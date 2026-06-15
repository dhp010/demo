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
    cardio: [],
    weight: [],
  };
  return {
    init: async () => {},

    // ── 노트 (기존) ──
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

    // ── 피트니스 ──
    getFitnessRecords: async () => ({
      cardio: [...mem.cardio].sort((a, b) => b.created_at - a.created_at),
      weight: [...mem.weight].sort((a, b) => b.created_at - a.created_at),
    }),
    addCardio: async (rec) => { mem.cardio.unshift(rec); },
    addWeight: async (rec) => { mem.weight.unshift(rec); },
    deleteCardio: async (id) => { mem.cardio = mem.cardio.filter(r => r.id !== id); },
    deleteWeight: async (id) => { mem.weight = mem.weight.filter(r => r.id !== id); },
  };
}

function buildTursoStorage(client) {
  function toNote(n) {
    return {
      id: n.id,
      title: n.title || '',
      content: n.content || '',
      content_text: n.content_text || '',
      tags: typeof n.tags === 'string' ? JSON.parse(n.tags || '[]') : (n.tags || []),
      notebook_id: n.notebook_id,
      pinned: !!n.pinned,
      deleted: !!n.deleted,
      created_at: Number(n.created_at),
      updated_at: Number(n.updated_at),
    };
  }

  function toCardio(r) {
    return {
      id: r.id,
      date: r.date,
      activity: r.activity,
      distance_km: Number(r.distance_km),
      duration_min: Number(r.duration_min),
      body_weight_kg: Number(r.body_weight_kg),
      calories: Number(r.calories),
      created_at: Number(r.created_at),
    };
  }

  function toWeight(r) {
    return {
      id: r.id,
      date: r.date,
      exercise: r.exercise,
      exercise_type: r.exercise_type,
      weight_kg: Number(r.weight_kg),
      sets: Number(r.sets),
      reps: Number(r.reps),
      one_rm: r.one_rm != null ? Number(r.one_rm) : null,
      calories: Number(r.calories),
      created_at: Number(r.created_at),
    };
  }

  return {
    init: async () => {
      // 기존 노트 테이블
      await client.execute(`
        CREATE TABLE IF NOT EXISTS notebooks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          color INTEGER DEFAULT 0
        )`);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY,
          title TEXT DEFAULT '',
          content TEXT DEFAULT '',
          content_text TEXT DEFAULT '',
          tags TEXT DEFAULT '[]',
          notebook_id TEXT,
          pinned INTEGER DEFAULT 0,
          deleted INTEGER DEFAULT 0,
          created_at INTEGER,
          updated_at INTEGER
        )`);
      const res = await client.execute('SELECT COUNT(*) as cnt FROM notebooks');
      if (Number(res.rows[0].cnt) === 0) {
        await client.batch([
          { sql: 'INSERT INTO notebooks (id,name,color) VALUES (?,?,?)', args: [genId(), '내 노트북', 0] },
          { sql: 'INSERT INTO notebooks (id,name,color) VALUES (?,?,?)', args: [genId(), '아이디어', 1] },
        ], 'write');
      }

      // 피트니스 테이블
      await client.execute(`
        CREATE TABLE IF NOT EXISTS fitness_cardio (
          id TEXT PRIMARY KEY,
          date TEXT NOT NULL,
          activity TEXT NOT NULL,
          distance_km REAL NOT NULL DEFAULT 0,
          duration_min REAL NOT NULL DEFAULT 0,
          body_weight_kg REAL NOT NULL DEFAULT 70,
          calories REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        )`);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS fitness_weight (
          id TEXT PRIMARY KEY,
          date TEXT NOT NULL,
          exercise TEXT NOT NULL,
          exercise_type TEXT NOT NULL DEFAULT 'compound',
          weight_kg REAL NOT NULL DEFAULT 0,
          sets INTEGER NOT NULL DEFAULT 1,
          reps INTEGER NOT NULL DEFAULT 1,
          one_rm REAL,
          calories REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        )`);
    },

    // ── 노트 (기존 — 변경 없음) ──
    getData: async () => {
      const [nbs, notes] = await Promise.all([
        client.execute('SELECT * FROM notebooks ORDER BY name'),
        client.execute('SELECT * FROM notes ORDER BY updated_at DESC'),
      ]);
      return {
        notebooks: nbs.rows.map(nb => ({ id: nb.id, name: nb.name, color: Number(nb.color) })),
        notes: notes.rows.map(toNote),
      };
    },
    upsertNote: async (id, n) => {
      await client.execute({
        sql: `INSERT INTO notes (id,title,content,content_text,tags,notebook_id,pinned,deleted,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET
                title=excluded.title, content=excluded.content,
                content_text=excluded.content_text, tags=excluded.tags,
                notebook_id=excluded.notebook_id, pinned=excluded.pinned,
                deleted=excluded.deleted, updated_at=excluded.updated_at`,
        args: [
          id, n.title || '', n.content || '', n.contentText || '',
          JSON.stringify(n.tags || []), n.notebookId || null,
          n.pinned ? 1 : 0, n.deleted ? 1 : 0,
          n.createdAt || Date.now(), n.updatedAt || Date.now(),
        ],
      });
    },
    deleteNote: async (id) => {
      await client.execute({ sql: 'DELETE FROM notes WHERE id=?', args: [id] });
    },
    upsertNotebook: async (id, nb) => {
      await client.execute({
        sql: `INSERT INTO notebooks (id,name,color) VALUES (?,?,?)
              ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color`,
        args: [id, nb.name || '노트북', nb.color || 0],
      });
    },
    deleteNotebook: async (id) => {
      await client.batch([
        { sql: 'UPDATE notes SET deleted=1 WHERE notebook_id=?', args: [id] },
        { sql: 'DELETE FROM notebooks WHERE id=?', args: [id] },
      ], 'write');
    },

    // ── 피트니스 ──
    getFitnessRecords: async () => {
      const [cardio, weight] = await Promise.all([
        client.execute('SELECT * FROM fitness_cardio ORDER BY date DESC, created_at DESC'),
        client.execute('SELECT * FROM fitness_weight ORDER BY date DESC, created_at DESC'),
      ]);
      return { cardio: cardio.rows.map(toCardio), weight: weight.rows.map(toWeight) };
    },

    addCardio: async (rec) => {
      await client.execute({
        sql: `INSERT INTO fitness_cardio
              (id, date, activity, distance_km, duration_min, body_weight_kg, calories, created_at)
              VALUES (?,?,?,?,?,?,?,?)`,
        args: [rec.id, rec.date, rec.activity, rec.distance_km, rec.duration_min || 0,
               rec.body_weight_kg, rec.calories, rec.created_at],
      });
    },

    addWeight: async (rec) => {
      await client.execute({
        sql: `INSERT INTO fitness_weight
              (id, date, exercise, exercise_type, weight_kg, sets, reps, one_rm, calories, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
        args: [rec.id, rec.date, rec.exercise, rec.exercise_type || 'compound',
               rec.weight_kg, rec.sets, rec.reps, rec.one_rm ?? null,
               rec.calories, rec.created_at],
      });
    },

    deleteCardio: async (id) => {
      await client.execute({ sql: 'DELETE FROM fitness_cardio WHERE id=?', args: [id] });
    },

    deleteWeight: async (id) => {
      await client.execute({ sql: 'DELETE FROM fitness_weight WHERE id=?', args: [id] });
    },
  };
}

// ── SELECT STORAGE ───────────────────────────────────────
let storage;
if (process.env.TURSO_DATABASE_URL) {
  const { createClient } = require('@libsql/client');
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  storage = buildTursoStorage(client);
  console.log('Turso 연결됨:', process.env.TURSO_DATABASE_URL);
} else {
  console.warn('[경고] TURSO_DATABASE_URL 미설정 — 인메모리 저장소 사용 (재시작 시 초기화됨)');
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (urlPath.startsWith('/api/')) {
    try {
      // ── 피트니스 API ──────────────────────────────────
      if (req.method === 'GET' && urlPath === '/api/fitness/records') {
        return json(res, await storage.getFitnessRecords());
      }
      if (req.method === 'POST' && urlPath === '/api/fitness/cardio') {
        const body = await parseBody(req);
        const record = { id: genId(), ...body, created_at: Date.now() };
        await storage.addCardio(record);
        return json(res, { ok: true, record });
      }
      if (req.method === 'POST' && urlPath === '/api/fitness/weight') {
        const body = await parseBody(req);
        const record = { id: genId(), ...body, created_at: Date.now() };
        await storage.addWeight(record);
        return json(res, { ok: true, record });
      }
      if (req.method === 'DELETE' && urlPath.startsWith('/api/fitness/cardio/')) {
        const id = urlPath.slice('/api/fitness/cardio/'.length);
        await storage.deleteCardio(id);
        return json(res, { ok: true });
      }
      if (req.method === 'DELETE' && urlPath.startsWith('/api/fitness/weight/')) {
        const id = urlPath.slice('/api/fitness/weight/'.length);
        await storage.deleteWeight(id);
        return json(res, { ok: true });
      }

      // ── 노트 API (기존) ───────────────────────────────
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

  // Static files — 기본 페이지는 fitness_tracker.html
  const PAGE_MAP = {
    '/': 'fitness_tracker.html',
    '/fitness': 'fitness_tracker.html',
    '/exercises': 'exercise_guide.html',
    '/guide': 'exercise_guide.html',
  };
  const filePath = path.join(BASE, PAGE_MAP[urlPath] || urlPath);
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
