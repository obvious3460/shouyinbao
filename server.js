'use strict';
/* ============================================================
 * 收银宝 · 服务端（零依赖版）
 * 仅使用 Node.js 内置模块：http / fs / path / os / node:sqlite
 *
 * 启动：node server.js   （或双击 启动服务.bat）
 * 端口：默认 3000，可用环境变量 PORT 修改
 * 数据库：data/shouyinbao.db（真实 SQLite 文件，可复制备份）
 *
 * 权限：按设备类型区分（User-Agent 判断）
 *   - 手机端：可记录销售、出库入库、出账、查看；不可改商品/会员/设置/等级
 *   - 电脑端：全部权限（含价格编辑）
 * ============================================================ */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { buildSystemPrompt, extractSql, execAiSql, parseChartContent, autoChart, detectChartIntent } = require('./ai-lib.js');

/* ---------- 常量 ---------- */
const PORT = parseInt(process.env.PORT || '3000', 10);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const BACKUP_DIR = path.join(ROOT, 'backup');
const DB_FILE = path.join(DATA_DIR, 'shouyinbao.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

/* ---------- 数据库 ---------- */
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');   // 并发读 + 崩溃安全
db.exec('PRAGMA synchronous = NORMAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS levels (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  rate REAL NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS products (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '未分类',
  price    REAL NOT NULL DEFAULT 0,
  cost     REAL NOT NULL DEFAULT 0,
  stock    REAL NOT NULL DEFAULT 0,
  unit     TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT DEFAULT '',
  level_id   INTEGER,
  points     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sales (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  no                  TEXT NOT NULL,
  time                INTEGER NOT NULL,
  subtotal            REAL NOT NULL,
  manual_rate         REAL NOT NULL DEFAULT 1,
  manual_discount_amt REAL NOT NULL DEFAULT 0,
  vip_rate            REAL NOT NULL DEFAULT 1,
  vip_discount        REAL NOT NULL DEFAULT 0,
  points_used         INTEGER NOT NULL DEFAULT 0,
  points_value        REAL NOT NULL DEFAULT 0,
  points_earned       INTEGER NOT NULL DEFAULT 0,
  payable             REAL NOT NULL,
  pay_method          TEXT NOT NULL DEFAULT '微信',
  cash_received       REAL,
  "change"            REAL,
  member_id           INTEGER,
  member_name         TEXT,
  member_level        TEXT,
  cashier             TEXT
);
CREATE TABLE IF NOT EXISTS sale_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id    INTEGER NOT NULL,
  product_id INTEGER,
  name       TEXT NOT NULL,
  category   TEXT DEFAULT '',
  price      REAL NOT NULL,
  cost       REAL NOT NULL DEFAULT 0,
  qty        REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS expenses (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  time     INTEGER NOT NULL,
  category TEXT NOT NULL,
  amount   REAL NOT NULL,
  note     TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS stock_moves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  time       INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  type       TEXT NOT NULL,   -- in 入库 / out 出库
  qty        REAL NOT NULL,
  note       TEXT DEFAULT ''
);
`);

/* 迁移：为历史数据库补充 sales.cashier 列 */
try {
  const cols = db.prepare('PRAGMA table_info(sales)').all().map(c => c.name);
  if (!cols.includes('cashier')) db.exec('ALTER TABLE sales ADD COLUMN cashier TEXT');
} catch (e) { console.warn('[迁移] sales.cashier 列添加失败：', e.message); }

/* AI 查询使用的只读连接（双重安全：白名单 + 只读） */
let dbRO = null;
try { dbRO = new DatabaseSync(DB_FILE, { readOnly: true }); } catch (e) { dbRO = null; }

/* ---------- 默认数据（首次启动自动写入示例） ---------- */
function seedIfEmpty(){
  const { c } = db.prepare('SELECT COUNT(*) c FROM products').get();
  if (c > 0) return;

  const insLevel = db.prepare('INSERT INTO levels (name, rate) VALUES (?, ?)');
  insLevel.run('普通会员', 0.98);
  insLevel.run('银卡会员', 0.95);
  insLevel.run('金卡会员', 0.92);
  insLevel.run('黑金会员', 0.88);

  const insProd = db.prepare('INSERT INTO products (name, category, price, cost, stock, unit) VALUES (?, ?, ?, ?, ?, ?)');
  [
    ['可口可乐', '饮料', 3.00, 2.10, 120, '瓶'],
    ['农夫山泉', '饮料', 2.00, 1.20, 200, '瓶'],
    ['鲜牛奶',   '饮料', 6.50, 4.80, 60,  '盒'],
    ['薯片',     '零食', 6.00, 3.60, 80,  '袋'],
    ['面包',     '零食', 5.00, 2.80, 45,  '个'],
    ['红烧牛肉面','零食', 4.00, 2.50, 90,  '桶'],
    ['红富士苹果','生鲜', 8.80, 5.50, 25,  '斤'],
    ['香蕉',     '生鲜', 5.60, 3.20, 30,  '斤'],
    ['抽纸',     '日用品', 12.00, 8.50, 40, '提'],
    ['牙膏',     '日用品', 15.00, 10.00, 35, '支'],
    ['洗洁精',   '日用品', 8.00, 5.20, 0,   '瓶']
  ].forEach(r => insProd.run(...r));

  const insMem = db.prepare('INSERT INTO members (name, phone, level_id, points, created_at) VALUES (?, ?, ?, ?, ?)');
  insMem.run('张三', '13800000001', 3, 1280, Date.now() - 86400000 * 30);
  insMem.run('李四', '13800000002', 1, 350,  Date.now() - 86400000 * 10);
  insMem.run('王五', '13800000003', 4, 5660, Date.now() - 86400000 * 60);

  const insExp = db.prepare('INSERT INTO expenses (time, category, amount, note) VALUES (?, ?, ?, ?)');
  insExp.run(Date.now() - 86400000 * 2, '进货', 1560.00, '日用品补货');
  insExp.run(Date.now() - 86400000 * 1, '水电', 320.50,  '上月水电费');
}
seedIfEmpty();

/* ---------- 设置 ---------- */
const SETTING_DEFAULTS = {
  shopName: '收银宝便利店', cashier: '收银员', pointsPerYuan: 1, pointsToYuan: 100, lowStock: 10,
  aiProvider: 'demo', aiBaseUrl: 'https://api.deepseek.com', aiKey: '', aiModel: 'deepseek-chat'
};
function getSettings(){
  const out = { ...SETTING_DEFAULTS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  out.pointsPerYuan = parseFloat(out.pointsPerYuan) || 0;
  out.pointsToYuan = parseInt(out.pointsToYuan, 10) || 100;
  out.lowStock = parseInt(out.lowStock, 10) || 10;
  if (!out.aiProvider) out.aiProvider = 'demo';
  delete out.seq;
  return out;
}
function setSetting(key, value){ db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)); }
function getSeq(){ const row = db.prepare("SELECT value FROM settings WHERE key='seq'").get(); return row ? parseInt(row.value, 10) || 1000 : 1000; }
function nextNo(){
  const seq = getSeq();
  setSetting('seq', seq + 1);
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return 'S' + `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}` + '-' + seq;
}

/* ---------- 小工具 ---------- */
function r2(n){ return Math.round((n + Number.EPSILON) * 100) / 100; }
function fmtD(ts){ const d = new Date(ts); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; }
function dayStart(ts){ const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dayEnd(ts){ const d = new Date(ts); d.setHours(23, 59, 59, 999); return d.getTime(); }
function isMobile(req){
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  return /mobile|android|iphone|ipad|ipod|windows phone/i.test(ua);
}
function json(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req){
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('请求体不是合法 JSON')); } });
    req.on('error', reject);
  });
}
function num(v, def){ const n = parseFloat(v); return isNaN(n) ? def : n; }

/* ---------- 折扣计算（与前端一致，服务端为准） ---------- */
function calcSale(items, member, pointsUse, manualDiscount, settings){
  const rows = items.map(it => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(it.productId);
    if (!p) throw new Error('商品不存在（id=' + it.productId + '）');
    const qty = Math.max(0.001, num(it.qty, 1));
    if (p.stock >= 0 && qty > p.stock) throw new Error(`「${p.name}」库存不足（剩余 ${p.stock}）`);
    return { ...p, qty };
  });
  const subtotal = r2(rows.reduce((a, r) => a + r.price * r.qty, 0));
  const manualRate = Math.min(100, Math.max(1, num(manualDiscount, 100))) / 100;
  const afterManual = r2(subtotal * manualRate);
  const manualDiscountAmt = r2(subtotal - afterManual);
  const rate = member ? (db.prepare('SELECT rate FROM levels WHERE id = ?').get(member.level_id) || {}).rate || 1 : 1;
  const vipDiscount = r2(afterManual - afterManual * rate);
  const afterVip = r2(afterManual * rate);
  let pu = Math.max(0, Math.floor(num(pointsUse, 0)));
  if (member) pu = Math.min(pu, member.points);
  const maxPointsValue = r2(afterVip * 0.5);
  const maxPoints = Math.floor(maxPointsValue * settings.pointsToYuan);
  pu = Math.min(pu, maxPoints);
  const pointsValue = r2(pu / settings.pointsToYuan);
  const payable = Math.max(0, r2(afterVip - pointsValue));
  const pointsEarned = Math.floor(payable * settings.pointsPerYuan);
  return { rows, subtotal, manualRate, manualDiscountAmt, vipRate: rate, vipDiscount, pointsUsed: pu, pointsValue, payable, pointsEarned, afterVip };
}

/* ---------- API 路由 ---------- */
const routes = [];
function route(method, pattern, handler, opts){
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:[^/]+/g, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, desktopOnly: !!(opts && opts.desktopOnly) });
}

/* --- 系统 --- */
route('GET', '/api/bootstrap', async (req, res) => {
  json(res, 200, {
    settings: getSettings(),
    levels: db.prepare('SELECT * FROM levels ORDER BY id').all(),
    products: db.prepare('SELECT * FROM products ORDER BY id').all(),
    members: db.prepare('SELECT * FROM members ORDER BY id').all(),
    device: isMobile(req) ? 'mobile' : 'desktop'
  });
});

route('GET', '/api/settings', async (req, res) => json(res, 200, getSettings()));
route('PUT', '/api/settings', async (req, res) => {
  const b = await readBody(req);
  setSetting('shopName', String(b.shopName || '收银宝便利店'));
  setSetting('cashier', String(b.cashier || '收银员'));
  setSetting('pointsPerYuan', num(b.pointsPerYuan, 1));
  setSetting('pointsToYuan', Math.max(1, parseInt(b.pointsToYuan, 10) || 100));
  setSetting('lowStock', Math.max(0, parseInt(b.lowStock, 10) || 10));
  setSetting('aiProvider', String(b.aiProvider || 'demo'));
  setSetting('aiBaseUrl', String(b.aiBaseUrl || 'https://api.deepseek.com'));
  setSetting('aiKey', typeof b.aiKey === 'string' ? b.aiKey : (getSettings().aiKey || ''));   // 未传时保留原密钥
  setSetting('aiModel', String(b.aiModel || 'deepseek-chat'));
  json(res, 200, getSettings());
}, { desktopOnly: true });

route('POST', '/api/reset-sample', async (req, res) => {
  db.exec('DELETE FROM sale_items; DELETE FROM sales; DELETE FROM stock_moves; DELETE FROM expenses; DELETE FROM members; DELETE FROM products; DELETE FROM levels; DELETE FROM settings;');
  seedIfEmpty();
  json(res, 200, { ok: true });
}, { desktopOnly: true });

route('POST', '/api/clear', async (req, res) => {
  db.exec('DELETE FROM sale_items; DELETE FROM sales; DELETE FROM stock_moves; DELETE FROM expenses; DELETE FROM members; DELETE FROM products; DELETE FROM levels; DELETE FROM settings;');
  setSetting('seq', 1000);
  json(res, 200, { ok: true });
}, { desktopOnly: true });

/* --- 商品 --- */
route('GET', '/api/products', async (req, res) => json(res, 200, db.prepare('SELECT * FROM products ORDER BY id').all()));
route('POST', '/api/products', async (req, res) => {
  const b = await readBody(req);
  const name = String(b.name || '').trim();
  if (!name) return json(res, 400, { error: '商品名称不能为空' });
  const r = db.prepare('INSERT INTO products (name, category, price, cost, stock, unit) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, String(b.category || '').trim() || '未分类', r2(num(b.price, 0)), r2(num(b.cost, 0)), num(b.stock, 0), String(b.unit || '').trim());
  json(res, 200, { id: Number(r.lastInsertRowid) });
}, { desktopOnly: true });
route('PUT', '/api/products/:id', async (req, res, p) => {
  const b = await readBody(req);
  const name = String(b.name || '').trim();
  if (!name) return json(res, 400, { error: '商品名称不能为空' });
  db.prepare('UPDATE products SET name=?, category=?, price=?, cost=?, stock=?, unit=? WHERE id=?')
    .run(name, String(b.category || '').trim() || '未分类', r2(num(b.price, 0)), r2(num(b.cost, 0)), num(b.stock, 0), String(b.unit || '').trim(), parseInt(p.id, 10));
  json(res, 200, { ok: true });
}, { desktopOnly: true });
route('DELETE', '/api/products/:id', async (req, res, p) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(parseInt(p.id, 10));
  json(res, 200, { ok: true });
}, { desktopOnly: true });

/* --- 会员 --- */
route('GET', '/api/members', async (req, res) => json(res, 200, db.prepare('SELECT * FROM members ORDER BY id').all()));
route('POST', '/api/members', async (req, res) => {
  const b = await readBody(req);
  const name = String(b.name || '').trim();
  if (!name) return json(res, 400, { error: '会员姓名不能为空' });
  const r = db.prepare('INSERT INTO members (name, phone, level_id, points, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, String(b.phone || '').trim(), parseInt(b.levelId, 10) || 1, Math.max(0, parseInt(b.points, 10) || 0), Date.now());
  json(res, 200, { id: Number(r.lastInsertRowid) });
}, { desktopOnly: true });
route('PUT', '/api/members/:id', async (req, res, p) => {
  const b = await readBody(req);
  const name = String(b.name || '').trim();
  if (!name) return json(res, 400, { error: '会员姓名不能为空' });
  db.prepare('UPDATE members SET name=?, phone=?, level_id=?, points=? WHERE id=?')
    .run(name, String(b.phone || '').trim(), parseInt(b.levelId, 10) || 1, Math.max(0, parseInt(b.points, 10) || 0), parseInt(p.id, 10));
  json(res, 200, { ok: true });
}, { desktopOnly: true });
route('DELETE', '/api/members/:id', async (req, res, p) => {
  db.prepare('DELETE FROM members WHERE id = ?').run(parseInt(p.id, 10));
  json(res, 200, { ok: true });
}, { desktopOnly: true });

/* --- 等级 --- */
route('GET', '/api/levels', async (req, res) => json(res, 200, db.prepare('SELECT * FROM levels ORDER BY id').all()));
route('POST', '/api/levels', async (req, res) => {
  const b = await readBody(req);
  const name = String(b.name || '').trim();
  const rate = num(b.rate, 1);
  if (!name) return json(res, 400, { error: '等级名称不能为空' });
  if (rate <= 0 || rate > 1) return json(res, 400, { error: '折扣率需在 0.01 ~ 1 之间' });
  const r = db.prepare('INSERT INTO levels (name, rate) VALUES (?, ?)').run(name, rate);
  json(res, 200, { id: Number(r.lastInsertRowid) });
}, { desktopOnly: true });
route('PUT', '/api/levels/:id', async (req, res, p) => {
  const b = await readBody(req);
  const name = String(b.name || '').trim();
  const rate = num(b.rate, 1);
  if (!name) return json(res, 400, { error: '等级名称不能为空' });
  if (rate <= 0 || rate > 1) return json(res, 400, { error: '折扣率需在 0.01 ~ 1 之间' });
  db.prepare('UPDATE levels SET name=?, rate=? WHERE id=?').run(name, rate, parseInt(p.id, 10));
  json(res, 200, { ok: true });
}, { desktopOnly: true });
route('DELETE', '/api/levels/:id', async (req, res, p) => {
  const id = parseInt(p.id, 10);
  const { c } = db.prepare('SELECT COUNT(*) c FROM levels').get();
  if (c <= 1) return json(res, 400, { error: '至少保留一个等级' });
  const used = db.prepare('SELECT COUNT(*) c FROM members WHERE level_id = ?').get(id).c;
  if (used > 0) return json(res, 400, { error: '该等级下还有会员，无法删除' });
  db.prepare('DELETE FROM levels WHERE id = ?').run(id);
  json(res, 200, { ok: true });
}, { desktopOnly: true });

/* --- 出账 --- */
route('GET', '/api/expenses', async (req, res) => json(res, 200, db.prepare('SELECT * FROM expenses ORDER BY time DESC').all()));
route('POST', '/api/expenses', async (req, res) => {
  const b = await readBody(req);
  const cat = String(b.category || '').trim();
  const amount = num(b.amount, 0);
  if (!cat) return json(res, 400, { error: '类别不能为空' });
  if (amount <= 0) return json(res, 400, { error: '金额需大于 0' });
  const time = typeof b.time === 'number' ? b.time : new Date(String(b.date || fmtD(Date.now())) + 'T00:00:00').getTime();
  const r = db.prepare('INSERT INTO expenses (time, category, amount, note) VALUES (?, ?, ?, ?)')
    .run(time, cat, r2(amount), String(b.note || '').trim());
  json(res, 200, { id: Number(r.lastInsertRowid) });
}, {});
route('PUT', '/api/expenses/:id', async (req, res, p) => {
  const b = await readBody(req);
  const cat = String(b.category || '').trim();
  const amount = num(b.amount, 0);
  if (!cat) return json(res, 400, { error: '类别不能为空' });
  if (amount <= 0) return json(res, 400, { error: '金额需大于 0' });
  const time = typeof b.time === 'number' ? b.time : new Date(String(b.date || fmtD(Date.now())) + 'T00:00:00').getTime();
  db.prepare('UPDATE expenses SET time=?, category=?, amount=?, note=? WHERE id=?')
    .run(time, cat, r2(amount), String(b.note || '').trim(), parseInt(p.id, 10));
  json(res, 200, { ok: true });
}, { desktopOnly: true });
route('DELETE', '/api/expenses/:id', async (req, res, p) => {
  db.prepare('DELETE FROM expenses WHERE id = ?').run(parseInt(p.id, 10));
  json(res, 200, { ok: true });
}, { desktopOnly: true });

/* --- 销售结算（事务：销售单 + 明细 + 扣库存 + 会员积分） --- */
route('POST', '/api/sales', async (req, res) => {
  const b = await readBody(req);
  if (!Array.isArray(b.items) || b.items.length === 0) return json(res, 400, { error: '购物车为空' });
  let s, member, payMethod, cashReceived, change, cashier;
  try {
    const settings = getSettings();
    cashier = String(b.cashier || settings.cashier || '').trim();
    member = b.memberId ? db.prepare('SELECT * FROM members WHERE id = ?').get(parseInt(b.memberId, 10)) : null;
    s = calcSale(b.items, member, b.pointsUse, b.manualDiscount, settings);
    payMethod = String(b.payMethod || '微信');
    cashReceived = null; change = null;
    if (payMethod === '现金'){
      cashReceived = num(b.cashReceived, s.payable);
      if (cashReceived + 0.001 < s.payable) throw new Error('实收现金不足：应收 ' + s.payable.toFixed(2) + ' 元');
      change = r2(cashReceived - s.payable);
    }
  } catch (e){
    return json(res, 400, { error: e.message });
  }

  const no = nextNo();
  const time = Date.now();
  db.exec('BEGIN');
  try {
    const r = db.prepare(`INSERT INTO sales (no, time, subtotal, manual_rate, manual_discount_amt, vip_rate, vip_discount,
        points_used, points_value, points_earned, payable, pay_method, cash_received, "change",
        member_id, member_name, member_level, cashier)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(no, time, s.subtotal, s.manualRate, s.manualDiscountAmt, s.vipRate, s.vipDiscount,
        s.pointsUsed, s.pointsValue, s.pointsEarned, s.payable, payMethod, cashReceived, change,
        member ? member.id : null, member ? member.name : null,
        member ? (db.prepare('SELECT name FROM levels WHERE id = ?').get(member.level_id) || {}).name : null,
        cashier);
    const saleId = Number(r.lastInsertRowid);

    const insItem = db.prepare('INSERT INTO sale_items (sale_id, product_id, name, category, price, cost, qty) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const updStock = db.prepare('UPDATE products SET stock = ? WHERE id = ?');
    for (const row of s.rows){
      insItem.run(saleId, row.id, row.name, row.category, row.price, row.cost, row.qty);
      if (row.stock >= 0){
        const left = Math.max(0, r2(row.stock - row.qty));
        updStock.run(left, row.id);
      }
    }
    if (member){
      db.prepare('UPDATE members SET points = ? WHERE id = ?')
        .run(Math.max(0, member.points - s.pointsUsed) + s.pointsEarned, member.id);
    }
    db.exec('COMMIT');
    json(res, 200, {
      id: saleId, no, time,
      items: s.rows.map(r2 => ({ productId: r2.id, name: r2.name, category: r2.category, price: r2.price, cost: r2.cost, qty: r2.qty })),
      subtotal: s.subtotal, manualDiscountAmt: s.manualDiscountAmt, vipDiscount: s.vipDiscount,
      pointsUsed: s.pointsUsed, pointsValue: s.pointsValue, pointsEarned: s.pointsEarned,
      payable: s.payable, payMethod, cashReceived, change,
      memberName: member ? member.name : null, memberLevel: member ? (db.prepare('SELECT name FROM levels WHERE id = ?').get(member.level_id) || {}).name : null
    });
  } catch (e){
    db.exec('ROLLBACK');
    throw e;
  }
});

/* --- 销售查询 --- */
route('GET', '/api/sales', async (req, res, rparams, url) => {
  let sql = 'SELECT * FROM sales';
  const params = [];
  const conds = [];
  if (url.searchParams.get('from')){
    conds.push('time >= ?');
    params.push(dayStart(new Date(url.searchParams.get('from') + 'T00:00:00').getTime()));
  }
  if (url.searchParams.get('to')){
    conds.push('time <= ?');
    params.push(dayEnd(new Date(url.searchParams.get('to') + 'T00:00:00').getTime()));
  }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY time DESC';
  const sales = db.prepare(sql).all(...params);
  const items = db.prepare('SELECT * FROM sale_items ORDER BY id').all();
  const bySale = {};
  for (const it of items){ (bySale[it.sale_id] = bySale[it.sale_id] || []).push(it); }
  for (const s of sales) s.items = bySale[s.id] || [];
  json(res, 200, sales);
});

/* --- 出入库 --- */
route('POST', '/api/stock', async (req, res) => {
  const b = await readBody(req);
  const pid = parseInt(b.productId, 10);
  const type = b.type === 'out' ? 'out' : 'in';
  const qty = num(b.qty, 0);
  if (!pid || qty <= 0) return json(res, 400, { error: '请选择商品并填写正确的数量' });
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(pid);
  if (!p) return json(res, 400, { error: '商品不存在' });
  db.exec('BEGIN');
  try {
    let newStock;
    if (type === 'in') newStock = p.stock < 0 ? p.stock : r2(p.stock + qty);
    else newStock = p.stock < 0 ? p.stock : Math.max(0, r2(p.stock - qty));
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(newStock, pid);
    db.prepare('INSERT INTO stock_moves (time, product_id, type, qty, note) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), pid, type, qty, String(b.note || '').trim());
    db.exec('COMMIT');
    json(res, 200, { ok: true, newStock });
  } catch (e){
    db.exec('ROLLBACK');
    throw e;
  }
});
route('GET', '/api/stock-moves', async (req, res, params, url) => {
  const limit = Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10));
  const moves = db.prepare('SELECT * FROM stock_moves ORDER BY id DESC LIMIT ?').all(limit);
  const names = {};
  for (const p of db.prepare('SELECT id, name FROM products').all()) names[p.id] = p.name;
  for (const m of moves) m.productName = names[m.product_id] || ('#' + m.product_id);
  json(res, 200, moves);
});

/* --- 首页概览 --- */
route('GET', '/api/dashboard', async (req, res) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t0 = today.getTime(), t1 = today.getTime() + 86400000 - 1;
  const saleRows = db.prepare('SELECT * FROM sales WHERE time BETWEEN ? AND ?').all(t0, t1);
  const expRows = db.prepare('SELECT * FROM expenses WHERE time BETWEEN ? AND ?').all(t0, t1);
  const revenue = r2(saleRows.reduce((a, s) => a + s.payable, 0));
  const expense = r2(expRows.reduce((a, e) => a + e.amount, 0));
  const settings = getSettings();
  const lowStock = db.prepare('SELECT * FROM products WHERE stock >= 0 AND stock <= ? ORDER BY stock ASC').all(settings.lowStock);
  const recent = [];
  for (const s of saleRows) recent.push({ time: s.time, kind: 'in', text: '销售 ' + s.no, amt: s.payable, note: '收银 ' + s.pay_method });
  for (const e of expRows) recent.push({ time: e.time, kind: 'out', text: '出账 · ' + e.category, amt: -e.amount, note: e.note || '' });
  recent.sort((a, b) => b.time - a.time);
  json(res, 200, { orders: saleRows.length, revenue, expense, net: r2(revenue - expense), lowStock: lowStock.slice(0, 12), recent: recent.slice(0, 8) });
});

/* --- 统计分析 --- */
route('GET', '/api/stats', async (req, res, params, url) => {
  const from = url.searchParams.get('from') || fmtD(Date.now());
  const to = url.searchParams.get('to') || fmtD(Date.now());
  const t0 = dayStart(new Date(from + 'T00:00:00').getTime());
  const t1 = dayEnd(new Date(to + 'T00:00:00').getTime());
  const sales = db.prepare('SELECT * FROM sales WHERE time BETWEEN ? AND ?').all(t0, t1);
  const exps = db.prepare('SELECT * FROM expenses WHERE time BETWEEN ? AND ?').all(t0, t1);
  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE time BETWEEN ? AND ?)').all(t0, t1);

  const revenue = r2(sales.reduce((a, s) => a + s.payable, 0));
  const vipGive = r2(sales.reduce((a, s) => a + s.vipDiscount + s.pointsValue, 0));
  const expense = r2(exps.reduce((a, e) => a + e.amount, 0));
  const gross = r2(items.reduce((a, it) => a + (it.price - it.cost) * it.qty, 0));

  const week = [];
  for (let i = 6; i >= 0; i--){
    const d = new Date(); d.setDate(d.getDate() - i);
    const ds = fmtD(d.getTime());
    const w0 = dayStart(d.getTime()), w1 = dayEnd(d.getTime());
    const v = r2(db.prepare('SELECT SUM(payable) s FROM sales WHERE time BETWEEN ? AND ?').get(w0, w1).s || 0);
    week.push({ label: ds.slice(5), value: v });
  }
  const catMap = {};
  for (const it of items) catMap[it.category] = (catMap[it.category] || 0) + it.price * it.qty;
  const categories = Object.entries(catMap).map(([name, value]) => ({ name, value: r2(value) })).sort((a, b) => b.value - a.value);

  json(res, 200, { orders: sales.length, revenue, vipGive, expense, gross, net: r2(gross - expense), week, categories });
});

/* --- 报表（日报 / 周报 / 月报） --- */
route('GET', '/api/report', async (req, res, params, url) => {
  const type = ['daily', 'weekly', 'monthly'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'daily';
  const dateStr = url.searchParams.get('date') || fmtD(Date.now());
  const base = new Date(dateStr + 'T00:00:00');
  let from, to;
  if (type === 'daily'){ from = new Date(base); to = new Date(base); }
  else if (type === 'weekly'){
    const dow = (base.getDay() + 6) % 7;              // 周一为一周起点
    from = new Date(base); from.setDate(base.getDate() - dow);
    to = new Date(from); to.setDate(from.getDate() + 6);
  } else {
    from = new Date(base.getFullYear(), base.getMonth(), 1);
    to = new Date(base.getFullYear(), base.getMonth() + 1, 0);
  }
  const t0 = dayStart(from.getTime()), t1 = dayEnd(to.getTime());
  const sales = db.prepare('SELECT * FROM sales WHERE time BETWEEN ? AND ? ORDER BY time').all(t0, t1);
  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE time BETWEEN ? AND ?)').all(t0, t1);
  const exps = db.prepare('SELECT * FROM expenses WHERE time BETWEEN ? AND ? ORDER BY time DESC').all(t0, t1);

  const revenue = r2(sales.reduce((a, s) => a + s.payable, 0));
  const gross = r2(items.reduce((a, it) => a + (it.price - it.cost) * it.qty, 0));
  const vipGive = r2(sales.reduce((a, s) => a + s.vipDiscount + s.pointsValue, 0));
  const pointsIssued = sales.reduce((a, s) => a + s.pointsEarned, 0);
  const expense = r2(exps.reduce((a, e) => a + e.amount, 0));
  const orders = sales.length;
  const avgOrder = orders ? r2(revenue / orders) : 0;
  const newMembers = db.prepare('SELECT COUNT(*) c FROM members WHERE created_at BETWEEN ? AND ?').get(t0, t1).c;
  const settings = getSettings();

  // 每日明细
  const daily = [];
  for (let d = new Date(t0); d.getTime() <= t1; d.setDate(d.getDate() + 1)){
    const ds = fmtD(d.getTime());
    const weekday = '星期' + ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    const dsales = sales.filter(s => fmtD(s.time) === ds);
    const dexps = exps.filter(e => fmtD(e.time) === ds);
    daily.push({
      date: ds, weekday,
      orders: dsales.length,
      revenue: r2(dsales.reduce((a, s) => a + s.payable, 0)),
      expense: r2(dexps.reduce((a, e) => a + e.amount, 0))
    });
  }

  // 热销商品 Top10
  const prodMap = {};
  for (const it of items){
    prodMap[it.name] = prodMap[it.name] || { name: it.name, qty: 0, amount: 0 };
    prodMap[it.name].qty = r2(prodMap[it.name].qty + it.qty);
    prodMap[it.name].amount = r2(prodMap[it.name].amount + it.price * it.qty);
  }
  const topProducts = Object.values(prodMap).sort((a, b) => b.amount - a.amount).slice(0, 10);

  // 支付方式分布
  const payMap = {};
  for (const s of sales){
    payMap[s.pay_method] = payMap[s.pay_method] || { method: s.pay_method, count: 0, amount: 0 };
    payMap[s.pay_method].count++;
    payMap[s.pay_method].amount = r2(payMap[s.pay_method].amount + s.payable);
  }
  const payMethods = Object.values(payMap).sort((a, b) => b.amount - a.amount);

  // 支出分类合计
  const expCatMap = {};
  for (const e of exps){
    expCatMap[e.category] = expCatMap[e.category] || { category: e.category, count: 0, amount: 0 };
    expCatMap[e.category].count++;
    expCatMap[e.category].amount = r2(expCatMap[e.category].amount + e.amount);
  }
  const expenseCats = Object.values(expCatMap).sort((a, b) => b.amount - a.amount);

  json(res, 200, {
    type,
    shopName: settings.shopName,
    generatedAt: Date.now(),
    range: {
      from: fmtD(t0), to: fmtD(t1),
      label: type === 'daily' ? fmtD(t0) : fmtD(t0) + ' 至 ' + fmtD(t1)
    },
    summary: { orders, revenue, avgOrder, vipGive, pointsIssued, gross, expense, net: r2(gross - expense), newMembers },
    daily, topProducts, payMethods, expenseCats, expenseList: exps.slice(0, 30)
  });
});

/* --- AI 助手 --- */
async function callLLM(settings, messages, jsonMode){
  const base = String(settings.aiBaseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const body = { model: settings.aiModel || 'deepseek-chat', messages, temperature: 0.2, stream: false };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + settings.aiKey },
    body: JSON.stringify(body)
  });
  if (!r.ok){
    const t = await r.text().catch(() => '');
    throw new Error('AI 接口 HTTP ' + r.status + ' ' + t.slice(0, 300));
  }
  const d = await r.json();
  const content = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  if (!content) throw new Error('AI 返回内容为空');
  return String(content);
}

/* 近 7 天营业额（用于演示模式图表） */
function last7DaysRevenue(){
  const week = [];
  for (let i = 6; i >= 0; i--){
    const d = new Date(); d.setDate(d.getDate() - i);
    const ds = fmtD(d.getTime());
    const v = r2(db.prepare('SELECT SUM(payable) s FROM sales WHERE time BETWEEN ? AND ?').get(dayStart(d.getTime()), dayEnd(d.getTime())).s || 0);
    week.push({ label: ds.slice(5), value: v });
  }
  return week;
}

route('POST', '/api/chat', async (req, res) => {
  const b = await readBody(req);
  const msg = String(b.message || '').trim();
  if (!msg) return json(res, 400, { error: '请输入要咨询的问题' });
  const settings = getSettings();

  // 演示模式：无需密钥，展示"提问 → 查库 → 图表 → 总结"完整管道
  if (settings.aiProvider === 'demo'){
    const demoSql = "SELECT name AS 商品, SUM(qty) AS 销量, ROUND(SUM(price*qty),2) AS 销售额 FROM sale_items GROUP BY name ORDER BY 销售额 DESC LIMIT 5";
    const rows = execAiSql(dbRO || db, demoSql);
    const lines = rows.map((r, i) => `${i + 1}. ${r['商品']}　销量 ${r['销量']}，销售额 ¥${r['销售额']}`).join('\n');
    const week = last7DaysRevenue();
    const demoChart = { type: 'line', title: '近 7 天营业额趋势（演示）', x: week.map(w => w.label), y: week.map(w => w.value) };
    return json(res, 200, {
      reply: '【演示模式】AI 查询管道工作正常 ✅（正式使用请在系统设置填写 AI 接口密钥）。\n\n示例：按销售额统计的商品排行：\n' + (lines || '（暂无销售数据）'),
      sql: demoSql, rows, demo: true, chart: demoChart
    });
  }

  if (!settings.aiKey) return json(res, 400, { error: '请先在「系统设置 → AI 助手配置」填写 API 密钥（或选择演示模式）' });
  const chartIntent = detectChartIntent(msg);
  try {
    const sys = buildSystemPrompt();
    // 意图引导：账单→汇总图；明细→逐笔交易字段（时间、处理人、商品、金额等）
    const sysExtra = chartIntent === 'force'
      ? '\n补充指令：用户想看账单/汇总图表。若用户未指明具体范围，请默认查询"最近一个月每天的营业额"（按日分组求和），直接输出 SQL，不要反问用户要哪方面账单。'
      : chartIntent === 'text'
        ? '\n补充指令：用户想看逐笔交易明细。请查询交易明细并选择能展示完整信息的字段：格式化后的时间(datetime)、收银员/处理人(cashier)、商品名称(sale_items.name)、数量(qty)、金额(payable)、支付方式(pay_method)、会员姓名(member_name)等，按时间倒序排列，不要聚合汇总。'
        : '';
    const first = await callLLM(settings, [
      { role: 'system', content: sys + sysExtra },
      { role: 'user', content: msg }
    ]);
    const sql = extractSql(first);
    if (!sql){
      // 看账单意图但模型未查库 → 服务端自动生成默认账单图表（近 30 天营业额）
      if (chartIntent === 'force'){
        const days = [];
        for (let i = 29; i >= 0; i--){
          const d = new Date(); d.setDate(d.getDate() - i);
          const ds = fmtD(d.getTime());
          const v = r2(db.prepare('SELECT SUM(payable) s FROM sales WHERE time BETWEEN ? AND ?').get(dayStart(d.getTime()), dayEnd(d.getTime())).s || 0);
          days.push({ label: ds, value: v });
        }
        const total = r2(days.reduce((a, d) => a + d.value, 0));
        const activeDays = days.filter(d => d.value > 0).length;
        const chart = { type: 'line', title: '近 30 天营业额趋势', x: days.map(d => d.label.slice(5)), y: days.map(d => d.value) };
        const reply = `已自动生成本期账单汇总（近 30 天）：\n· 总营业额 ¥${total.toFixed(2)}\n· 有营业天数 ${activeDays} 天\n\n可以再指定范围，例如：「查看7月账单」「查看张三的账单」「查看员工李娜的账单」。`;
        return json(res, 200, { reply, chart, sql: null, rows: null, intent: chartIntent, auto: true });
      }
      // 明细意图但模型未查库 → 服务端兜底：最近 20 笔交易逐笔列出
      if (chartIntent === 'text'){
        const recent = db.prepare('SELECT * FROM sales ORDER BY time DESC LIMIT 20').all();
        const items = db.prepare('SELECT * FROM sale_items ORDER BY id DESC LIMIT 500').all();
        const bySale = {};
        for (const it of items){ (bySale[it.sale_id] = bySale[it.sale_id] || []).push(it); }
        const rows = recent.map(s => ({
          时间: fmtDT(s.time), 单号: s.no, 处理人: s.cashier || '-', 会员: s.member_name || '-',
          商品: (bySale[s.id] || []).map(it => `${it.name}×${it.qty}`).join('、'),
          金额: s.payable, 支付: s.pay_method
        }));
        return json(res, 200, {
          reply: `已自动列出最近 ${rows.length} 笔交易明细（每笔含时间与处理人；如需更早或指定日期，请补充说明）：`,
          rows, sql: null, intent: chartIntent, detail: true
        });
      }
      return json(res, 200, { reply: first, sql: null, rows: null, intent: chartIntent });
    }
    const rows = execAiSql(dbRO || db, sql);
    // 第二段调用：请模型用 JSON 输出"回答 + 可选图表"，让"查看账单/图表"类提问自动配图
    const jsonMode = !['ollama', 'custom'].includes(settings.aiProvider);
    const nowD = new Date(); const p2 = n => String(n).padStart(2, '0');
    const curDate = `${nowD.getFullYear()}-${p2(nowD.getMonth()+1)}-${p2(nowD.getDate())}`;
    // 意图识别：用户想看"账单/汇总"→ 强制出图；想看"明细"→ 不出图（chartIntent 已在上方定义）
    const chartInstr = chartIntent === 'force'
      ? '用户希望以图表形式查看账单/汇总。**必须**输出 chart（按数据选择 bar/line/pie 最合适的），chart 不得为 null。'
      : chartIntent === 'text'
        ? '用户想看的是逐笔明细/记录清单，不需要图表，chart 固定为 null。'
        : '当数据用图表展示更直观（趋势/对比/占比/排行）时给出一张图，否则为 null。';
    const answerInstr = chartIntent === 'text'
      ? '请**逐条列出**查询结果中的每一笔交易，不要汇总、不要省略、不要概括成一句话。每笔写明：时间、处理人（收银员/现金ier）、商品、数量、金额、支付方式等字段；开头注明共 N 笔。'
      : '用简洁的简体中文总结下面的查询结果来回答用户的问题，不要编造或夸大数字；结果为空就如实说明。';
    const second = await callLLM(settings, [
      { role: 'system', content: `今天是 ${curDate}（用户问题中未写明年份的日期默认是 ${nowD.getFullYear()} 年）。你是「收银宝」店铺管理系统的数据分析助手。请以 JSON 格式输出，仅两个字段：
1. "answer"：${answerInstr}
2. "chart"：${chartInstr}
   chart 格式：{"type":"bar"|"line"|"pie","title":"标题","x":["标签1","标签2",...],"y":[数值1,数值2,...]}
   - bar 柱状图：排行/对比（如商品销售额、员工业绩）
   - line 折线图：随时间趋势（如每日营业额）
   - pie 饼图：占比分布（如支付方式、分类占比）
   y 数值保留最多 2 位小数；数据点不超过 40 个；不得传空数组；不要输出 JSON 以外的任何内容。` },
      { role: 'user', content: '用户问题：' + msg + '\n\n执行的SQL：\n' + sql + '\n\n查询结果(JSON)：\n' + JSON.stringify(rows).slice(0, 8000) }
    ], jsonMode);
    const parsed = parseChartContent(second);
    // 模型未出图时，自动根据结果兜底生成图表
    const chart = parsed.chart || autoChart(rows);
    return json(res, 200, { reply: parsed.answer, chart, sql, rows, intent: chartIntent, detail: chartIntent === 'text' });
  } catch (e){
    return json(res, 500, { error: 'AI 处理失败：' + e.message });
  }
}, { desktopOnly: true });

route('POST', '/api/ai-test', async (req, res) => {
  const settings = getSettings();
  if (!settings.aiKey) return json(res, 400, { error: '尚未填写 API 密钥' });
  try {
    const t0 = Date.now();
    const reply = await callLLM(settings, [{ role: 'user', content: '请只回复两个字：正常' }]);
    return json(res, 200, { ok: true, reply: String(reply).slice(0, 100), ms: Date.now() - t0 });
  } catch (e){
    return json(res, 400, { error: e.message });
  }
}, { desktopOnly: true });

/* --- 备份下载 --- */
route('GET', '/api/backup', async (req, res) => {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');   // 把 WAL 合并进主文件，保证备份完整
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  const fname = `shouyinbao_${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.db`;
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${fname}"`
  });
  fs.createReadStream(DB_FILE).pipe(res);
});

/* ---------- 静态文件 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.map': 'application/json'
};
function serveStatic(req, res, pathname){
  let rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, 'index.html')){
    return json(res, 403, { error: '禁止访问' });
  }
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: '页面不存在' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------- 路由分发 ---------- */
async function handle(req, res){
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')){
      for (const r of routes){
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        if (r.desktopOnly && isMobile(req)) return json(res, 403, { error: '手机端无此权限，请在电脑端操作' });
        const params = {};
        r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
        return await r.handler(req, res, params, url);
      }
      return json(res, 404, { error: '接口不存在' });
    }
    return serveStatic(req, res, url.pathname);
  } catch (e){
    console.error('[错误]', e);
    return json(res, 500, { error: String((e && e.message) || e) });
  }
}

/* ---------- 每日自动备份（23:00，保留最近 7 份） ---------- */
function dailyBackup(){
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  const fname = `shouyinbao_${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}.db`;
  try {
    fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, fname));
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('shouyinbao_') && f.endsWith('.db')).sort();
    while (files.length > 7){ fs.unlinkSync(path.join(BACKUP_DIR, files.shift())); }
    console.log('[备份] 已完成：' + fname);
  } catch (e){ console.error('[备份失败]', e.message); }
}
function scheduleDailyBackup(){
  const check = () => {
    const now = new Date();
    if (now.getHours() === 23 && now.getMinutes() >= 0 && now.getMinutes() < 5) dailyBackup();
  };
  check();
  setInterval(check, 5 * 60 * 1000);
}

/* ---------- 启动 ---------- */
const server = http.createServer(handle);
server.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log('  💰 收银宝服务端已启动');
  console.log('  本机访问:  http://127.0.0.1:' + PORT);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)){
    for (const n of nets[name]){
      if (n.family === 'IPv4' && !n.internal){
        console.log('  局域网访问: http://' + n.address + ':' + PORT + '  （手机/其他电脑）');
      }
    }
  }
  console.log('  数据库文件: ' + DB_FILE);
  console.log('  备份目录:   ' + BACKUP_DIR + '（每天 23:00 自动备份，保留 7 天）');
  console.log('  手机端仅可记录与出入库；价格等管理请在电脑端操作');
  console.log('==============================================');
});

process.on('SIGINT', () => { console.log('\n正在关闭...'); try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (e) {} process.exit(0); });
