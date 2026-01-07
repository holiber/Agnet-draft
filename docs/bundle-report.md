# Bundle report

This document records what `npm run build` produces in `dist/` and what is (and is not) bundled into the build artifacts.

## Build command

```bash
npm ci
npm run build
```

## Environment

- **Node.js**: v24.12.0
- **npm**: 11.6.2
- **tsup**: 8.5.1
- **Build target**: node18 (per `tsup.config.ts`)

## Build size

All sizes below are **raw file sizes** (not compressed).

- **Total `dist/` size (all artifacts)**: 624,416 bytes
- **Runtime JS only (`.js` + `.cjs`)**: 190,448 bytes
- **Source maps (`.map`)**: 380,314 bytes
- **Type declarations (`.d.ts` + `.d.cts`)**: 53,654 bytes

### `dist/` file list (bytes)

| File | Bytes |
| --- | ---: |
| `dist/index.cjs.map` | 127,357 |
| `dist/cli/runCli.cjs.map` | 108,122 |
| `dist/index.cjs` | 67,438 |
| `dist/cli/runCli.cjs` | 51,462 |
| `dist/chunk-HRWFFVIS.js.map` | 48,024 |
| `dist/index.js.map` | 33,989 |
| `dist/index.d.cts` | 26,751 |
| `dist/index.d.ts` | 26,751 |
| `dist/chunk-HRWFFVIS.js` | 22,646 |
| `dist/cli/runCli.js.map` | 18,222 |
| `dist/chunk-GPIMNU74.js.map` | 17,143 |
| `dist/index.js` | 16,663 |
| `dist/chunk-PJW2WJEY.js.map` | 14,280 |
| `dist/cli/runCli.js` | 9,111 |
| `dist/chunk-6YYMCS4B.js.map` | 8,488 |
| `dist/chunk-GPIMNU74.js` | 7,848 |
| `dist/chunk-PJW2WJEY.js` | 7,591 |
| `dist/chunk-6YYMCS4B.js` | 4,700 |
| `dist/chunk-XDJJEWBH.js.map` | 4,476 |
| `dist/chunk-XDJJEWBH.js` | 2,368 |
| `dist/shortcuts-api-BKDZBDEE.js` | 251 |
| `dist/chats-api-R4W7JCDW.js` | 209 |
| `dist/providers-api-YNYQKOWD.js` | 161 |
| `dist/cli/runCli.d.cts` | 76 |
| `dist/cli/runCli.d.ts` | 76 |
| `dist/chats-api-R4W7JCDW.js.map` | 71 |
| `dist/providers-api-YNYQKOWD.js.map` | 71 |
| `dist/shortcuts-api-BKDZBDEE.js.map` | 71 |

## Modules included in the build

### Output modules (files emitted into `dist/`)

- **Entry points**:
  - `dist/index.js` (ESM)
  - `dist/index.cjs` (CJS)
  - `dist/cli/runCli.js` (ESM)
  - `dist/cli/runCli.cjs` (CJS)
- **ESM chunks**:
  - `dist/chunk-HRWFFVIS.js`
  - `dist/chunk-GPIMNU74.js`
  - `dist/chunk-PJW2WJEY.js`
  - `dist/chunk-6YYMCS4B.js`
  - `dist/chunk-XDJJEWBH.js`
  - `dist/providers-api-YNYQKOWD.js`
  - `dist/chats-api-R4W7JCDW.js`
  - `dist/shortcuts-api-BKDZBDEE.js`
- **Types**:
  - `dist/index.d.ts`, `dist/index.d.cts`
  - `dist/cli/runCli.d.ts`, `dist/cli/runCli.d.cts`

### Bundled npm packages (inlined from `node_modules/`)

None. No sources under `node_modules/` appear in the generated sourcemaps, which indicates the build output only contains code from this repository.

## Modules not included in the build (externalized)

These are modules referenced via `import`/`require` in `dist/**/*.js` and `dist/**/*.cjs`, but not bundled into the output.

### External third-party modules

- `yaml`

### External Node.js built-ins

- `child_process`
- `fs`
- `fs/promises`
- `path`
- `process`
- `util`

## How this was derived

- **Bundled npm packages**: scanned `dist/**/*.map` and extracted package names from any `.../node_modules/<pkg>/...` sources.
- **External modules**: scanned `dist/**/*.js` and `dist/**/*.cjs` for `import ... from "<specifier>"`, `export * from "<specifier>"`, `import("<specifier>")`, and `require("<specifier>")`.
