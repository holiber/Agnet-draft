import { parse as parseYaml } from "yaml";

import {
  AgentConfigError,
  type AgentAuthRequirement,
  type AgentCard,
  type AgentConfig,
  type AgentMcpRequirement,
  type AgentRule,
  type AgentRuntimeConfig,
  type AgentSkill,
  validateAgentRuntimeConfig
} from "./agnet.js";
import type { JsonObject } from "./protocol.js";

type Heading = { level: number; text: string; line: number };

function mdxError(path: string | undefined, message: string): AgentConfigError {
  const where = path ? ` at "${path}"` : "";
  return new AgentConfigError(`Invalid .agent.mdx${where}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function collapseWs(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function headingKey(text: string): string {
  return collapseWs(text).toLowerCase();
}

export function normalizeSectionId(raw: string): string {
  const s = raw.trim().toLowerCase();
  // Replace any run of non-alphanumerics with "-"
  const kebab = s
    .replace(/['’]/g, "") // drop apostrophes
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return kebab;
}

function extractFrontmatter(raw: string, path?: string): { frontmatter: string; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n") && normalized.trimStart() !== normalized) {
    // If there are leading blank lines before the delimiter, treat that as invalid for Tier1.
    throw mdxError(path, "frontmatter must start at the first line with '---'");
  }
  if (!normalized.startsWith("---\n")) {
    throw mdxError(path, "missing required YAML frontmatter (expected starting '---')");
  }

  const lines = normalized.split("\n");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) throw mdxError(path, "unterminated frontmatter (missing closing '---')");
  const fm = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n");
  return { frontmatter: fm, body };
}

function parseHeadings(markdown: string): Heading[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  /** @type {Heading[]} */
  const out: Heading[] = [];

  let inFence = false;
  let fenceMarker: "```" | "~~~" | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    const fenceMatch = /^(~~~|```)/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1] as "```" | "~~~";
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        inFence = false;
        fenceMarker = null;
      }
      continue;
    }
    if (inFence) continue;

    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(trimmed);
    if (!m) continue;
    out.push({ level: m[1].length, text: m[2], line: i + 1 });
  }
  return out;
}

function sliceSection(bodyLines: string[], startLineIdx: number, endLineIdx: number): string {
  const lines = bodyLines.slice(startLineIdx, endLineIdx);
  // Preserve markdown content but remove the first blank line if present.
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n").trimEnd();
}

function parseSubsections(params: {
  sectionMarkdown: string;
  path?: string;
  sectionName: "Rules" | "Skills";
}): Array<{ rawId: string; normalizedId: string; body: string }> {
  const lines = params.sectionMarkdown.replace(/\r\n/g, "\n").split("\n");
  const headings = parseHeadings(params.sectionMarkdown).filter((h) => h.level === 3);
  if (headings.length === 0) return [];

  const seen = new Set<string>();
  const out: Array<{ rawId: string; normalizedId: string; body: string }> = [];

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const next = headings[i + 1];
    const rawId = h.text.trim();
    const normalizedId = normalizeSectionId(rawId);
    if (!normalizedId) {
      throw mdxError(params.path, `${params.sectionName} subsection heading must produce a non-empty id`);
    }
    if (seen.has(normalizedId)) {
      throw mdxError(
        params.path,
        `Duplicate ${params.sectionName.toLowerCase()} id after normalization: "${normalizedId}"`
      );
    }
    seen.add(normalizedId);

    const startIdx = h.line; // line numbers are 1-based; content starts on next line
    const endIdx = next ? next.line - 1 : lines.length;
    const body = sliceSection(lines, startIdx, endIdx);
    out.push({ rawId, normalizedId, body });
  }

  return out;
}

export function parseAgentMdx(raw: string, opts?: { path?: string }): AgentConfig {
  const { frontmatter, body } = extractFrontmatter(raw, opts?.path);

  let fm: unknown;
  try {
    fm = parseYaml(frontmatter) as unknown;
  } catch (err) {
    throw mdxError(opts?.path, `failed to parse YAML frontmatter: ${(err as Error).message}`);
  }
  if (!isRecord(fm)) throw mdxError(opts?.path, "frontmatter must be a YAML object");

  // Conflict validation: if defined in frontmatter AND in body => error.
  // Tier1 always requires these body sections, so defining them in frontmatter is always a conflict.
  const fmAgent = isRecord(fm.agent) ? (fm.agent as Record<string, unknown>) : undefined;
  const fmExt = isRecord(fm.extensions) ? (fm.extensions as Record<string, unknown>) : undefined;
  const conflictChecks: Array<{
    label: "Description" | "System Prompt" | "Rules" | "Skills";
    isPresent: boolean;
  }> = [
    {
      label: "Description",
      isPresent: fm.description !== undefined || fmAgent?.description !== undefined
    },
    {
      label: "System Prompt",
      isPresent:
        fm.systemPrompt !== undefined ||
        fmAgent?.systemPrompt !== undefined ||
        fmExt?.systemPrompt !== undefined
    },
    {
      label: "Rules",
      isPresent: fm.rules !== undefined || fmAgent?.rules !== undefined
    },
    {
      label: "Skills",
      isPresent: fm.skills !== undefined || fmAgent?.skills !== undefined
    }
  ];
  for (const c of conflictChecks) {
    if (!c.isPresent) continue;
    const verb = c.label === "Rules" || c.label === "Skills" ? "are" : "is";
    throw mdxError(
      opts?.path,
      `${c.label} ${verb} defined both in frontmatter and body. Choose exactly one source.`
    );
  }

  const id = typeof fm.id === "string" ? fm.id.trim() : "";
  const name = typeof fm.name === "string" ? fm.name.trim() : "";
  const version = typeof fm.version === "string" ? fm.version.trim() : "";
  if (!id) throw mdxError(opts?.path, "missing required frontmatter field: id");
  if (!name) throw mdxError(opts?.path, "missing required frontmatter field: name");
  if (!version) throw mdxError(opts?.path, "missing required frontmatter field: version");

  const runtimeRaw = fm.runtime;
  if (runtimeRaw === undefined) throw mdxError(opts?.path, "missing required frontmatter field: runtime");
  let runtime: AgentRuntimeConfig;
  try {
    runtime = validateAgentRuntimeConfig(runtimeRaw, "runtime");
  } catch (err) {
    throw mdxError(opts?.path, (err as Error).message);
  }

  let mcp: AgentMcpRequirement | undefined;
  if (fm.mcp !== undefined) {
    if (!isRecord(fm.mcp)) throw mdxError(opts?.path, "frontmatter.mcp must be an object");
    const tools = (fm.mcp as Record<string, unknown>).tools;
    if (tools !== undefined) {
      if (!Array.isArray(tools)) throw mdxError(opts?.path, "frontmatter.mcp.tools must be an array");
      const normalized = tools.map((t, i) => {
        if (typeof t !== "string" || t.trim().length === 0) {
          throw mdxError(opts?.path, `frontmatter.mcp.tools[${i}] must be a non-empty string`);
        }
        return t.trim();
      });
      mcp = { tools: normalized };
    }
  }

  let auth: AgentAuthRequirement | undefined;
  if (fm.auth !== undefined) {
    if (!isRecord(fm.auth)) throw mdxError(opts?.path, "frontmatter.auth must be an object");
    const kind = (fm.auth as Record<string, unknown>).kind;
    const header = (fm.auth as Record<string, unknown>).header;
    if (typeof kind !== "string" || kind.trim().length === 0) {
      throw mdxError(opts?.path, "frontmatter.auth.kind must be a non-empty string");
    }
    const k = kind.trim() as AgentAuthRequirement["kind"];
    if (k !== "none" && k !== "bearer" && k !== "apiKey") {
      throw mdxError(opts?.path, 'frontmatter.auth.kind must be "none" | "bearer" | "apiKey"');
    }
    if (header !== undefined && (typeof header !== "string" || header.trim().length === 0)) {
      throw mdxError(opts?.path, "frontmatter.auth.header must be a non-empty string");
    }
    auth = { kind: k, ...(typeof header === "string" ? { header: header.trim() } : {}) };
  }

  const bodyLines = body.replace(/\r\n/g, "\n").split("\n");
  const headings = parseHeadings(body);

  const expected = [
    { level: 1, key: "description", label: "Description" },
    { level: 2, key: "system prompt", label: "System Prompt" },
    { level: 2, key: "rules", label: "Rules" },
    { level: 2, key: "skills", label: "Skills" }
  ] as const;

  const found: Heading[] = [];
  let cursor = 0;
  for (const exp of expected) {
    let match: Heading | undefined;
    for (let i = cursor; i < headings.length; i++) {
      const h = headings[i];
      if (h.level === exp.level && headingKey(h.text) === exp.key) {
        match = h;
        cursor = i + 1;
        break;
      }
    }
    if (!match) {
      throw mdxError(opts?.path, `missing required markdown section: ${"#".repeat(exp.level)} ${exp.label}`);
    }
    found.push(match);
  }

  // Strict order (Tier1): ensure they appear in the order we matched them.
  for (let i = 1; i < found.length; i++) {
    if (found[i].line <= found[i - 1].line) {
      throw mdxError(opts?.path, "markdown sections are out of order (Tier1 requires fixed order)");
    }
  }

  // Ensure the document starts with "# Description" (after frontmatter/blank lines).
  const firstNonEmpty = bodyLines.findIndex((l) => l.trim().length > 0);
  if (firstNonEmpty !== -1) {
    const first = bodyLines[firstNonEmpty].trimStart();
    if (!/^#\s+description\s*$/i.test(collapseWs(first))) {
      throw mdxError(opts?.path, 'first markdown section must be "# Description"');
    }
  }

  const [hDesc, hSys, hRules, hSkills] = found;
  const desc = sliceSection(bodyLines, hDesc.line, hSys.line - 1);
  const sysPrompt = sliceSection(bodyLines, hSys.line, hRules.line - 1);
  const rulesMarkdown = sliceSection(bodyLines, hRules.line, hSkills.line - 1);
  const skillsMarkdown = sliceSection(bodyLines, hSkills.line, bodyLines.length);

  const ruleSubsections = parseSubsections({
    sectionMarkdown: rulesMarkdown,
    path: opts?.path,
    sectionName: "Rules"
  });
  const rules: AgentRule[] = ruleSubsections.map((r) => ({
    id: r.normalizedId,
    text: r.body
  }));

  const skillSubsections = parseSubsections({
    sectionMarkdown: skillsMarkdown,
    path: opts?.path,
    sectionName: "Skills"
  });
  const skills: AgentSkill[] = skillSubsections.map((s) => ({
    id: s.normalizedId,
    description: s.body
  }));
  if (skills.length === 0) {
    throw mdxError(opts?.path, '## Skills must contain at least one "### <skill-id>" subsection');
  }

  const extensions: JsonObject = {};
  if (sysPrompt.trim().length > 0) {
    extensions.systemPrompt = sysPrompt;
  }

  const agent: AgentCard = {
    id,
    name,
    version,
    description: desc,
    skills,
    ...(rules.length > 0 ? { rules } : {}),
    ...(mcp ? { mcp } : {}),
    ...(auth ? { auth } : {}),
    ...(Object.keys(extensions).length > 0 ? { extensions } : {})
  };

  return { agent, runtime };
}

