'use strict';
const { detectBusinessIntent, resolveDateRange, rangeText } = require('./business-ai.js');

let pass = 0, fail = 0;
function check(name, condition, detail){
  if (condition){ pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

const now = new Date(2026, 8, 20, 15, 30).getTime();

check('识别经营简报', detectBusinessIntent('今日经营简报') === 'brief');
check('识别利润分析', detectBusinessIntent('本月赚了多少钱') === 'profit');
check('识别库存补货', detectBusinessIntent('哪些商品需要补货') === 'inventory');
check('库存明细仍走库存分析', detectBusinessIntent('查看库存明细') === 'inventory');
check('识别员工业绩', detectBusinessIntent('本月员工业绩排行') === 'employee');
check('识别商品排行', detectBusinessIntent('哪些商品毛利最高') === 'product');
check('识别会员复购', detectBusinessIntent('分析会员复购') === 'member');
check('识别支付占比', detectBusinessIntent('微信支付宝支付方式占比') === 'payment');
check('识别风险诊断', detectBusinessIntent('检查经营风险') === 'risk');
check('交易明细交给明细分析', detectBusinessIntent('查看张三消费记录') === null);
check('未知问题交给通用AI', detectBusinessIntent('帮我写一句欢迎语') === null);

const today = resolveDateRange('今天营业额', now, 'month');
check('今天范围', today.fromText === '2026-09-20' && today.toText === '2026-09-20', JSON.stringify(today));
const yesterday = resolveDateRange('昨天营业额', now, 'month');
check('昨天范围', yesterday.fromText === '2026-09-19' && yesterday.toText === '2026-09-19');
const week = resolveDateRange('本周销售', now, 'month');
check('本周从周一开始', week.fromText === '2026-09-14' && week.toText === '2026-09-20', rangeText(week));
const lastWeek = resolveDateRange('上周销售', now, 'month');
check('上周完整七天', lastWeek.fromText === '2026-09-07' && lastWeek.toText === '2026-09-13', rangeText(lastWeek));
const month = resolveDateRange('本月利润', now, 'today');
check('本月截至今天', month.fromText === '2026-09-01' && month.toText === '2026-09-20', rangeText(month));
const lastMonth = resolveDateRange('上个月利润', now, 'today');
check('上月完整月份', lastMonth.fromText === '2026-08-01' && lastMonth.toText === '2026-08-31', rangeText(lastMonth));
const recent = resolveDateRange('最近30天趋势', now, 'today');
check('最近30天', recent.fromText === '2026-08-22' && recent.toText === '2026-09-20', rangeText(recent));
const explicitMonth = resolveDateRange('查看2025年7月账单', now, 'today');
check('指定年月', explicitMonth.fromText === '2025-07-01' && explicitMonth.toText === '2025-07-31', rangeText(explicitMonth));
const explicitDay = resolveDateRange('查看2026-09-02流水', now, 'month');
check('指定日期', explicitDay.fromText === '2026-09-02' && explicitDay.toText === '2026-09-02', rangeText(explicitDay));
check('上期范围长度相同', today.previousTo - today.previousFrom === today.to - today.from);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail ? 1 : 0;
