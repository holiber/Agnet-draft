# Testing Strategy

The project uses **several types of tests**, each serving a specific purpose.
It’s important to understand **when to write which test** so that tests remain fast, useful, and maintainable.

---

## 1. Unit tests

**Location:**

```

tests/unit/**/*.test.ts

```

**Purpose:**
Unit tests verify **isolated logic** without external dependencies (browser, CLI, file system, network).

**When to write:**

* new complex business logic
* algorithms, parsing, validations
* edge cases and boundary conditions
* bugs that can be reproduced without an environment

**Characteristics:**

* fast
* many assertions
* do not use `userSleep`
* do not record video

**Run commands:**

* `test:unit`

---

## 2. Regular E2E tests

**Location:**

```
tests/e2e/**/*.e2e.test.ts
```

**Purpose:**
Validation of **integrations** and interactions between real components (API, server, browser, CLI),
but **without user “theater”** (no delays and no video).

**When to write:**

* verifying the interaction of multiple components
* critical integrations (API → UI, CLI → FS)
* technical end-to-end checks

**Run commands:**

* `test:e2e`

---

## 3. Scenario tests (CLI + Web)

**Location:**

```

tests/scenario/cli/**/*.scenario.test.ts
tests/scenario/web/**/*.scenario.test.ts

````

Scenario tests are a **comprehensive check of a single user feature**
(one test = one “user flow”).

They **do not replace unit and e2e tests**, but complement them.

---

### 3.1 General idea of scenario tests

**One scenario test:**

* covers the **main (happy-path) scenario**
* verifies that the feature works “from start to finish”
* **does not cover all edge cases** (that’s what unit/e2e tests are for)

Scenario tests can run in **two modes**:

* `smokecheck`
* `userlike`

---

## 3.2 Scenario tests — Smokecheck mode

**Command:**

```bash
test:scenario:smoke
````

**Purpose:**
A fast and reliable **sanity check** of key user scenarios.

**Smokecheck rules:**

* tests run **strictly sequentially**
* **fail-fast**: execution stops on the first failure
* **minimal console output**
* all detailed output is saved to `.cache/smokecheck/*.log`
* `userSleep()` in this mode is **always 0ms**

**Console output:**

When all test succeeded
```
passed X/Y in Zs
```


When at least one test failed
```
passed X/Y in Zs
FAILED: <file> :: <test name>
log: .cache/smokecheck/<file>.log
```

**When to write/update smoke scenarios:**

* changes in critical user features
* regression checks before merge
* quick checks to see if “core functionality is alive”

---

## 3.3 Scenario tests — User-like mode (with video)

**Commands:**

```bash
test:scenario:userlike
test:scenario:userlike:web
test:scenario:userlike:web:mobile
```

**Purpose:**
A demonstrational run of scenarios so that a **human (or reviewer)** can visually verify
that everything works correctly.

**User-like mode specifics:**

* the test **explicitly** controls pauses:

  ```ts
  await userSleep(); // default 1500ms
  await userSleep(3000);
  ```
* CLI:

  * character-by-character input
  * delays between characters
  * delays between actions (enter press)
  * video recorded via asciinema
* Web:

  * video recorded by Playwright (`recordVideo`)
* `web:mobile`:

  * same scenarios
  * forced mobile viewport

**Artifacts:**

* Web:

  ```
  artifacts/user-style-e2e/web/<scenario>/*.webm
  ```
* CLI:

  ```
  artifacts/user-style-e2e/cli/<scenario>/*.mp4
  ```

**When to write/update user-like scenarios:**

* changes to user UX
* changes to CLI dialogs
* important user flows (onboarding, init, signup, etc.)
* when video simplifies code review

**Important:**
If a scenario test is **created or modified**, the PR **must include fresh user-like videos**.

---

## 4. userSleep and helper utilities

All helper functions are located in a single file:

```
tests/test-utils.ts
```

### userSleep

```ts
await userSleep();      // default ~1500ms in userlike
await userSleep(3000); // custom delay
```

* in `userlike` mode it actually waits
* in `smokecheck` mode it is always `0ms`

Delays are **always defined explicitly in the test** — this makes the scenario readable and controllable.

## 5. Notes

* `test` <- this comand run both unit and e2e tests, but not scenario tests

