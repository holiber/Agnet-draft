<p align="center">
  <img alt="Agnet logo" src="media/agnet-logo.png" />
</p>

# Agnet
A network for your AI agents

## CLI (local)

This repo ships a small CLI that can talk to local stdio agents.

```bash
# List built-in demo agents
agnet agents list

# Describe an agent (skills/capabilities)
agnet agents describe mock-agent

# One-shot invocation
agnet agents invoke --agent mock-agent --skill chat --prompt "hello"

# Session lifecycle (state persisted in ./.cache/agnet/sessions)
SESSION_ID="$(agnet agents session open --agent mock-agent)"
agnet agents session send --session "$SESSION_ID" --prompt "hello"
agnet agents session send --session "$SESSION_ID" --prompt "world"
agnet agents session close --session "$SESSION_ID"
```
