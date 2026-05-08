# 抖音创作者自动回复 — Chrome 扩展

油猴脚本被抖音 CSP 拦截无法注入，因此提供 Chrome 扩展版本。**功能完全一致**：在创作者中心评论管理页自动回复评论，支持 LLM 个性化生成、自定义模板、混合模式与定时扫描。

> 与 [油猴版](../userscripts/) 共享 70% 核心代码（sanitize / DOM / works / collect / send / llm / engine 模块完全相同）；差别只在配置存储（`chrome.storage.local` 替代 `GM_setValue`）和注入方式。

---

## 安装（开发者模式加载）

### 第 1 步：打开 Chrome / Edge 的扩展程序页

| 浏览器 | 地址栏输入 |
|--------|-----------|
| Chrome | `chrome://extensions/` |
| Edge | `edge://extensions/` |

### 第 2 步：打开右上角「开发者模式」开关

### 第 3 步：点「加载已解压的扩展程序」

选择本目录 `chrome-extension/`（**不是父目录、不是子文件**，就是这个文件夹本身）。

### 第 4 步：验证安装

- 扩展卡片应该出现「抖音创作者自动回复助手 0.1.0」
- 状态：已启用
- ID 是一段随机字符串（每台机器不同）

### 第 5 步：在抖音页面验证脚本注入

1. 打开 `https://creator.douyin.com/creator-micro/interactive/comment`
2. 登录后查看页面右下角，应看到一个蓝色 🤖 圆形悬浮按钮
3. 点击 🤖 → 配置面板弹出 → 安装成功

如果看不到按钮：F12 → Console，搜 `[抖音自动回复]`：能看到 `loaded v0.1.0` 说明注入成功，可能是 CSS 冲突；找不到说明 content script 没匹配上当前 URL，检查 `manifest.json` 的 `matches`。

---

## 使用

界面、模式、定时器、过滤规则全部与油猴版一致，**完整说明见 [`../userscripts/README.md`](../userscripts/README.md)** 的「使用」「故障排查」章节。

简要：

- 模式三选：纯模板 / 纯 LLM / 混合（推荐）
- 定时扫描：≥ 5 分钟，跑完一轮再排下一次
- 自动追加 AI 签名，内置违规内容过滤
- 默认延迟 3~8 秒/条 + 仿人打字 30~80ms/字

---

## 与油猴版的差别

| 维度 | 油猴版 | Chrome 扩展版 |
|------|--------|--------------|
| 抖音 CSP | ❌ 被拦截 | ✅ 不受影响（扩展特权） |
| 安装 | 装 Tampermonkey 后粘代码 | 开发者模式加载文件夹 |
| 配置存储 | `GM_setValue` | `chrome.storage.local` |
| 配置同步多台机器 | ❌ | ✅（如果登录 Chrome 账号且开启同步可考虑改用 `chrome.storage.sync`） |
| 跨浏览器移植 | ✅（火狐 etc） | ❌ Chrome / Edge 限定 |
| 文件结构 | 单文件 | 多文件目录 |

**故障与维护与油猴版一致**：抖音 DOM 改版后所有 `SELECTORS` 集中在 `content.js` 顶部，单点修改。

---

## 文件结构

```
chrome-extension/
├── manifest.json    # MV3 清单
├── content.js       # 注入脚本（≈ 1190 行，与 userscript 主体几乎完全一致）
└── README.md        # 本文档
```

无 background service worker、无 popup —— 一切都在 content script 里跑，简单直接。

---

## 扩展更新

修改 `content.js` 后：

1. 回到 `chrome://extensions/`
2. 找到「抖音创作者自动回复助手」
3. 点卡片右下角的「🔄 重新加载」按钮
4. 刷新抖音评论页

---

## 安全提醒

- API Key 存在 `chrome.storage.local`，仅本机本浏览器可见
- 给本扩展配额度受限的 key
- 别擅自调低延迟（默认 3~8 秒/条）抖音风控会限流
- 内置内容过滤：含微信/vx/v信/加我/私信我/联系方式/8 位以上数字 → 自动跳过
- 回复末尾自动追加 AI 签名（可在面板修改）便于事后辨识

---

## 打包成 .crx 分发（可选）

如果要给同事分发，不想每人都用「开发者模式 + 加载文件夹」：

1. `chrome://extensions/` → 「打包扩展程序」
2. 「扩展程序根目录」选本目录
3. 第一次会生成 `.crx` 和 `.pem`（**`.pem` 务必保存**，下次更新需要它）
4. 把 `.crx` 文件发给同事

但 Chrome 现在对未上架商店的 `.crx` 有越来越严的限制；**最稳妥还是让同事手动加载文件夹**。
