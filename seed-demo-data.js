'use strict';
/* ============================================================
 * 模拟数据生成器：生成 7 月 + 8 月（至今日）完整消费记录
 * 用法：node seed-demo-data.js   （先停止服务再运行更稳妥）
 * 生成内容：销售单+明细（约450笔）、出账、出入库、会员积分累计
 * 运行前自动备份当前数据库到 backup/ 目录
 * ============================================================ */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DB_FILE = path.join(__dirname, 'data', 'shouyinbao.db');
const BACKUP_DIR = path.join(__dirname, 'backup');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

/* ---------- 工具 ---------- */
function r2(n){ return Math.round((n + Number.EPSILON) * 100) / 100; }
function rand(min, max){ return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr){ return arr[Math.floor(Math.random() * arr.length)]; }
function weightedPick(pairs){ // pairs: [[value, weight], ...]
  const total = pairs.reduce((a, p) => a + p[1], 0);
  let r = Math.random() * total;
  for (const [v, w] of pairs){ r -= w; if (r <= 0) return v; }
  return pairs[0][0];
}
function fmt(d){ const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}`; }

/* ---------- 连接与备份 ---------- */
console.log('备份当前数据库...');
const dbBak = new DatabaseSync(DB_FILE);
try { dbBak.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (e) {}   // 先合并 WAL，保证备份完整
dbBak.close();
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, '模拟数据前备份_' + stamp + '.db'));
console.log('备份完成：backup/模拟数据前备份_' + stamp + '.db');

const db = new DatabaseSync(DB_FILE);

/* ---------- 清理交易数据（保留商品/会员/等级/设置） ---------- */
db.exec('DELETE FROM sale_items; DELETE FROM sales; DELETE FROM stock_moves; DELETE FROM expenses;');
db.prepare("INSERT INTO settings (key, value) VALUES ('seq', '1000') ON CONFLICT(key) DO UPDATE SET value='1000'").run();

const products = db.prepare('SELECT * FROM products ORDER BY id').all();
const levels = db.prepare('SELECT * FROM levels').all();
let members = db.prepare('SELECT * FROM members').all();
const settingsRow = db.prepare("SELECT value FROM settings WHERE key='pointsToYuan'").get();
const pointsToYuan = settingsRow ? parseInt(settingsRow.value, 10) || 100 : 100;

/* ---------- 补充会员并重置积分 ---------- */
const NEW_MEMBERS = [
  ['陈六', '13900000006', 2, '2026-07-05'],
  ['刘七', '13900000007', 1, '2026-07-20'],
  ['赵八', '13900000008', 3, '2026-08-03'],
  ['孙九', '13900000009', 4, '2026-08-10']
];
for (const [name, phone, levelId, date] of NEW_MEMBERS){
  const r = db.prepare('INSERT INTO members (name, phone, level_id, points, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, phone, levelId, rand(200, 3000), new Date(date + 'T10:00:00').getTime());
  members.push({ id: Number(r.lastInsertRowid), name, phone, level_id: levelId, points: 0, created_at: new Date(date + 'T10:00:00').getTime() });
}
members = members.map(m => ({ ...m, points: rand(300, 9000) }));
for (const m of members) db.prepare('UPDATE members SET points = ? WHERE id = ?').run(m.points, m.id);

/* ---------- 常量 ---------- */
const CASHIERS = ['张伟', '李娜', '王芳', '陈强'];
const PAYS = [['微信', 45], ['支付宝', 25], ['现金', 20], ['银行卡', 10]];
const HOURS = [10, 10, 11, 11, 12, 12, 13, 15, 16, 17, 17, 18, 18, 19, 19, 20, 8, 9]; // 高峰权重
const EXP_CATS = ['进货', '房租', '水电', '工资', '设备', '其他'];

function levelName(id){ const l = levels.find(x => x.id === id); return l ? l.name : null; }
function levelRate(id){ const l = levels.find(x => x.id === id); return l ? l.rate : 1; }

/* ---------- 生成一天的销售 ---------- */
let totalRevenue = 0, saleCount = 0;
const inMemMember = id => members.find(m => m.id === id);

function makeSale(d){
  const n = rand(1, 5);
  const chosen = [];
  for (let i = 0; i < n; i++) chosen.push(pick(products));

  let subtotal = 0;
  const items = [];
  for (const p of chosen){
    const qty = p.category === '生鲜' ? (Math.random() < 0.5 ? 1 : 2) : rand(1, 3);
    items.push({ p, qty });
    subtotal += p.price * qty;
  }
  subtotal = r2(subtotal);

  // 整单折扣（约15%的单打折）
  const manualRate = Math.random() < 0.85 ? 1 : pick([0.9, 0.92, 0.95, 0.98]);
  const afterManual = r2(subtotal * manualRate);
  const manualDiscountAmt = r2(subtotal - afterManual);

  // VIP 会员（约35%）
  let member = null, vipRate = 1, vipDiscount = 0, pointsUsed = 0, pointsValue = 0, pointsEarned = 0;
  if (Math.random() < 0.35){
    member = pick(members);
    vipRate = levelRate(member.level_id);
    vipDiscount = r2(afterManual - afterManual * vipRate);
  }
  const afterVip = r2(afterManual * vipRate);

  // 积分抵扣（会员约25%的概率用积分）
  if (member && member.points >= 100 && Math.random() < 0.25){
    const maxPts = Math.min(member.points, Math.floor(r2(afterVip * 0.5) * pointsToYuan));
    pointsUsed = maxPts > 0 ? rand(0, maxPts) : 0;
    pointsValue = r2(pointsUsed / pointsToYuan);
  }
  const payable = Math.max(0, r2(afterVip - pointsValue));
  pointsEarned = Math.floor(payable * 1); // 默认 1元=1分

  // 支付方式
  const payMethod = weightedPick(PAYS);
  let cashReceived = null, change = null;
  if (payMethod === '现金'){
    cashReceived = Math.ceil(payable / 5) * 5;
    change = r2(cashReceived - payable);
  }

  const cashier = pick(CASHIERS);
  const d2 = new Date(d); d2.setHours(pick(HOURS), rand(0, 59), rand(0, 59), 0);
  const no = 'S' + fmt(d2) + '-' + (1000 + saleCount);
  const time = d2.getTime();

  const r = db.prepare(`INSERT INTO sales (no, time, subtotal, manual_rate, manual_discount_amt, vip_rate, vip_discount,
      points_used, points_value, points_earned, payable, pay_method, cash_received, "change",
      member_id, member_name, member_level, cashier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(no, time, subtotal, manualRate, manualDiscountAmt, vipRate, vipDiscount,
      pointsUsed, pointsValue, pointsEarned, payable, payMethod, cashReceived, change,
      member ? member.id : null, member ? member.name : null, member ? levelName(member.level_id) : null, cashier);
  const saleId = Number(r.lastInsertRowid);

  const ins = db.prepare('INSERT INTO sale_items (sale_id, product_id, name, category, price, cost, qty) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const it of items) ins.run(saleId, it.p.id, it.p.name, it.p.category, it.p.price, it.p.cost, it.qty);

  // 库存扣减（售罄自动补货并记出入库）
  for (const it of items){
    const p = products.find(x => x.id === it.p.id);
    if (p.stock >= 0){
      const left = Math.max(0, r2(p.stock - it.qty));
      if (left === 0){
        const restock = rand(30, 120);
        db.prepare('INSERT INTO stock_moves (time, product_id, type, qty, note) VALUES (?, ?, ?, ?, ?)')
          .run(time, p.id, 'in', restock, '自动补货');
        db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(restock, p.id);
        p.stock = restock;
      } else {
        db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(left, p.id);
        p.stock = left;
      }
    }
  }
  // 会员积分
  if (member){
    member.points = Math.max(0, member.points - pointsUsed) + pointsEarned;
    db.prepare('UPDATE members SET points = ? WHERE id = ?').run(member.points, member.id);
  }
  totalRevenue += payable;
  saleCount++;
}

/* ---------- 生成 7 月 + 8 月（至今日） ---------- */
const today = new Date();
for (let month = 6; month <= 7; month++){           // 6=7月, 7=8月
  const lastDay = month === 7 ? today.getDate() : 31;
  for (let day = 1; day <= lastDay; day++){
    const d = new Date(2026, month, day);
    const dow = d.getDay();                          // 周末生意好
    const count = rand(5, 9) + (dow === 0 || dow === 6 ? rand(3, 5) : 0);
    for (let i = 0; i < count; i++) makeSale(d);
  }
}

/* ---------- 出账（7/8 月） ---------- */
const insExp = db.prepare('INSERT INTO expenses (time, category, amount, note) VALUES (?, ?, ?, ?)');
const expenses = [
  ['2026-07-01', '房租', 2000.00, '7月房租'],
  ['2026-07-03', '进货', 1560.00, '饮料零食补货'],
  ['2026-07-10', '工资', 4500.00, '7月上旬员工工资'],
  ['2026-07-14', '进货', 890.50, '日用品进货'],
  ['2026-07-20', '水电', 385.60, '7月水电费'],
  ['2026-07-25', '设备', 680.00, '更换收银小票机'],
  ['2026-07-28', '进货', 1230.00, '生鲜补货'],
  ['2026-08-01', '房租', 2000.00, '8月房租'],
  ['2026-08-05', '进货', 1420.00, '零食饮料补货'],
  ['2026-08-10', '工资', 4500.00, '8月上旬员工工资'],
  ['2026-08-12', '进货', 760.00, '日用品进货'],
  ['2026-08-15', '水电', 320.80, '8月水电费'],
  ['2026-08-16', '其他', 150.00, '店铺清洁用品']
];
for (const [date, cat, amount, note] of expenses) insExp.run(new Date(date + 'T09:00:00').getTime(), cat, amount, note);

/* ---------- 月初补货出入库 ---------- */
const insMove = db.prepare('INSERT INTO stock_moves (time, product_id, type, qty, note) VALUES (?, ?, ?, ?, ?)');
const restocks = [
  ['2026-07-02', 1, 50, '月初可乐补货'], ['2026-07-02', 4, 40, '月初薯片补货'], ['2026-07-15', 9, 30, '月中抽纸补货'],
  ['2026-08-02', 2, 60, '月初矿泉水补货'], ['2026-08-02', 6, 45, '月初泡面补货'], ['2026-08-11', 7, 20, '月中苹果补货']
];
for (const [date, pid, qty, note] of restocks){
  insMove.run(new Date(date + 'T08:30:00').getTime(), pid, 'in', qty, note);
  const p = products.find(x => x.id === pid);
  if (p) { p.stock = r2(p.stock + qty); db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(p.stock, p.id); }
}

/* ---------- 汇总输出 ---------- */
const stat = db.prepare(`
  SELECT strftime('%Y-%m', time/1000, 'unixepoch', 'localtime') AS month,
         COUNT(*) AS orders, ROUND(SUM(payable),2) AS revenue,
         ROUND(SUM(vip_discount + points_value),2) AS vipGive,
         ROUND(SUM(points_earned),0) AS points
  FROM sales GROUP BY month ORDER BY month`).all();
console.log('\n================ 模拟数据生成完成 ================');
console.log('销售单总数:', saleCount, '笔，总营业额: ¥' + r2(totalRevenue).toFixed(2));
for (const s of stat) console.log(`  ${s.month}：${s.orders} 单，营业额 ¥${s.revenue}，VIP让利 ¥${s.vipGive}，发放积分 ${s.points}`);
console.log('出账:', expenses.length, '笔；出入库记录:', db.prepare('SELECT COUNT(*) c FROM stock_moves').get().c, '条');
console.log('会员:', db.prepare('SELECT COUNT(*) c FROM members').get().c, '人（含新增4人）');
console.log('==================================================');
db.close();
