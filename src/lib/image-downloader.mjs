// 评论图片下载模块

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

/**
 * 从 URL 中提取文件扩展名。
 * @param {string} url - 图片 URL
 * @returns {string} 扩展名（含点号），默认 ".jpg"
 */
export function extractExtFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(\w+)$/);
    return match ? `.${match[1]}` : ".jpg";
  } catch {
    return ".jpg";
  }
}

/**
 * 下载评论中的图片并保存到本地。
 * 下载完成后会将 comment.imageUrls 替换为 comment.imagePaths。
 * @param {Array<object>} comments - 评论列表，每条评论可能包含 imageUrls 字段
 * @param {string} outputPath - 输出文件路径，图片将保存在其同级的 comment-images 目录
 */
export async function downloadCommentImages(comments, outputPath) {
  const hasImages = comments.some((c) => c.imageUrls?.length > 0);
  if (!hasImages) return;

  const imageDir = path.resolve(path.dirname(outputPath), "comment-images");
  await fs.promises.mkdir(imageDir, { recursive: true });

  let downloaded = 0;
  let failed = 0;

  for (const comment of comments) {
    if (!comment.imageUrls?.length) continue;
    const savedPaths = [];

    for (let i = 0; i < comment.imageUrls.length; i++) {
      const url = comment.imageUrls[i];
      try {
        const response = await fetch(url);
        if (!response.ok) {
          console.warn(`[image] 下载失败 (HTTP ${response.status}): ${url.slice(0, 100)}…`);
          failed += 1;
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const ext = extractExtFromUrl(url);
        const hash = crypto.createHash("md5").update(url).digest("hex").slice(0, 8);
        const safeName = comment.username.replace(/[^\w\u4e00-\u9fff-]/g, "_").slice(0, 20);
        const filename = `${safeName}_${i}_${hash}${ext}`;
        const filePath = path.resolve(imageDir, filename);

        await fs.promises.writeFile(filePath, buffer);
        savedPaths.push(filePath);
        downloaded += 1;
      } catch (err) {
        console.warn(`[image] 下载异常: ${err?.message ?? err}`);
        failed += 1;
      }
    }

    delete comment.imageUrls;
    if (savedPaths.length > 0) {
      comment.imagePaths = savedPaths;
    }
  }

  if (downloaded > 0) {
    console.log(`[image] 已下载 ${downloaded} 张评论图片至 ${imageDir}`);
  }
  if (failed > 0) {
    console.warn(`[image] ${failed} 张图片下载失败`);
  }
}
