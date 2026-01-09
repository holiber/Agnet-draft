---
version: 0.3.0
icon: 🤖
title: Agent File Format
description: Defines the required format, metadata, commands, tools, and execution rules for AI agent definition files.
---

contributing_agents_file_format.md

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

templateEngine
	•	Enables template rendering for some text fields using the agent context (ctx)
	•	Default: hbs
	•	Disable templating by setting to ""
	•	Template rendering is applied by the runtime (not by this policy)

input
	•	Optional initial runtime input for the agent
	•	This value is provided to ctx.input at start
	•	Default: empty

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

commands
Defines Cursor-style commands supported by this agent.

commands is a list. Each list item is one of:
	1.	Local path (file or folder)
	2.	Remote URL (file or folder)
	3.	Inline command definition object

Examples:

commands:
  - ./commands
  - ./commands/test.md
  - https://example.com/commands/
  - https://example.com/commands/test.md
  - name: test
    description: Generates unit tests for a specific function or file.
    argument-hint: [target-name] [framework]
    body: |
      Create unit tests for $1 using the $2 framework.
      Ensure the tests cover edge cases and follow our project style.

Inline command fields:
	•	name (required for inline commands)
	•	description (required)
	•	body (required)
	•	argument-hint (optional; string or list)

Command substitution rules:
	•	$1, $2, … are positional arguments
	•	$ARGUMENTS is all arguments joined by spaces

If a referenced positional argument is missing, the runtime must treat the invocation as invalid.

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
	•	The code must return an object:

{ [toolName]: { fn, scheme } }


	•	scheme must follow the OpenAI tool (function) format (simplified)
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

⸻

This policy defines the authoritative contract for agent definition files.

