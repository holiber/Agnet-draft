# Setup tests

The repo should have next commands for test running in the package.json

```json
{
  "scripts": {
    "test": "pnpm run test:unit && pnpm run test:e2e",

    "test:unit": "vitest run tests/unit --exclude tests/unit/integration",
    "test:unit:integration": "vitest run tests/unit/integration",

    "test:e2e": "playwright test tests/e2e --ignore tests/e2e/integration",
    "test:e2e:integration": "playwright test tests/e2e/integration",

    "test:scenario:smoke": "SCENARIO_MODE=smoke node scripts/run-scenarios.mjs --no-integration",
    "test:scenario:userlike": "SCENARIO_MODE=userlike node scripts/run-scenarios.mjs --no-integration",
    "test:scenario:userlike:web": "SCENARIO_MODE=userlike node scripts/run-scenarios.mjs --web --no-integration",
    "test:scenario:userlike:web:mobile": "SCENARIO_MODE=userlike node scripts/run-scenarios.mjs --web --mobile --no-integration",

    "test:scenario:integration": "SCENARIO_MODE=smoke node scripts/run-scenarios.mjs --integration",

    "test:integration": "pnpm run test:unit:integration && pnpm run test:e2e:integration && pnpm run test:scenario:integration"
  }
}


```

Also the repo requires some helper files to run these tests

## utils
```ts
// tests/test-utils.ts
import * as pty from "node-pty";
import { chromium, devices, type Browser, type BrowserContext, type Page } from "playwright";

// SCENARIO MODES

/**
 * SCENARIO_MODE:
 * - "smoke"    -> no delays, fastest possible execution
 * - "userlike" -> real pauses and typing delays (human-like)
 */
export type ScenarioMode = "smoke" | "userlike";

export const SCENARIO_MODE: ScenarioMode =
  process.env.SCENARIO_MODE === "smoke" ? "smoke" : "userlike";

/**
 * SCENARIO_WEB_DEVICE:
 * - "desktop" (default)
 * - "mobile"
 */
export type WebDeviceMode = "desktop" | "mobile";

export const SCENARIO_WEB_DEVICE: WebDeviceMode =
  process.env.SCENARIO_WEB_DEVICE === "mobile" ? "mobile" : "desktop";

// USER-LIKE HELPERS

/**
 * userSleep
 *
 * Explicit pause between user actions.
 * - userlike: real delay
 * - smoke:    always 0ms
 */
export async function userSleep(ms = 1500): Promise<void> {
  if (SCENARIO_MODE === "smoke") return;
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * userTypeDelay
 *
 * Small delay between keystrokes.
 * Convenience helper built on top of userSleep.
 */
export async function userTypeDelay(ms = 40): Promise<void> {
  await userSleep(ms);
}

// CLI utilities (PTY)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * CliSession
 *
 * Runs CLI inside a pseudo-terminal so it behaves like a real user terminal.
 */
export class CliSession {
  private term: pty.IPty;
  private buffer = "";

  constructor(cmd: string, args: string[], cwd: string) {
    this.term = pty.spawn(cmd, args, {
      cwd,
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      env: { ...process.env, FORCE_COLOR: "1" },
    });

    this.term.onData((data) => {
      this.buffer += data;
    });
  }

  output(): string {
    return this.buffer;
  }

  write(text: string): void {
    this.term.write(text);
  }

  kill(): void {
    this.term.kill();
  }

  /**
   * Types text character-by-character.
   * Timing is fully controlled by the test via userTypeDelay / userSleep.
   */
  async typeCharByChar(text: string, onEachChar?: () => Promise<void>) {
    for (const ch of text) {
      this.term.write(ch);
      if (onEachChar) {
        await onEachChar();
      }
    }
  }

  async waitFor(pattern: RegExp | string, timeoutMs = 20_000): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const content = this.buffer;
      const matched =
        typeof pattern === "string"
          ? content.includes(pattern)
          : pattern.test(content);

      if (matched) return;

      await sleep(50);
    }

    throw new Error(
      `Timeout waiting for: ${pattern}\n\nCLI output so far:\n${this.buffer}`
    );
  }
}

// WEB UTILS (Playwright)    

export type WebSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
};

/**
 * startWebSession
 *
 * - Always creates a fresh browser context
 * - Device (desktop/mobile) is selected via SCENARIO_WEB_DEVICE
 * - Video recording is enabled automatically in userlike mode
 *   when E2E_WEB_VIDEO_DIR is provided
 */
export async function startWebSession(): Promise<WebSession> {
  const browser = await chromium.launch({ headless: true });

  const recordVideoDir =
    SCENARIO_MODE === "userlike" ? process.env.E2E_WEB_VIDEO_DIR : undefined;

  let context: BrowserContext;

  if (SCENARIO_WEB_DEVICE === "mobile") {
    const device = devices["iPhone 14"];
    context = await browser.newContext({
      ...device,
      recordVideo: recordVideoDir ? { dir: recordVideoDir } : undefined,
    });
  } else {
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: recordVideoDir ? { dir: recordVideoDir } : undefined,
    });
  }

  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    close: async () => {
      // Video is finalized when context is closed
      await context.close();
      await browser.close();
    },
  };
}

/**
 * userType (Web)
 *
 * User-like text input for web forms.
 *
 * - smoke:    uses fill() (instant)
 * - userlike: focuses field and types character-by-character with delay
 */
export async function userType(
  page: Page,
  selector: string,
  text: string,
  perCharDelayMs = 40
): Promise<void> {
  if (SCENARIO_MODE === "smoke") {
    await page.fill(selector, text);
    return;
  }

  await page.click(selector);
  await page.fill(selector, "");

  await page.type(selector, text, {
    delay: perCharDelayMs,
  });
}
```

## Scenario test runner

```mjs
// scripts/run-scenarios.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const ROOT = process.cwd();
const SCENARIO_DIR = path.join(ROOT, "tests", "scenario");

// mode
const MODE = process.env.SCENARIO_MODE === "smoke" ? "smoke" : "userlike";

// smoke logs
const CACHE_DIR = path.join(ROOT, ".cache", "smokecheck");

// artifacts
const ARTIFACTS_ROOT = path.join(ROOT, "artifacts", "user-style-e2e");
const WEB_VIDEO_ROOT = path.join(ARTIFACTS_ROOT, "web");
const CLI_VIDEO_ROOT = path.join(ARTIFACTS_ROOT, "cli");

// args
const argv = process.argv.slice(2);
const onlyWeb = argv.includes("--web");
const onlyCli = argv.includes("--cli");
const mobile = argv.includes("--mobile");
const onlyIntegration = argv.includes("--integration");
const noIntegration = argv.includes("--no-integration");

// If neither specified, run both
const runWeb = onlyCli ? false : true;
const runCli = onlyWeb ? false : true;

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function resetDirs() {
  if (MODE === "smoke") {
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    mkdirp(CACHE_DIR);
  }
  if (MODE === "userlike") {
    mkdirp(WEB_VIDEO_ROOT);
    mkdirp(CLI_VIDEO_ROOT);
  }
}

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function isScenarioFile(p) {
  return p.endsWith(".scenario.test.ts") || p.endsWith(".scenario.test.js");
}

function isIntegrationScenario(file) {
  const rel = path.relative(SCENARIO_DIR, file).split(path.sep);
  return rel.includes("integration");
}

function targetOf(file) {
  const rel = path.relative(SCENARIO_DIR, file).split(path.sep);

  // supports:
  // tests/scenario/cli/...
  // tests/scenario/web/...
  // tests/scenario/cli/integration/...
  // tests/scenario/integration/cli/...
  if (rel.includes("cli")) return "cli";
  return "web";
}

function safeBase(file) {
  return path
    .basename(file)
    .replace(/\.scenario\.test\.(ts|js)$/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function runVitestOneFile({ file, env, stdio }) {
  const cmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const args = [
    "vitest",
    "run",
    "--config",
    "vitest.scenario.config.ts",
    file,
    "--no-threads",
    "--single-thread",
    "--bail=1",
  ];

  return spawnSync(cmd, args, {
    env: { ...process.env, ...env },
    stdio,
  });
}

// cast -> mp4 via agg + ffmpeg
function convertCastToMp4(castPath, mp4Path) {
  const gifPath = mp4Path.replace(/\.mp4$/, ".gif");

  let r = spawnSync("agg", [castPath, gifPath], { stdio: "inherit" });
  if (r.status !== 0) return false;

  r = spawnSync(
    "ffmpeg",
    ["-y", "-i", gifPath, "-movflags", "faststart", "-pix_fmt", "yuv420p", mp4Path],
    { stdio: "inherit" }
  );
  return r.status === 0;
}

function runCliUserlikeWithVideo(file) {
  const base = safeBase(file);
  const outDir = path.join(CLI_VIDEO_ROOT, base);
  mkdirp(outDir);

  const castPath = path.join(outDir, `${base}.cast`);
  const mp4Path = path.join(outDir, `${base}.mp4`);

  const cmd = [
    "asciinema",
    "rec",
    "--overwrite",
    "-q",
    "-c",
    `SCENARIO_MODE=userlike pnpm vitest run --config vitest.scenario.config.ts "${file}" --no-threads --single-thread --bail=1`,
    castPath,
  ];

  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
  if (r.status !== 0) return { ok: false, outDir };

  const okMp4 = convertCastToMp4(castPath, mp4Path);
  return { ok: okMp4, outDir, castPath, mp4Path };
}

// main
resetDirs();

let files = walk(SCENARIO_DIR).filter(isScenarioFile).sort();

files = files.filter((f) => {
  const t = targetOf(f);
  if (t === "web" && !runWeb) return false;
  if (t === "cli" && !runCli) return false;

  const integ = isIntegrationScenario(f);
  if (onlyIntegration && !integ) return false;
  if (noIntegration && integ) return false;

  return true;
});

const total = files.length;
if (total === 0) {
  process.stdout.write("passed 0/0 in 0.00s\n");
  process.exit(0);
}

let passed = 0;
const started = performance.now();

for (const file of files) {
  const base = safeBase(file);
  const integ = isIntegrationScenario(file);

  // fail early if integration scenario is run without secrets
  if (integ && !process.env.OPENAI_API_KEY) {
    process.stdout.write(`FAILED: ${file}\n`);
    process.stdout.write(`missing required env: OPENAI_API_KEY\n`);
    process.exit(1);
  }

  if (MODE === "smoke") {
    const logPath = path.join(CACHE_DIR, `${base}.log`);
    const fd = fs.openSync(logPath, "w");

    const r = runVitestOneFile({
      file,
      env: {
        SCENARIO_MODE: "smoke",
        SCENARIO_WEB_DEVICE: mobile ? "mobile" : "desktop",
      },
      stdio: ["ignore", fd, fd],
    });

    fs.closeSync(fd);

    if (r.status !== 0) {
      const elapsed = ((performance.now() - started) / 1000).toFixed(2);
      process.stdout.write(`passed ${passed}/${total} in ${elapsed}s\n`);
      process.stdout.write(`FAILED: ${file}\n`);
      process.stdout.write(`log: ${logPath}\n`);
      process.exit(1);
    }

    passed += 1;
    continue;
  }

  // USERLIKE
  if (targetOf(file) === "cli") {
    const res = runCliUserlikeWithVideo(file);
    if (!res.ok) {
      const elapsed = ((performance.now() - started) / 1000).toFixed(2);
      process.stdout.write(`passed ${passed}/${total} in ${elapsed}s\n`);
      process.stdout.write(`FAILED: ${file}\n`);
      process.stdout.write(`cli video dir: ${res.outDir}\n`);
      process.exit(1);
    }

    passed += 1;
    continue;
  }

  const webOutDir = path.join(WEB_VIDEO_ROOT, base);
  mkdirp(webOutDir);

  const r = runVitestOneFile({
    file,
    env: {
      SCENARIO_MODE: "userlike",
      SCENARIO_WEB_DEVICE: mobile ? "mobile" : "desktop",
      E2E_WEB_VIDEO_DIR: webOutDir,
    },
    stdio: "inherit",
  });

  if (r.status !== 0) {
    const elapsed = ((performance.now() - started) / 1000).toFixed(2);
    process.stdout.write(`passed ${passed}/${total} in ${elapsed}s\n`);
    process.stdout.write(`FAILED: ${file}\n`);
    process.stdout.write(`web video dir: ${webOutDir}\n`);
    process.exit(1);
  }

  passed += 1;
}

const elapsed = ((performance.now() - started) / 1000).toFixed(2);
process.stdout.write(`passed ${passed}/${total} in ${elapsed}s\n`);
process.exit(0);

```
