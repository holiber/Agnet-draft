import { describe, expect, it } from "vitest";

import {
  detectItems,
  detectPaginationFields,
  envOrUndefined,
  extractStableId,
  extractStableIdDeep,
  fetchJson,
  joinUrl,
  topLevelKeys,
  trimAndRedact
} from "./integration-utils.js";

type CursorEndpointCandidate = {
  name: string;
  listUrl: (baseUrl: string) => string;
  getUrl: (baseUrl: string, id: string) => string;
};

function cursorAuthHeaders(): Record<string, string> {
  const apiKey =
    envOrUndefined("CURSOR_API_KEY") ?? envOrUndefined("CURSOR_BEARER_TOKEN") ?? envOrUndefined("CURSOR_AUTH_TOKEN");
  if (!apiKey) return {};

  // Default to Bearer, but allow overriding via env for unusual providers.
  const headerName = envOrUndefined("CURSOR_AUTH_HEADER") ?? "Authorization";
  const headerValue = envOrUndefined("CURSOR_AUTH_VALUE") ?? `Bearer ${apiKey}`;
  return { [headerName]: headerValue };
}

function cursorBaseUrl(): string {
  // Keep overridable; we don't want tests to hardcode a potentially-wrong default forever.
  return envOrUndefined("CURSOR_BASE_URL") ?? "https://api.cursor.com";
}

function cursorCandidates(): CursorEndpointCandidate[] {
  const listUrlOverride = envOrUndefined("CURSOR_LIST_URL");
  const getUrlTemplate = envOrUndefined("CURSOR_GET_URL_TEMPLATE"); // supports "{id}"
  if (listUrlOverride && getUrlTemplate) {
    return [
      {
        name: "env:CURSOR_LIST_URL + CURSOR_GET_URL_TEMPLATE",
        listUrl: () => listUrlOverride,
        getUrl: (_base, id) => getUrlTemplate.replaceAll("{id}", encodeURIComponent(id))
      }
    ];
  }

  return [
    {
      name: "v1/tasks",
      listUrl: (base) => joinUrl(base, "/v1/tasks"),
      getUrl: (base, id) => joinUrl(base, `/v1/tasks/${encodeURIComponent(id)}`)
    },
    {
      name: "v1/runs",
      listUrl: (base) => joinUrl(base, "/v1/runs"),
      getUrl: (base, id) => joinUrl(base, `/v1/runs/${encodeURIComponent(id)}`)
    },
    {
      name: "api/tasks",
      listUrl: (base) => joinUrl(base, "/api/tasks"),
      getUrl: (base, id) => joinUrl(base, `/api/tasks/${encodeURIComponent(id)}`)
    }
  ];
}

describe("Cursor Cloud Tasks API (discovery logging)", () => {
  const hasCreds =
    !!envOrUndefined("CURSOR_API_KEY") || !!envOrUndefined("CURSOR_BEARER_TOKEN") || !!envOrUndefined("CURSOR_AUTH_TOKEN");

  it.skipIf(!hasCreds)(
    "lists tasks/runs and fetches one by id (logs shape + pagination)",
    { timeout: 30_000 },
    async () => {
      const baseUrl = cursorBaseUrl();
      const headers = cursorAuthHeaders();

      const query = new URLSearchParams();
      query.set("limit", "10");

      const errors: Array<{ candidate: string; status?: number; bodySample?: unknown }> = [];
      let chosen:
        | {
            candidate: CursorEndpointCandidate;
            listUrl: string;
            listJson: unknown;
            items: unknown[];
            itemsPath: string;
          }
        | undefined;

      for (const candidate of cursorCandidates()) {
        const url = new URL(candidate.listUrl(baseUrl));
        if (!url.search) url.search = query.toString();
        else url.search = `${url.search.replace(/^\?/, "")}&${query.toString()}`;

        const res = await fetchJson(url.toString(), {
          method: "GET",
          headers,
          timeoutMs: 15_000
        });

        const payload = res.json ?? safeFallbackJson(res.text);
        const itemsInfo = detectItems(payload);
        if (!res.ok || !itemsInfo) {
          errors.push({
            candidate: `${candidate.name} (${url.toString()})`,
            status: res.status,
            bodySample: trimAndRedact(payload)
          });
          continue;
        }

        chosen = {
          candidate,
          listUrl: url.toString(),
          listJson: payload,
          items: itemsInfo.items,
          itemsPath: itemsInfo.path
        };
        break;
      }

      if (!chosen) {
        throw new Error(
          [
            "Failed to discover a working Cursor list endpoint.",
            "Tried candidates:",
            ...errors.map((e) => `- ${e.candidate} => ${e.status ?? "unknown status"}`),
            "",
            "Tip: set CURSOR_LIST_URL and CURSOR_GET_URL_TEMPLATE (with {id}) to force exact endpoints."
          ].join("\n")
        );
      }

      console.log("[cursor] request", {
        baseUrl,
        listUrl: chosen.listUrl,
        query: Object.fromEntries(query.entries()),
        headers: Object.keys(headers).sort()
      });

      console.log("[cursor] list top-level keys", topLevelKeys(chosen.listJson));
      console.log("[cursor] list items", { path: chosen.itemsPath, count: chosen.items.length });
      console.log(
        "[cursor] list pagination fields",
        detectPaginationFields(chosen.listJson).map((f) => ({ path: f.path, value: trimAndRedact(f.value) }))
      );

      console.log("[cursor] list first-item sample", trimAndRedact(chosen.items[0]));

      expect(Array.isArray(chosen.items)).toBe(true);

      if (chosen.items.length === 0) {
        // Non-flaky: provider may legitimately return no tasks/runs for the account.
        return;
      }

      const first = chosen.items[0];
      const id = extractStableId(first);
      expect(id, "Expected first list item to have a stable id field (id/taskId/runId/uuid)").toBeTruthy();

      // Ensure the id field is stable across a handful of items (without being brittle).
      for (const item of chosen.items.slice(0, 5)) {
        expect(extractStableId(item), "Expected list items to include a stable id field").toBeTruthy();
      }

      const getUrl = chosen.candidate.getUrl(baseUrl, id as string);
      const got = await fetchJson(getUrl, { method: "GET", headers, timeoutMs: 15_000 });
      const gotPayload = got.json ?? safeFallbackJson(got.text);

      console.log("[cursor] get request", { getUrl, headers: Object.keys(headers).sort() });
      console.log("[cursor] get top-level keys", topLevelKeys(gotPayload));
      console.log("[cursor] get sample", trimAndRedact(gotPayload));

      expect(got.ok, `Expected GET to succeed (status=${got.status})`).toBe(true);

      const gotId = extractStableIdDeep(gotPayload);
      expect(gotId, "Expected get response to contain a stable id field somewhere").toBeTruthy();
      expect(gotId).toBe(String(id));
    }
  );
});

function safeFallbackJson(text: string): unknown {
  // If the API returns non-JSON (e.g. HTML error page), keep a small sample for debugging.
  if (!text) return undefined;
  return { nonJsonBody: text.slice(0, 1000) };
}

