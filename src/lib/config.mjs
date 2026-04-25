import fs from "node:fs/promises";
import path from "node:path";
import { normalizeText } from "./common.mjs";

export const DEFAULT_CONFIG_PATH = path.resolve("config.json");

function withDefaultPath(value, fallback) {
  const normalized = normalizeText(String(value ?? ""));
  return path.resolve(normalized || fallback);
}

function expectObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
}

function expectBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function expectNumber(value, label, { min = Number.NEGATIVE_INFINITY } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new Error(`${label} must be a number >= ${min}`);
  }
  return value;
}

function expectString(value, label) {
  if (typeof value !== "string" || !normalizeText(value)) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export async function loadAppConfig(configPath = DEFAULT_CONFIG_PATH) {
  const absolutePath = path.resolve(configPath);
  let rawText = "";

  try {
    rawText = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(
        `Config file not found: ${absolutePath}. Create it from config.json.example first.`,
      );
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `Failed to parse config JSON: ${absolutePath}\n${error instanceof Error ? error.message : String(error)}`,
    );
  }

  expectObject(parsed, "config");
  expectObject(parsed.llm, "config.llm");
  expectObject(parsed.schedule, "config.schedule");
  expectObject(parsed.task, "config.task");
  expectObject(parsed.paths, "config.paths");

  const config = {
    configPath: absolutePath,
    llm: {
      baseURL: expectString(parsed.llm.baseURL, "config.llm.baseURL"),
      apiKey: expectString(parsed.llm.apiKey, "config.llm.apiKey"),
      model: expectString(parsed.llm.model, "config.llm.model"),
      temperature:
        parsed.llm.temperature === undefined
          ? 0.7
          : expectNumber(parsed.llm.temperature, "config.llm.temperature", {
              min: 0,
            }),
      maxTokens:
        parsed.llm.maxTokens === undefined
          ? 300
          : expectNumber(parsed.llm.maxTokens, "config.llm.maxTokens", {
              min: 1,
            }),
    },
    schedule: {
      enabled:
        parsed.schedule.enabled === undefined
          ? true
          : expectBoolean(parsed.schedule.enabled, "config.schedule.enabled"),
      cron: expectString(parsed.schedule.cron, "config.schedule.cron"),
      runOnStartup:
        parsed.schedule.runOnStartup === undefined
          ? false
          : expectBoolean(
              parsed.schedule.runOnStartup,
              "config.schedule.runOnStartup",
            ),
    },
    task: {
      workTitle: expectString(parsed.task.workTitle, "config.task.workTitle"),
      workPublishText: normalizeText(String(parsed.task.workPublishText ?? "")),
      exportLimit:
        parsed.task.exportLimit === undefined
          ? 50
          : expectNumber(parsed.task.exportLimit, "config.task.exportLimit", {
              min: 1,
            }),
      replyLimit:
        parsed.task.replyLimit === undefined
          ? 20
          : expectNumber(parsed.task.replyLimit, "config.task.replyLimit", {
              min: 1,
            }),
      autoReply:
        parsed.task.autoReply === undefined
          ? true
          : expectBoolean(parsed.task.autoReply, "config.task.autoReply"),
      dryRun:
        parsed.task.dryRun === undefined
          ? false
          : expectBoolean(parsed.task.dryRun, "config.task.dryRun"),
      headless:
        parsed.task.headless === undefined
          ? true
          : expectBoolean(parsed.task.headless, "config.task.headless"),
      includeHistory:
        parsed.task.includeHistory === undefined
          ? true
          : expectBoolean(
              parsed.task.includeHistory,
              "config.task.includeHistory",
            ),
    },
    paths: {
      exportFile: withDefaultPath(
        parsed.paths.exportFile,
        "comments-output/unreplied-comments.json",
      ),
      planFile: withDefaultPath(
        parsed.paths.planFile,
        "comments-output/generated-reply-plan.json",
      ),
    },
  };

  return config;
}
