# 抖音创作者中心自动回复 — 油猴脚本设计

> 把 `run-all.sh` 的四步全流程（获取作品 → 导出未回复评论 → LLM 生成回复 → 自动回复）翻译成单文件 Tampermonkey 脚本，浏览器内直接跑，无需 Node 后端。

---

## 1. 目标与范围

### 1.1 目标
- 在抖音创作者中心评论管理页一键启动自动回复
- 支持 LLM 根据评论内容生成个性化回复
- 支持自动遍历前 N 个作品
- 支持定时扫描（前提：页面常驻）

### 1.2 运行环境
- 注入页面：`https://creator.douyin.com/creator-micro/comment-manage*`
- 不支持 `www.douyin.com` 前台视频页
- 浏览器：Chrome / Edge / Firefox + Tampermonkey

### 1.3 与 Node.js 工具的关系
两端**回复生成风格一致**（system prompt、过滤规则原样移植），但**数据完全独立**：
- 油猴端不访问 SQLite，不做用户历史评论查询
- 油猴端去重仅靠页面"未回复"筛选 tab
- 适合每天数十到数百条的轻量场景；高强度批量任务仍走 Node 端

---

## 2. 架构

```
单文件 IIFE 油猴脚本
│
├── config UI（Shadow DOM 悬浮面板）
│       ↕ GM_setValue / GM_getValue
│
├── 状态机引擎（run loop）
│       │
│       ├── 手动触发（点"开始"）
│       └── 定时触发（setTimeout 递归）
│
└── worker 模块
    ├── works-panel       ：打开/选择作品
    ├── comment-collector ：滚动 + 提取可见未回复评论
    ├── llm-client        ：fetch OpenAI 兼容 API
    ├── reply-sender      ：仿人输入 + 点发送
    └── sanitizer         ：复用 lib/llm-reply-generator 的过滤规则
```

每个 worker 模块对应 Node 端一个 `lib/*.mjs`，便于把成熟逻辑直接翻译过来。

### 2.1 主循环

```
for (i = 0; i < worksLimit; i++) {
  ① openWorksPanel()           // 点「选择作品」
  ② selectWorkByIndex(i)       // 点第 i 个作品
  ③ applyUnrepliedFilter()     // 点「未回复」标签
  ④ while (有未回复评论 && 未暂停) {
       comment = extractFirstUnreplied()
       reply   = generateReply(comment)   // 三种模式
       reply   = sanitize(reply)
       if (reply) await sendReply(reply)  // 仿人输入 + 发送
       await sleep(3~8s)
  }
}
```

---

## 3. DOM 选择器策略

抖音 DOM 经常变，关键策略：**语义优先 + 文本兜底**。所有选择器集中在文件顶部 `SELECTORS` 常量，便于改版时单点修改。

| 操作 | 主选择器 | 兜底 |
|------|---------|------|
| 选作品按钮 | `button:has-text("选择作品")` | 遍历 button 找文本 |
| 作品列表项 | 侧边栏内 `[data-e2e*="work"]` 或 `[role="listitem"]` | 取侧边栏内带封面 `<img>` 的可点击块 |
| 「未回复」筛选 tab | 顶部 tab 文本匹配 `未回复` | 同上 |
| 单条评论容器 | 评论列表内带「回复」按钮的最近祖先 `div` | XPath 找含「回复」文本节点的可点击块 |
| 「回复」按钮 | 评论容器内 `button:has-text("回复")` | 文本匹配 |
| 输入框 | 弹出后页面里 `contenteditable="true"` 且可见且未填值 | 监听 `focus` 事件捕获 |
| 「发送」按钮 | 输入框附近 `button:has-text("发送")` 且可点击 | DOM 树就近搜索 |

**避坑**：
- 抖音用 React，DOM 节点会被替换 → 脚本不缓存 element 引用，每次操作前重新查询
- 用 `MutationObserver` 监听评论列表变化，新评论出现时触发再次查询

---

## 4. 单条回复发送时序

```
1. scrollIntoView({block:"center"})
2. wait 200ms（让 hover 类生效）
3. 点击「回复」按钮
4. waitFor(输入框出现, 5s 超时)
5. 输入框 focus
   → 先尝试 execCommand("insertText", reply)
   → 失败则逐字 dispatchEvent input/composition 事件（30~80ms/字，仿人）
6. waitFor(发送按钮 enabled, 3s 超时)
7. 点击「发送」
8. waitFor(评论从列表消失 OR 「回复」按钮消失, 8s)
9. 随机 sleep 3000~8000ms
```

**异常处理**：每一步 try/catch，失败写日志面板并跳过该评论；连续 3 条失败 → 暂停并告警"DOM 可能已更新"。

---

## 5. LLM 调用与三种回复模式

### 5.1 配置项（持久化在 `GM_setValue`）

```js
{
  enabled: false,
  mode: "hybrid",                  // "template" | "llm" | "hybrid"
  worksLimit: 8,
  templates: [
    "感谢关注！❤️",
    "谢谢你的支持！",
    "欢迎常来玩～"
  ],
  llm: {
    baseURL: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    temperature: 0.7,
    maxTokens: 300
  },
  aiSignature: "【沪上码仔AI自动回复，注意甄别】",
  typingMinMs: 30,
  typingMaxMs: 80,
  replyDelayMinMs: 3000,
  replyDelayMaxMs: 8000,
  schedule: {
    enabled: false,
    intervalMin: 30,
    runImmediatelyOnStart: false
  }
}
```

### 5.2 LLM 调用

直连 OpenAI 兼容 API：

```js
fetch(`${baseURL}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
  body: JSON.stringify({
    model, temperature, max_tokens: maxTokens,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: buildUserPrompt(work, comment) }
    ]
  }),
  signal: AbortSignal.timeout(15000)
})
```

`SYSTEM_PROMPT` 翻译自 `lib/llm-reply-generator.mjs` 已有提示词（友好、口语化、禁止引流、禁止 markdown），保持两端风格一致。

`buildUserPrompt` 注入：作品标题、用户昵称、评论文本、是否带图。**历史评论不带**（无 SQLite，避免再做存储层）。

### 5.3 三种模式

```
generateReply(comment):
  if mode == "template":
     return random(templates)
  if mode == "llm":
     try: return await callLLM(comment)
     catch: return null   // 跳过
  if mode == "hybrid":
     try: return await callLLM(comment)
     catch: return random(templates)
```

### 5.4 内容过滤（sanitize）

完全照搬 `lib/llm-reply-generator.mjs` 的 `sanitizeReplyMessage`：

```
1. 去除 <think>...</think> 块
2. 折叠多余空白和换行
3. 直引号 → 弯引号
4. 命中黑名单 → 返回 null（跳过该评论）
   /微信/i  /vx/i  /v信/i  /加我/i  /私信我/i
   /联系方式/i  /\d{8,}/
5. 空文本 → 返回 null
6. 长度 > 400 → 截断到 397 + "..."
7. 追加 aiSignature（容不下时再截原文以容纳签名）
```

模板模式回复**也走 sanitize**，统一兜底。

---

## 6. 定时扫描

### 6.1 配置
- 默认间隔 30 分钟，可改为自定义分钟数
- 间隔下限 5 分钟（小于则阻止保存）
- 可选"开启时立即跑一次"

### 6.2 行为矩阵

| 情况 | 行为 |
|------|------|
| 定时到点，正在跑 | 跳过本次，记日志"上一轮未结束"，等下一周期 |
| 定时到点，待机 | 自动开始一轮 |
| 用户手动点"暂停" | 暂停当前轮；定时器继续走，下一周期照常起 |
| 用户关闭定时开关 | `clearTimeout` 清掉；不影响正在跑的那轮 |
| 页面切到后台标签 | 照常运行（不依赖 visibility） |
| 页面关闭/刷新 | 定时器销毁；重开页面后根据 `schedule.enabled` 自动恢复 |
| URL 离开评论管理页 | `MutationObserver` 监测后暂停定时器；回到此页自动恢复 |

### 6.3 实现要点
- 用 `setTimeout` 递归调度（避免堆积），不用 `setInterval`
- 面板"下次运行"用 1Hz 倒计时显示
- 启动时若 `schedule.enabled === true` 自动恢复定时器
- 定时触发的轮次日志前缀 `[定时]`

---

## 7. 面板 UI

右下角悬浮，挂在 Shadow DOM 里避免抖音 CSS 污染。

```
              ┌────────────────────────────────────┐
              │  🤖 抖音自动回复            [—] [×] │
              ├────────────────────────────────────┤
              │  状态: 待机                         │
              │  [  ▶ 开始  ]  [  ⏸ 暂停  ]        │
              ├────────────────────────────────────┤
              │  ▼ 基础设置                         │
              │  启用       [ON ●  ]                │
              │  模式       (○ 模板 ● 混合 ○ LLM)    │
              │  作品数 N   [   8   ]               │
              ├────────────────────────────────────┤
              │  ▼ 定时扫描                         │
              │  开启定时    [OFF  ●]               │
              │  间隔  (● 30 分钟  ○ 自定义)         │
              │  自定义    [   45   ] 分钟          │
              │  ☐ 开启时立即跑一次                  │
              │  下次运行: 14:32:15（剩 23 分 11 秒） │
              ├────────────────────────────────────┤
              │  ▼ 模板（每行一条）                  │
              │  ┌────────────────────────────────┐│
              │  │ 感谢关注！❤️                   ││
              │  │ ...                            ││
              │  └────────────────────────────────┘│
              ├────────────────────────────────────┤
              │  ▼ LLM 配置                         │
              │  baseURL   [https://api.openai...]│
              │  apiKey    [••••••••••••]         │
              │  model     [gpt-4o-mini]          │
              │  temp [0.7]  maxTokens [300]      │
              │  签名 [【沪上码仔AI自动回复…】]      │
              ├────────────────────────────────────┤
              │  ▼ 高级（延迟/打字速度，默认折叠）    │
              ├────────────────────────────────────┤
              │  ▼ 日志（实时滚动）                  │
              │  [💾 保存] [📋 复制日志] [🧹 清空]   │
   ┌──────┐  └────────────────────────────────────┘
   │  🤖  │  ← 折叠时只剩这个圆形按钮（拖拽吸边）
   └──────┘
```

- 折叠态 64×64，展开态宽 380、高度自适应+滚动
- 拖拽位置存 `GM_setValue("panelPos", ...)`
- 总开关关闭时 "开始" 按钮 disabled

### 7.1 日志格式

```
[14:32:15] 作品 2/8: 看花就来上海✨
[14:32:16]   评论 #1 user=张三 → LLM…
[14:32:18]   评论 #1 已回复 ✓
[14:32:23]   评论 #2 user=李四 → 命中黑名单(微信)，跳过
[14:32:25]   评论 #3 user=王五 → LLM 超时，回退到模板
[15:02:15] [定时] 第 2 轮启动
```

最多保留 200 行，可一键复制全部。

---

## 8. 错误处理矩阵

| 场景 | 行为 |
|------|------|
| 选作品按钮找不到 | 等 5s 重试一次，仍失败 → 暂停并告警 |
| 单条评论回复失败（任意步骤） | 跳过，日志记录原因；连续 3 次失败 → 暂停 |
| LLM 401/429 | 高亮日志，**整轮直接停止**（避免烧 quota） |
| LLM 超时/网络错误 | hybrid 回退模板；llm 模式跳过 |
| 用户点"暂停" | 当前评论处理完后退出循环 |
| 页面关闭/刷新 | `beforeunload` 保存进度（已处理评论数） |
| 模板列表为空且模式需要模板 | 启动校验，弹错误阻止开始 |

---

## 9. 文件位置

```
douyin-creator-tools/
├── userscripts/                              ← 新建目录
│   ├── douyin-auto-reply-userscript.js       ← 主脚本（约 800-1000 行）
│   └── README.md                             ← 安装与使用说明
└── docs/plans/
    └── 2026-05-08-douyin-userscript-design.md   ← 本文档
```

不放在 `src/` 下：src 全是 Node ESM，混入 GM_* / DOM API 会让 lint 报错。

---

## 10. 不做的事（YAGNI）

- ❌ 不做评论图片下载/解析（油猴里成本高）
- ❌ 不做用户历史评论查询（无数据库，硬塞 prompt 会失控）
- ❌ 不做小时级配额（间隔 + 作品数 N + sanitize 已够限速）
- ❌ 不做 cron 表达式（30 分钟+自定义分钟够用）
- ❌ 不支持 `www.douyin.com` 前台视频页
- ❌ 不做"人工确认后发送"模式（要么全自动，要么完全不开）

---

## 11. 测试与验证

油猴脚本无法跑单元测试，验证靠：

1. **小号验证**：在 6 条以内测试评论上跑通完整流程
2. **DOM 失效模拟**：手动改一个 SELECTORS 让选择器失效，验证错误处理是否符合预期（暂停 + 告警，不卡死）
3. **LLM 故障注入**：故意填错 apiKey → 验证 401 处理、hybrid 回退
4. **定时器验证**：把 intervalMin 改成 5 分钟跑 30 分钟，看是否准时触发 6 次
5. **过滤规则验证**：往模板里塞含"微信"的字符串，验证被过滤
