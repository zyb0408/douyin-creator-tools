# 自动化全流程执行逻辑详解

> 对应 `run-all.sh` 的 4 个步骤 + 清空数据库，逐一拆解每个步骤的内部执行逻辑。

---

## 全流程总览

```
run-all.sh
│
├─ [1/4] npm run works -- --limit 8
│         获取作品列表 → 输出 list-works.json
│
├─ [2/4] npm run comments:export
│         导出未回复评论 → 输出 unreplied-comments-*.json
│
├─ [3/4] npm run comments:generate-reply
│         LLM 生成回复 → 输出 generated-reply-plan.json
│
├─ [4/4] npm run comments:reply-all
│         自动回复评论 → 清理中间文件
│
└─ [可选] npm run db:clear
          清空数据库
```

---

## 步骤 1：获取作品列表

**命令**：`npm run works -- --limit 8`
**入口**：`src/list-douyin-works.mjs`
**核心函数**：`comment-workflow.mjs` → `listWorks()`
**输出**：`comments-output/list-works.json`

### 执行流程

```
list-douyin-works.mjs
│
├─ ① parseArgs() 解析命令行参数
│     --limit 8（最多保留 8 个作品）
│     --out, --profile, --timeout, --headless, --debug
│
└─ ② listWorks(args)  ← comment-workflow.mjs
    │
    ├─ ③ openCommentSession(options)
    │     ├─ launchPersistentPage()
    │     │     启动 Chromium，复用 .playwright/douyin-profile 登录态
    │     │     设置 headless / viewport 等选项
    │     │
    │     └─ ensureCommentPageReady(page, url)
    │           导航到抖音创作者评论管理页
    │           等待页面关键元素加载完成
    │           如果未登录 → 提示用户扫码
    │
    ├─ ④ fetchAllWorksWithRetry(page)
    │     ├─ 点击「选择作品」按钮打开作品侧边栏
    │     ├─ 等待作品列表加载（带重试，最多 3 次）
    │     ├─ 滚动加载所有作品（循环滚动直到无新作品出现）
    │     ├─ 从 DOM 中提取每个作品的：
    │     │     · 标题 (title)
    │     │     · 发布文本 (publishText)
    │     │     · 封面图 URL (coverUrl)
    │     │     · 数据指标 (stats: 播放/评论/点赞)
    │     └─ 返回作品数组
    │
    ├─ ⑤ 按 --limit 截取前 N 个作品
    │     limitedWorks = works.slice(0, 8)
    │
    ├─ ⑥ emitResult() 写入 JSON
    │     输出文件：comments-output/list-works.json
    │     格式：{ pageUrl, count, works: [{ title, publishText, coverUrl, stats }] }
    │
    └─ ⑦ context.close() 关闭浏览器
```

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/list-douyin-works.mjs` | CLI 入口，参数解析 |
| `src/comment-workflow.mjs` → `listWorks()` | 编排：启动浏览器 → 获取作品 → 写文件 |
| `src/lib/works-panel.mjs` → `fetchAllWorksWithRetry()` | DOM 操作：打开侧边栏、滚动加载、提取作品 |
| `src/douyin-browser.mjs` → `launchPersistentPage()` | 浏览器启动/登录态管理 |
| `src/lib/comment-page.mjs` → `ensureCommentPageReady()` | 页面就绪检测 |

---

## 步骤 2：导出未回复评论

**命令**：`npm run comments:export`
**入口**：`src/export-douyin-comments.mjs`
**核心函数**：`comment-workflow.mjs` → `exportCommentsInternal()` → `exportUnrepliedComments()`
**输出**：`comments-output/unreplied-comments-{作品标题}.json`（每个作品一个文件）

### 执行流程

```
export-douyin-comments.mjs
│
├─ ① parseArgs() 解析命令行参数
│     位置参数："作品短标题"（可选，不传则处理全部作品）
│     --limit 200, --out, --no-history, --headless, --debug
│
├─ ② 判断是否提供了作品标题
│     │
│     ├─ [未提供] 从 list-works.json 读取所有作品
│     │   for (const work of worksData.works) {
│     │     → 逐个调用 exportUnrepliedComments({ workTitle: work.title })
│     │     → 每个作品输出独立文件：unreplied-comments-{safeTitle}.json
│     │   }
│     │
│     └─ [已提供] 只处理指定作品
│         → exportUnrepliedComments({ workTitle })
│         → 输出到 --out 指定路径（默认 unreplied-comments.json）
│
└─ ③ exportUnrepliedComments(options)
    │
    └─ exportCommentsInternal(options, { filterMode: "unreplied", hardRefresh: false })
       │
       ├─ ④ openCommentSession(options)
       │     启动浏览器 + 导航到评论管理页（同步骤 1）
       │
       ├─ ⑤ resolveTargetWork(page, workTitle)
       │     ├─ 点击「选择作品」打开侧边栏
       │     ├─ 在作品列表中搜索匹配目标作品
       │     │     匹配策略：精确匹配 → 发布文本消歧 → 部分匹配
       │     └─ 点击选中该作品，评论区自动加载该作品的评论
       │
       ├─ ⑥ collectComments(page, { limit: 5000 })
       │     ├─ applyUnrepliedCommentsFilter(page)
       │     │     在页面上点击「未回复」筛选按钮
       │     ├─ markCommentScrollContainer(page)
       │     │     标记评论滚动容器 DOM 元素
       │     ├─ resetCommentScrollToTop(page)
       │     │     滚动到评论列表顶部
       │     ├─ 进入滚动采集循环：
       │     │     while (未超时 && 未达到终止条件) {
       │     │       ① extractCommentSnapshot(page)
       │     │          从 DOM 提取当前可见评论：
       │     │          用户名、评论内容、图片 URL、回复缩进等
       │     │       ② 检查终止指示器（"暂无评论" / "没有更多"）
       │     │       ③ 合并新评论到结果集（按 signature 去重）
       │     │       ④ advanceCommentScroll(page)
       │     │          向下滚动加载更多评论
       │     │          三级降级策略：主滚动条 → 内部容器 → 大幅跳跃
       │     │     }
       │     └─ 返回所有采集到的评论数组
       │
       ├─ ⑦ 数据库查询（辅助信息）
       │     ├─ getUserHistoryMap(usernames)
       │     │     查询每个用户的历史评论（最多 3 条）
       │     └─ getReplyCountMap(workTitle, comments)
       │           批量查询每条评论的已回复次数
       │
       ├─ ⑧ 过滤已回复评论
       │     exportComments = comments.filter(c => reply_count < 1)
       │     跳过数据库中 reply_count >= 1 的评论
       │
       ├─ ⑨ downloadCommentImages(exportComments, outputPath)
       │     下载评论中的图片到 comments-output/comment-images/
       │     文件名：SHA256(图片URL) + 原始扩展名
       │
       ├─ ⑩ emitResult() 写入 JSON
       │     未回复模式：无评论时不创建文件，直接返回
       │     格式：{
       │       selectedWork: { title, publishText },
       │       count: N,
       │       comments: [{
       │         username, commentText, replyMessage: "",
       │         imagePaths?, history? (最近 3 条历史评论)
       │       }]
       │     }
       │
       ├─ ⑪ upsertComments() 写入数据库
       │     将所有评论（含已回复的）写入 SQLite
       │     用于后续去重和回复计数
       │
       └─ ⑫ context.close() 关闭浏览器
```

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/export-douyin-comments.mjs` | CLI 入口，支持单作品/全作品模式 |
| `src/comment-workflow.mjs` → `exportCommentsInternal()` | 编排：选作品 → 采集 → 过滤 → 写文件 |
| `src/lib/comment-ops.mjs` → `collectComments()` | 核心采集循环：滚动 + DOM 提取 + 去重 |
| `src/lib/comment-snapshot.mjs` → `extractCommentSnapshot()` | 浏览器端 DOM 快照提取 |
| `src/lib/works-panel.mjs` → `findTargetWorkWithRetry()` | 作品搜索匹配 |
| `src/lib/image-downloader.mjs` → `downloadCommentImages()` | 评论图片下载 |
| `src/lib/db-ops.mjs` → `getReplyCountMap()` | 批量查询回复次数（去重用） |

---

## 步骤 3：LLM 生成回复

**命令**：`npm run comments:generate-reply`
**入口**：`src/lib/llm-reply-generator.mjs`
**核心函数**：`generateReplyPlan()`
**输出**：`comments-output/generated-reply-plan.json`

### 执行流程

```
llm-reply-generator.mjs
│
├─ ① 读取配置
│     ├─ 读取 config.json
│     ├─ 验证 config.llm 配置段（baseURL, apiKey, model, temperature, maxTokens）
│     ├─ 读取 AI 签名 config.llm.aiSignature（未配置则用默认值）
│     └─ 读取输出路径 config.paths.planFile（默认 generated-reply-plan.json）
│
├─ ② 扫描评论文件
│     扫描 comments-output/ 目录
│     匹配文件名模式：unreplied-comments-*.json
│     如果没有找到 → 报错退出
│
├─ ③ 加载所有评论
│     for (const filePath of commentFiles) {
│       source = loadReplySource(filePath)  // 读取 JSON
│       取 selectedWork（仅第一个文件的）
│       将 source.comments 合并到 allComments[]
│       如果评论已有 replyMessage → 跳过（不重复生成）
│     }
│
├─ ④ 逐条生成回复
│     for (const comment of allComments) {
│       if (comment.replyMessage) continue;  // 跳过已有回复的
│       │
│       ├─ ④-a buildPrompt({ selectedWork, comment })
│       │     构造 LLM 提示词，包含：
│       │     · 作品标题
│       │     · 用户昵称
│       │     · 评论内容
│       │     · 是否带图
│       │     · 该用户历史评论（最多 3 条）
│       │
│       ├─ ④-b generateSingleReply({ llmConfig, selectedWork, comment })
│       │     调用 LLM API（POST /chat/completions）
│       │     使用原生 fetch，传入 model + messages + temperature + max_tokens
│       │     返回 LLM 生成的原始文本
│       │
│       └─ ④-c sanitizeReplyMessage(text, aiSignature)
│            ├─ 清理：去除 <think> 标签、多余换行和空格
│            ├─ 替换直引号为弯引号
│            ├─ 截断：超过 400 字则截断（保留前 397 字 + "..."）
│            ├─ 过滤：检测引流/联系方式等违规内容
│            │     BLOCKED_PATTERNS: 微信/vx/v信/加我/私信我/联系方式/8位以上数字
│            │     命中 → skipReason = "blocked_content"
│            ├─ 空回复检测 → skipReason = "empty_reply"
│            └─ 追加 AI 签名：【沪上码仔AI自动回复，注意甄别】
│                  如果空间不足 → 截断原文以容纳签名
│     }
│
├─ ⑤ emitResult() 写入 JSON
│     输出文件：comments-output/generated-reply-plan.json
│     格式：{
│       selectedWork: { title, publishText },
│       count: N,
│       comments: [{
│         username, commentText, workTitle, publishText,
│         replyMessage: "生成的回复文本",
│         imagePaths?, history?
│       }]
│     }
│
└─ ⑥ 输出统计
      总评论数 / 已生成回复 / 跳过（无回复） / 生成失败 / 可操作回复数
```

### 内容过滤规则

| 规则 | 正则 | 处理 |
|------|------|------|
| 微信引流 | `/微信/i` | 标记 blocked_content |
| VX 变体 | `/vx/i`, `/v信/i` | 标记 blocked_content |
| 加我/私信 | `/加我/i`, `/私信我/i` | 标记 blocked_content |
| 联系方式 | `/联系方式/i` | 标记 blocked_content |
| 长数字串 | `/\d{8,}/` | 标记 blocked_content |
| 空回复 | 文本为空 | 标记 empty_reply |
| 超长回复 | > 400 字 | 截断 + 标记 truncated |

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/lib/llm-reply-generator.mjs` | 全部逻辑：配置读取、提示词构造、API 调用、内容过滤 |
| `src/lib/result-store.mjs` → `emitResult()` | JSON 文件写入 |
| `src/lib/common.mjs` → `normalizeText()`, `truncateReplyMessage()` | 文本处理工具 |

---

## 步骤 4：自动回复评论

**命令**：`npm run comments:reply-all`
**入口**：`src/reply-all-works.mjs`
**子进程**：`src/reply-douyin-comments.mjs` → `comment-workflow.mjs` → `reply-flow.mjs`
**输出**：`comments-output/reply-comments-result.json`（每个作品一个）
**清理**：完成后删除 `comments-output/` 下所有 `.json` 文件

### 执行流程

```
reply-all-works.mjs（主进程）
│
├─ ① 读取回复计划
│     读取 comments-output/generated-reply-plan.json
│     解析为 { selectedWork, comments: [...] }
│
├─ ② 按作品标题分组
│     for (const comment of plan.comments) {
│       workCommentsMap.set(comment.workTitle, [...])
│     }
│     例：3 个作品 → 3 个分组
│
├─ ③ 逐作品处理（串行）
│     for (const [workTitle, comments] of workCommentsMap) {
│       │
│       ├─ ③-a 创建临时计划文件
│       │     文件名：temp-reply-plan-{safeTitle}.json
│       │     内容：{ selectedWork: { title }, count, comments }
│       │
│       ├─ ③-b spawn 子进程
│       │     spawn("node", ["src/reply-douyin-comments.mjs", tempPlanPath])
│       │     stdio: "inherit"（子进程日志直接输出到终端）
│       │
│       │     ┌─────────────────────────────────────────────┐
│       │     │         子进程内部执行逻辑                    │
│       │     │                                             │
│       │     │  reply-douyin-comments.mjs                  │
│       │     │   ├─ parseArgs() 解析临时文件路径             │
│       │     │   └─ replyComments({ planFile })            │
│       │     │       │                                     │
│       │     │       ├─ ④ loadReplyCommentsFile(planFile)  │
│       │     │       │     读取 JSON → repairJsonFieldQuotes│
│       │     │       │     → 解析为 { selectedWork, plans }│
│       │     │       │                                     │
│       │     │       ├─ ⑤ 数据库去重                       │
│       │     │       │     getReplyCountMap(workTitle, plans)│
│       │     │       │     过滤掉 reply_count >= 1 的评论   │
│       │     │       │                                     │
│       │     │       ├─ ⑥ openCommentSession()             │
│       │     │       │     启动浏览器 + 导航到评论页         │
│       │     │       │                                     │
│       │     │       ├─ ⑦ resolveTargetWork()              │
│       │     │       │     在作品面板中搜索并选中目标作品     │
│       │     │       │                                     │
│       │     │       ├─ ⑧ replyToComments() ← 核心循环     │
│       │     │       │     │                               │
│       │     │       │     ├─ applyUnrepliedCommentsFilter │
│       │     │       │     │     点击页面「未回复」筛选按钮  │
│       │     │       │     │                               │
│       │     │       │     ├─ markCommentScrollContainer   │
│       │     │       │     ├─ resetCommentScrollToTop      │
│       │     │       │     │                               │
│       │     │       │     └─ while (未超时 && 有未处理计划) │
│       │     │       │         │                           │
│       │     │       │         ├─ extractCommentSnapshot   │
│       │     │       │         │     从 DOM 提取当前可见评论 │
│       │     │       │         │                           │
│       │     │       │         ├─ getNextReplyTarget       │
│       │     │       │         │     匹配可见评论 ↔ 回复计划 │
│       │     │       │         │     匹配策略：              │
│       │     │       │         │     · 同用户仅 1 条评论     │
│       │     │       │         │       → 仅按用户名匹配      │
│       │     │       │         │     · 同用户多条评论        │
│       │     │       │         │       → 用户名 + 评论内容   │
│       │     │       │         │         includes 模糊匹配  │
│       │     │       │         │                           │
│       │     │       │         ├─ [找到匹配]                │
│       │     │       │         │   safeReplyToComment()     │
│       │     │       │         │     ├─ 检查评论 DOM 状态    │
│       │     │       │         │     ├─ 如果有折叠回复       │
│       │     │       │         │     │   → 点击展开          │
│       │     │       │         │     ├─ 查找「回复」按钮     │
│       │     │       │         │     │   无按钮 → skip      │
│       │     │       │         │     ├─ 点击「回复」按钮     │
│       │     │       │         │     ├─ 等待输入框出现       │
│       │     │       │         │     ├─ 逐字输入回复文本     │
│       │     │       │         │     │   (每字间隔 50ms)    │
│       │     │       │         │     ├─ waitForReplySendReady│
│       │     │       │         │     │   等待发送按钮可点击   │
│       │     │       │         │     ├─ 点击「发送」按钮     │
│       │     │       │         │     └─ 返回 status: replied │
│       │     │       │         │                           │
│       │     │       │         └─ [未找到匹配]              │
│       │     │       │             aggressivelyAdvanceScroll│
│       │     │       │             ├─ 10 轮激进滚动尝试      │
│       │     │       │             │   逐步加大滚动距离      │
│       │     │       │             ├─ 检查终止指示器         │
│       │     │       │             │   "暂无评论"/"没有更多" │
│       │     │       │             └─ 到底仍未找到 → 退出   │
│       │     │       │                                     │
│       │     │       ├─ ⑨ emitResult() 写入结果 JSON       │
│       │     │       │     reply-comments-result.json      │
│       │     │       │                                     │
│       │     │       ├─ ⑩ upsertComments() 写入数据库       │
│       │     │       │     更新评论的 replyMessage 字段      │
│       │     │       │                                     │
│       │     │       ├─ ⑪ incrementReplyCount()            │
│       │     │       │     对成功回复的评论 reply_count + 1  │
│       │     │       │     防止下次重复回复                  │
│       │     │       │                                     │
│       │     │       └─ ⑫ context.close() 关闭浏览器       │
│       │     │                                             │
│       │     └─────────────────────────────────────────────┘
│       │
│       ├─ ③-c 等待子进程退出
│       │     成功 → totalReplied += comments.length
│       │     失败 → failedWorks.push(workTitle)
│       │
│       └─ ③-d 删除临时计划文件
│     }
│
├─ ④ 输出汇总
│     成功回复 N 条 / 失败作品 M 个
│
└─ ⑤ cleanOutputDirectory()
      删除 comments-output/ 下所有 .json 文件
      仅保留 comment-images/ 目录下的图片
```

### 超时计算

```
replyFlowTimeout = min(
  7200000,                                          // 上限 2 小时
  max(
    1800000,                                        // 下限 30 分钟
    60000 + min(replyLimit, planCount) × 20000     // 60秒缓冲 + 每条20秒
  )
)
```

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/reply-all-works.mjs` | 主进程：读取计划 → 分组 → spawn 子进程 → 清理 |
| `src/reply-douyin-comments.mjs` | 子进程入口：解析参数 → 调用 replyComments() |
| `src/comment-workflow.mjs` → `replyComments()` | 编排：加载计划 → 去重 → 启动浏览器 → 回复 → 写库 |
| `src/lib/reply-flow.mjs` → `replyToComments()` | 核心回复循环：匹配 → 输入 → 发送 → 滚动 |
| `src/lib/comment-ops.mjs` → `collectComments()` 等 | 评论 DOM 操作（筛选、滚动、采集） |
| `src/lib/comment-snapshot.mjs` → `extractCommentSnapshot()` | 浏览器端评论快照提取 |
| `src/lib/result-store.mjs` → `loadReplyCommentsFile()` | 计划文件加载 + JSON 修复 |
| `src/lib/db-ops.mjs` → `incrementReplyCount()` | 回复计数递增 |

---

## 可选步骤：清空数据库

**命令**：`npm run db:clear`
**入口**：`src/clear-database.mjs`
**核心函数**：`db-ops.mjs` → `clearAllComments()`

### 执行流程

```
clear-database.mjs
│
├─ ① 解析参数
│     --force  → 跳过确认提示
│     --help   → 显示帮助信息
│
├─ ② 确认提示（--force 时跳过）
│     "⚠️ 即将清空数据库中所有评论数据，此操作不可逆！"
│     "确认清空？请输入 y 继续："
│     输入非 y/yes → 取消操作
│
├─ ③ clearAllComments()
│     ├─ SELECT COUNT(*) FROM comments  → 记录当前行数
│     ├─ DELETE FROM comments            → 清空所有数据
│     └─ DELETE FROM sqlite_sequence     → 重置自增 ID
│
└─ ④ 输出结果
      "✅ 已清空数据库，共删除 N 条评论记录。"
      closeDb() 关闭数据库连接
```

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/clear-database.mjs` | CLI 入口：确认提示 + 调用清空函数 |
| `src/lib/db-ops.mjs` → `clearAllComments()` | 执行 DELETE + 重置自增 ID |
| `src/lib/db.mjs` → `closeDb()` | 关闭数据库连接 |
