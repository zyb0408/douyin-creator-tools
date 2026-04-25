#!/usr/bin/env node

import process from "node:process";
import { createSharedCliArgs, consumeSharedCliArg } from "./cli-options.mjs";
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
    limit: 0,
    outputPath: DEFAULT_WORKS_OUTPUT_PATH
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextIndex = consumeSharedCliArg(args, argv, index);
    if (nextIndex !== null) {
      index = nextIndex;
      continue;
    }

    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--out":
        args.outputPath = argv[index + 1] ?? DEFAULT_WORKS_OUTPUT_PATH;
        index += 1;
        break;
      case "--limit":
        args.limit = toPositiveInteger(argv[index + 1], "--limit");
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

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
