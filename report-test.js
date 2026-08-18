'use strict';
/* 报表接口自测（容错断言，不依赖具体数据量） */
const BASE = 'http://127.0.0.1:3000';
let pass = 0, fail = 0;
function check(name, cond, extra){
  if (cond){ pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
async function get(path){
  const r = await fetch(BASE + path);
  return { status: r.status, data: await r.json() };
}

(async () => {
  const today = new Date(); const p2 = n => String(n).padStart(2, '0');
  const ds = `${today.getFullYear()}-${p2(today.getMonth()+1)}-${p2(today.getDate())}`;

  // 日报
  const d = await get('/api/report?type=daily&date=' + ds);
  check('日报 200', d.status === 200);
  check('日报类型', d.data.type === 'daily');
  check('日报范围=当天', d.data.range.from === ds && d.data.range.to === ds, d.data.range.label);
  check('日报每日明细=1天', d.data.daily.length === 1, 'n=' + d.data.daily.length);
  check('日报摘要字段齐全', ['orders','revenue','avgOrder','vipGive','pointsIssued','gross','expense','net','newMembers'].every(k => k in d.data.summary));
  check('日报汇总自洽', Math.abs(d.data.summary.net - (d.data.summary.gross - d.data.summary.expense)) < 0.01, 'net=' + d.data.summary.net);
  check('日报数组字段', Array.isArray(d.data.topProducts) && Array.isArray(d.data.payMethods) && Array.isArray(d.data.expenseCats) && Array.isArray(d.data.expenseList));
  check('日报含店铺名', typeof d.data.shopName === 'string' && d.data.shopName.length > 0);

  // 周报：日期所在周的周一起始
  const w = await get('/api/report?type=weekly&date=' + ds);
  check('周报 200', w.status === 200);
  check('周报每日=7天', w.data.daily.length === 7, 'n=' + w.data.daily.length);
  const fromDate = new Date(w.data.range.from + 'T00:00:00');
  const dow = (fromDate.getDay() + 6) % 7;
  check('周报从周一开始', dow === 0, 'from=' + w.data.range.from);
  // 周报每日求和 ≈ 汇总营业额
  const sumDaily = w.data.daily.reduce((a, x) => a + x.revenue, 0);
  check('周报每日营业额合计=汇总', Math.abs(sumDaily - w.data.summary.revenue) < 0.01, 'sum=' + sumDaily.toFixed(2) + ' rev=' + w.data.summary.revenue);

  // 月报
  const m = await get('/api/report?type=monthly&date=' + ds);
  check('月报 200', m.status === 200);
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  check('月报每日=当月天数(' + daysInMonth + ')', m.data.daily.length === daysInMonth, 'n=' + m.data.daily.length);
  check('月报范围=整月', m.data.range.from.endsWith('-01'));

  // 非法类型回退 daily
  const bad = await get('/api/report?type=xxx&date=' + ds);
  check('非法类型回退为日报', bad.status === 200 && bad.data.type === 'daily');

  // 热销商品按金额降序
  const tp = d.data.topProducts;
  let sorted = true;
  for (let i = 1; i < tp.length; i++) if (tp[i].amount > tp[i - 1].amount) sorted = false;
  check('热销商品按销售额降序', sorted, 'top=' + tp.length);

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exitCode = fail ? 1 : 0;   // 自然退出，避免 process.exit 与 fetch 连接收尾竞争
})().catch(e => { console.error('测试异常', e); process.exitCode = 1; });
