'use strict';
/* ============================================================
 * 收银宝前端（服务端版）—— API 客户端
 * 所有数据通过 /api/* 读写服务器 SQLite 数据库
 * 设备权限：手机端仅记录+出入库；电脑端完整管理（含价格编辑）
 * ============================================================ */

const $  = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const IS_MOBILE = /Mobi|Android|iPhone|iPad|iPod|Windows Phone/i.test(navigator.userAgent);

/* ---------- 工具 ---------- */
function pad(n){ return String(n).padStart(2, '0'); }
function round2(n){ return Math.round((n + Number.EPSILON) * 100) / 100; }
function money(n){ return '¥' + round2(n).toFixed(2); }
function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
function todayStr(){ const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function fmtDT(ts){ const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fmtD(ts){ const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function inRange(ts, from, to){
  const ds = fmtD(ts);
  if (from && ds < from) return false;
  if (to && ds > to) return false;
  return true;
}
function levelName(lid){ const l = (D.levels || []).find(x => x.id === lid); return l ? l.name : '未知'; }
function levelRate(lid){ const l = (D.levels || []).find(x => x.id === lid); return l ? l.rate : 1; }

/* ---------- API ---------- */
let D = null;          // bootstrap 数据缓存
let DEVICE = 'desktop';

async function api(path, opts){
  opts = opts || {};
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined){
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const r = await fetch('/api' + path, init);
  let data = null;
  try { data = await r.json(); } catch (e) { /* 非 JSON（如备份下载） */ }
  if (!r.ok){
    const msg = (data && data.error) || ('请求失败（' + r.status + '）');
    throw new Error(msg);
  }
  return data;
}
async function refresh(){ D = await api('/bootstrap'); DEVICE = D.device; applyDeviceMode(); }

function applyDeviceMode(){
  $('#deviceTag').textContent = DEVICE === 'mobile'
    ? '📱 手机模式：记录 / 出库入库'
    : '💻 电脑模式：完整管理';
  const admin = DEVICE === 'mobile';
  $$('.admin-only').forEach(el => el.style.display = admin ? 'none' : '');
  // 手机端隐藏管理类弹窗按钮
  if (admin){
    $$('.admin-only').forEach(el => el.style.display = 'none');
  }
}

/* ---------- 视图切换 ---------- */
const PAGE_TITLES = {
  home: '📊 今日概览', pos: '🛒 收银台', stock: '📦 出库入库', products: '📋 商品管理',
  members: '👤 会员管理', expenses: '💸 出账记账', ledger: '📒 流水账本', stats: '📈 统计分析', report: '📑 报表中心', settings: '⚙️ 系统设置'
};
const ADMIN_VIEWS = ['products', 'members', 'report', 'settings'];

async function switchView(name){
  if (DEVICE === 'mobile' && ADMIN_VIEWS.includes(name)){
    alert('手机端仅支持记录与出库入库，管理功能请在电脑端操作');
    return;
  }
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === name));
  $$('.view').forEach(el => el.style.display = 'none');
  const v = $('#view-' + name);
  if (v) v.style.display = 'block';
  $('#pageTitle').textContent = PAGE_TITLES[name] || '';
  const renders = {
    home: renderHome, pos: renderPos, stock: renderStock, products: renderProducts, members: renderMembers,
    expenses: renderExpenses, ledger: renderLedger, stats: renderStats, report: renderReport, settings: renderSettings
  };
  if (renders[name]) await renders[name]();
}
function openModal(id){ $(id).classList.add('show'); }
function closeModal(id){ $(id).classList.remove('show'); }

/* ============================================================
 * 首页概览
 * ============================================================ */
async function renderHome(){
  $('#todayLabel').textContent = todayStr() + '  ' + (D.settings.shopName || '收银宝');
  const d = await api('/dashboard');
  $('#homeOrders').textContent = d.orders;
  $('#homeRevenue').textContent = money(d.revenue);
  $('#homeExpense').textContent = money(d.expense);
  $('#homeNet').textContent = money(d.net);

  $('#homeWarn').innerHTML = d.lowStock.length
    ? d.lowStock.map(p => `<div class="warn-item"><span>${esc(p.name)}（${esc(p.category)}）</span><span class="st">库存 ${p.stock} ${esc(p.unit || '')}</span></div>`).join('')
    : '<div class="empty">✅ 库存充足，无预警</div>';

  $('#homeRecent').innerHTML = d.recent.length
    ? d.recent.map(r => `<div class="warn-item"><span>${fmtDT(r.time)}　${esc(r.text)}${r.note ? '　<small style="color:var(--muted)">' + esc(r.note) + '</small>' : ''}</span><span style="${r.kind === 'in' ? 'color:var(--ok)' : 'color:var(--danger)'}">${r.amt >= 0 ? '+' : ''}${money(Math.abs(r.amt))}</span></div>`).join('')
    : '<div class="empty">暂无流水记录</div>';
}

/* ============================================================
 * 收银台
 * ============================================================ */
let prodFilter = { kw: '', cat: '全部' };
let cart = [];
let cartMemberId = '';
let pointsUse = 0;
let manualDiscount = 100;
let payMethod = '微信';
let cashReceived = '';

function renderPos(){
  renderProductGrid();
  renderCart();
}

function renderProductGrid(){
  const cats = ['全部', ...new Set(D.products.map(p => p.category))];
  $('#catChips').innerHTML = cats.map(c =>
    `<div class="chip ${prodFilter.cat === c ? 'active' : ''}" onclick="prodFilter.cat=${JSON.stringify(c)};renderProductGrid()">${esc(c)}</div>`).join('');

  const kw = prodFilter.kw.trim().toLowerCase();
  const list = D.products.filter(p =>
    (prodFilter.cat === '全部' || p.category === prodFilter.cat) &&
    (!kw || p.name.toLowerCase().includes(kw)));

  $('#posGrid').innerHTML = list.length ? list.map(p => {
    const out = p.stock === 0;
    const low = p.stock > 0 && p.stock <= D.settings.lowStock;
    return `<div class="pcard ${out ? 'out' : ''} ${low ? 'low' : ''}" ${out ? '' : `onclick="addToCart('${p.id}')"`} title="点击加入购物车">
      <div class="pname">${esc(p.name)}</div>
      <div class="pprice">${money(p.price)}</div>
      <div class="pstock">${p.stock < 0 ? '不限库存' : '库存 ' + p.stock} ${esc(p.unit || '')}</div>
    </div>`;
  }).join('') : '<div class="empty" style="grid-column:1/-1">没有找到商品，请到电脑端「商品管理」添加</div>';
}

function addToCart(pid){
  const p = D.products.find(x => x.id === pid);
  if (!p) return;
  if (p.stock === 0){ alert(`「${p.name}」已售罄`); return; }
  const item = cart.find(c => c.productId === pid);
  if (item){
    if (p.stock >= 0 && item.qty + 1 > p.stock){ alert(`「${p.name}」库存不足（剩余 ${p.stock}）`); return; }
    item.qty++;
  } else {
    cart.push({ productId: p.id, name: p.name, category: p.category, price: p.price, cost: p.cost, qty: 1, unit: p.unit });
  }
  renderCart();
}
function cartQty(pid, d){
  const item = cart.find(c => c.productId === pid);
  if (!item) return;
  const p = D.products.find(x => x.id === pid);
  item.qty += d;
  if (item.qty <= 0){ cart = cart.filter(c => c.productId !== pid); }
  else if (p && p.stock >= 0 && item.qty > p.stock){ alert(`「${p.name}」库存不足`); item.qty = p.stock; }
  renderCart();
}
function removeFromCart(pid){ cart = cart.filter(c => c.productId !== pid); renderCart(); }
function clearCart(){ if (cart.length && !confirm('确定清空购物车？')) return; cart = []; renderCart(); }

function onMemberChange(){
  cartMemberId = $('#memberSelect').value;
  pointsUse = 0;
  cashReceived = '';
  renderCart();
}
function onPayChange(){
  payMethod = $('#payMethod').value;
  cashReceived = '';
  renderCart();
}

/* 折扣计算（与服务器一致，仅用于实时预览） */
function calcCart(){
  const subtotal = round2(cart.reduce((a, c) => a + c.price * c.qty, 0));
  const manualRate = Math.min(100, Math.max(1, parseFloat(manualDiscount) || 100)) / 100;
  const afterManual = round2(subtotal * manualRate);
  const manualDiscountAmt = round2(subtotal - afterManual);
  const member = cartMemberId ? D.members.find(m => m.id === cartMemberId) : null;
  const rate = member ? levelRate(member.levelId) : 1;
  const vipDiscount = round2(afterManual - afterManual * rate);
  const afterVip = round2(afterManual * rate);
  let pu = Math.max(0, Math.floor(parseFloat(pointsUse) || 0));
  if (member) pu = Math.min(pu, member.points);
  const maxPointsValue = round2(afterVip * 0.5);
  const maxPoints = Math.floor(maxPointsValue * D.settings.pointsToYuan);
  pu = Math.min(pu, maxPoints);
  const pointsValue = round2(pu / D.settings.pointsToYuan);
  const payable = Math.max(0, round2(afterVip - pointsValue));
  const pointsEarned = Math.floor(payable * D.settings.pointsPerYuan);
  return { subtotal, manualRate, manualDiscountAmt, vipRate: rate, vipDiscount, pointsUsed: pu, pointsValue, payable, pointsEarned };
}

function renderCart(){
  $('#memberSelect').innerHTML = '<option value="">非会员（不打折）</option>' +
    D.members.map(m => `<option value="${m.id}">${esc(m.name)}（${esc(levelName(m.levelId))} ${(levelRate(m.levelId) * 100).toFixed(0)}折）</option>`).join('');
  $('#memberSelect').value = cartMemberId;

  const member = cartMemberId ? D.members.find(m => m.id === cartMemberId) : null;
  $('#memberInfo').innerHTML = member
    ? `会员：${esc(member.name)}　等级：${esc(levelName(member.levelId))}（${(levelRate(member.levelId) * 100).toFixed(0)}折）　可用积分：${member.points}`
    : '未选择会员';

  const puInput = $('#pointsUse');
  puInput.disabled = !member;
  if (!member){ pointsUse = 0; puInput.value = 0; }
  $('#manualDiscount').value = manualDiscount;

  $('#cartList').innerHTML = cart.length ? cart.map(c =>
    `<div class="cart-item">
      <div class="ci-name">${esc(c.name)}</div>
      <div class="qty-ctl">
        <button onclick="cartQty('${c.productId}',-1)">−</button>
        <span class="q">${c.qty}</span>
        <button onclick="cartQty('${c.productId}',1)">＋</button>
      </div>
      <div class="ci-price">${money(c.price * c.qty)}</div>
      <div class="ci-del" onclick="removeFromCart('${c.productId}')" title="移除">✕</div>
    </div>`).join('') : '<div class="empty">购物车为空，点击左侧商品加入</div>';

  const s = calcCart();
  pointsUse = s.pointsUsed;
  puInput.value = pointsUse;

  $('#sumSubtotal').textContent = money(s.subtotal);
  $('#sumManualRow').style.display = s.manualDiscountAmt > 0.001 ? 'flex' : 'none';
  $('#sumManual').textContent = '-' + money(s.manualDiscountAmt);
  $('#sumRateLabel').textContent = member ? levelName(member.levelId) + ' ' + (s.vipRate * 100).toFixed(0) + '折' : '无';
  $('#sumVip').textContent = '-' + money(s.vipDiscount);
  $('#sumPoints').textContent = '-' + money(s.pointsValue);
  $('#sumPayable').textContent = money(s.payable);

  $('#cashRow').style.display = payMethod === '现金' ? 'block' : 'none';
  $('#cashReceived').value = cashReceived;
  if (payMethod === '现金'){
    const cash = parseFloat(cashReceived) || 0;
    $('#changeLabel').textContent = money(Math.max(0, round2(cash - s.payable)));
  }
}

/* ---------- 结算 ---------- */
async function settle(){
  if (!cart.length){ alert('购物车为空，请先选择商品'); return; }
  try {
    const sale = await api('/sales', {
      method: 'POST',
      body: {
        items: cart.map(c => ({ productId: c.productId, qty: c.qty })),
        memberId: cartMemberId || null,
        pointsUse,
        manualDiscount,
        payMethod,
        cashReceived: parseFloat(cashReceived) || null
      }
    });
    await refresh();
    showReceipt(sale);
    cart = []; cartMemberId = ''; pointsUse = 0; manualDiscount = 100; cashReceived = ''; payMethod = '微信';
    renderPos();
  } catch (e){
    alert('结算失败：' + e.message);
  }
}

/* ---------- 小票 ---------- */
function showReceipt(sale){
  const items = sale.items.map(it => `<div class="r-line"><span>${esc(it.name)} ×${it.qty}</span><span>${money(it.price * it.qty)}</span></div>`).join('');
  $('#receiptContent').innerHTML = `
    <div class="receipt">
      <div class="r-head">
        <div class="shop">${esc(D.settings.shopName)}</div>
        <p>单号：${esc(sale.no)}</p>
        <p>${fmtDT(sale.time)}　收银员：${esc(D.settings.cashier)}</p>
      </div>
      <div class="r-items">${items}</div>
      <div class="r-line"><span>小计</span><span>${money(sale.subtotal)}</span></div>
      ${sale.manualDiscountAmt > 0.001 ? `<div class="r-line"><span>整单折扣</span><span>-${money(sale.manualDiscountAmt)}</span></div>` : ''}
      ${sale.memberName ? `<div class="r-line"><span>${esc(sale.memberName)}（${esc(sale.memberLevel)}）</span><span>-${money(sale.vipDiscount)}</span></div>` : ''}
      ${sale.pointsValue > 0 ? `<div class="r-line"><span>积分抵扣 ${sale.pointsUsed} 分</span><span>-${money(sale.pointsValue)}</span></div>` : ''}
      <div class="r-line r-tot"><span>实收</span><span>${money(sale.payable)}</span></div>
      <div class="r-line"><span>支付方式</span><span>${esc(sale.payMethod)}</span></div>
      ${sale.payMethod === '现金' ? `<div class="r-line"><span>现金 ${money(sale.cashReceived)}　找零</span><span>${money(sale.change)}</span></div>` : ''}
      ${sale.pointsEarned > 0 ? `<p style="margin-top:6px">本次获得积分：${sale.pointsEarned} 分</p>` : ''}
      <p style="text-align:center;margin-top:8px">—— 谢谢惠顾，欢迎再次光临 ——</p>
    </div>`;
  openModal('receiptModal');
}
function printReceipt(){
  $('#printArea').innerHTML = $('#receiptContent').innerHTML;
  window.print();
}

/* ============================================================
 * 出库入库
 * ============================================================ */
function renderStock(){
  $('#stockProduct').innerHTML = D.products.map(p =>
    `<option value="${p.id}">${esc(p.name)}（当前库存 ${p.stock < 0 ? '不限' : p.stock} ${esc(p.unit || '')}）</option>`).join('');
  renderStockMoves();
}
async function renderStockMoves(){
  const moves = await api('/stock-moves?limit=30');
  $('#stockTbody').innerHTML = moves.length ? moves.map(m => `
    <tr>
      <td>${fmtDT(m.time)}</td>
      <td>${esc(m.productName)}</td>
      <td>${m.type === 'in' ? '<span class="badge b-green">入库</span>' : '<span class="badge b-orange">出库</span>'}</td>
      <td class="num"><b>${m.qty}</b></td>
      <td style="color:var(--muted)">${esc(m.note || '-')}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty">暂无出入库记录</td></tr>';
}
async function submitStock(){
  const productId = $('#stockProduct').value;
  const qty = parseFloat($('#stockQty').value);
  const note = $('#stockNote').value.trim();
  if (!productId){ alert('请选择商品'); return; }
  if (!qty || qty <= 0){ alert('请输入正确的数量'); return; }
  try {
    const r = await api('/stock', { method: 'POST', body: { productId: parseInt(productId, 10), type: $('#stockType').value, qty, note } });
    await refresh();
    $('#stockQty').value = '';
    $('#stockNote').value = '';
    renderStock();
    alert('操作成功，当前库存：' + r.newStock);
  } catch (e){ alert('操作失败：' + e.message); }
}

/* ============================================================
 * 商品管理（电脑端）
 * ============================================================ */
let editingProductId = null;
function productFormOpen(id){
  editingProductId = id || null;
  const p = id ? D.products.find(x => x.id === id) : null;
  $('#productModalTitle').textContent = p ? '编辑商品' : '新增商品';
  $('#pfName').value = p ? p.name : '';
  $('#pfCat').value = p ? p.category : '';
  $('#pfPrice').value = p ? p.price : '';
  $('#pfCost').value = p ? p.cost : '';
  $('#pfStock').value = p ? p.stock : 100;
  $('#pfUnit').value = p ? p.unit : '';
  openModal('productModal');
}
async function saveProduct(){
  const name = $('#pfName').value.trim();
  const price = parseFloat($('#pfPrice').value);
  if (!name){ alert('请输入商品名称'); return; }
  if (isNaN(price) || price < 0){ alert('请输入正确的售价'); return; }
  const body = {
    name,
    category: $('#pfCat').value.trim() || '未分类',
    price: round2(price),
    cost: round2(parseFloat($('#pfCost').value) || 0),
    stock: Math.round(parseFloat($('#pfStock').value) || 0),
    unit: $('#pfUnit').value.trim()
  };
  try {
    if (editingProductId) await api('/products/' + editingProductId, { method: 'PUT', body });
    else await api('/products', { method: 'POST', body });
    await refresh(); closeModal('productModal'); renderProducts();
  } catch (e){ alert('保存失败：' + e.message); }
}
async function delProduct(id){
  const p = D.products.find(x => x.id === id);
  if (!p) return;
  if (!confirm(`确定删除商品「${p.name}」？历史销售记录不受影响。`)) return;
  try {
    await api('/products/' + id, { method: 'DELETE' });
    await refresh(); renderProducts();
  } catch (e){ alert('删除失败：' + e.message); }
}
function renderProducts(){
  $('#prodCatFilter').innerHTML = '<option value="全部">全部分类</option>' +
    [...new Set(D.products.map(p => p.category))].map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('#prodCatFilter').value = prodFilter.cat;

  const kw = prodFilter.kw.trim().toLowerCase();
  const list = D.products.filter(p =>
    (prodFilter.cat === '全部' || p.category === prodFilter.cat) &&
    (!kw || p.name.toLowerCase().includes(kw) || p.category.toLowerCase().includes(kw)));

  $('#prodTbody').innerHTML = list.length ? list.map(p => `
    <tr>
      <td><b>${esc(p.name)}</b></td>
      <td><span class="badge b-gray">${esc(p.category)}</span></td>
      <td class="num">${money(p.price)}</td>
      <td class="num" style="color:var(--muted)">${money(p.cost)}</td>
      <td class="num ${p.stock >= 0 && p.stock <= D.settings.lowStock ? 'b-red' : ''}">${p.stock < 0 ? '不限' : p.stock}</td>
      <td>${esc(p.unit || '')}</td>
      <td><button class="btn small" onclick="productFormOpen('${p.id}')">编辑</button>
          <button class="btn small danger" onclick="delProduct('${p.id}')">删除</button></td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">暂无商品</td></tr>';
}

/* ============================================================
 * 会员管理（电脑端）
 * ============================================================ */
let memFilter = { kw: '' };
let editingLevelId = null;
let editingMemberId = null;

function levelFormOpen(id){
  editingLevelId = id || null;
  const l = id ? D.levels.find(x => x.id === id) : null;
  $('#levelModalTitle').textContent = l ? '编辑等级' : '新增等级';
  $('#lfName').value = l ? l.name : '';
  $('#lfRate').value = l ? l.rate : 0.95;
  openModal('levelModal');
}
async function saveLevel(){
  const name = $('#lfName').value.trim();
  const rate = parseFloat($('#lfRate').value);
  if (!name){ alert('请输入等级名称'); return; }
  if (isNaN(rate) || rate <= 0 || rate > 1){ alert('折扣率需在 0.01 ~ 1 之间'); return; }
  try {
    if (editingLevelId) await api('/levels/' + editingLevelId, { method: 'PUT', body: { name, rate } });
    else await api('/levels', { method: 'POST', body: { name, rate } });
    await refresh(); closeModal('levelModal'); renderMembers();
  } catch (e){ alert('保存失败：' + e.message); }
}
async function delLevel(id){
  try {
    await api('/levels/' + id, { method: 'DELETE' });
    await refresh(); renderMembers();
  } catch (e){ alert('删除失败：' + e.message); }
}

function memberFormOpen(id){
  editingMemberId = id || null;
  const m = id ? D.members.find(x => x.id === id) : null;
  $('#memberModalTitle').textContent = m ? '编辑会员' : '新增会员';
  $('#mfName').value = m ? m.name : '';
  $('#mfPhone').value = m ? m.phone : '';
  $('#mfPoints').value = m ? m.points : 0;
  $('#mfLevel').innerHTML = D.levels.map(l => `<option value="${l.id}">${esc(l.name)}（${(l.rate * 100).toFixed(0)}折）</option>`).join('');
  $('#mfLevel').value = m ? m.levelId : D.levels[0].id;
  openModal('memberModal');
}
async function saveMember(){
  const name = $('#mfName').value.trim();
  if (!name){ alert('请输入会员姓名'); return; }
  const body = {
    name,
    phone: $('#mfPhone').value.trim(),
    levelId: parseInt($('#mfLevel').value, 10),
    points: Math.max(0, Math.floor(parseFloat($('#mfPoints').value) || 0))
  };
  try {
    if (editingMemberId) await api('/members/' + editingMemberId, { method: 'PUT', body });
    else await api('/members', { method: 'POST', body });
    await refresh(); closeModal('memberModal'); renderMembers();
  } catch (e){ alert('保存失败：' + e.message); }
}
async function delMember(id){
  const m = D.members.find(x => x.id === id);
  if (!m) return;
  if (!confirm(`确定删除会员「${m.name}」？历史销售记录不受影响。`)) return;
  try {
    await api('/members/' + id, { method: 'DELETE' });
    await refresh(); renderMembers();
  } catch (e){ alert('删除失败：' + e.message); }
}
function renderMembers(){
  const lc = l => { const m = { 0.98: 'b-blue', 0.95: 'b-green', 0.92: 'b-orange', 0.88: 'b-purple' }; return m[l.rate] || 'b-gray'; };
  $('#levelTbody').innerHTML = D.levels.map(l => `
    <tr>
      <td><span class="badge ${lc(l)}">${esc(l.name)}</span></td>
      <td><b>${(l.rate * 100).toFixed(0)} 折</b>（率 ${l.rate}）</td>
      <td style="color:var(--muted);font-size:13px">在整单折扣之后额外 ${(l.rate * 100).toFixed(0)} 折</td>
      <td><button class="btn small" onclick="levelFormOpen('${l.id}')">编辑</button>
          <button class="btn small danger" onclick="delLevel('${l.id}')">删除</button></td>
    </tr>`).join('');

  const kw = memFilter.kw.trim().toLowerCase();
  const list = D.members.filter(m => !kw || m.name.toLowerCase().includes(kw) || m.phone.includes(kw));
  $('#memTbody').innerHTML = list.length ? list.map(m => `
    <tr>
      <td><b>${esc(m.name)}</b></td>
      <td>${esc(m.phone || '-')}</td>
      <td><span class="badge ${lc(D.levels.find(l => l.id === m.levelId) || { rate: 1 })}">${esc(levelName(m.levelId))}</span></td>
      <td class="num"><b>${m.points}</b> 分</td>
      <td>${fmtD(m.createdAt)}</td>
      <td><button class="btn small" onclick="memberFormOpen('${m.id}')">编辑</button>
          <button class="btn small danger" onclick="delMember('${m.id}')">删除</button></td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">暂无会员</td></tr>';
}

/* ============================================================
 * 出账记账
 * ============================================================ */
let editingExpenseId = null;
let expFilter = { cat: '全部', from: '', to: '' };

function expenseFormOpen(id){
  editingExpenseId = id || null;
  const e = id ? ALL_EXPENSES.find(x => x.id === id) : null;
  $('#expenseModalTitle').textContent = e ? '编辑出账' : '新增出账';
  $('#efDate').value = e ? fmtD(e.time) : todayStr();
  $('#efCat').value = e ? e.category : '进货';
  $('#efAmount').value = e ? e.amount : '';
  $('#efNote').value = e ? e.note : '';
  openModal('expenseModal');
}
async function saveExpense(){
  const date = $('#efDate').value;
  const cat = $('#efCat').value.trim();
  const amount = parseFloat($('#efAmount').value);
  if (!date){ alert('请选择日期'); return; }
  if (!cat){ alert('请输入类别'); return; }
  if (isNaN(amount) || amount <= 0){ alert('请输入正确的金额（大于 0）'); return; }
  const body = { date, category: cat, amount: round2(amount), note: $('#efNote').value.trim() };
  try {
    if (editingExpenseId) await api('/expenses/' + editingExpenseId, { method: 'PUT', body });
    else await api('/expenses', { method: 'POST', body });
    await refresh(); closeModal('expenseModal'); renderExpenses();
  } catch (e){ alert('保存失败：' + e.message); }
}
async function delExpense(id){
  const e = ALL_EXPENSES.find(x => x.id === id);
  if (!e) return;
  if (!confirm(`确定删除该笔出账（${e.category} ${money(e.amount)}）？`)) return;
  try {
    await api('/expenses/' + id, { method: 'DELETE' });
    await refresh(); renderExpenses();
  } catch (e){ alert('删除失败：' + e.message); }
}
let ALL_EXPENSES = [];
async function renderExpenses(){
  ALL_EXPENSES = await api('/expenses');
  const list = ALL_EXPENSES.filter(e =>
    (expFilter.cat === '全部' || e.category === expFilter.cat) &&
    inRange(e.time, expFilter.from, expFilter.to));
  const admin = DEVICE !== 'mobile';
  $('#expTbody').innerHTML = list.length ? list.map(e => `
    <tr>
      <td>${fmtD(e.time)}</td>
      <td><span class="badge b-red">${esc(e.category)}</span></td>
      <td class="num"><b style="color:var(--danger)">${money(e.amount)}</b></td>
      <td style="color:var(--muted)">${esc(e.note || '-')}</td>
      <td>${admin ? `<button class="btn small" onclick="expenseFormOpen('${e.id}')">编辑</button>
          <button class="btn small danger" onclick="delExpense('${e.id}')">删除</button>` : '<span style="color:var(--muted);font-size:12px">手机端只读</span>'}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty">该条件下暂无出账记录</td></tr>';
  $('#expTotal').textContent = money(list.reduce((a, e) => a + e.amount, 0));
}

/* ============================================================
 * 流水账本
 * ============================================================ */
let ledgerFilter = { type: 'all', from: '', to: '' };
async function renderLedger(){
  const [sales, expenses] = await Promise.all([api('/sales'), api('/expenses')]);
  const rows = [];
  sales.forEach(s => {
    if (ledgerFilter.type === 'out') return;
    const first = s.items[0];
    const more = s.items.length > 1 ? ` 等 ${s.items.length} 件` : '';
    rows.push({
      time: s.time, no: s.no, kind: 'in', badge: 'b-green', badgeText: '销售',
      summary: `${esc(first ? first.name : '')} ×${first ? first.qty : ''}${more}`,
      amount: s.payable, note: s.memberName ? `${s.memberName}（${s.memberLevel}）` : (s.pay_method || '')
    });
  });
  expenses.forEach(e => {
    if (ledgerFilter.type === 'in') return;
    rows.push({
      time: e.time, no: 'ZC-' + e.id, kind: 'out', badge: 'b-red', badgeText: '出账',
      summary: `${esc(e.category)} 支出`,
      amount: -e.amount, note: esc(e.note || '')
    });
  });
  const list = rows.filter(r => inRange(r.time, ledgerFilter.from, ledgerFilter.to)).sort((a, b) => b.time - a.time);

  $('#ledTbody').innerHTML = list.length ? list.map(r => `
    <tr>
      <td>${fmtDT(r.time)}</td>
      <td><span class="badge ${r.badge}">${r.badgeText}</span> <span style="font-size:12px;color:var(--muted)">${esc(r.no)}</span></td>
      <td>${r.summary}</td>
      <td class="num" style="color:${r.kind === 'in' ? 'var(--ok)' : 'var(--danger)'};font-weight:600">${r.amount >= 0 ? '+' : '-'}${money(Math.abs(r.amount))}</td>
      <td style="color:var(--muted)">${r.note || '-'}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty">该条件下暂无流水</td></tr>';

  const sumIn = round2(list.filter(r => r.kind === 'in').reduce((a, r) => a + r.amount, 0));
  const sumOut = round2(list.filter(r => r.kind === 'out').reduce((a, r) => a + Math.abs(r.amount), 0));
  $('#ledSumIn').textContent = money(sumIn);
  $('#ledSumOut').textContent = money(sumOut);
  $('#ledSumNet').textContent = money(sumIn - sumOut);
}

/* ============================================================
 * 统计分析
 * ============================================================ */
let statsRange = { from: todayStr(), to: todayStr() };
function setStatsRange(kind){
  const today = new Date();
  if (kind === 'today'){ statsRange = { from: todayStr(), to: todayStr() }; }
  else if (kind === 'week'){
    const f = new Date(today); f.setDate(f.getDate() - 6);
    statsRange = { from: fmtD(f.getTime()), to: todayStr() };
  }
  else if (kind === 'month'){
    statsRange = { from: `${today.getFullYear()}-${pad(today.getMonth()+1)}-01`, to: todayStr() };
  }
  $('#stFrom').value = statsRange.from;
  $('#stTo').value = statsRange.to;
  renderStats();
}
async function renderStats(){
  $('#stFrom').value = statsRange.from;
  $('#stTo').value = statsRange.to;
  const s = await api('/stats?from=' + statsRange.from + '&to=' + statsRange.to);
  $('#stOrders').textContent = s.orders;
  $('#stRevenue').textContent = money(s.revenue);
  $('#stVip').textContent = money(s.vipGive);
  $('#stExpense').textContent = money(s.expense);
  $('#stGross').textContent = money(s.gross);
  $('#stNet').textContent = money(s.net);

  const maxV = Math.max(...s.week.map(d => d.value), 1);
  $('#weekBars').innerHTML = s.week.map(d => `
    <div class="bar-col" title="${d.label}：${money(d.value)}">
      <div class="bv">${d.value >= 100 ? '¥' + Math.round(d.value) : d.value > 0 ? d.value.toFixed(0) : ''}</div>
      <div class="bar" style="height:${Math.max(3, d.value / maxV * 100)}%"></div>
      <div class="bl">${d.label}</div>
    </div>`).join('');

  const maxC = s.categories.length ? s.categories[0].value : 1;
  $('#catBreakdown').innerHTML = s.categories.length ? s.categories.map(c => `
    <div class="catbar-row">
      <span class="cn">${esc(c.name)}</span>
      <div class="track"><div class="fill" style="width:${(c.value / maxC * 100).toFixed(1)}%"></div></div>
      <span class="cv">${money(c.value)}</span>
    </div>`).join('') : '<div class="empty">该时间段内无销售数据</div>';
}

/* ============================================================
 * 系统设置（电脑端）
 * ============================================================ */
function renderSettings(){
  $('#setShopName').value = D.settings.shopName;
  $('#setCashier').value = D.settings.cashier;
  $('#setPointsPerYuan').value = D.settings.pointsPerYuan;
  $('#setPointsToYuan').value = D.settings.pointsToYuan;
  $('#setLowStock').value = D.settings.lowStock;
}
async function saveSettings(){
  try {
    await api('/settings', {
      method: 'PUT',
      body: {
        shopName: $('#setShopName').value.trim() || '收银宝便利店',
        cashier: $('#setCashier').value.trim() || '收银员',
        pointsPerYuan: parseFloat($('#setPointsPerYuan').value) || 0,
        pointsToYuan: parseInt($('#setPointsToYuan').value, 10) || 100,
        lowStock: parseInt($('#setLowStock').value, 10) || 10
      }
    });
    await refresh();
    alert('设置已保存');
  } catch (e){ alert('保存失败：' + e.message); }
}
function downloadBackup(){
  window.location.href = '/api/backup';
}
async function resetSample(){
  if (!confirm('将用示例数据覆盖当前所有数据，确定？')) return;
  try {
    await api('/reset-sample', { method: 'POST' });
    await refresh(); switchView('home');
  } catch (e){ alert('操作失败：' + e.message); }
}
async function clearData(){
  if (!confirm('确定清空所有数据？此操作不可恢复！')) return;
  try {
    await api('/clear', { method: 'POST' });
    await refresh(); switchView('home');
  } catch (e){ alert('操作失败：' + e.message); }
}

/* ============================================================
 * 报表中心（日报 / 周报 / 月报，电脑端）
 * ============================================================ */
let reportState = { type: 'daily', date: todayStr() };

function renderReport(){
  $('#repType').value = reportState.type;
  $('#repDate').value = reportState.date;
  loadReport();
}
async function loadReport(){
  reportState.type = $('#repType').value;
  reportState.date = $('#repDate').value || todayStr();
  try {
    const r = await api('/report?type=' + reportState.type + '&date=' + reportState.date);
    renderReportContent(r);
  } catch (e){
    $('#reportArea').innerHTML = '<div class="empty">报表生成失败：' + esc(e.message) + '</div>';
  }
}
function renderReportContent(r){
  const s = r.summary;
  const item = (k, v, color) => `<div class="rg-item"><div class="k">${k}</div><div class="v"${color ? ` style="color:${color}"` : ''}>${v}</div></div>`;
  const sumGrid = `<div class="report-grid">
      ${item('订单数', s.orders + ' 单')}
      ${item('营业额', money(s.revenue))}
      ${item('客单价', money(s.avgOrder))}
      ${item('VIP 让利', money(s.vipGive), 'var(--warn)')}
      ${item('积分发放', s.pointsIssued + ' 分')}
      ${item('销售毛利', money(s.gross))}
      ${item('支出合计', money(s.expense), 'var(--danger)')}
      ${item('净利', money(s.net), 'var(--ok)')}
      ${item('新增会员', s.newMembers + ' 人')}
    </div>`;

  const dailyTable = r.daily.length ? `<h4>每日明细（${r.type === 'daily' ? '当日' : r.type === 'weekly' ? '周一至周日' : '全月每日'}）</h4>
    <table class="tbl"><thead><tr><th>日期</th><th>星期</th><th class="num">订单数</th><th class="num">营业额</th><th class="num">支出</th><th class="num">净利</th></tr></thead>
    <tbody>${r.daily.map(d => `<tr><td>${d.date}</td><td>${d.weekday}</td><td class="num">${d.orders}</td><td class="num">${money(d.revenue)}</td><td class="num" style="color:var(--danger)">${money(d.expense)}</td><td class="num" style="color:var(--ok)">${money(d.revenue - d.expense)}</td></tr>`).join('')}</tbody></table>` : '';

  const topTable = r.topProducts.length ? `<h4>热销商品 TOP ${r.topProducts.length}</h4>
    <table class="tbl"><thead><tr><th>排名</th><th>商品</th><th class="num">销量</th><th class="num">销售额</th></tr></thead>
    <tbody>${r.topProducts.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td class="num">${p.qty}</td><td class="num">${money(p.amount)}</td></tr>`).join('')}</tbody></table>`
    : '<h4>热销商品 TOP 10</h4><div class="empty">该周期内暂无销售</div>';

  const payTable = r.payMethods.length ? `<h4>支付方式分布</h4>
    <table class="tbl"><thead><tr><th>方式</th><th class="num">笔数</th><th class="num">金额</th></tr></thead>
    <tbody>${r.payMethods.map(p => `<tr><td>${esc(p.method)}</td><td class="num">${p.count}</td><td class="num">${money(p.amount)}</td></tr>`).join('')}</tbody></table>` : '';

  const expCatTable = r.expenseCats.length ? `<h4>支出分类合计</h4>
    <table class="tbl"><thead><tr><th>类别</th><th class="num">笔数</th><th class="num">金额</th></tr></thead>
    <tbody>${r.expenseCats.map(e => `<tr><td>${esc(e.category)}</td><td class="num">${e.count}</td><td class="num" style="color:var(--danger)">${money(e.amount)}</td></tr>`).join('')}</tbody></table>` : '';

  const expList = r.type === 'daily' && r.expenseList.length ? `<h4>支出明细</h4>
    <table class="tbl"><thead><tr><th>类别</th><th class="num">金额</th><th>备注</th></tr></thead>
    <tbody>${r.expenseList.map(e => `<tr><td>${esc(e.category)}</td><td class="num" style="color:var(--danger)">${money(e.amount)}</td><td style="color:var(--muted)">${esc(e.note || '-')}</td></tr>`).join('')}</tbody></table>` : '';

  const typeName = r.type === 'daily' ? '日报' : r.type === 'weekly' ? '周报' : '月报';
  $('#reportArea').innerHTML = `
    <div class="report">
      <div class="r-title">${esc(r.shopName)} · ${typeName}</div>
      <div class="r-sub">统计周期：${esc(r.range.label)}　　生成时间：${fmtDT(r.generatedAt)}</div>
      ${sumGrid}
      ${dailyTable}
      ${topTable}
      ${payTable}
      ${expCatTable}
      ${expList}
      <div style="text-align:center;color:var(--muted);font-size:12px;margin-top:14px">—— 收银宝报表 · 完 ——</div>
    </div>`;
}
function printReport(){
  const html = $('#reportArea').innerHTML;
  if (!html || !html.includes('class="report"')){ alert('请先选择类型与日期生成报表'); return; }
  $('#reportPrintArea').innerHTML = html;
  window.print();
}
function exportReportTxt(){
  const area = $('#reportArea');
  const el = area.querySelector('.report');
  if (!el){ alert('请先生成报表'); return; }
  const txt = (el.innerText || el.textContent).replace(/\n{3,}/g, '\n\n').trim();
  const blob = new Blob(['\ufeff' + txt + '\n'], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `收银宝${reportState.type === 'daily' ? '日报' : reportState.type === 'weekly' ? '周报' : '月报'}_${reportState.date}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ============================================================
 * 初始化
 * ============================================================ */
(async function init(){
  try {
    await refresh();
    // 统计默认今天
    statsRange = { from: todayStr(), to: todayStr() };
    $('#stFrom').value = statsRange.from;
    $('#stTo').value = statsRange.to;
    switchView('home');
  } catch (e){
    document.body.innerHTML = `<div style="padding:60px;text-align:center;font-family:sans-serif">
      <h2>⚠️ 无法连接服务器</h2>
      <p style="color:#64748b;margin-top:12px">${esc(e.message)}</p>
      <p style="color:#64748b;margin-top:6px">请确认服务器电脑已启动服务（双击 启动服务.bat），且本机与服务器在同一网络。</p>
    </div>`;
  }
})();
