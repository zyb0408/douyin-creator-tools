// 抖音创作者自动回复助手 — Chrome 扩展 content script
// （从 userscripts/douyin-auto-reply-userscript.js 移植，核心模块完全一致）

(async function () {
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
    worksLimit: 200, // 单次扫描安全上限（防异常死循环），用户不可见
    maxRepliesPerScan: 10, // 用户可配置：每次扫描最多回复条数
    worksToProcess: 0, // 遍历最新 N 个作品（0 = 仅当前作品不切换）
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
    return structuredClone(_cachedConfig);
  }

  function saveConfig(cfg) {
    _cachedConfig = cfg;
    chrome.storage.local
      .set({ [CONFIG_KEY]: JSON.stringify(cfg) })
      .catch((e) => console.warn(TAG, "saveConfig failed:", e));
  }

  // 启动时一次性加载，之后所有 loadConfig() 都是同步读 cache
  let _cachedConfig = structuredClone(DEFAULT_CONFIG);
  async function initConfig() {
    try {
      const result = await chrome.storage.local.get([CONFIG_KEY]);
      const raw = result[CONFIG_KEY];
      if (!raw) return;
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      _cachedConfig = deepMerge(DEFAULT_CONFIG, parsed);
    } catch (e) {
      console.warn(TAG, "initConfig failed, using defaults:", e);
    }
  }

  ar.config = { DEFAULT_CONFIG, loadConfig, saveConfig, deepMerge, initConfig };

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
      .replace(/<(?:think|thinking|reasoning|thought)>[\s\S]*?<\/(?:think|thinking|reasoning|thought)>/gi, "")
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
    // 评论筛选下拉触发器（"全部评论 ▾"），点开后菜单含"全部评论/未回复/包含问题/可能打扰"
    filterTriggerSelector: ".douyin-creator-interactive-select-selection-text",
    filterTriggerText: "全部评论",
    unrepliedOptionText: "未回复",
    // 评论项操作按钮（赞/回复/删除/举报），实际是 div 不是 button
    commentActionItemSelector: '[class*="item-M3fSkJ"]',
    commentListRoot: '[class*="comment-list"], [class*="CommentList"]',
    replyBtnText: "回复",
    sendBtnText: "发送",
    editorContentEditable: '[contenteditable="true"]',
  };

  // ============================================================
  // works — 打开作品面板，选第 i 个作品
  // 抖音 DOM: ul.douyin-creator-interactive-list-items > div.container-XXXX
  // ============================================================
  const WORKS_LIST_UL = "ul.douyin-creator-interactive-list-items";

  async function openWorksPanel() {
    // 如果侧边栏已经打开，直接返回（避免反复点击）
    const existing = document.querySelector(WORKS_LIST_UL);
    if (existing && isVisible(existing)) return;

    const btn = await waitFor(
      () => queryClickableByText(SELECTORS.worksOpenBtnText),
      { timeout: 8000 },
    );
    realClick(btn);
    // 等侧边栏作品列表 UL 出现
    await waitFor(
      () => {
        const ul = document.querySelector(WORKS_LIST_UL);
        return ul && isVisible(ul);
      },
      { timeout: 6000 },
    );
    await sleep(500); // 等列表渲染稳定
  }

  function listWorkItems() {
    const ul = document.querySelector(WORKS_LIST_UL);
    if (!ul) return [];
    // UL 直接子元素就是 div.container-XXXX，每个是一个作品项
    return [...ul.children].filter(isVisible);
  }

  function getWorkTitle(item) {
    // container 的 textContent 含标题、统计、时间等，截前 60 字作为日志标题
    return (
      (item?.textContent || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 60) || "未知作品"
    );
  }

  async function selectWorkByIndex(idx) {
    await openWorksPanel();
    const items = listWorkItems();
    if (idx >= items.length) {
      throw new Error(
        `作品索引 ${idx + 1} 超出范围（共 ${items.length} 个）`,
      );
    }
    const item = items[idx];
    // 滚到该作品（侧边栏 UL 可能有滚动条）
    item.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(300);
    realClick(item);
    // 等评论区刷新（侧边栏关闭 + 评论加载）
    await sleep(1500);
    return getWorkTitle(item);
  }

  ar.works = {
    openWorksPanel,
    listWorkItems,
    selectWorkByIndex,
    getWorkTitle,
    SELECTORS,
  };

  // ============================================================
  // collect — 应用「未回复」筛选，提取下一条待回复
  // ============================================================
  // 取节点自身直接的文本（排除子节点的 textContent，用来精确匹配下拉选项）
  function directText(el) {
    if (!el) return "";
    return [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.nodeValue)
      .join("")
      .trim();
  }

  // 辅助：在当前打开的下拉里找某个 directText 匹配的选项并点击
  async function clickDropdownOption(text) {
    const option = await waitFor(
      () => {
        for (const e of document.querySelectorAll("*")) {
          if (directText(e) === text && isVisible(e)) return e;
        }
        return null;
      },
      { timeout: 3000 },
    );
    realClick(option);
  }

  // 辅助：点开筛选下拉（找到触发器并点击）
  async function openFilterDropdown(matchText) {
    const trigger = await waitFor(
      () => {
        const cands = document.querySelectorAll(SELECTORS.filterTriggerSelector);
        for (const e of cands) {
          if (
            (e.textContent || "").trim() === matchText &&
            isVisible(e)
          )
            return e;
        }
        return null;
      },
      { timeout: 5000 },
    );
    const clickTarget =
      trigger.closest("[role='button'], [class*='select']") || trigger;
    realClick(clickTarget);
    await sleep(400);
  }

  async function applyUnrepliedFilter() {
    // 先检查当前筛选状态，不在"全部评论"就先复位
    const currentTrigger = document.querySelector(SELECTORS.filterTriggerSelector);
    const currentText = (currentTrigger?.textContent || "").trim();

    if (currentText && currentText !== SELECTORS.filterTriggerText) {
      // 当前不在"全部评论"——先复位（不管是在"未回复"还是"包含问题"等）
      await openFilterDropdown(currentText);
      await clickDropdownOption(SELECTORS.filterTriggerText);
      await sleep(800);
    }

    // 现在从"全部评论"切到"未回复"，触发一次全量 API 请求
    await openFilterDropdown(SELECTORS.filterTriggerText);
    await clickDropdownOption(SELECTORS.unrepliedOptionText);
    await sleep(2000); // 等评论列表刷新（API 请求 + React 渲染）
  }

  /**
   * 从评论列表里找第一条"还有「回复」按钮"的评论容器。
   * 返回 { container, replyBtn, username, commentText }，找不到返回 null。
   */
  function extractFirstUnreplied() {
    // 直接找 class*="item-M3fSkJ" 且 directText === "回复" 的元素
    const items = document.querySelectorAll(SELECTORS.commentActionItemSelector);
    let replyBtn = null;
    for (const el of items) {
      // 跳过本次扫描已处理过的（DOM 标记）
      if (el.dataset && el.dataset.douyinArReplied === "1") continue;
      if (
        directText(el) === SELECTORS.replyBtnText &&
        isVisible(el)
      ) {
        replyBtn = el;
        break;
      }
    }
    if (!replyBtn) return null;

    // 评论容器：抖音命名规律是 class="container-XXXX"（XXXX 是 hash）
    // 兜底依次尝试 content-XXXX、然后是含时间标识 + 高度合理的祖先
    let container = replyBtn.closest("[class*='container-']");
    if (!container) container = replyBtn.closest("[class*='content-']");
    if (!container) {
      let p = replyBtn.parentElement;
      while (p && p.parentElement) {
        const r = p.getBoundingClientRect();
        const text = (p.textContent || "").trim();
        if (
          r.height >= 60 &&
          /(\d+[小时分钟天月秒]前|昨天|前天|刚刚|\d{1,2}-\d{1,2})/.test(text) &&
          text.length > 20
        ) {
          container = p;
          break;
        }
        p = p.parentElement;
      }
    }
    if (!container) container = replyBtn.parentElement;

    // 抽用户名/评论文本
    // 抖音格式: "Sting昨天18:53缓存命中97%左右 1回复删除举报"
    //          [用户名][时间][评论文本][操作行]
    // 创作者自己的评论会含 "作者" 徽章，textContent 拼接会产生 "用户名作者..."
    const allText = (container.textContent || "")
      .trim()
      .replace(/\s+/g, " ");
    const timeRe =
      /(\d+\s*[小时分钟天周月秒]前|昨天\s*\d{1,2}[:：]\d{1,2}|前天\s*\d{1,2}[:：]\d{1,2}|刚刚|\d{1,2}-\d{1,2}(?:\s*\d{1,2}[:：]\d{1,2})?|\d{4}-\d{1,2}-\d{1,2}(?:\s*\d{1,2}[:：]\d{1,2})?)/;
    const m = allText.match(timeRe);
    let username = "unknown";
    let body = allText;
    if (m) {
      username = allText.slice(0, m.index).trim() || "unknown";
      body = allText.slice(m.index + m[0].length).trim();
    }
    // 检测"作者"徽章（抖音给创作者评论加的标记）
    let isOwn = false;
    for (const e of container.querySelectorAll("*")) {
      if (
        directText(e) === "作者" &&
        e.children.length === 0 &&
        isVisible(e)
      ) {
        isOwn = true;
        break;
      }
    }
    // 清掉用户名里的 "作者" 后缀/前缀（textContent 拼接产生的）
    if (username.endsWith("作者")) username = username.slice(0, -2).trim();
    if (username.startsWith("作者"))
      username = username.slice(2).trim() || "unknown";

    // 去尾部操作按钮文本: "1回复删除举报" 或 "0回复删除举报查看N条回复"
    const commentText =
      body
        .replace(/\s*\d*\s*回复\s*删除\s*举报.*$/, "")
        .trim() || body.slice(0, 100);

    return { container, replyBtn, username, commentText, isOwn };
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

    // 点击「回复」前快照所有可见 contenteditable，便于识别"新出现的那个"
    // 顶部主评论框始终在 DOM 里，必须排除它，否则会把回复发成新评论
    const beforeEditors = new Set(
      [...document.querySelectorAll(SELECTORS.editorContentEditable)].filter(
        isVisible,
      ),
    );

    realClick(replyBtn);

    // 找新出现的输入框：优先 commentInfo.container 内的，兜底用快照差集
    const editor = await waitFor(
      () => {
        const all = [
          ...document.querySelectorAll(SELECTORS.editorContentEditable),
        ].filter(isVisible);
        // 优先：评论容器内出现的
        const inContainer = all.find(
          (e) => container.contains(e) && !beforeEditors.has(e),
        );
        if (inContainer) return inContainer;
        // 兜底：本来不在的，新出现的
        const newOne = all.find((e) => !beforeEditors.has(e));
        if (newOne) return newOne;
        return null;
      },
      { timeout: 5000 },
    );

    await typeReply(editor, replyText, cfg);

    // 找发送按钮：限定在 editor 邻近的容器里，避免点到顶部主输入框的"发送"
    const sendBtn = await waitFor(
      () => {
        // editor 自身向上找最近的"回复表单"祖先
        const scope =
          editor.closest(
            "[class*='editor'], [class*='Editor'], [class*='reply'], [class*='Reply'], form",
          ) ||
          editor.parentElement?.parentElement ||
          editor.parentElement;
        if (!scope) return null;
        const all = [
          ...scope.querySelectorAll("button, [role='button'], div, span"),
        ];
        for (const e of all) {
          if (
            directText(e) === SELECTORS.sendBtnText &&
            isVisible(e) &&
            !e.disabled &&
            e.getAttribute("aria-disabled") !== "true" &&
            !e.classList.contains("disabled")
          ) {
            return e.closest("button, [role='button']") || e;
          }
        }
        return null;
      },
      { timeout: 4000 },
    );
    realClick(sendBtn);

    // 发送后等：任意一个达到即视为完成
    // A. 行内输入框 editor 从 DOM 移除或不可见（最常见的成功标志）
    // B. editor 文本被清空（前端发送后清框）
    // C. replyBtn 自身消失（评论被未回复筛掉）
    await waitFor(
      () => {
        const editorGone =
          !document.body.contains(editor) || !isVisible(editor);
        const editorEmpty = (editor.textContent || "").trim() === "";
        const btnGone =
          !document.body.contains(replyBtn) || !isVisible(replyBtn);
        return editorGone || editorEmpty || btnGone;
      },
      { timeout: 8000 },
    );
    return true;
  }

  ar.send = { findEditor, findSendButton, typeReply, sendReply };

  // ============================================================
  // llm — OpenAI 兼容接口客户端
  // ============================================================
  const SYSTEM_PROMPT = [
    "你是抖音创作者评论助手。请只输出一条可以直接发送的中文回复，不要解释，不要加引号，不要分点。",
    "",
    "要求：",
    "1. 回复自然、真诚、简短，尽量像真人。",
    "2. 不要引流，不要留联系方式，不要让用户私信。",
    "3. 不要夸大承诺，不要出现营销腔。",
    "4. 如果评论带图但你看不到图片内容，不要编造图片细节。",
    "5. 最终回复控制在 80 字内，绝对不要超过 400 字。",
  ].join("\n");

  function buildUserPrompt({ workTitle, comment }) {
    return [
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
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt({ workTitle, comment }) },
      ],
      // 禁用 reasoning model 的思考链输出（与 Node 版 lib/llm-reply-generator 对齐）
      chat_template_kwargs: { enable_thinking: false },
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

  ar.llm = { buildUserPrompt, SYSTEM_PROMPT, callLLM };

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
  // 页面会话级别已回复签名集合：跨 scan 持久，防止定时扫描重复回复
  const repliedSignatures = new Set();
  const sigOf = (c) =>
    (c.username || "").trim() + "|" + (c.commentText || "").trim().slice(0, 40);

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
      `${trigger === "schedule" ? "[定时] " : ""}扫描 #${STATE.runId} 启动`,
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
    const safetyMax = Math.max(1, cfg.worksLimit | 0); // 隐性安全上限，防死循环
    const userMax = Math.max(1, cfg.maxRepliesPerScan | 0); // 用户配置：本次扫描最多回复
    const maxReplies = Math.min(userMax, safetyMax);
    const worksToProcess = Math.max(0, cfg.worksToProcess | 0);

    // 处理一个已选中作品的所有未回复（不切换作品，直接在当前评论列表上跑）
    // 返回本作品成功回复的条数
    const processCurrentWork = async (workTitle) => {
      let replied = 0;
      let consecutiveFailures = 0;

      try {
        await applyUnrepliedFilter();
      } catch (e) {
        appendLog(`  未回复筛选失败：${e.message}`);
        return 0;
      }

      let commentSeq = 0;
      while (!STATE.abortRequested && commentSeq < maxReplies) {
        const c = extractFirstUnreplied();
        if (!c) {
          appendLog(`  已无可回复评论`);
          break;
        }
        if (c.isOwn) {
          if (c.replyBtn && c.replyBtn.dataset)
            c.replyBtn.dataset.douyinArReplied = "1";
          appendLog(`  跳过自己的评论：${c.username}`);
          continue;
        }
        const sig = sigOf(c);
        if (repliedSignatures.has(sig)) {
          if (c.replyBtn && c.replyBtn.dataset)
            c.replyBtn.dataset.douyinArReplied = "1";
          consecutiveFailures += 1;
          if (consecutiveFailures >= 3) {
            appendLog(`  重复抓到已处理评论，可能页面未刷新，停止`);
            break;
          }
          continue;
        }
        commentSeq += 1;

        // 评论摘要日志（用户名 + 原文截断）
        const commentPreview =
          (c.commentText || "").slice(0, 40) +
          ((c.commentText || "").length > 40 ? "…" : "");
        appendLog(
          `  评论 #${commentSeq} user=${c.username} | 原文: "${commentPreview}"`,
        );
        appendLog(`  评论 #${commentSeq} 调用 ${cfg.mode} 生成回复...`);
        const tStart = Date.now();
        const gen = await generateReply({ cfg, workTitle, comment: c });
        const tMs = Date.now() - tStart;
        if (gen.fatal) {
          appendLog(
            `  评论 #${commentSeq} LLM ${gen.status} 致命错误，停止`,
          );
          break;
        }
        if (!gen.text) {
          appendLog(
            `  评论 #${commentSeq} → 跳过(${gen.reason})，耗时 ${tMs}ms`,
          );
          repliedSignatures.add(sig);
          if (c.replyBtn && c.replyBtn.dataset)
            c.replyBtn.dataset.douyinArReplied = "1";
          consecutiveFailures += 1;
          if (consecutiveFailures >= 3) {
            appendLog(`  连续 3 次失败，暂停本作品`);
            break;
          }
          continue;
        }
        appendLog(
          `  评论 #${commentSeq} 生成完成 (via ${gen.via}, ${tMs}ms)`,
        );

        const sanitized = sanitizeReplyMessage(gen.text, cfg.aiSignature);
        if (!sanitized.replyMessage) {
          appendLog(
            `  评论 #${commentSeq} → 命中过滤(${sanitized.skipReason})，跳过`,
          );
          repliedSignatures.add(sig);
          if (c.replyBtn && c.replyBtn.dataset)
            c.replyBtn.dataset.douyinArReplied = "1";
          continue;
        }

        // 显示最终发送内容（截断）
        const replyPreview =
          sanitized.replyMessage.slice(0, 60) +
          (sanitized.replyMessage.length > 60 ? "…" : "");
        appendLog(`  评论 #${commentSeq} 回复内容: "${replyPreview}"`);

        try {
          appendLog(`  评论 #${commentSeq} 发送中...`);
          await sendReply(c, sanitized.replyMessage, cfg);
          repliedSignatures.add(sig);
          if (c.replyBtn && c.replyBtn.dataset)
            c.replyBtn.dataset.douyinArReplied = "1";
          replied += 1;
          consecutiveFailures = 0;
          appendLog(`  评论 #${commentSeq} 已回复 ✓`);
          await sleep(
            randomBetween(cfg.replyDelayMinMs, cfg.replyDelayMaxMs),
          );
        } catch (e) {
          appendLog(`  评论 #${commentSeq} 发送失败：${e.message}`);
          repliedSignatures.add(sig);
          if (c.replyBtn && c.replyBtn.dataset)
            c.replyBtn.dataset.douyinArReplied = "1";
          consecutiveFailures += 1;
          if (consecutiveFailures >= 3) {
            appendLog(`  连续 3 次失败，暂停本作品`);
            break;
          }
        }
      }
      return replied;
    };

    try {
      if (worksToProcess === 0) {
        // 仅当前作品（不切换）
        appendLog(`本次扫描最多回复 ${maxReplies} 条 / 仅当前作品`);
        totalReplied = await processCurrentWork("（当前作品）");
      } else {
        // 切换前 N 个作品
        appendLog(`本次扫描每作品最多回复 ${maxReplies} 条 / 遍历前 ${worksToProcess} 个作品`);
        try {
          await openWorksPanel();
        } catch (e) {
          appendLog(`打开作品面板失败：${e.message}`);
          return { totalReplied: 0 };
        }
        const items = listWorkItems();
        if (items.length === 0) {
          appendLog(`未找到任何作品，停止`);
          return { totalReplied: 0 };
        }
        const N = Math.min(worksToProcess, items.length);
        appendLog(`发现 ${items.length} 个作品，处理前 ${N} 个`);

        for (let i = 0; i < N; i++) {
          if (STATE.abortRequested) {
            appendLog(`已暂停`);
            break;
          }
          STATE.currentWorkIdx = i;
          let title;
          try {
            title = await selectWorkByIndex(i);
          } catch (e) {
            appendLog(`作品 #${i + 1} 切换失败：${e.message}`);
            continue;
          }
          appendLog(`========= 作品 ${i + 1}/${N}: ${title} =========`);
          const replied = await processCurrentWork(title);
          totalReplied += replied;
          appendLog(`作品 ${i + 1}/${N} 完成，本作品回复 ${replied} 条`);
        }
      }
    } catch (e) {
      STATE.lastError = e.message;
      appendLog(`引擎异常：${e.message}`);
    } finally {
      STATE.state = "idle";
      STATE.currentWorkIdx = -1;
      appendLog(`扫描 #${STATE.runId} 结束，共回复 ${totalReplied} 条`);
    }
    return { totalReplied };
  }

  ar.engine = { runOnce, requestPause, getState };

  // ============================================================
  // scheduler — chrome.alarms 精确定时（SW 管理 alarm，不受标签后台节流）
  // ============================================================
  const sched = { active: false, nextFireAt: 0 };

  function clearScheduler() {
    sched.active = false;
    sched.nextFireAt = 0;
    chrome.runtime.sendMessage({ type: "SCHEDULE_STOP" }).catch(() => { });
  }

  function scheduleNext(intervalMs) {
    const intervalMin = intervalMs / 60_000;
    sched.active = true;
    sched.nextFireAt = Date.now() + intervalMs;
    chrome.runtime
      .sendMessage({ type: "SCHEDULE_START", intervalMin })
      .catch(() => { });
  }

  function startScheduler() {
    const cfg = loadConfig();
    if (!cfg.schedule.enabled) return;
    if (cfg.schedule.intervalMin < 5) {
      appendLog(`定时间隔小于 5 分钟，已忽略`);
      return;
    }
    appendLog(`定时已开启，间隔 ${cfg.schedule.intervalMin} 分钟（后台精确计时）`);
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
      active: sched.active,
      nextFireAt: sched.nextFireAt,
      msUntilNext: sched.nextFireAt ? sched.nextFireAt - Date.now() : 0,
    };
  }

  // 监听来自 service worker 的定时触发消息
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SCHEDULE_FIRE") {
      // 页面不在激活状态也允许扫描（用户之前选了定时，说明不想错过）
      // runOnce 内部会检查 STATE.state === "running" 防堆积
      runOnce({ trigger: "schedule" })
        .then(() => {
          // 扫描完成后刷新倒计时
          const cfg = loadConfig();
          if (cfg.schedule.enabled) {
            sched.nextFireAt =
              Date.now() + cfg.schedule.intervalMin * 60_000;
          }
        })
        .catch((e) => appendLog(`定时轮异常：${e.message}`));
    }
  });

  // URL 守卫：离开评论管理页不再暂停定时（SW 侧由 alarm 管理），
  // 仅用于 UI 状态提示
  function installUrlGuard() {
    // alarm 层面已由 SW 全局管理，这里只保留兼容接口不做事
  }

  ar.scheduler = {
    startScheduler,
    stopScheduler,
    scheduleNext,
    getSchedulerInfo,
    installUrlGuard,
  };

  // ============================================================
  // ui — Shadow DOM 悬浮面板
  // ============================================================
  const UI_STYLES = `
    :host { all: initial; }
    .root { position: fixed; right: 24px; bottom: 24px; z-index: 2147483647;
            font-family: -apple-system, "PingFang SC", system-ui, sans-serif; font-size: 13px; color: #1f2328; }
    .fab { width: 56px; height: 56px; border-radius: 28px; background: #1f6feb; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 24px; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,.2); user-select: none; }
    .panel { width: 380px; max-height: 80vh; background: #fff; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.18); overflow: hidden; display: flex; flex-direction: column; }
    .panel header { padding: 12px 14px; background: #f6f8fa; border-bottom: 1px solid #e1e4e8; display: flex; align-items: center; justify-content: space-between; cursor: move; }
    .panel header .title { font-weight: 600; }
    .panel header .actions button { background: transparent; border: none; cursor: pointer; padding: 4px 6px; font-size: 14px; }
    .body { padding: 12px; overflow-y: auto; flex: 1; }
    .section { border: 1px solid #e1e4e8; border-radius: 6px; margin-bottom: 8px; }
    .section > summary { padding: 8px 10px; cursor: pointer; font-weight: 500; background: #fafbfc; }
    .section[open] > summary { border-bottom: 1px solid #e1e4e8; }
    .section .content { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    .row { display: flex; align-items: center; gap: 8px; }
    .row label { flex: 0 0 80px; color: #57606a; }
    .row input[type="text"], .row input[type="number"], .row input[type="password"], .row select { flex: 1; padding: 4px 8px; border: 1px solid #d0d7de; border-radius: 4px; font: inherit; }
    textarea { width: 100%; min-height: 80px; padding: 6px; border: 1px solid #d0d7de; border-radius: 4px; font: inherit; resize: vertical; box-sizing: border-box; }
    .controls { display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid #e1e4e8; background: #fafbfc; flex-wrap: wrap; }
    .btn { padding: 6px 12px; border: 1px solid #d0d7de; background: #fff; border-radius: 6px; cursor: pointer; font: inherit; }
    .btn.primary { background: #1f6feb; color: #fff; border-color: #1f6feb; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .log { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; background: #0d1117; color: #9ece6a; padding: 8px; border-radius: 4px; height: 160px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
    .status { padding: 8px 12px; background: #fff; border-bottom: 1px solid #e1e4e8; font-size: 12px; color: #57606a; }
    .status.running { color: #1a7f37; }
  `;

  function createPanelHost() {
    const host = document.createElement("div");
    host.id = "douyin-ar-host";
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.right = "0";
    host.style.bottom = "0";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = UI_STYLES;
    shadow.appendChild(style);
    const root = document.createElement("div");
    root.className = "root";
    shadow.appendChild(root);
    return { host, shadow, root };
  }

  let uiState = { collapsed: true, root: null, shadow: null, _countdownTimer: null };

  function stopCountdown() {
    if (uiState._countdownTimer) {
      clearInterval(uiState._countdownTimer);
      uiState._countdownTimer = null;
    }
  }

  function renderFab() {
    stopCountdown();
    uiState.root.innerHTML = `<div class="fab" title="抖音自动回复">🤖</div>`;
    uiState.root.querySelector(".fab").addEventListener("click", () => {
      uiState.collapsed = false;
      render();
    });
  }

  // 占位：完整 panel 留到 Task 14 实现
  function renderPanel() {
    const cfg = loadConfig();
    const st = getState();
    const sInfo = getSchedulerInfo();
    const nextStr =
      sInfo.active && sInfo.nextFireAt
        ? new Date(sInfo.nextFireAt).toLocaleTimeString() +
        `（剩 ${Math.max(0, Math.round(sInfo.msUntilNext / 60000))} 分钟）`
        : "未定时";
    const escapeHtml = (s) =>
      String(s).replace(/[<>&"']/g, (c) =>
        ({
          "<": "&lt;",
          ">": "&gt;",
          "&": "&amp;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
      );

    uiState.root.innerHTML = `
      <div class="panel">
        <header><span class="title">🤖 抖音自动回复</span><span class="actions"><button class="collapse">—</button></span></header>
        <div class="status ${st.state === "running" ? "running" : ""}">状态：${st.state === "running" ? `运行中（作品 ${st.currentWorkIdx + 1}）` : "待机"}</div>

        <div class="body">
          <details class="section" open>
            <summary>基础设置</summary>
            <div class="content">
              <div class="row"><label>启用</label><input type="checkbox" id="enabled" ${cfg.enabled ? "checked" : ""}></div>
              <div class="row"><label>模式</label>
                <select id="mode">
                  <option value="template" ${cfg.mode === "template" ? "selected" : ""}>纯模板</option>
                  <option value="llm" ${cfg.mode === "llm" ? "selected" : ""}>纯 LLM</option>
                  <option value="hybrid" ${cfg.mode === "hybrid" ? "selected" : ""}>混合</option>
                </select>
              </div>
              <div class="row"><label>每次最多回复</label><input type="number" id="maxRepliesPerScan" min="1" max="200" value="${cfg.maxRepliesPerScan}">条</div>
              <div class="row"><label>遍历作品数</label><input type="number" id="worksToProcess" min="0" max="50" value="${cfg.worksToProcess}"><span style="font-size:11px;color:#57606a">（0=仅当前作品）</span></div>
              <div class="row"><label>回复尾巴</label><input type="text" id="aiSig" placeholder="留空则不追加" value="${escapeHtml(cfg.aiSignature)}"></div>
            </div>
          </details>

          <details class="section">
            <summary>定时扫描</summary>
            <div class="content">
              <div class="row"><label>开启</label><input type="checkbox" id="schedEnabled" ${cfg.schedule.enabled ? "checked" : ""}></div>
              <div class="row"><label>间隔(分钟)</label><input type="number" id="schedInterval" min="5" value="${cfg.schedule.intervalMin}"></div>
              <div class="row"><label>立即先跑</label><input type="checkbox" id="schedImmediate" ${cfg.schedule.runImmediatelyOnStart ? "checked" : ""}></div>
              <div class="row"><label>下次运行</label><span id="countdown-text" style="font-size:12px;color:#57606a">${nextStr}</span></div>
            </div>
          </details>

          <details class="section">
            <summary>自定义模板（每行一条）</summary>
            <div class="content"><textarea id="templates">${escapeHtml((cfg.templates || []).join("\n"))}</textarea></div>
          </details>

          <details class="section">
            <summary>LLM 配置</summary>
            <div class="content">
              <div class="row"><label>baseURL</label><input type="text" id="llmBase" value="${escapeHtml(cfg.llm.baseURL)}"></div>
              <div class="row"><label>apiKey</label><input type="password" id="llmKey" value="${escapeHtml(cfg.llm.apiKey)}"></div>
              <div class="row"><label>model</label><input type="text" id="llmModel" value="${escapeHtml(cfg.llm.model)}"></div>
              <div class="row"><label>temperature</label><input type="number" step="0.1" id="llmTemp" value="${cfg.llm.temperature}"></div>
              <div class="row"><label>maxTokens</label><input type="number" id="llmMax" value="${cfg.llm.maxTokens}"></div>
            </div>
          </details>

          <details class="section">
            <summary>高级（延迟与打字速度）</summary>
            <div class="content">
              <div class="row"><label>打字最小</label><input type="number" id="typeMin" value="${cfg.typingMinMs}">ms</div>
              <div class="row"><label>打字最大</label><input type="number" id="typeMax" value="${cfg.typingMaxMs}">ms</div>
              <div class="row"><label>评论间隔最小</label><input type="number" id="rdMin" value="${cfg.replyDelayMinMs}">ms</div>
              <div class="row"><label>评论间隔最大</label><input type="number" id="rdMax" value="${cfg.replyDelayMaxMs}">ms</div>
            </div>
          </details>

          <details class="section" open>
            <summary>日志</summary>
            <div class="content"><div class="log" id="logBox">${escapeHtml(logBuffer.join("\n"))}</div></div>
          </details>
        </div>

        <div class="controls">
          <button class="btn primary" id="btnStart" ${st.state === "running" ? "disabled" : ""}>▶ 开始</button>
          <button class="btn" id="btnPause" ${st.state !== "running" ? "disabled" : ""}>⏸ 暂停</button>
          <button class="btn" id="btnSave">💾 保存</button>
          <button class="btn" id="btnCopyLog">📋 复制日志</button>
          <button class="btn" id="btnClearLog">🧹 清空日志</button>
        </div>
      </div>
    `;
    bindPanelEvents();

    // 启动 1 秒倒计时，实时更新面板"下次运行"显示
    stopCountdown();
    uiState._countdownTimer = setInterval(() => {
      const sInfo = getSchedulerInfo();
      const el = uiState.root?.querySelector("#countdown-text");
      if (!el) {
        stopCountdown();
        return;
      }
      if (sInfo.active && sInfo.nextFireAt) {
        const ms = sInfo.msUntilNext;
        if (ms <= 0) {
          el.textContent = "即将触发...";
        } else {
          const totalSec = Math.max(0, Math.round(ms / 1000));
          const min = Math.floor(totalSec / 60);
          const sec = totalSec % 60;
          el.textContent =
            new Date(sInfo.nextFireAt).toLocaleTimeString() +
            `（剩 ${min} 分 ${sec} 秒）`;
        }
      } else {
        el.textContent = "未定时";
      }
    }, 1000);
  }

  function bindPanelEvents() {
    const $ = (sel) => uiState.root.querySelector(sel);
    $(".collapse").addEventListener("click", () => {
      uiState.collapsed = true;
      render();
    });
    $("#btnStart").addEventListener("click", () =>
      runOnce({ trigger: "manual" }).then(() => render()),
    );
    $("#btnPause").addEventListener("click", () => requestPause());
    $("#btnSave").addEventListener("click", saveFromUI);
    $("#btnCopyLog").addEventListener("click", () =>
      navigator.clipboard.writeText(logBuffer.join("\n")),
    );
    $("#btnClearLog").addEventListener("click", () => {
      clearLog();
      render();
    });
  }

  function saveFromUI() {
    const $ = (sel) => uiState.root.querySelector(sel);
    const cfg = loadConfig();
    cfg.enabled = $("#enabled").checked;
    cfg.mode = $("#mode").value;
    cfg.maxRepliesPerScan = Math.max(
      1,
      Math.min(200, parseInt($("#maxRepliesPerScan").value, 10) || 10),
    );
    cfg.worksToProcess = Math.max(
      0,
      Math.min(50, parseInt($("#worksToProcess").value, 10) || 0),
    );
    // worksLimit 是隐性安全上限，UI 不展示。如旧版小于 50 自动复位避免限死
    if (!cfg.worksLimit || cfg.worksLimit < 50) cfg.worksLimit = 200;
    cfg.schedule.enabled = $("#schedEnabled").checked;
    const interval = parseInt($("#schedInterval").value, 10) || 30;
    if (interval < 5) {
      alert("定时间隔不能小于 5 分钟");
      return;
    }
    cfg.schedule.intervalMin = interval;
    cfg.schedule.runImmediatelyOnStart = $("#schedImmediate").checked;
    cfg.templates = $("#templates")
      .value.split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    cfg.llm.baseURL = $("#llmBase").value.trim();
    cfg.llm.apiKey = $("#llmKey").value.trim();
    cfg.llm.model = $("#llmModel").value.trim();
    cfg.llm.temperature = parseFloat($("#llmTemp").value) || 0.7;
    cfg.llm.maxTokens = parseInt($("#llmMax").value, 10) || 300;
    cfg.aiSignature = $("#aiSig").value;
    cfg.typingMinMs = parseInt($("#typeMin").value, 10);
    cfg.typingMaxMs = parseInt($("#typeMax").value, 10);
    cfg.replyDelayMinMs = parseInt($("#rdMin").value, 10);
    cfg.replyDelayMaxMs = parseInt($("#rdMax").value, 10);
    saveConfig(cfg);
    appendLog("配置已保存");

    // 应用定时变更
    if (cfg.schedule.enabled) startScheduler();
    else stopScheduler();
    render();
  }

  // 订阅日志变化，实时刷新日志框
  logSubscribers.add(() => {
    if (!uiState.collapsed) {
      const box = uiState.root?.querySelector("#logBox");
      if (box) {
        box.textContent = logBuffer.join("\n");
        box.scrollTop = box.scrollHeight;
      }
    }
  });

  function render() {
    if (uiState.collapsed) renderFab();
    else renderPanel();
  }

  function initUI() {
    const { root, shadow } = createPanelHost();
    uiState.root = root;
    uiState.shadow = shadow;
    render();
  }

  ar.ui = {
    initUI,
    render,
    get state() {
      return uiState;
    },
  };

  // 启动时根据配置自动恢复定时器
  await initConfig();
  const __cfg = loadConfig();
  if (__cfg.schedule.enabled) {
    setTimeout(() => startScheduler(), 2000); // 等 DOM 稳定
  }
  installUrlGuard();
  initUI();

  console.log(`${TAG} loaded v${VERSION}`);
})();
