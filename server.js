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
 *   - 手机端：仅可新增销售和支出记账，不可查看历史流水、统计或管理数据
 *   - 电脑端：可查看流水、统计，并拥有完整管理权限
 * ============================================================ */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { buildSystemPrompt, extractSql, execAiSql, parseChartContent, autoChart, detectChartIntent } = require('./ai-lib.js');
const { detectBusinessIntent, resolveDateRange, rangeText } = require('./business-ai.js');

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
  unit     TEXT DEFAULT '',
  kind     TEXT NOT NULL DEFAULT 'goods'
);
CREATE TABLE IF NOT EXISTS service_materials (
  service_id  INTEGER NOT NULL,
  material_id INTEGER NOT NULL,
  qty         REAL NOT NULL,
  PRIMARY KEY (service_id, material_id)
);
CREATE TABLE IF NOT EXISTS members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT DEFAULT '',
  level_id   INTEGER,
  points     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS employees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
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
  cashier             TEXT,
  employee_id         INTEGER,
  employee_name       TEXT
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
  note     TEXT DEFAULT '',
  employee_id INTEGER,
  employee_name TEXT
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

/* 迁移：旧商品默认作为实物商品 */
try {
  const cols = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
  if (!cols.includes('kind')) db.exec("ALTER TABLE products ADD COLUMN kind TEXT NOT NULL DEFAULT 'goods'");
} catch (e) { console.warn('[迁移] products.kind 列添加失败：', e.message); }

/* 迁移：为历史数据库补充 sales.cashier 列 */
try {
  const cols = db.prepare('PRAGMA table_info(sales)').all().map(c => c.name);
  if (!cols.includes('cashier')) db.exec('ALTER TABLE sales ADD COLUMN cashier TEXT');
  if (!cols.includes('employee_id')) db.exec('ALTER TABLE sales ADD COLUMN employee_id INTEGER');
  if (!cols.includes('employee_name')) db.exec('ALTER TABLE sales ADD COLUMN employee_name TEXT');
} catch (e) { console.warn('[迁移] sales.cashier 列添加失败：', e.message); }
try {
  const cols = db.prepare('PRAGMA table_info(expenses)').all().map(c => c.name);
  if (!cols.includes('employee_id')) db.exec('ALTER TABLE expenses ADD COLUMN employee_id INTEGER');
  if (!cols.includes('employee_name')) db.exec('ALTER TABLE expenses ADD COLUMN employee_name TEXT');
} catch (e) { console.warn('[迁移] expenses.employee 列添加失败：', e.message); }

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

function ensureDefaultEmployee(){
  const row = db.prepare('SELECT id, username, name, active, created_at FROM employees ORDER BY id LIMIT 1').get();
  if (row) return row;
  const createdAt = Date.now();
  const r = db.prepare('INSERT INTO employees (username, name, password_hash, active, created_at) VALUES (?, ?, ?, 1, ?)')
    .run('employee', '默认员工', hashPassword('123456'), createdAt);
  console.log('  默认员工账号已创建：employee / 123456（请在电脑端员工管理中修改密码）');
  return db.prepare('SELECT id, username, name, active, created_at FROM employees WHERE id = ?').get(Number(r.lastInsertRowid));
}
ensureDefaultEmployee();

/* ---------- 设置 ---------- */
const SETTING_DEFAULTS = {
  shopName: '收银宝便利店', cashier: '收银员', pointsPerYuan: 1, lowStock: 10,
  aiProvider: 'demo', aiBaseUrl: 'https://api.deepseek.com', aiKey: '', aiModel: 'deepseek-chat'
};
function getSettings(){
  const out = { ...SETTING_DEFAULTS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  out.pointsPerYuan = parseFloat(out.pointsPerYuan) || 0;
  out.lowStock = parseInt(out.lowStock, 10) || 10;
  delete out.pointsToYuan;
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
function fmtDT(ts){ const d = new Date(ts); const p = n => String(n).padStart(2, '0'); return `${fmtD(ts)} ${p(d.getHours())}:${p(d.getMinutes())}`; }
function dayStart(ts){ const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dayEnd(ts){ const d = new Date(ts); d.setHours(23, 59, 59, 999); return d.getTime(); }
function isMobile(req){
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  return /mobile|android|iphone|ipad|ipod|windows phone/i.test(ua);
}
function json(res, code, obj, extraHeaders){
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
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

/* ---------- 员工登录与记录归属 ---------- */
const SESSION_COOKIE = 'shouyinbao_session';
const sessions = new Map();
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
function hashPassword(password){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored){
  const parts = String(stored || '').split(':');
  if (parts.length !== 2) return false;
  try {
    const actual = crypto.scryptSync(String(password), parts[0], 64);
    const expected = Buffer.from(parts[1], 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (e) { return false; }
}
function parseCookies(req){
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')){
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function getEmployee(req){
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()){
    sessions.delete(token);
    return null;
  }
  const employee = db.prepare('SELECT id, username, name, active, created_at FROM employees WHERE id = ?').get(session.employeeId);
  if (!employee || !employee.active){
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL;
  return employee;
}
function publicEmployee(employee){
  return employee ? { id: employee.id, username: employee.username, name: employee.name, active: !!employee.active } : null;
}
function employeeForRecord(req, body){
  const signedIn = getEmployee(req);
  if (signedIn) return signedIn;
  const id = parseInt(body && body.employeeId, 10);
  if (id){
    const selected = db.prepare('SELECT id, username, name, active, created_at FROM employees WHERE id = ? AND active = 1').get(id);
    if (selected) return selected;
  }
  const cashier = String((body && body.cashier) || '').trim();
  if (cashier){
    return db.prepare('SELECT id, username, name, active, created_at FROM employees WHERE name = ? AND active = 1').get(cashier) || null;
  }
  return null;
}
function requireMobileEmployee(req, res){
  if (!isMobile(req)) return getEmployee(req);
  const employee = getEmployee(req);
  if (!employee) json(res, 401, { error: '请先登录员工账号' });
  return employee;
}

/* ---------- 折扣计算（与前端一致，服务端为准） ---------- */
function calcSale(items, member, manualDiscount, settings){
  const stockUse = new Map();
  const rows = items.map(it => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(it.productId);
    if (!p) throw new Error('商品不存在（id=' + it.productId + '）');
    if (p.kind === 'supply') throw new Error(`「${p.name}」是耗材，不能直接销售`);
    const qty = Number(it.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error(`「${p.name}」数量不正确`);
    let cost = p.cost;
    if (p.kind === 'service'){
      const materials = db.prepare('SELECT m.qty, p.* FROM service_materials m JOIN products p ON p.id = m.material_id WHERE m.service_id = ?').all(p.id);
      for (const material of materials){
        if (material.kind === 'service') throw new Error(`「${p.name}」的耗材配置无效`);
        cost += material.cost * material.qty;
        const use = stockUse.get(material.id) || { product: material, qty: 0, serviceQty: 0 };
        use.qty += material.qty * qty;
        use.serviceQty += material.qty * qty;
        stockUse.set(material.id, use);
      }
    } else {
      const use = stockUse.get(p.id) || { product: p, qty: 0, serviceQty: 0 };
      use.qty += qty;
      stockUse.set(p.id, use);
    }
    return { ...p, cost: r2(cost), qty };
  });
  for (const use of stockUse.values()){
    if (!Number.isFinite(use.qty)) throw new Error('耗材用量超出范围');
    if (use.product.stock >= 0 && use.qty > use.product.stock + 0.000001){
      throw new Error(`「${use.product.name}」库存不足（需要 ${Math.round(use.qty * 1000) / 1000}，剩余 ${use.product.stock}）`);
    }
  }
  const subtotal = r2(rows.reduce((a, r) => a + r.price * r.qty, 0));
  const manualRate = Math.min(100, Math.max(1, num(manualDiscount, 100))) / 100;
  const afterManual = r2(subtotal * manualRate);
  const manualDiscountAmt = r2(subtotal - afterManual);
  const rate = member ? (db.prepare('SELECT rate FROM levels WHERE id = ?').get(member.level_id) || {}).rate || 1 : 1;
  const vipDiscount = r2(afterManual - afterManual * rate);
  const afterVip = r2(afterManual * rate);
  const payable = afterVip;
  const pointsEarned = Math.floor(payable * settings.pointsPerYuan);
  return { rows, stockUse, subtotal, manualRate, manualDiscountAmt, vipRate: rate, vipDiscount, pointsUsed: 0, pointsValue: 0, payable, pointsEarned, afterVip };
}

/* ---------- API 路由 ---------- */
const routes = [];
function route(method, pattern, handler, opts){
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:[^/]+/g, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, desktopOnly: !!(opts && opts.desktopOnly) });
}

/* --- 系统 --- */
route('POST', '/api/login', async (req, res) => {
  const b = await readBody(req);
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const employee = db.prepare('SELECT id, username, name, password_hash, active, created_at FROM employees WHERE username = ?').get(username);
  if (!employee || !employee.active || !verifyPassword(password, employee.password_hash)){
    return json(res, 401, { error: '账号或密码错误' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { employeeId: employee.id, expiresAt: Date.now() + SESSION_TTL });
  json(res, 200, { employee: publicEmployee(employee) }, {
    'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}`
  });
});
route('POST', '/api/logout', async (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  json(res, 200, { ok: true }, { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
});
route('GET', '/api/bootstrap', async (req, res) => {
  const mobile = isMobile(req);
  const employee = getEmployee(req);
  json(res, 200, {
    settings: getSettings(),
    levels: db.prepare('SELECT * FROM levels ORDER BY id').all(),
    products: db.prepare('SELECT * FROM products ORDER BY id').all(),
    serviceMaterials: db.prepare('SELECT service_id serviceId, material_id materialId, qty FROM service_materials ORDER BY service_id, material_id').all(),
    members: db.prepare('SELECT * FROM members ORDER BY id').all(),
    employees: mobile ? [] : db.prepare('SELECT id, username, name, active, created_at FROM employees ORDER BY id').all(),
    employee: publicEmployee(employee),
    requiresLogin: mobile,
    device: mobile ? 'mobile' : 'desktop'
  });
});

route('GET', '/api/settings', async (req, res) => json(res, 200, getSettings()), { desktopOnly: true });
route('PUT', '/api/settings', async (req, res) => {
  const b = await readBody(req);
  setSetting('shopName', String(b.shopName || '收银宝便利店'));
  setSetting('cashier', String(b.cashier || '收银员'));
  setSetting('pointsPerYuan', num(b.pointsPerYuan, 1));
  setSetting('lowStock', Math.max(0, parseInt(b.lowStock, 10) || 10));
  setSetting('aiProvider', String(b.aiProvider || 'demo'));
  setSetting('aiBaseUrl', String(b.aiBaseUrl || 'https://api.deepseek.com'));
  setSetting('aiKey', typeof b.aiKey === 'string' ? b.aiKey : (getSettings().aiKey || ''));   // 未传时保留原密钥
  setSetting('aiModel', String(b.aiModel || 'deepseek-chat'));
  json(res, 200, getSettings());
}, { desktopOnly: true });

route('POST', '/api/reset-sample', async (req, res) => {
  db.exec('DELETE FROM service_materials; DELETE FROM sale_items; DELETE FROM sales; DELETE FROM stock_moves; DELETE FROM expenses; DELETE FROM members; DELETE FROM products; DELETE FROM levels; DELETE FROM settings;');
  seedIfEmpty();
  json(res, 200, { ok: true });
}, { desktopOnly: true });

route('POST', '/api/clear', async (req, res) => {
  db.exec('DELETE FROM service_materials; DELETE FROM sale_items; DELETE FROM sales; DELETE FROM stock_moves; DELETE FROM expenses; DELETE FROM members; DELETE FROM products; DELETE FROM levels; DELETE FROM settings;');
  setSetting('seq', 1000);
  json(res, 200, { ok: true });
}, { desktopOnly: true });

/* --- 员工管理（电脑端） --- */
route('GET', '/api/employees', async (req, res) => {
  json(res, 200, db.prepare('SELECT id, username, name, active, created_at FROM employees ORDER BY id').all());
}, { desktopOnly: true });
route('POST', '/api/employees', async (req, res) => {
  const b = await readBody(req);
  const username = String(b.username || '').trim();
  const name = String(b.name || '').trim();
  const password = String(b.password || '');
  if (!username || !/^[\u4e00-\u9fffA-Za-z0-9_.-]{2,32}$/.test(username)) return json(res, 400, { error: '账号需为 2~32 位中文、字母、数字或 _.-' });
  if (!name) return json(res, 400, { error: '员工姓名不能为空' });
  if (password.length < 6) return json(res, 400, { error: '密码至少需要 6 位' });
  try {
    const r = db.prepare('INSERT INTO employees (username, name, password_hash, active, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(username, name, hashPassword(password), b.active === false ? 0 : 1, Date.now());
    json(res, 200, { id: Number(r.lastInsertRowid) });
  } catch (e){
    if (String(e.message).includes('UNIQUE')) return json(res, 400, { error: '账号已存在' });
    throw e;
  }
}, { desktopOnly: true });
route('PUT', '/api/employees/:id', async (req, res, p) => {
  const b = await readBody(req);
  const id = parseInt(p.id, 10);
  const name = String(b.name || '').trim();
  const password = String(b.password || '');
  if (!name) return json(res, 400, { error: '员工姓名不能为空' });
  if (password && password.length < 6) return json(res, 400, { error: '密码至少需要 6 位' });
  const active = b.active === false ? 0 : 1;
  if (password) db.prepare('UPDATE employees SET name=?, active=?, password_hash=? WHERE id=?').run(name, active, hashPassword(password), id);
  else db.prepare('UPDATE employees SET name=?, active=? WHERE id=?').run(name, active, id);
  json(res, 200, { ok: true });
}, { desktopOnly: true });
route('DELETE', '/api/employees/:id', async (req, res, p) => {
  const id = parseInt(p.id, 10);
  const total = db.prepare('SELECT COUNT(*) c FROM employees').get().c;
  if (total <= 1) return json(res, 400, { error: '至少保留一个员工账号' });
  db.prepare('DELETE FROM employees WHERE id = ?').run(id);
  json(res, 200, { ok: true });
}, { desktopOnly: true });

/* --- 商品 --- */
function productInput(b, existingId){
  const name = String(b.name || '').trim();
  if (!name) throw new Error('名称不能为空');
  const kind = b.kind || 'goods';
  if (!['goods', 'service', 'supply'].includes(kind)) throw new Error('项目类型不正确');
  const price = Number(b.price);
  const cost = Number(b.cost || 0);
  const stock = kind === 'service' ? -1 : Number(b.stock);
  if (![price, cost, stock].every(Number.isFinite) || price < 0 || cost < 0 || stock < -1) throw new Error('价格、成本或库存不正确');
  if (existingId && kind === 'service' && db.prepare('SELECT 1 FROM service_materials WHERE material_id = ?').get(existingId)){
    throw new Error('该项目已被服务作为耗材使用，不能改为服务');
  }
  const materials = [];
  const seen = new Set();
  if (kind === 'service'){
    if (!Array.isArray(b.materials || [])) throw new Error('耗材配置不正确');
    for (const item of b.materials || []){
      const materialId = Number(item.materialId);
      const qty = Number(item.qty);
      const material = db.prepare('SELECT id, kind FROM products WHERE id = ?').get(materialId);
      if (!material || material.kind === 'service' || materialId === existingId || seen.has(materialId) || !Number.isFinite(qty) || qty <= 0 || qty > 1000000){
        throw new Error('耗材项目或用量不正确');
      }
      seen.add(materialId);
      materials.push({ materialId, qty });
    }
  }
  return { name, kind, category: String(b.category || '').trim() || '未分类', price: r2(price), cost: r2(cost), stock,
    unit: String(b.unit || '').trim(), materials };
}
function writeMaterials(serviceId, materials){
  db.prepare('DELETE FROM service_materials WHERE service_id = ?').run(serviceId);
  const insert = db.prepare('INSERT INTO service_materials (service_id, material_id, qty) VALUES (?, ?, ?)');
  for (const material of materials) insert.run(serviceId, material.materialId, material.qty);
}
route('GET', '/api/products', async (req, res) => json(res, 200, db.prepare('SELECT * FROM products ORDER BY id').all()), { desktopOnly: true });
route('POST', '/api/products', async (req, res) => {
  const b = await readBody(req);
  let input;
  try { input = productInput(b, null); } catch (e){ return json(res, 400, { error: e.message }); }
  db.exec('BEGIN');
  try {
    const r = db.prepare('INSERT INTO products (name, category, price, cost, stock, unit, kind) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.name, input.category, input.price, input.cost, input.stock, input.unit, input.kind);
    const id = Number(r.lastInsertRowid);
    writeMaterials(id, input.materials);
    db.exec('COMMIT');
    json(res, 200, { id });
  } catch (e){ db.exec('ROLLBACK'); throw e; }
}, { desktopOnly: true });
route('PUT', '/api/products/:id', async (req, res, p) => {
  const b = await readBody(req);
  const id = parseInt(p.id, 10);
  const old = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!old) return json(res, 404, { error: '项目不存在' });
  let input;
  try { input = productInput({ ...b, kind: b.kind || old.kind }, id); } catch (e){ return json(res, 400, { error: e.message }); }
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE products SET name=?, category=?, price=?, cost=?, stock=?, unit=?, kind=? WHERE id=?')
      .run(input.name, input.category, input.price, input.cost, input.stock, input.unit, input.kind, id);
    writeMaterials(id, input.materials);
    db.exec('COMMIT');
    json(res, 200, { ok: true });
  } catch (e){ db.exec('ROLLBACK'); throw e; }
}, { desktopOnly: true });
route('DELETE', '/api/products/:id', async (req, res, p) => {
  const id = parseInt(p.id, 10);
  if (db.prepare('SELECT 1 FROM service_materials WHERE material_id = ?').get(id)) return json(res, 400, { error: '该项目正被服务作为耗材使用，请先修改服务配置' });
  db.prepare('DELETE FROM service_materials WHERE service_id = ?').run(id);
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  json(res, 200, { ok: true });
}, { desktopOnly: true });

/* --- 会员 --- */
route('GET', '/api/members', async (req, res) => json(res, 200, db.prepare('SELECT * FROM members ORDER BY id').all()), { desktopOnly: true });
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
route('GET', '/api/levels', async (req, res) => json(res, 200, db.prepare('SELECT * FROM levels ORDER BY id').all()), { desktopOnly: true });
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
route('GET', '/api/expenses', async (req, res) => json(res, 200, db.prepare('SELECT * FROM expenses ORDER BY time DESC').all()), { desktopOnly: true });
route('POST', '/api/expenses', async (req, res) => {
  const b = await readBody(req);
  const signedIn = requireMobileEmployee(req, res);
  if (isMobile(req) && !signedIn) return;
  const cat = String(b.category || '').trim();
  const amount = num(b.amount, 0);
  if (!cat) return json(res, 400, { error: '类别不能为空' });
  if (amount <= 0) return json(res, 400, { error: '金额需大于 0' });
  const time = typeof b.time === 'number' ? b.time : new Date(String(b.date || fmtD(Date.now())) + 'T00:00:00').getTime();
  const employee = signedIn || employeeForRecord(req, b);
  const r = db.prepare('INSERT INTO expenses (time, category, amount, note, employee_id, employee_name) VALUES (?, ?, ?, ?, ?, ?)')
    .run(time, cat, r2(amount), String(b.note || '').trim(), employee ? employee.id : null, employee ? employee.name : null);
  json(res, 200, { id: Number(r.lastInsertRowid) });
}, {});
route('PUT', '/api/expenses/:id', async (req, res, p) => {
  const b = await readBody(req);
  const cat = String(b.category || '').trim();
  const amount = num(b.amount, 0);
  if (!cat) return json(res, 400, { error: '类别不能为空' });
  if (amount <= 0) return json(res, 400, { error: '金额需大于 0' });
  const time = typeof b.time === 'number' ? b.time : new Date(String(b.date || fmtD(Date.now())) + 'T00:00:00').getTime();
  const old = db.prepare('SELECT employee_id, employee_name FROM expenses WHERE id=?').get(parseInt(p.id, 10));
  const employee = employeeForRecord(req, b);
  db.prepare('UPDATE expenses SET time=?, category=?, amount=?, note=?, employee_id=?, employee_name=? WHERE id=?')
    .run(time, cat, r2(amount), String(b.note || '').trim(), employee ? employee.id : (old && old.employee_id) || null,
      employee ? employee.name : (old && old.employee_name) || null, parseInt(p.id, 10));
  json(res, 200, { ok: true });
}, { desktopOnly: true });
route('DELETE', '/api/expenses/:id', async (req, res, p) => {
  db.prepare('DELETE FROM expenses WHERE id = ?').run(parseInt(p.id, 10));
  json(res, 200, { ok: true });
}, { desktopOnly: true });

/* --- 销售结算（事务：销售单 + 明细 + 扣库存 + 会员积分） --- */
route('POST', '/api/sales', async (req, res) => {
  const b = await readBody(req);
  const signedIn = requireMobileEmployee(req, res);
  if (isMobile(req) && !signedIn) return;
  if (!Array.isArray(b.items) || b.items.length === 0) return json(res, 400, { error: '购物车为空' });
  let s, member, payMethod, cashReceived, change, cashier, employee;
  try {
    const settings = getSettings();
    employee = signedIn || employeeForRecord(req, b);
    cashier = employee ? employee.name : String(b.cashier || settings.cashier || '').trim();
    member = b.memberId ? db.prepare('SELECT * FROM members WHERE id = ?').get(parseInt(b.memberId, 10)) : null;
    s = calcSale(b.items, member, b.manualDiscount, settings);
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
        member_id, member_name, member_level, cashier, employee_id, employee_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(no, time, s.subtotal, s.manualRate, s.manualDiscountAmt, s.vipRate, s.vipDiscount,
        s.pointsUsed, s.pointsValue, s.pointsEarned, s.payable, payMethod, cashReceived, change,
        member ? member.id : null, member ? member.name : null,
        member ? (db.prepare('SELECT name FROM levels WHERE id = ?').get(member.level_id) || {}).name : null,
        cashier, employee ? employee.id : null, employee ? employee.name : null);
    const saleId = Number(r.lastInsertRowid);

    const insItem = db.prepare('INSERT INTO sale_items (sale_id, product_id, name, category, price, cost, qty) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const updStock = db.prepare('UPDATE products SET stock = ? WHERE id = ?');
    for (const row of s.rows){
      insItem.run(saleId, row.id, row.name, row.category, row.price, row.cost, row.qty);
    }
    const insMove = db.prepare('INSERT INTO stock_moves (time, product_id, type, qty, note) VALUES (?, ?, ?, ?, ?)');
    for (const use of s.stockUse.values()){
      if (use.product.stock < 0) continue;
      const left = Math.max(0, Math.round((use.product.stock - use.qty) * 1000) / 1000);
      updStock.run(left, use.product.id);
      if (use.serviceQty) insMove.run(time, use.product.id, 'out', Math.round(use.serviceQty * 1000) / 1000, '服务消耗 · ' + no);
    }
    if (member){
      db.prepare('UPDATE members SET points = ? WHERE id = ?')
        .run(member.points + s.pointsEarned, member.id);
    }
    db.exec('COMMIT');
    json(res, 200, {
      id: saleId, no, time,
      items: s.rows.map(r2 => ({ productId: r2.id, name: r2.name, category: r2.category, price: r2.price, cost: r2.cost, qty: r2.qty })),
      subtotal: s.subtotal, manualDiscountAmt: s.manualDiscountAmt, vipDiscount: s.vipDiscount,
      pointsUsed: s.pointsUsed, pointsValue: s.pointsValue, pointsEarned: s.pointsEarned,
      payable: s.payable, payMethod, cashReceived, change,
      memberName: member ? member.name : null, memberLevel: member ? (db.prepare('SELECT name FROM levels WHERE id = ?').get(member.level_id) || {}).name : null,
      cashier, employeeId: employee ? employee.id : null, employeeName: employee ? employee.name : null
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
}, { desktopOnly: true });

/* --- 出入库 --- */
route('POST', '/api/stock', async (req, res) => {
  const b = await readBody(req);
  const pid = parseInt(b.productId, 10);
  const type = b.type === 'out' ? 'out' : 'in';
  const qty = num(b.qty, 0);
  if (!pid || qty <= 0) return json(res, 400, { error: '请选择商品并填写正确的数量' });
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(pid);
  if (!p) return json(res, 400, { error: '商品不存在' });
  if (p.kind === 'service') return json(res, 400, { error: '服务项目没有库存' });
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
}, { desktopOnly: true });
route('GET', '/api/stock-moves', async (req, res, params, url) => {
  const limit = Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10));
  const moves = db.prepare('SELECT * FROM stock_moves ORDER BY id DESC LIMIT ?').all(limit);
  const names = {};
  for (const p of db.prepare('SELECT id, name FROM products').all()) names[p.id] = p.name;
  for (const m of moves) m.productName = names[m.product_id] || ('#' + m.product_id);
  json(res, 200, moves);
}, { desktopOnly: true });

/* --- 首页概览 --- */
route('GET', '/api/dashboard', async (req, res) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t0 = today.getTime(), t1 = today.getTime() + 86400000 - 1;
  const saleRows = db.prepare('SELECT * FROM sales WHERE time BETWEEN ? AND ?').all(t0, t1);
  const expRows = db.prepare('SELECT * FROM expenses WHERE time BETWEEN ? AND ?').all(t0, t1);
  const revenue = r2(saleRows.reduce((a, s) => a + s.payable, 0));
  const expense = r2(expRows.reduce((a, e) => a + e.amount, 0));
  const settings = getSettings();
  const lowStock = db.prepare("SELECT * FROM products WHERE kind != 'service' AND stock >= 0 AND stock <= ? ORDER BY stock ASC").all(settings.lowStock);
  const recent = [];
  for (const s of saleRows) recent.push({ time: s.time, kind: 'in', text: '销售 ' + s.no, amt: s.payable, note: '收银 ' + s.pay_method });
  for (const e of expRows) recent.push({ time: e.time, kind: 'out', text: '出账 · ' + e.category, amt: -e.amount, note: e.note || '' });
  recent.sort((a, b) => b.time - a.time);
  json(res, 200, { orders: saleRows.length, revenue, expense, net: r2(revenue - expense), lowStock: lowStock.slice(0, 12), recent: recent.slice(0, 8) });
}, { desktopOnly: true });

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
  const vipGive = r2(sales.reduce((a, s) => a + s.vipDiscount, 0));
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
}, { desktopOnly: true });

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
  const vipGive = r2(sales.reduce((a, s) => a + s.vipDiscount, 0));
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
}, { desktopOnly: true });

/* --- AI 助手 --- */
function aiMoney(n){ return '¥' + r2(Number(n) || 0).toFixed(2); }
function aiRate(current, previous){
  const c = Number(current) || 0, p = Number(previous) || 0;
  if (!p) return c ? null : 0;
  return r2((c - p) / Math.abs(p) * 100);
}
function aiCompareText(current, previous){
  const rate = aiRate(current, previous);
  if (rate === null) return '上期为 0，本期新增收入';
  if (Math.abs(rate) < 0.01) return '与上期持平';
  return `较上期${rate > 0 ? '增长' : '下降'} ${Math.abs(rate).toFixed(1)}%`;
}
function aiMetric(label, value, sub, tone){
  return { label, value: String(value), sub: String(sub || ''), tone: tone || '' };
}
function aiPeriodMetrics(range){
  const sale = db.prepare(`SELECT COUNT(*) orders,
    COALESCE(SUM(payable),0) revenue, COALESCE(AVG(payable),0) avg_order,
    COALESCE(SUM(subtotal - payable),0) discount
    FROM sales WHERE time BETWEEN ? AND ?`).get(range.from, range.to);
  const cost = db.prepare(`SELECT COALESCE(SUM(si.cost * si.qty),0) value
    FROM sale_items si JOIN sales s ON s.id = si.sale_id
    WHERE s.time BETWEEN ? AND ?`).get(range.from, range.to).value || 0;
  const expense = db.prepare('SELECT COALESCE(SUM(amount),0) value FROM expenses WHERE time BETWEEN ? AND ?')
    .get(range.from, range.to).value || 0;
  const revenue = r2(sale.revenue || 0);
  const goodsCost = r2(cost);
  const gross = r2(revenue - goodsCost);
  const expenses = r2(expense);
  return {
    orders: Number(sale.orders) || 0,
    revenue,
    avgOrder: r2(sale.avg_order || 0),
    discount: r2(sale.discount || 0),
    goodsCost,
    gross,
    expense: expenses,
    net: r2(gross - expenses),
    margin: revenue ? r2(gross / revenue * 100) : 0
  };
}
function aiDailyRevenue(range, maxDays){
  const rows = [];
  const cap = Math.max(1, Math.min(maxDays || 31, 40));
  let start = range.from;
  const totalDays = Math.floor((range.to - range.from) / 86400000) + 1;
  if (totalDays > cap) start = dayStart(range.to - (cap - 1) * 86400000);
  for (let ts = start; ts <= range.to && rows.length < cap; ts += 86400000){
    const value = db.prepare('SELECT COALESCE(SUM(payable),0) value FROM sales WHERE time BETWEEN ? AND ?')
      .get(dayStart(ts), dayEnd(ts)).value || 0;
    rows.push({ label: fmtD(ts).slice(5), value: r2(value) });
  }
  return rows;
}
function aiTrendRange(range){
  if (range.fromText !== range.toText) return range;
  return resolveDateRange('近7天', Date.now(), '7days');
}
function aiBaseResponse(intent, range, reply, extra){
  return Object.assign({
    reply,
    intent,
    local: true,
    range: { label: range.label, from: range.fromText, to: range.toText, text: rangeText(range) },
    chart: null,
    rows: null,
    metrics: [],
    suggestions: []
  }, extra || {});
}

/*
 * 常见收银经营问题由本地统计引擎直接回答：可复核、无幻觉、无需 API 密钥。
 * 返回 null 时才交给通用大模型执行只读查询。
 */
function buildLocalBusinessAnalysis(message, settings){
  const intent = detectBusinessIntent(message);
  if (!intent) return null;
  const defaultRange = intent === 'brief' ? 'today' : intent === 'risk' ? '7days' : intent === 'inventory' ? '30days' : 'month';
  const range = resolveDateRange(message, Date.now(), defaultRange);
  const metrics = aiPeriodMetrics(range);
  const previous = aiPeriodMetrics({ from: range.previousFrom, to: range.previousTo });

  if (intent === 'brief' || intent === 'overview'){
    const trendRange = aiTrendRange(range);
    const daily = aiDailyRevenue(trendRange, 31);
    const lowCount = db.prepare("SELECT COUNT(*) value FROM products WHERE kind != 'service' AND stock >= 0 AND stock <= ?").get(settings.lowStock).value || 0;
    const newMembers = db.prepare('SELECT COUNT(*) value FROM members WHERE created_at BETWEEN ? AND ?').get(range.from, range.to).value || 0;
    const comparison = aiCompareText(metrics.revenue, previous.revenue);
    const notes = [];
    if (!metrics.orders) notes.push('本期还没有销售记录。');
    else notes.push(`本期共 ${metrics.orders} 单，客单价 ${aiMoney(metrics.avgOrder)}，营业额${comparison}。`);
    if (metrics.net < 0) notes.push(`扣除商品成本和出账后估算亏损 ${aiMoney(Math.abs(metrics.net))}，建议检查折扣与费用。`);
    else notes.push(`扣除商品成本和出账后估算净收益 ${aiMoney(metrics.net)}。`);
    if (lowCount) notes.push(`目前有 ${lowCount} 种商品达到库存预警线。`);
    return aiBaseResponse(intent, range, `【${range.label}经营概况】\n${notes.join('\n')}`, {
      metrics: [
        aiMetric('营业额', aiMoney(metrics.revenue), comparison, metrics.revenue >= previous.revenue ? 'ok' : 'warn'),
        aiMetric('订单数', metrics.orders + ' 单', `上期 ${previous.orders} 单`),
        aiMetric('客单价', aiMoney(metrics.avgOrder), '每笔平均实收'),
        aiMetric('估算净收益', aiMoney(metrics.net), `毛利率 ${metrics.margin.toFixed(1)}%`, metrics.net < 0 ? 'danger' : 'ok'),
        aiMetric('新增会员', newMembers + ' 人', '本期注册'),
        aiMetric('库存预警', lowCount + ' 种', `阈值 ≤ ${settings.lowStock}`, lowCount ? 'warn' : 'ok')
      ],
      chart: { type: 'line', title: `${trendRange.label}营业额趋势`, x: daily.map(x => x.label), y: daily.map(x => x.value) },
      suggestions: ['分析本月利润', '查看库存预警', '员工业绩排行', '经营风险诊断']
    });
  }

  if (intent === 'profit'){
    const trend = aiDailyRevenue(aiTrendRange(range), 31);
    const reply = `【${range.label}利润分析】\n营业额 ${aiMoney(metrics.revenue)}，商品成本 ${aiMoney(metrics.goodsCost)}，估算毛利 ${aiMoney(metrics.gross)}；另有出账 ${aiMoney(metrics.expense)}，估算净收益 ${aiMoney(metrics.net)}。\n毛利率约 ${metrics.margin.toFixed(1)}%，营业额${aiCompareText(metrics.revenue, previous.revenue)}。\n说明：利润按商品成本和实收金额估算，未计入尚未登记的房租、工资、损耗等费用。`;
    return aiBaseResponse(intent, range, reply, {
      metrics: [
        aiMetric('营业额', aiMoney(metrics.revenue), aiCompareText(metrics.revenue, previous.revenue)),
        aiMetric('商品成本', aiMoney(metrics.goodsCost), '已售商品成本'),
        aiMetric('估算毛利', aiMoney(metrics.gross), `毛利率 ${metrics.margin.toFixed(1)}%`, metrics.gross < 0 ? 'danger' : 'ok'),
        aiMetric('其他出账', aiMoney(metrics.expense), '已登记费用'),
        aiMetric('估算净收益', aiMoney(metrics.net), '毛利减其他出账', metrics.net < 0 ? 'danger' : 'ok'),
        aiMetric('优惠金额', aiMoney(metrics.discount), '标价小计与实收差额')
      ],
      chart: { type: 'line', title: `${range.label}每日营业额`, x: trend.map(x => x.label), y: trend.map(x => x.value) },
      suggestions: ['查看本月支出明细', '哪些商品毛利最高', '经营风险诊断']
    });
  }

  if (intent === 'inventory'){
    const days = Math.max(1, Math.floor((range.to - range.from) / 86400000) + 1);
    const raw = db.prepare(`SELECT p.id, p.name, p.category, p.stock, p.unit, p.cost,
      COALESCE(SUM(CASE WHEN s.time BETWEEN ? AND ? THEN si.qty ELSE 0 END),0) sold
      FROM products p
      LEFT JOIN sale_items si ON si.product_id = p.id
      LEFT JOIN sales s ON s.id = si.sale_id
      WHERE p.kind != 'service' AND p.stock >= 0
      GROUP BY p.id ORDER BY p.stock ASC, p.name`).all(range.from, range.to);
    const rows = raw.map(p => {
      const avg = Number(p.sold) / days;
      const cover = avg > 0 ? Math.floor(Number(p.stock) / avg) : null;
      const suggested = Math.max(0, Math.ceil(Math.max(settings.lowStock * 2, avg * 14) - Number(p.stock)));
      return {
        商品: p.name,
        分类: p.category,
        当前库存: `${r2(p.stock)}${p.unit || ''}`,
        本期销量: r2(p.sold),
        可售天数: cover == null ? '暂无销量' : cover + '天',
        建议补货: suggested ? `${suggested}${p.unit || ''}` : '-'
      };
    });
    const needs = rows.filter((row, i) => Number(raw[i].stock) <= settings.lowStock || (Number(raw[i].sold) > 0 && Number(raw[i].stock) / (Number(raw[i].sold) / days) <= 7));
    const out = raw.filter(p => Number(p.stock) <= 0).length;
    const slow = raw.filter(p => Number(p.stock) > settings.lowStock && Number(p.sold) === 0).length;
    const shown = /滞销|积压|周转/.test(message)
      ? rows.filter((row, i) => Number(raw[i].stock) > 0 && Number(raw[i].sold) === 0).slice(0, 20)
      : needs.slice(0, 20);
    const reply = `【库存分析｜销量范围：${range.label}】\n发现 ${out} 种商品已售罄，${needs.length} 种需要关注补货，${slow} 种有库存但本期没有销量。\n补货量按“至少达到预警线的 2 倍或覆盖约 14 天销量”估算，请结合供货周期确认。`;
    return aiBaseResponse(intent, range, reply, {
      metrics: [
        aiMetric('商品总数', raw.length + ' 种', '当前在库商品'),
        aiMetric('已售罄', out + ' 种', '库存 ≤ 0', out ? 'danger' : 'ok'),
        aiMetric('建议补货', needs.length + ' 种', '低库存或不足 7 天', needs.length ? 'warn' : 'ok'),
        aiMetric('疑似滞销', slow + ' 种', `${range.label}无销量`, slow ? 'warn' : '')
      ],
      rows: shown,
      table: true,
      suggestions: ['查看热销商品', '查看滞销商品', '经营风险诊断']
    });
  }

  if (intent === 'employee'){
    const rows = db.prepare(`SELECT
      COALESCE(NULLIF(employee_name,''), NULLIF(cashier,''), '未记录员工') AS employee,
      COUNT(*) orders, ROUND(SUM(payable),2) revenue, ROUND(AVG(payable),2) avg_order,
      ROUND(SUM(payable - COALESCE((SELECT SUM(cost * qty) FROM sale_items WHERE sale_id = sales.id),0)),2) gross
      FROM sales WHERE time BETWEEN ? AND ?
      GROUP BY COALESCE(NULLIF(employee_name,''), NULLIF(cashier,''), '未记录员工')
      ORDER BY revenue DESC LIMIT 20`).all(range.from, range.to);
    const tableRows = rows.map(r => ({ 员工: r.employee, 订单数: r.orders, 营业额: r2(r.revenue), 客单价: r2(r.avg_order), 估算毛利: r2(r.gross) }));
    const leader = rows[0];
    const reply = leader
      ? `【${range.label}员工业绩】\n${leader.employee} 营业额最高，为 ${aiMoney(leader.revenue)}，共 ${leader.orders} 单。业绩仅用于经营参考，排班时长不同不宜直接作为绩效结论。`
      : `【${range.label}员工业绩】\n本期暂无员工销售记录。`;
    return aiBaseResponse(intent, range, reply, {
      metrics: [
        aiMetric('参与收银', rows.length + ' 人', range.label),
        aiMetric('总订单', metrics.orders + ' 单', '全部员工'),
        aiMetric('总营业额', aiMoney(metrics.revenue), range.label),
        aiMetric('最高营业额', leader ? aiMoney(leader.revenue) : aiMoney(0), leader ? leader.employee : '暂无')
      ],
      rows: tableRows,
      table: true,
      chart: rows.length ? { type: 'bar', title: `${range.label}员工业绩排行`, x: rows.map(r => r.employee), y: rows.map(r => r2(r.revenue)) } : null,
      suggestions: ['查看本月销售趋势', '查看本月支出明细', '查看商品排行']
    });
  }

  if (intent === 'product'){
    const byCategory = /品类|分类/.test(message);
    const groupExpr = byCategory ? "COALESCE(NULLIF(si.category,''),'未分类')" : 'si.name';
    const label = byCategory ? '品类' : '商品';
    const rows = db.prepare(`SELECT ${groupExpr} label, ROUND(SUM(si.qty),2) qty,
      ROUND(SUM(si.price * si.qty),2) amount,
      ROUND(SUM((si.price - si.cost) * si.qty),2) gross
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.time BETWEEN ? AND ? GROUP BY ${groupExpr}
      ORDER BY amount DESC LIMIT 15`).all(range.from, range.to);
    const tableRows = rows.map(r => ({ [label]: r.label, 销量: r2(r.qty), 标价销售额: r2(r.amount), 标价毛利: r2(r.gross) }));
    const top = rows[0];
    return aiBaseResponse(intent, range, top
      ? `【${range.label}${label}排行】\n${top.label} 排名第一，销量 ${r2(top.qty)}，标价销售额 ${aiMoney(top.amount)}。商品排行按销售明细标价统计，整单折扣未按商品分摊。`
      : `【${range.label}${label}排行】\n本期暂无商品销售记录。`, {
      metrics: [
        aiMetric('有销量' + label, rows.length + ' 个', range.label),
        aiMetric('销量冠军', top ? top.label : '暂无', top ? `${r2(top.qty)} 件` : ''),
        aiMetric('冠军销售额', top ? aiMoney(top.amount) : aiMoney(0), '按明细标价'),
        aiMetric('总营业额', aiMoney(metrics.revenue), '按订单实收')
      ],
      rows: tableRows,
      table: true,
      chart: rows.length ? { type: 'bar', title: `${range.label}${label}销售额排行`, x: rows.slice(0, 10).map(r => r.label), y: rows.slice(0, 10).map(r => r2(r.amount)) } : null,
      suggestions: ['查看库存预警', '哪些商品毛利最高', '分析本月利润']
    });
  }

  if (intent === 'member'){
    const rows = db.prepare(`SELECT COALESCE(NULLIF(member_name,''),'未命名会员') member,
      COUNT(*) orders, ROUND(SUM(payable),2) amount, MAX(time) last_time
      FROM sales WHERE time BETWEEN ? AND ? AND member_id IS NOT NULL
      GROUP BY member_id, member_name ORDER BY amount DESC LIMIT 20`).all(range.from, range.to);
    const memberSummary = db.prepare(`SELECT COUNT(*) orders, COALESCE(SUM(payable),0) amount
      FROM sales WHERE time BETWEEN ? AND ? AND member_id IS NOT NULL`).get(range.from, range.to);
    const repeat = rows.filter(r => Number(r.orders) >= 2).length;
    const share = metrics.revenue ? r2(Number(memberSummary.amount) / metrics.revenue * 100) : 0;
    const newMembers = db.prepare('SELECT COUNT(*) value FROM members WHERE created_at BETWEEN ? AND ?').get(range.from, range.to).value || 0;
    const tableRows = rows.map(r => ({ 会员: r.member, 消费次数: r.orders, 消费金额: r2(r.amount), 最近消费: fmtDT(r.last_time) }));
    const top = rows[0];
    return aiBaseResponse(intent, range, `【${range.label}会员分析】\n会员消费 ${aiMoney(memberSummary.amount)}，占营业额 ${share.toFixed(1)}%；有 ${repeat} 位会员消费至少 2 次，新增会员 ${newMembers} 人。${top ? `消费最高的是 ${top.member}（${aiMoney(top.amount)}）。` : '本期暂无会员消费记录。'}`, {
      metrics: [
        aiMetric('会员消费额', aiMoney(memberSummary.amount), `占营业额 ${share.toFixed(1)}%`),
        aiMetric('会员订单', Number(memberSummary.orders) + ' 单', range.label),
        aiMetric('复购会员', repeat + ' 人', '本期消费 ≥ 2 次'),
        aiMetric('新增会员', newMembers + ' 人', range.label)
      ],
      rows: tableRows,
      table: true,
      chart: rows.length ? { type: 'bar', title: `${range.label}会员消费排行`, x: rows.slice(0, 10).map(r => r.member), y: rows.slice(0, 10).map(r => r2(r.amount)) } : null,
      suggestions: ['查看会员消费明细', '查看热销商品', '分析本月营业额']
    });
  }

  if (intent === 'payment'){
    const rows = db.prepare(`SELECT pay_method method, COUNT(*) orders, ROUND(SUM(payable),2) amount
      FROM sales WHERE time BETWEEN ? AND ? GROUP BY pay_method ORDER BY amount DESC`).all(range.from, range.to);
    const tableRows = rows.map(r => ({ 支付方式: r.method, 订单数: r.orders, 收款金额: r2(r.amount), 金额占比: metrics.revenue ? r2(r.amount / metrics.revenue * 100) + '%' : '0%' }));
    return aiBaseResponse(intent, range, `【${range.label}支付方式】\n共统计 ${metrics.orders} 笔订单、${aiMoney(metrics.revenue)} 收款。${rows[0] ? `${rows[0].method}使用最多，收款 ${aiMoney(rows[0].amount)}。` : '本期暂无收款记录。'}`, {
      metrics: rows.slice(0, 4).map(r => aiMetric(r.method, aiMoney(r.amount), `${r.orders} 单`)),
      rows: tableRows,
      table: true,
      chart: rows.length ? { type: 'pie', title: `${range.label}支付方式占比`, x: rows.map(r => r.method), y: rows.map(r => r2(r.amount)) } : null,
      suggestions: ['查看本月营业额', '查看交易明细', '分析本月利润']
    });
  }

  if (intent === 'risk'){
    const lowRows = db.prepare("SELECT name, stock, unit FROM products WHERE kind != 'service' AND stock >= 0 AND stock <= ? ORDER BY stock ASC LIMIT 10").all(settings.lowStock);
    const out = lowRows.filter(p => Number(p.stock) <= 0);
    const revenueRate = aiRate(metrics.revenue, previous.revenue);
    const risks = [];
    if (!metrics.orders) risks.push({ level: '高', item: '本期无销售记录', advice: '确认是否尚未营业或存在漏记账。' });
    if (revenueRate !== null && revenueRate <= -20) risks.push({ level: '高', item: `营业额较上期下降 ${Math.abs(revenueRate).toFixed(1)}%`, advice: '检查客流、缺货和促销变化。' });
    if (metrics.net < 0) risks.push({ level: '高', item: `估算净收益为 ${aiMoney(metrics.net)}`, advice: '复核商品成本、折扣和大额出账。' });
    if (out.length) risks.push({ level: '高', item: `${out.length} 种商品已售罄`, advice: '优先补充仍有销量的售罄商品。' });
    if (lowRows.length > out.length) risks.push({ level: '中', item: `${lowRows.length - out.length} 种商品库存偏低`, advice: '结合近 30 天销量安排补货。' });
    if (metrics.revenue && metrics.discount / metrics.revenue >= 0.15) risks.push({ level: '中', item: `优惠金额达到营业额的 ${r2(metrics.discount / metrics.revenue * 100)}%`, advice: '检查折扣是否符合预期。' });
    if (!risks.length) risks.push({ level: '低', item: '暂未发现明显经营风险', advice: '继续关注库存周转与每日营业趋势。' });
    const rows = risks.map(r => ({ 风险级别: r.level, 发现: r.item, 建议: r.advice }));
    const trend = aiDailyRevenue(aiTrendRange(range), 31);
    return aiBaseResponse(intent, range, `【${range.label}经营风险诊断】\n共发现 ${risks.filter(r => r.level !== '低').length} 项需要关注的问题。诊断基于当前已登记的销售、成本、出账和库存数据，不替代人工盘点。`, {
      metrics: [
        aiMetric('营业额', aiMoney(metrics.revenue), aiCompareText(metrics.revenue, previous.revenue), revenueRate !== null && revenueRate < -20 ? 'danger' : ''),
        aiMetric('估算净收益', aiMoney(metrics.net), `毛利率 ${metrics.margin.toFixed(1)}%`, metrics.net < 0 ? 'danger' : 'ok'),
        aiMetric('库存预警', lowRows.length + ' 种', `其中售罄 ${out.length} 种`, lowRows.length ? 'warn' : 'ok'),
        aiMetric('待关注', risks.filter(r => r.level !== '低').length + ' 项', '自动诊断结果', risks.some(r => r.level === '高') ? 'danger' : '')
      ],
      rows,
      table: true,
      chart: { type: 'line', title: `${range.label}营业额趋势`, x: trend.map(x => x.label), y: trend.map(x => x.value) },
      suggestions: ['查看库存补货建议', '分析本月利润', '查看员工业绩']
    });
  }

  return null;
}

function buildLocalDetailAnalysis(message){
  if (/库存|缺货|补货|滞销|周转|积压/.test(message)) return null;
  if (detectChartIntent(message) !== 'text' && !/流水/.test(message)) return null;
  const range = resolveDateRange(message, Date.now(), '30days');
  const employees = db.prepare('SELECT name FROM employees ORDER BY id').all();
  const members = db.prepare('SELECT name FROM members ORDER BY id').all();
  const employee = employees.find(x => x.name && String(message).includes(x.name));
  const member = members.find(x => x.name && String(message).includes(x.name));
  if (/支出|费用|出账/.test(message)){
    let expenseSql = 'SELECT * FROM expenses WHERE time BETWEEN ? AND ?';
    const expenseParams = [range.from, range.to];
    if (employee){ expenseSql += " AND employee_name = ?"; expenseParams.push(employee.name); }
    expenseSql += ' ORDER BY time DESC LIMIT 50';
    const expenses = db.prepare(expenseSql).all(...expenseParams);
    const rows = expenses.map(e => ({
      时间: fmtDT(e.time),
      类别: e.category,
      金额: r2(e.amount),
      经手员工: e.employee_name || '-',
      备注: e.note || '-'
    }));
    const total = r2(expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0));
    return aiBaseResponse('expense-detail', range, `【${range.label}支出明细】\n${employee ? `员工 ${employee.name} 经手的` : ''}支出共 ${rows.length} 笔，合计 ${aiMoney(total)}${rows.length >= 50 ? '，当前显示最近 50 笔' : ''}。`, {
      rows,
      table: true,
      detail: true,
      metrics: [aiMetric('支出合计', aiMoney(total), `${rows.length} 笔`, total ? 'warn' : '')],
      suggestions: ['分析本月利润', '查看本月营业额', '经营风险诊断']
    });
  }
  let sql = 'SELECT * FROM sales WHERE time BETWEEN ? AND ?';
  const params = [range.from, range.to];
  if (employee){ sql += " AND COALESCE(NULLIF(employee_name,''), cashier) = ?"; params.push(employee.name); }
  if (member){ sql += ' AND member_name = ?'; params.push(member.name); }
  sql += ' ORDER BY time DESC LIMIT 50';
  const sales = db.prepare(sql).all(...params);
  const itemStmt = db.prepare('SELECT name, qty FROM sale_items WHERE sale_id = ? ORDER BY id');
  const rows = sales.map(s => ({
    时间: fmtDT(s.time),
    单号: s.no,
    处理人: s.employee_name || s.cashier || '-',
    会员: s.member_name || '-',
    商品: itemStmt.all(s.id).map(it => `${it.name}×${it.qty}`).join('、'),
    实收金额: r2(s.payable),
    支付方式: s.pay_method
  }));
  const who = [employee && `员工 ${employee.name}`, member && `会员 ${member.name}`].filter(Boolean).join('、');
  return aiBaseResponse('detail', range, `【${range.label}交易明细】\n${who ? who + '，' : ''}共找到 ${rows.length} 笔记录${rows.length >= 50 ? '，当前显示最近 50 笔' : ''}。`, {
    rows,
    table: true,
    detail: true,
    suggestions: ['分析本月营业额', '查看支付方式占比', '查看商品排行']
  });
}

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

  // 高频收银问题优先使用本地业务分析：无需密钥，计算口径固定且结果可复核。
  const localAnswer = buildLocalDetailAnalysis(msg) || buildLocalBusinessAnalysis(msg, settings);
  if (localAnswer) return json(res, 200, localAnswer);

  // 演示模式仍可使用上面的本地经营分析；超出范围时给出明确引导。
  if (settings.aiProvider === 'demo'){
    return json(res, 200, {
      reply: '这项问题需要启用大模型才能理解。当前无需密钥的本地经营分析已经可用，可查询：经营简报、营业额、利润、库存补货、商品排行、员工业绩、会员、支付方式、交易明细和经营风险。\n\n如需自由问答，请到「系统设置 → AI 助手配置」选择服务商并填写接口信息。',
      demo: true,
      suggestions: ['今日经营简报', '分析本月利润', '查看库存预警', '经营风险诊断']
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
    const history = Array.isArray(b.history) ? b.history.slice(-6).map(item => ({
      role: item && item.role === 'assistant' ? 'assistant' : 'user',
      content: String(item && item.content || '').slice(0, 800)
    })).filter(item => item.content) : [];
    const first = await callLLM(settings, [
      { role: 'system', content: sys + sysExtra + '\n补充：结合最近对话理解“再看看、换成上月、按员工”等连续追问，但所有数字必须来自查询结果。' },
      ...history,
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
}, { desktopOnly: true });

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
  console.log('  手机端仅可新增销售/支出记账；流水与统计请在电脑端查看');
  console.log('==============================================');
});

process.on('SIGINT', () => { console.log('\n正在关闭...'); try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (e) {} process.exit(0); });
