#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  DEFAULT_COMMENT_PAGE_URL,
  DEFAULT_USER_DATA_DIR,
  gotoPage,
  launchPersistentPage,
  promptForEnter
} from "./douyin-browser.mjs";
import { toPositiveInteger } from "./lib/common.mjs";

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

function printHelp() {
  console.log(`
Usage:
  npm run view -- [options]
  npm run view -- <url>

Options:
  --url <url>        Page URL to open (default: creator comment page)
  --profile <path>   Playwright profile path
  --timeout <ms>     Max wait for initial page navigation (default: 60000)
  --zoom <percent>   Page zoom percentage after open (default: 80)
  --headless         Run Chromium in headless mode
  --help             Print this help
  `);
}

function resolvePageUrl(rawValue) {
  if (!rawValue) {
    return DEFAULT_COMMENT_PAGE_URL;
  }

  if (/^https?:\/\//i.test(rawValue)) {
    return rawValue;
  }

  return path.resolve(rawValue);
}

function parseArgs(argv) {
  const args = {
    pageUrl: DEFAULT_COMMENT_PAGE_URL,
    profileDir: DEFAULT_USER_DATA_DIR,
    timeoutMs: 60000,
    zoomPercent: 80,
    headless: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--url":
        args.pageUrl = resolvePageUrl(argv[index + 1] ?? DEFAULT_COMMENT_PAGE_URL);
        index += 1;
        break;
      case "--profile":
        args.profileDir = path.resolve(argv[index + 1] ?? DEFAULT_USER_DATA_DIR);
        index += 1;
        break;
      case "--timeout":
        args.timeoutMs = toPositiveInteger(argv[index + 1], "--timeout");
        index += 1;
        break;
      case "--zoom":
        args.zoomPercent = toPositiveInteger(argv[index + 1], "--zoom");
        index += 1;
        break;
      case "--headless":
        args.headless = true;
        break;
      default:
        if (!arg.startsWith("-")) {
          args.pageUrl = resolvePageUrl(arg);
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

  const { context, page } = await launchPersistentPage({
    userDataDir: args.profileDir,
    headless: args.headless,
    viewport: DEFAULT_VIEWPORT,
    alwaysNewPage: true
  });

  try {
    await gotoPage(page, args.pageUrl, args.timeoutMs);
    if (args.zoomPercent > 0 && args.zoomPercent !== 100) {
      await page.evaluate((zoomPercent) => {
        const zoom = Math.max(10, Math.min(zoomPercent, 300)) / 100;
        document.documentElement.style.zoom = String(zoom);
      }, args.zoomPercent);
    }
    console.log(`已打开新的标签页：${args.pageUrl}`);
    console.log(`正在复用登录信息目录：${args.profileDir}`);
    console.log(`浏览器视口：${DEFAULT_VIEWPORT.width}x${DEFAULT_VIEWPORT.height}`);
    console.log(`页面缩放：${args.zoomPercent}%`);
    await promptForEnter("手动处理完成后，回到终端按 Enter 关闭浏览器");
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
