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

type OpenHandsEndpointCandidate = {
  name: string;
  listUrl: (baseUrl: string) => string;
  getUrl: (baseUrl: string, id: string) => string;
};

function openHandsAuthHeaders(): Record<string, string> {
  const bearer =
    envOrUndefined("OPENHANDS_BEARER_TOKEN") ?? envOrUndefined("OPENHANDS_AUTH_TOKEN") ?? envOrUndefined("OPENHANDS_API_KEY");
  if (!bearer) return {};

  const headerName = envOrUndefined("OPENHANDS_AUTH_HEADER") ?? "Authorization";
  const headerValue = envOrUndefined("OPENHANDS_AUTH_VALUE") ?? `Bearer ${bearer}`;
  return { [headerName]: headerValue };
}

function openHandsBaseUrl(): string | undefined {
  return envOrUndefined("OPENHANDS_BASE_URL");
}

function openHandsCandidates(): OpenHandsEndpointCandidate[] {
  const listUrlOverride = envOrUndefined("OPENHANDS_LIST_URL");
  const getUrlTemplate = envOrUndefined("OPENHANDS_GET_URL_TEMPLATE"); // supports "{id}"
  if (listUrlOverride && getUrlTemplate) {
    return [
      {
        name: "env:OPENHANDS_LIST_URL + OPENHANDS_GET_URL_TEMPLATE",
        listUrl: () => listUrlOverride,
        getUrl: (_base, id) => getUrlTemplate.replaceAll("{id}", encodeURIComponent(id))
      }
    ];
  }

  return [
    {
      name: "api/conversations",
      listUrl: (base) => joinUrl(base, "/api/conversations"),
      getUrl: (base, id) => joinUrl(base, `/api/conversations/${encodeURIComponent(id)}`)
    },
    {
      name: "v1/conversations",
      listUrl: (base) => joinUrl(base, "/v1/conversations"),
      getUrl: (base, id) => joinUrl(base, `/v1/conversations/${encodeURIComponent(id)}`)
    },
    {
      name: "conversations",
      listUrl: (base) => joinUrl(base, "/conversations"),
      getUrl: (base, id) => joinUrl(base, `/conversations/${encodeURIComponent(id)}`)
    }
  ];
}

describe("OpenHands Conversations API (discovery logging)", () => {
  const baseUrl = openHandsBaseUrl();
  const headers = openHandsAuthHeaders();
  const hasCreds = !!baseUrl && Object.keys(headers).length > 0;

  it.skipIf(!hasCreds)(
    "lists conversations and fetches one by id (logs shape + pagination)",
    { timeout: 30_000 },
    async () => {
      const query = new URLSearchParams();
      query.set("limit", "10");

      const errors: Array<{ candidate: string; status?: number; bodySample?: unknown }> = [];
      let chosen:
        | {
            candidate: OpenHandsEndpointCandidate;
            listUrl: string;
            listJson: unknown;
            items: unknown[];
            itemsPath: string;
          }
        | undefined;

      for (const candidate of openHandsCandidates()) {
        const url = new URL(candidate.listUrl(baseUrl as string));
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
            "Failed to discover a working OpenHands conversations list endpoint.",
            "Tried candidates:",
            ...errors.map((e) => `- ${e.candidate} => ${e.status ?? "unknown status"}`),
            "",
            "Tip: set OPENHANDS_LIST_URL and OPENHANDS_GET_URL_TEMPLATE (with {id}) to force exact endpoints."
          ].join("\n")
        );
      }

      console.log("[openhands] request", {
        baseUrl,
        listUrl: chosen.listUrl,
        query: Object.fromEntries(query.entries()),
        headers: Object.keys(headers).sort()
      });

      console.log("[openhands] list top-level keys", topLevelKeys(chosen.listJson));
      console.log("[openhands] list items", { path: chosen.itemsPath, count: chosen.items.length });
      console.log(
        "[openhands] list pagination fields",
        detectPaginationFields(chosen.listJson).map((f) => ({ path: f.path, value: trimAndRedact(f.value) }))
      );
      console.log("[openhands] list first-item sample", trimAndRedact(chosen.items[0]));

      expect(Array.isArray(chosen.items)).toBe(true);

      if (chosen.items.length === 0) {
        // Non-flaky: provider may legitimately return no conversations.
        return;
      }

      const first = chosen.items[0];
      const id = extractStableId(first);
      expect(id, "Expected first list item to have an id field (id/conversationId/uuid)").toBeTruthy();

      for (const item of chosen.items.slice(0, 5)) {
        expect(extractStableId(item), "Expected list items to include a stable id field").toBeTruthy();
      }

      const getUrl = chosen.candidate.getUrl(baseUrl as string, id as string);
      const got = await fetchJson(getUrl, { method: "GET", headers, timeoutMs: 15_000 });
      const gotPayload = got.json ?? safeFallbackJson(got.text);

      console.log("[openhands] get request", { getUrl, headers: Object.keys(headers).sort() });
      console.log("[openhands] get top-level keys", topLevelKeys(gotPayload));
      console.log("[openhands] get sample", trimAndRedact(gotPayload));

      expect(got.ok, `Expected GET to succeed (status=${got.status})`).toBe(true);

      const gotId = extractStableIdDeep(gotPayload);
      expect(gotId, "Expected get response to contain a stable id field somewhere").toBeTruthy();
      expect(gotId).toBe(String(id));
    }
  );
});

function safeFallbackJson(text: string): unknown {
  if (!text) return undefined;
  return { nonJsonBody: text.slice(0, 1000) };
}

