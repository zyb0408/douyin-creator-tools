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
| 导出作品未回复评论 | `npm run comments:export -- "<作品标题>"` |
| 批量回复评论 | `npm run comments:reply -- <plan.json>` |
| 查看最近 N 个作品 | `npm run works -- --limit 5` |
| 启动 API 服务 | `npm run server` |

## 注意事项

- 参数一定要放在 `--` 之后，否则会被 npm 吞掉
- 复用 `.playwright/douyin-profile` 登录态，不要清空或替换
- 确保配置文件中 API 地址正确
