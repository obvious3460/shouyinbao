'use strict';
/* 排查：7月数据是否存在 + 模型实际使用的 SQL */
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync('C:/test/shouyinbao-server/data/shouyinbao.db', { readOnly: true });
const rows = db.prepare("SELECT strftime('%Y-%m', time/1000, 'unixepoch', 'localtime') AS m, COUNT(*) c, ROUND(SUM(payable),2) rev FROM sales GROUP BY m ORDER BY m").all();
console.log('数据库月份分布:', JSON.stringify(rows));
db.close();

(async () => {
  const B = 'http://127.0.0.1:3000';
  const H = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0)' };
  const r = await fetch(B + '/api/chat', { method: 'POST', headers: H, body: JSON.stringify({ message: '7月每天的营业额' }) }).then(r => r.json());
  console.log('模型SQL:', r.sql || '(未查库)');
  console.log('回答:', (r.reply || r.error || '').slice(0, 100));
  if (r.error) console.log('错误:', r.error);
})().catch(e => console.error('失败:', e.message));
