# 其他功能说明

> 除 `run-all.sh` 全流程（获取作品 → 导出评论 → 生成回复 → 自动回复）之外，项目还提供以下功能。

---

## 功能总览

| 功能 | 命令 | 说明 |
|------|------|------|
| 登录认证 | `npm run auth` | 扫码登录，保存浏览器登录态 |
| 手动查看 | `npm run view` | 打开创作者页面供手动操作 |
| 导出全部评论 | `npm run comments:export-all` | 导出指定作品的全部评论（含已回复） |
| 单次执行 | `npm run run:once` | 基于 config.json 执行完整流程 |
| 定时调度 | `npm run run:scheduler` | 按 cron 表达式周期性自动执行 |
| 用户排行 | `npm run users` | 查看评论最多的用户 / 按用户名搜索 |
| 数据看板 | `npm run server` | Web 界面查看评论数据和词云 |
| 词云计算 | `npm run wordcloud` | 从数据库生成词频数据 |
| 图文发布 | `npm run imagetext:publish` | 自动化发布图文作品 |
| 文章发布 | `npm run article:publish` | 自动化发布文章 |
| 文生图 | `npm run txt2img` | 调用即梦 API 生成图片 |
| 导入历史评论 | `node src/import-existing-comments.mjs` | 批量导入已有导出文件到数据库 |
| 清空数据库 | `npm run db:clear` | 清空评论数据并重置自增 ID |

---

## 1. 登录认证

**命令**：`npm run auth`
**入口**：`src/auth-douyin.mjs`

### 使用方法

```bash
npm run auth
npm run auth -- --url "https://creator.douyin.com/..."   # 自定义登录页
npm run auth -- --viewport 1440x900                       # 指定浏览器窗口大小
```

### 选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--url <url>` | 登录页 URL | 创作者评论页 |
| `--profile <path>` | Playwright profile 存储路径 | `.playwright/douyin-profile` |
| `--timeout <ms>` | 页面导航最大等待时间 | 60000 |
| `--viewport <WxH>` | 浏览器视口大小 | 自适应屏幕 |

### 业务流程

```
npm run auth
│
├─ ① 启动 Chromium 浏览器（复用 profile 目录）
├─ ② 导航到抖音创作者页面
├─ ③ 提示用户在浏览器中手动扫码登录
│     "请在浏览器中手动扫码登录。"
│     "登录完成并能进入创作者评论页后，按 Enter 保存并关闭浏览器"
├─ ④ 用户扫码完成，按 Enter
├─ ⑤ 再次导航到评论页，验证登录是否成功
│     检测「选择作品」按钮是否可见
├─ ⑥ 验证成功
│     "登录信息已保存，后续命令会复用这份鉴权。"
└─ ⑦ 关闭浏览器
```

> 💡 **登录态持久化**：登录信息保存在 `.playwright/douyin-profile` 目录中，后续所有需要浏览器的命令（`works`、`comments:export`、`comments:reply`、`article:publish` 等）都会自动复用。无需每次重新登录。

---

## 2. 手动查看

**命令**：`npm run view`
**入口**：`src/open-douyin-view.mjs`

### 使用方法

```bash
npm run view                                    # 打开创作者评论页
npm run view -- "https://some-url.com"          # 打开指定 URL
npm run view -- --zoom 60                       # 缩放 60%
npm run view -- --viewport 1920x1080             # 指定视口
```

### 选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--url <url>` | 要打开的页面 URL | 创作者评论页 |
| `--zoom <percent>` | 页面缩放比例 | 80 |
| `--viewport <WxH>` | 浏览器视口大小 | 自适应屏幕 |
| `--headless` | 无头模式运行 | 否 |
| `--profile <path>` | Playwright profile 路径 | 默认 |

### 业务流程

```
npm run view
│
├─ ① 启动 Chromium（复用登录态，alwaysNewPage: true）
├─ ② 导航到目标 URL
├─ ③ 应用页面缩放（CSS zoom）
├─ ④ 输出当前状态信息（URL、profile、视口、缩放比例）
├─ ⑤ 等待用户手动操作
│     "手动处理完成后，回到终端按 Enter 关闭浏览器"
└─ ⑥ 用户按 Enter → 关闭浏览器
```

> 💡 适用场景：需要手动查看评论区、手动回复特定评论、检查页面状态等。

---

## 3. 导出全部评论（含已回复）

**命令**：`npm run comments:export-all`
**入口**：`src/export-all-douyin-comments.mjs`
**核心函数**：`comment-workflow.mjs` → `exportAllComments()`
**输出**：`comments-output/all-comments.json`

### 使用方法

```bash
npm run comments:export-all -- "作品短标题"
npm run comments:export-all -- --work-publish-text "发布文本" "作品短标题"   # 消歧义
npm run comments:export-all -- --limit 1000 "作品短标题"
```

### 选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `"作品短标题"` | 目标作品标题（必填） | — |
| `--work-publish-text <text>` | 发布文本，用于同名作品消歧义 | 空 |
| `--limit <n>` | 最大导出评论数 | 5000 |
| `--out <path>` | 输出文件路径 | `comments-output/all-comments.json` |
| `--no-history` | 不导出用户历史评论 | 否 |
| `--headless` | 无头模式 | 否 |

### 与 `comments:export` 的区别

| 对比项 | `comments:export` | `comments:export-all` |
|--------|-------------------|----------------------|
| 过滤模式 | 仅未回复评论 | 全部评论（含已回复） |
| 硬刷新 | 否 | 是（清 HTTP 缓存 + 指纹检测） |
| 默认上限 | 200 条 | 5000 条 |
| 输出字段 | 包含 `replyMessage: ""` | 不包含 `replyMessage` |
| 空结果 | 不创建文件 | 仍然创建文件 |

### 业务流程

```
npm run comments:export-all -- "作品标题"
│
├─ ① 启动浏览器 + 导航到评论页
├─ ② 硬刷新页面（CDP 清缓存）
│     确保拿到最新评论数据
├─ ③ 等待「选择作品」按钮出现
├─ ④ 采集当前评论列表指纹（用于后续检测列表变化）
├─ ⑤ 搜索并选中目标作品
├─ ⑥ 等待评论列表从旧指纹切换到目标作品内容
├─ ⑦ 滚动采集全部评论（filterMode = "all"，不应用未回复筛选）
├─ ⑧ 查询用户历史 + 回复次数
├─ ⑨ 过滤已回复评论（reply_count >= 1 的跳过）
├─ ⑩ 下载评论图片
├─ ⑪ 写入 all-comments.json
├─ ⑫ 写入数据库
└─ ⑬ 关闭浏览器
```

---

## 4. 单次执行（配置驱动）

**命令**：`npm run run:once`
**入口**：`src/run-once.mjs`
**核心函数**：`runOnce()`

### 使用方法

```bash
npm run run:once                    # 使用默认 config.json
npm run run:once -- /path/to/config.json   # 指定配置文件
```

### 配置文件格式（config.json）

```json
{
  "llm": {
    "baseURL": "https://api.example.com/v1",
    "apiKey": "sk-xxx",
    "model": "model-name",
    "temperature": 0.7,
    "maxTokens": 200,
    "aiSignature": "【AI自动回复】"
  },
  "task": {
    "workTitle": "目标作品标题",
    "workPublishText": "发布文本（消歧义用）",
    "exportLimit": 200,
    "replyLimit": 20,
    "includeHistory": true,
    "autoReply": true,
    "dryRun": false,
    "headless": false
  },
  "paths": {
    "exportFile": "comments-output/unreplied-comments.json",
    "planFile": "comments-output/generated-reply-plan.json"
  },
  "schedule": {
    "enabled": false,
    "cron": "0 */3 * * *",
    "runOnStartup": false
  }
}
```

### 业务流程

```
npm run run:once
│
├─ ① loadAppConfig(configPath)
│     读取并验证 config.json
│     校验 llm / task / paths / schedule 四个配置段
│
├─ ② exportUnrepliedComments()
│     导出指定作品的未回复评论
│     使用 config.task.workTitle / exportLimit / headless 等参数
│
├─ ③ generateReplyPlan()
│     调用 LLM 为每条评论生成回复
│     使用 config.llm 配置 + config.paths 输出路径
│
├─ ④ 判断是否自动回复
│     if (config.task.autoReply && actionableCount > 0)
│       → replyComments()  执行自动回复
│     else
│       → 跳过，仅生成回复计划
│
└─ ⑤ 输出统计
      generated / skipped / failed / actionable / 耗时
```

> 💡 与 `run-all.sh` 的区别：`run-once` 只处理**单个指定作品**，由 `config.json` 驱动，适合定时任务。

---

## 5. 定时调度

**命令**：`npm run run:scheduler`
**入口**：`src/run-scheduler.mjs`

### 使用方法

```bash
npm run run:scheduler                    # 使用默认 config.json
npm run run:scheduler -- /path/to/config.json
```

### 配置要求

在 `config.json` 中配置 `schedule` 段：

```json
{
  "schedule": {
    "enabled": true,
    "cron": "0 */3 * * *",
    "runOnStartup": true
  }
}
```

| 字段 | 说明 | 示例 |
|------|------|------|
| `enabled` | 是否启用调度 | `true` |
| `cron` | cron 表达式 | `"0 */3 * * *"`（每 3 小时） |
| `runOnStartup` | 启动时是否立即执行一次 | `true` |

### 业务流程

```
npm run run:scheduler
│
├─ ① loadAppConfig() 读取配置
├─ ② 检查 schedule.enabled
│     未启用 → 输出 "disabled in config, exiting" → 退出
├─ ③ 验证 cron 表达式合法性
├─ ④ 如果 runOnStartup = true → 立即执行一次 runOnce()
├─ ⑤ 注册 cron 定时任务
│     每到 cron 指定时间 → trigger("cron") → runOnce()
├─ ⑥ 防重入保护
│     if (isRunning) → "previous run still active, skip"
│     确保同一时间只有一个 runOnce 在执行
└─ ⑦ 持续运行，直到进程被终止
```

> 💡 适用场景：部署在服务器上，配合 `pm2` 或 `systemd` 实现无人值守的自动化评论回复。

---

## 6. 用户评论排行

**命令**：`npm run users`
**入口**：`src/users.mjs`

### 使用方法

```bash
npm run users                              # 默认前 3 名
npm run users -- --top 10                  # 前 10 名
npm run users -- --top 10 --recent 5       # 最近 5 个作品中的前 10 名
npm run users -- --name "半山"             # 按用户名搜索
npm run users -- --name "半山" --json      # 输出 JSON 格式
```

### 选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--top <n>` | 排行模式，显示前 N 名 | 3（最大 200） |
| `--recent <n>` | 仅统计最近 N 个作品中的用户 | 全部 |
| `--name <子串>` | 按用户名子串匹配（不区分大小写） | — |
| `--json`, `-j` | 输出 JSON 格式 | 否 |

> ⚠️ `--top` 与 `--name` 不可同时使用；`--recent` 仅与排行模式搭配。

### 业务流程

```
npm run users -- --top 10
│
├─ ① 解析参数（mode = "top" | "name"）
├─ ② getTopCommenters(db, { limit: 10, recentWorks })
│     ├─ 查询所有评论（或按 recentWorks 过滤）
│     ├─ 按用户名聚合，统计评论数
│     ├─ 对每个用户：normalizeText 去重评论正文
│     └─ 按评论数降序排列，取前 N 名
├─ ③ 输出结果
│     #1  用户名  （去重后 N 条）
│       — 评论内容1
│       — 评论内容2
│       ...
└─ ④ 关闭数据库
```

```
npm run users -- --name "半山"
│
├─ ① listMatchingUsernames(db, "半山")
│     全表扫描，返回所有用户名包含"半山"的用户
├─ ② 对每个匹配用户：getDedupedCommentsForUser(db, username)
│     查询该用户的所有评论，normalizeText 去重
└─ ③ 输出该用户的去重评论列表
```

---

## 7. 数据看板（Web 服务器）

**命令**：`npm run server`
**入口**：`src/server.mjs`
**端口**：`8765`（可通过 `PORT` 环境变量修改）

### 使用方法

```bash
npm run server                # 默认端口 8765
PORT=3000 npm run server      # 自定义端口
```

### API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/stats` | 总览统计：总评论数、作品数、已回复数 |
| GET | `/api/works` | 按作品分组统计：每个作品的评论数和已回复数 |
| POST | `/api/comments` | 分页查询评论（支持按作品/关键词/回复状态筛选） |
| GET | `/api/wordcloud` | 获取词云数据（需先运行 `npm run wordcloud`） |
| GET | `/api/openclaw-thinking/status` | OpenClaw 会话状态查询 |
| GET | `/api/openclaw-thinking/history` | OpenClaw 历史记录 |
| GET | `/api/openclaw-thinking/stream` | OpenClaw 思考流实时推送（SSE） |

### 评论查询接口详情

**POST** `/api/comments`

请求体：
```json
{
  "work": "作品标题",
  "q": "搜索关键词",
  "replied": true,
  "page": 1,
  "limit": 50
}
```

| 参数 | 说明 |
|------|------|
| `work` | 按作品标题筛选 |
| `q` | 按评论内容模糊搜索 |
| `replied` | `true` 仅已回复 / `false` 仅未回复 / 不传为全部 |
| `page` | 页码（从 1 开始） |
| `limit` | 每页条数 |

### 业务流程

```
npm run server
│
├─ ① 启动 Express 服务器（端口 8765）
├─ ② 注册 API 路由
│     /api/stats      → 查询 SQLite 聚合统计
│     /api/works      → 按作品 GROUP BY
│     /api/comments   → 分页查询 + 多条件筛选
│     /api/wordcloud  → 读取 data/wordcloud.json
│     /api/openclaw-* → OpenClaw 思考流集成
├─ ③ 内联赛博朋克风格前端页面
│     单页应用，包含：
│     · 数据总览卡片（总评论/作品/已回复）
│     · 作品列表 + 评论列表
│     · 词云可视化
│     · OpenClaw 思考流实时展示
└─ ④ 持续监听请求
```

---

## 8. 词云计算

**命令**：`npm run wordcloud`
**入口**：`src/compute-wordcloud.mjs`
**输出**：`data/wordcloud.json`

### 使用方法

```bash
npm run wordcloud
```

### 业务流程

```
npm run wordcloud
│
├─ ① 从 SQLite 读取全部评论文本
│     SELECT comment_text FROM comments
│
├─ ② 分词 + 词频统计
│     ├─ 中文分词：Intl.Segmenter("zh", { granularity: "word" })
│     ├─ 英文分词：正则匹配 [a-z][a-z0-9]{1,}
│     ├─ 过滤停词（约 200 个中文停词 + 60 个英文停词）
│     ├─ 过滤无效词（长度 < 2 / 纯数字 / 纯标点）
│     └─ 过滤低频词（出现次数 < 2）
│
├─ ③ 按词频降序排列，取 Top 200
│
└─ ④ 写入 data/wordcloud.json
      格式：{
        updatedAt: "ISO 时间",
        total: 1234,
        words: [["关键词", 出现次数], ...]
      }
```

> 💡 建议每天运行一次。生成的数据可通过 `npm run server` 的 Web 界面查看词云可视化。

---

## 9. 图文发布

**命令**：`npm run imagetext:publish`
**入口**：`src/publish-douyin-imagetext.mjs`

### 使用方法

```bash
npm run imagetext:publish -- imagetext.json
npm run imagetext:publish -- --dry-run imagetext.json    # 试运行（不点击发布）
npm run imagetext:publish -- --keep-open imagetext.json  # 完成后保持浏览器打开
```

### JSON 配置文件格式

```json
{
  "imagePaths": ["./photo1.jpg", "./photo2.jpg"],
  "title": "作品标题",
  "description": "作品描述",
  "music": "星际穿越"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `imagePaths` | 是 | 图片文件路径数组（本地路径） |
| `title` | 是 | 作品标题 |
| `description` | 否 | 作品描述 |
| `music` | 否 | 背景音乐名称（模糊搜索匹配） |

### 选项

| 选项 | 说明 |
|------|------|
| `--dry-run` | 填写表单但不点击发布按钮 |
| `--keep-open` | 完成后保持浏览器打开 |
| `--headless` | 无头模式 |
| `--timeout <ms>` | 超时时间 |

### 业务流程

```
npm run imagetext:publish -- imagetext.json
│
├─ ① readPublishInput(inputFile)
│     读取 JSON → 修复引号 → 解析 → 校验必填字段
│
├─ ② 启动浏览器 + 导航到图文上传页
│     https://creator.douyin.com/creator-micro/content/upload?default-tab=3
│
├─ ③ dismissPopups(page)
│     关闭可能出现的弹窗（引导弹窗、通知等）
│
├─ ④ 上传图片
│     定位文件上传 input → setInputFiles(imagePaths)
│     等待图片上传完成
│
├─ ⑤ 填写标题和描述
│     定位输入框 → 逐字输入文本
│
├─ ⑥ selectMusic(page, musicName, "last")
│     如果配置了音乐：
│     ├─ 点击「添加音乐」按钮
│     ├─ 在搜索框中输入音乐名称
│     ├─ 等待搜索结果加载
│     └─ 点击最后一个匹配结果（通常是最相关的）
│
├─ ⑦ 点击发布按钮（--dry-run 时跳过）
│
└─ ⑧ 关闭浏览器（--keep-open 时等待用户按 Enter）
```

---

## 10. 文章发布

**命令**：`npm run article:publish`
**入口**：`src/publish-douyin-article.mjs`

### 使用方法

```bash
npm run article:publish -- article.json
npm run article:publish -- --dry-run article.json
```

### JSON 配置文件格式

```json
{
  "title": "文章标题",
  "subtitle": "文章摘要",
  "content": "正文内容（支持换行）",
  "imagePath": "./cover.png",
  "music": "星际穿越",
  "tags": ["标签1", "标签2"]
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `title` | 是 | 文章标题 |
| `subtitle` | 否 | 文章摘要 |
| `content` | 是 | 正文内容 |
| `imagePath` | 否 | 封面图路径 |
| `music` | 否 | 背景音乐名称 |
| `tags` | 否 | 标签数组 |

### 业务流程

```
npm run article:publish -- article.json
│
├─ ① readPublishInput(inputFile)
│     读取 JSON → 修复引号 → 解析 → 校验必填字段
│
├─ ② 启动浏览器 + 导航到文章编辑页
│     https://creator.douyin.com/creator-micro/content/post/article
│
├─ ③ dismissPopups(page)
│     关闭弹窗
│
├─ ④ 填写标题
├─ ⑤ 填写摘要（如有）
├─ ⑥ 填写正文
│     定位编辑器 → 点击 → 逐字输入内容
├─ ⑦ 上传封面图（如有）
├─ ⑧ 添加标签（如有）
│     逐个输入标签 → 按回车确认
├─ ⑨ selectMusic(page, musicName, "first")
│     与图文发布类似，但使用 .first() 选择匹配结果
├─ ⑩ 点击发布按钮（--dry-run 时跳过）
└─ ⑪ 关闭浏览器
```

---

## 11. 文生图（即梦 API）

**命令**：`npm run txt2img`
**入口**：`src/txt2img.mjs`

### 使用方法

```bash
npm run txt2img -- "一只可爱的猫咪在水彩画风格下"
npm run txt2img -- --out ./my-image.png "prompt text"
```

### 选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `"prompt"` | 图片描述提示词（必填） | — |
| `--out <path>` | 输出图片路径 | 自动生成时间戳文件名 |
| `--ak <key>` | 火山引擎 Access Key | 环境变量 `VOLC_ACCESS_KEY` |
| `--sk <key>` | 火山引擎 Secret Key | 环境变量 `VOLC_SECRET_KEY` |

### 业务流程

```
npm run txt2img -- "prompt"
│
├─ ① 从参数或环境变量读取 API 凭证
├─ ② 构造火山引擎 API 请求
│     ├─ HMAC-SHA256 V4 签名
│     ├─ Service: cv, Action: CVProcess
│     └─ ReqKey: high_aes_general_v30l_zt2i（即梦文生图 3.0）
│
├─ ③ 发送 POST 请求到 visual.volcengineapi.com
│
├─ ④ 解析响应，提取图片 URL
│     支持多种响应格式（data_dict / image_urls / binary）
│
├─ ⑤ 下载图片到本地
│
└─ ⑥ 输出保存路径
```

> ⚠️ 此功能与抖音评论管理核心功能无关，是独立的 AI 图片生成工具。

---

## 12. 导入历史评论

**命令**：`node src/import-existing-comments.mjs`
**入口**：`src/import-existing-comments.mjs`

### 使用方法

```bash
node src/import-existing-comments.mjs
```

### 前置条件

需要将已有的导出 JSON 文件放到 `comments-output/all-works/` 目录下，每个文件格式需包含：

```json
{
  "selectedWork": { "title": "作品标题" },
  "comments": [
    { "username": "用户名", "commentText": "评论内容" }
  ]
}
```

### 业务流程

```
node src/import-existing-comments.mjs
│
├─ ① 读取 comments-output/all-works/ 目录下所有 .json 文件
├─ ② 逐个文件处理
│     ├─ 解析 JSON
│     ├─ 提取 selectedWork.title 和 comments 数组
│     ├─ 构造数据库行 { username, commentText, replyMessage: null }
│     └─ upsertComments(workTitle, rows) 写入数据库
├─ ③ 输出统计
│     "✓ 作品标题：插入 N 条"
└─ ④ 关闭数据库
```

> 💡 适用场景：首次使用本项目时，将之前手动导出的评论数据批量导入数据库，以便使用用户排行、词云等功能。

---

## 13. 清空数据库

**命令**：`npm run db:clear`
**入口**：`src/clear-database.mjs`

### 使用方法

```bash
npm run db:clear                # 交互式确认
npm run db:clear -- --force    # 跳过确认直接清空
```

### 业务流程

```
npm run db:clear
│
├─ ① 确认提示（--force 时跳过）
│     "⚠️ 即将清空数据库中所有评论数据，此操作不可逆！"
│     "确认清空？请输入 y 继续："
│
├─ ② clearAllComments()
│     ├─ 统计当前行数
│     ├─ DELETE FROM comments
│     └─ DELETE FROM sqlite_sequence（重置自增 ID）
│
└─ ③ 输出 "✅ 已清空数据库，共删除 N 条评论记录。"
```

> ⚠️ 此操作不可逆！清空后所有历史评论数据将丢失。
