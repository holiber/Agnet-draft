import { getRegisteredEndpoints } from "./registry.js";
import type { ApiSnapshot } from "./snapshot.js";

function isValidSourceDateEpoch(value: string | undefined): value is string {
  if (!value) return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function deterministicGeneratedAt(): string {
  // Prefer SOURCE_DATE_EPOCH when available to support reproducible builds.
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (isValidSourceDateEpoch(epoch)) {
    // SOURCE_DATE_EPOCH is seconds since Unix epoch.
    return new Date(Number(epoch) * 1000).toISOString();
  }
  // Default to Unix epoch for deterministic output.
  return new Date(0).toISOString();
}

async function loadProfileModules(profile: string): Promise<void> {
  // Tier1: only the built-in Agents API is currently registered.
  //
  // Future: gate additional dynamic modules by profile/config here.
  void profile;
  await import("../apis/agents-api.js");
}

function isInternalEndpointId(id: string): boolean {
  return id === "internal.apiDoc" || id.startsWith("internal.");
}

export class ApiHost {
  private readonly profile: string;
  private loaded = false;

  constructor(opts?: { profile?: string }) {
    this.profile = opts?.profile ?? "default";
  }

  /**
   * Tooling-only.
   *
   * Deterministic for a given profile + codebase (stable ordering and schema).
   */
  async getApiSnapshot(): Promise<ApiSnapshot> {
    if (!this.loaded) {
      await loadProfileModules(this.profile);
      this.loaded = true;
    }

    const endpoints = getRegisteredEndpoints()
      .filter((e) => !isInternalEndpointId(e.id))
      .filter((e) => !e.internal)
      .map((e) => ({
        id: e.id,
        pattern: e.pattern,
        args: e.args.map((a) => ({
          name: a.name,
          type: a.type,
          required: a.required ?? false,
          description: a.description,
          cli:
            a.cli && (a.cli.flag || a.cli.repeatable)
              ? { flag: a.cli.flag, repeatable: a.cli.repeatable }
              : undefined
        }))
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    return {
      version: 1,
      generatedAt: deterministicGeneratedAt(),
      profile: this.profile,
      endpoints
    };
  }
}

