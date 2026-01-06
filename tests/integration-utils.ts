export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function envOrUndefined(name: string): string | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

export function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function fetchJson(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  json: unknown;
  text: string;
}> {
  const timeoutMs = init.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  // Avoid keeping the event loop alive.
  (t as unknown as { unref?: () => void }).unref?.();

  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const headers: Record<string, string> = {};
    for (const [k, v] of res.headers.entries()) headers[k] = v;
    const text = await res.text();
    const json = safeJsonParse(text);
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers,
      json,
      text
    };
  } finally {
    clearTimeout(t);
  }
}

const SENSITIVE_KEY_RE = /(authorization|api[-_]?key|token|secret|password|cookie|set-cookie)/i;

export function trimAndRedact(value: unknown, opts?: { maxDepth?: number; maxArray?: number; maxString?: number; maxKeys?: number }): unknown {
  const maxDepth = opts?.maxDepth ?? 6;
  const maxArray = opts?.maxArray ?? 2;
  const maxString = opts?.maxString ?? 240;
  const maxKeys = opts?.maxKeys ?? 40;

  function inner(v: unknown, depth: number): unknown {
    if (depth > maxDepth) return "[TruncatedDepth]";
    if (v === null) return null;
    const t = typeof v;
    if (t === "boolean" || t === "number") return v;
    if (t === "string") {
      const s = v as string;
      if (s.length <= maxString) return s;
      return `${s.slice(0, Math.max(0, maxString - 30))}…[truncated ${s.length} chars]`;
    }
    if (Array.isArray(v)) {
      const arr = v.slice(0, maxArray).map((x) => inner(x, depth + 1));
      if (v.length > maxArray) arr.push(`[+${v.length - maxArray} more items]`);
      return arr;
    }
    if (t === "object") {
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).slice(0, maxKeys);
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        if (SENSITIVE_KEY_RE.test(k)) {
          out[k] = "[REDACTED]";
          continue;
        }
        out[k] = inner(obj[k], depth + 1);
      }
      if (Object.keys(obj).length > maxKeys) out["[+moreKeys]"] = Object.keys(obj).length - maxKeys;
      return out;
    }
    return String(v);
  }

  return inner(value, 0);
}

export function topLevelKeys(v: unknown): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  return Object.keys(v as Record<string, unknown>).sort();
}

export function detectItems(payload: unknown): { items: unknown[]; path: string } | undefined {
  if (Array.isArray(payload)) return { items: payload, path: "$" };
  if (!payload || typeof payload !== "object") return undefined;
  const obj = payload as Record<string, unknown>;

  const preferred = ["tasks", "runs", "conversations", "items", "data", "results"];
  for (const k of preferred) {
    const v = obj[k];
    if (Array.isArray(v)) return { items: v, path: `$.${k}` };
  }

  // Common nested patterns: { data: { items: [...] } } or { result: { data: [...] } }.
  for (const [k, v] of Object.entries(obj)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const nested = v as Record<string, unknown>;
    for (const kk of preferred) {
      const vv = nested[kk];
      if (Array.isArray(vv)) return { items: vv, path: `$.${k}.${kk}` };
    }
  }

  return undefined;
}

const PAGINATION_KEY_RE = /(cursor|next|prev|page|offset|limit|has_more|hasMore|pagination)/i;

export function detectPaginationFields(payload: unknown): Array<{ path: string; value: unknown }> {
  const out: Array<{ path: string; value: unknown }> = [];
  if (!payload || typeof payload !== "object") return out;
  const obj = payload as Record<string, unknown>;

  function scan(record: Record<string, unknown>, base: string): void {
    for (const [k, v] of Object.entries(record)) {
      if (PAGINATION_KEY_RE.test(k)) {
        out.push({ path: `${base}.${k}`, value: v });
      }
      if (v && typeof v === "object" && !Array.isArray(v) && (k === "pagination" || k === "meta")) {
        scan(v as Record<string, unknown>, `${base}.${k}`);
      }
    }
  }

  scan(obj, "$");
  return out;
}

export function extractStableId(v: unknown): string | undefined {
  if (!v || typeof v !== "object") return undefined;
  const obj = v as Record<string, unknown>;
  const candidates = ["id", "taskId", "runId", "conversationId", "_id", "uuid"];
  for (const k of candidates) {
    const val = obj[k];
    if (typeof val === "string" && val.trim()) return val;
    if (typeof val === "number" && Number.isFinite(val)) return String(val);
  }
  return undefined;
}

export function extractStableIdDeep(v: unknown): string | undefined {
  const direct = extractStableId(v);
  if (direct) return direct;
  if (!v || typeof v !== "object") return undefined;
  if (Array.isArray(v)) return undefined;
  const obj = v as Record<string, unknown>;
  const wrappers = ["task", "run", "conversation", "data", "item", "result"];
  for (const k of wrappers) {
    const nested = obj[k];
    const id = extractStableId(nested);
    if (id) return id;
  }
  for (const nested of Object.values(obj)) {
    const id = extractStableId(nested);
    if (id) return id;
  }
  return undefined;
}

