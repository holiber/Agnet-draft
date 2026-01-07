<p align="center">
  <img alt="Agnet logo" src="media/agnet-logo.png" />
</p>

## Human-style vs Computer-style API

Agnet has two parallel entrypoints built on the same execution model:

- **Human-style**: `agnet.ask(request)` → `Promise<string>`
  - Optimized for scripts, REPL usage, CLI, and docs examples
  - **Syntax sugar for**: `await (await agnet.chats.create(request)).response()`

- **Computer-style**: `agnet.prompt(request)` → `Promise<Result>`
  - Optimized for programmatic workflows and integrations
  - **Syntax sugar for**: `await (await agnet.chats.create(request)).result()`

## Unified request input

All of these accept the same input type:

- `agnet.ask(request)`
- `agnet.prompt(request)`
- `agnet.chats.create(request)`

```ts
export type TAgentRequest =
  | string
  | {
      providerId?: string;
      prompt: string;
    };
```

### Default provider resolution (deterministic)

If `providerId` is not provided, Agnet resolves the default provider in this order:

1. A provider explicitly marked as default (supported via `agent.extensions.default: true` or `agent.extensions.isDefault: true`)
2. Otherwise, the **last registered** provider

## Examples

### API (TypeScript)

```ts
import { Agnet } from "agnet";

const agnet = new Agnet();

const response = await agnet.ask("hello");

const result = await agnet.prompt("hello");
console.log(result.text, result.providerId);
```

### CLI

```bash
agnet ask "hello"
agnet prompt "hello" --provider mock-agent
```
