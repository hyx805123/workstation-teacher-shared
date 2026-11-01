'use strict';
/*
  班主任工作台 · 班级共享同步服务（单机版升级为多人实时共享）
  - 零第三方依赖，Node 18+ 直接运行
  - 数据落盘：data/state.json（原子写）+ data/versions/vNNNNNNNN.json（历史快照，保留 30 份）
  - 并发策略：版本号 + 三方合并（base / mine / theirs），服务端完成合并后再落盘
  - 实时推送：SSE /api/events
  - 用法：node sync-server.js [端口]     环境变量 HOST 可改监听地址（默认 0.0.0.0 供局域网访问）
*/
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const DATA_DIR = path.join(ROOT, 'data');
const VER_DIR = path.join(DATA_DIR, 'versions');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOG_FILE = path.join(ROOT, 'service.log');
const ACT_FILE = path.join(DATA_DIR, 'activity.log');
const MAX_BODY = 16 * 1024 * 1024;
const KEEP_VERSIONS = 30;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

/* ---------------- 日志 ---------------- */
function log(msg) {
  const line = '[' + new Date().toLocaleString('zh-CN') + '] ' + msg + '\r\n';
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.unlinkSync(LOG_FILE);
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) { /* ignore */ }
}
function activity(obj) {
  try {
    if (fs.existsSync(ACT_FILE) && fs.statSync(ACT_FILE).size > 4 * 1024 * 1024) fs.unlinkSync(ACT_FILE);
    fs.appendFileSync(ACT_FILE, JSON.stringify(Object.assign({ at: Date.now() }, obj)) + '\n');
  } catch (e) { /* ignore */ }
}

/* ---------------- 状态存储 ---------------- */
const DB = { version: 0, updatedAt: 0, updatedBy: '', state: null };
const snapshots = new Map(); // version -> state（内存缓存，避免频繁读盘）

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(VER_DIR)) fs.mkdirSync(VER_DIR, { recursive: true });
}

function loadFromDisk() {
  ensureDirs();
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    DB.version = Number(raw.version) || 0;
    DB.updatedAt = Number(raw.updatedAt) || 0;
    DB.updatedBy = raw.updatedBy || '';
    DB.state = raw.state || null;
    if (DB.state) snapshots.set(DB.version, DB.state);
  } catch (e) {
    log('state.json 读取失败，将作为首次启动处理：' + e.message);
  }
}

function atomicWrite(file, text) {
  const tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function snapshotPath(v) { return path.join(VER_DIR, 'v' + String(v).padStart(8, '0') + '.json'); }

function getSnapshot(v) {
  if (snapshots.has(v)) return snapshots.get(v);
  const p = snapshotPath(v);
  if (!fs.existsSync(p)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    snapshots.set(v, s);
    return s;
  } catch (e) { return null; }
}

function commit(nextState, by, merged, conflicts) {
  DB.version += 1;
  DB.state = nextState;
  DB.updatedAt = Date.now();
  DB.updatedBy = by || '';
  atomicWrite(STATE_FILE, JSON.stringify({ version: DB.version, updatedAt: DB.updatedAt, updatedBy: DB.updatedBy, state: DB.state }));
  try {
    atomicWrite(snapshotPath(DB.version), JSON.stringify(DB.state));
    snapshots.set(DB.version, DB.state);
    pruneVersions();
  } catch (e) { log('快照写入失败：' + e.message); }
  activity({ event: 'commit', version: DB.version, by: DB.updatedBy, merged: !!merged, conflicts: conflicts || [] });
  broadcast({ type: 'state', version: DB.version, updatedBy: DB.updatedBy, updatedAt: DB.updatedAt });
  return DB.version;
}

function pruneVersions() {
  const files = fs.readdirSync(VER_DIR).filter((f) => /^v\d{8}\.json$/.test(f)).sort();
  while (files.length > KEEP_VERSIONS) {
    const f = files.shift();
    try { fs.unlinkSync(path.join(VER_DIR, f)); } catch (e) { /* ignore */ }
    const v = parseInt(f.slice(1, 9), 10);
    snapshots.delete(v);
  }
  // 内存里只留最近 5 份
  if (snapshots.size > 5) {
    const keys = Array.from(snapshots.keys()).sort((a, b) => a - b);
    while (keys.length > 5) snapshots.delete(keys.shift());
  }
}

/* ---------------- 三方合并 ---------------- */
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
const keyOf = (it) => (it && (it.id || it.sid)) ? String(it.id || it.sid) : null;
function labelOf(it) { return (it && (it.name || it.title || it.sid)) || '未命名'; }

function idx(arr) {
  const m = {};
  (Array.isArray(arr) ? arr : []).forEach((it) => { const k = keyOf(it); if (k) m[k] = it; });
  return m;
}

// 单项内部字段级合并（学生改不同字段、考试录不同学生/科目分数时避免整条覆盖）
function looksLikeIdArray(a) {
  return Array.isArray(a) && a.length > 0 && a.every((x) => x && typeof x === 'object' && (x.id || x.sid));
}

function mergeItemDeep(base, mine, theirs, path, conflicts, depth) {
  base = base && typeof base === 'object' ? base : {};
  mine = mine && typeof mine === 'object' ? mine : {};
  theirs = theirs && typeof theirs === 'object' ? theirs : {};
  const out = {};
  const keys = {};
  [base, mine, theirs].forEach((o) => Object.keys(o).forEach((k) => { keys[k] = 1; }));

  Object.keys(keys).forEach((k) => {
    const x = base[k], y = mine[k], z = theirs[k];
    const hasM = Object.prototype.hasOwnProperty.call(mine, k);
    const hasT = Object.prototype.hasOwnProperty.call(theirs, k);

    if (!hasM) { if (hasT && !eq(z, x)) out[k] = z; return; }        // 我删了这个字段，他改过才留
    if (!hasT) { if (x === undefined || !eq(y, x)) out[k] = y; return; }
    if (eq(y, z)) { out[k] = y; return; }
    if (eq(y, x)) { out[k] = z; return; }
    if (eq(z, x)) { out[k] = y; return; }

    // 双方都改了：能下钻就下钻
    if (depth > 0 && isObj(y) && isObj(z)) {
      out[k] = mergeItemDeep(x || {}, y, z, path + '.' + k, conflicts, depth - 1);
      return;
    }
    if (depth > 0 && looksLikeIdArray(y) && looksLikeIdArray(z)) {
      out[k] = mergeCollection(x, y, z, path + '.' + k, conflicts);
      return;
    }
    out[k] = z;
    conflicts.push(path + ' 的「' + k + '」被多人同时修改，已采用服务器版本');
  });

  return out;
}

// 集合（students / exams / points / records / todos / chats）按 id 三方合并
function mergeCollection(baseA, mineA, theirsA, label, conflicts) {
  baseA = Array.isArray(baseA) ? baseA : [];
  mineA = Array.isArray(mineA) ? mineA : [];
  theirsA = Array.isArray(theirsA) ? theirsA : [];
  const b = idx(baseA), m = idx(mineA), t = idx(theirsA);
  const out = [], done = {};

  mineA.forEach((item) => {
    const id = keyOf(item);
    if (!id) { out.push(item); return; } // 无 id 的脏数据，原样保留
    done[id] = 1;
    const bi = b[id], ti = t[id];

    if (ti === undefined) {
      if (bi === undefined) { out.push(item); return; }          // 我新增
      if (eq(item, bi)) return;                                   // 我没改，对方删了 → 删除
      out.push(item);
      conflicts.push(label + '「' + labelOf(item) + '」被其他老师删除，但你这边改过，已保留');
      return;
    }
    if (bi === undefined) {                                       // 我新增，对方也有同 id
      out.push(ti);
      if (!eq(item, ti)) conflicts.push(label + '「' + labelOf(item) + '」新增冲突，已取服务器版本');
      return;
    }
    if (eq(item, ti)) { out.push(ti); return; }                   // 双方一致
    if (eq(item, bi)) { out.push(ti); return; }                   // 我只改了自己看不见的部分 → 取对方
    if (eq(ti, bi)) { out.push(item); return; }                   // 对方没改 → 取我方
    // 同一条记录双方都改：尽量按字段/子结构合并，避免整条覆盖
    out.push(mergeItemDeep(bi, item, ti, label + '「' + labelOf(item) + '」', conflicts, 3));
  });

  // 我删除的
  baseA.forEach((item) => {
    const id = keyOf(item);
    if (!id || done[id]) return;
    const ti = t[id];
    if (ti === undefined) return;         // 双方都删了
    if (eq(ti, item)) return;             // 对方没改 → 尊重我的删除
    out.push(ti);
    conflicts.push(label + '「' + labelOf(ti) + '」已删除，但其他老师改过，已恢复');
  });

  // 对方新增的
  theirsA.forEach((item) => {
    const id = keyOf(item);
    if (!id) return;
    if (!m[id] && !b[id]) out.push(item);
  });

  return out;
}

// 考勤：{日期: {sid: 状态}}
function mergeAttendance(base, mine, theirs, conflicts) {
  base = base || {}; mine = mine || {}; theirs = theirs || {};
  const out = {};
  const dates = {};
  [base, mine, theirs].forEach((o) => Object.keys(o).forEach((d) => { dates[d] = 1; }));
  Object.keys(dates).forEach((d) => {
    const bd = base[d] || {}, md = mine[d] || {}, td = theirs[d] || {};
    const sids = {};
    [bd, md, td].forEach((o) => Object.keys(o).forEach((k) => { sids[k] = 1; }));
    const od = {};
    Object.keys(sids).forEach((sid) => {
      const x = bd[sid], y = md[sid], z = td[sid];
      if (y === undefined) { if (z !== undefined && !eq(z, x)) od[sid] = z; return; } // 我删了，他改过才留
      if (z === undefined) { if (x === undefined) od[sid] = y; else if (!eq(y, x)) od[sid] = y; return; }
      if (eq(y, z)) { od[sid] = y; return; }
      if (eq(y, x)) { od[sid] = z; return; }
      if (eq(z, x)) { od[sid] = y; return; }
      od[sid] = z;
      conflicts.push('考勤 ' + d + ' 有学生状态被多人同时修改');
    });
    if (Object.keys(od).length) out[d] = od;
  });
  return out;
}

// 设置：一层键级三方合并，已知子对象再下钻一层
function mergeObjectTree(base, mine, theirs, label, conflicts, depth) {
  base = base || {}; mine = mine || {}; theirs = theirs || {};
  const out = {};
  const keys = {};
  [base, mine, theirs].forEach((o) => Object.keys(o).forEach((k) => { keys[k] = 1; }));
  Object.keys(keys).forEach((k) => {
    const x = base[k], y = mine[k], z = theirs[k];
    const hasM = Object.prototype.hasOwnProperty.call(mine, k);
    const hasT = Object.prototype.hasOwnProperty.call(theirs, k);
    if (!hasM) { if (hasT && !eq(z, x)) out[k] = z; return; }      // 我删了，他改过才留
    if (!hasT) { if (!(x === undefined)) { if (!eq(y, x)) out[k] = y; } else out[k] = y; return; }
    if (eq(y, z)) { out[k] = y; return; }
    if (eq(y, x)) { out[k] = z; return; }
    if (eq(z, x)) { out[k] = y; return; }
    if (depth > 0 && isObj(y) && isObj(z)) {
      out[k] = mergeObjectTree(x || {}, y, z, label + '.' + k, conflicts, depth - 1);
      return;
    }
    out[k] = z;
    if (label !== 'state') conflicts.push(label + '.' + k + ' 被多人同时修改，已采用服务器版本');
  });
  return out;
}

const COLLECTIONS = ['students', 'exams', 'points', 'records', 'todos', 'chats'];
const LABELS = { students: '学生', exams: '考试', points: '点评', records: '成长记录', todos: '待办', chats: 'AI 对话' };
const DEEP_OBJECTS = ['settings', 'settings.ai', 'settings.teacher', 'settings.countdown', 'map'];

function merge3(base, mine, theirs) {
  const conflicts = [];
  if (!base) return { state: mine, conflicts: ['没有找到基线版本，已用你提交的内容覆盖'] };
  const out = {};
  const keys = {};
  [base, mine, theirs].forEach((o) => o && Object.keys(o).forEach((k) => { keys[k] = 1; }));

  Object.keys(keys).forEach((k) => {
    if (COLLECTIONS.indexOf(k) >= 0) {
      out[k] = mergeCollection(base[k], mine[k], theirs[k], (LABELS[k] || k), conflicts);
      return;
    }
    if (k === 'attendance') {
      out[k] = mergeAttendance(base[k], mine[k], theirs[k], conflicts);
      return;
    }
    if (DEEP_OBJECTS.indexOf(k) >= 0) {
      out[k] = mergeObjectTree(base[k], mine[k], theirs[k], k, conflicts, k === 'settings' ? 1 : 0);
      return;
    }
    // 其余标量/未知结构：谁改取谁
    const x = base[k], y = mine[k], z = theirs[k];
    if (!(k in mine)) { if (eq(z, x)) return; out[k] = z; return; }
    if (!(k in theirs)) { if (!eq(y, x)) out[k] = y; return; }
    if (eq(y, z)) { out[k] = y; return; }
    if (eq(y, x)) { out[k] = z; return; }
    if (eq(z, x)) { out[k] = y; return; }
    out[k] = z;
  });
  return { state: out, conflicts };
}

/* ---------------- SSE ---------------- */
const sseClients = new Set();
function broadcast(payload) {
  const data = 'data: ' + JSON.stringify(payload) + '\n\n';
  sseClients.forEach((res) => { try { res.write(data); } catch (e) { /* ignore */ } });
}
setInterval(() => {
  sseClients.forEach((res) => { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } });
}, 25000).unref();

/* ---------------- HTTP ---------------- */
function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  const target = path.join(ROOT, path.normalize(urlPath));
  const rel = path.relative(ROOT, target);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).some((s) => s.startsWith('.'))
      || rel.split(path.sep)[0] === 'data') {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }
  fs.readFile(target, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found: ' + urlPath);
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    if (req.method === 'HEAD') return res.end();
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  let url, urlPath = '/';
  try {
    url = new URL(req.url, 'http://127.0.0.1');
    urlPath = decodeURIComponent(url.pathname);
  } catch (e) {
    res.writeHead(400); return res.end('Bad Request');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  /* --- 健康检查 --- */
  if (urlPath === '/api/health') {
    return sendJson(res, 200, { ok: true, version: DB.version, updatedAt: DB.updatedAt, updatedBy: DB.updatedBy, online: sseClients.size, hasState: !!DB.state });
  }

  /* --- 拉取状态 --- */
  if (urlPath === '/api/state' && req.method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    if (since && since === DB.version) return sendJson(res, 200, { version: DB.version, unchanged: true });
    return sendJson(res, 200, { version: DB.version, updatedAt: DB.updatedAt, updatedBy: DB.updatedBy, state: DB.state });
  }

  /* --- 提交状态 --- */
  if (urlPath === '/api/state' && (req.method === 'PUT' || req.method === 'POST')) {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (e) {
      return sendJson(res, 400, { error: '请求体不是合法 JSON：' + e.message });
    }
    if (!payload || !payload.state || typeof payload.state !== 'object') {
      return sendJson(res, 400, { error: '缺少 state' });
    }
    const client = payload.client && typeof payload.client === 'object' ? payload.client : {};
    const by = String(client.name || '').slice(0, 40) || '未署名';
    const baseVersion = Number(payload.baseVersion || 0);

    // 首次初始化
    if (!DB.state) {
      const v = commit(payload.state, by, false, []);
      return sendJson(res, 200, { version: v, merged: false, state: DB.state, conflicts: [] });
    }

    if (baseVersion === DB.version) {
      const v = commit(payload.state, by, false, []);
      return sendJson(res, 200, { version: v, merged: false, state: DB.state, conflicts: [] });
    }

    // 版本落后 → 三方合并
    const base = baseVersion ? getSnapshot(baseVersion) : null;
    const { state: mergedState, conflicts } = merge3(base, payload.state, DB.state);
    const v = commit(mergedState, by, true, conflicts);
    log('merged put from ' + by + ': base=' + baseVersion + ' server=' + (DB.version - 1) + ' -> v' + v + ' conflicts=' + conflicts.length);
    return sendJson(res, 200, { version: v, merged: true, state: mergedState, conflicts, previousVersion: DB.version - 1 });
  }

  /* --- 服务端合并预览（调试用） --- */
  if (urlPath === '/api/merge-preview' && req.method === 'POST') {
    try {
      const p = JSON.parse(await readBody(req));
      const r = merge3(p.base, p.mine, p.theirs);
      return sendJson(res, 200, { ok: true, conflicts: r.conflicts, state: r.state });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }

  /* --- SSE --- */
  if (urlPath === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('retry: 3000\n\n');
    res.write('data: ' + JSON.stringify({ type: 'hello', version: DB.version, updatedBy: DB.updatedBy }) + '\n\n');
    sseClients.add(res);
    req.on('close', () => { sseClients.delete(res); });
    return;
  }

  /* --- 静态资源 --- */
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end('Method Not Allowed');
  }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  return serveStatic(req, res, urlPath);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log('端口 ' + PORT + ' 已被占用，静默退出');
    process.exit(0);
  }
  log('server error: ' + e.message);
  process.exit(1);
});

loadFromDisk();
server.listen(PORT, HOST, () => {
  const nets = require('os').networkInterfaces();
  const ips = [];
  Object.keys(nets).forEach((n) => nets[n].forEach((a) => {
    if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  }));
  log('sync server on http://' + HOST + ':' + PORT + '  version=' + DB.version + '  ips=' + ips.join(','));
  console.log('班主任工作台 · 共享服务已启动');
  console.log('  本机访问：http://127.0.0.1:' + PORT + '/');
  ips.forEach((ip) => console.log('  局域网访问：http://' + ip + ':' + PORT + '/'));
  console.log('  数据目录：' + DATA_DIR + '（当前版本 v' + DB.version + '）');
  console.log('  按 Ctrl+C 停止');
});
