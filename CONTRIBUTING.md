## Contributing

### API changes and generated documentation

Before pushing changes that affect the public API (decorated endpoints, argument metadata, or dynamic module loading):

- Run `npm run docs:api`
- Commit the updated generated files:
  - `docs/generated/api.json`
  - `docs/generated/api.md`

CI will regenerate these files and fail the build if they differ from what is committed.

