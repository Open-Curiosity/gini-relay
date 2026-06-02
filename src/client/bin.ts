#!/usr/bin/env bun
/**
 * The `frp` CLI binary. Thin: dispatch to runCli with real defaults and surface
 * its exit code. All logic lives in the sibling client modules.
 */
import { runCli } from "./cli.ts";

process.exit(await runCli(process.argv.slice(2)));
