
## Scenario Web Test (with real character-by-character typing)

```ts
// tests/scenario/web/signup.scenario.test.ts
import { describe, it } from "vitest";
import {
  startWebSession,
  userSleep,
  userType,
  SCENARIO_MODE,
} from "../../test-utils";

describe("scenario/web", () => {
  it("mobile/desktop signup works", async () => {
    const session = await startWebSession();

    try {
      await session.page.goto("http://localhost:3000", {
        waitUntil: "networkidle",
      });

      await session.page.waitForSelector('[data-testid="signup"]');
      await userSleep();
      await session.page.click('[data-testid="signup"]');

      await session.page.waitForSelector('[data-testid="email"]');
      await userSleep(1200);

      // IMPORTANT:
      // - userlike: typed character-by-character with delay
      // - smoke:    filled instantly
      await userType(
        session.page,
        '[data-testid="email"]',
        "test@example.com",
      );

      await userSleep();
      await session.page.click('[data-testid="submit"]');

      await session.page.waitForSelector('[data-testid="welcome"]', {
        timeout: SCENARIO_MODE === "smoke" ? 10_000 : 30_000,
      });
    } finally {
      await session.close();
    }
  });
});
```

## CLI test
```ts

import { describe, it } from "vitest";
import { CliSession, userSleep, userTypeDelay } from "../../test-utils";

describe("scenario/cli", () => {
  it("init flow creates project", async () => {
    const cli = new CliSession("node", ["./dist/cli.js"], process.cwd());

    await cli.waitFor(/Welcome|Usage|Help/i);

    await userSleep(); // default 1500ms in userlike, 0ms in smoke

    // user-like typing
    await cli.typeCharByChar("init", () => userTypeDelay(40));
    cli.write("\r");

    await cli.waitFor(/Project name/i);

    await userSleep(1800);

    await cli.typeCharByChar("my-app", () => userTypeDelay(40));
    cli.write("\r");

    await cli.waitFor(/Success|Created|Done/i, process.env.SCENARIO_MODE === "smoke" ? 10_000 : 30_000);

    cli.kill();
  });
});

```
