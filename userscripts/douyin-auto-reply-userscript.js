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

  // ============================================================
  // send — 单条回复发送时序
  // ============================================================
  async function findEditor() {
    return waitFor(
      () => {
        const eds = document.querySelectorAll(SELECTORS.editorContentEditable);
        for (const e of eds) {
          if (isVisible(e) && (e.textContent || "").length === 0) return e;
        }
        return null;
      },
      { timeout: 5000 },
    );
  }

  async function findSendButton(near) {
    return waitFor(
      () => {
        const root =
          near?.closest("[class*='editor'], [class*='Editor'], form") ||
          document;
        const btn = queryClickableByText(SELECTORS.sendBtnText, root);
        if (!btn) return null;
        if (
          btn.disabled ||
          btn.getAttribute("aria-disabled") === "true" ||
          btn.classList.contains("disabled")
        )
          return null;
        return btn;
      },
      { timeout: 4000 },
    );
  }

  async function typeReply(editor, text, { typingMinMs, typingMaxMs }) {
    editor.focus();
    // 优先一次性插入（最快路径）
    try {
      if (document.execCommand) {
        document.execCommand("insertText", false, text);
        await sleep(80);
        if (
          (editor.textContent || "").includes(
            text.slice(0, Math.min(8, text.length)),
          )
        )
          return;
      }
    } catch (_) {
      /* 降级 */
    }

    // 降级：逐字 dispatch input event（对 React 受控组件有效）
    for (const ch of text) {
      const before = editor.textContent || "";
      editor.dispatchEvent(
        new InputEvent("beforeinput", {
          data: ch,
          inputType: "insertText",
          bubbles: true,
          cancelable: true,
        }),
      );
      editor.textContent = before + ch;
      editor.dispatchEvent(
        new InputEvent("input", {
          data: ch,
          inputType: "insertText",
          bubbles: true,
        }),
      );
      await sleep(randomBetween(typingMinMs, typingMaxMs));
    }
  }

  /**
   * 完整的单条回复时序：滚动 → 点回复 → 等输入框 → 输入 → 等发送 enabled → 点发送 → 等消失
   * 成功返回 true，失败抛错。
   */
  async function sendReply(commentInfo, replyText, cfg) {
    const { container, replyBtn } = commentInfo;
    container.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(200);

    realClick(replyBtn);

    const editor = await findEditor();
    await typeReply(editor, replyText, cfg);

    const sendBtn = await findSendButton(editor);
    realClick(sendBtn);

    // 等评论从未回复列表消失（或回复按钮消失）
    await waitFor(
      () => !document.body.contains(replyBtn) || !isVisible(replyBtn),
      { timeout: 8000 },
    );
    return true;
  }

  ar.send = { findEditor, findSendButton, typeReply, sendReply };

  // ============================================================
  // llm — OpenAI 兼容接口客户端
  // ============================================================
  const SYSTEM_PROMPT_HEADER =
    "你是抖音创作者评论助手。请只输出一条可以直接发送的中文回复，不要解释，不要加引号，不要分点。";

  function buildPrompt({ workTitle, comment }) {
    return [
      SYSTEM_PROMPT_HEADER,
      "",
      "要求：",
      "1. 回复自然、真诚、简短，尽量像真人。",
      "2. 不要引流，不要留联系方式，不要让用户私信。",
      "3. 不要夸大承诺，不要出现营销腔。",
      "4. 如果评论带图但你看不到图片内容，不要编造图片细节。",
      "5. 最终回复控制在 80 字内，绝对不要超过 400 字。",
      "",
      `作品标题：${normalizeText(workTitle) || "未知作品"}`,
      `用户昵称：${normalizeText(comment.username || "")}`,
      `评论内容：${normalizeText(comment.commentText || "")}`,
      `评论是否带图：否`,
    ].join("\n");
  }

  async function callLLM(
    { llmConfig, workTitle, comment },
    { timeoutMs = 15000 } = {},
  ) {
    const url =
      llmConfig.baseURL.replace(/\/$/, "") + "/chat/completions";
    const body = {
      model: llmConfig.model,
      temperature: llmConfig.temperature,
      max_tokens: llmConfig.maxTokens,
      messages: [
        { role: "user", content: buildPrompt({ workTitle, comment }) },
      ],
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${llmConfig.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text();
        const err = new Error(
          `LLM ${res.status}: ${errText.slice(0, 200)}`,
        );
        err.status = res.status;
        throw err;
      }
      const payload = await res.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string")
        throw new Error(
          "LLM response missing choices[0].message.content",
        );
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  ar.llm = { buildPrompt, callLLM };

  // ============================================================
  // generator — 三种模式：template / llm / hybrid
  // ============================================================
  async function generateReply({ cfg, workTitle, comment }) {
    const mode = cfg.mode;

    if (mode === "template") {
      if (!cfg.templates || cfg.templates.length === 0)
        return { text: null, reason: "no_templates" };
      return { text: pickRandom(cfg.templates), via: "template" };
    }

    if (mode === "llm") {
      try {
        const raw = await callLLM({ llmConfig: cfg.llm, workTitle, comment });
        return { text: raw, via: "llm" };
      } catch (e) {
        return {
          text: null,
          reason: `llm_failed:${e.message}`,
          status: e.status,
        };
      }
    }

    if (mode === "hybrid") {
      try {
        const raw = await callLLM({ llmConfig: cfg.llm, workTitle, comment });
        return { text: raw, via: "llm" };
      } catch (e) {
        // 401/429 时不回退（避免烧 quota），让上层中止整轮
        if (e.status === 401 || e.status === 429)
          return {
            text: null,
            reason: `llm_${e.status}`,
            status: e.status,
            fatal: true,
          };
        if (cfg.templates && cfg.templates.length > 0)
          return {
            text: pickRandom(cfg.templates),
            via: "template_fallback",
          };
        return {
          text: null,
          reason: `llm_failed_no_template:${e.message}`,
        };
      }
    }

    return { text: null, reason: `unknown_mode:${mode}` };
  }

  ar.generator = { generateReply };

  // ============================================================
  // engine — 主循环 + 暂停状态机
  // ============================================================
  const STATE = {
    state: "idle",
    currentWorkIdx: -1,
    currentCommentIdx: 0,
    abortRequested: false,
    runId: 0,
    lastError: null,
  };

  function getState() {
    return { ...STATE };
  }

  function requestPause() {
    if (STATE.state === "running") {
      STATE.abortRequested = true;
      appendLog("收到暂停请求，将在当前评论后停止");
    }
  }

  async function runOnce({ trigger = "manual" } = {}) {
    if (STATE.state === "running") {
      appendLog(
        `[${trigger === "schedule" ? "定时" : "手动"}] 上一轮未结束，跳过本次`,
      );
      return { skipped: true };
    }
    STATE.runId += 1;
    STATE.state = "running";
    STATE.abortRequested = false;
    STATE.lastError = null;
    appendLog(
      `${trigger === "schedule" ? "[定时] " : ""}第 ${STATE.runId} 轮启动`,
    );

    const cfg = loadConfig();
    if (!cfg.enabled) {
      STATE.state = "idle";
      appendLog("启用开关未打开，停止");
      return { aborted: true };
    }
    if (
      (cfg.mode === "template" || cfg.mode === "hybrid") &&
      (!cfg.templates || cfg.templates.length === 0)
    ) {
      STATE.state = "idle";
      appendLog("模板列表为空但模式需要模板，停止");
      return { aborted: true };
    }

    let totalReplied = 0;
    let consecutiveFailures = 0;

    try {
      for (let i = 0; i < cfg.worksLimit; i++) {
        if (STATE.abortRequested) {
          appendLog("已暂停");
          break;
        }
        STATE.currentWorkIdx = i;
        try {
          await selectWorkByIndex(i);
        } catch (e) {
          appendLog(`作品 #${i + 1} 选择失败：${e.message}`);
          continue;
        }
        const items = listWorkItems();
        const workTitle =
          (items[i]?.textContent || "")
            .trim()
            .slice(0, 60)
            .replace(/\s+/g, " ") || `作品#${i + 1}`;
        appendLog(`作品 ${i + 1}/${cfg.worksLimit}: ${workTitle}`);

        try {
          await applyUnrepliedFilter();
        } catch (e) {
          appendLog(`  未回复筛选失败：${e.message}`);
          continue;
        }

        let commentSeq = 0;
        while (!STATE.abortRequested) {
          if (commentSeq >= 200) {
            appendLog(`  达到本作品评论上限 200`);
            break;
          }
          const c = extractFirstUnreplied();
          if (!c) {
            appendLog(`  本作品已无可回复评论`);
            break;
          }
          commentSeq += 1;

          const gen = await generateReply({
            cfg,
            workTitle,
            comment: c,
          });
          if (gen.fatal) {
            appendLog(
              `  评论 #${commentSeq} LLM ${gen.status} 致命错误，停止整轮`,
            );
            consecutiveFailures = 99;
            break;
          }
          if (!gen.text) {
            appendLog(
              `  评论 #${commentSeq} user=${c.username} → 跳过(${gen.reason})`,
            );
            consecutiveFailures += 1;
            if (consecutiveFailures >= 3) {
              appendLog(`  连续 3 次失败，暂停整轮`);
              break;
            }
            continue;
          }

          const sanitized = sanitizeReplyMessage(gen.text, cfg.aiSignature);
          if (!sanitized.replyMessage) {
            appendLog(
              `  评论 #${commentSeq} user=${c.username} → 命中过滤(${sanitized.skipReason})，跳过`,
            );
            continue;
          }

          try {
            appendLog(
              `  评论 #${commentSeq} user=${c.username} → 发送中... (${gen.via})`,
            );
            await sendReply(c, sanitized.replyMessage, cfg);
            totalReplied += 1;
            consecutiveFailures = 0;
            appendLog(`  评论 #${commentSeq} 已回复 ✓`);
            await sleep(
              randomBetween(cfg.replyDelayMinMs, cfg.replyDelayMaxMs),
            );
          } catch (e) {
            appendLog(`  评论 #${commentSeq} 发送失败：${e.message}`);
            consecutiveFailures += 1;
            if (consecutiveFailures >= 3) {
              appendLog(`  连续 3 次失败，暂停整轮`);
              break;
            }
          }
        }
        if (consecutiveFailures >= 99) break;
      }
    } catch (e) {
      STATE.lastError = e.message;
      appendLog(`引擎异常：${e.message}`);
    } finally {
      STATE.state = "idle";
      STATE.currentWorkIdx = -1;
      appendLog(`第 ${STATE.runId} 轮结束，共回复 ${totalReplied} 条`);
    }
    return { totalReplied };
  }

  ar.engine = { runOnce, requestPause, getState };

  // ============================================================
  // scheduler — setTimeout 递归调度
  // ============================================================
  const sched = { timer: null, nextFireAt: 0 };

  function clearScheduler() {
    if (sched.timer) {
      clearTimeout(sched.timer);
      sched.timer = null;
      sched.nextFireAt = 0;
    }
  }

  function scheduleNext(intervalMs) {
    clearScheduler();
    sched.nextFireAt = Date.now() + intervalMs;
    sched.timer = setTimeout(async () => {
      sched.timer = null;
      const cfg = loadConfig();
      if (!cfg.schedule.enabled) return; // 期间被关闭
      try {
        await runOnce({ trigger: "schedule" });
      } catch (e) {
        appendLog(`定时轮异常：${e.message}`);
      }
      // 排下一次（loadConfig 重新读，间隔可能被改）
      const c2 = loadConfig();
      if (c2.schedule.enabled)
        scheduleNext(c2.schedule.intervalMin * 60_000);
    }, intervalMs);
  }

  function startScheduler() {
    const cfg = loadConfig();
    if (!cfg.schedule.enabled) return;
    if (cfg.schedule.intervalMin < 5) {
      appendLog(`定时间隔小于 5 分钟，已忽略`);
      return;
    }
    appendLog(`定时已开启，间隔 ${cfg.schedule.intervalMin} 分钟`);
    if (cfg.schedule.runImmediatelyOnStart) {
      runOnce({ trigger: "schedule" }).then(() =>
        scheduleNext(cfg.schedule.intervalMin * 60_000),
      );
    } else {
      scheduleNext(cfg.schedule.intervalMin * 60_000);
    }
  }

  function stopScheduler() {
    clearScheduler();
    appendLog("定时已停止");
  }

  function getSchedulerInfo() {
    return {
      active: !!sched.timer,
      nextFireAt: sched.nextFireAt,
      msUntilNext: sched.nextFireAt ? sched.nextFireAt - Date.now() : 0,
    };
  }

  // URL 守卫：离开评论管理页时暂停定时器，回来后恢复
  function installUrlGuard() {
    const isOnTargetPage = () =>
      /\/creator-micro\/(comment-manage|data-center\/comment)/.test(
        location.pathname,
      );
    let onTarget = isOnTargetPage();
    const obs = new MutationObserver(() => {
      const now = isOnTargetPage();
      if (now === onTarget) return;
      onTarget = now;
      const cfg = loadConfig();
      if (!cfg.schedule.enabled) return;
      if (now) {
        appendLog("回到评论管理页，恢复定时");
        startScheduler();
      } else {
        appendLog("离开评论管理页，暂停定时");
        clearScheduler();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  ar.scheduler = {
    startScheduler,
    stopScheduler,
    scheduleNext,
    getSchedulerInfo,
    installUrlGuard,
  };

  // 启动时根据配置自动恢复定时器
  const __cfg = loadConfig();
  if (__cfg.schedule.enabled) {
    setTimeout(() => startScheduler(), 2000); // 等 DOM 稳定
  }
  installUrlGuard();

  console.log(`${TAG} loaded v${VERSION}`);
})();
