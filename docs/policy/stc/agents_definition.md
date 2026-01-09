---
version: 0.2.0
icon: 🤖
tags:
  - agents
  - governance
  - configuration
title: Agent File Format
description: Defines the required format, defaults, and security model for .agent.md files.
---

contributing_agents_file_format.md

Purpose

This policy defines the format of AI agent definition files stored in the agents/ folder inside the policies directory.

Its goal is to make agent configuration:
	•	Standardized
	•	Explicit
	•	Easy to load by humans and tools
	•	Safe and deterministic for AI execution

⸻

Scope

This policy applies to files with the following naming pattern:

agents/<category>_<agent-name>.agent.md

Example:

agents/frontend_ui-tester.agent.md
agents/backend_api-coder.agent.md


⸻

File Structure

An agent file is a Markdown document with the following structure:
	1.	Optional YAML metadata header
	2.	Markdown body

Only specific Markdown headings are allowed to act as metadata keys (see below).
All other headings are treated as plain documentation.

⸻

Optional YAML Metadata

If present, the YAML metadata must be the first block in the file.

Metadata is optional.
If a field is missing, defaults apply.

Metadata must not contradict the Markdown body.

⸻

Supported Metadata Fields & Defaults

version
	•	Version of the agent definition
	•	Default: 0.1.0

⸻

icon
	•	Single emoji
	•	Default: 🤖

⸻

title
	•	Human-readable agent name
	•	Default: the first top-level heading (# ...) in the file

⸻

description
	•	Short agent summary
	•	Default: the first paragraph after the first top-level heading

⸻

tags
	•	List of strings for search and grouping
	•	Default: empty list

⸻

roles
	•	List of agent roles (e.g. planner, coder, reviewer)
	•	Default: empty list

⸻

avatar
	•	Avatar image reference
	•	Default resolution order:
	1.	First image under # Avatar heading
	2.	First image at the start of the markdown body
	3.	Not set

⸻

system
	•	System message for the agent
	•	Default resolution order:
	1.	Content under ## System heading (if exists)
	2.	description metadata (if exists)
	3.	title

⸻

recommended
	•	Non-mandatory guidance for the agent
	•	Supported fields:
	•	models
	•	capabilities
	•	Default: empty object

⸻

required
	•	Mandatory requirements for the agent
	•	Supported fields:
	•	models
	•	capabilities
	•	Default: empty object

⸻

allow
	•	Whitelist of allowed abilities
	•	Default: * (all abilities allowed)
	•	"" or false means no abilities allowed

⸻

deny
	•	Blacklist of forbidden abilities
	•	Default: empty
	•	deny always overrides allow

⸻

limits
	•	Hard execution limits
	•	Default values:
	•	time_per_message: 5 minutes
	•	max_files_changed: 100

⸻

status
	•	Lifecycle status of the agent
	•	Default: active
	•	Supported values:
	•	active
	•	deprecated
	•	disabled

⸻

rules
	•	Explicit rules for the agent
	•	Default value:
	•	Content under ## Rules heading (if present)
	•	Otherwise empty

⸻

policies
	•	List of policies the agent must load and follow
	•	Default: empty
	•	Supported formats:
	•	Local policy name (e.g. contributing_ai_codingworkflow.md)
	•	Wildcards (e.g. contributing_ai_*)
	•	URL to a policy file

⸻

Abilities

Abilities define what an agent is allowed to do.

Supported Abilities

Base abilities:
	•	fs — filesystem access
	•	network — network access
	•	sh — shell commands
	•	tool — tool calls
	•	MCP — MCP capabilities
	•	browser — browser interaction
	•	env — environment inspection

⸻

Scoped Abilities

Abilities may be scoped.

Examples:
	•	sh:gh — allow calling gh
	•	sh:ls — allow calling ls

Rules:
	•	Scoped permissions override unscoped defaults
	•	Scoped denies override scoped allows

⸻

Markdown Headings as Metadata Keys

Only the following Markdown headings are allowed to act as metadata sources:
	•	# <Title> → title
	•	First paragraph after # <Title> → description
	•	# Avatar → avatar
	•	## System → system
	•	## Rules → rules

All other headings are treated as documentation only.

⸻

Minimal Example Agent File

---
title: Backend Autocode Agent
roles: [coder]
allow: [fs, tool, sh:gh]
deny: [network]
limits:
  time_per_message: 5m
  max_files_changed: 100
policies:
  - contributing_issue_codingworkflow.md
  - contributing_ai_codingworkflow.md
---

# Backend Autocode Agent

This agent implements small backend changes safely and incrementally.

## System
Follow all coding and AI workflow policies strictly.

## Rules
- Keep changes minimal
- Add or update tests
- Stop and mark `help needed` if blocked


⸻

General Principles
	•	Defaults must keep agent files short
	•	Explicit metadata overrides inferred values
	•	deny always wins over allow
	•	Agents must stop when limits are exceeded
	•	If behavior is ambiguous, the agent must not proceed

⸻
