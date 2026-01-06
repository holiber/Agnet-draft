# Contributing

Thanks for contributing to Agnet.

## Development workflow

- Install dependencies:

```bash
npm ci
```

- Run unit tests:

```bash
npm test
```

- Typecheck (CI lint step):

```bash
npm run lint
```

## API docs generation (required)

This repository checks in generated API docs under `docs/generated/`.

- Regenerate API docs:

```bash
npm run docs:api
```

- Ensure the generated docs are committed:
  - `docs/generated/api.json`
  - `docs/generated/api.md`

CI enforces that generated docs are up to date. If you change any endpoints or CLI args and do not update `docs/generated/*`, the `docs:api:check` step will fail.

