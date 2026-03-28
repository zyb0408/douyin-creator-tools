import fs from "node:fs";
import path from "node:path";
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

app.get("/api/wordcloud", (_req, res) => {
  const filePath = path.resolve("data/wordcloud.json");
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    res.json(data);
  } catch {
    res.status(404).json({ error: "词云数据不存在，请先运行 npm run wordcloud" });
  }
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

  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,249,0.015) 2px, rgba(0,255,249,0.015) 4px);
    pointer-events: none;
    z-index: 9999;
  }

  /* ── Header ── */
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
  .logo { font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 22px; color: var(--cyan); text-shadow: 0 0 12px var(--cyan); letter-spacing: 4px; }
  .logo span { color: var(--magenta); text-shadow: 0 0 12px var(--magenta); }
  .stats-bar { display: flex; gap: 20px; font-size: 12px; color: var(--dim); margin-left: auto; }
  .stat { display: flex; flex-direction: column; align-items: center; }
  .stat-val { font-size: 20px; font-family: 'Rajdhani', sans-serif; font-weight: 700; color: var(--cyan); text-shadow: 0 0 8px var(--cyan); }
  .stat-val.mag { color: var(--magenta); text-shadow: 0 0 8px var(--magenta); }
  .stat-val.grn { color: var(--green); text-shadow: 0 0 8px var(--green); }

  /* ── Word Cloud ── */
  .wc-section { flex-shrink: 0; }
  .wc-toggle-bar {
    display: flex; align-items: center; padding: 6px 16px;
    background: var(--bg2); border-bottom: 1px solid var(--border);
    gap: 12px; cursor: pointer; user-select: none;
  }
  .wc-toggle-bar:hover { background: var(--bg3); }
  .wc-label { font-size: 11px; letter-spacing: 3px; color: var(--magenta); text-shadow: 0 0 8px var(--magenta); }
  .wc-meta-inline { font-size: 10px; color: var(--dim); flex: 1; }
  .wc-meta-inline span { color: var(--cyan); }
  .wc-chevron { font-size: 10px; color: var(--dim); transition: transform 0.2s; }
  .wc-chevron.collapsed { transform: rotate(-90deg); }
  .wc-body { height: 220px; position: relative; overflow: hidden; transition: height 0.25s ease; background: var(--bg); }
  .wc-body.collapsed { height: 0; }
  #wcCanvas { position: absolute; inset: 0; }

  /* ── Toolbar ── */
  .toolbar {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid var(--border);
    background: var(--bg2); flex-shrink: 0; flex-wrap: wrap;
  }
  .search-wrap { position: relative; flex: 1; min-width: 200px; }
  .search-wrap::before {
    content: '//'; position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
    color: var(--cyan); font-size: 12px; pointer-events: none;
  }
  .clear-btn {
    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    background: none; border: none; color: var(--dim); cursor: pointer;
    font-size: 14px; line-height: 1; display: none;
  }
  .clear-btn.visible { display: block; }
  .clear-btn:hover { color: var(--cyan); }
  input[type=text] {
    width: 100%; background: var(--bg3); border: 1px solid var(--border);
    color: var(--text); font-family: 'Share Tech Mono', monospace;
    font-size: 13px; padding: 7px 28px 7px 30px; outline: none; transition: border-color 0.2s;
  }
  input[type=text]:focus { border-color: var(--cyan); box-shadow: 0 0 8px rgba(0,255,249,0.2); }

  .filter-group { display: flex; gap: 6px; }
  .filter-btn {
    background: transparent; border: 1px solid var(--border); color: var(--dim);
    font-family: 'Share Tech Mono', monospace; font-size: 11px; padding: 6px 12px;
    cursor: pointer; letter-spacing: 1px; transition: all 0.15s;
  }
  .filter-btn:hover { border-color: var(--cyan); color: var(--cyan); }
  .filter-btn.active { border-color: var(--cyan); color: var(--cyan); background: rgba(0,255,249,0.08); box-shadow: 0 0 8px rgba(0,255,249,0.2); }
  .filter-btn.mag.active { border-color: var(--magenta); color: var(--magenta); background: rgba(255,0,200,0.08); box-shadow: 0 0 8px rgba(255,0,200,0.2); }
  .filter-btn.grn.active { border-color: var(--green); color: var(--green); background: rgba(0,255,157,0.08); box-shadow: 0 0 8px rgba(0,255,157,0.2); }

  .kw-tag {
    display: inline-flex; align-items: center; gap: 6px;
    background: rgba(255,0,200,0.12); border: 1px solid var(--magenta);
    color: var(--magenta); font-size: 11px; padding: 3px 10px;
    letter-spacing: 1px; white-space: nowrap;
  }
  .kw-tag button { background: none; border: none; color: var(--magenta); cursor: pointer; font-size: 13px; line-height: 1; }
  .kw-tag button:hover { color: #fff; }

  .result-info { font-size: 11px; color: var(--dim); white-space: nowrap; margin-left: auto; }
  .result-info span { color: var(--yellow); }

  /* ── Table ── */
  .table-wrap { flex: 1; overflow-y: auto; }
  .table-wrap::-webkit-scrollbar { width: 5px; }
  .table-wrap::-webkit-scrollbar-track { background: var(--bg); }
  .table-wrap::-webkit-scrollbar-thumb { background: var(--border); }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead th {
    position: sticky; top: 0; background: var(--bg2);
    padding: 8px 14px; text-align: left; font-family: 'Rajdhani', sans-serif;
    font-weight: 700; font-size: 12px; letter-spacing: 3px;
    color: var(--magenta); border-bottom: 1px solid var(--border);
    text-shadow: 0 0 8px var(--magenta); z-index: 1;
  }
  tbody tr { border-bottom: 1px solid rgba(26,26,74,0.5); transition: background 0.1s; }
  tbody tr:hover { background: rgba(0,255,249,0.03); }
  td { padding: 10px 14px; vertical-align: top; }

  .td-user { width: 110px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--cyan); font-size: 12px; }
  .td-comment { color: var(--text); line-height: 1.5; word-break: break-all; }
  .td-reply { width: 220px; font-size: 12px; color: var(--green); word-break: break-all; line-height: 1.5; }
  .td-reply.empty { color: var(--border); font-style: italic; }

  .hl { background: rgba(255,230,0,0.2); color: var(--yellow); border-radius: 2px; }

  .empty-state {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; height: 200px; color: var(--dim);
    font-size: 13px; letter-spacing: 2px;
  }
  .empty-state::before {
    content: '// NO DATA //'; display: block; color: var(--border);
    font-size: 20px; margin-bottom: 12px; letter-spacing: 6px;
  }

  /* ── Pagination ── */
  .pagination {
    display: flex; align-items: center; gap: 8px; padding: 10px 16px;
    border-top: 1px solid var(--border); background: var(--bg2);
    flex-shrink: 0; justify-content: flex-end;
  }
  .page-btn {
    background: transparent; border: 1px solid var(--border); color: var(--dim);
    font-family: 'Share Tech Mono', monospace; font-size: 12px;
    padding: 5px 14px; cursor: pointer; transition: all 0.15s;
  }
  .page-btn:hover:not(:disabled) { border-color: var(--cyan); color: var(--cyan); }
  .page-btn:disabled { opacity: 0.3; cursor: default; }
  .page-info { font-size: 12px; color: var(--dim); }
  .page-info span { color: var(--cyan); }

  .loading {
    position: fixed; inset: 0; background: rgba(5,5,16,0.7);
    display: flex; align-items: center; justify-content: center;
    z-index: 100; font-size: 16px; letter-spacing: 8px;
    color: var(--cyan); text-shadow: 0 0 20px var(--cyan);
  }
  .loading.hidden { display: none; }

  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.2} }
  .blink { animation: blink 1.2s infinite; }

  .content { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
</style>
</head>
<body>

<div class="loading hidden" id="loading">LOADING<span class="blink">_</span></div>

<header>
  <div class="logo">DOUYIN<span>//</span>TERMINAL</div>
  <div class="stats-bar">
    <div class="stat"><div class="stat-val" id="statComments">-</div><div>COMMENTS</div></div>
    <div class="stat"><div class="stat-val mag" id="statWorks">-</div><div>WORKS</div></div>
    <div class="stat"><div class="stat-val grn" id="statReplied">-</div><div>REPLIED</div></div>
  </div>
</header>

<div class="wc-section">
  <div class="wc-toggle-bar" onclick="toggleWc()">
    <div class="wc-label">// WORD CLOUD</div>
    <div class="wc-meta-inline" id="wcMeta"></div>
    <div class="wc-chevron" id="wcChevron">▼</div>
  </div>
  <div class="wc-body" id="wcBody">
    <canvas id="wcCanvas"></canvas>
  </div>
</div>

<div class="content">
  <div class="toolbar">
    <div class="search-wrap">
      <input type="text" id="searchInput" placeholder="搜索用户名 / 评论内容..." />
      <button class="clear-btn" id="clearBtn" onclick="clearSearch()">✕</button>
    </div>
    <div id="kwTag" style="display:none"></div>
    <div class="filter-group">
      <button class="filter-btn active" onclick="setFilter(this,'all')">ALL</button>
      <button class="filter-btn mag" onclick="setFilter(this,0)">UNREPLIED</button>
      <button class="filter-btn grn" onclick="setFilter(this,1)">REPLIED</button>
    </div>
    <div class="result-info">共 <span id="totalCount">-</span> 条</div>
  </div>

  <div class="table-wrap" id="tableWrap"></div>

  <div class="pagination">
    <button class="page-btn" id="btnPrev" onclick="gotoPage(state.page-1)" disabled>◀ PREV</button>
    <div class="page-info">PAGE <span id="pageNum">1</span> / <span id="pageTotal">1</span></div>
    <button class="page-btn" id="btnNext" onclick="gotoPage(state.page+1)" disabled>NEXT ▶</button>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/wordcloud@1.2.2/src/wordcloud2.js"></script>
<script>
const state = { q: '', replied: null, page: 1, limit: 50 };
let searchTimer = null;

async function fetchStats() {
  const r = await fetch('/api/stats').then(r => r.json());
  document.getElementById('statComments').textContent = r.totalComments;
  document.getElementById('statWorks').textContent = r.totalWorks;
  document.getElementById('statReplied').textContent = r.totalReplied;
}

function setFilter(btn, val) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.replied = val === 'all' ? null : Number(val);
  state.page = 1;
  loadComments();
}

function gotoPage(p) { state.page = p; loadComments(); }

function clearSearch() {
  state.q = '';
  state.page = 1;
  document.getElementById('searchInput').value = '';
  document.getElementById('clearBtn').classList.remove('visible');
  document.getElementById('kwTag').style.display = 'none';
  loadComments();
}

function setKeyword(word) {
  state.q = word;
  state.page = 1;
  document.getElementById('searchInput').value = word;
  document.getElementById('clearBtn').classList.add('visible');
  const tag = document.getElementById('kwTag');
  tag.style.display = 'inline-flex';
  tag.innerHTML = \`<span class="kw-tag">WORD: \${esc(word)} <button onclick="clearSearch()">✕</button></span>\`;
  loadComments();
}

async function loadComments() {
  setLoading(true);
  try {
    const data = await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: state.q || undefined, replied: state.replied, page: state.page, limit: state.limit })
    }).then(r => r.json());
    renderTable(data.comments, data.total);
    renderPagination(data.total);
  } finally {
    setLoading(false);
  }
}

function highlight(text, q) {
  if (!q) return esc(text);
  const lower = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  let idx = lower.indexOf(lowerQ);
  if (idx === -1) return esc(text);
  let result = '', last = 0;
  while (idx !== -1) {
    result += esc(text.slice(last, idx));
    result += '<span class="hl">' + esc(text.slice(idx, idx + q.length)) + '</span>';
    last = idx + q.length;
    idx = lower.indexOf(lowerQ, last);
  }
  return result + esc(text.slice(last));
}

function renderTable(rows, total) {
  document.getElementById('totalCount').textContent = total;
  const wrap = document.getElementById('tableWrap');
  if (!rows.length) { wrap.innerHTML = '<div class="empty-state">无匹配数据</div>'; return; }

  let html = \`<table><thead><tr><th>USER</th><th>COMMENT</th><th>REPLY</th></tr></thead><tbody>\`;
  for (const row of rows) {
    const hasReply = row.reply_message?.trim();
    html += \`<tr>
      <td class="td-user">\${esc(maskUser(row.username))}</td>
      <td class="td-comment">\${highlight(row.comment_text, state.q)}</td>
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

function setLoading(on) { document.getElementById('loading').classList.toggle('hidden', !on); }
function esc(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function maskUser(s) {
  const c = [...String(s??'')];
  if (c.length<=1) return '*';
  if (c.length===2) return c[0]+'*';
  return c[0]+'**'+c[c.length-1];
}

// ── Word cloud ──
function toggleWc() {
  const body = document.getElementById('wcBody');
  const collapsed = body.classList.toggle('collapsed');
  document.getElementById('wcChevron').classList.toggle('collapsed', collapsed);
}

async function loadWordcloud() {
  const meta = document.getElementById('wcMeta');
  const canvas = document.getElementById('wcCanvas');
  meta.innerHTML = 'LOADING<span class="blink">_</span>';
  let data;
  try { data = await fetch('/api/wordcloud').then(r=>r.json()); }
  catch { meta.innerHTML='加载失败'; return; }
  if (data.error) { meta.innerHTML=data.error; return; }

  const words = data.words;
  const maxC = words[0]?.[1]??1, minC = words[words.length-1]?.[1]??1;
  const body = document.getElementById('wcBody');
  canvas.width = body.clientWidth;
  canvas.height = body.clientHeight;

  const list = words.map(([w,c]) => {
    const r = (c-minC)/(maxC-minC+1);
    return [w, Math.round(10+Math.pow(r,0.45)*60)];
  });

  meta.innerHTML = \`更新于 <span>\${new Date(data.updatedAt).toLocaleString('zh-CN')}</span> &nbsp;·&nbsp; 共 <span>\${data.total}</span> 词 &nbsp;·&nbsp; 点击词可筛选评论\`;

  WordCloud(canvas, {
    list, gridSize: 8, weightFactor: 1,
    fontFamily: "'Rajdhani','Noto Sans SC',sans-serif",
    color: () => ['#00fff9','#ff00c8','#ffe600','#00ff9d','#a78bfa','#60a5fa'][Math.floor(Math.random()*6)],
    backgroundColor: '#050510',
    rotateRatio: 0.25, rotationSteps: 2,
    shuffle: true, drawOutOfBound: false, shrinkToFit: true, cursor: 'pointer',
    click: (item) => setKeyword(item[0])
  });
}

document.getElementById('searchInput').addEventListener('input', e => {
  const val = e.target.value.trim();
  document.getElementById('clearBtn').classList.toggle('visible', val.length > 0);
  document.getElementById('kwTag').style.display = 'none';
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = val; state.page = 1; loadComments(); }, 350);
});

(async () => {
  await Promise.all([fetchStats(), loadWordcloud()]);
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
