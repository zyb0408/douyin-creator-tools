#!/usr/bin/env node

import process from "node:process";
import { createSharedCliArgs, consumeSharedCliArg } from "./cli-options.mjs";
import { DEFAULT_EXPORT_OUTPUT_PATH, exportUnrepliedComments } from "./comment-workflow.mjs";
import { normalizeText, toPositiveInteger } from "./lib/common.mjs";
import fs from "node:fs/promises";
import path from "node:path";

function printHelp() {
  console.log(`
Usage:
  npm run comments:export -- "作品短标题"
  npm run comments:export -- [options] "作品短标题"

Options:
  --limit <n>        Max exported comments (default: 200)
  --out <path>       Output JSON path (default: comments-output/unreplied-comments.json)
  --no-history       Skip exporting user history
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
    workTitle: "",
    limit: 200,
    noHistory: false,
    outputPath: DEFAULT_EXPORT_OUTPUT_PATH
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
      case "--limit":
        args.limit = toPositiveInteger(argv[index + 1], "--limit");
        index += 1;
        break;
      case "--out":
        args.outputPath = argv[index + 1] ?? DEFAULT_EXPORT_OUTPUT_PATH;
        index += 1;
        break;
      case "--no-history":
        args.noHistory = true;
        break;
      case "--latest":
        args.useLatest = true;
        break;
      default:
        if (!arg.startsWith("-") && !args.workTitle) {
          args.workTitle = normalizeText(arg);
          break;
        }
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

  // 如果没有提供作品标题，尝试从 list-works.json 获取所有作品
  if (!args.workTitle) {
    const worksPath = path.resolve("comments-output/list-works.json");
    try {
      const worksData = JSON.parse(await fs.readFile(worksPath, "utf8"));
      if (!worksData.works || worksData.works.length === 0) {
        throw new Error("list-works.json 中没有找到作品");
      }

      console.log(`找到 ${worksData.works.length} 个作品，开始逐个处理未回复评论...`);

      let processedCount = 0;
      let exportedCount = 0;
      const exportDir = path.resolve("comments-output");

      // 遍历所有作品
      for (const work of worksData.works) {
        args.workTitle = work.title;
        console.log(`\n正在处理作品: ${args.workTitle}`);

        try {
          // 为每个作品创建独立的输出文件，文件名基于作品标题
          const safeTitle = args.workTitle.replace(/[\\/:*?"<>|]/g, "_");
          args.outputPath = path.resolve(exportDir, `unreplied-comments-${safeTitle}.json`);

          await exportUnrepliedComments(args);
          exportedCount += 1;
        } catch (error) {
          console.warn(`处理作品 "${args.workTitle}" 时出错: ${error.message}`);
        }

        processedCount += 1;
      }

      console.log(`\n处理完成！共处理 ${processedCount} 个作品，成功导出 ${exportedCount} 个作品的未回复评论`);
      return;
    } catch (error) {
      console.warn(`无法从 list-works.json 获取作品标题: ${error.message}`);
      throw new Error('Missing work title. Usage: npm run comments:export -- "作品短标题"');
    }
  }

  // 如果提供了作品标题，只处理指定作品
  await exportUnrepliedComments(args);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
