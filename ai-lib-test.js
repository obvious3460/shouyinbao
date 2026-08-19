'use strict';
/* ai-lib 单元测试：SQL 提取 / 安全过滤 / 只读执行 */
const { DatabaseSync } = require('node:sqlite');
const { buildSystemPrompt, extractSql, sanitizeSql, execAiSql, parseChartContent, validChart, autoChart, detectChartIntent } = require('./ai-lib.js');

let pass = 0, fail = 0;
function check(name, cond, extra){
  if (cond){ pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
function throws(fn){
  try { fn(); return false; } catch (e) { return true; }
}

// --- extractSql ---
check('提取 JSON 形式SQL', extractSql('{"sql":"SELECT 1"}') === 'SELECT 1');
check('提取代码块SQL', extractSql('我来查一下：\n```sql\nSELECT name FROM products\n```') === 'SELECT name FROM products');
check('提取直接SELECT', extractSql('SELECT * FROM sales WHERE id=1; 以上就是') === 'SELECT * FROM sales WHERE id=1');
check('无SQL返回null', extractSql('今天天气不错，直接回答') === null);
check('空内容返回null', extractSql('') === null);

// --- sanitizeSql ---
check('合法SELECT通过', sanitizeSql('SELECT * FROM products') === 'SELECT * FROM products LIMIT 200');
check('已有LIMIT不追加', sanitizeSql('SELECT * FROM products LIMIT 5') === 'SELECT * FROM products LIMIT 5');
check('拒绝UPDATE', throws(() => sanitizeSql('UPDATE products SET price=0')));
check('拒绝DELETE', throws(() => sanitizeSql('DELETE FROM sales')));
check('拒绝DROP', throws(() => sanitizeSql('SELECT * FROM sales; DROP TABLE sales')));
check('拒绝INSERT', throws(() => sanitizeSql('INSERT INTO sales VALUES(1)')));
check('拒绝PRAGMA', throws(() => sanitizeSql('PRAGMA user_version')));
check('拒绝注释注入', throws(() => sanitizeSql('/*x*/ SELECT 1')));
check('多语句取第一条', sanitizeSql('SELECT 1;\nSELECT 2') === 'SELECT 1 LIMIT 200');
check('尾部注释被清理', sanitizeSql('SELECT * FROM sales -- 查销售') === 'SELECT * FROM sales LIMIT 200');
check('拒绝非SELECT', throws(() => sanitizeSql('SHOW TABLES')));

// --- execAiSql（含只读连接，模拟生产环境双重安全）---
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = path.join(os.tmpdir(), 'ailib_test_' + Date.now() + '.db');
const db = new DatabaseSync(tmp);
db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t(name) VALUES (\'a\'),(\'b\'),(\'c\')');
db.close();
const dbRO = new DatabaseSync(tmp, { readOnly: true });   // 生产环境 AI 查询用的就是这种只读连接
const rows = execAiSql(dbRO, 'SELECT * FROM t ORDER BY id');
check('只读执行返回行数', rows.length === 3);
check('只读执行字段正确', rows[0].name === 'a');
check('写语句被sanitize拒绝', throws(() => execAiSql(dbRO, "DELETE FROM t")));
check('只读连接拒绝写库(DB级)', throws(() => dbRO.prepare("INSERT INTO t(name) VALUES('x')").run()));
dbRO.close();
fs.unlinkSync(tmp);

// --- extractSql / sanitizeSql 回归（修复：注释行、WITH 子句、正文误抓）---
check('提取带注释开头的SQL(从SELECT行开始)', extractSql('我查一下：\n-- 统计7月营业额\nSELECT SUM(payable) FROM sales') === 'SELECT SUM(payable) FROM sales');
check('注释开头可通过校验', sanitizeSql('-- 统计\nSELECT * FROM sales').startsWith('SELECT'));
check('WITH CTE 查询通过', sanitizeSql('WITH t AS (SELECT 1 AS a) SELECT * FROM t') === 'WITH t AS (SELECT 1 AS a) SELECT * FROM t LIMIT 200');
check('WITH+DML 被拒绝', throws(() => sanitizeSql('WITH t AS (SELECT 1 AS a) DELETE FROM t')));
check('正文SELECT字样不误抓', extractSql('请用 SELECT 语句查询数据，结果如下：营业额是100元') === null);
check('代码块优先于正文', extractSql('说明：用SELECT查询。\n```sql\nSELECT name FROM products\n```') === 'SELECT name FROM products');
check('错误信息含开头预览', throws(() => sanitizeSql('UPDATE products SET price=0')) && (() => { try { sanitizeSql('UPDATE x'); return false; } catch (e) { return e.message.includes('收到开头'); } })());

// --- 系统提示词 ---
const sys = buildSystemPrompt();
check('系统提示词含表说明', sys.includes('sales') && sys.includes('members') && sys.includes('expenses'));
check('系统提示词中文', sys.includes('人民币') || sys.includes('中文'));

// --- 图表解析与校验 ---
const good = parseChartContent('{"answer":"7月营业额9457元","chart":{"type":"bar","title":"月度营业额","x":["7月","8月"],"y":[9456.92,5838.22]}}');
check('解析JSON含图表', good.chart && good.chart.type === 'bar' && good.chart.x.length === 2, JSON.stringify(good.chart));
check('解析JSON含回答', good.answer.includes('9457'));
const embedded = parseChartContent('回答如下：\n{"answer":"支付方式分布","chart":{"type":"pie","title":"占比","x":["微信","现金"],"y":[100,50]}}\n以上完毕');
check('解析嵌入JSON', embedded.chart && embedded.chart.type === 'pie' && embedded.chart.y[1] === 50);
const none = parseChartContent('{"answer":"今日无销售"}');
check('chart为null时回答保留', none.chart === null && none.answer.includes('今日无销售'));
const plain = parseChartContent('直接回答，没有图表');
check('非JSON回退原文', plain.answer === '直接回答，没有图表' && plain.chart === null);
check('图表校验-类型非法', validChart({ type: 'radar', x: ['a'], y: [1] }) === null);
check('图表校验-长度不符', validChart({ type: 'bar', x: ['a', 'b'], y: [1] }) === null);
check('图表校验-空数组', validChart({ type: 'bar', x: [], y: [] }) === null);
check('图表校验-超40点', validChart({ type: 'bar', x: Array(41).fill('a'), y: Array(41).fill(1) }) === null);
check('图表校验-数值规整', validChart({ type: 'line', x: ['a'], y: ['1.23456'] }).y[0] === 1.23);
check('图表校验-非法数值', validChart({ type: 'line', x: ['a'], y: ['abc'] }) === null);
check('图表校验-合法通过', validChart({ type: 'bar', title: 't', x: ['a', 'b'], y: [1, 2] }).type === 'bar');

// --- autoChart 兜底生成 ---
const ac1 = autoChart([{ 日期: '2026-07-01', 营业额: 100 }, { 日期: '2026-07-02', 营业额: 150 }, { 日期: '2026-07-03', 营业额: 120 }]);
check('日期型自动生成折线图', ac1 && ac1.type === 'line' && ac1.x.length === 3 && ac1.y[1] === 150, JSON.stringify(ac1));
const ac2 = autoChart([{ 商品: '可乐', 销售额: 330 }, { 商品: '薯片', 销售额: 552 }]);
check('排行型自动生成柱状图', ac2 && ac2.type === 'bar' && ac2.x[0] === '可乐');
check('单行不生成图表', autoChart([{ a: 1, b: 2 }]) === null);
check('非数值不生成图表', autoChart([{ a: 'x', b: 'y' }, { a: 'z', b: 'w' }]) === null);
check('超过40行不生成图表', autoChart(Array(41).fill({ a: 'x', b: 1 })) === null);
check('31天数据可生成图表', autoChart(Array(31).fill({ 日期: '2026-07-01', 营业额: 100 })) !== null);

// --- 意图识别 detectChartIntent ---
check('「查看账单」→force', detectChartIntent('查看账单') === 'force');
check('「看账单」→force', detectChartIntent('看账单') === 'force');
check('「画个图表」→force', detectChartIntent('画个图表看看营业额') === 'force');
check('「占比」→force', detectChartIntent('支付方式占比') === 'force');
check('「趋势」→force', detectChartIntent('近30天消费趋势') === 'force');
check('「汇总」→force', detectChartIntent('汇总一下7月') === 'force');
check('「查看账单明细」→text(明细优先)', detectChartIntent('查看账单明细') === 'text');
check('「每笔消费」→text', detectChartIntent('张三每笔消费记录') === 'text');
check('「清单」→text', detectChartIntent('列出消费清单') === 'text');
check('「张三的消费记录」→auto', detectChartIntent('张三的消费记录') === 'auto');
check('「员工销售情况」→auto', detectChartIntent('每个员工的销售情况') === 'auto');
check('空输入→auto', detectChartIntent('') === 'auto');

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail ? 1 : 0;
