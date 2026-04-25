import fs from "node:fs/promises";
import { emitResult } from "./result-store.mjs";
import { normalizeText } from "./common.mjs";

const MAX_REPLY_MESSAGE_CHARS = 400;
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

function truncateReplyMessage(text) {
  const source = String(text ?? "");
  const codePoints = [...source];
  if (codePoints.length <= MAX_REPLY_MESSAGE_CHARS) {
    return {
      text: source,
      truncated: false,
    };
  }

  return {
    text: codePoints.slice(0, MAX_REPLY_MESSAGE_CHARS).join(""),
    truncated: true,
  };
}

function replaceStraightDoubleQuotes(text) {
  let open = true;
  return text.replace(/"/g, () => {
    const next = open ? "“" : "”";
    open = !open;
    return next;
  });
}

function sanitizeReplyMessage(rawText) {
  const normalized = normalizeText(
    String(rawText ?? "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
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

  return {
    replyMessage: text,
    skipReason: "",
    truncated,
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

  return text;
}

export async function generateReplyPlan({ inputPath, outputPath, llmConfig }) {
  const source = await loadReplySource(inputPath);

  let generatedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  const comments = [];

  for (const comment of source.comments) {
    const nextComment = { ...comment };
    const existingReply = normalizeText(String(comment?.replyMessage ?? ""));

    if (existingReply) {
      nextComment.replyMessage = existingReply;
      comments.push(nextComment);
      generatedCount += 1;
      continue;
    }

    try {
      const text = await generateSingleReply({
        llmConfig,
        selectedWork: source.selectedWork,
        comment,
      });

      const sanitized = sanitizeReplyMessage(text);
      nextComment.replyMessage = sanitized.replyMessage;

      if (sanitized.replyMessage) {
        generatedCount += 1;
      } else {
        skippedCount += 1;
      }
    } catch (error) {
      nextComment.replyMessage = "";
      nextComment.llmError =
        error instanceof Error ? error.message : String(error);
      failedCount += 1;
    }

    comments.push(nextComment);
  }

  const plan = {
    ...source,
    comments,
  };

  await emitResult(plan, outputPath);

  return {
    outputPath,
    totalCount: comments.length,
    generatedCount,
    skippedCount,
    failedCount,
    actionableCount: comments.filter((comment) =>
      normalizeText(comment.replyMessage ?? ""),
    ).length,
  };
}
