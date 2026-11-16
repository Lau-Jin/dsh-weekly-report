/**
 * 周期计算（对应 gen_weekly_text.py 的 current_week / weeks_in_range /
 * month_range / last_month_range）。
 * 语义：--week current = 本周一~本周日；区间按自然周拆，每段裁剪到区间内。
 */
import { addDays, isoDate, makeDate, todayCn } from './util.mjs';

/** 本周一 ~ 本周日 */
export function currentWeek(today = todayCn()) {
  const offset = (today.getDay() + 6) % 7; // 周一=0
  const monday = addDays(today, -offset);
  return [monday, addDays(monday, 6)];
}

/** [start, end] 拆成若干自然周（周一~周日），每段裁剪到区间内 */
/**
 * 把区间拆成**完整的自然周**（周一 ~ 周日），不裁剪到区间边界。
 *
 * 例：区间 10/1 ~ 10/31 → 9/28~10/4、10/5~10/11、10/12~10/18、10/19~10/25、10/26~11/1
 * （跨月的周照样按完整周一~周日生成，属于哪个月由「周与该月有交集」判断）
 */
export function weeksInRange(start, end) {
  let s = start;
  let e = end;
  if (e < s) [s, e] = [e, s];
  const out = [];
  const offset = (s.getDay() + 6) % 7;          // 周一=0
  let cur = addDays(s, -offset);                // 区间首日所在周的周一
  const lastOffset = (e.getDay() + 6) % 7;
  const last = addDays(e, 6 - lastOffset);      // 区间末日所在周的周日
  while (cur <= last) {
    out.push([cur, addDays(cur, 6)]);
    cur = addDays(cur, 7);
  }
  return out;
}

/** 整月：1 日 ~ 最后一天 */
export function monthRange(year, month) {
  const first = makeDate(year, month, 1);
  const lastDay = new Date(year, month, 0).getDate();
  return [first, makeDate(year, month, lastDay)];
}

/** 上个月 */
export function lastMonthRange(today = todayCn()) {
  const y = today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear();
  const m = today.getMonth() === 0 ? 12 : today.getMonth();
  return monthRange(y, m);
}

/** 月份键 'YYYY-MM' → [year, month] */
export function parseMonth(text) {
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(text || '').trim());
  if (!m) throw new Error('月份格式应为 YYYY-MM');
  return [Number(m[1]), Number(m[2])];
}

export { isoDate };
