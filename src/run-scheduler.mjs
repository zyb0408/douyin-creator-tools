#!/usr/bin/env node

import process from "node:process";
import cron from "node-cron";
import { loadAppConfig } from "./lib/config.mjs";
import { runOnce } from "./run-once.mjs";

async function main() {
  const configPath = process.argv[2];
  const config = await loadAppConfig(configPath);

  if (!config.schedule.enabled) {
    console.log("[scheduler] disabled in config, exiting");
    return;
  }

  if (!cron.validate(config.schedule.cron)) {
    throw new Error(`Invalid cron expression: ${config.schedule.cron}`);
  }

  let isRunning = false;

  async function trigger(reason) {
    if (isRunning) {
      console.log(
        `[scheduler] previous run still active, skip trigger=${reason}`,
      );
      return;
    }

    isRunning = true;
    console.log(`[scheduler] trigger=${reason}`);
    try {
      await runOnce(configPath);
    } finally {
      isRunning = false;
    }
  }

  if (config.schedule.runOnStartup) {
    await trigger("startup");
  }

  cron.schedule(config.schedule.cron, () => {
    void trigger("cron");
  });

  console.log(`[scheduler] started with cron=${config.schedule.cron}`);
}

if (import.meta.url === new URL(process.argv[1], "file://").href) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exitCode = 1;
  });
}
