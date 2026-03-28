import express from "express";
import { getDb } from "./lib/db.mjs";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── API ──────────────────────────────────────────────────────

app.get("/api/stats", (_req, res) => {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) AS total FROM comments").get();
  const works = db.prepare("SELECT COUNT(DISTINCT work_title) AS total FROM comments").get();
  const replied = db.prepare("SELECT COUNT(*) AS total FROM comments WHERE reply_message IS NOT NULL AND reply_message != ''").get();
  res.json({ totalComments: total.total, totalWorks: works.total, totalReplied: replied.total });
});

app.get("/api/works", (_req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      work_title,
      COUNT(*) AS total,
      SUM(CASE WHEN reply_message IS NOT NULL AND reply_message != '' THEN 1 ELSE 0 END) AS replied
    FROM comments
    GROUP BY work_title
    ORDER BY total DESC
  `).all();
  res.json(rows);
});

app.post("/api/comments", (req, res) => {
  const { work, q, replied, page = 1, limit = 50 } = req.body ?? {};
  const db = getDb();
  const offset = (Math.max(1, page) - 1) * limit;

  const conditions = [];
  const params = [];

  if (work) {
    conditions.push("work_title = ?");
    params.push(work);
  }
  if (q) {
    conditions.push("(username LIKE ? OR comment_text LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  if (replied === true || replied === 1) {
    conditions.push("reply_message IS NOT NULL AND reply_message != ''");
  } else if (replied === false || replied === 0) {
    conditions.push("(reply_message IS NULL OR reply_message = '')");
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRow = db.prepare(`SELECT COUNT(*) AS total FROM comments ${where}`).get(...params);
  const rows = db.prepare(`SELECT id, work_title, username, comment_text, reply_message FROM comments ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);

  res.json({ total: countRow.total, page, limit, comments: rows });
});

// ── HTML ─────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DOUYIN // COMMENT TERMINAL</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@500;700&display=swap" rel="stylesheet">
<style>
  :root {
    --cyan: #00fff9;
    --magenta: #ff00c8;
    --yellow: #ffe600;
    --bg: #050510;
    --bg2: #0a0a1f;
    --bg3: #0f0f2d;
    --border: #1a1a4a;
    --text: #c8d6f0;
    --dim: #5a6a8a;
    --green: #00ff9d;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Share Tech Mono', monospace;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* scanline overlay */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background: repeating-linear-gradient(
      0deg,
      transparent,
      transparent 2px,
      rgba(0,255,249,0.015) 2px,
      rgba(0,255,249,0.015) 4px
    );
    pointer-events: none;
    z-index: 9999;
  }

  header {
    padding: 10px 24px;
    border-bottom: 1px solid var(--cyan);
    display: flex;
    align-items: center;
    gap: 24px;
    background: var(--bg2);
    box-shadow: 0 0 20px rgba(0,255,249,0.15);
    flex-shrink: 0;
  }

  .logo {
    font-family: 'Rajdhani', sans-serif;
    font-weight: 700;
    font-size: 22px;
    color: var(--cyan);
    text-shadow: 0 0 12px var(--cyan);
    letter-spacing: 4px;
    white-space: nowrap;
  }
  .logo span { color: var(--magenta); text-shadow: 0 0 12px var(--magenta); }

  .stats-bar {
    display: flex;
    gap: 20px;
    font-size: 12px;
    color: var(--dim);
    margin-left: auto;
    flex-wrap: wrap;
  }
  .stat { display: flex; flex-direction: column; align-items: center; }
  .stat-val { font-size: 20px; font-family: 'Rajdhani', sans-serif; font-weight: 700; color: var(--cyan); text-shadow: 0 0 8px var(--cyan); }
  .stat-val.mag { color: var(--magenta); text-shadow: 0 0 8px var(--magenta); }
  .stat-val.grn { color: var(--green); text-shadow: 0 0 8px var(--green); }

  .main {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  /* ── Works sidebar ── */
  .sidebar {
    width: 220px;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    background: var(--bg2);
    overflow: hidden;
  }

  .sidebar-header {
    padding: 10px 14px;
    font-size: 11px;
    color: var(--magenta);
    letter-spacing: 3px;
    border-bottom: 1px solid var(--border);
    text-shadow: 0 0 8px var(--magenta);
    flex-shrink: 0;
  }

  .works-list {
    flex: 1;
    overflow-y: auto;
  }

  .works-list::-webkit-scrollbar { width: 4px; }
  .works-list::-webkit-scrollbar-track { background: var(--bg); }
  .works-list::-webkit-scrollbar-thumb { background: var(--border); }

  .work-item {
    padding: 9px 14px;
    cursor: pointer;
    border-bottom: 1px solid rgba(26,26,74,0.5);
    transition: all 0.15s;
    position: relative;
  }
  .work-item::before {
    content: '';
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 2px;
    background: var(--cyan);
    transform: scaleY(0);
    transition: transform 0.15s;
  }
  .work-item:hover { background: var(--bg3); }
  .work-item.active { background: var(--bg3); }
  .work-item.active::before { transform: scaleY(1); }

  .work-title {
    font-size: 12px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 3px;
  }
  .work-item.active .work-title { color: var(--cyan); }

  .work-meta {
    font-size: 10px;
    color: var(--dim);
    display: flex;
    gap: 8px;
  }
  .work-meta .replied { color: var(--green); }

  /* ── Content panel ── */
  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg);
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg2);
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .search-wrap {
    position: relative;
    flex: 1;
    min-width: 160px;
  }
  .search-wrap::before {
    content: '//';
    position: absolute;
    left: 10px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--cyan);
    font-size: 12px;
    pointer-events: none;
  }
  input[type=text] {
    width: 100%;
    background: var(--bg3);
    border: 1px solid var(--border);
    color: var(--text);
    font-family: 'Share Tech Mono', monospace;
    font-size: 13px;
    padding: 7px 12px 7px 30px;
    outline: none;
    transition: border-color 0.2s;
  }
  input[type=text]:focus { border-color: var(--cyan); box-shadow: 0 0 8px rgba(0,255,249,0.2); }

  .filter-group { display: flex; gap: 6px; }
  .filter-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--dim);
    font-family: 'Share Tech Mono', monospace;
    font-size: 11px;
    padding: 6px 12px;
    cursor: pointer;
    letter-spacing: 1px;
    transition: all 0.15s;
  }
  .filter-btn:hover { border-color: var(--cyan); color: var(--cyan); }
  .filter-btn.active { border-color: var(--cyan); color: var(--cyan); background: rgba(0,255,249,0.08); box-shadow: 0 0 8px rgba(0,255,249,0.2); }
  .filter-btn.mag.active { border-color: var(--magenta); color: var(--magenta); background: rgba(255,0,200,0.08); box-shadow: 0 0 8px rgba(255,0,200,0.2); }
  .filter-btn.grn.active { border-color: var(--green); color: var(--green); background: rgba(0,255,157,0.08); box-shadow: 0 0 8px rgba(0,255,157,0.2); }

  .result-info {
    font-size: 11px;
    color: var(--dim);
    white-space: nowrap;
  }
  .result-info span { color: var(--yellow); }

  /* ── Table ── */
  .table-wrap {
    flex: 1;
    overflow-y: auto;
  }
  .table-wrap::-webkit-scrollbar { width: 5px; }
  .table-wrap::-webkit-scrollbar-track { background: var(--bg); }
  .table-wrap::-webkit-scrollbar-thumb { background: var(--border); }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  thead th {
    position: sticky;
    top: 0;
    background: var(--bg2);
    padding: 8px 14px;
    text-align: left;
    font-family: 'Rajdhani', sans-serif;
    font-weight: 700;
    font-size: 12px;
    letter-spacing: 3px;
    color: var(--magenta);
    border-bottom: 1px solid var(--border);
    text-shadow: 0 0 8px var(--magenta);
    z-index: 1;
  }

  tbody tr {
    border-bottom: 1px solid rgba(26,26,74,0.5);
    transition: background 0.1s;
  }
  tbody tr:hover { background: rgba(0,255,249,0.03); }

  td {
    padding: 10px 14px;
    vertical-align: top;
  }

  .td-work {
    width: 160px;
    font-size: 11px;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 160px;
  }

  .td-user {
    width: 120px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--cyan);
    font-size: 12px;
  }

  .td-comment { color: var(--text); line-height: 1.5; word-break: break-all; }

  .td-reply {
    width: 200px;
    font-size: 12px;
    color: var(--green);
    word-break: break-all;
    line-height: 1.5;
  }
  .td-reply.empty { color: var(--border); font-style: italic; }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 200px;
    color: var(--dim);
    font-size: 13px;
    letter-spacing: 2px;
  }
  .empty-state::before {
    content: '// NO DATA //';
    display: block;
    color: var(--border);
    font-size: 20px;
    margin-bottom: 12px;
    letter-spacing: 6px;
  }

  /* ── Pagination ── */
  .pagination {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border-top: 1px solid var(--border);
    background: var(--bg2);
    flex-shrink: 0;
    justify-content: flex-end;
  }

  .page-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--dim);
    font-family: 'Share Tech Mono', monospace;
    font-size: 12px;
    padding: 5px 14px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .page-btn:hover:not(:disabled) { border-color: var(--cyan); color: var(--cyan); }
  .page-btn:disabled { opacity: 0.3; cursor: default; }
  .page-info { font-size: 12px; color: var(--dim); }
  .page-info span { color: var(--cyan); }

  .loading {
    position: fixed;
    inset: 0;
    background: rgba(5,5,16,0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    font-size: 16px;
    letter-spacing: 8px;
    color: var(--cyan);
    text-shadow: 0 0 20px var(--cyan);
  }
  .loading.hidden { display: none; }

  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.2} }
  .blink { animation: blink 1.2s infinite; }
</style>
</head>
<body>

<div class="loading hidden" id="loading">LOADING<span class="blink">_</span></div>

<header>
  <div class="logo">DOUYIN<span>//</span>TERMINAL</div>
  <div class="stats-bar" id="statsBar">
    <div class="stat"><div class="stat-val" id="statComments">-</div><div>COMMENTS</div></div>
    <div class="stat"><div class="stat-val mag" id="statWorks">-</div><div>WORKS</div></div>
    <div class="stat"><div class="stat-val grn" id="statReplied">-</div><div>REPLIED</div></div>
  </div>
</header>

<div class="main">
  <aside class="sidebar">
    <div class="sidebar-header">// WORKS</div>
    <div class="works-list" id="worksList"></div>
  </aside>

  <div class="content">
    <div class="toolbar">
      <div class="search-wrap">
        <input type="text" id="searchInput" placeholder="搜索用户名 / 评论内容..." />
      </div>
      <div class="filter-group">
        <button class="filter-btn active" data-replied="all" onclick="setFilter(this,'all')">ALL</button>
        <button class="filter-btn mag" data-replied="0" onclick="setFilter(this,0)">UNREPLIED</button>
        <button class="filter-btn grn" data-replied="1" onclick="setFilter(this,1)">REPLIED</button>
      </div>
      <div class="result-info">共 <span id="totalCount">-</span> 条</div>
    </div>

    <div class="table-wrap" id="tableWrap">
      <div class="empty-state">选择左侧作品开始查询</div>
    </div>

    <div class="pagination">
      <button class="page-btn" id="btnPrev" onclick="gotoPage(state.page - 1)" disabled>◀ PREV</button>
      <div class="page-info">PAGE <span id="pageNum">1</span> / <span id="pageTotal">1</span></div>
      <button class="page-btn" id="btnNext" onclick="gotoPage(state.page + 1)" disabled>NEXT ▶</button>
    </div>
  </div>
</div>

<script>
const state = { work: null, q: '', replied: null, page: 1, limit: 50, total: 0 };
let searchTimer = null;

async function fetchStats() {
  const r = await fetch('/api/stats').then(r => r.json());
  document.getElementById('statComments').textContent = r.totalComments;
  document.getElementById('statWorks').textContent = r.totalWorks;
  document.getElementById('statReplied').textContent = r.totalReplied;
}

async function fetchWorks() {
  const rows = await fetch('/api/works').then(r => r.json());
  const el = document.getElementById('worksList');
  el.innerHTML = '';

  // "全部" 选项
  const allItem = document.createElement('div');
  allItem.className = 'work-item active';
  allItem.dataset.title = '';
  allItem.innerHTML = \`
    <div class="work-title" style="color:var(--cyan)">// 全部作品</div>
    <div class="work-meta"><span>\${rows.reduce((s,r)=>s+r.total,0)} 条</span></div>
  \`;
  allItem.onclick = () => selectWork(allItem, '');
  el.appendChild(allItem);

  rows.forEach(row => {
    const item = document.createElement('div');
    item.className = 'work-item';
    item.dataset.title = row.work_title;
    item.innerHTML = \`
      <div class="work-title">\${esc(row.work_title)}</div>
      <div class="work-meta">
        <span>\${row.total}</span>
        \${row.replied > 0 ? \`<span class="replied">✓\${row.replied}</span>\` : ''}
      </div>
    \`;
    item.onclick = () => selectWork(item, row.work_title);
    el.appendChild(item);
  });
}

function selectWork(el, title) {
  document.querySelectorAll('.work-item').forEach(i => i.classList.remove('active'));
  el.classList.add('active');
  state.work = title || null;
  state.page = 1;
  loadComments();
}

function setFilter(btn, val) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.replied = val === 'all' ? null : Number(val);
  state.page = 1;
  loadComments();
}

function gotoPage(p) {
  state.page = p;
  loadComments();
}

async function loadComments() {
  setLoading(true);
  try {
    const body = {
      work: state.work || undefined,
      q: state.q || undefined,
      replied: state.replied,
      page: state.page,
      limit: state.limit
    };
    const data = await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(r => r.json());

    state.total = data.total;
    renderTable(data.comments, data.total);
    renderPagination(data.total);
  } finally {
    setLoading(false);
  }
}

function renderTable(rows, total) {
  document.getElementById('totalCount').textContent = total;
  const wrap = document.getElementById('tableWrap');

  if (!rows.length) {
    wrap.innerHTML = '<div class="empty-state">无匹配数据</div>';
    return;
  }

  const showWork = !state.work;

  let html = \`<table><thead><tr>
    \${showWork ? '<th>WORK</th>' : ''}
    <th>USER</th>
    <th>COMMENT</th>
    <th>REPLY</th>
  </tr></thead><tbody>\`;

  for (const row of rows) {
    const hasReply = row.reply_message && row.reply_message.trim();
    html += \`<tr>
      \${showWork ? \`<td class="td-work" title="\${esc(row.work_title)}">\${esc(row.work_title)}</td>\` : ''}
      <td class="td-user">\${esc(row.username)}</td>
      <td class="td-comment">\${esc(row.comment_text)}</td>
      <td class="td-reply \${hasReply ? '' : 'empty'}">\${hasReply ? esc(row.reply_message) : '—'}</td>
    </tr>\`;
  }

  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function renderPagination(total) {
  const pages = Math.max(1, Math.ceil(total / state.limit));
  document.getElementById('pageNum').textContent = state.page;
  document.getElementById('pageTotal').textContent = pages;
  document.getElementById('btnPrev').disabled = state.page <= 1;
  document.getElementById('btnNext').disabled = state.page >= pages;
}

function setLoading(on) {
  document.getElementById('loading').classList.toggle('hidden', !on);
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Search debounce
document.getElementById('searchInput').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    state.page = 1;
    loadComments();
  }, 350);
});

// Init
(async () => {
  await fetchStats();
  await fetchWorks();
  await loadComments();
})();
</script>
</body>
</html>`;

app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(HTML);
});

// ── Start ─────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  DOUYIN // COMMENT TERMINAL`);
  console.log(`  http://localhost:${PORT}\n`);
});
