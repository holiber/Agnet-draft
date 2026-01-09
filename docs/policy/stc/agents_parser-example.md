# Example of a parser for *.agent.md files
'''ts

/**
 * Agent .agent.md parser + validator (proposal)
 *
 * Requirements implemented:
 * - YAML frontmatter is optional, keys are case-insensitive.
 * - Only these headings are allowed as metadata sources (case-insensitive):
 *   - `# <Title>` -> title fallback
 *   - first paragraph after first `#` -> description fallback
 *   - `# Avatar` -> avatar fallback (first image under that section)
 *   - `## System` -> system fallback
 *   - `## Rules` -> rules fallback
 *
 * Conflict errors (throws):
 * 1) YAML metadata conflicts with heading-derived values for: title, description, avatar, system, rules
 *    - Comparison is case-insensitive and ignores surrounding whitespace.
 * 2) allow conflicts with deny
 *    - If allow is a list (not "*") and any ability overlaps deny (exact match) -> error
 *    - If deny contains "*" -> error (invalid)
 *
 * Ability validation (throws):
 * - Abilities must be one of: fs, network, sh, tool, mcp, browser, env
 * - Scoped abilities allowed only for `sh:<command>` (e.g. sh:gh, sh:ls)
 * - Keys and values are processed case-insensitively
 *
 * Defaults:
 * - version: 0.1.0
 * - icon: 🤖
 * - status: active
 * - limits: { time_per_message: "5m", max_files_changed: 100 }
 * - allow: "*"
 * - deny: ""
 * - system default: content under "## System" if exists otherwise description if exists otherwise title
 */

import matter from "gray-matter";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import type { Root, Content, Paragraph, Image, Text, Heading } from "mdast";

export type AgentStatus = "active" | "deprecated" | "disabled";
export type AgentCapability = string;

const BASE_ABILITIES = ["fs", "network", "sh", "tool", "mcp", "browser", "env"] as const;
type BaseAbility = (typeof BASE_ABILITIES)[number];

// We store abilities in canonical lower-case form (base + optional scope)
export type CanonicalAbility = `${BaseAbility}` | `sh:${string}`;

export type AgentRecommendedRequired = {
  models?: string[];
  capabilities?: AgentCapability[];
};

export type AgentLimits = {
  time_per_message: string; // "5m"
  max_files_changed: number; // 100
};

// Frontmatter keys are treated case-insensitively; we normalize them.
export type AgentFrontmatter = Partial<{
  version: string;
  icon: string;
  title: string;
  description: string;
  tags: string[];
  roles: string[];
  avatar: string;
  system: string;
  recommended: AgentRecommendedRequired;
  required: AgentRecommendedRequired;
  allow: "*" | "" | false | string[] | string;
  deny: "" | false | string[] | string;
  limits: Partial<AgentLimits>;
  status: AgentStatus;
  rules: string;
  policies: string[] | string;
}>;

export type AgentDefinition = {
  version: string;
  icon: string;
  title: string;
  description: string;
  tags: string[];
  roles: string[];
  avatar?: string;
  system: string;
  recommended: AgentRecommendedRequired;
  required: AgentRecommendedRequired;
  allow: "*" | CanonicalAbility[];
  deny: CanonicalAbility[];
  limits: AgentLimits;
  status: AgentStatus;
  rules: string;
  policies: string[];
};

const DEFAULTS = {
  version: "0.1.0",
  icon: "🤖",
  status: "active" as AgentStatus,
  limits: { time_per_message: "5m", max_files_changed: 100 } as AgentLimits,
  allow: "*" as const,
  deny: [] as CanonicalAbility[],
  tags: [] as string[],
  roles: [] as string[],
  recommended: {} as AgentRecommendedRequired,
  required: {} as AgentRecommendedRequired,
  policies: [] as string[],
  rules: "",
};

class AgentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentParseError";
  }
}

function normStr(s: unknown): string {
  return String(s ?? "").trim();
}
function normCmp(s: unknown): string {
  return normStr(s).toLowerCase();
}

/** Normalize object keys to lower-case (1 level deep), preserving values. */
function lowerKeys<T extends Record<string, any>>(obj: any): T {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return (obj ?? {}) as T;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) out[String(k).toLowerCase()] = v;
  return out as T;
}

function normalizeFrontmatterKeys(raw: any): AgentFrontmatter {
  const fm = lowerKeys<AgentFrontmatter>(raw ?? {});
  // Also normalize nested keys for recommended/required/limits (they're small objects)
  if (fm.recommended) fm.recommended = lowerKeys(fm.recommended as any);
  if (fm.required) fm.required = lowerKeys(fm.required as any);
  if (fm.limits) fm.limits = lowerKeys(fm.limits as any);
  return fm;
}

function mdText(node: any): string {
  if (!node) return "";
  if (node.type === "text") return (node as Text).value;
  if (node.type === "paragraph") return (node as Paragraph).children.map(mdText).join("");
  if (Array.isArray(node.children)) return node.children.map(mdText).join("");
  return "";
}

function stringifyNode(node: any): string {
  if (!node) return "";
  if (node.type === "paragraph") return mdText(node as Paragraph).trim();
  if (node.type === "heading") {
    const h = node as Heading;
    return `${"#".repeat(h.depth)} ${h.children.map(mdText).join("").trim()}`;
  }
  if (node.type === "list") {
    return (node.children ?? [])
      .map((li: any) => {
        const line = (li.children ?? []).map((c: any) => stringifyNode(c)).join(" ").trim();
        return `- ${line}`;
      })
      .join("\n");
  }
  if (Array.isArray(node.children)) return node.children.map(stringifyNode).join("\n").trim();
  return "";
}

type Extracted = {
  firstH1Title?: string;
  firstParagraphAfterH1?: string;
  avatarFromAvatarSection?: string;
  avatarFromBodyStart?: string;
  systemSection?: string;
  rulesSection?: string;
};

function extractFromMarkdown(body: string): Extracted {
  const ast = unified().use(remarkParse).parse(body) as Root;
  const extracted: Extracted = {};

  let sawFirstH1 = false;
  let afterFirstH1 = false;

  const captureSection = (headingText: string, headingDepth: number): string | undefined => {
    const nodes = ast.children;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type !== "heading") continue;
      const h = n as Heading;
      const t = h.children.map(mdText).join("").trim();
      if (h.depth === headingDepth && t.toLowerCase() === headingText.toLowerCase()) {
        const parts: string[] = [];
        for (let j = i + 1; j < nodes.length; j++) {
          const m = nodes[j];
          if (m.type === "heading") {
            const hh = m as Heading;
            if (hh.depth <= headingDepth) break;
          }
          parts.push(stringifyNode(m));
        }
        const out = parts.join("\n").trim();
        return out.length ? out : undefined;
      }
    }
    return undefined;
  };

  const findFirstImageInSection = (headingText: string, headingDepth: number): string | undefined => {
    const nodes = ast.children;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type !== "heading") continue;
      const h = n as Heading;
      const t = h.children.map(mdText).join("").trim();
      if (h.depth === headingDepth && t.toLowerCase() === headingText.toLowerCase()) {
        for (let j = i + 1; j < nodes.length; j++) {
          const m = nodes[j];
          if (m.type === "heading") {
            const hh = m as Heading;
            if (hh.depth <= headingDepth) break;
          }
          let found: string | undefined;
          visit(m, "image", (img: Image) => {
            if (!found) found = img.url;
          });
          if (found) return found;
        }
      }
    }
    return undefined;
  };

  for (let i = 0; i < ast.children.length; i++) {
    const n = ast.children[i];

    if (n.type === "heading") {
      const h = n as Heading;
      const t = h.children.map(mdText).join("").trim();

      if (!sawFirstH1 && h.depth === 1) {
        extracted.firstH1Title = t || undefined;
        sawFirstH1 = true;
        afterFirstH1 = true;
        continue;
      }
      if (afterFirstH1 && h.depth >= 1) afterFirstH1 = false;
    }

    if (afterFirstH1 && !extracted.firstParagraphAfterH1 && n.type === "paragraph") {
      const txt = mdText(n as Paragraph).trim();
      if (txt) extracted.firstParagraphAfterH1 = txt;
      continue;
    }

    if (!sawFirstH1 && !extracted.avatarFromBodyStart) {
      let found: string | undefined;
      visit(n, "image", (img: Image) => {
        if (!found) found = img.url;
      });
      if (found) extracted.avatarFromBodyStart = found;
    }
  }

  extracted.avatarFromAvatarSection = findFirstImageInSection("Avatar", 1);
  extracted.systemSection = captureSection("System", 2);
  extracted.rulesSection = captureSection("Rules", 2);

  return extracted;
}

function normalizePolicies(policies: AgentFrontmatter["policies"]): string[] {
  if (!policies) return [];
  if (Array.isArray(policies)) return policies.map(String).map((s) => s.trim()).filter(Boolean);
  return String(policies)
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Validate and canonicalize ability strings; throws on invalid values. */
export function validateAndNormalizeAbilities(
  input: "*" | "" | false | string[] | string | undefined,
  fieldName: "allow" | "deny"
): "*" | CanonicalAbility[] {
  if (input === undefined) return fieldName === "allow" ? "*" : [];
  if (input === "*") return "*";
  if (input === "" || input === false) return [];

  const list = Array.isArray(input)
    ? input.map(String)
    : String(input)
        .split(/\r?\n|,/)
        .map((s) => s.trim())
        .filter(Boolean);

  const out: CanonicalAbility[] = [];
  for (const raw of list) {
    const v = raw.trim();
    if (!v) continue;

    const lower = v.toLowerCase();

    // Disallow "*" inside deny list items or allow list items other than the special "*" value
    if (lower === "*") {
      throw new AgentParseError(`Invalid ability "*" inside ${fieldName} list. Use ${fieldName}: "*" only as a single scalar.`);
    }

    // Parse base[:scope]
    const m = /^([a-z]+)(?::([a-z0-9._-]+))?$/i.exec(v);
    if (!m) throw new AgentParseError(`Invalid ability syntax in ${fieldName}: "${v}"`);

    const base = m[1].toLowerCase();
    const scope = m[2];

    if (!BASE_ABILITIES.includes(base as BaseAbility)) {
      throw new AgentParseError(
        `Unknown base ability in ${fieldName}: "${v}". Allowed: ${BASE_ABILITIES.join(", ")}`
      );
    }

    // Scoped abilities: currently only sh:<command>
    if (scope) {
      if (base !== "sh") {
        throw new AgentParseError(`Scoped ability is only allowed for "sh:<command>". Invalid: "${v}"`);
      }
      out.push(`sh:${scope.toLowerCase()}`);
      continue;
    }

    out.push(base as CanonicalAbility);
  }

  // Deduplicate
  return Array.from(new Set(out));
}

/** Throw if YAML and heading-derived values conflict (case-insensitive). */
function assertNoYamlHeadingConflicts(params: {
  yamlValue?: string;
  inferredValue?: string;
  keyName: string;
}) {
  const { yamlValue, inferredValue, keyName } = params;
  if (!yamlValue || !inferredValue) return;
  if (normCmp(yamlValue) !== normCmp(inferredValue)) {
    throw new AgentParseError(
      `Conflict for "${keyName}": YAML value "${normStr(yamlValue)}" differs from heading-derived value "${normStr(inferredValue)}".`
    );
  }
}

/** Throw if allow/deny conflict (exact overlap when allow is list). */
function assertNoAllowDenyConflicts(allow: "*" | CanonicalAbility[], deny: CanonicalAbility[]) {
  // deny "*" is already prevented by validator
  if (allow === "*") return; // allow-all + deny-some is valid and intended

  const allowSet = new Set(allow);
  const conflicts = deny.filter((d) => allowSet.has(d));
  if (conflicts.length) {
    throw new AgentParseError(
      `allow/deny conflict: abilities present in both allow and deny: ${conflicts.join(", ")}`
    );
  }

  // Optional: prevent nonsensical "deny: sh" while allowing sh:gh etc (policy doesn’t mandate this).
  // Keep strict only for exact matches per your requirement.
}

export function parseAgentMarkdown(fileContent: string): AgentDefinition {
  const parsed = matter(fileContent);
  const fm = normalizeFrontmatterKeys(parsed.data || {});
  const body = parsed.content ?? "";

  const extracted = extractFromMarkdown(body);

  // Conflicts: YAML vs headings-derived (case-insensitive)
  // Allowed heading sources per policy: first H1 title, first paragraph after H1, # Avatar image, ## System, ## Rules
  assertNoYamlHeadingConflicts({ keyName: "title", yamlValue: fm.title, inferredValue: extracted.firstH1Title });
  assertNoYamlHeadingConflicts({
    keyName: "description",
    yamlValue: fm.description,
    inferredValue: extracted.firstParagraphAfterH1,
  });
  assertNoYamlHeadingConflicts({
    keyName: "avatar",
    yamlValue: fm.avatar,
    inferredValue: extracted.avatarFromAvatarSection ?? extracted.avatarFromBodyStart,
  });
  assertNoYamlHeadingConflicts({ keyName: "system", yamlValue: fm.system, inferredValue: extracted.systemSection });
  assertNoYamlHeadingConflicts({ keyName: "rules", yamlValue: fm.rules, inferredValue: extracted.rulesSection });

  const title = normStr(fm.title) || normStr(extracted.firstH1Title) || "Untitled Agent";
  const description = normStr(fm.description) || normStr(extracted.firstParagraphAfterH1) || "";

  // avatar default:
  // 1) YAML avatar
  // 2) first image under "# Avatar"
  // 3) first image at start of body
  const avatar =
    normStr(fm.avatar) ||
    normStr(extracted.avatarFromAvatarSection) ||
    normStr(extracted.avatarFromBodyStart) ||
    undefined;

  // rules default: YAML rules else content under "## Rules" else ""
  const rules = normStr(fm.rules) || normStr(extracted.rulesSection) || DEFAULTS.rules;

  // system default order you specified:
  // 1) content after "## System" heading (if exists)
  // 2) description if exists
  // 3) title
  const system = normStr(extracted.systemSection) || normStr(fm.system) || description || title;

  const version = normStr(fm.version) || DEFAULTS.version;
  const icon = normStr(fm.icon) || DEFAULTS.icon;

  const statusRaw = normStr(fm.status) || DEFAULTS.status;
  const status = (statusRaw.toLowerCase() as AgentStatus) ?? DEFAULTS.status;
  if (!["active", "deprecated", "disabled"].includes(status)) {
    throw new AgentParseError(`Invalid status "${statusRaw}". Allowed: active, deprecated, disabled.`);
  }

  const tags = Array.isArray(fm.tags) ? fm.tags.map((s) => normStr(s)).filter(Boolean) : DEFAULTS.tags;
  const roles = Array.isArray(fm.roles) ? fm.roles.map((s) => normStr(s)).filter(Boolean) : DEFAULTS.roles;

  const recommended = (fm.recommended ?? DEFAULTS.recommended) as AgentRecommendedRequired;
  const required = (fm.required ?? DEFAULTS.required) as AgentRecommendedRequired;

  // Abilities: validate + canonicalize
  const allow = validateAndNormalizeAbilities(fm.allow, "allow");
  const deny = validateAndNormalizeAbilities(fm.deny, "deny");
  if (deny === "*") {
    // Our validator prevents this, but keep guard.
    throw new AgentParseError(`deny: "*" is not allowed. Deny must be a list or empty.`);
  }
  assertNoAllowDenyConflicts(allow, deny as CanonicalAbility[]);

  // limits defaults
  const limits: AgentLimits = {
    time_per_message: normStr(fm.limits?.time_per_message) || DEFAULTS.limits.time_per_message,
    max_files_changed: Number(fm.limits?.max_files_changed ?? DEFAULTS.limits.max_files_changed),
  };
  if (!Number.isFinite(limits.max_files_changed) || limits.max_files_changed < 0) {
    throw new AgentParseError(`limits.max_files_changed must be a non-negative number.`);
  }
  if (!limits.time_per_message) {
    throw new AgentParseError(`limits.time_per_message must be a non-empty string (e.g. "5m").`);
  }

  const policies = normalizePolicies(fm.policies);

  return {
    version,
    icon,
    title,
    description,
    tags,
    roles,
    avatar,
    system,
    recommended,
    required,
    allow,
    deny: deny as CanonicalAbility[],
    limits,
    status,
    rules,
    policies,
  };
}

// Example CLI usage:
//   node parse-agent.js agents/backend_api-coder.agent.md
if (require.main === module) {
  const fs = require("node:fs");
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: node parse-agent.js <path-to-agent-file>");
    process.exit(1);
  }
  const content = fs.readFileSync(path, "utf8");
  const agent = parseAgentMarkdown(content);
  console.log(JSON.stringify(agent, null, 2));
}

'''
