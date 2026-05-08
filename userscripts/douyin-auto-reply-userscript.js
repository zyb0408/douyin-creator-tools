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

  // ============================================================
  // dom — 选择器与等待工具
  // ============================================================
  async function waitFor(predicate, { timeout = 5000, interval = 100 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const result = predicate();
        if (result) return result;
      } catch (_) {
        /* 忽略，继续轮询 */
      }
      await sleep(interval);
    }
    throw new Error(`waitFor timeout after ${timeout}ms`);
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = window.getComputedStyle(el);
    return (
      cs.visibility !== "hidden" &&
      cs.display !== "none" &&
      cs.opacity !== "0"
    );
  }

  function queryAllByText(text, { tag = "*", root = document } = {}) {
    const all = root.querySelectorAll(tag);
    const out = [];
    for (const el of all) {
      if (
        el.textContent &&
        el.textContent.trim() === text &&
        isVisible(el)
      )
        out.push(el);
    }
    return out;
  }

  function queryByText(text, opts) {
    return queryAllByText(text, opts)[0] || null;
  }

  function queryClickableByText(text, root = document) {
    // 文本完全匹配 → 兜底：包含匹配（避免抖音多语言或加省略号）
    let el =
      queryByText(text, { tag: "button", root }) ||
      queryByText(text, { tag: "span", root });
    if (el) return el.closest("button, [role='button'], a") || el;

    const all = root.querySelectorAll(
      "button, [role='button'], div, span",
    );
    for (const e of all) {
      const t = (e.textContent || "").trim();
      if (t && t.length < 30 && t.includes(text) && isVisible(e)) {
        return e.closest("button, [role='button']") || e;
      }
    }
    return null;
  }

  function realClick(el) {
    if (!el) throw new Error("realClick: element is null");
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    for (const type of [
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
    ]) {
      el.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          view: window,
        }),
      );
    }
  }

  ar.dom = {
    waitFor,
    isVisible,
    queryByText,
    queryAllByText,
    queryClickableByText,
    realClick,
  };

  // ============================================================
  // selectors — 集中管理所有 DOM 选择器（页面改版时改这里）
  // ============================================================
  const SELECTORS = {
    worksOpenBtnText: "选择作品",
    worksPanelRoot:
      '[class*="work-list"], [class*="WorkList"], [class*="works-panel"]',
    worksItemFallbackImg: 'img[src*="aweme"]',
    unrepliedTabText: "未回复",
    commentListRoot: '[class*="comment-list"], [class*="CommentList"]',
    replyBtnText: "回复",
    sendBtnText: "发送",
    editorContentEditable: '[contenteditable="true"]',
  };

  // ============================================================
  // works — 打开作品面板，选第 i 个作品
  // ============================================================
  async function openWorksPanel() {
    const btn = await waitFor(
      () => queryClickableByText(SELECTORS.worksOpenBtnText),
      { timeout: 8000 },
    );
    realClick(btn);
    // 等侧边栏出现：用「兜底封面图」作为存在标志
    await waitFor(
      () =>
        document.querySelectorAll(SELECTORS.worksItemFallbackImg).length >= 1,
      { timeout: 6000 },
    );
    await sleep(400);
  }

  function listWorkItems() {
    // 优先 data-e2e 等语义属性；兜底：所有带封面图的可点击块
    const named = document.querySelectorAll(
      '[data-e2e*="work"], [data-e2e*="aweme-item"]',
    );
    if (named.length > 0) return Array.from(named).filter(isVisible);
    // 兜底：每个封面图所在的可点击容器
    const imgs = Array.from(
      document.querySelectorAll(SELECTORS.worksItemFallbackImg),
    ).filter(isVisible);
    const seen = new Set();
    const items = [];
    for (const img of imgs) {
      const card =
        img.closest('[role="button"]') || img.closest("li") || img.closest("div");
      if (card && !seen.has(card)) {
        seen.add(card);
        items.push(card);
      }
    }
    return items;
  }

  async function selectWorkByIndex(idx) {
    await openWorksPanel();
    const items = listWorkItems();
    if (idx >= items.length)
      throw new Error(`作品索引越界：要 #${idx} 但只有 ${items.length} 个`);
    realClick(items[idx]);
    await sleep(800); // 等评论区切换
  }

  ar.works = { openWorksPanel, listWorkItems, selectWorkByIndex, SELECTORS };

  // ============================================================
  // collect — 应用「未回复」筛选，提取下一条待回复
  // ============================================================
  async function applyUnrepliedFilter() {
    const tab = await waitFor(
      () => queryClickableByText(SELECTORS.unrepliedTabText),
      { timeout: 5000 },
    );
    realClick(tab);
    await sleep(600);
  }

  /**
   * 从评论列表里找第一条"还有「回复」按钮"的评论容器。
   * 返回 { container, replyBtn, username, commentText }，找不到返回 null。
   */
  function extractFirstUnreplied() {
    const candidates = [];
    const all = document.querySelectorAll(
      "button, [role='button'], span, div",
    );
    for (const el of all) {
      const t = (el.textContent || "").trim();
      if (t === SELECTORS.replyBtnText && isVisible(el)) {
        const clickable = el.closest("button, [role='button']") || el;
        candidates.push(clickable);
      }
    }
    if (candidates.length === 0) return null;

    const replyBtn = candidates[0];
    let container =
      replyBtn.closest(
        "[class*='comment-item'], [class*='CommentItem'], li",
      ) || replyBtn.parentElement;
    while (container && container.parentElement) {
      const c = container.parentElement;
      if (c.querySelectorAll("button, [role='button']").length > 5) break;
      if (c.tagName === "UL" || c.tagName === "OL") break;
      container = c;
      if (container.getBoundingClientRect().height > 60) break;
    }

    const allText = (container.textContent || "")
      .trim()
      .replace(/\s+/g, " ");
    const lines = allText
      .split("回复")[0]
      .split(/\s{2,}/)
      .filter(Boolean);
    const username = lines[0] || "unknown";
    const commentText =
      lines.slice(1).join(" ") || allText.slice(0, 100);

    return { container, replyBtn, username, commentText };
  }

  ar.collect = { applyUnrepliedFilter, extractFirstUnreplied };

  console.log(`${TAG} loaded v${VERSION}`);
})();
