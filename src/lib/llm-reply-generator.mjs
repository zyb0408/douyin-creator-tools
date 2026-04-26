#!/usr/bin/env node
import fs from "node:fs/promises";
import { emitResult } from "./result-store.mjs";
import { normalizeText, MAX_REPLY_MESSAGE_CHARS, truncateReplyMessage } from "./common.mjs";
import path from "node:path";

const DEBUG = process.env.DEBUG === "1";

function debugLog(...args) {
  if (DEBUG) console.log("[DEBUG]", ...args);
}

const MAX_HISTORY_ITEMS = 3;
const BLOCKED_PATTERNS = [
  /微信/i,
  /vx/i,
  /v信/i,
  /加我/i,
  /私信我/i,
  /联系方式/i,
  /\d{8,}/,
];

// ✅ AI 自动回复签名默认值（可通过 config.json 的 llm.aiSignature 覆盖）
const DEFAULT_AI_SIGNATURE = "【沪上码仔AI自动回复，注意甄别】";

function replaceStraightDoubleQuotes(text) {
  let open = true;
  return text.replace(/"/g, () => {
    const next = open ? "“" : "”";
    open = !open;
    return next;
  });
}

function sanitizeReplyMessage(rawText, aiSignature = DEFAULT_AI_SIGNATURE) {
  const normalized = normalizeText(
    String(rawText ?? "")
      .replace(/<[\\s\\S]*?<\/think>/gi, "")
      .replace(/^here'?s a thinking process:?.*$/gim, ""),
  )
    .replace(/\r?\n+/g, " ")
    .replace(/\s{2,}/g, " ");
  const quoted = replaceStraightDoubleQuotes(normalized);
  const { text, truncated } = truncateReplyMessage(quoted);

  if (!normalizeText(text)) {
    return {
      replyMessage: "",
      skipReason: "empty_reply",
      truncated,
    };
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(text)) {
      return {
        replyMessage: "",
        skipReason: "blocked_content",
        truncated,
      };
    }
  }

  // ✅ 在最终回复后追加签名，确保不超过最大长度
  const signatureLength = aiSignature.length;
  let finalText = text;
  if (finalText.length + signatureLength <= MAX_REPLY_MESSAGE_CHARS) {
    finalText = finalText + aiSignature;
  } else {
    // 如果空间不足，截断原文以容纳签名
    const availableSpace = MAX_REPLY_MESSAGE_CHARS - signatureLength;
    if (availableSpace > 0) {
      finalText = finalText.slice(0, availableSpace) + aiSignature;
    } else {
      finalText = aiSignature; // 极端情况：只保留签名
    }
  }

  return {
    replyMessage: finalText,
    skipReason: "",
    truncated: truncated || finalText.length > text.length,
  };
}

function summarizeHistory(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return "无历史评论记录";
  }

  return history
    .slice(0, MAX_HISTORY_ITEMS)
    .map(
      (item, index) =>
        `${index + 1}. ${normalizeText(item?.text ?? "") || "无内容"}`,
    )
    .join("\n");
}

function buildPrompt({ selectedWork, comment }) {
  const hasImages =
    Array.isArray(comment.imagePaths) && comment.imagePaths.length > 0;
  return `
你是抖音创作者评论助手。请只输出一条可以直接发送的中文回复，不要解释，不要加引号，不要分点。

要求：
1. 回复自然、真诚、简短，尽量像真人。
2. 不要引流，不要留联系方式，不要让用户私信。
3. 不要夸大承诺，不要出现营销腔。
4. 如果评论带图但你看不到图片内容，不要编造图片细节。
5. 最终回复控制在 80 字内，绝对不要超过 400 字。

作品标题：${normalizeText(selectedWork?.title ?? "") || "未知作品"}
用户昵称：${normalizeText(comment.username ?? "")}
评论内容：${normalizeText(comment.commentText ?? "")}
评论是否带图：${hasImages ? "是" : "否"}
该用户历史评论：
${summarizeHistory(comment.history)}
`.trim();
}

async function loadReplySource(inputPath) {
  const rawText = await fs.readFile(inputPath, "utf8");
  const parsed = JSON.parse(rawText);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("reply source must be a JSON object");
  }

  if (!Array.isArray(parsed.comments)) {
    throw new Error("reply source must contain comments array");
  }

  return parsed;
}

async function generateSingleReply({ llmConfig, selectedWork, comment }) {
  debugLog("调用 LLM 生成回复，模型:", llmConfig.model);
  debugLog("评论内容:", comment.commentText.slice(0, 100), comment.commentText.length > 100 ? "..." : "");

  const response = await globalThis.fetch(
    `${llmConfig.baseURL.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llmConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: llmConfig.model,
        messages: [
          {
            role: "user",
            content: buildPrompt({ selectedWork, comment }),
          },
        ],
        temperature: llmConfig.temperature,
        max_tokens: llmConfig.maxTokens,
        chat_template_kwargs: {
          enable_thinking: false,
        },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  const text = payload?.choices?.[0]?.message?.content;

  if (typeof text !== "string") {
    throw new Error("LLM response does not contain choices[0].message.content");
  }

  debugLog("LLM 响应内容:", text.slice(0, 100), text.length > 100 ? "..." : "");
  return text;
}

export async function generateReplyPlan({ outputPath } = {}) {
  const commentOutputDir = path.resolve("comments-output");
  const configPath = path.resolve("config.json");

  // === 日志：读取配置文件 ===
  debugLog("尝试读取配置文件:", configPath);
  let config = null;
  try {
    const configContent = await fs.readFile(configPath, "utf8");
    debugLog("配置文件内容:", configContent.length, "字符");
    config = JSON.parse(configContent);
    debugLog("配置文件解析成功");
  } catch (error) {
    console.error(`[ERROR] 读取或解析 config.json 失败: ${error.message}`);
    throw new Error("config.json 文件不存在或格式错误，请确保它位于项目根目录");
  }

  // === 验证并初始化配置 ===
  if (!config.llm) {
    throw new Error("config.json 中缺少 llm 配置");
  }

  const llmConfig = config.llm;
  debugLog("LLM 配置: baseURL=" + llmConfig.baseURL + ", model=" + llmConfig.model + ", apiKey=" + llmConfig.apiKey.substring(0, 5) + "...");

  // 从配置中读取 AI 签名，如果未配置则使用默认值
  const aiSignature = (llmConfig.aiSignature && typeof llmConfig.aiSignature === "string" && llmConfig.aiSignature.trim())
    ? llmConfig.aiSignature.trim()
    : DEFAULT_AI_SIGNATURE;
  debugLog("AI 签名:", aiSignature);

  // 安全获取 paths，如果不存在则使用默认值
  const defaultPaths = {
    planFile: "comments-output/generated-reply-plan.json",
    exportFile: "comments-output/unreplied-comments.json"
  };
  const paths = config.paths || defaultPaths;
  debugLog("使用输出路径:", paths.planFile);

  // === 日志：扫描评论文件 ===
  debugLog("扫描评论文件目录:", commentOutputDir);
  const allFiles = await fs.readdir(commentOutputDir);
  debugLog("目录内容:", allFiles.join(", "));

  const commentFiles = [];
  for (const file of allFiles) {
    if (file.startsWith("unreplied-comments-") && file.endsWith(".json")) {
      const filePath = path.resolve(commentOutputDir, file);
      commentFiles.push(filePath);
      debugLog("发现评论文件:", file);
    }
  }

  if (commentFiles.length === 0) {
    console.error(`[ERROR] 未找到任何 unreplied-comments-*.json 文件，请先运行 'npm run comments:export'`);
    throw new Error("没有找到任何未回复评论文件。请先运行 'npm run comments:export' 导出评论。");
  }

  console.log(`[INFO] 找到 ${commentFiles.length} 个未回复评论文件，开始处理...`);

  let generatedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const allComments = [];
  let selectedWork = null;

  // === 日志：遍历每个文件 ===
  for (const filePath of commentFiles) {
    console.log(`[INFO] 正在处理: ${path.basename(filePath)}`);
    try {
      const source = await loadReplySource(filePath);
      if (!selectedWork) {
        selectedWork = source.selectedWork;
        debugLog("使用作品上下文:", selectedWork.title);
      }
      debugLog("文件包含", source.comments.length, "条评论");

      for (const comment of source.comments) {
        if (normalizeText(comment.replyMessage)) {
          allComments.push({ ...comment });
          generatedCount += 1;
          debugLog("跳过已生成回复的评论:", comment.username);
          continue;
        }
        const newComment = { ...comment };
        allComments.push(newComment);
      }
    } catch (error) {
      console.warn(`[WARNING] 处理文件 ${filePath} 时出错: ${error.message}`);
      failedCount += 1;
    }
  }

  console.log(`[INFO] 共收集 ${allComments.length} 条待处理评论`);

  // === 日志：逐条生成回复 ===
  for (const comment of allComments) {
    if (normalizeText(comment.replyMessage)) continue;

    debugLog("正在为", comment.username, "生成回复:", comment.commentText.slice(0, 50) + "...");

    try {
      const text = await generateSingleReply({ llmConfig, selectedWork, comment });
      const sanitized = sanitizeReplyMessage(text, aiSignature);
      comment.replyMessage = sanitized.replyMessage;

      if (sanitized.replyMessage) {
        generatedCount += 1;
        debugLog("成功生成回复:", sanitized.replyMessage.slice(0, 50) + "...");
      } else {
        skippedCount += 1;
        debugLog("回复被过滤:", sanitized.skipReason);
      }
    } catch (error) {
      comment.replyMessage = "";
      comment.llmError = error instanceof Error ? error.message : String(error);
      failedCount += 1;
      console.error(`[ERROR] 生成回复失败: ${error.message}`);
    }
  }

  // === 日志：输出结果 ===
  const plan = { selectedWork, count: allComments.length, comments: allComments };
  const finalOutputPath = outputPath || paths.planFile;
  debugLog("将结果写入:", finalOutputPath);
  await emitResult(plan, finalOutputPath);

  console.log(`\n[RESULT] 生成回复计划完成！\n- 总评论数: ${allComments.length}\n- 已生成回复: ${generatedCount}\n- 跳过（无回复）: ${skippedCount}\n- 生成失败: ${failedCount}\n- 输出文件: ${finalOutputPath}`);

  // === 新增：输出最终文件内容摘要 ===
  const actionableCount = allComments.filter(c => normalizeText(c.replyMessage ?? "")).length;
  console.log(`[RESULT] 可操作回复数: ${actionableCount}`);

  // 仅当文件为空时输出完整内容用于调试
  if (allComments.length === 0) {
    console.error("[CRITICAL] 最终输出文件为空，请检查 comments-output/ 目录下是否有有效的 unreplied-comments-*.json 文件");
  }

  return {
    outputPath: finalOutputPath,
    totalCount: allComments.length,
    generatedCount,
    skippedCount,
    failedCount,
    actionableCount
  };
}

// 仅在直接运行时执行（而非被 import 时）
if (process.argv[1] && process.argv[1].endsWith("llm-reply-generator.mjs")) {
  try {
    console.log('[INFO] 开始执行 generateReplyPlan...');
    await generateReplyPlan();
    console.log('[INFO] 脚本执行完成');
  } catch (error) {
    console.error('[FATAL] 脚本执行失败:', error.message);
    process.exitCode = 1;
  }
}
