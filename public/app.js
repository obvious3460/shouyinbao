'use strict';
/* ============================================================
 * 收银宝前端（服务端版）—— API 客户端
 * 所有数据通过 /api/* 读写服务器 SQLite 数据库
 * 设备权限：手机端仅新增销售/支出记账；电脑端查看流水统计并完整管理
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
  const mobile = DEVICE === 'mobile';
  $('#deviceTag').textContent = mobile
    ? '📱 手机模式：仅新增记账'
    : '💻 电脑模式：查看流水 / 统计 / 完整管理';
  const allowed = mobile ? MOBILE_VIEWS : null;
  $$('.nav-item').forEach(el => {
    const hidden = allowed && !allowed.has(el.dataset.view);
    el.style.display = hidden ? 'none' : '';
  });
  $$('.view').forEach(el => {
    const name = el.id.replace(/^view-/, '');
    if (allowed && !allowed.has(name)) el.style.display = 'none';
  });
  $$('.admin-only').forEach(el => el.style.display = mobile ? 'none' : '');
  const posNav = document.querySelector('.nav-item[data-view="pos"]');
  if (posNav){
    posNav.innerHTML = `<span class="nav-icon" aria-hidden="true">${mobile ? '🧾' : '🛒'}</span><span class="nav-label">${mobile ? '销售记账' : '收银台'}</span>`;
  }
  const employeeStatus = $('#employeeStatus');
  if (employeeStatus){
    employeeStatus.className = 'employee-status';
    employeeStatus.innerHTML = D.employee
      ? `👤 ${esc(D.employee.name)} <button class="logout" onclick="logoutEmployee()">退出</button>`
      : '';
  }
  ['#posEmployeeRow', '#posCashierRow', '#expenseEmployeeRow'].forEach(sel => {
    const el = $(sel);
    if (el) el.style.display = mobile ? 'none' : '';
  });
  const expenseHistory = $('#expenseHistory');
  const expenseHistoryTools = $('#expenseHistoryTools');
  if (mobile){
    if (expenseHistory) expenseHistory.style.display = 'none';
    if (expenseHistoryTools) expenseHistoryTools.style.display = 'none';
  } else {
    if (expenseHistory) expenseHistory.style.display = '';
    if (expenseHistoryTools) expenseHistoryTools.style.display = 'contents';
  }
}

/* ---------- 视图切换 ---------- */
const PAGE_TITLES = {
  analysis: '📊 经营分析',
  home: '📊 今日概览', pos: '🛒 收银台', inventory: '📦 库存管理',
  members: '👤 会员管理', employees: '👷 员工管理', expenses: '💸 出账记账', ledger: '📒 流水账本', stats: '📈 统计分析', report: '📑 报表中心', chat: '🤖 AI 助手', settings: '⚙️ 系统设置'
};
const MOBILE_VIEWS = new Set(['pos', 'expenses']);
const ANALYSIS_TAB_TITLES = { home: '今日概览', ledger: '流水账本', stats: '统计分析' };
let analysisTab = 'home';

async function switchView(name){
  if (DEVICE === 'mobile' && !MOBILE_VIEWS.has(name)){
    return;
  }
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === name));
  $$('.view').forEach(el => el.style.display = 'none');
  const v = $('#view-' + name);
  if (v) v.style.display = 'block';
  $('#pageTitle').textContent = PAGE_TITLES[name] || '';
  const renders = {
    analysis: renderAnalysis,
    home: renderHome, pos: renderPos, inventory: renderInventory, members: renderMembers,
    employees: renderEmployees, expenses: renderExpenses, ledger: renderLedger, stats: renderStats, report: renderReport, chat: renderChat, settings: renderSettings
  };
  if (renders[name]) await renders[name]();
}
async function switchAnalysisTab(name){
  if (!ANALYSIS_TAB_TITLES[name]) name = 'home';
  analysisTab = name;
  ['home', 'ledger', 'stats'].forEach(tabName => {
    const panel = $('#view-' + tabName);
    if (panel) panel.style.display = tabName === analysisTab ? 'block' : 'none';
  });
  $$('.analysis-tab').forEach(el => el.classList.toggle('active', el.dataset.analysisTab === analysisTab));
  $('#pageTitle').textContent = PAGE_TITLES.analysis + ' · ' + ANALYSIS_TAB_TITLES[analysisTab];
  const renders = { home: renderHome, ledger: renderLedger, stats: renderStats };
  await renders[analysisTab]();
}
async function renderAnalysis(){
  await switchAnalysisTab(analysisTab);
}
function modalElement(id){
  const key = String(id || '');
  return key.startsWith('#') ? $(key) : document.getElementById(key);
}
function openModal(id){
  const el = modalElement(id);
  if (el) el.classList.add('show');
}
function closeModal(id){
  const el = modalElement(id);
  if (el) el.classList.remove('show');
}

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
let manualDiscount = 100;
let payMethod = '微信';
let cashReceived = '';

function renderPos(){
  if (!$('#posCashier').value) $('#posCashier').value = D.settings.cashier || '';
  $('#cashierList').innerHTML = D.settings.cashier ? `<option value="${esc(D.settings.cashier)}">` : '';
  const employeeSelect = $('#posEmployee');
  if (employeeSelect){
    const current = employeeSelect.value;
    employeeSelect.innerHTML = '<option value="">未指定员工</option>' +
      (D.employees || []).filter(e => e.active !== false && e.active !== 0)
        .map(e => `<option value="${e.id}">${esc(e.name)}（${esc(e.username)}）</option>`).join('');
    employeeSelect.value = current;
  }
  renderProductGrid();
  renderCart();
}

function renderProductGrid(){
  const saleable = D.products.filter(p => p.kind !== 'supply');
  const cats = ['全部', ...new Set(saleable.map(p => p.category))];
  $('#catChips').innerHTML = cats.map(c =>
    `<div class="chip ${prodFilter.cat === c ? 'active' : ''}" onclick="prodFilter.cat=${JSON.stringify(c)};renderProductGrid()">${esc(c)}</div>`).join('');

  const kw = prodFilter.kw.trim().toLowerCase();
  const list = saleable.filter(p =>
    (prodFilter.cat === '全部' || p.category === prodFilter.cat) &&
    (!kw || p.name.toLowerCase().includes(kw)));

  $('#posGrid').innerHTML = list.length ? list.map(p => {
    const service = p.kind === 'service';
    const out = !service && p.stock === 0;
    const low = !service && p.stock > 0 && p.stock <= D.settings.lowStock;
    const materials = (D.serviceMaterials || []).filter(m => m.serviceId === p.id);
    const detail = service ? (materials.length ? '服务 · 消耗 ' + materials.map(m => {
      const material = D.products.find(x => x.id === m.materialId);
      return material ? material.name + ' ' + m.qty + (material.unit || '') : '';
    }).filter(Boolean).join('、') : '服务 · 不消耗耗材') : (p.stock < 0 ? '不限库存' : '库存 ' + p.stock) + ' ' + (p.unit || '');
    return `<div class="pcard ${out ? 'out' : ''} ${low ? 'low' : ''}" ${out ? '' : `onclick="addToCart('${p.id}')"`} title="点击加入购物车">
      <div class="pname">${esc(p.name)}</div>
      <div class="pprice">${money(p.price)}</div>
      <div class="pstock">${esc(detail)}</div>
    </div>`;
  }).join('') : '<div class="empty" style="grid-column:1/-1">没有找到商品，请到电脑端「商品管理」添加</div>';
}

function addToCart(pid){
  const productId = Number(pid);
  const p = D.products.find(x => x.id === productId);
  if (!p) return;
  if (p.kind === 'supply') return;
  if (p.stock === 0){ alert(`「${p.name}」已售罄`); return; }
  const item = cart.find(c => c.productId === productId);
  if (item){
    if (p.stock >= 0 && item.qty + 1 > p.stock){ alert(`「${p.name}」库存不足（剩余 ${p.stock}）`); return; }
    item.qty++;
  } else {
    cart.push({ productId: p.id, name: p.name, category: p.category, price: p.price, cost: p.cost, qty: 1, unit: p.unit });
  }
  renderCart();
}
function cartQty(pid, d){
  const productId = Number(pid);
  const item = cart.find(c => c.productId === productId);
  if (!item) return;
  const p = D.products.find(x => x.id === productId);
  item.qty += d;
  if (item.qty <= 0){ cart = cart.filter(c => c.productId !== productId); }
  else if (p && p.stock >= 0 && item.qty > p.stock){ alert(`「${p.name}」库存不足`); item.qty = p.stock; }
  renderCart();
}
function removeFromCart(pid){
  const productId = Number(pid);
  cart = cart.filter(c => c.productId !== productId);
  renderCart();
}
function clearCart(){ if (cart.length && !confirm('确定清空购物车？')) return; cart = []; renderCart(); }

function onMemberChange(){
  cartMemberId = $('#memberSelect').value;
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
  const payable = afterVip;
  const pointsEarned = Math.floor(payable * D.settings.pointsPerYuan);
  return { subtotal, manualRate, manualDiscountAmt, vipRate: rate, vipDiscount, payable, pointsEarned };
}

function renderCart(){
  $('#memberSelect').innerHTML = '<option value="">非会员（不打折）</option>' +
    D.members.map(m => `<option value="${m.id}">${esc(m.name)}（${esc(levelName(m.levelId))} ${(levelRate(m.levelId) * 100).toFixed(0)}折）</option>`).join('');
  $('#memberSelect').value = cartMemberId;

  const member = cartMemberId ? D.members.find(m => m.id === cartMemberId) : null;
  $('#memberInfo').innerHTML = member
    ? `会员：${esc(member.name)}　等级：${esc(levelName(member.levelId))}（${(levelRate(member.levelId) * 100).toFixed(0)}折）　积分余额：${member.points}`
    : '未选择会员';

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

  $('#sumSubtotal').textContent = money(s.subtotal);
  $('#sumManualRow').style.display = s.manualDiscountAmt > 0.001 ? 'flex' : 'none';
  $('#sumManual').textContent = '-' + money(s.manualDiscountAmt);
  $('#sumRateLabel').textContent = member ? levelName(member.levelId) + ' ' + (s.vipRate * 100).toFixed(0) + '折' : '无';
  $('#sumVip').textContent = '-' + money(s.vipDiscount);
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
        manualDiscount,
        payMethod,
        cashReceived: parseFloat(cashReceived) || null,
        cashier: ($('#posCashier').value || '').trim() || D.settings.cashier,
        employeeId: parseInt($('#posEmployee').value, 10) || null
      }
    });
    await refresh();
    showReceipt(sale);
    cart = []; cartMemberId = ''; manualDiscount = 100; cashReceived = ''; payMethod = '微信';
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
        <p>${fmtDT(sale.time)}　员工：${esc(sale.employeeName || sale.cashier || D.settings.cashier)}</p>
      </div>
      <div class="r-items">${items}</div>
      <div class="r-line"><span>小计</span><span>${money(sale.subtotal)}</span></div>
      ${sale.manualDiscountAmt > 0.001 ? `<div class="r-line"><span>整单折扣</span><span>-${money(sale.manualDiscountAmt)}</span></div>` : ''}
      ${sale.memberName ? `<div class="r-line"><span>${esc(sale.memberName)}（${esc(sale.memberLevel)}）</span><span>-${money(sale.vipDiscount)}</span></div>` : ''}
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
  $('#stockProduct').innerHTML = D.products.filter(p => p.kind !== 'service').map(p =>
    `<option value="${p.id}">${esc(p.name)}（当前库存 ${p.stock < 0 ? '不限' : p.stock} ${esc(p.unit || '')}）</option>`).join('');
  renderStockMoves();
}
function renderInventory(){
  renderStock();
  renderProducts();
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
    renderInventory();
    alert('操作成功，当前库存：' + r.newStock);
  } catch (e){ alert('操作失败：' + e.message); }
}

/* ============================================================
 * 商品管理（电脑端）
 * ============================================================ */
let editingProductId = null;
function productFormOpen(id){
  editingProductId = id ? Number(id) : null;
  const p = editingProductId ? D.products.find(x => x.id === editingProductId) : null;
  $('#productModalTitle').textContent = p ? '编辑商品' : '新增商品';
  $('#pfName').value = p ? p.name : '';
  $('#pfCat').value = p ? p.category : '';
  $('#pfPrice').value = p ? p.price : '';
  $('#pfCost').value = p ? p.cost : '';
  $('#pfStock').value = p ? p.stock : 100;
  $('#pfUnit').value = p ? p.unit : '';
  $('#pfKind').value = p ? (p.kind || 'goods') : 'goods';
  $('#pfMaterials').innerHTML = '';
  if (p) (D.serviceMaterials || []).filter(m => m.serviceId === p.id).forEach(m => addMaterialRow(m.materialId, m.qty));
  updateProductKind();
  openModal('productModal');
}
function updateProductKind(){
  const service = $('#pfKind').value === 'service';
  const supply = $('#pfKind').value === 'supply';
  $('#pfStockField').style.display = service ? 'none' : '';
  $('#pfPriceField').style.display = supply ? 'none' : '';
  $('#pfCostLabel').textContent = service ? '服务基础成本（元，不含耗材）' : '成本价（元）';
  $('#pfMaterialsPanel').style.display = service ? '' : 'none';
}
function addMaterialRow(materialId, qty){
  const options = D.products.filter(p => p.kind !== 'service' && p.id !== editingProductId)
    .map(p => `<option value="${p.id}" ${p.id === Number(materialId) ? 'selected' : ''}>${esc(p.name)}（库存 ${p.stock < 0 ? '不限' : p.stock} ${esc(p.unit || '')}）</option>`).join('');
  if (!options){ alert('请先新增实物商品或耗材'); return; }
  const row = document.createElement('div');
  row.className = 'field-row material-row';
  row.style.cssText = 'align-items:end;margin:8px 0';
  row.innerHTML = `<label class="field">耗材<select class="material-id">${options}</select></label>
    <label class="field">每次用量<input class="material-qty" type="number" min="0.001" step="0.001" value="${qty || 1}"></label>
    <button class="btn small danger" onclick="this.parentElement.remove()">移除</button>`;
  $('#pfMaterials').appendChild(row);
}
async function saveProduct(){
  const name = $('#pfName').value.trim();
  const kind = $('#pfKind').value;
  const price = kind === 'supply' ? 0 : parseFloat($('#pfPrice').value);
  if (!name){ alert('请输入商品名称'); return; }
  if (isNaN(price) || price < 0){ alert('请输入正确的售价'); return; }
  const materials = $$('#pfMaterials .material-row').map(row => ({
    materialId: Number(row.querySelector('.material-id').value),
    qty: Number(row.querySelector('.material-qty').value)
  }));
  if (kind === 'service' && materials.some(m => !Number.isFinite(m.qty) || m.qty <= 0)){ alert('请输入正确的耗材用量'); return; }
  const body = {
    name,
    kind,
    category: $('#pfCat').value.trim() || '未分类',
    price: round2(price),
    cost: round2(parseFloat($('#pfCost').value) || 0),
    stock: kind === 'service' ? -1 : parseFloat($('#pfStock').value),
    unit: $('#pfUnit').value.trim(),
    materials: kind === 'service' ? materials : []
  };
  try {
    if (editingProductId) await api('/products/' + editingProductId, { method: 'PUT', body });
    else await api('/products', { method: 'POST', body });
    await refresh(); closeModal('productModal'); renderInventory();
  } catch (e){ alert('保存失败：' + e.message); }
}
async function delProduct(id){
  const p = D.products.find(x => x.id === Number(id));
  if (!p) return;
  if (!confirm(`确定删除商品「${p.name}」？历史销售记录不受影响。`)) return;
  try {
    await api('/products/' + id, { method: 'DELETE' });
    await refresh(); renderInventory();
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
      <td><b>${esc(p.name)}</b>${p.kind === 'service' ? '<div class="hint">' + ((D.serviceMaterials || []).filter(m => m.serviceId === p.id).map(m => { const x = D.products.find(y => y.id === m.materialId); return x ? esc(x.name) + ' ' + m.qty + esc(x.unit || '') : ''; }).filter(Boolean).join('、') || '无耗材') + '</div>' : ''}</td>
      <td><span class="badge b-gray">${p.kind === 'service' ? '服务' : p.kind === 'supply' ? '耗材' : '商品'}</span></td>
      <td><span class="badge b-gray">${esc(p.category)}</span></td>
      <td class="num">${money(p.price)}</td>
      <td class="num" style="color:var(--muted)">${money(p.cost)}</td>
      <td class="num ${p.kind !== 'service' && p.stock >= 0 && p.stock <= D.settings.lowStock ? 'b-red' : ''}">${p.kind === 'service' ? '—' : p.stock < 0 ? '不限' : p.stock}</td>
      <td>${esc(p.unit || '')}</td>
      <td><button class="btn small" onclick="productFormOpen('${p.id}')">编辑</button>
          <button class="btn small danger" onclick="delProduct('${p.id}')">删除</button></td>
    </tr>`).join('') : '<tr><td colspan="8" class="empty">暂无项目</td></tr>';
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
 * 员工管理与登录
 * ============================================================ */
let editingEmployeeId = null;
function employeeFormOpen(id){
  editingEmployeeId = id ? Number(id) : null;
  const e = editingEmployeeId ? (D.employees || []).find(x => x.id === editingEmployeeId) : null;
  $('#employeeModalTitle').textContent = e ? '编辑员工' : '新增员工';
  $('#employeeUsername').value = e ? e.username : '';
  $('#employeeUsername').disabled = !!e;
  $('#employeeName').value = e ? e.name : '';
  $('#employeePassword').value = '';
  $('#employeePassword').placeholder = e ? '留空表示不修改密码' : '至少 6 位';
  $('#employeeActive').checked = e ? !!e.active : true;
  openModal('employeeModal');
}
async function saveEmployee(){
  const username = $('#employeeUsername').value.trim();
  const name = $('#employeeName').value.trim();
  const password = $('#employeePassword').value;
  const active = $('#employeeActive').checked;
  if (!name){ alert('请输入员工姓名'); return; }
  if (!editingEmployeeId && !username){ alert('请输入登录账号'); return; }
  if (!editingEmployeeId && password.length < 6){ alert('密码至少需要 6 位'); return; }
  try {
    const body = { username, name, active };
    if (password) body.password = password;
    if (editingEmployeeId) await api('/employees/' + editingEmployeeId, { method: 'PUT', body });
    else await api('/employees', { method: 'POST', body });
    await refresh(); closeModal('employeeModal'); renderEmployees();
  } catch (e){ alert('保存失败：' + e.message); }
}
async function delEmployee(id){
  const e = (D.employees || []).find(x => x.id === Number(id));
  if (!e || !confirm(`确定删除员工「${e.name}」？历史记录不会被删除。`)) return;
  try {
    await api('/employees/' + Number(id), { method: 'DELETE' });
    await refresh(); renderEmployees();
  } catch (err){ alert('删除失败：' + err.message); }
}
function renderEmployees(){
  const list = D.employees || [];
  $('#employeeTbody').innerHTML = list.length ? list.map(e => `
    <tr>
      <td><b>${esc(e.name)}</b></td>
      <td>${esc(e.username)}</td>
      <td><span class="badge ${e.active ? 'b-green' : 'b-gray'}">${e.active ? '启用' : '停用'}</span></td>
      <td>${fmtD(e.created_at || e.createdAt)}</td>
      <td><button class="btn small" onclick="employeeFormOpen('${e.id}')">编辑</button>
          <button class="btn small danger" onclick="delEmployee('${e.id}')">删除</button></td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty">暂无员工</td></tr>';
}
function showEmployeeLogin(){
  $('#loginOverlay').classList.add('show');
  $('#loginError').textContent = '';
  setTimeout(() => $('#loginUsername').focus(), 0);
}
async function loginEmployee(){
  const username = $('#loginUsername').value.trim();
  const password = $('#loginPassword').value;
  const error = $('#loginError');
  const button = $('#loginOverlay button');
  if (!username || !password){ error.textContent = '请输入账号和密码'; return; }
  button.disabled = true;
  error.textContent = '';
  try {
    await api('/login', { method: 'POST', body: { username, password } });
    await refresh();
    $('#loginOverlay').classList.remove('show');
    $('#loginPassword').value = '';
    await switchView('pos');
  } catch (e){
    error.textContent = e.message;
  } finally {
    button.disabled = false;
  }
}
async function logoutEmployee(){
  try { await api('/logout', { method: 'POST' }); } finally { window.location.reload(); }
}

/* ============================================================
 * 出账记账
 * ============================================================ */
let editingExpenseId = null;
let expFilter = { cat: '全部', from: '', to: '' };

function expenseFormOpen(id){
  editingExpenseId = id ? Number(id) : null;
  const e = editingExpenseId ? ALL_EXPENSES.find(x => x.id === editingExpenseId) : null;
  $('#expenseModalTitle').textContent = e ? '编辑出账' : '新增出账';
  $('#efDate').value = e ? fmtD(e.time) : todayStr();
  $('#efCat').value = e ? e.category : '进货';
  $('#efAmount').value = e ? e.amount : '';
  $('#efNote').value = e ? e.note : '';
  const employeeSelect = $('#efEmployee');
  if (employeeSelect){
    employeeSelect.innerHTML = '<option value="">未指定员工</option>' +
      (D.employees || []).filter(x => x.active !== false && x.active !== 0)
        .map(x => `<option value="${x.id}">${esc(x.name)}（${esc(x.username)}）</option>`).join('');
    employeeSelect.value = e && e.employee_id ? String(e.employee_id) : '';
  }
  openModal('expenseModal');
}
async function saveExpense(){
  const date = $('#efDate').value;
  const cat = $('#efCat').value.trim();
  const amount = parseFloat($('#efAmount').value);
  if (!date){ alert('请选择日期'); return; }
  if (!cat){ alert('请输入类别'); return; }
  if (isNaN(amount) || amount <= 0){ alert('请输入正确的金额（大于 0）'); return; }
  const body = { date, category: cat, amount: round2(amount), note: $('#efNote').value.trim(), employeeId: parseInt($('#efEmployee').value, 10) || null };
  try {
    if (editingExpenseId) await api('/expenses/' + editingExpenseId, { method: 'PUT', body });
    else await api('/expenses', { method: 'POST', body });
    await refresh(); closeModal('expenseModal'); renderExpenses();
  } catch (e){ alert('保存失败：' + e.message); }
}
async function delExpense(id){
  const e = ALL_EXPENSES.find(x => x.id === Number(id));
  if (!e) return;
  if (!confirm(`确定删除该笔出账（${e.category} ${money(e.amount)}）？`)) return;
  try {
    await api('/expenses/' + id, { method: 'DELETE' });
    await refresh(); renderExpenses();
  } catch (e){ alert('删除失败：' + e.message); }
}
let ALL_EXPENSES = [];
async function renderExpenses(){
  const mobile = DEVICE === 'mobile';
  const history = $('#expenseHistory');
  const historyTools = $('#expenseHistoryTools');
  const addButton = $('#expenseAddBtn');
  if (mobile){
    if (history) history.style.display = 'none';
    if (historyTools) historyTools.style.display = 'none';
    if (addButton) addButton.textContent = '＋ 记录支出';
    return;
  }
  if (history) history.style.display = '';
  if (historyTools) historyTools.style.display = 'contents';
  if (addButton) addButton.textContent = '＋ 新增出账';
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
      <td>${esc(e.employee_name || '未绑定')}</td>
      <td>${admin ? `<button class="btn small" onclick="expenseFormOpen('${e.id}')">编辑</button>
          <button class="btn small danger" onclick="delExpense('${e.id}')">删除</button>` : '<span style="color:var(--muted);font-size:12px">手机端只读</span>'}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">该条件下暂无出账记录</td></tr>';
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
      amount: s.payable, employee: s.employee_name || s.cashier || '未绑定',
      note: s.memberName ? `${s.memberName}（${s.memberLevel}）` : (s.pay_method || '')
    });
  });
  expenses.forEach(e => {
    if (ledgerFilter.type === 'in') return;
    rows.push({
      time: e.time, no: 'ZC-' + e.id, kind: 'out', badge: 'b-red', badgeText: '出账',
      summary: `${esc(e.category)} 支出`,
      amount: -e.amount, employee: e.employee_name || '未绑定', note: esc(e.note || '')
    });
  });
  const list = rows.filter(r => inRange(r.time, ledgerFilter.from, ledgerFilter.to)).sort((a, b) => b.time - a.time);

  $('#ledTbody').innerHTML = list.length ? list.map(r => `
    <tr>
      <td>${fmtDT(r.time)}</td>
      <td><span class="badge ${r.badge}">${r.badgeText}</span> <span style="font-size:12px;color:var(--muted)">${esc(r.no)}</span></td>
      <td>${r.summary}</td>
      <td class="num" style="color:${r.kind === 'in' ? 'var(--ok)' : 'var(--danger)'};font-weight:600">${r.amount >= 0 ? '+' : '-'}${money(Math.abs(r.amount))}</td>
      <td>${esc(r.employee)}</td>
      <td style="color:var(--muted)">${r.note || '-'}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">该条件下暂无流水</td></tr>';

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
  $('#setLowStock').value = D.settings.lowStock;
  $('#setAiProvider').value = D.settings.aiProvider || 'demo';
  $('#setAiBaseUrl').value = D.settings.aiBaseUrl || 'https://api.deepseek.com';
  $('#setAiKey').value = D.settings.aiKey || '';
  $('#setAiModel').value = D.settings.aiModel || 'deepseek-chat';
}
function collectSettings(){
  return {
    shopName: $('#setShopName').value.trim() || '收银宝便利店',
    cashier: $('#setCashier').value.trim() || '收银员',
    pointsPerYuan: parseFloat($('#setPointsPerYuan').value) || 0,
    lowStock: parseInt($('#setLowStock').value, 10) || 10,
    aiProvider: $('#setAiProvider').value,
    aiBaseUrl: $('#setAiBaseUrl').value.trim(),
    aiKey: $('#setAiKey').value.trim(),
    aiModel: $('#setAiModel').value.trim()
  };
}
async function saveSettings(){
  try {
    await api('/settings', { method: 'PUT', body: collectSettings() });
    await refresh();
    alert('设置已保存');
  } catch (e){ alert('保存失败：' + e.message); }
}
const AI_PRESETS = {
  deepseek:  { base: 'https://api.deepseek.com', model: 'deepseek-chat' },
  openai:    { base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  dashscope: { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  moonshot:  { base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  ollama:    { base: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  custom:    { base: '', model: '' },
  demo:      { base: '', model: '' }
};
function onAiProviderChange(){
  const p = AI_PRESETS[$('#setAiProvider').value];
  if (p){
    if (p.base) $('#setAiBaseUrl').value = p.base;
    if (p.model) $('#setAiModel').value = p.model;
  }
}
async function testAi(){
  const el = $('#aiTestResult');
  el.style.color = 'var(--muted)';
  el.textContent = '测试中…';
  try {
    if ($('#setAiProvider').value === 'demo'){
      el.style.color = 'var(--warn)';
      el.textContent = 'ℹ️ 演示模式无需密钥，保存后可直接到 AI 助手体验';
      await api('/settings', { method: 'PUT', body: collectSettings() });
      await refresh();
      return;
    }
    await api('/settings', { method: 'PUT', body: collectSettings() });  // 先保存当前填写内容
    await refresh();
    const r = await api('/ai-test', { method: 'POST' });
    el.style.color = 'var(--ok)';
    el.textContent = '✅ 连接成功（' + r.ms + 'ms）' + (r.reply ? ' AI回复：' + r.reply : '');
  } catch (e){
    el.style.color = 'var(--danger)';
    el.textContent = '❌ ' + e.message;
  }
}
function downloadBackup(){
  window.location.href = '/api/backup';
}
async function resetSample(){
  if (!confirm('将用示例数据覆盖当前所有数据，确定？')) return;
  try {
    await api('/reset-sample', { method: 'POST' });
    await refresh(); await switchView('analysis');
  } catch (e){ alert('操作失败：' + e.message); }
}
async function clearData(){
  if (!confirm('确定清空所有数据？此操作不可恢复！')) return;
  try {
    await api('/clear', { method: 'POST' });
    await refresh(); await switchView('analysis');
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
 * AI 助手（电脑端）
 * ============================================================ */
let chatHistory = [];
function renderChat(){
  if (!chatHistory.length){
    chatHistory = [{
      role: 'ai', systemGreeting: true, local: true,
      text: '你好，我是收银宝 AI 经营助手 👋\n\n我可以直接分析当前账本里的营业额、利润、库存、员工、商品、会员和经营风险。常用经营分析无需配置密钥；更自由的问题可以在系统设置中接入大模型。\n\n点击上方快捷按钮，或直接告诉我你想了解什么。',
      suggestions: ['今日经营简报', '分析本月利润', '查看库存补货建议']
    }];
  }
  renderChatMsgs();
}
function renderChatMsgs(){
  $('#chatMsgs').innerHTML = chatHistory.map(m => m.role === 'user'
    ? `<div class="chat-msg user"><div class="bubble">${esc(m.text)}</div></div>`
    : `<div class="chat-msg ai"><div class="bubble">${m.local ? '<span class="local-tag">本地经营分析</span>' : ''}${m.demo ? '<span class="demo-tag">演示模式</span>' : ''}${esc(m.text)}${renderAiMetrics(m.metrics)}${m.table && m.rows && m.rows.length ? renderDetailTable(m.rows) : ''}${m.chart ? `<div class="chart-box"><div class="c-title">${esc(m.chart.title)}</div>${renderChart(m.chart)}</div>` : ''}${m.range && m.range.text ? `<span class="ai-range">数据范围：${esc(m.range.text)}</span>` : ''}${m.sql ? `<span class="sql-note">查询语句：${esc(m.sql)}</span>` : ''}${renderAiFollowups(m.suggestions)}</div></div>`).join('');
  const box = $('#chatMsgs');
  box.scrollTop = box.scrollHeight;
}

function renderAiMetrics(metrics){
  if (!Array.isArray(metrics) || !metrics.length) return '';
  return `<div class="ai-metrics">${metrics.map(m => {
    const tone = ['ok', 'warn', 'danger'].includes(m.tone) ? m.tone : '';
    return `<div class="ai-metric ${tone}"><div class="am-label">${esc(m.label)}</div><div class="am-value" title="${esc(m.value)}">${esc(m.value)}</div>${m.sub ? `<div class="am-sub" title="${esc(m.sub)}">${esc(m.sub)}</div>` : ''}</div>`;
  }).join('')}</div>`;
}

function renderAiFollowups(items){
  if (!Array.isArray(items) || !items.length) return '';
  return `<div class="ai-followups"><span class="follow-label">继续问：</span>${items.slice(0, 4).map(item => `<button type="button" data-ai-question="${esc(item)}" onclick="askAi(this.dataset.aiQuestion)">${esc(item)}</button>`).join('')}</div>`;
}

function askAi(question){
  const input = $('#chatInput');
  if (!input || $('#chatSendBtn').disabled) return;
  input.value = String(question || '');
  sendChat();
}

/* 明细结果渲染为表格（时间/处理人/商品/金额等逐笔列出） */
function renderDetailTable(rows){
  if (!rows || !rows.length) return '';
  const keys = Object.keys(rows[0] || {});
  if (!keys.length) return '';
  const head = keys.map(k => `<th>${esc(k)}</th>`).join('');
  const body = rows.map(r => `<tr>${keys.map(k => {
    let v = r[k];
    if (typeof v === 'number' && v >= 1e11 && v < 1e13) v = fmtDT(v);   // 毫秒时间戳 → 本地时间
    return `<td>${esc(v)}</td>`;
  }).join('')}</tr>`).join('');
  return `<div class="detail-wrap"><table class="tbl detail-tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    <div class="detail-count">共 ${rows.length} 条</div></div>`;
}

/* ---------- 图表渲染（纯 SVG，零依赖） ---------- */
const CHART_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#64748b'];
function fmtNum(n){ return (Math.round(n * 100) / 100).toString().replace(/\.00$/, ''); }
function renderChart(ch){
  if (ch.type === 'bar') return svgBar(ch);
  if (ch.type === 'line') return svgLine(ch);
  if (ch.type === 'pie') return svgPie(ch);
  return '';
}
function svgGrid(W, H, padL, padT, padB, padR){
  let g = '';
  for (let i = 0; i <= 4; i++){
    const gy = H - padB - (i / 4) * (H - padT - padB);
    g += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#e2e8f0" stroke-dasharray="3 3"></line>`;
  }
  return g;
}
function svgBar(c){
  const W = 560, H = 220, padL = 52, padT = 14, padB = 30, padR = 10;
  const n = c.x.length, max = Math.max(...c.y, 1);
  const iw = (W - padL - padR) / n, bw = Math.min(40, iw * 0.6);
  let bars = '';
  c.x.forEach((x, i) => {
    const h = (c.y[i] / max) * (H - padT - padB);
    const bx = padL + i * iw + (iw - bw) / 2, by = H - padB - h;
    bars += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="#3b82f6"></rect>`;
    bars += `<text x="${(bx + bw / 2).toFixed(1)}" y="${(by - 4).toFixed(1)}" text-anchor="middle" font-size="10" fill="#475569">${fmtNum(c.y[i])}</text>`;
    bars += `<text x="${(bx + bw / 2).toFixed(1)}" y="${H - padB + 14}" text-anchor="middle" font-size="9" fill="#94a3b8">${esc(String(x).slice(0, 8))}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:560px">${svgGrid(W, H, padL, padT, padB, padR)}${bars}</svg>`;
}
function svgLine(c){
  const W = 560, H = 220, padL = 48, padT = 14, padB = 30, padR = 10;
  const n = c.x.length, max = Math.max(...c.y, 1);
  const innerW = W - padL - padR;
  const pts = c.y.map((v, i) => ({
    x: padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW),
    y: H - padB - (v / max) * (H - padT - padB)
  }));
  const dots = pts.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="#3b82f6"></circle>`).join('');
  const labels = c.x.map((x, i) => `<text x="${pts[i].x.toFixed(1)}" y="${H - padB + 14}" text-anchor="middle" font-size="9" fill="#94a3b8">${esc(String(x).slice(0, 8))}</text>`).join('');
  const vals = pts.map((p, i) => `<text x="${p.x.toFixed(1)}" y="${(p.y - 7).toFixed(1)}" text-anchor="middle" font-size="10" fill="#475569">${fmtNum(c.y[i])}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:560px">${svgGrid(W, H, padL, padT, padB, padR)}
    <polyline points="${pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="#2563eb" stroke-width="2.5"></polyline>${dots}${vals}${labels}</svg>`;
}
function svgPie(c){
  const cx = 100, cy = 100, R = 80, r = 50;
  const total = c.y.reduce((a, b) => a + b, 0) || 1;
  let ang = -Math.PI / 2, paths = '', legend = '';
  c.y.forEach((v, i) => {
    const frac = v / total;
    const a2 = ang + frac * 2 * Math.PI;
    const large = (a2 - ang) > Math.PI ? 1 : 0;
    const x1 = cx + R * Math.cos(ang), y1 = cy + R * Math.sin(ang);
    const x2 = cx + R * Math.cos(a2), y2 = cy + R * Math.sin(a2);
    const xi1 = cx + r * Math.cos(ang), yi1 = cy + r * Math.sin(ang);
    const xi2 = cx + r * Math.cos(a2), yi2 = cy + r * Math.sin(a2);
    const color = CHART_COLORS[i % CHART_COLORS.length];
    paths += `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} A${R},${R} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} L${xi2.toFixed(1)},${yi2.toFixed(1)} A${r},${r} 0 ${large} 0 ${xi1.toFixed(1)},${yi1.toFixed(1)} Z" fill="${color}"></path>`;
    legend += `<div class="pie-legend"><span class="dot" style="background:${color}"></span>${esc(String(c.x[i]))} <b>${fmtNum(v)}</b>（${(frac * 100).toFixed(1)}%）</div>`;
    ang = a2;
  });
  return `<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
    <svg viewBox="0 0 200 200" width="160" height="160" style="flex-shrink:0">${paths}</svg>
    <div style="min-width:150px">${legend}</div></div>`;
}
async function sendChat(){
  const input = $('#chatInput');
  const msg = input.value.trim();
  if (!msg) return;
  const history = chatHistory
    .filter(m => !m.systemGreeting && (m.role === 'user' || (m.role === 'ai' && m.text && !m.demo)))
    .slice(-6)
    .map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.text }));
  chatHistory.push({ role: 'user', text: msg });
  input.value = '';
  renderChatMsgs();
  const btn = $('#chatSendBtn');
  btn.disabled = true;
  const loadingIdx = chatHistory.length;
  chatHistory.push({ role: 'ai', text: '…思考中，请稍候' });
  renderChatMsgs();
  try {
    const r = await api('/chat', { method: 'POST', body: { message: msg, history } });
    chatHistory[loadingIdx] = {
      role: 'ai', text: r.reply, sql: r.sql || null, demo: !!r.demo, local: !!r.local,
      chart: r.chart || null, rows: r.rows || null, detail: !!r.detail, table: !!r.table,
      metrics: r.metrics || null, suggestions: r.suggestions || null, range: r.range || null
    };
  } catch (e){
    chatHistory[loadingIdx] = { role: 'ai', text: '⚠️ ' + e.message };
  }
  btn.disabled = false;
  renderChatMsgs();
  input.focus();
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
    if (DEVICE === 'mobile' && !D.employee){
      showEmployeeLogin();
      return;
    }
    await switchView('pos');
  } catch (e){
    document.body.innerHTML = `<div style="padding:60px;text-align:center;font-family:sans-serif">
      <h2>⚠️ 无法连接服务器</h2>
      <p style="color:#64748b;margin-top:12px">${esc(e.message)}</p>
      <p style="color:#64748b;margin-top:6px">请确认服务器电脑已启动服务（双击 启动服务.bat），且本机与服务器在同一网络。</p>
    </div>`;
  }
})();
