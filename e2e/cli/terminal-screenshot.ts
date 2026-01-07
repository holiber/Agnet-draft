import type { Browser, TestInfo } from "@playwright/test";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function slugifyFilenamePart(input: string): string {
  const s = input
    .trim()
    .toLowerCase()
    // Keep it filesystem-friendly and stable.
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/(^-+)|(-+$)/g, "");
  return s.length > 0 ? s.slice(0, 80) : "terminal";
}

function renderTerminalHtml(opts: { title: string; lines: string[] }): string {
  const header = escapeHtml(opts.title);
  const body = escapeHtml(opts.lines.join("\n"));

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${header}</title>
    <style>
      :root {
        color-scheme: dark;
      }
      body {
        margin: 0;
        padding: 16px;
        background: #0b0f14;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      }
      .terminal {
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.10);
        background: #0e1621;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
        overflow: hidden;
      }
      .titlebar {
        padding: 10px 12px;
        background: rgba(255, 255, 255, 0.06);
        border-bottom: 1px solid rgba(255, 255, 255, 0.10);
        color: rgba(255, 255, 255, 0.85);
        font-size: 12px;
        line-height: 1;
        display: flex;
        gap: 10px;
        align-items: center;
      }
      .dots {
        display: inline-flex;
        gap: 6px;
      }
      .dot {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        display: inline-block;
      }
      .dot.red { background: #ff5f56; }
      .dot.yellow { background: #ffbd2e; }
      .dot.green { background: #27c93f; }
      pre {
        margin: 0;
        padding: 14px 16px;
        color: rgba(255, 255, 255, 0.92);
        font-size: 13px;
        line-height: 1.45;
        white-space: pre;
      }
      .dim {
        color: rgba(255, 255, 255, 0.65);
      }
    </style>
  </head>
  <body>
    <div class="terminal">
      <div class="titlebar">
        <span class="dots">
          <span class="dot red"></span>
          <span class="dot yellow"></span>
          <span class="dot green"></span>
        </span>
        <span class="dim">${header}</span>
      </div>
      <pre>${body}</pre>
    </div>
  </body>
</html>`;
}

/**
 * "Terminal screenshot" helper for CLI tests.
 *
 * We don't have a real terminal UI here, so we render a terminal-like
 * HTML snippet and screenshot it via headless Chromium. This makes it
 * deterministic and CI-friendly while still producing a human-viewable
 * terminal screenshot artifact.
 */
export async function captureTerminalScreenshot(
  browser: Browser,
  testInfo: TestInfo,
  opts: { title: string; lines: string[]; filenameHint?: string }
): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 980, height: 520 } });
  try {
    const html = renderTerminalHtml({ title: opts.title, lines: opts.lines });
    await page.setContent(html, { waitUntil: "domcontentloaded" });

    const hint = opts.filenameHint ?? opts.title;
    const fileName = `terminal-${slugifyFilenamePart(hint)}.png`;
    const filePath = testInfo.outputPath(fileName);

    // On heavily parallel CI runners Chromium can occasionally fail to capture.
    // One retry makes this robust without masking persistent failures.
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await page.screenshot({ path: filePath });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await page.waitForTimeout(75);
      }
    }
    if (lastErr) throw lastErr;
    await testInfo.attach(fileName, { path: filePath, contentType: "image/png" });
  } finally {
    await page.close();
  }
}

