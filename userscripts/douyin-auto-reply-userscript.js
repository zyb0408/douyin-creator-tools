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
