import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";

import { Agnet } from "../src/agnet.js";

describe("Agnet.providers.register (.agent.mdx)", () => {
  it("registers from a .agent.mdx file path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agnet-mdx-"));
    const mdxPath = path.join(dir, "a.agent.mdx");

    await writeFile(
      mdxPath,
      `---
id: mdx-a
name: MDX A
version: 0.1.0
runtime:
  transport: http
  baseUrl: https://example.com
---
# Description
MDX agent A.

## System Prompt
System prompt A.

## Rules
### minimal-files
Prefer fewer files.

## Skills
### chat
Talk.
`,
      "utf-8"
    );

    const ai = new Agnet({ cwd: dir });
    const ref = ai.providers.register(mdxPath);
    expect(ref.id).toBe("mdx-a");
    expect(ref.runtime?.transport).toBe("http");
    expect(ai.providers.list().map((a) => a.id)).toContain("mdx-a");
    expect((ai.providers.get("mdx-a")?.card.extensions as any)?.systemPrompt).toContain("System prompt A.");
  });
});

