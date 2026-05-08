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

  console.log(`${TAG} loaded v${VERSION}`);
})();
