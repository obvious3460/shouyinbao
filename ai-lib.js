'use strict';
/* ============================================================
 * AI 助手工具库：提示词构建、SQL 提取、安全校验、只读执行
 * 安全设计（双重保险）：
 *   1. sanitizeSql 白名单：仅允许单条 SELECT，禁止一切写语句
 *   2. 由调用方传入只读数据库连接（readOnly），即使 SQL 异常也无法写库
 * ============================================================ */

function buildSystemPrompt(){
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  const curDate = `${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())}`;
  const curYear = now.getFullYear();
  return `你是「收银宝」店铺管理系统的 AI 数据助手。数据库是 SQLite，有以下表：
- sales 销售单：no(单号), time(时间戳,毫秒), subtotal(小计), manual_discount_amt(整单折扣), vip_discount(VIP折扣), points_value(积分抵扣), payable(实收金额), pay_method(支付方式), cashier(收银员), member_id, member_name, member_level, points_earned(本次获得积分)
- sale_items 销售明细：sale_id(所属销售单id), name(商品名), category(分类), price(单价), cost(成本价), qty(数量)
- products 商品：name, category, price(售价), cost(成本价), stock(库存), unit(单位)
- members 会员：name, phone, level_id, points(积分), created_at(注册时间,毫秒)
- levels 会员等级：id, name, rate(折扣率,如0.95)
- expenses 出账：time(时间戳,毫秒), category(类别), amount(金额), note(备注)
- stock_moves 出入库：time(时间戳,毫秒), product_id, type(in=入库/out=出库), qty, note

注意：
0. 当前系统日期是 ${curDate}，当前年份是 ${curYear} 年。用户提到"7月/本月/上周"等未写明具体年份的日期时，一律按 ${curYear} 年理解。
1. time 是毫秒时间戳。换算本地日期用 date(time/1000,'unixepoch','localtime')，月份用 strftime('%Y-%m',time/1000,'unixepoch','localtime')，今天用 date('now','localtime')。
2. 如果用户问题需要查数据，请输出 SQL 代码块，格式：\`\`\`sql\nSELECT ...\n\`\`\`。只允许 SELECT 查询，禁止任何修改数据的语句。默认对结果排序、限制条数。
3. 不需要查数据时，直接用简体中文回答。
4. 金额默认是人民币元。回答用简体中文，尽量简洁、有结论。`;
}

/* 从模型输出中提取 SQL 语句；没有则返回 null */
function extractSql(content){
  if (!content) return null;
  const c = String(content);
  // 1) JSON 形式 {"sql": "..."}
  try {
    const obj = JSON.parse(c);
    if (obj && typeof obj.sql === 'string' && obj.sql.trim()) return obj.sql.trim();
  } catch (e) { /* 不是 JSON，继续 */ }
  // 2) ```sql ... ``` 代码块
  const m = c.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (m && m[1] && m[1].trim()) return m[1].trim();
  // 3) 从行首开始的 SELECT/WITH 语句（取到第一个分号为止，避免抓到正文里的"SELECT"字样）
  const s = c.match(/(?:^|\n)\s*(SELECT|WITH)\b[\s\S]*/i);
  if (s){
    const t = s[0].split(';')[0].trim();
    if (t) return t;
  }
  return null;
}

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|reindex|begin|commit|rollback|savepoint|release|replace|truncate|grant|revoke|exec|execute|load_extension)\b/i;

/* 校验并规整 SQL：仅单条 SELECT/WITH 查询，禁止写语句与注释注入 */
function sanitizeSql(sql){
  if (!sql) return null;
  let s = String(sql).trim();
  // 去掉开头的注释行（模型常在 SQL 前加 -- 说明）
  s = s.replace(/^(?:--[^\n]*(?:\n|$)|[ \t]*\/\*[\s\S]*?\*\/[ \t]*(?:\n|$))+/, '').trim();
  // 只取第一条语句（以"分号+换行/结尾"为界，容忍模型输出多条）
  s = s.split(/;\s*(?:\n|$)/)[0].trim().replace(/;+\s*$/, '');
  // 去掉尾部注释
  s = s.replace(/\s*(?:--[^\n]*|\/\*[\s\S]*?\*\/)\s*$/, '').trim();
  if (!/^(select|with)\b/i.test(s)) throw new Error('只允许 SELECT 查询语句（收到开头：' + s.slice(0, 40) + '…）');
  if (FORBIDDEN.test(s)) throw new Error('语句中包含不允许的操作（仅支持查询）');
  if (!/\blimit\b/i.test(s)) s += ' LIMIT 200';
  return s;
}

/* 在只读连接上执行，返回最多 200 行 */
function execAiSql(dbRO, sql){
  const safe = sanitizeSql(sql);
  const rows = dbRO.prepare(safe).all();
  return rows.slice(0, 200);
}

/* ---------- 图表 ---------- */
const CHART_TYPES = ['bar', 'line', 'pie'];

/* 意图识别：判断用户是要"汇总图表"还是"逐笔明细"
 * 返回 'force'（强制出图）/ 'text'（明细，不出图）/ 'auto'（交给模型判断）
 * 优先级：明确要图 > 要明细 > 汇总类词（账单/趋势/占比/排行等） */
function detectChartIntent(msg){
  const m = String(msg || '');
  if (/图表|画图|画个图|生成图|做个图|用图|图看看|图吧|图展示/.test(m)) return 'force';
  if (/明细|每笔|逐笔|具体记录|清单|列表|全部记录|每一笔|记账明细/.test(m)) return 'text';
  if (/查看账单|看账单|账单|汇总|总览|概况|趋势|对比|占比|排行|统计|分析/.test(m)) return 'force';
  return 'auto';
}

/* 兜底：模型未出图时，根据查询结果自动生成图表（标签+数值两列 → bar/line） */
function autoChart(rows){
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 40) return null;
  const keys = Object.keys(rows[0] || {});
  if (keys.length < 2) return null;
  const labelKey = keys[0];
  const valueKey = keys[keys.length - 1];
  const x = [], y = [];
  for (const r of rows){
    const v = parseFloat(r[valueKey]);
    if (isNaN(v)) return null;
    x.push(String(r[labelKey]));
    y.push(Math.round(v * 100) / 100);
  }
  const isDate = x.every(s => /^\d{4}-\d{2}(-\d{2})?$/.test(s));   // 标签像日期 → 折线图
  return { type: isDate ? 'line' : 'bar', title: '查询结果图表', x, y };
}

/* 校验并规整图表规格；非法返回 null */
function validChart(ch){
  if (!ch || typeof ch !== 'object') return null;
  if (!CHART_TYPES.includes(ch.type)) return null;
  if (!Array.isArray(ch.x) || !Array.isArray(ch.y)) return null;
  if (ch.x.length === 0 || ch.x.length > 40 || ch.x.length !== ch.y.length) return null;
  const y = ch.y.map(v => { const n = parseFloat(v); return isNaN(n) ? null : Math.round(n * 100) / 100; });
  if (y.some(v => v === null)) return null;
  return { type: ch.type, title: String(ch.title || '').slice(0, 50), x: ch.x.map(String).slice(0, 40), y };
}

/* 从模型输出中解析 {answer, chart}；解析失败时把原文当回答 */
function parseChartContent(content){
  const c = String(content || '').trim();
  let obj = null;
  try { obj = JSON.parse(c); } catch (e) { /* 继续 */ }
  if (!obj){
    const m = c.match(/\{[\s\S]*\}/);   // 取第一个花括号块
    if (m){ try { obj = JSON.parse(m[0]); } catch (e2) { /* 继续 */ } }
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)){
    return { answer: typeof obj.answer === 'string' && obj.answer.trim() ? obj.answer.trim() : c, chart: validChart(obj.chart) };
  }
  return { answer: c, chart: null };
}

module.exports = { buildSystemPrompt, extractSql, sanitizeSql, execAiSql, parseChartContent, validChart, autoChart, detectChartIntent };
