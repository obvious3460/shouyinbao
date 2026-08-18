'use strict';
/* 收银宝服务端 端到端自测（Node 24 自带 fetch） */
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
  // 1. 静态页面
  const page = await fetch(BASE + '/');
  const html = await page.text();
  check('静态页面 index.html 可访问', page.status === 200 && html.includes('收银宝'));

  // 2. bootstrap（桌面 UA）
  const boot = await req('/api/bootstrap', { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' });
  check('bootstrap 返回示例商品', boot.data.products && boot.data.products.length === 11, '商品数=' + (boot.data.products && boot.data.products.length));
  check('bootstrap 返回示例会员', boot.data.members && boot.data.members.length === 3, '会员数=' + (boot.data.members && boot.data.members.length));
  check('bootstrap 设备识别=desktop', boot.data.device === 'desktop');

  // 3. bootstrap（手机 UA）
  const bootM = await req('/api/bootstrap', { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Mobile' });
  check('手机 UA 识别=mobile', bootM.data.device === 'mobile');

  // 4. 结算：金卡会员(92折) + 整单9折 + 500积分(100分=1元)
  // 可乐3.00×10=30 + 薯片6.00×2=12 → 小计42
  // 整单9折后 37.8 → VIP折扣 37.8×0.08=3.024 → 34.776 → 积分5元 → 应收29.776
  const s1 = await req('/api/sales', {
    method: 'POST', ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120',
    body: {
      items: [{ productId: 1, qty: 10 }, { productId: 4, qty: 2 }],
      memberId: 1, pointsUse: 500, manualDiscount: 90, payMethod: '微信'
    }
  });
  const c = s1.data;
  check('结算成功', s1.status === 200);
  check('结算小计=42', Math.abs(c.subtotal - 42) < 0.001, 'subtotal=' + c.subtotal);
  check('整单折扣=4.2', Math.abs(c.manualDiscountAmt - 4.2) < 0.001, 'amt=' + c.manualDiscountAmt);
  check('VIP折扣=3.02', Math.abs(c.vipDiscount - 3.02) < 0.001, 'vip=' + c.vipDiscount);
  check('积分抵扣=5', Math.abs(c.pointsValue - 5) < 0.001, 'pv=' + c.pointsValue);
  check('应收=29.78', Math.abs(c.payable - 29.78) < 0.001, 'payable=' + c.payable);
  check('获得积分=29', c.pointsEarned === 29, 'earned=' + c.pointsEarned);
  check('小票含会员名', c.memberName === '张三' && c.memberLevel === '金卡会员');

  // 5. 库存扣减：可乐 120-10=110，薯片 80-2=78
  const p1 = (await req('/api/products')).data.find(p => p.id === 1);
  const p4 = (await req('/api/products')).data.find(p => p.id === 4);
  check('可乐库存=110', p1.stock === 110, 'stock=' + p1.stock);
  check('薯片库存=78', p4.stock === 78, 'stock=' + p4.stock);

  // 6. 会员积分：张三 1280-500+29=809
  const m1 = (await req('/api/members')).data.find(m => m.id === 1);
  check('会员积分=809', m1.points === 809, 'points=' + m1.points);

  // 7. 库存不足拦截
  const s2 = await req('/api/sales', {
    method: 'POST', ua: 'Mozilla/5.0 (Windows NT 10.0)',
    body: { items: [{ productId: 11, qty: 5 }], memberId: null, pointsUse: 0, manualDiscount: 100, payMethod: '微信' }
  });
  check('售罄商品被拦截(库存0)', s2.status === 400, 'status=' + s2.status);

  // 8. 现金不足拦截
  const s3 = await req('/api/sales', {
    method: 'POST', ua: 'Mozilla/5.0 (Windows NT 10.0)',
    body: { items: [{ productId: 2, qty: 1 }], memberId: null, pointsUse: 0, manualDiscount: 100, payMethod: '现金', cashReceived: 1 }
  });
  check('现金不足被拦截', s3.status === 400, 'status=' + s3.status);

  // 9. 出入库
  const st1 = await req('/api/stock', { method: 'POST', ua: 'Mozilla/5.0 (iPhone) Mobile', body: { productId: 11, type: 'in', qty: 50, note: '补货测试' } });
  check('入库成功(手机)', st1.status === 200 && st1.data.newStock === 50, 'stock=' + (st1.data && st1.data.newStock));
  const st2 = await req('/api/stock', { method: 'POST', ua: 'Mozilla/5.0 (iPhone) Mobile', body: { productId: 11, type: 'out', qty: 10, note: '损耗测试' } });
  check('出库成功(手机)', st2.status === 200 && st2.data.newStock === 40, 'stock=' + (st2.data && st2.data.newStock));
  const moves = await req('/api/stock-moves');
  check('出入库记录=2条', moves.data.length === 2, 'n=' + moves.data.length);

  // 10. 手机权限拦截：不能改商品价格 / 不能删等级
  const mb = await req('/api/products/1', { method: 'PUT', ua: 'Mozilla/5.0 (iPhone) Mobile', body: { name: '可乐', price: 99 } });
  check('手机改价被拦截 403', mb.status === 403, 'status=' + mb.status);
  const mb2 = await req('/api/settings', { method: 'PUT', ua: 'Mozilla/5.0 (Android) Mobile', body: { shopName: 'x' } });
  check('手机改设置被拦截 403', mb2.status === 403, 'status=' + mb2.status);
  const mb3 = await req('/api/sales', { method: 'POST', ua: 'Mozilla/5.0 (iPhone) Mobile', body: { items: [{ productId: 2, qty: 1 }], memberId: null, pointsUse: 0, manualDiscount: 100, payMethod: '微信' } });
  check('手机收银不被拦截', mb3.status === 200, 'status=' + mb3.status);

  // 11. 桌面端改价成功
  const pc = await req('/api/products/1', { method: 'PUT', ua: 'Mozilla/5.0 (Windows NT 10.0)', body: { name: '可口可乐', category: '饮料', price: 3.5, cost: 2.1, stock: 110, unit: '瓶' } });
  check('电脑改价成功', pc.status === 200, 'status=' + pc.status);
  const p1b = (await req('/api/products')).data.find(p => p.id === 1);
  check('改价后售价=3.5', p1b.price === 3.5, 'price=' + p1b.price);

  // 12. 出账：手机可新增，不可删除
  const ex = await req('/api/expenses', { method: 'POST', ua: 'Mozilla/5.0 (iPhone) Mobile', body: { date: '2025-01-01', category: '进货', amount: 100, note: '测试' } });
  check('手机新增出账成功', ex.status === 200, 'status=' + ex.status);
  const exDel = await req('/api/expenses/' + ex.data.id, { method: 'DELETE', ua: 'Mozilla/5.0 (iPhone) Mobile' });
  check('手机删除出账被拦截', exDel.status === 403, 'status=' + exDel.status);

  // 13. 统计与概览
  const today = new Date(); const p2 = n => String(n).padStart(2, '0');
  const ds = today.getFullYear() + '-' + p2(today.getMonth()+1) + '-' + p2(today.getDate());
  const st = await req('/api/stats?from=' + ds + '&to=' + ds);
  check('统计返回订单数≥2', st.data.orders >= 2, 'orders=' + st.data.orders);
  check('统计近7天柱状图=7', st.data.week.length === 7, 'week=' + st.data.week.length);
  const dash = await req('/api/dashboard');
  check('概览返回今日营业额>0', dash.data.revenue > 0, 'revenue=' + dash.data.revenue);

  // 14. 销售查询（明细）
  const sales = await req('/api/sales');
  check('销售列表含明细', sales.data.length >= 2 && sales.data[0].items && sales.data[0].items.length >= 1, 'n=' + sales.data.length);

  // 15. 备份下载
  const bk = await fetch(BASE + '/api/backup');
  const buf = await bk.arrayBuffer();
  check('备份下载成功(.db)', bk.status === 200 && buf.byteLength > 1000, 'bytes=' + buf.byteLength);

  // 16. 404 处理
  const nf = await req('/api/no-such');
  check('未知接口返回404', nf.status === 404, 'status=' + nf.status);

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常', e); process.exit(1); });
