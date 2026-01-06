import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";

import { AgentInterop } from "../src/agent-interop.js";

describe("AgentInterop.register (.agent.mdx)", () => {
  it("registers from a .agent.mdx file path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agentinterop-mdx-"));
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

    const ai = new AgentInterop();
    const ref = ai.register(mdxPath);
    expect(ref.id).toBe("mdx-a");
    expect(ref.runtime?.transport).toBe("http");
    expect(ai.listAgents().map((a) => a.id)).toContain("mdx-a");
    expect((ai.get("mdx-a")?.card.extensions as any)?.systemPrompt).toContain("System prompt A.");
  });
});

