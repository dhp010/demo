const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BASE = __dirname;

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ── STORAGE ABSTRACTION ──────────────────────────────────
function buildMemoryStorage() {
  const mem = {
    notebooks: [
      { id: genId(), name: '내 노트북', color: 0 },
      { id: genId(), name: '아이디어', color: 1 },
    ],
    notes: [],
  };
  return {
    init: async () => {},
    getData: async () => ({ notebooks: [...mem.notebooks], notes: mem.notes.map(n => ({ ...n })) }),
    upsertNote: async (id, n) => {
      const row = {
        id, title: n.title || '', content: n.content || '',
        content_text: n.contentText || '', tags: n.tags || [],
        notebook_id: n.notebookId || null, pinned: !!n.pinned,
        deleted: !!n.deleted, created_at: n.createdAt || Date.now(),
        updated_at: n.updatedAt || Date.now(),
      };
      const i = mem.notes.findIndex(x => x.id === id);
      if (i >= 0) mem.notes[i] = row; else mem.notes.unshift(row);
    },
    deleteNote: async (id) => { mem.notes = mem.notes.filter(n => n.id !== id); },
    upsertNotebook: async (id, nb) => {
      const row = { id, name: nb.name || '노트북', color: nb.color || 0 };
      const i = mem.notebooks.findIndex(x => x.id === id);
      if (i >= 0) mem.notebooks[i] = row; else mem.notebooks.push(row);
    },
    deleteNotebook: async (id) => {
      mem.notes = mem.notes.map(n => n.notebook_id === id ? { ...n, deleted: true } : n);
      mem.notebooks = mem.notebooks.filter(n => n.id !== id);
    },
  };
}

function buildPgStorage(pool) {
  return {
    init: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS notebooks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          color INTEGER DEFAULT 0
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY,
          title TEXT DEFAULT '',
          content TEXT DEFAULT '',
          content_text TEXT DEFAULT '',
          tags JSONB DEFAULT '[]',
          notebook_id TEXT,
          pinned BOOLEAN DEFAULT false,
          deleted BOOLEAN DEFAULT false,
          created_at BIGINT,
          updated_at BIGINT
        )`);
      const { rows } = await pool.query('SELECT COUNT(*) FROM notebooks');
      if (parseInt(rows[0].count) === 0) {
        await pool.query('INSERT INTO notebooks (id,name,color) VALUES ($1,$2,$3)', [genId(), '내 노트북', 0]);
        await pool.query('INSERT INTO notebooks (id,name,color) VALUES ($1,$2,$3)', [genId(), '아이디어', 1]);
      }
    },
    getData: async () => {
      const [nbs, notes] = await Promise.all([
        pool.query('SELECT * FROM notebooks ORDER BY name'),
        pool.query('SELECT * FROM notes ORDER BY updated_at DESC NULLS LAST'),
      ]);
      return { notebooks: nbs.rows, notes: notes.rows };
    },
    upsertNote: async (id, n) => {
      await pool.query(`
        INSERT INTO notes (id,title,content,content_text,tags,notebook_id,pinned,deleted,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (id) DO UPDATE SET
          title=$2, content=$3, content_text=$4, tags=$5,
          notebook_id=$6, pinned=$7, deleted=$8, updated_at=$10`,
        [id, n.title || '', n.content || '', n.contentText || '',
         JSON.stringify(n.tags || []), n.notebookId || null,
         !!n.pinned, !!n.deleted,
         n.createdAt || Date.now(), n.updatedAt || Date.now()]);
    },
    deleteNote: async (id) => pool.query('DELETE FROM notes WHERE id=$1', [id]),
    upsertNotebook: async (id, nb) => {
      await pool.query(`
        INSERT INTO notebooks (id,name,color) VALUES ($1,$2,$3)
        ON CONFLICT (id) DO UPDATE SET name=$2, color=$3`,
        [id, nb.name || '노트북', nb.color || 0]);
    },
    deleteNotebook: async (id) => {
      await pool.query('UPDATE notes SET deleted=true WHERE notebook_id=$1', [id]);
      await pool.query('DELETE FROM notebooks WHERE id=$1', [id]);
    },
  };
}

let storage;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  });
  storage = buildPgStorage(pool);
  console.log('PostgreSQL 연결됨');
} else {
  console.warn('[경고] DATABASE_URL 미설정 — 인메모리 저장소 사용 (재시작 시 초기화됨)');
  storage = buildMemoryStorage();
}

// ── HTTP ─────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function parseBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (urlPath.startsWith('/api/')) {
    try {
      if (req.method === 'GET' && urlPath === '/api/data') {
        return json(res, await storage.getData());
      }
      if (req.method === 'PUT' && urlPath.startsWith('/api/notes/')) {
        const id = urlPath.slice('/api/notes/'.length);
        await storage.upsertNote(id, await parseBody(req));
        return json(res, { ok: true });
      }
      if (req.method === 'DELETE' && urlPath.startsWith('/api/notes/')) {
        await storage.deleteNote(urlPath.slice('/api/notes/'.length));
        return json(res, { ok: true });
      }
      if (req.method === 'PUT' && urlPath.startsWith('/api/notebooks/')) {
        const id = urlPath.slice('/api/notebooks/'.length);
        await storage.upsertNotebook(id, await parseBody(req));
        return json(res, { ok: true });
      }
      if (req.method === 'DELETE' && urlPath.startsWith('/api/notebooks/')) {
        await storage.deleteNotebook(urlPath.slice('/api/notebooks/'.length));
        return json(res, { ok: true });
      }
      return json(res, { error: 'Not found' }, 404);
    } catch (e) {
      console.error('API 오류:', e.message);
      return json(res, { error: e.message }, 500);
    }
  }

  // Static files
  const filePath = path.join(BASE, urlPath === '/' ? 'evernote_clone.html' : urlPath);
  if (!filePath.startsWith(BASE)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

storage.init()
  .then(() => server.listen(PORT, '0.0.0.0', () => console.log(`서버 실행 중: http://localhost:${PORT}`)))
  .catch(err => { console.error('초기화 실패:', err); process.exit(1); });
