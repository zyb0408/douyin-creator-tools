# JS 模块依赖关系图

> 基于 `refactor/cleanup-and-dry` 分支，反映重构后的模块结构。

---

## 一、run-all.sh 全流程依赖链

```
run-all.sh
│
├─ [1/4] npm run works ──→ src/list-douyin-works.mjs
│                              ├── src/cli-options.mjs
│                              │     ├── src/douyin-browser.mjs
│                              │     └── src/lib/common.mjs
│                              ├── src/comment-workflow.mjs
│                              │     ├── src/douyin-browser.mjs
│                              │     ├── src/lib/common.mjs
│                              │     ├── src/lib/comment-page.mjs
│                              │     │     ├── src/douyin-browser.mjs
│                              │     │     └── src/lib/common.mjs
│                              │     ├── src/lib/comment-ops.mjs
│                              │     │     ├── src/lib/common.mjs
│                              │     │     └── src/lib/comment-snapshot.mjs
│                              │     ├── src/lib/constants.mjs
│                              │     ├── src/lib/image-downloader.mjs
│                              │     ├── src/lib/reply-flow.mjs
│                              │     │     ├── src/lib/common.mjs
│                              │     │     ├── src/lib/comment-ops.mjs
│                              │     │     │     ├── src/lib/common.mjs
│                              │     │     │     └── src/lib/comment-snapshot.mjs
│                              │     │     └── src/lib/comment-snapshot.mjs
│                              │     ├── src/lib/result-store.mjs
│                              │     │     └── src/lib/common.mjs
│                              │     ├── src/lib/works-panel.mjs
│                              │     │     └── src/lib/common.mjs
│                              │     └── src/lib/db-ops.mjs
│                              │           └── src/lib/db.mjs
│                              └── src/lib/common.mjs
│
├─ [2/4] npm run comments:export ──→ src/export-douyin-comments.mjs
│                                      ├── src/cli-options.mjs
│                                      │     ├── src/douyin-browser.mjs
│                                      │     └── src/lib/common.mjs
│                                      ├── src/comment-workflow.mjs
│                                      │     └── (同上，见 [1/4])
│                                      └── src/lib/common.mjs
│
├─ [3/4] npm run comments:generate-reply ──→ src/lib/llm-reply-generator.mjs
│                                              ├── src/lib/result-store.mjs
│                                              │     └── src/lib/common.mjs
│                                              └── src/lib/common.mjs
│
└─ [4/4] npm run comments:reply-all ──→ src/reply-all-works.mjs
                                          └── (仅 Node.js 内置模块，无项目内依赖)
                                          │
                                          └─ spawn ──→ src/reply-douyin-comments.mjs
                                                         ├── src/cli-options.mjs
                                                         │     ├── src/douyin-browser.mjs
                                                         │     └── src/lib/common.mjs
                                                         ├── src/comment-workflow.mjs
                                                         │     └── (同上，见 [1/4])
                                                         └── src/lib/common.mjs
```

---

## 二、各入口脚本的依赖关系

### 1. `npm run auth` → `src/auth-douyin.mjs`

```
src/auth-douyin.mjs
├── src/douyin-browser.mjs          (浏览器启动/导航)
└── src/lib/common.mjs              (toPositiveInteger)
```

### 2. `npm run view` → `src/open-douyin-view.mjs`

```
src/open-douyin-view.mjs
├── src/douyin-browser.mjs          (浏览器启动/导航)
└── src/lib/common.mjs              (toPositiveInteger)
```

### 3. `npm run works` → `src/list-douyin-works.mjs`

```
src/list-douyin-works.mjs
├── src/cli-options.mjs
│   ├── src/douyin-browser.mjs
│   └── src/lib/common.mjs
├── src/comment-workflow.mjs        (listWorks)
│   ├── src/douyin-browser.mjs
│   ├── src/lib/common.mjs
│   ├── src/lib/comment-page.mjs
│   │   ├── src/douyin-browser.mjs
│   │   └── src/lib/common.mjs
│   ├── src/lib/comment-ops.mjs
│   │   ├── src/lib/common.mjs
│   │   └── src/lib/comment-snapshot.mjs
│   ├── src/lib/constants.mjs
│   ├── src/lib/image-downloader.mjs
│   ├── src/lib/reply-flow.mjs
│   │   ├── src/lib/common.mjs
│   │   ├── src/lib/comment-ops.mjs
│   │   └── src/lib/comment-snapshot.mjs
│   ├── src/lib/result-store.mjs
│   │   └── src/lib/common.mjs
│   ├── src/lib/works-panel.mjs
│   │   └── src/lib/common.mjs
│   └── src/lib/db-ops.mjs
│       └── src/lib/db.mjs
└── src/lib/common.mjs
```

### 4. `npm run comments:export` → `src/export-douyin-comments.mjs`

```
src/export-douyin-comments.mjs
├── src/cli-options.mjs
│   ├── src/douyin-browser.mjs
│   └── src/lib/common.mjs
├── src/comment-workflow.mjs        (exportUnrepliedComments)
│   └── (同上)
└── src/lib/common.mjs
```

### 5. `npm run comments:export-all` → `src/export-all-douyin-comments.mjs`

```
src/export-all-douyin-comments.mjs
├── src/cli-options.mjs
│   ├── src/douyin-browser.mjs
│   └── src/lib/common.mjs
├── src/comment-workflow.mjs        (exportAllComments)
│   └── (同上)
└── src/lib/common.mjs
```

### 6. `npm run comments:generate-reply` → `src/lib/llm-reply-generator.mjs`

```
src/lib/llm-reply-generator.mjs
├── src/lib/result-store.mjs
│   └── src/lib/common.mjs
└── src/lib/common.mjs              (normalizeText, MAX_REPLY_MESSAGE_CHARS, truncateReplyMessage)
```

### 7. `npm run comments:reply` → `src/reply-douyin-comments.mjs`

```
src/reply-douyin-comments.mjs
├── src/cli-options.mjs
│   ├── src/douyin-browser.mjs
│   └── src/lib/common.mjs
├── src/comment-workflow.mjs        (replyComments)
│   └── (同上)
└── src/lib/common.mjs
```

### 8. `npm run comments:reply-all` → `src/reply-all-works.mjs`

```
src/reply-all-works.mjs
└── (仅 Node.js 内置模块: fs, path, child_process)
    │
    └─ spawn ──→ src/reply-douyin-comments.mjs
                   └── (同上 [7])
```

### 9. `npm run run:once` → `src/run-once.mjs`

```
src/run-once.mjs
├── src/comment-workflow.mjs        (exportUnrepliedComments, replyComments)
│   └── (同上)
├── src/lib/config.mjs
│   └── src/lib/common.mjs
└── src/lib/llm-reply-generator.mjs
    ├── src/lib/result-store.mjs
    │   └── src/lib/common.mjs
    └── src/lib/common.mjs
```

### 10. `npm run run:scheduler` → `src/run-scheduler.mjs`

```
src/run-scheduler.mjs
├── src/lib/config.mjs
│   └── src/lib/common.mjs
└── src/run-once.mjs
    ├── src/comment-workflow.mjs
    │   └── (同上)
    ├── src/lib/config.mjs
    │   └── src/lib/common.mjs
    └── src/lib/llm-reply-generator.mjs
        ├── src/lib/result-store.mjs
        │   └── src/lib/common.mjs
        └── src/lib/common.mjs
```

### 11. `npm run users` → `src/users.mjs`

```
src/users.mjs
├── src/lib/db.mjs                  (getDb, closeDb)
└── src/lib/top-commenters.mjs
    └── src/lib/common.mjs
```

### 12. `npm run article:publish` → `src/publish-douyin-article.mjs`

```
src/publish-douyin-article.mjs
├── src/douyin-browser.mjs          (浏览器启动/导航)
├── src/cli-options.mjs
│   ├── src/douyin-browser.mjs
│   └── src/lib/common.mjs
└── src/lib/publish-utils.mjs
    └── src/lib/common.mjs          (repairJsonFieldQuotes)
```

### 13. `npm run imagetext:publish` → `src/publish-douyin-imagetext.mjs`

```
src/publish-douyin-imagetext.mjs
├── src/douyin-browser.mjs          (浏览器启动/导航)
├── src/cli-options.mjs
│   ├── src/douyin-browser.mjs
│   └── src/lib/common.mjs
└── src/lib/publish-utils.mjs
    └── src/lib/common.mjs          (repairJsonFieldQuotes)
```

### 14. `npm run server` → `src/server.mjs`

```
src/server.mjs
├── src/lib/db.mjs                  (getDb)
└── src/lib/openclaw-thinking-feed.mjs
    └── (仅 Node.js 内置模块: fs, readline, path, os)
```

### 15. `npm run wordcloud` → `src/compute-wordcloud.mjs`

```
src/compute-wordcloud.mjs
└── src/lib/db.mjs                  (getDb, closeDb)
```

### 16. `npm run txt2img` → `src/txt2img.mjs`

```
src/txt2img.mjs
└── (仅 Node.js 内置模块: crypto, fs, path, process)
```

### 17. `scripts/export-all-unreplied.mjs`

```
scripts/export-all-unreplied.mjs
└── (仅 Node.js 内置模块: fs, path, child_process)
    │
    └─ execFile ──→ src/export-douyin-comments.mjs
                      └── (同上 [4])
```

### 18. `src/import-existing-comments.mjs`

```
src/import-existing-comments.mjs
├── src/lib/db-ops.mjs
│   └── src/lib/db.mjs
└── src/lib/db.mjs                  (closeDb)
```

---

## 三、lib/ 基础模块内部依赖

```
src/lib/common.mjs                  (无项目内依赖，纯工具函数)
src/lib/db.mjs                      (无项目内依赖，仅 better-sqlite3)
src/lib/constants.mjs               (无项目内依赖，纯常量)
src/lib/image-downloader.mjs        (无项目内依赖，仅 Node.js 内置模块)
src/lib/comment-snapshot.mjs        (无项目内依赖)
src/lib/openclaw-thinking-feed.mjs  (无项目内依赖)
│
src/lib/config.mjs
└── src/lib/common.mjs
│
src/lib/db-ops.mjs
└── src/lib/db.mjs
│
src/lib/top-commenters.mjs
└── src/lib/common.mjs
│
src/lib/publish-utils.mjs
└── src/lib/common.mjs
│
src/lib/result-store.mjs
└── src/lib/common.mjs
│
src/lib/comment-page.mjs
├── src/douyin-browser.mjs
└── src/lib/common.mjs
│
src/lib/comment-ops.mjs
├── src/lib/common.mjs
└── src/lib/comment-snapshot.mjs
│
src/lib/works-panel.mjs
└── src/lib/common.mjs
│
src/lib/reply-flow.mjs
├── src/lib/common.mjs
├── src/lib/comment-ops.mjs
│   ├── src/lib/common.mjs
│   └── src/lib/comment-snapshot.mjs
└── src/lib/comment-snapshot.mjs
│
src/lib/llm-reply-generator.mjs
├── src/lib/result-store.mjs
│   └── src/lib/common.mjs
└── src/lib/common.mjs
```

---

## 四、模块热度排行（被依赖次数）

| 模块 | 被依赖次数 | 说明 |
|------|-----------|------|
| `src/lib/common.mjs` | **16** | 通用工具函数，被几乎所有模块依赖 |
| `src/douyin-browser.mjs` | **8** | 浏览器启动/导航基础封装 |
| `src/comment-workflow.mjs` | **5** | 核心业务编排层 |
| `src/cli-options.mjs` | **5** | CLI 参数共享工具 |
| `src/lib/db.mjs` | **4** | SQLite 数据库单例 |
| `src/lib/comment-snapshot.mjs` | **3** | 浏览器端评论快照提取 |
| `src/lib/result-store.mjs` | **2** | 结果输出管理 |
| `src/lib/config.mjs` | **2** | 配置加载与验证 |
| `src/lib/comment-ops.mjs` | **2** | 评论 DOM 操作 |
| `src/lib/db-ops.mjs` | **2** | 数据库 CRUD |
| `src/lib/constants.mjs` | **1** | 超时/限制常量 |
| `src/lib/image-downloader.mjs` | **1** | 图片下载 |
| `src/lib/publish-utils.mjs` | **2** | 发布脚本共享工具 |
| `src/lib/reply-flow.mjs` | **1** | 回复执行引擎 |
| `src/lib/works-panel.mjs` | **1** | 作品面板 DOM 操作 |
| `src/lib/top-commenters.mjs` | **1** | 用户排行查询 |
| `src/lib/comment-page.mjs` | **1** | 评论页面导航 |
| `src/lib/openclaw-thinking-feed.mjs` | **1** | OpenClaw 集成 |
| `src/lib/llm-reply-generator.mjs` | **1** | LLM 回复生成 |
