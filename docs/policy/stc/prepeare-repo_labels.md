# Required Labels Policy

The repository must contain the following labels for tickets (issues).

More detailed explanations and constraints can be found in
contributing_issues_labels.md

⸻

Core Labels

research

Color: #6F42C1 (purple)

Research tickets are used for information gathering, exploration, and analysis.

Rules:
	•	No production code changes are allowed
	•	Experimental or prototype code is allowed
	•	Results must be documented in the issue or in docs/ticket/:ticket_id

⸻

plan

Color: #0EA5E9 (blue)

Plan tickets describe work that will later be split into multiple executable tasks.

They are typically created after discussions (meetings, chats, brainstorming).

Rules:
	•	A plan may contain explicit tasks or a high-level TODO list
	•	When processed, the plan must be converted into concrete issues

⸻

aigenerated

Color: #F59E0B (amber)

This label marks tickets that were created by AI agents.

Rules:
	•	Any AI-created issue must include this label
	•	The label is informational and does not grant permissions

⸻

epic

Color: #DC2626 (red)

Epic tickets represent large initiatives that consist of multiple tasks and are typically divided into Tiers.

A task qualifies as an Epic if it can be meaningfully split into staged delivery levels.

Recommended naming for Epic subtasks:

🧩 <ShortFeatureSlug> T<tier>_<order> <shortDescription>

Example:

🧩 auth-flow T1_10 Add scenario tests


⸻

Execution & Automation Labels

bug

Color: #B91C1C (dark red)

Used for bug reports.

Rules:
	•	AI agents may create bug issues only if they strictly follow
contributing_ai_reportabug

⸻

proposal

Color: #A855F7 (violet)

Used for:
	•	Feature requests
	•	Refactor requests
	•	Fixes
	•	Optimization ideas

Rules:
	•	AI agents may create proposals
	•	AI agents must follow contributing_ai_proposal

⸻

refactor

Color: #64748B (slate)

Used for refactoring-only work.

Rules:
	•	No functional changes unless explicitly stated
	•	When assigned to an AI agent, it must follow
contributing_ai_refactor

⸻

autoplan

Color: #14B8A6 (teal)

Allows an AI agent to automatically perform planning work, including:
	•	Creating plan structures
	•	Creating sub-issues
	•	Creating research tickets

Rules:
	•	AI agents MUST NOT create or apply this label themselves
	•	The label is a human-granted permission
	•	AI agents must follow contributing_ai_autoplan

⸻

autocode

Color: #22C55E (green)

Allows an AI agent to implement code automatically.

Rules:
	•	AI agents MUST NOT create or apply this label themselves
	•	The label is a human-granted permission
	•	AI agents must follow contributing_ai_autocode

⸻

⚙️ Programmatic Label Management (GitHub API)

Create a Label

curl -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/OWNER/REPO/labels \
  -d '{
    "name": "research",
    "color": "6F42C1",
    "description": "Information gathering, exploration, analysis. No production code changes."
  }'


⸻

Update an Existing Label

curl -X PATCH \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/OWNER/REPO/labels/research \
  -d '{
    "new_name": "research",
    "color": "6F42C1",
    "description": "Research, analysis, experiments. Suggestions allowed, no main code changes."
  }'


⸻

🤖 AI-Agent Notes
	•	Labels must be created exactly once
	•	AI agents may:
	•	Verify label existence
	•	Update label descriptions if policy changes
	•	AI agents must not invent new labels unless explicitly instructed
	•	autoplan and autocode act as hard execution gates and require human 
