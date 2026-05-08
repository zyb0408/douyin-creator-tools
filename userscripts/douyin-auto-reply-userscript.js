// ==UserScript==
// @name         抖音创作者自动回复助手
// @namespace    https://github.com/douyin-creator-tools
// @version      0.1.0
// @description  在抖音创作者中心评论管理页自动回复评论，支持 LLM 生成、模板、混合模式与定时扫描
// @author       hu-shang-ma-zai
// @match        https://creator.douyin.com/creator-micro/comment-manage*
// @match        https://creator.douyin.com/creator-micro/data-center/comment*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  const NS = "__douyinAR";
  const VERSION = "0.1.0";
  const TAG = "[抖音自动回复]";

  // 把所有模块挂到 window[NS] 便于控制台调试
  const ar = (window[NS] = window[NS] || {});
  ar.version = VERSION;

  // ============================================================
  // config — 配置默认值与持久化
  // ============================================================
  const DEFAULT_CONFIG = {
    enabled: false,
    mode: "hybrid", // "template" | "llm" | "hybrid"
    worksLimit: 8,
    templates: ["感谢关注！❤️", "谢谢你的支持！", "欢迎常来玩～"],
    llm: {
      baseURL: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4o-mini",
      temperature: 0.7,
      maxTokens: 300,
    },
    aiSignature: "【沪上码仔AI自动回复，注意甄别】",
    typingMinMs: 30,
    typingMaxMs: 80,
    replyDelayMinMs: 3000,
    replyDelayMaxMs: 8000,
    schedule: {
      enabled: false,
      intervalMin: 30,
      runImmediatelyOnStart: false,
    },
  };

  const CONFIG_KEY = "douyinAR.config";

  function deepMerge(target, source) {
    if (!source || typeof source !== "object") return target;
    const out = Array.isArray(target) ? [...target] : { ...target };
    for (const k of Object.keys(source)) {
      const sv = source[k];
      const tv = out[k];
      if (
        sv &&
        typeof sv === "object" &&
        !Array.isArray(sv) &&
        tv &&
        typeof tv === "object" &&
        !Array.isArray(tv)
      ) {
        out[k] = deepMerge(tv, sv);
      } else {
        out[k] = sv;
      }
    }
    return out;
  }

  function loadConfig() {
    try {
      const raw = GM_getValue(CONFIG_KEY, null);
      if (!raw) return structuredClone(DEFAULT_CONFIG);
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return deepMerge(DEFAULT_CONFIG, parsed);
    } catch (e) {
      console.warn(TAG, "loadConfig failed, using defaults:", e);
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  function saveConfig(cfg) {
    GM_setValue(CONFIG_KEY, JSON.stringify(cfg));
  }

  ar.config = { DEFAULT_CONFIG, loadConfig, saveConfig, deepMerge };

  // ============================================================
  // utils — 通用工具
  // ============================================================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randomBetween = (min, max) => min + Math.random() * (max - min);
  const randomInt = (min, max) => Math.floor(randomBetween(min, max + 1));
  const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const nowHHMMSS = () => {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
  };

  // 日志缓冲：最多 200 行，提供订阅器供 UI 实时刷新
  const LOG_MAX = 200;
  const logBuffer = [];
  const logSubscribers = new Set();
  function appendLog(line) {
    const stamped = `[${nowHHMMSS()}] ${line}`;
    logBuffer.push(stamped);
    if (logBuffer.length > LOG_MAX) logBuffer.shift();
    for (const fn of logSubscribers) {
      try {
        fn(stamped, logBuffer);
      } catch (e) {
        console.error(TAG, "log subscriber failed:", e);
      }
    }
    console.log(TAG, stamped);
  }
  function clearLog() {
    logBuffer.length = 0;
    for (const fn of logSubscribers) fn(null, logBuffer);
  }

  ar.utils = {
    sleep,
    randomBetween,
    randomInt,
    pickRandom,
    nowHHMMSS,
    appendLog,
    clearLog,
    logBuffer,
    logSubscribers,
  };

  // ============================================================
  // sanitize — 内容过滤（与 lib/llm-reply-generator.mjs 完全一致）
  // ============================================================
  const MAX_REPLY_MESSAGE_CHARS = 400;
  const BLOCKED_PATTERNS = [
    /微信/i,
    /vx/i,
    /v信/i,
    /加我/i,
    /私信我/i,
    /联系方式/i,
    /\d{8,}/,
  ];

  function normalizeText(v = "") {
    return String(v ?? "").replace(/\s+/g, " ").trim();
  }

  function truncateReplyMessage(text) {
    const src = String(text ?? "");
    const cps = [...src];
    if (cps.length <= MAX_REPLY_MESSAGE_CHARS)
      return { text: src, truncated: false };
    return {
      text: cps.slice(0, MAX_REPLY_MESSAGE_CHARS).join(""),
      truncated: true,
    };
  }

  function replaceStraightDoubleQuotes(text) {
    let open = true;
    return text.replace(/"/g, () => {
      const n = open ? "“" : "”";
      open = !open;
      return n;
    });
  }

  function sanitizeReplyMessage(rawText, aiSignature) {
    const sig = aiSignature || "";
    const stripped = String(rawText ?? "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/^here'?s a thinking process:?.*$/gim, "");
    const normalized = normalizeText(stripped)
      .replace(/\r?\n+/g, " ")
      .replace(/\s{2,}/g, " ");
    const quoted = replaceStraightDoubleQuotes(normalized);
    const { text, truncated } = truncateReplyMessage(quoted);

    if (!normalizeText(text))
      return { replyMessage: "", skipReason: "empty_reply", truncated };

    for (const pat of BLOCKED_PATTERNS) {
      if (pat.test(text))
        return { replyMessage: "", skipReason: "blocked_content", truncated };
    }

    const sigLen = sig.length;
    let finalText = text;
    if (finalText.length + sigLen <= MAX_REPLY_MESSAGE_CHARS) {
      finalText = finalText + sig;
    } else if (MAX_REPLY_MESSAGE_CHARS - sigLen > 0) {
      finalText = finalText.slice(0, MAX_REPLY_MESSAGE_CHARS - sigLen) + sig;
    } else {
      finalText = sig;
    }
    return {
      replyMessage: finalText,
      skipReason: "",
      truncated: truncated || finalText.length > text.length,
    };
  }

  ar.sanitize = {
    sanitizeReplyMessage,
    normalizeText,
    truncateReplyMessage,
    BLOCKED_PATTERNS,
  };

  console.log(`${TAG} loaded v${VERSION}`);
})();
