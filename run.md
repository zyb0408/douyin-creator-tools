# 运行步骤指南

## 快速开始

```bash
cd ~/Desktop/hermes_workspace/dev/douyin-creator-tools
```

## 1. 检查 Node.js 版本

```bash
node -v  # 确保版本 >= 20.0.0
```

## 2. 安装依赖

```bash
npm install
```

## 3. 安装 Playwright Chromium

```bash
npx playwright install chromium
```

## 4. 首次登录（必须用户亲自扫码）

```bash
npm run auth
```

## 5. 运行各个功能

| 功能 | 命令 |
|------|------|
| 查看作品列表 | `npm run works` |
| 导出作品未回复评论 | `npm run comments:export` （自动使用最新作品）或 `npm run comments:export -- "<作品标题>"` |
| 生成评论回复（使用大模型） | `npm run comments:generate-reply` |
| 批量回复评论 | `npm run comments:reply -- <plan.json>` |
| 查看最近 N 个作品 | `npm run works -- --limit 5` |
| 启动 API 服务 | `npm run server` |

## 完全自动化的完整工作流程

1. **获取最新作品列表**：
   ```bash
   npm run works
   ```
   生成文件：`comments-output/list-works.json`

2. **导出所有作品的未回复评论**：
   ```bash
   npm run comments:export
   ```
   自动从 `list-works.json` 读取所有作品标题，逐个导出未回复评论：
   - 对每个作品生成独立的输出文件，文件名格式：`unreplied-comments-作品标题.json`
   - 如果某个作品没有未回复评论，系统将不创建文件并显示提示
   - 处理完成后显示统计信息（处理了多少作品，成功导出了多少）
   - 所有文件保存在 `comments-output/` 目录中

3. **生成回复内容（使用大模型）**：
   ```bash
   npm run comments:generate-reply
   ```
   读取 `comments-output/unreplied-comments.json`（最新作品的未回复评论），调用本地大模型API生成回复，生成 `comments-output/generated-reply-plan.json`
   - 如果 `unreplied-comments.json` 不存在，`comments:generate-reply` 会提示错误
   - 如果需要为特定作品生成回复：
     1. 先运行 `npm run comments:export -- "作品标题"` 生成该作品的未回复评论文件
     2. 将生成的文件（如 `unreplied-comments-作品标题.json`）复制为 `unreplied-comments.json`
     3. 运行 `npm run comments:generate-reply`
     
     ```bash
     cp "comments-output/unreplied-comments-作品标题.json" "comments-output/unreplied-comments.json"
     npm run comments:generate-reply
     ```

4. **自动回复评论**：
   ```bash
   npm run comments:reply -- comments-output/generated-reply-plan.json
   ```

> **提示**：
> - 如果需要导出特定作品的评论，仍可使用 `npm run comments:export -- "作品标题"`
> - `comments:generate-reply` 命令会自动读取 `config.json` 中的 LLM 配置，无需额外参数
> - 所有中间文件都保存在 `comments-output/` 目录中，便于调试和重试
> - 当没有未回复评论时，系统会跳过文件创建，避免无意义的空文件生成
> - 如果需要导出所有作品的全部评论（包括已回复），请使用 `npm run comments:export-all -- "作品标题"` 命令

## 注意事项

- 参数一定要放在 `--` 之后，否则会被 npm 吞掉
- 复用 `.playwright/douyin-profile` 登录态，不要清空或替换
- 确保配置文件中 API 地址正确
