/**
 * publish-utils.mjs — 图文/文章发布脚本共用的工具函数
 *
 * 从 publish-douyin-imagetext.mjs 和 publish-douyin-article.mjs 中提取的
 * 重复逻辑，统一维护在此模块中。
 */

import fs from "node:fs";
import { repairJsonFieldQuotes } from "./common.mjs";

// ---------------------------------------------------------------------------
// dismissPopups — 关闭页面上的"我知道了"弹窗（最多尝试 3 次）
// ---------------------------------------------------------------------------

export async function dismissPopups(page) {
  for (let index = 0; index < 3; index += 1) {
    const dismissButton = page.getByText("我知道了", { exact: true }).first();
    const visible = await dismissButton.isVisible().catch(() => false);
    if (!visible) {
      break;
    }
    await dismissButton.click().catch(() => {});
    await page.waitForTimeout(500);
  }
}

// ---------------------------------------------------------------------------
// selectMusic — 在发布页选择配乐
//
// imagetext 版本使用 .last() 获取"选择音乐"按钮，article 版本使用 .first()。
// 通过 musicButtonSelector 参数区分："last"（默认）或 "first"。
// ---------------------------------------------------------------------------

export async function selectMusic(page, musicName, musicButtonSelector = "last") {
  console.log(`选择配乐：${musicName}`);
  await dismissPopups(page);

  const musicLocator = page.getByText("选择音乐");
  const musicButton =
    musicButtonSelector === "first" ? musicLocator.first() : musicLocator.last();
  await musicButton.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await musicButton.click();
  await page.waitForTimeout(2000);
  await dismissPopups(page);

  const searchInput = page
    .locator('input[placeholder*="搜索"], input[placeholder*="音乐"]')
    .first();
  if (await searchInput.isVisible().catch(() => false)) {
    await searchInput.fill(musicName);
    await page.waitForTimeout(500);
    await searchInput.press("Enter");
  } else {
    const fallbackInputs = await page.locator('input[type="search"], input[type="text"]').all();
    let filled = false;
    for (const input of fallbackInputs) {
      if (await input.isVisible().catch(() => false)) {
        await input.fill(musicName);
        await page.waitForTimeout(500);
        await input.press("Enter");
        filled = true;
        break;
      }
    }

    if (!filled) {
      throw new Error("Music search input was not found.");
    }
  }

  await page.waitForTimeout(3000);
  await dismissPopups(page);

  const hiddenUseButton = page.locator('span.semi-button-content:text-is("使用")').first();
  await hiddenUseButton.waitFor({ state: "attached", timeout: 10000 });

  await page.evaluate(() => {
    const fallbackButton = Array.from(document.querySelectorAll("span")).find(
      (node) =>
        node instanceof HTMLElement &&
        node.className.includes("semi-button-content") &&
        node.textContent?.trim() === "使用"
    );
    if (!(fallbackButton instanceof HTMLElement)) {
      return false;
    }

    const row =
      fallbackButton.closest('[class*="item"]') ||
      fallbackButton.closest('[class*="row"]') ||
      fallbackButton.parentElement?.parentElement?.parentElement;
    if (!(row instanceof HTMLElement)) {
      return false;
    }

    row.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    return true;
  });

  await hiddenUseButton
    .locator("xpath=ancestor::*[4]")
    .hover()
    .catch(() => {});
  await page.waitForTimeout(500);

  const useButton = page.getByText("使用", { exact: true }).first();
  await useButton.waitFor({ state: "visible", timeout: 5000 });
  await useButton.click();
  await page.waitForTimeout(1000);
}

// ---------------------------------------------------------------------------
// readPublishInput — 读取并解析发布用的 JSON 输入文件
//
// 统一处理：文件存在性检查 -> 读取内容 -> repairJsonFieldQuotes -> JSON.parse
// 返回 { errors: string[], parsed: object | null }
// ---------------------------------------------------------------------------

export function readPublishInput(inputFile) {
  const errors = [];

  if (!inputFile) {
    errors.push("缺少 JSON 文件参数");
    return { errors, parsed: null };
  }

  if (!fs.existsSync(inputFile)) {
    errors.push(`文件不存在: ${inputFile}`);
    return { errors, parsed: null };
  }

  let rawContent;
  try {
    rawContent = fs.readFileSync(inputFile, "utf8");
  } catch (error) {
    errors.push(
      `无法读取文件: ${inputFile} (${error instanceof Error ? error.message : String(error)})`
    );
    return { errors, parsed: null };
  }

  const repairedContent = repairJsonFieldQuotes(rawContent);

  let parsed;
  try {
    parsed = JSON.parse(repairedContent);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const posMatch = msg.match(/position\s+(\d+)/i);
    let hint = msg;
    if (posMatch) {
      const pos = Number(posMatch[1]);
      const before = rawContent.slice(Math.max(0, pos - 40), pos);
      const after = rawContent.slice(pos, pos + 40);
      hint = `${msg}\n    问题位置附近: ...${before}👉${after}...`;
    }
    errors.push(`JSON 解析失败: ${hint}`);
    return { errors, parsed: null };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push("JSON 内容应为一个对象 {...}，不能是数组或其他类型");
    return { errors, parsed: null };
  }

  return { errors, parsed };
}
