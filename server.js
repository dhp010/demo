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
    profiles: [],
    food_log: [],
  };
  return {
    init: async () => {},

    // ── 프로필 ──
    getProfiles: async () => [...mem.profiles].sort((a, b) => a.created_at - b.created_at),
    getProfile: async (id) => mem.profiles.find(p => p.id === id) || null,
    upsertProfile: async (id, name) => {
      const existing = mem.profiles.find(p => p.id === id);
      const row = { id, name, gender: existing?.gender || 'male', body_weight_kg: existing?.body_weight_kg || 70, created_at: existing?.created_at || Date.now() };
      const i = mem.profiles.findIndex(p => p.id === id);
      if (i >= 0) mem.profiles[i] = row; else mem.profiles.push(row);
    },
    updateProfileSettings: async (id, fields) => {
      const i = mem.profiles.findIndex(p => p.id === id);
      if (i >= 0) mem.profiles[i] = { ...mem.profiles[i], ...fields };
    },
    deleteProfile: async (id) => {
      mem.profiles = mem.profiles.filter(p => p.id !== id);
      mem.cardio = mem.cardio.filter(r => r.user_id !== id);
      mem.weight = mem.weight.filter(r => r.user_id !== id);
      mem.food_log = mem.food_log.filter(r => r.user_id !== id);
    },

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
    getFitnessRecords: async (userId) => ({
      cardio: [...mem.cardio].filter(r => (r.user_id || 'default') === userId).sort((a, b) => b.created_at - a.created_at),
      weight: [...mem.weight].filter(r => (r.user_id || 'default') === userId).sort((a, b) => b.created_at - a.created_at),
    }),
    addCardio: async (rec) => { mem.cardio.unshift(rec); },
    addWeight: async (rec) => { mem.weight.unshift(rec); },
    deleteCardio: async (id) => { mem.cardio = mem.cardio.filter(r => r.id !== id); },
    deleteWeight: async (id) => { mem.weight = mem.weight.filter(r => r.id !== id); },

    // ── 음식 로그 ──
    getFoodLog: async (userId, date) => [...mem.food_log].filter(r => r.user_id === userId && r.date === date).sort((a, b) => a.created_at - b.created_at),
    addFoodLog: async (rec) => { mem.food_log.push(rec); },
    deleteFoodLog: async (id) => { mem.food_log = mem.food_log.filter(r => r.id !== id); },
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

      // 프로필 테이블 (마이그레이션: gender, body_weight_kg 컬럼 추가)
      await client.execute(`
        CREATE TABLE IF NOT EXISTS fitness_profiles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          gender TEXT NOT NULL DEFAULT 'male',
          body_weight_kg REAL NOT NULL DEFAULT 70,
          created_at INTEGER NOT NULL
        )`);
      try { await client.execute(`ALTER TABLE fitness_profiles ADD COLUMN gender TEXT NOT NULL DEFAULT 'male'`); } catch {}
      try { await client.execute(`ALTER TABLE fitness_profiles ADD COLUMN body_weight_kg REAL NOT NULL DEFAULT 70`); } catch {}

      // 피트니스 테이블
      await client.execute(`
        CREATE TABLE IF NOT EXISTS fitness_cardio (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL DEFAULT 'default',
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
          user_id TEXT NOT NULL DEFAULT 'default',
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
      // 음식 로그 테이블
      await client.execute(`
        CREATE TABLE IF NOT EXISTS fitness_food_log (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL DEFAULT 'default',
          date TEXT NOT NULL,
          name TEXT NOT NULL,
          icon TEXT DEFAULT '',
          base_kcal REAL NOT NULL DEFAULT 0,
          serving REAL NOT NULL DEFAULT 1,
          kcal REAL NOT NULL DEFAULT 0,
          meal TEXT NOT NULL DEFAULT 'lunch',
          prot REAL,
          carb REAL,
          fat REAL,
          sodium REAL,
          created_at INTEGER NOT NULL
        )`);

      // 기존 테이블에 user_id 컬럼 추가 (마이그레이션)
      for (const tbl of ['fitness_cardio', 'fitness_weight']) {
        try { await client.execute(`ALTER TABLE ${tbl} ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'`); } catch {}
      }
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
    getFitnessRecords: async (userId) => {
      const [cardio, weight] = await Promise.all([
        client.execute({ sql: 'SELECT * FROM fitness_cardio WHERE user_id=? ORDER BY date DESC, created_at DESC', args: [userId] }),
        client.execute({ sql: 'SELECT * FROM fitness_weight WHERE user_id=? ORDER BY date DESC, created_at DESC', args: [userId] }),
      ]);
      return { cardio: cardio.rows.map(toCardio), weight: weight.rows.map(toWeight) };
    },

    addCardio: async (rec) => {
      await client.execute({
        sql: `INSERT INTO fitness_cardio
              (id, user_id, date, activity, distance_km, duration_min, body_weight_kg, calories, created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`,
        args: [rec.id, rec.user_id || 'default', rec.date, rec.activity, rec.distance_km, rec.duration_min || 0,
               rec.body_weight_kg, rec.calories, rec.created_at],
      });
    },

    addWeight: async (rec) => {
      await client.execute({
        sql: `INSERT INTO fitness_weight
              (id, user_id, date, exercise, exercise_type, weight_kg, sets, reps, one_rm, calories, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        args: [rec.id, rec.user_id || 'default', rec.date, rec.exercise, rec.exercise_type || 'compound',
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

    // ── 프로필 ──
    getProfiles: async () => {
      const r = await client.execute('SELECT * FROM fitness_profiles ORDER BY created_at ASC');
      return r.rows.map(p => ({
        id: p.id, name: p.name,
        gender: p.gender || 'male',
        body_weight_kg: p.body_weight_kg != null ? Number(p.body_weight_kg) : 70,
        created_at: Number(p.created_at),
      }));
    },
    getProfile: async (id) => {
      const r = await client.execute({ sql: 'SELECT * FROM fitness_profiles WHERE id=?', args: [id] });
      if (!r.rows.length) return null;
      const p = r.rows[0];
      return { id: p.id, name: p.name, gender: p.gender || 'male', body_weight_kg: p.body_weight_kg != null ? Number(p.body_weight_kg) : 70 };
    },
    upsertProfile: async (id, name) => {
      await client.execute({
        sql: `INSERT INTO fitness_profiles (id, name, gender, body_weight_kg, created_at) VALUES (?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET name=excluded.name`,
        args: [id, name, 'male', 70, Date.now()],
      });
    },
    updateProfileSettings: async (id, fields) => {
      const sets = [];
      const args = [];
      if (fields.gender !== undefined) { sets.push('gender=?'); args.push(fields.gender); }
      if (fields.body_weight_kg !== undefined) { sets.push('body_weight_kg=?'); args.push(fields.body_weight_kg); }
      if (!sets.length) return;
      args.push(id);
      await client.execute({ sql: `UPDATE fitness_profiles SET ${sets.join(',')} WHERE id=?`, args });
    },
    deleteProfile: async (id) => {
      await client.batch([
        { sql: 'DELETE FROM fitness_profiles WHERE id=?', args: [id] },
        { sql: 'DELETE FROM fitness_cardio WHERE user_id=?', args: [id] },
        { sql: 'DELETE FROM fitness_weight WHERE user_id=?', args: [id] },
        { sql: 'DELETE FROM fitness_food_log WHERE user_id=?', args: [id] },
      ], 'write');
    },

    // ── 음식 로그 ──
    getFoodLog: async (userId, date) => {
      const r = await client.execute({ sql: 'SELECT * FROM fitness_food_log WHERE user_id=? AND date=? ORDER BY created_at ASC', args: [userId, date] });
      return r.rows.map(f => ({
        id: f.id, name: f.name, icon: f.icon || '', date: f.date,
        baseKcal: Number(f.base_kcal), serving: Number(f.serving),
        kcal: Number(f.kcal), meal: f.meal,
        prot: f.prot != null ? Number(f.prot) : null,
        carb: f.carb != null ? Number(f.carb) : null,
        fat: f.fat != null ? Number(f.fat) : null,
        sodium: f.sodium != null ? Number(f.sodium) : null,
      }));
    },
    addFoodLog: async (rec) => {
      await client.execute({
        sql: `INSERT INTO fitness_food_log (id,user_id,date,name,icon,base_kcal,serving,kcal,meal,prot,carb,fat,sodium,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [rec.id, rec.user_id || 'default', rec.date, rec.name, rec.icon || '',
               rec.baseKcal, rec.serving, rec.kcal, rec.meal,
               rec.prot ?? null, rec.carb ?? null, rec.fat ?? null, rec.sodium ?? null, rec.created_at],
      });
    },
    deleteFoodLog: async (id) => {
      await client.execute({ sql: 'DELETE FROM fitness_food_log WHERE id=?', args: [id] });
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

// 처리되지 않은 예외로 서버가 죽지 않도록
process.on('uncaughtException', err => console.error('uncaughtException:', err.message));
process.on('unhandledRejection', err => console.error('unhandledRejection:', err?.message || err));

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
      // ── 프로필 API ───────────────────────────────────────
      if (req.method === 'GET' && urlPath === '/api/profiles') {
        return json(res, await storage.getProfiles());
      }
      if (req.method === 'GET' && urlPath.startsWith('/api/profiles/')) {
        const id = urlPath.slice('/api/profiles/'.length);
        const profile = await storage.getProfile(id);
        if (!profile) return json(res, { error: 'Not found' }, 404);
        return json(res, profile);
      }
      if (req.method === 'POST' && urlPath === '/api/profiles') {
        const body = await parseBody(req);
        if (!body.id || !body.name) return json(res, { error: 'id and name required' }, 400);
        await storage.upsertProfile(body.id, body.name);
        return json(res, { ok: true });
      }
      if (req.method === 'PATCH' && urlPath.startsWith('/api/profiles/')) {
        const id = urlPath.slice('/api/profiles/'.length);
        if (!id) return json(res, { error: 'id required' }, 400);
        const body = await parseBody(req);
        const fields = {};
        if (body.gender !== undefined) fields.gender = body.gender;
        if (body.body_weight_kg !== undefined) fields.body_weight_kg = Number(body.body_weight_kg);
        await storage.updateProfileSettings(id, fields);
        return json(res, { ok: true });
      }
      if (req.method === 'DELETE' && urlPath.startsWith('/api/profiles/')) {
        const id = urlPath.slice('/api/profiles/'.length);
        if (!id) return json(res, { error: 'id required' }, 400);
        await storage.deleteProfile(id);
        return json(res, { ok: true });
      }

      if (req.method === 'GET' && urlPath === '/api/fitness/food') {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const userId = params.get('user') || 'default';
        const date = params.get('date') || '';
        return json(res, await storage.getFoodLog(userId, date));
      }
      if (req.method === 'POST' && urlPath === '/api/fitness/food') {
        const body = await parseBody(req);
        const record = { id: genId(), ...body, created_at: Date.now() };
        await storage.addFoodLog(record);
        return json(res, { ok: true, record });
      }
      if (req.method === 'DELETE' && urlPath.startsWith('/api/fitness/food/')) {
        const id = urlPath.slice('/api/fitness/food/'.length);
        await storage.deleteFoodLog(id);
        return json(res, { ok: true });
      }

      if (req.method === 'GET' && urlPath === '/api/fitness/records') {
        const userId = new URL(req.url, 'http://localhost').searchParams.get('user') || 'default';
        return json(res, await storage.getFitnessRecords(userId));
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

  // 로컬 다운로드 엔드포인트
  if (urlPath === '/download') {
    const filePath = path.join(BASE, 'fitness_tracker.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'attachment; filename="FitTrack_로컬.html"',
        'Content-Length': data.length,
      });
      res.end(data);
    });
    return;
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
  .catch(err => {
    console.error('DB 초기화 실패, 인메모리로 전환:', err.message);
    storage = buildMemoryStorage();
    return storage.init();
  })
  .then(() => server.listen(PORT, '0.0.0.0', () => console.log(`서버 실행 중: http://localhost:${PORT}`)))
  .catch(err => { console.error('서버 시작 실패:', err); process.exit(1); });
