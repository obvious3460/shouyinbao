'use strict';
/* ============================================================
 * 收银业务 AI：意图识别与日期范围解析
 *
 * 常见经营问题优先走本地、可审计的统计逻辑，不依赖大模型猜 SQL。
 * 本文件保持纯函数，方便单元测试；实际数据库查询由 server.js 完成。
 * ============================================================ */

function pad(n){ return String(n).padStart(2, '0'); }
function fmtDate(ts){
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function startOfDay(value){
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function endOfDay(value){
  const d = new Date(value);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}
function makeRange(from, to, label){
  const start = startOfDay(from);
  const end = endOfDay(to);
  const duration = end - start + 1;
  return {
    from: start,
    to: end,
    fromText: fmtDate(start),
    toText: fmtDate(end),
    label,
    previousFrom: start - duration,
    previousTo: start - 1
  };
}

/* 返回最贴近收银经营场景的固定意图；null 表示交给通用 AI。 */
function detectBusinessIntent(message){
  const m = String(message || '').trim();
  if (!m) return null;
  if (/风险|异常|诊断|经营建议|优化建议|有什么问题|注意什么/.test(m)) return 'risk';
  if (/经营简报|营业简报|今日简报|经营概况|经营情况|今天怎么样|店里怎么样|生意怎么样/.test(m)) return 'brief';
  if (/库存|缺货|断货|补货|滞销|周转|积压|库存预警/.test(m)) return 'inventory';
  if (/明细|每笔|逐笔|具体记录|消费记录|交易记录|清单|流水/.test(m)) return null;
  if (/员工|店员|收银员|营业员|员工业绩|谁卖/.test(m)) return 'employee';
  if (/会员|顾客|客户|复购|回头客|消费人群/.test(m)) return 'member';
  if (/支付方式|微信|支付宝|现金.*占比|收款.*占比/.test(m)) return 'payment';
  if (/商品|单品|品类|分类|热销|畅销|销量|卖得最|销售排行/.test(m)) return 'product';
  if (/利润|毛利|净利|盈利|亏损|成本|支出|费用|赚了|赚多少/.test(m)) return 'profit';
  if (/营业额|销售额|收入|订单|客单价|销售趋势|业绩|账单|汇总|统计|分析/.test(m)) return 'overview';
  return null;
}

/*
 * 解析常见中文日期：今天/昨天、本周/上周、本月/上月、近 N 天、
 * YYYY-MM-DD、YYYY年M月、M月。未说明时由调用方传入默认范围类型。
 */
function resolveDateRange(message, nowValue, defaultType){
  const m = String(message || '');
  const now = new Date(nowValue == null ? Date.now() : nowValue);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let hit = m.match(/(\d{4})[年\-/](\d{1,2})[月\-/](\d{1,2})日?/);
  if (hit){
    const d = new Date(Number(hit[1]), Number(hit[2]) - 1, Number(hit[3]));
    if (!isNaN(d.getTime())) return makeRange(d, d, fmtDate(d.getTime()));
  }

  hit = m.match(/(?:(\d{4})年)?(\d{1,2})月/);
  if (hit){
    const year = hit[1] ? Number(hit[1]) : now.getFullYear();
    const month = Number(hit[2]);
    if (month >= 1 && month <= 12){
      const from = new Date(year, month - 1, 1);
      const to = new Date(year, month, 0);
      return makeRange(from, to, `${year}年${month}月`);
    }
  }

  hit = m.match(/(?:最近|近)(\d{1,3})天/);
  if (hit){
    const days = Math.max(1, Math.min(90, Number(hit[1])));
    const from = new Date(today); from.setDate(from.getDate() - days + 1);
    return makeRange(from, today, `近${days}天`);
  }

  if (/前天/.test(m)){
    const d = new Date(today); d.setDate(d.getDate() - 2);
    return makeRange(d, d, '前天');
  }
  if (/昨天|昨日/.test(m)){
    const d = new Date(today); d.setDate(d.getDate() - 1);
    return makeRange(d, d, '昨天');
  }
  if (/今天|今日/.test(m)) return makeRange(today, today, '今天');

  const mondayOffset = (today.getDay() + 6) % 7;
  if (/上周|上星期/.test(m)){
    const to = new Date(today); to.setDate(to.getDate() - mondayOffset - 1);
    const from = new Date(to); from.setDate(from.getDate() - 6);
    return makeRange(from, to, '上周');
  }
  if (/本周|这周|本星期|这星期/.test(m)){
    const from = new Date(today); from.setDate(from.getDate() - mondayOffset);
    return makeRange(from, today, '本周');
  }
  if (/上月|上个月/.test(m)){
    return makeRange(new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 0), '上月');
  }
  if (/本月|这个月|当月/.test(m)){
    return makeRange(new Date(now.getFullYear(), now.getMonth(), 1), today, '本月');
  }

  if (defaultType === 'today') return makeRange(today, today, '今天');
  if (defaultType === '7days'){
    const from = new Date(today); from.setDate(from.getDate() - 6);
    return makeRange(from, today, '近7天');
  }
  if (defaultType === '30days'){
    const from = new Date(today); from.setDate(from.getDate() - 29);
    return makeRange(from, today, '近30天');
  }
  return makeRange(new Date(now.getFullYear(), now.getMonth(), 1), today, '本月');
}

function rangeText(range){
  return range.fromText === range.toText ? range.fromText : `${range.fromText} 至 ${range.toText}`;
}

module.exports = { detectBusinessIntent, resolveDateRange, rangeText, fmtDate };
