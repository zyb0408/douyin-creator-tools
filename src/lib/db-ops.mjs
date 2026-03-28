import { getDb } from "./db.mjs";

/**
 * 批量写入评论到数据库。
 * - export 场景：reply_message 为 null，已存在的行保持不变（INSERT OR IGNORE）
 * - reply 场景：传入 reply_message，INSERT OR REPLACE 覆盖整行
 *
 * @param {string} workTitle - 作品标题
 * @param {Array<{username: string, commentText: string, replyMessage?: string|null}>} comments
 */
export function upsertComments(workTitle, comments) {
  if (!workTitle || !Array.isArray(comments) || comments.length === 0) {
    return;
  }

  const db = getDb();

  const insertIgnore = db.prepare(`
    INSERT OR IGNORE INTO comments (work_title, username, comment_text, reply_message)
    VALUES (?, ?, ?, ?)
  `);

  const insertReplace = db.prepare(`
    INSERT OR REPLACE INTO comments (work_title, username, comment_text, reply_message)
    VALUES (?, ?, ?, ?)
  `);

  const runBatch = db.transaction((rows) => {
    for (const row of rows) {
      const { username, commentText, replyMessage } = row;
      if (!username || !commentText) {
        continue;
      }

      if (replyMessage != null) {
        insertReplace.run(workTitle, username, commentText, replyMessage);
      } else {
        insertIgnore.run(workTitle, username, commentText, null);
      }
    }
  });

  runBatch(comments);
}
