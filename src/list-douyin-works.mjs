#!/usr/bin/env node

import process from "node:process";
import { createSharedCliArgs } from "./cli-options.mjs";
import { DEFAULT_WORKS_OUTPUT_PATH, listWorks } from "./comment-workflow.mjs";
import { toPositiveInteger } from "./lib/common.mjs";

function printHelp() {
  console.log(`
Usage:
  npm run works
  npm run works -- [options]

Options:
  --limit <n>       Only keep the first N works from the current list
  --out <path>       Output JSON path (default: comments-output/list-works.json)
  --profile <path>   Playwright profile path
  --timeout <ms>     Max total runtime
  --headless         Run Chromium in headless mode
  --debug            Print debug logs
  --help             Print this help
  `);
}

function parseArgs(argv) {
  const args = {
    ...createSharedCliArgs(),
    limit: 5,
    outputPath: DEFAULT_WORKS_OUTPUT_PATH
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--out":
        args.outputPath = argv[index + 1] ?? DEFAULT_WORKS_OUTPUT_PATH;
        index += 1;
        break;
      case "--profile":
        args.profileDir = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--timeout":
        args.timeoutMs = toPositiveInteger(argv[index + 1], "--timeout");
        index += 1;
        break;
      case "--headless":
        args.headless = true;
        break;
      case "--debug":
        args.debug = true;
        break;
      default:
        // Handle --limit=5 or --limit 5
        if (arg.startsWith("--limit=")) {
          args.limit = toPositiveInteger(arg.substring("--limit=".length), "--limit");
        } else if (arg === "--limit" && index + 1 < argv.length) {
          args.limit = toPositiveInteger(argv[index + 1], "--limit");
          index += 1;
        } else {
          throw new Error(`Unknown argument: ${arg}`);
        }
        break;
    }
  }
    console.log('[DEBUG] 最终 args:', args); // ← 调试用

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
    console.log('[DEBUG] 解析后的参数:', args); // ← 添加这一行！

  if (args.help) {
    printHelp();
    return;
  }

  await listWorks(args);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
