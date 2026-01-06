#!/usr/bin/env node
/**
 * agentinterop
 *
 * Thin CLI entrypoint that delegates to the generated dispatcher.
 */

import { runCli } from "../dist/cli/runCli.js";

await runCli(process.argv);
