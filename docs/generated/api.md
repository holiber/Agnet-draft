# Agnet API Reference

Version: **1**

---

## ask.*

### `ask` (unary)

**Args**
- `prompt` (string, required)
- `providerId` (string, optional)

---

## chats.*

### `chats.close` (unary)

**Args**
- `chatId` (string, required)

---

### `chats.create` (unary)

**Args**
- `providerId` (string, optional)

---

### `chats.send` (serverStream)

**Args**
- `chatId` (string, required)
- `prompt` (string, required)

---

## prompt.*

### `prompt` (unary)

**Args**
- `prompt` (string, required)
- `providerId` (string, optional)

---

## providers.*

### `providers.describe` (unary)

**Args**
- `providerId` (string, required)
- `json` (boolean, optional)

---

### `providers.list` (unary)

**Args**
- `json` (boolean, optional)

---

### `providers.register` (unary)

**Args**
- `files` (string[], optional)
- `file` (string, optional)
- `json` (string, optional)
- `bearerEnv` (string, optional)
- `apiKeyEnv` (string, optional)
- `headerEnv` (string[], optional)

---

## Metadata

- Snapshot schema version: 1
- Profile: default
- Generated at: 1970-01-01T00:00:00.000Z

> Generated from runtime API snapshot. Do not edit manually.
