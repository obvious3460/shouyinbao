'use strict';
/* AI 助手接口冒烟测试 */
const BASE = 'http://127.0.0.1:3000';
let pass = 0, fail = 0;
function check(name, cond, extra){
  if (cond){ pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
async function req(path, opts){
  const init = { method: (opts && opts.method) || 'GET', headers: {} };
  if (opts && opts.ua) init.headers['User-Agent'] = opts.ua;
  if (opts && opts.body !== undefined){ init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const r = await fetch(BASE + path, init);
  let data = null;
  try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}

(async () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120';

  // 1. 默认是演示模式，chat 应直接返回演示结果（含 SQL 与行）
  const c1 = await req('/api/chat', { method: 'POST', ua, body: { message: '本月热销商品' } });
  check('演示模式 chat 200', c1.status === 200, 'status=' + c1.status);
  check('演示模式返回SQL', typeof c1.data.sql === 'string' && c1.data.sql.startsWith('SELECT'), c1.data.sql || '');
  check('演示模式标记', c1.data.demo === true);
  check('演示模式含回复', typeof c1.data.reply === 'string' && c1.data.reply.length > 0);

  // 2. 切到 deepseek 但无密钥 → 提示配置
  await req('/api/settings', { method: 'PUT', ua, body: { aiProvider: 'deepseek', aiBaseUrl: 'https://api.deepseek.com', aiKey: '', aiModel: 'deepseek-chat' } });
  const c2 = await req('/api/chat', { method: 'POST', ua, body: { message: '营业额多少' } });
  check('无密钥被拦截(400)', c2.status === 400, 'status=' + c2.status + ' ' + (c2.data && c2.data.error));

  // 3. 手机端不能使用 AI（403）
  const c3 = await req('/api/chat', { method: 'POST', ua: 'Mozilla/5.0 (iPhone) Mobile', body: { message: 'hi' } });
  check('手机端 AI 被拦截 403', c3.status === 403, 'status=' + c3.status);

  // 4. ai-test 无密钥 → 400
  const t = await req('/api/ai-test', { method: 'POST', ua });
  check('ai-test 无密钥 400', t.status === 400, 'status=' + t.status);

  // 5. 收银员字段：结算时记录 cashier，查询可读回
  const sale = await req('/api/sales', { method: 'POST', ua, body: {
    items: [{ productId: 2, qty: 1 }], memberId: null, pointsUse: 0, manualDiscount: 100,
    payMethod: '微信', cashier: '测试员小王'
  } });
  check('带收银员结算成功', sale.status === 200, 'status=' + sale.status);
  const list = await req('/api/sales');
  const s0 = list.data[0];
  check('收银员已写入销售单', s0.cashier === '测试员小王', 'cashier=' + s0.cashier);

  // 6. 切回演示模式，方便用户直接体验
  await req('/api/settings', { method: 'PUT', ua, body: { aiProvider: 'demo' } });
  const c4 = await req('/api/chat', { method: 'POST', ua, body: { message: '张三的消费记录' } });
  check('切回演示模式可用', c4.status === 200 && c4.data.demo === true, 'status=' + c4.status);

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('测试异常', e); process.exitCode = 1; });
