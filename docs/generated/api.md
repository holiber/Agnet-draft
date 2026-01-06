# Agnet API Reference

Version: **1**

---

## agents.*

### `agents.describe` (unary)

**Args**
- `agentId` (string, required)
- `json` (boolean, optional)

---

### `agents.invoke` (serverStream)

**Args**
- `agentId` (string, optional)
- `skill` (string, required)
- `prompt` (string, required)

---

### `agents.list` (unary)

**Args**
- `json` (boolean, optional)

---

### `agents.register` (unary)

**Args**
- `files` (string[], optional)
- `file` (string, optional)
- `json` (string, optional)
- `bearerEnv` (string, optional)
- `apiKeyEnv` (string, optional)
- `headerEnv` (string[], optional)

---

### `agents.task.close` (unary)

**Args**
- `taskId` (string, required)

---

### `agents.task.open` (unary)

**Args**
- `agentId` (string, optional)
- `skill` (string, optional)

---

### `agents.task.send` (serverStream)

**Args**
- `taskId` (string, required)
- `prompt` (string, required)

---

## Metadata

- Snapshot schema version: 1
- Profile: default
- Generated at: 1970-01-01T00:00:00.000Z

> Generated from runtime API snapshot. Do not edit manually.
