# 抖音创作者中心自动回复 — 油猴脚本实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 `run-all.sh` 的四步流程（获取作品 → 导出未回复评论 → LLM 生成回复 → 自动回复）翻译成单文件 Tampermonkey 脚本，注入抖音创作者中心评论管理页，支持三种回复模式（template / llm / hybrid）和定时扫描。

**Architecture:** 单文件 IIFE，UI 跑在 Shadow DOM 悬浮面板里避免污染；运行引擎是一个状态机驱动的 `for 作品 → while 评论` 循环；每条回复走"仿人输入 + 显式延迟"。模块（config、selectors、dom、sanitize、llm、works、collect、send、engine、scheduler、ui）在文件内分段定义，全部挂到一个内部对象 `__douyinAR` 上，方便 DevTools 控制台单独验证。

**Tech Stack:** Tampermonkey (`@grant GM_setValue/GM_getValue/GM_addStyle`)，浏览器原生 fetch + AbortController + AbortSignal.timeout，MutationObserver，Shadow DOM。

**Design doc:** `docs/plans/2026-05-08-douyin-userscript-design.md`

**No test framework：** 浏览器内脚本无法跑 Jest/Vitest。每个 task 的"验证"步骤是在 DevTools 控制台粘贴 snippet 调用 `window.__douyinAR.<module>.<fn>(...)`，肉眼检查返回值；集成测试在真实创作者后台跑。

---

## Task 1: 油猴脚本骨架与元数据

**Files:**
- Create: `userscripts/douyin-auto-reply-userscript.js`

**Step 1: 写入元数据头 + IIFE 骨架**

```javascript
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

  console.log(`${TAG} loaded v${VERSION}`);
})();
```

**Step 2: 在 Tampermonkey 安装并验证加载**

1. 打开 Tampermonkey → 添加新脚本 → 全选粘贴上述内容 → Ctrl+S
2. 打开 `https://creator.douyin.com/creator-micro/comment-manage`
3. F12 → Console，应看到 `[抖音自动回复] loaded v0.1.0`
4. 控制台输入 `__douyinAR.version`，应返回 `"0.1.0"`

**Step 3: Commit**

```bash
git add userscripts/douyin-auto-reply-userscript.js
git commit -m "feat(userscript): scaffold with metadata header"
```

---

## Task 2: 配置存储层

**Files:**
- Modify: `userscripts/douyin-auto-reply-userscript.js`

**Step 1: 在 IIFE 内部、`console.log` 之前插入 config 模块**

```javascript
// ============================================================
// config — 配置默认值与持久化
// ============================================================
const DEFAULT_CONFIG = {
  enabled: false,
  mode: "hybrid",                  // "template" | "llm" | "hybrid"
  worksLimit: 8,
  templates: [
    "感谢关注！❤️",
    "谢谢你的支持！",
    "欢迎常来玩～",
  ],
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
    if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
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
```

**Step 2: 在控制台验证**

```javascript
// 控制台输入：
__douyinAR.config.loadConfig()
// 应该返回完整 DEFAULT_CONFIG 对象

const c = __douyinAR.config.loadConfig();
c.worksLimit = 5;
__douyinAR.config.saveConfig(c);
__douyinAR.config.loadConfig().worksLimit
// 应该返回 5；刷新页面后再 loadConfig，仍然是 5
```

**Step 3: Commit**

```bash
git add userscripts/douyin-auto-reply-userscript.js
git commit -m "feat(userscript): add config storage with GM_setValue persistence"
```

---

## Task 3: 通用工具（sleep、randomBetween、日志缓冲）

**Files:**
- Modify: `userscripts/douyin-auto-reply-userscript.js`

**Step 1: 在 config 模块之后插入 utils 模块**

```javascript
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
    try { fn(stamped, logBuffer); } catch (e) { console.error(TAG, "log subscriber failed:", e); }
  }
  console.log(TAG, stamped);
}
function clearLog() {
  logBuffer.length = 0;
  for (const fn of logSubscribers) fn(null, logBuffer);
}

ar.utils = { sleep, randomBetween, randomInt, pickRandom, nowHHMMSS, appendLog, clearLog, logBuffer, logSubscribers };
```

**Step 2: 验证**

```javascript
__douyinAR.utils.appendLog("hello");
__douyinAR.utils.logBuffer  // 应该有一条带时间戳的 hello

await __douyinAR.utils.sleep(500);  // 等 500ms
__douyinAR.utils.randomInt(1, 5)    // 1~5 之间整数
```

**Step 3: Commit**

```bash
git add userscripts/douyin-auto-reply-userscript.js
git commit -m "feat(userscript): add utils with sleep, log buffer, random helpers"
```

---

## Task 4: Sanitizer 模块（移植 sanitizeReplyMessage）

**Files:**
- Modify: `userscripts/douyin-auto-reply-userscript.js`
- Reference: `src/lib/llm-reply-generator.mjs:14-85`、`src/lib/common.mjs:3-5,218-230`

**Step 1: 在 utils 之后插入 sanitize 模块（与 Node 端 1:1 移植）**

```javascript
// ============================================================
// sanitize — 内容过滤（与 lib/llm-reply-generator.mjs 完全一致）
// ============================================================
const MAX_REPLY_MESSAGE_CHARS = 400;
const BLOCKED_PATTERNS = [
  /微信/i, /vx/i, /v信/i, /加我/i, /私信我/i, /联系方式/i, /\d{8,}/,
];

function normalizeText(v = "") {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function truncateReplyMessage(text) {
  const src = String(text ?? "");
  const cps = [...src];
  if (cps.length <= MAX_REPLY_MESSAGE_CHARS) return { text: src, truncated: false };
  return { text: cps.slice(0, MAX_REPLY_MESSAGE_CHARS).join(""), truncated: true };
}

function replaceStraightDoubleQuotes(text) {
  let open = true;
  return text.replace(/"/g, () => { const n = open ? "“" : "”"; open = !open; return n; });
}

function sanitizeReplyMessage(rawText, aiSignature) {
  const sig = aiSignature || "";
  const stripped = String(rawText ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^here'?s a thinking process:?.*$/gim, "");
  const normalized = normalizeText(stripped).replace(/\r?\n+/g, " ").replace(/\s{2,}/g, " ");
  const quoted = replaceStraightDoubleQuotes(normalized);
  const { text, truncated } = truncateReplyMessage(quoted);

  if (!normalizeText(text)) return { replyMessage: "", skipReason: "empty_reply", truncated };

  for (const pat of BLOCKED_PATTERNS) {
    if (pat.test(text)) return { replyMessage: "", skipReason: "blocked_content", truncated };
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
  return { replyMessage: finalText, skipReason: "", truncated: truncated || finalText.length > text.length };
}

ar.sanitize = { sanitizeReplyMessage, normalizeText, truncateReplyMessage, BLOCKED_PATTERNS };
```

**Step 2: 在控制台验证 7 个关键场景**

```javascript
const s = __douyinAR.sanitize.sanitizeReplyMessage;
const SIG = "【沪上码仔AI自动回复，注意甄别】";

// 1) 正常文本 → 追加签名
s("谢谢你的关注！", SIG)
// → { replyMessage: "谢谢你的关注！【沪上码仔...】", skipReason: "", truncated: false }

// 2) 含 <think> 标签 → 被剥离
s("<think>嗯…让我想想</think>谢谢支持", SIG).replyMessage
// → "谢谢支持【...】"，skipReason 为 ""

// 3) 黑名单 — 微信
s("加我微信详聊", SIG).skipReason  // → "blocked_content"

// 4) 黑名单 — 长数字
s("电话 13800138000", SIG).skipReason  // → "blocked_content"

// 5) 空回复
s("", SIG).skipReason  // → "empty_reply"
s("    \n  ", SIG).skipReason  // → "empty_reply"

// 6) 超长截断（> 400 码点）
const long = "啊".repeat(450);
const r = s(long, SIG);
[...r.replyMessage].length <= 400  // → true（含签名也不超 400）
r.truncated  // → true

// 7) 直引号 → 弯引号
s('"hello" world', SIG).replyMessage.startsWith("“hello”")  // → true
```

**Step 3: Commit**

```bash
git add userscripts/douyin-auto-reply-userscript.js
git commit -m "feat(userscript): port sanitizeReplyMessage from llm-reply-generator"
```

---

## Task 5: DOM 工具（waitFor / queryByText / click / hover）

**Files:**
- Modify: `userscripts/douyin-auto-reply-userscript.js`

**Step 1: 在 sanitize 之后插入 dom 模块**

```javascript
// ============================================================
// dom — 选择器与等待工具
// ============================================================
async function waitFor(predicate, { timeout = 5000, interval = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const result = predicate();
      if (result) return result;
    } catch (_) { /* 忽略，继续轮询 */ }
    await sleep(interval);
  }
  throw new Error(`waitFor timeout after ${timeout}ms`);
}

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const cs = window.getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
}

function queryAllByText(text, { tag = "*", root = document } = {}) {
  const all = root.querySelectorAll(tag);
  const out = [];
  for (const el of all) {
    if (el.textContent && el.textContent.trim() === text && isVisible(el)) out.push(el);
  }
  return out;
}

function queryByText(text, opts) { return queryAllByText(text, opts)[0] || null; }

function queryClickableByText(text, root = document) {
  // 文本完全匹配 → 兜底：包含匹配（避免抖音多语言或加省略号）
  let el = queryByText(text, { tag: "button", root }) || queryByText(text, { tag: "span", root });
  if (el) return el.closest("button, [role='button'], a") || el;

  const all = root.querySelectorAll("button, [role='button'], div, span");
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
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
  }
}

ar.dom = { waitFor, isVisible, queryByText, queryAllByText, queryClickableByText, realClick };
```

**Step 2: 在创作者评论页控制台手动验证**

```javascript
// 进入 https://creator.douyin.com/creator-micro/comment-manage 后：

// 1) 找「选择作品」按钮
const btn = __douyinAR.dom.queryClickableByText("选择作品");
btn  // 应返回一个真实 DOM 元素，不是 null

// 2) 等待元素出现（已经存在的话立即返回）
await __douyinAR.dom.waitFor(() => __douyinAR.dom.queryClickableByText("选择作品"))
// 应该立即返回元素

// 3) 真实点击
__douyinAR.dom.realClick(btn)
// 抖音页面应该弹出作品选择侧边栏；再点一次外部关闭它
```

**Step 3: Commit**

```bash
git add userscripts/douyin-auto-reply-userscript.js
git commit -m "feat(userscript): add DOM utils (waitFor, queryByText, realClick)"
```

---

## Task 6: SELECTORS 常量 + works-panel 模块

**Files:**
- Modify: `userscripts/douyin-auto-reply-userscript.js`

**Step 1: 在 dom 之后插入 selectors + works 模块**

```javascript
// ============================================================
// selectors — 集中管理所有 DOM 选择器（页面改版时改这里）
// ============================================================
const SELECTORS = {
  worksOpenBtnText: "选择作品",
  worksPanelRoot: '[class*="work-list"], [class*="WorkList"], [class*="works-panel"]',
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
  const btn = await waitFor(() => queryClickableByText(SELECTORS.worksOpenBtnText), { timeout: 8000 });
  realClick(btn);
  // 等侧边栏出现：用「兜底封面图」作为存在标志
  await waitFor(
    () => document.querySelectorAll(SELECTORS.worksItemFallbackImg).length >= 1,
    { timeout: 6000 }
  );
  await sleep(400);
}

function listWorkItems() {
  // 优先 data-e2e 等语义属性；兜底：所有带封面图的可点击块
  const named = document.querySelectorAll('[data-e2e*="work"], [data-e2e*="aweme-item"]');
  if (named.length > 0) return Array.from(named).filter(isVisible);
  // 兜底：每个封面图所在的可点击容器
  const imgs = Array.from(document.querySelectorAll(SELECTORS.worksItemFallbackImg)).filter(isVisible);
  const seen = new Set();
  const items = [];
  for (const img of imgs) {
    const card = img.closest('[role="button"]') || img.closest("li") || img.closest("div");
    if (card && !seen.has(card)) { seen.add(card); items.push(card); }
  }
  return items;
}

async function selectWorkByIndex(idx) {
  await openWorksPanel();
  const items = listWorkItems();
  if (idx >= items.length) throw new Error(`作品索引越界：要 #${idx} 但只有 ${items.length} 个`);
  realClick(items[idx]);
  await sleep(800);  // 等评论区切换
}

ar.works = { openWorksPanel, listWorkItems, selectWorkByIndex, SELECTORS };
```

**Step 2: 在评论页控制台验证**

```javascript
// 1) 打开作品面板
await __douyinAR.works.openWorksPanel();
// 应看到侧边栏弹出

// 2) 列出当前作品
__douyinAR.works.listWorkItems().length  // > 0

// 3) 选第 0 个
await __douyinAR.works.selectWorkByIndex(0)
// 评论区应切换到该作品；侧边栏自动关闭
```

**Step 3: 如果选择器不匹配（很可能），临时调整 `SELECTORS.worksItemFallbackImg`**

打开 DevTools → Elements，定位作品列表项，找一个稳定的属性（class 或 data-*），更新 `SELECTORS`。**这是已知风险**：抖音改版会让选择器失效，所以全部集中在 SELECTORS 是核心设计。

**Step 4: Commit**

```bash
git add userscripts/douyin-auto-reply-userscript.js
git commit -m "feat(userscript): add works panel module with selector fallback"
```

---

## Task 7: 评论收集器（applyUnrepliedFilter + extractFirstUnreplied）

**Files:**
- Modify: `userscripts/douyin-auto-reply-userscript.js`

**Step 1: 在 works 模块之后插入 collect 模块**

```javascript
// ============================================================
// collect — 应用「未回复」筛选，提取下一条待回复
// ============================================================
async function applyUnrepliedFilter() {
  // 抖音有时是 tab，有时是下拉过滤；先按文本找最贴近的可点击
  const tab = await waitFor(() => queryClickableByText(SELECTORS.unrepliedTabText), { timeout: 5000 });
  realClick(tab);
  await sleep(600);
}

/**
 * 从评论列表里找第一条"还有「回复」按钮"的评论容器。
 * 返回 { container, replyBtn, username, commentText }，找不到返回 null。
 */
function extractFirstUnreplied() {
  // 找页面上所有「回复」按钮，取第一个可见的
  const candidates = [];
  const all = document.querySelectorAll("button, [role='button'], span, div");
  for (const el of all) {
    const t = (el.textContent || "").trim();
    if (t === SELECTORS.replyBtnText && isVisible(el)) {
      const clickable = el.closest("button, [role='button']") || el;
      candidates.push(clickable);
    }
  }
  if (candidates.length === 0) return null;

  const replyBtn = candidates[0];
  // 评论容器：往上找最近的"块级容器"（通常 display flex 或带 class）
  let container = replyBtn.closest("[class*='comment-item'], [class*='CommentItem'], li") || replyBtn.parentElement;
  while (container && container.parentElement) {
    const c = container.parentElement;
    if (c.querySelectorAll("button, [role='button']").length > 5) break;  // 走到了列表层
    if (c.tagName === "UL" || c.tagName === "OL") break;
    container = c;
    if (container.getBoundingClientRect().height > 60) break;
  }

  // 从容器里抽用户名和评论文本
  const allText = (container.textContent || "").trim().replace(/\s+/g, " ");
  // 简化策略：第一段非空文字当昵称，第二段当评论文本（用于日志和 prompt）
  // 如果有 [data-e2e] 或具体 class 就优先它（页面改版时再补）
  const lines = allText.split("回复")[0].split(/\s{2,}/).filter(Boolean);
  const username = lines[0] || "unknown";
  const commentText = lines.slice(1).join(" ") || allText.slice(0, 100);

  return { container, replyBtn, username, commentText };
}

ar.collect = { applyUnrepliedFilter, extractFirstUnreplied };
```

**Step 2: 在评论页验证**

```javascript
// 选好一个作品后：
await __douyinAR.collect.applyUnrepliedFilter();
// 列表应只剩未回复评论

const c = __douyinAR.collect.extractFirstUnreplied();
console.log(c);
// 应包含 container（DOM 元素）, replyBtn, username, commentText
```

**Step 3: 调优**：如果 username/commentText 抽得不准，更新 lines 切分策略，或加 `[data-e2e]` 选择器。**先做到能用，后续在真实跑批中再调**。

**Step 4: Commit**

```bash
git add userscripts/douyin-auto-reply-userscript.js
git commit -m "feat(userscript): add comment collector with unreplied filter"
```

---

## Task 8: 回复发送器（仿人输入 + 发送时序）

**Files:**
- Modify: `userscripts/douyin-auto-reply-userscript.js`

**Step 1: 在 collect 之后插入 send 模块**

```javascript
// ============================================================
// send — 单条回复发送时序
// ============================================================
async function findEditor() {
  return waitFor(() => {
    const eds = document.querySelectorAll(SELECTORS.editorContentEditable);
    for (const e of eds) {
      if (isVisible(e) && (e.textContent || "").length === 0) return e;
    }
    return null;
  }, { timeout: 5000 });
}

async function findSendButton(near) {
  return waitFor(() => {
    const root = near?.closest("[class*='editor'], [class*='Editor'], form") || document;
    const btn = queryClickableByText(SELECTORS.sendBtnText, root);
    if (!btn) return null;
    if (btn.disabled || btn.getAttribute("aria-disabled") === "true" || btn.classList.contains("disabled")) return null;
    return btn;
  }, { timeout: 4000 });
}

async function typeReply(editor, text, { typingMinMs, typingMaxMs }) {
  editor.focus();
  // 优先一次性插入（最快路径）
  try {
    if (document.execCommand) {
      document.execCommand("insertText", false, text);
      // 校验是否真的写进去
      await sleep(80);
      if ((editor.textContent || "").includes(text.slice(0, Math.min(8, text.length)))) return;
    }
  } catch (_) { /* 降级 */ }

  // 降级：逐字 dispatch input event（对 React 受控组件有效）
  for (const ch of text) {
    const before = editor.textContent || "";
    editor.dispatchEvent(new InputEvent("beforeinput", { data: ch, inputType: "insertText", bubbles: true, cancelable: true }));
    // 直接改 textContent 兜底
    editor.textContent = before + ch;
    editor.dispatchEvent(new InputEvent("input", { data: ch, inputType: "insertText", bubbles: true }));
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
  await waitFor(() => !document.body.contains(replyBtn) || !isVisible(replyBtn), { timeout: 8000 });
  return true;
}

ar.send = { findEditor, findSendButton, typeReply, sendReply };
```

**Step 2: 在评论页手动跑一条**

```javascript
// 在已经有未回复评论的作品里：
await __douyinAR.collect.applyUnrepliedFilter();
const c = __douyinAR.collect.extractFirstUnreplied();
await __douyinAR.send.sendReply(c, "测试回复，请忽略🙏", { typingMinMs: 30, typingMaxMs: 80 });
// 应看到回复被实际发出去
```

**警告**：这步会在你账号上真实发出评论。**先用小号验证**。

**Step 3: Commit**

```bash
git add userscripts/douyin-auto-reply-userscript.js
git commit -m "feat(userscript): add reply sender with humanized typing"
```

---

## Task 9: LLM 客户端

**Files:**
- Modify: `userscripts/douyin-auto-reply-userscript.js`
- Reference: `src/lib/llm-reply-generator.mjs:101-181`（提示词与请求体）

**Step 1: 在 send 之后插入 llm 模块**

```javascript
// ============================================================
// llm — OpenAI 兼容接口客户端
// ============================================================
const SYSTEM_PROMPT_HEADER = "你是抖音创作者评论助手。请只输出一条可以直接发送的中文回复，不要解释，不要加引号，不要分点。";

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

async function callLLM({ llmConfig, workTitle, comment }, { timeoutMs = 15000 } = {}) {
  const url = llmConfig.baseURL.replace(/\/$/, "") + "/chat/completions";
  const body = {
    model: llmConfig.model,
    temperature: llmConfig.temperature,
    max_tokens: llmConfig.maxTokens,
    messages: [{ role: "user", content: buildPrompt({ workTitle, comment }) }],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${llmConfig.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`LLM ${res.status}: ${errText.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const payload = await res.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("LLM response missing choices[0].message.content");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

ar.llm = { buildPrompt, callLLM };
```

**Step 2: 验证（先在面板存好 apiKey）**

```javascript
const cfg = __douyinAR.config.loadConfig();
cfg.llm.apiKey = "sk-...";
__douyinAR.config.saveConfig(cfg);

const reply = await __douyinAR.llm.callLLM({
  llmConfig: cfg.llm,
  workTitle: "上海周末好去处",
  comment: { username: "小王", commentText: "好想去看看，求攻略！" },
});
console.log(reply);
// 应该返回一段 LLM 生成的中文文本
```

**Step 3: Commit**

```bash
git add userscripts/douyin-auto-reply-userscript.js
git commit -m "feat(userscript): add LLM client with OpenAI-compatible API"
```

---

## Task 10: 回复生成器（三种模式）

**Files:**
- Modify: `userscripts/douyin-auto-reply-userscript.js`

**Step 1: 在 llm 之后插入 generator 模块**

```javascript
// ============================================================
// generator — 三种模式：template / llm / hybrid
// ============================================================
async function generateReply({ cfg, workTitle, comment }) {
  const mode = cfg.mode;

  if (mode === "template") {
    if (!cfg.templates || cfg.templates.length === 0) return { text: null, reason: "no_templates" };
    return { text: pickRandom(cfg.templates), via: "template" };
  }

  if (mode === "llm") {
    try {
      const raw = await callLLM({ llmConfig: cfg.llm, workTitle, comment });
      return { text: raw, via: "llm" };
    } catch (e) {
      return { text: null, reason: `llm_failed:${e.message}`, status: e.status };
    }
  }

  if (mode === "hybrid") {
    try {
      const raw = await callLLM({ llmConfig: cfg.llm, workTitle, comment });
      return { text: raw, via: "llm" };
    } catch (e) {
      // 401/429 时不回退（避免烧 quota），让上层中止整轮
      if (e.status === 401 || e.status === 429) return { text: null, reason: `llm_${e.status}`, status: e.status, fatal: true };
      if (cfg.templates && cfg.templates.length > 0) return { text: pickRandom(cfg.templates), via: "template_fallback" };
      return { text: null, reason: `llm_failed_no_template:${e.message}` };
    }
  }

  return { text: null, reason: `unknown_mode:${mode}` };
}

ar.generator = { generateReply };
```

**Step 2: 验证**

```javascript
// template 模式
const cfgT = { ...__douyinAR.config.loadConfig(), mode: "template" };
await __douyinAR.generator.generateReply({ cfg: cfgT, workTitle: "x", comment: { username: "u", commentText: "c" } })
// → { text: <模板里随机一条>, via: "template" }

// hybrid 模式 + 错的 apiKey
const cfgH = __douyinAR.config.loadConfig();
cfgH.mode = "hybrid";
cfgH.llm.apiKey = "sk-bogus";
await __douyinAR.generator.generateReply({ cfg: cfgH, workTitle: "x", comment: { username: "u", commentText: "c" } })
// → 401 → fatal:true（不回退）
```

**Step 3: Commit**

```bash
git add userscripts/douyin-auto-reply-userscript.js
git commit -m "feat(userscript): add three-mode reply generator (template/llm/hybrid)"
```

---

## Task 11: 主运行引擎（状态机 + 主循环）

**Files:**
- Modify: `userscripts/douyin-auto-reply-userscript.js`

**Step 1: 在 generator 之后插入 engine 模块**

```javascript
// ============================================================
// engine — 主循环 + 暂停状态机
// ============================================================
const STATE = { state: "idle", currentWorkIdx: -1, currentCommentIdx: 0, abortRequested: false, runId: 0, lastError: null };

function getState() { return { ...STATE }; }

function requestPause() {
  if (STATE.state === "running") { STATE.abortRequested = true; appendLog("收到暂停请求，将在当前评论后停止"); }
}

async function runOnce({ trigger = "manual" } = {}) {
  if (STATE.state === "running") {
    appendLog(`[${trigger === "schedule" ? "定时" : "手动"}] 上一轮未结束，跳过本次`);
    return { skipped: true };
  }
  STATE.runId += 1;
  STATE.state = "running";
  STATE.abortRequested = false;
  STATE.lastError = null;
  appendLog(`${trigger === "schedule" ? "[定时] " : ""}第 ${STATE.runId} 轮启动`);

  const cfg = loadConfig();
  if (!cfg.enabled) { STATE.state = "idle"; appendLog("启用开关未打开，停止"); return { aborted: true }; }
  if ((cfg.mode === "template" || cfg.mode === "hybrid") && (!cfg.templates || cfg.templates.length === 0)) {
    STATE.state = "idle"; appendLog("模板列表为空但模式需要模板，停止"); return { aborted: true };
  }

  let totalReplied = 0;
  let consecutiveFailures = 0;

  try {
    for (let i = 0; i < cfg.worksLimit; i++) {
      if (STATE.abortRequested) { appendLog("已暂停"); break; }
      STATE.currentWorkIdx = i;
      try {
        await selectWorkByIndex(i);
      } catch (e) {
        appendLog(`作品 #${i + 1} 选择失败：${e.message}`); continue;
      }
      const items = listWorkItems();
      const workTitle = (items[i]?.textContent || "").trim().slice(0, 60).replace(/\s+/g, " ") || `作品#${i + 1}`;
      appendLog(`作品 ${i + 1}/${cfg.worksLimit}: ${workTitle}`);

      try { await applyUnrepliedFilter(); } catch (e) { appendLog(`  未回复筛选失败：${e.message}`); continue; }

      let commentSeq = 0;
      while (!STATE.abortRequested) {
        // 把循环上限设为 200 防止意外死循环（每作品最多回复 200 条）
        if (commentSeq >= 200) { appendLog(`  达到本作品评论上限 200`); break; }
        const c = extractFirstUnreplied();
        if (!c) { appendLog(`  本作品已无可回复评论`); break; }
        commentSeq += 1;

        const gen = await generateReply({ cfg, workTitle, comment: c });
        if (gen.fatal) {
          appendLog(`  评论 #${commentSeq} LLM ${gen.status} 致命错误，停止整轮`);
          consecutiveFailures = 99;
          break;
        }
        if (!gen.text) {
          appendLog(`  评论 #${commentSeq} user=${c.username} → 跳过(${gen.reason})`);
          consecutiveFailures += 1;
          if (consecutiveFailures >= 3) { appendLog(`  连续 3 次失败，暂停整轮`); break; }
          continue;
        }

        const sanitized = sanitizeReplyMessage(gen.text, cfg.aiSignature);
        if (!sanitized.replyMessage) {
          appendLog(`  评论 #${commentSeq} user=${c.username} → 命中过滤(${sanitized.skipReason})，跳过`);
          continue;
        }

        try {
          appendLog(`  评论 #${commentSeq} user=${c.username} → 发送中... (${gen.via})`);
          await sendReply(c, sanitized.replyMessage, cfg);
          totalReplied += 1;
          consecutiveFailures = 0;
          appendLog(`  评论 #${commentSeq} 已回复 ✓`);
          await sleep(randomBetween(cfg.replyDelayMinMs, cfg.replyDelayMaxMs));
        } catch (e) {
          appendLog(`  评论 #${commentSeq} 发送失败：${e.message}`);
          consecutiveFailures += 1;
          if (consecutiveFailures >= 3) { appendLog(`  连续 3 次失败，暂停整轮`); break; }
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
```

**Step 2: 验证（小号、worksLimit=1，模板模式）**

```javascript
// 在面板还没做，先手工配置：
const cfg = __douyinAR.config.loadConfig();
cfg.enabled = true;
cfg.mode = "template";
cfg.worksLimit = 1;
__douyinAR.config.saveConfig(cfg);

await __douyinAR.engine.runOnce({ trigger: "manual" });
// 应该走完一个作品的所有未回复评论
__douyinAR.utils.logBuffer  // 看完整日志
```

**Step 3: Commit**

```bash
git add userscripts/douyin-auto-reply-userscript.js
git commit -m "feat(userscript): add main engine with pause state machine"
```

---

## Task 12: 定时调度器

**Files:**
- Modify: `userscripts/douyin-auto-reply-userscript.js`

**Step 1: 在 engine 之后插入 scheduler 模块**

```javascript
// ============================================================
// scheduler — setTimeout 递归调度
// ============================================================
const sched = { timer: null, nextFireAt: 0 };

function clearScheduler() { if (sched.timer) { clearTimeout(sched.timer); sched.timer = null; sched.nextFireAt = 0; } }

function scheduleNext(intervalMs) {
  clearScheduler();
  sched.nextFireAt = Date.now() + intervalMs;
  sched.timer = setTimeout(async () => {
    sched.timer = null;
    const cfg = loadConfig();
    if (!cfg.schedule.enabled) return;  // 期间被关闭
    try { await runOnce({ trigger: "schedule" }); } catch (e) { appendLog(`定时轮异常：${e.message}`); }
    // 排下一次（loadConfig 重新读，间隔可能被改）
    const c2 = loadConfig();
    if (c2.schedule.enabled) scheduleNext(c2.schedule.intervalMin * 60_000);
  }, intervalMs);
}

function startScheduler() {
  const cfg = loadConfig();
  if (!cfg.schedule.enabled) return;
  if (cfg.schedule.intervalMin < 5) { appendLog(`定时间隔小于 5 分钟，已忽略`); return; }
  appendLog(`定时已开启，间隔 ${cfg.schedule.intervalMin} 分钟`);
  if (cfg.schedule.runImmediatelyOnStart) {
    runOnce({ trigger: "schedule" }).then(() => scheduleNext(cfg.schedule.intervalMin * 60_000));
  } else {
    scheduleNext(cfg.schedule.intervalMin * 60_000);
  }
}

function stopScheduler() { clearScheduler(); appendLog("定时已停止"); }

function getSchedulerInfo() {
  return { active: !!sched.timer, nextFireAt: sched.nextFireAt, msUntilNext: sched.nextFireAt ? sched.nextFireAt - Date.now() : 0 };
}

// URL 守卫：离开评论管理页时暂停定时器，回来后恢复
function installUrlGuard() {
  const isOnTargetPage = () => /\/creator-micro\/(comment-manage|data-center\/comment)/.test(location.pathname);
  let onTarget = isOnTargetPage();
  const obs = new MutationObserver(() => {
    const now = isOnTargetPage();
    if (now === onTarget) return;
    onTarget = now;
    const cfg = loadConfig();
    if (!cfg.schedule.enabled) return;
    if (now) { appendLog("回到评论管理页，恢复定时"); startScheduler(); }
    else { appendLog("离开评论管理页，暂停定时"); clearScheduler(); }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

ar.scheduler = { startScheduler, stopScheduler, scheduleNext, getSchedulerInfo, installUrlGuard };
```

**Step 2: 在 IIFE 末尾（`console.log("loaded")` 之前）调用启动逻辑**

```javascript
// 启动时根据配置自动恢复定时器
const __cfg = loadConfig();
if (__cfg.schedule.enabled) {
  setTimeout(() => startScheduler(), 2000);  // 等 DOM 稳定
}
installUrlGuard();
```

**Step 3: 验证**

```javascript
// 临时把间隔改 5 分钟开测：
const cfg = __douyinAR.config.loadConfig();
cfg.enabled = true;
cfg.mode = "template";
cfg.worksLimit = 1;
cfg.schedule.enabled = true;
cfg.schedule.intervalMin = 5;
__douyinAR.config.saveConfig(cfg);
__douyinAR.scheduler.startScheduler();
__douyinAR.scheduler.getSchedulerInfo()
// → { active: true, nextFireAt: <未来时间>, msUntilNext: ~300000 }
```

**Step 4: Commit**

```bash
git add userscripts/douyin-auto-reply-userscript.js
git commit -m "feat(userscript): add scheduler with URL guard auto-pause"
```

---

## Task 13: UI 面板骨架（Shadow DOM + 拖拽 + 折叠）

**Files:**
- Modify: `userscripts/douyin-auto-reply-userscript.js`

**Step 1: 在 scheduler 之后插入 ui-shell 模块**

```javascript
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
  .controls { display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid #e1e4e8; background: #fafbfc; }
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
  host.style.position = "fixed"; host.style.zIndex = "2147483647"; host.style.right = "0"; host.style.bottom = "0";
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style"); style.textContent = UI_STYLES; shadow.appendChild(style);
  const root = document.createElement("div"); root.className = "root"; shadow.appendChild(root);
  return { host, shadow, root };
}

let uiState = { collapsed: true, root: null, shadow: null };

function renderFab() {
  uiState.root.innerHTML = `<div class="fab" title="抖音自动回复">🤖</div>`;
  uiState.root.querySelector(".fab").addEventListener("click", () => { uiState.collapsed = false; render(); });
}

// 占位：完整 panel 留到 Task 14 实现
function renderPanel() {
  uiState.root.innerHTML = `
    <div class="panel">
      <header><span class="title">🤖 抖音自动回复</span><span class="actions"><button class="collapse">—</button></span></header>
      <div class="status">状态：待机</div>
      <div class="body"><em>面板内容将在 Task 14 填充</em></div>
    </div>
  `;
  uiState.root.querySelector(".collapse").addEventListener("click", () => { uiState.collapsed = true; render(); });
}

function render() {
  if (uiState.collapsed) renderFab(); else renderPanel();
}

function initUI() {
  const { root, shadow } = createPanelHost();
  uiState.root = root;
  uiState.shadow = shadow;
  render();
}

ar.ui = { initUI, render, get state() { return uiState; } };
```

**Step 2: 在 IIFE 启动逻辑里调用 `initUI()`**

```javascript
// 在 installUrlGuard() 之后：
initUI();
```

**Step 3: 验证**

刷新页面，应看到右下角 🤖 圆按钮；点击展开为面板，再点 — 折叠。

**Step 4: Commit**

```bash
git add userscripts/douyin-auto-reply-userscript.js
git commit -m "feat(userscript): add Shadow DOM panel shell with collapse toggle"
```

---

## Task 14: UI 面板内容（基础设置 / 定时 / 模板 / LLM / 高级）

**Files:**
- Modify: `userscripts/douyin-auto-reply-userscript.js`

**Step 1: 替换 Task 13 里的 `renderPanel`**

```javascript
function renderPanel() {
  const cfg = loadConfig();
  const st = getState();
  const sInfo = getSchedulerInfo();
  const nextStr = sInfo.active && sInfo.nextFireAt
    ? new Date(sInfo.nextFireAt).toLocaleTimeString() + `（剩 ${Math.max(0, Math.round(sInfo.msUntilNext / 60000))} 分钟）`
    : "未定时";

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
            <div class="row"><label>作品数 N</label><input type="number" id="worksLimit" min="1" max="50" value="${cfg.worksLimit}"></div>
          </div>
        </details>

        <details class="section">
          <summary>定时扫描</summary>
          <div class="content">
            <div class="row"><label>开启</label><input type="checkbox" id="schedEnabled" ${cfg.schedule.enabled ? "checked" : ""}></div>
            <div class="row"><label>间隔(分钟)</label><input type="number" id="schedInterval" min="5" value="${cfg.schedule.intervalMin}"></div>
            <div class="row"><label>立即先跑</label><input type="checkbox" id="schedImmediate" ${cfg.schedule.runImmediatelyOnStart ? "checked" : ""}></div>
            <div class="row"><label>下次运行</label><span style="font-size:12px;color:#57606a">${nextStr}</span></div>
          </div>
        </details>

        <details class="section">
          <summary>自定义模板（每行一条）</summary>
          <div class="content"><textarea id="templates">${(cfg.templates || []).join("\n")}</textarea></div>
        </details>

        <details class="section">
          <summary>LLM 配置</summary>
          <div class="content">
            <div class="row"><label>baseURL</label><input type="text" id="llmBase" value="${cfg.llm.baseURL}"></div>
            <div class="row"><label>apiKey</label><input type="password" id="llmKey" value="${cfg.llm.apiKey}"></div>
            <div class="row"><label>model</label><input type="text" id="llmModel" value="${cfg.llm.model}"></div>
            <div class="row"><label>temperature</label><input type="number" step="0.1" id="llmTemp" value="${cfg.llm.temperature}"></div>
            <div class="row"><label>maxTokens</label><input type="number" id="llmMax" value="${cfg.llm.maxTokens}"></div>
            <div class="row"><label>AI 签名</label><input type="text" id="aiSig" value="${cfg.aiSignature}"></div>
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
          <div class="content"><div class="log" id="logBox">${logBuffer.map(l => l.replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c])).join("\n")}</div></div>
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
}

function bindPanelEvents() {
  const $ = (sel) => uiState.root.querySelector(sel);
  $(".collapse").addEventListener("click", () => { uiState.collapsed = true; render(); });
  $("#btnStart").addEventListener("click", () => runOnce({ trigger: "manual" }).then(() => render()));
  $("#btnPause").addEventListener("click", () => requestPause());
  $("#btnSave").addEventListener("click", saveFromUI);
  $("#btnCopyLog").addEventListener("click", () => navigator.clipboard.writeText(logBuffer.join("\n")));
  $("#btnClearLog").addEventListener("click", () => { clearLog(); render(); });
}

function saveFromUI() {
  const $ = (sel) => uiState.root.querySelector(sel);
  const cfg = loadConfig();
  cfg.enabled = $("#enabled").checked;
  cfg.mode = $("#mode").value;
  cfg.worksLimit = Math.max(1, parseInt($("#worksLimit").value, 10) || 1);
  cfg.schedule.enabled = $("#schedEnabled").checked;
  const interval = parseInt($("#schedInterval").value, 10) || 30;
  if (interval < 5) { alert("定时间隔不能小于 5 分钟"); return; }
  cfg.schedule.intervalMin = interval;
  cfg.schedule.runImmediatelyOnStart = $("#schedImmediate").checked;
  cfg.templates = $("#templates").value.split("\n").map(s => s.trim()).filter(Boolean);
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
  if (cfg.schedule.enabled) startScheduler(); else stopScheduler();
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
```

**Step 2: 验证**

刷新页面，展开面板：
- 所有控件能编辑
- 改一些值 → 点"💾 保存" → 看到日志"配置已保存"
- 刷新页面 → 重新打开面板，值还在
- 点"▶ 开始" → 引擎跑起来；点"⏸ 暂停" → 当前评论后停下

**Step 3: Commit**

```bash
git add userscripts/douyin-auto-reply-userscript.js
git commit -m "feat(userscript): wire UI panel with full config controls"
```

---

## Task 15: 集成测试 + 错误恢复打磨

**Files:**
- Modify: `userscripts/douyin-auto-reply-userscript.js`（按测试中发现的问题改 SELECTORS / 时序参数）

**Step 1: 三种模式各跑一轮（小号、worksLimit=1、≤5 条评论）**

| 模式 | 步骤 | 预期 |
|------|------|------|
| template | 配 3 条模板 → 启用 → 开始 | 每条评论被随机模板回复，全部走完 |
| llm | 配真实 apiKey → 启用 → 开始 | 每条评论被 LLM 个性化回复 |
| hybrid + 错 apiKey | apiKey 改成 sk-bogus → 开始 | 期望：401 时 fatal=true，整轮停止；非 401 时回退模板 |

**Step 2: 故障注入测试**

1. **DOM 失效**：打开 DevTools → 临时把 `SELECTORS.unrepliedTabText` 改成 `"不存在的tab"` → 开始 → 应看到错误日志、连续失败 3 次后暂停整轮，**不卡死**
2. **过滤命中**：把模板里加一条"加我微信" → 开始 → 应看到日志"命中过滤(blocked_content)，跳过"，不实际发送
3. **暂停响应**：开始一轮后立即点暂停 → 当前评论处理完后停下，状态变"待机"

**Step 3: 定时器测试**

1. 设间隔 5 分钟 → 启用定时 → 等触发 → 看日志 "[定时] 第 N 轮启动"
2. 跳到其他页面（如个人中心）→ 应看到"离开评论管理页，暂停定时"
3. 回到评论管理页 → "回到评论管理页，恢复定时"
4. 关闭浏览器标签 → 重开页面 → 定时器应自动恢复（schedule.enabled 持久化）

**Step 4: 把测试中发现的所有调整 commit 进来**

```bash
git add userscripts/douyin-auto-reply-userscript.js
git commit -m "fix(userscript): adjust selectors and timing per integration testing"
```

---

## Task 16: README + 迁移 work-flow.md 安装说明

**Files:**
- Create: `userscripts/README.md`
- Modify: `work-flow.md`（让油猴章节链接到 `userscripts/README.md`，避免双源维护）

**Step 1: 写 `userscripts/README.md`**

内容包括：
- 安装步骤（Tampermonkey + 复制脚本）
- 验证安装（刷新创作者中心评论页应看到 🤖）
- 三种模式说明
- 定时扫描使用方法
- 安全提醒：先用小号、保持页面常驻、API Key 仅本地、抖音改版风险
- 故障排查（看不到面板 / 不回复 / LLM 失败 / 选择器失效）

**Step 2: 在 `work-flow.md` 把详细安装段落替换为短摘要 + "完整说明见 [userscripts/README.md](./userscripts/README.md)"**

具体保留 4-5 行核心步骤，详细 FAQ 全部移到 README，避免双份维护。

**Step 3: Commit**

```bash
git add userscripts/README.md work-flow.md
git commit -m "docs: add userscripts README and link from work-flow.md"
```

---

## Task 17: 推送分支

**Step 1: 推送当前分支**

```bash
git push -u origin refactor/cleanup-and-dry
```

**Step 2: 列出本次新增/修改的文件**

```
新增:
  userscripts/douyin-auto-reply-userscript.js  (~1000 行)
  userscripts/README.md
  docs/plans/2026-05-08-douyin-userscript-design.md (已在前面 commit)
修改:
  work-flow.md  (压缩详细安装说明)
```

**Step 3: 由用户决定是否开 PR**

不在计划里自动开 PR；让用户审过后再决定。

---

## 风险与已知坑

1. **抖音 DOM 改版**：所有选择器集中在 `SELECTORS` 常量；改版时定位 DevTools → 改一处即可。**这是该方案最大的脆弱点**。
2. **React 受控组件**：输入框 `execCommand("insertText")` 在抖音特定版本可能被吞，已用逐字 `textContent` + InputEvent 兜底；若新版本完全锁住 textContent，可能需要换成模拟剪贴板粘贴。
3. **风控**：默认延迟 3~8 秒/条 + 仿人打字。**别擅自把延迟调低**。
4. **定时跨标签**：脚本依赖页面常驻；切到后台标签时 `setTimeout` 仍会触发但浏览器节流可能让间隔比配置略长，不准时但不丢轮次。
5. **localStorage vs GM_setValue**：`apiKey` 用 GM_setValue（Tampermonkey 沙箱），不出现在页面 localStorage，比直接 localStorage 略安全；但仍是明文存储，**重要 key 用专属低限额 key**。
