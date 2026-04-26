# 运行步骤指南

## ✅ 环境与依赖准备（首次运行必读）

### 1. 系统要求
- Node.js ≥ 20.0.0（推荐使用 [nvm](https://github.com/nvm-sh/nvm) 管理版本）
- npm（随 Node.js 安装）
- macOS 或 Linux（Windows 未测试，建议使用 WSL）
- 可访问互联网（用于下载依赖和登录抖音）

### 2. 安装项目依赖

```bash
# 克隆仓库（如未完成）
git clone https://github.com/zyb0408/douyin-creator-tools.git
cd douyin-creator-tools

# 安装 Node.js 依赖
npm install

# 安装 Playwright Chromium 浏览器引擎
npx playwright install chromium
```

> ✅ 这些步骤只需执行一次，完成后即可长期使用。

### 3. 首次登录抖音（必须手动扫码）

```bash
npm run auth
```

**作用**：启动 Playwright 浏览器，打开抖音创作者中心登录页，**请用手机抖音 App 扫码登录**。

> 🔐 登录成功后，会自动生成 `.playwright/douyin-profile` 目录，保存你的登录态。**请勿删除或替换此目录**，否则每次都要重新扫码。
> ✅ 此步骤只需执行一次，后续自动化流程将自动复用登录态。

### 4. 配置本地大模型（LLM）

编辑 `config.json` 文件，确保 `llm` 字段指向你正在运行的本地大模型服务：

```json
{
  "llm": {
    "baseURL": "http://127.0.0.1:8000/v1",
    "apiKey": "sk-123456",
    "model": "Qwen3.6-35B-A3B-4bit",
    "temperature": 0.7,
    "maxTokens": 300
  }
}
```

> ⚠️ 确保你的本地大模型服务（如 Ollama、vLLM、FastChat 等）已启动并监听该地址。否则 `generate-reply` 步骤将失败。

---

## ✅ 一键全自动流程（推荐）

执行以下命令，**一步完成全部操作**：

```bash
chmod +x run-all.sh
./run-all.sh
```

> ✅ 自动完成：获取作品 → 导出评论 → 生成AI回复 → 自动回复 → 清理中间文件
> ✅ 所有评论都会被处理，无需手动指定作品
> ✅ 每条回复自动追加：【沪上码仔AI自动回复，注意甄别】
> ✅ 执行后自动清理所有中间文件，不留痕迹

---

## 📋 手动分步流程（调试用）

### 1. 获取最新作品列表

```bash
npm run works
```

**作用**：从抖音创作者中心获取最近的作品列表，生成 `comments-output/list-works.json` 文件，用于后续批量处理。

---

### 2. 导出所有作品的未回复评论

```bash
npm run comments:export
```

**作用**：自动读取 `list-works.json` 中的所有作品标题，逐个登录抖音，导出每个作品的**未回复评论**，生成多个文件：
- `unreplied-comments-作品标题.json`（每个作品一个）
- **无未回复评论的作品，不会生成文件**

> 💡 此步骤会创建大量文件，用于后续AI处理。

---

### 3. 生成AI回复内容

```bash
npm run comments:generate-reply
```

**作用**：
- 读取 `comments-output/` 下所有 `unreplied-comments-*.json` 文件
- 合并所有未回复评论，使用本地大模型（`config.json` 配置）逐条生成回复
- 每条回复自动追加签名：`【沪上码仔AI自动回复，注意甄别】`
- 输出统一文件：`comments-output/generated-reply-plan.json`

> ⚠️ 此步骤会调用本地LLM，耗时取决于评论数量和模型响应速度。

---

### 4. 自动回复所有评论

```bash
npm run comments:reply-all
```

**作用**：
- 读取 `generated-reply-plan.json` 中的全部评论
- 按作品标题分组，**逐个作品**调用抖音客户端自动回复
- 每个作品生成临时计划文件，回复完成后自动删除
- 所有回复成功后，**自动清理**以下中间文件：
  - `list-works.json`
  - `unreplied-comments-*.json`
  - `generated-reply-plan.json`
  - `reply-comments-result.json`
  - `all-comments.json`

> ✅ 最终仅保留 `comment-images/`（如有），确保系统干净。

---

### 5. 清空评论数据库

```bash
npm run db:clear
```

**作用**：清空本地数据库（`data/douyin-creator.db`）中 `comments` 表的所有数据，包括评论内容、回复记录、回复计数等，并重置自增 ID。

**选项**：
- `--force` — 跳过确认提示，直接清空（适用于脚本或定时任务中调用）
- `--help` — 显示帮助信息

```bash
# 跳过确认直接清空
npm run db:clear -- --force
```

> ⚠️ **此操作不可逆！** 清空后所有历史评论数据将丢失。默认会要求输入 `y` 确认。
> 💡 适用场景：数据库中积累了大量过期数据、回复计数异常需要重新开始、切换账号后重新采集。

---

## 🛠 配置说明

- **LLM 配置**：修改 `config.json` 中的 `llm` 字段，设置你的本地模型地址、密钥和模型名
- **回复签名**：在 `src/lib/llm-reply-generator.mjs` 中修改 `AI_SIGNATURE` 常量
- **自动清理**：`reply-all-works.mjs` 中的清理逻辑会自动删除所有 `.json` 文件，无需手动干预

## 💡 使用建议

- 首次使用请按顺序执行：`npm install` → `npx playwright install chromium` → `npm run auth` → `./run-all.sh`
- 确保 `config.json` 中的 `baseURL` 指向正在运行的本地大模型服务（如 http://127.0.0.1:8000/v1）
- 不要清空 `.playwright/douyin-profile`，它保存了你的登录态
- 推荐使用 `./run-all.sh` 作为日常执行命令，无需记忆复杂步骤

> 📌 所有中间文件都在 `comments-output/` 目录中，便于调试和重试。自动化流程结束后，该目录将被清空，仅保留图片。
