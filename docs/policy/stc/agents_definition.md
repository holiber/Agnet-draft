---
version: 0.2.0
icon: 🤖
title: Agent File Format
description: Defines the required format, metadata, and execution rules for AI agent definition files.
---

Purpose

This policy defines the format and rules for AI agent definition files located in the agents/ folder.

Its goal is to make agent behavior:
	•	Explicit
	•	Deterministic
	•	Machine-readable
	•	Safe to execute

⸻

Scope

This policy applies to files with the following naming pattern:

agents/<category>_<agent-name>.agent.md


⸻

File Structure

An agent file is a Markdown document with:
	1.	An optional YAML metadata header
	2.	A Markdown body

If metadata is missing, defaults apply.

⸻

Metadata (Optional, YAML)

If present, metadata must be the first block in the file.

Metadata keys are case-insensitive.

Supported Metadata Fields & Defaults

version
	•	Version of the agent definition
	•	Default: 0.1.0

icon
	•	Single emoji
	•	Default: 🤖

title
	•	Human-readable agent name
	•	Default: the first top-level heading (# ...) in the file

description
	•	Short summary of the agent
	•	Default: the first paragraph after the first top-level heading

status
	•	Lifecycle state of the agent
	•	Default: active
	•	Allowed values:
	•	active
	•	deprecated
	•	disabled

recommended
	•	Non-mandatory guidance
	•	Supported fields:
	•	models
	•	capabilities
	•	Default: empty

required
	•	Mandatory requirements for the agent

Supported fields:
	•	env — list of required environment variables
	•	startup — name of a tool that must be executed successfully before the agent starts

Default: empty

⸻

Startup Requirements

If required.startup is defined:
	•	The referenced tool must exist in the ## Tools section
	•	The tool must execute successfully before the agent performs any work
	•	If the tool fails:
	•	The agent must not start
	•	The failure must be reported

⸻

Tools Definition

Tools are defined only in the Markdown body under the following heading:

## Tools

Rules:
	•	Tool code must be written in JavaScript
	•	Tools must be returned as an object:

{ [toolName]: { fn, scheme } }


	•	scheme must follow the OpenAI tool (function) format
	•	Tool names are case-insensitive
	•	Tool names must match required.startup exactly (case-insensitive) when used there

⸻

OpenAI Tool Scheme (Simplified)

Each tool must define a scheme with:
	•	name
	•	description
	•	parameters (JSON Schema)

Example shape:

const scheme = {
  name: "tool_name",
  description: "...",
  parameters: { ... }
};


⸻

Metadata vs Heading Resolution

Only the following Markdown headings are allowed to act as metadata sources:
	•	# <Title> → title
	•	First paragraph after # <Title> → description
	•	# Avatar → avatar (first image)
	•	## System → system
	•	## Rules → rules

All comparisons are case-insensitive.

Conflict Rules

The loader must throw an error if:
	•	A value is defined both in YAML metadata and via a heading
	•	And the values are different (ignoring case and surrounding whitespace)

⸻

System Message Resolution

The system message is resolved in this order:
	1.	Content under ## System heading
	2.	description metadata
	3.	title

⸻

Rules Resolution

Rules are resolved as:
	•	Content under ## Rules heading (if present)
	•	Otherwise empty

⸻

Abilities (Optional Extension)

If abilities are supported by the runtime:
	•	Abilities must be validated
	•	Allowed base abilities:

fs, network, sh, tool, mcp, browser, env


	•	Scoped abilities are allowed only in the form:

sh:<command>


	•	Ability names are case-insensitive

If both allow and deny lists are supported:
	•	deny always overrides allow
	•	Any overlap between allow and deny must throw an error

⸻

General Rules
	•	Metadata must not change the meaning of the agent body
	•	Defaults must keep files minimal
	•	Startup checks are hard gates
	•	Agents must stop on ambiguity
	•	If validation fails, the agent must not run


## Example of an agent that checks that api tocken is working on startup
'''md
---
version: 0.1.0
status: active
icon: 🧭
title: Policy Auditor Agent
description: Audits policy files, builds index files, and suggests minimal fixes.

recommended:
  models:
    - GPT-5.2
    - Grok Code

required:
  startup: test_openai_api_key
  env:
    - OPENAI_API_KEY
---
# Policy Auditor Agent

This agent scans policy and agent files, detects inconsistencies, builds index files, and proposes minimal, deterministic changes.

## System
You are a governance-focused AI agent. Prefer the smallest possible change. Do not invent new policies. If something is unclear or missing, report it instead of guessing.

## Rules
- Treat policies as contracts, not recommendations by default
- Prefer proposals over direct edits
- Keep changes minimal and reviewable

## Tools
```js
async function testOpenapiKey(_args, { env, fetch }) {
  const apiKey = env?.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing required env var: OPENAI_API_KEY");
  }

  const res = await fetch("https://api.openai.com/v1/models", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "n/a");
    throw new Error(
      `OPENAI_API_KEY validation failed: ${res.status} ${res.statusText} :: ${text}`
    );
  }

  return { ok: true };
}

const scheme = {
  name: "test_openai_api_key",
  description: "Validates OPENAI_API_KEY by calling a cheap OpenAI endpoint.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

return {
  test_openai_api_key: {
    fn: testOpenapiKey,
    scheme,
  },
};
'''

