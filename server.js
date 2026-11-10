// 演唱会下单工作台 - 正式版（国内云）
// 零依赖，只用 Node 自带模块。Node >= 16
// 本地：ADMIN_PASSWORD=你的密码 node server.js
// 正式：用 PM2 跑，见 ecosystem.config.js / README.md
// 前台：/            （发给客户）
// 后台：/admin.html  （只给你自己，要输密码）
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
// 正式部署：把 DATA_DIR 指向持久目录，例如 /data 或 /home/xxx/concert-data
// 这样重新部署 / 重启也不会丢单。默认 ./data
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'orders.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-123456';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadOrders() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '[]');
  } catch { return []; }
}
function saveOrders(list) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE); // 原子写，断电也不容易坏文件
}

const clients = new Set();
function broadcast() {
  const data = `data: ${JSON.stringify({ type: 'orders', count: loadOrders().length, at: new Date().toISOString() })}\n\n`;
  for (const res of clients) { try { res.write(data); } catch {} }
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('JSON 格式不对')); } });
    req.on('error', reject);
  });
}
// 后台密码：请求头 x-admin-password，或 ?password=
// 前台下单 POST 不用密码；看单 / 改状态 / 删除 / 导出都要密码
function checkAdmin(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pw = req.headers['x-admin-password'] || url.searchParams.get('password') || '';
  return pw === ADMIN_PASSWORD;
}
// 简单防刷：同一 IP 1 分钟最多下 20 单
const hits = new Map();
const lookupHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60 * 1000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 20;
}
function maskId(v) {
  const t = String(v || '').trim();
  if (t.length <= 8) return '****';
  return t.slice(0, 4) + '********' + t.slice(-4);
}
function maskPhone(v) {
  const t = String(v || '').trim();
  if (t.length !== 11) return '****';
  return t.slice(0, 3) + '****' + t.slice(-4);
}
function lookupRateLimited(ip) {
  const now = Date.now();
  const arr = (lookupHits.get(ip) || []).filter(t => now - t < 60 * 1000);
  arr.push(now); lookupHits.set(ip, arr);
  return arr.length > 10;
}
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// ---- 订单统一分类：演唱会名大差不差归一类 + 同一场次归一类 ----
// 归一化演唱会名：去空格/标点/全半角、去年份、去“演唱会/巡回演唱会/巡演”等后缀
// 例如 “周杰伦 演唱会”“周杰伦嘉年华演唱会”“周杰伦嘉年华世界巡回演唱会2025”
// 都会归到同一个核心名（保留“嘉年华”这种巡演名，只去掉通用后缀）
function normalizeConcert(name) {
  let s = String(name || '').trim().toLowerCase();
  s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  s = s.replace(/[\s\-_·•・、，。,！!？?（）()\[\]【】《》""''“”‘’\/\\|@#$%^&*+=~`]/g, '');
  s = s.replace(/20\d{2}|19\d{2}/g, '');
  const suffixes = ['世界巡回演唱会', '巡回演唱会', '世界巡演', '巡回演唱', '演唱会', '巡演', '演唱', '世界巡回', '全球巡回', '巡回', 'live', 'tour', 'concert'];
  let changed = true;
  while (changed) { changed = false; for (const w of suffixes) { if (s.endsWith(w)) { s = s.slice(0, -w.length); changed = true; } } }
  return s || String(name || '').trim();
}
// 归一化场次时间：2026/12/24 19:30、2026-12-24T19:30、19:30:00 都归到 2026-12-24 19:30
function normalizeDatetime(dt) {
  const s = String(dt || '').trim().replace(/\//g, '-').replace('T', ' ');
  const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return s;
  const pad = n => String(n).padStart(2, '0');
  return `${m[1]}-${pad(m[2])}-${pad(m[3])} ${pad(m[4])}:${m[5]}`;
}
function groupKeyFor(concert, datetime) {
  return normalizeConcert(concert) + '|' + normalizeDatetime(datetime);
}
function sameConcert(a, b) {
  // 大差不差也归一类：一个是另一个的前缀就算同一演唱会
  // 例如“周杰伦”和“周杰伦嘉年华”在同一场次下归一组
  return a === b || a.startsWith(b) || b.startsWith(a);
}
function buildGroups(list) {
  const map = new Map();
  for (const o of list) {
    const key = o.groupKey || groupKeyFor(o.concert, o.datetime);
    const session = o.sessionKey || normalizeDatetime(o.datetime);
    const concertKey = normalizeConcert(o.concert);
    // 先找同一场次下名字大差不差的组（前缀包含即同组），找不到再新建
    let g = null;
    for (const cand of map.values()) {
      if (cand.session === session && sameConcert(cand.concertKey, concertKey)) { g = cand; break; }
    }
    if (!g) { g = { groupKey: key, concertKey, session, concert: o.concert, datetime: session, orders: [] }; map.set(key, g); }
    g.orders.push(o);
    // 显示名用组里出现最多的原始演唱会名
    g.concert = mostCommon(g.orders.map(x => x.concert));
  }
  for (const g of map.values()) {
    g.count = g.orders.length;
    g.tickets = g.orders.reduce((a, o) => a + (Number(o.quantity) || 0), 0);
    g.total = g.orders.reduce((a, o) => a + (Number(o.total) || 0), 0);
    g.pending = g.orders.filter(o => o.status === '待处理').length;
    g.orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  return [...map.values()].sort((a, b) => a.session.localeCompare(b.session) || b.orders[0].createdAt.localeCompare(a.orders[0].createdAt));
}
function mostCommon(arr) {
  const c = new Map();
  for (const v of arr) c.set(v, (c.get(v) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || arr[0];
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';

  // 健康检查（云平台 / Nginx 用）
  if (pathname === '/health') return sendJson(res, 200, { ok: true, orders: loadOrders().length });

  // 后台登录校验
  if (pathname === '/api/admin/login' && req.method === 'POST') {
    try { const b = await readBody(req); return sendJson(res, b.password === ADMIN_PASSWORD ? 200 : 401, { ok: b.password === ADMIN_PASSWORD }); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
  }

  // 客户查单（不用后台密码）：凭下单时填的身份证号查自己的订单
  // 必须身份证号完全一致才返回，只返回该身份证号的订单，且身份证/电话脱敏显示
  // 后台把状态改成 已确认 / 已出票 后，客户在这里立刻能看到
  if (pathname === '/api/orders/lookup' && req.method === 'POST') {
    if (lookupRateLimited(ip)) return sendJson(res, 429, { error: '查询太频繁，稍后再试' });
    try {
      const b = await readBody(req);
      const idNumber = String(b.idNumber || '').trim();
      if (!/^(\d{15}|\d{17}[\dXx])$/.test(idNumber)) return sendJson(res, 400, { error: '身份证号格式不对' });
      const list = loadOrders().filter(o => String(o.idNumber || '').trim().toUpperCase() === idNumber.toUpperCase());
      if (!list.length) return sendJson(res, 404, { error: '没查到该身份证号的订单，请核对后重试' });
      const out = list.map(o => ({
        id: o.id, concert: o.concert, datetime: o.datetime,
        priceTier: o.priceTier, unitPrice: o.unitPrice, quantity: o.quantity, total: o.total,
        seat: o.seat, name: o.name, status: o.status, createdAt: o.createdAt,
        idNumberMasked: maskId(o.idNumber), phoneMasked: maskPhone(o.phone),
      }));
      return sendJson(res, 200, out);
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }

  // 分组汇总（后台，要密码）：按归一化演唱会名 + 场次时间分组
  if (pathname === '/api/groups' && req.method === 'GET') {
    if (!checkAdmin(req)) return sendJson(res, 401, { error: '需要后台密码' });
    return sendJson(res, 200, buildGroups(loadOrders()));
  }

  // 导出 CSV（后台，要密码）
  if (pathname === '/api/orders/export' && req.method === 'GET') {
    if (!checkAdmin(req)) return sendJson(res, 401, { error: '需要后台密码' });
    const list = loadOrders();
    const head = ['订单号', '分组（演唱会+场次）', '演唱会', '场次时间', '价位', '单价', '张数', '合计', '座位偏好', '姓名', '身份证号', '电话', '备注', '状态', '下单时间'];
    const rows = list.map(o => [o.id, (o.groupKey || groupKeyFor(o.concert, o.datetime)), o.concert, o.datetime, o.priceTier, o.unitPrice, o.quantity, o.total, o.seat, o.name, o.idNumber, o.phone, o.note, o.status, o.createdAt]);
    const csv = '\ufeff' + [head, ...rows].map(r => r.map(csvEscape).join(',')).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="orders.csv"' });
    return res.end(csv);
  }

  // SSE：后台实时收到新订单（要密码）
  if (pathname === '/api/stream' && req.method === 'GET') {
    if (!checkAdmin(req)) return sendJson(res, 401, { error: '需要后台密码' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (pathname === '/api/orders') {
    if (req.method === 'GET') {
      if (!checkAdmin(req)) return sendJson(res, 401, { error: '需要后台密码' });
      return sendJson(res, 200, loadOrders());
    }
    if (req.method === 'POST') {
      if (rateLimited(ip)) return sendJson(res, 429, { error: '提交太频繁，稍后再试' });
      try {
        const b = await readBody(req);
        const required = ['concert', 'datetime', 'priceTier', 'unitPrice', 'quantity', 'name', 'idNumber', 'phone'];
        for (const k of required) if (!b[k] && b[k] !== 0) return sendJson(res, 400, { error: '缺少必填项：' + k });
        if (!['内场', '看台'].includes(String(b.priceTier))) return sendJson(res, 400, { error: '价位只能是内场或看台' });
        if (!/^1[3-9]\d{9}$/.test(String(b.phone))) return sendJson(res, 400, { error: '手机号格式不对' });
        if (!/^(\d{15}|\d{17}[\dXx])$/.test(String(b.idNumber).trim())) return sendJson(res, 400, { error: '身份证号格式不对' });
        const list = loadOrders();
        const order = {
          id: 'YC' + Date.now().toString().slice(-8) + Math.floor(Math.random() * 90 + 10),
          concert: String(b.concert).trim(),
          datetime: normalizeDatetime(b.datetime),
          groupKey: groupKeyFor(b.concert, b.datetime),
          sessionKey: normalizeDatetime(b.datetime),
          priceTier: String(b.priceTier).trim(),
          unitPrice: Number(b.unitPrice),
          quantity: Number(b.quantity) || 1,
          total: Number(b.unitPrice) * (Number(b.quantity) || 1),
          seat: String(b.seat || '').trim(),
          name: String(b.name).trim(),
          idNumber: String(b.idNumber).trim(),
          phone: String(b.phone).trim(),
          note: String(b.note || '').trim(),
          status: '待处理',
          createdAt: new Date().toISOString(),
        };
        list.unshift(order);
        saveOrders(list);
        broadcast();
        return sendJson(res, 200, order);
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    return sendJson(res, 405, { error: '方法不支持' });
  }

  const m = pathname.match(/^\/api\/orders\/([\w-]+)$/);
  if (m) {
    if (!checkAdmin(req)) return sendJson(res, 401, { error: '需要后台密码' });
    const id = m[1];
    const list = loadOrders();
    const idx = list.findIndex(o => o.id === id);
    if (idx === -1) return sendJson(res, 404, { error: '订单不存在' });
    if (req.method === 'PATCH') {
      try { const b = await readBody(req); if (b.status) list[idx].status = b.status; saveOrders(list); broadcast(); return sendJson(res, 200, list[idx]); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'DELETE') { list.splice(idx, 1); saveOrders(list); broadcast(); return sendJson(res, 200, { ok: true }); }
    return sendJson(res, 405, { error: '方法不支持' });
  }

  let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: '禁止访问' });
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, 404, { error: '找不到页面' });
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`已启动，端口 ${PORT}，数据目录 ${DATA_DIR}`));
