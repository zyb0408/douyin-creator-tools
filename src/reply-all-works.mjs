#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const PLAN_FILE = path.resolve("comments-output/generated-reply-plan.json");
const REPLY_SCRIPT = path.resolve("src/reply-douyin-comments.mjs");
const OUTPUT_DIR = path.resolve("comments-output");

async function cleanOutputDirectory() {
  console.log("[INFO] 清理中间文件（删除所有 .json 文件）...");
  try {
    const files = await fs.readdir(OUTPUT_DIR);
    for (const file of files) {
      if (file.endsWith(".json")) {
        const filePath = path.resolve(OUTPUT_DIR, file);
        await fs.unlink(filePath);
        console.log(`[DEBUG] 已删除: ${file}`);
      }
    }
    console.log("[INFO] 所有 .json 文件清理完成。");
  } catch (error) {
    console.warn(`[WARNING] 清理 .json 文件时出错: ${error.message}`);
  }
}

async function main() {
  try {
    console.log(`[INFO] 读取完整回复计划: ${PLAN_FILE}`);
    const planContent = await fs.readFile(PLAN_FILE, "utf8");
    const plan = JSON.parse(planContent);

    if (!Array.isArray(plan.comments) || plan.comments.length === 0) {
      console.error("[ERROR] 回复计划中没有评论，无法执行回复。");
      process.exitCode = 1;
      return;
    }

    // 按作品标题分组评论
    const workCommentsMap = new Map();
    for (const comment of plan.comments) {
      // 使用作品标题作为分组键
      const workTitle = comment.workTitle || plan.selectedWork?.title;
      if (!workTitle) {
        console.warn("[WARNING] 评论缺少作品标题，跳过:", comment.username);
        continue;
      }
      if (!workCommentsMap.has(workTitle)) {
        workCommentsMap.set(workTitle, []);
      }
      workCommentsMap.get(workTitle).push(comment);
    }

    if (workCommentsMap.size === 0) {
      console.error("[ERROR] 未找到任何有效作品的评论。");
      process.exitCode = 1;
      return;
    }

    console.log(`[INFO] 发现 ${workCommentsMap.size} 个作品，开始逐个回复...`);

    let totalReplied = 0;
    let failedWorks = [];

    // 为每个作品创建独立计划文件并调用回复脚本
    for (const [workTitle, comments] of workCommentsMap.entries()) {
      console.log(`\n[INFO] 正在处理作品: ${workTitle}`);

      // 创建临时计划文件
      const safeTitle = workTitle.replace(/[\\/:*?"<>|]/g, "_");
      const tempPlanPath = path.resolve(`comments-output/temp-reply-plan-${safeTitle}.json`);
      const tempPlan = {
        selectedWork: { title: workTitle },
        count: comments.length,
        comments: comments,
      };

      try {
        await fs.writeFile(tempPlanPath, JSON.stringify(tempPlan, null, 2));
        console.log(`[DEBUG] 临时计划文件已创建: ${tempPlanPath}`);

        // 调用 reply-douyin-comments.mjs
        const child = spawn("node", [REPLY_SCRIPT, tempPlanPath], {
          stdio: "inherit",
        });

        await new Promise((resolve, reject) => {
          child.on("close", (code) => {
            if (code === 0) {
              totalReplied += comments.length;
              console.log(`[SUCCESS] ${workTitle} 回复完成，共 ${comments.length} 条`);
              resolve();
            } else {
              failedWorks.push(workTitle);
              console.error(`[FAILED] ${workTitle} 回复失败`);
              reject(new Error(`Child process exited with code ${code}`));
            }
          });
        });

        // 删除临时文件
        await fs.unlink(tempPlanPath);
        console.log(`[DEBUG] 临时文件已清理: ${tempPlanPath}`);

      } catch (error) {
        console.error(`[ERROR] 处理作品 ${workTitle} 时出错:`, error.message);
        failedWorks.push(workTitle);
      }
    }

    console.log(`\n[RESULT] 所有作品处理完成！\n- 成功回复 ${totalReplied} 条评论\n- 失败作品: ${failedWorks.length} 个 (${failedWorks.join(", ") || "无"})`);

    if (failedWorks.length > 0) {
      console.error("[WARNING] 部分作品回复失败，请手动检查");
      process.exitCode = 1;
    }

    // ✅ 简化：直接删除 comments-output/ 下所有 .json 文件
    await cleanOutputDirectory();

  } catch (error) {
    console.error("[FATAL] 自动回复流程失败:", error.message);
    process.exitCode = 1;
  }
}

main();
