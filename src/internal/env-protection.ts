function parseTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

export function isEnvProtectionEnabled(env: NodeJS.ProcessEnv): boolean {
  return parseTruthy(env.AGNET_PROTECT) || parseTruthy(env.AGNET_PROTECT_ENV);
}

export function isStrictEnvProtectionEnabled(env: NodeJS.ProcessEnv): boolean {
  return parseTruthy(env.AGNET_PROTECT_STRICT);
}

type AllowPattern = { kind: "exact"; value: string } | { kind: "prefix"; value: string };

function parseAllowPatterns(value: string | undefined): AllowPattern[] {
  return splitList(value).map((item) => {
    if (item.endsWith("*")) return { kind: "prefix", value: item.slice(0, -1) };
    return { kind: "exact", value: item };
  });
}

function matchesAllow(key: string, patterns: AllowPattern[]): boolean {
  for (const p of patterns) {
    if (p.kind === "exact" && key === p.value) return true;
    if (p.kind === "prefix" && key.startsWith(p.value)) return true;
  }
  return false;
}

/**
 * Sanitize an environment object before passing it to a spawned process.
 *
 * Behavior:
 * - if protection is disabled, returns the original env
 * - if enabled, returns a reduced env containing:
 *   - a small safe base set
 *   - all `AGNET_*`
 *   - any keys listed in `AGNET_ALLOW_ENV` (supports `PREFIX_*`)
 */
export function sanitizeChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!isEnvProtectionEnabled(env)) return env;

  const allow = parseAllowPatterns(env.AGNET_ALLOW_ENV);
  const out: NodeJS.ProcessEnv = {};

  const safeExact = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PWD",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "FORCE_COLOR",
    "NVM_DIR",
    "NVM_BIN",
    "NODE_OPTIONS",
    "NODE_PATH",
    "CI"
  ]);

  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (safeExact.has(k)) out[k] = v;
    else if (k.startsWith("LC_")) out[k] = v;
    else if (k.startsWith("AGNET_")) out[k] = v;
    else if (matchesAllow(k, allow)) out[k] = v;
  }

  return out;
}

/**
 * Optional guard for strict mode. Intended as a coarse safety net, not a security boundary.
 *
 * Controlled by:
 * - `AGNET_PROTECT_STRICT=1`
 * - `AGNET_ALLOW_COMMANDS` (comma-separated list; items may be absolute paths or basenames)
 */
export function assertCommandAllowed(params: { command: string; env: NodeJS.ProcessEnv }): void {
  if (!isStrictEnvProtectionEnabled(params.env)) return;

  const allow = splitList(params.env.AGNET_ALLOW_COMMANDS);
  if (allow.length === 0) return;

  const command = params.command;
  const base = command.split(/[\\/]/).pop() ?? command;

  const ok = allow.includes(command) || allow.includes(base);
  if (!ok) {
    throw new Error(
      `Blocked command in strict protected mode: "${command}". Set AGNET_ALLOW_COMMANDS to allow it.`
    );
  }
}

