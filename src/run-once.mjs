#!/usr/bin/env node

import process from "node:process";
import { exportUnrepliedComments, replyComments } from "./comment-workflow.mjs";
import { loadAppConfig } from "./lib/config.mjs";
import { generateReplyPlan } from "./lib/llm-reply-generator.mjs";

export async function runOnce(configPath) {
  const config = await loadAppConfig(configPath);
  const startedAt = Date.now();

  console.log(`[run-once] start ${new Date(startedAt).toISOString()}`);
  console.log(`[run-once] target work: ${config.task.workTitle}`);

  await exportUnrepliedComments({
    workTitle: config.task.workTitle,
    workPublishText: config.task.workPublishText,
    limit: config.task.exportLimit,
    noHistory: !config.task.includeHistory,
    outputPath: config.paths.exportFile,
    headless: config.task.headless,
  });

  const generationSummary = await generateReplyPlan({
    inputPath: config.paths.exportFile,
    outputPath: config.paths.planFile,
    llmConfig: config.llm,
  });

  console.log(
    `[run-once] generated=${generationSummary.generatedCount} skipped=${generationSummary.skippedCount} failed=${generationSummary.failedCount} actionable=${generationSummary.actionableCount}`,
  );

  if (config.task.autoReply && generationSummary.actionableCount > 0) {
    await replyComments({
      planFile: config.paths.planFile,
      limit: config.task.replyLimit,
      dryRun: config.task.dryRun,
      headless: config.task.headless,
    });
  } else {
    console.log("[run-once] auto reply skipped");
  }

  const finishedAt = Date.now();
  console.log(
    `[run-once] finished in ${Math.round((finishedAt - startedAt) / 1000)}s`,
  );

  return generationSummary;
}

async function main() {
  const configPath = process.argv[2];
  await runOnce(configPath);
}

if (import.meta.url === new URL(process.argv[1], "file://").href) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exitCode = 1;
  });
}
