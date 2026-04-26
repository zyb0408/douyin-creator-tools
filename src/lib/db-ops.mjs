import { getDb } from "./db.mjs";

/**
 * 批量写入评论到数据库。
 * - export 场景：reply_message 为 null，已存在的行保持不变（INSERT OR IGNORE）
 * - reply 场景：传入 reply_message，仅更新 reply_message 字段，comment_time 不受影响
 *
 * @param {string} workTitle - 作品标题
 * @param {Array<{username: string, commentText: string, replyMessage?: string|null, commentTime?: string|null}>} comments
 */
export function upsertComments(workTitle, comments) {
  if (!workTitle || !Array.isArray(comments) || comments.length === 0) {
    return;
  }

  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const insertIgnore = db.prepare(`
    INSERT OR IGNORE INTO comments (work_title, username, comment_text, reply_message, comment_time)
    VALUES (?, ?, ?, ?, ?)
  `);

  const updateReply = db.prepare(`
    UPDATE comments SET reply_message = ?
    WHERE work_title = ? AND username = ? AND comment_text = ?
  `);

  const runBatch = db.transaction((rows) => {
    for (const row of rows) {
      const { username, commentText, replyMessage, commentTime } = row;
      if (!username || !commentText) {
        continue;
      }

      const effectiveTime = commentTime || today;

      if (replyMessage != null) {
        // 先确保行存在，再更新 reply_message（避免 INSERT OR REPLACE 覆盖 comment_time）
        insertIgnore.run(workTitle, username, commentText, null, effectiveTime);
        updateReply.run(replyMessage, workTitle, username, commentText);
      } else {
        insertIgnore.run(workTitle, username, commentText, null, effectiveTime);
      }
    }
  });

  runBatch(comments);
}

/**
 * 批量查询指定作品下一批评论的回复次数。
 * 返回 Map，key 为 `${username}|||${commentText}`，value 为 reply_count。
 *
 * @param {string} workTitle
 * @param {Array<{username: string, commentText: string}>} comments
 * @returns {Map<string, number>}
 */
export function getReplyCountMap(workTitle, comments) {
  if (!workTitle || !Array.isArray(comments) || comments.length === 0) {
    return new Map();
  }

  const db = getDb();

  // 构建 JSON 数组：每项为 [username, commentText]，用于 json_each() 批量查询
  const jsonArray = JSON.stringify(
    comments.map(({ username, commentText }) => [username, commentText])
  );

  // 使用 json_each() 一次性查询所有评论的回复次数，避免逐条查询
  const rows = db
    .prepare(
      `
    SELECT
      c.value ->> 0 AS username,
      c.value ->> 1 AS comment_text,
      COALESCE(cm.reply_count, 0) AS reply_count
    FROM json_each(?) AS c
    LEFT JOIN comments cm
      ON cm.work_title = ?
     AND cm.username = c.value ->> 0
     AND cm.comment_text = c.value ->> 1
  `
    )
    .all(jsonArray, workTitle);

  const result = new Map();
  for (const row of rows) {
    result.set(`${row.username}|||${row.comment_text}`, row.reply_count);
  }
  return result;
}

/**
 * 批量查询一组用户名的历史评论（跨所有作品），不含回复内容。
 * 返回 Map，key 为 username，value 为 [{date, text, work}] 按时间倒序。
 *
 * @param {string[]} usernames
 * @returns {Map<string, Array<{date: string, text: string, work: string}>>}
 */
export function getUserHistoryMap(usernames) {
  if (!Array.isArray(usernames) || usernames.length === 0) {
    return new Map();
  }

  const db = getDb();
  const unique = [...new Set(usernames.filter(Boolean))];
  const placeholders = unique.map(() => "?").join(",");

  const rows = db
    .prepare(
      `
    SELECT username, comment_text, comment_time, work_title
    FROM comments
    WHERE username IN (${placeholders})
    ORDER BY comment_time DESC, id DESC
  `
    )
    .all(...unique);

  const result = new Map();
  for (const row of rows) {
    if (!result.has(row.username)) {
      result.set(row.username, []);
    }
    result.get(row.username).push({
      date: row.comment_time,
      text: row.comment_text
    });
  }

  return result;
}

/**
 * 将指定评论的回复次数 +1。
 *
 * @param {string} workTitle
 * @param {string} username
 * @param {string} commentText
 * @returns {number} 实际更新的行数（0 表示未匹配到库中记录）
 */
export function incrementReplyCount(workTitle, username, commentText) {
  if (!workTitle || !username || !commentText) {
    return 0;
  }
  const db = getDb();
  const info = db
    .prepare(
      `
    UPDATE comments SET reply_count = reply_count + 1
    WHERE work_title = ? AND username = ? AND comment_text = ?
  `
    )
    .run(workTitle, username, commentText);
  return info.changes ?? 0;
}
