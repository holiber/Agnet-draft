import { describe, expect, it } from "vitest";

import { parseAgentMdx } from "../src/agent-mdx.js";

describe(".agent.mdx parsing (Tier1)", () => {
  it("parses frontmatter + required sections into AgentConfig", () => {
    const mdx = `---
id: codegen
name: CodeGen Agent
version: 0.1.0

runtime:
  transport: cli
  command: codegen-agent
  args: ["--stdio"]

mcp:
  tools: ["fs.read", "fs.write"]

auth:
  kind: bearer
  header: Authorization
---
# Description
Human-readable **markdown** description.

## System Prompt
You are a helpful assistant.

## Rules
### minimal files
Prefer fewer files.

### no-vendor-lock
Avoid vendor-specific APIs in core logic.

## Skills
### chat
General conversation.

### codegen
Generate TypeScript code following project conventions.
`;

    const config = parseAgentMdx(mdx, { path: "codegen.agent.mdx" });
    expect(config.agent.id).toBe("codegen");
    expect(config.agent.name).toBe("CodeGen Agent");
    expect(config.agent.version).toBe("0.1.0");
    expect(config.runtime.transport).toBe("cli");

    expect(config.agent.description).toContain("Human-readable **markdown**");
    expect((config.agent.extensions as any)?.systemPrompt).toContain("You are a helpful assistant.");

    expect(config.agent.mcp?.tools).toEqual(["fs.read", "fs.write"]);
    expect(config.agent.auth?.kind).toBe("bearer");
    expect(config.agent.auth?.header).toBe("Authorization");

    expect(config.agent.rules?.map((r) => r.id)).toEqual(["minimal-files", "no-vendor-lock"]);
    expect(config.agent.skills.map((s) => s.id)).toEqual(["chat", "codegen"]);
  });

  it("rejects frontmatter/body conflicts with a clear error", () => {
    const mdx = `---
id: a
name: A
version: 0.1.0
description: nope
runtime:
  transport: cli
  command: a
---
# Description
Hi

## System Prompt
x

## Rules

## Skills
### chat
Hi
`;
    expect(() => parseAgentMdx(mdx, { path: "a.agent.mdx" })).toThrowError(
      /Choose exactly one source/
    );
  });

  it("rejects duplicate skill ids after normalization", () => {
    const mdx = `---
id: a
name: A
version: 0.1.0
runtime:
  transport: cli
  command: a
---
# Description
Hi

## System Prompt
x

## Rules

## Skills
### CodeGen
One

### codegen
Two
`;
    expect(() => parseAgentMdx(mdx, { path: "a.agent.mdx" })).toThrowError(/Duplicate skills id/);
  });

  it("rejects missing required sections", () => {
    const mdx = `---
id: a
name: A
version: 0.1.0
runtime:
  transport: cli
  command: a
---
# Description
Hi

## System Prompt
x

## Skills
### chat
Hi
`;
    expect(() => parseAgentMdx(mdx, { path: "a.agent.mdx" })).toThrowError(/missing required markdown section/i);
  });
});

