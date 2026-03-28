import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_DB_PATH = path.resolve("data/douyin-creator.db");

let _db = null;

export function getDb() {
  if (_db) {
    return _db;
  }

  const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      work_title   TEXT NOT NULL,
      username     TEXT NOT NULL,
      comment_text TEXT NOT NULL,
      reply_message TEXT,
      UNIQUE(work_title, username, comment_text)
    )
  `);

  return _db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
