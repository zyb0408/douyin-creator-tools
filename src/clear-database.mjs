#!/usr/bin/env node

/**
 * 清空评论数据库
 *
 * 删除 data/douyin-creator.db 中 comments 表的所有数据并重置自增 ID。
 * 适用于需要重新开始采集评论的场景。
 *
 * 用法：
 *   npm run db:clear
 *   npm run db:clear -- --force   （跳过确认提示）
 */

import { clearAllComments } from "./lib/db-ops.mjs";
import { closeDb } from "./lib/db.mjs";
import readline from "node:readline";

function printHelp() {
  console.log(`
用法：
  npm run db:clear
  npm run db:clear -- --force

选项：
  --force    跳过确认提示，直接清空
  --help     显示此帮助信息

作用：
  清空本地数据库（data/douyin-creator.db）中 comments 表的所有数据，
  包括评论内容、回复记录、回复计数等，并重置自增 ID。

  ⚠️ 此操作不可逆！清空后所有历史评论数据将丢失。
  `);
}

function confirmPrompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const force = args.includes("--force");

  if (!force) {
    console.log("⚠️  即将清空数据库中所有评论数据，此操作不可逆！");
    const confirmed = await confirmPrompt("确认清空？请输入 y 继续：");
    if (!confirmed) {
      console.log("已取消。");
      return;
    }
  }

  const result = clearAllComments();
  console.log(`✅ 已清空数据库，共删除 ${result.deletedCount} 条评论记录。`);
  closeDb();
}

main();
