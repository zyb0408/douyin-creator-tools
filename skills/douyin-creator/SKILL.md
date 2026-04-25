---
name: douyin-creator
description: "抖音（Douyin）创作者中心作品与评论自动化：获取已发布作品列表、导出指定作品的未回复评论、按 JSON 批量回复评论。当用户提到 抖音 / Douyin / 创作者中心 / 作品列表 / 导出评论 / 回复评论 / 未回复评论 / 批量回复 时触发。"
user-invocable: true
metadata: {"Hermes":{"requires":{"bins":["node","npm","npx"]}}}
---

# douyin-creator

用仓库 `douyin-creator-tools` 的 CLI 完成三件事：作品列表、导出未回复评论、按 JSON 批量回复。不要自己用 Playwright 重写。用户提到这三件事以外的抖音需求时，告知"本 skill 只处理作品列表、评论导出、批量回复"。

## 项目根

`$PROJECT_DIR = ~/Desktop/hermes_workspace/dev/douyin-creator-tools`（仓库固定 clone 到此位置）。

依赖安装、Chromium 安装、扫码登录等**初始化步骤不在本 skill 范围**，由 `$PROJECT_DIR/README.md` 负责。命令执行时报「需要登录 / 跳转到登录页 / 找不到 chromium / 缺依赖」等环境问题时，**停止执行**并要求用户按 README 完成对应初始化，不要自作主张替用户安装或登录。

## 工作流 1：作品列表

```bash
cd "$PROJECT_DIR" && npm run works
cd "$PROJECT_DIR" && npm run works -- --limit 5
```

输出 `$PROJECT_DIR/comments-output/list-works.json`：

```json
{ "count": 2, "works": [{ "title": "作品标题" }] }
```

- `--limit N` 可选，只保留当前列表里最新的前 N 个作品；例如只处理最近 5 个作品时先运行 `npm run works -- --limit 5`

## 工作流 2：导出未回复评论

```bash
cd "$PROJECT_DIR" && npm run comments:export -- "<作品标题>"
```

- 位置参数必填：作品标题，从工作流 1 的 `works[].title` 里取，带空格必须加双引号
- 标题匹配规则：页面上作品标题 includes 传入字符串，传完整标题最稳

输出 `$PROJECT_DIR/comments-output/unreplied-comments.json`：

```json
{
  "selectedWork": { "title": "作品标题" },
  "count": 1,
  "comments": [
    {
      "username": "用户A",
      "commentText": "评论内容",
      "imagePaths": ["/abs/path/comment-images/用户A_0_ab12cd34.jpeg"],
      "replyMessage": ""
    }
  ]
}
```

`imagePaths` 仅在评论带图时出现。`replyMessage` 初始为空字符串。

如果需要批量遍历多个作品导出未回复评论，优先使用仓库脚本并限制范围，避免扫描全部作品：

```bash
cd "$PROJECT_DIR" && node ./scripts/export-all-unreplied.mjs --latest 5
```

- `--latest 5` 表示只处理 `list-works.json` 中最新的 5 个作品
- 若要跳过最新几个后再处理，可用 `--offset <n> --latest <m>`

## 工作流 3：批量回复

流程：导出 JSON → 在每条 `replyMessage` 填文案 → 把 JSON 路径传给 `comments:reply`。

```bash
cd "$PROJECT_DIR" && npm run comments:reply -- /abs/path/to/comments.json
```

**硬约束**（违反会失败或丢数据）：

1. 只改 `replyMessage`，`username` / `commentText` / `imagePaths` / `selectedWork` 原样保留，内部靠它们匹配评论
2. `replyMessage` 按 Unicode 字符最多 400（中文、英文、标点、emoji 都按 1 算）
3. `replyMessage` 为 `""` 的条目会被跳过
4. 回复文本里的引号用中文 `""`，别用未转义的英文 `"`
5. 不要加 `status` / `appliedReplyMessage` 字段，那是结果字段，执行时会被覆盖
