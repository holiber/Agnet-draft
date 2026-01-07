import { describe, expect, it } from "vitest";

import { root } from "../src/modules/root.js";

describe("workbench-light root module", () => {
  it("builds a recursive schema including submodules without side-effects", () => {
    const schema = root.getApiSchema() as any;
    expect(schema.chats).toBeTruthy();
    expect(schema.providers).toBeTruthy();
    expect(schema.shortcuts).toBeTruthy();

    // Spot-check a couple endpoints.
    expect(schema.chats.send.kind).toBe("stream");
    expect(schema.providers.list.kind).toBe("query");
  });
});

