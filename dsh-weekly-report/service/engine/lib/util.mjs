/**
 * 周报引擎 · 基础工具（Node 版，对应 gen_weekly_text.py 的「基础工具」段）
 *
 * 移植原则：输出逐字节对齐 Python 版。
 *   · 日期一律用「本地日期」语义（Python 的 date），这里用 Date 表示某一天的 00:00 本地时间。
 *   · 相似度必须与 Python difflib.SequenceMatcher(...).ratio() 一致（阈值 0.85 是判重口径）。
 *
 * 这个文件被很多模块引用：只加不改，改行为要同步 Python 对照 + 测试。
 */

/** 日期（本地 00:00）→ 'YYYY-MM-DD' */
export function isoDate(d) {
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 'YYYY-MM-DD' / 'YYYY/MM/DD' / 'YYYY年MM月DD日' / 'YYYY.MM.DD' → Date | null（对应 to_date） */
export function toDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return startOfDay(v);
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (!m) m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(s);
  if (!m) m = /^(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(s);
  if (!m) m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})/.exec(s);
  if (!m) return null;
  return makeDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** 构造本地日期（月/日按 1 起） */
export function makeDate(y, m, d) {
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function today() {
  return startOfDay(new Date());
}

/** 加天数（不依赖 DST 之外的时区细节，按本地日期推进） */
export function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/**
 * 某一天所在自然周的周日（周一为一周起点）。
 * 周报口径：本周内未完成的事项，结束时间一律取「本周周日」，不往后拖到下个月。
 */
export function weekEndOf(d) {
  if (!d) return null;
  const offset = (d.getDay() + 6) % 7; // 周一=0 … 周日=6
  return addDays(d, 6 - offset);
}

/** 某一天所在自然周的周一 */
export function weekStartOf(d) {
  if (!d) return null;
  const offset = (d.getDay() + 6) % 7;
  return addDays(d, -offset);
}

export function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
}

export function minDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a <= b ? a : b;
}

export function maxDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a >= b ? a : b;
}

/** '2026年11月10日'（对应 fmt_date） */
export function fmtDate(d) {
  if (!d) return '';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 周期显示（对应 fmt_range）：同年同月省略重复部分 */
export function fmtRange(start, end) {
  if (!start) return '';
  if (!end) return fmtDate(start);
  if (isoDate(start) === isoDate(end)) return fmtDate(start);
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    return `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日-${end.getDate()}日`;
  }
  if (start.getFullYear() === end.getFullYear()) {
    return `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日-${end.getMonth() + 1}月${end.getDate()}日`;
  }
  return `${fmtDate(start)}-${fmtDate(end)}`;
}

/** 相对路径按脚本目录解析（对应 _abs）；~ 与 %VAR% 展开 */
export function absPath(p, baseDir) {
  if (!p) return p;
  let s = String(p).replace(/%([^%]+)%/g, (m0, name) => process.env[name] ?? m0);
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    s = (process.env.USERPROFILE || process.env.HOME || '') + s.slice(1);
  }
  return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('/') ? s : joinPath(baseDir, s);
}

/** 简易 join（避免依赖 path 语义差异，统一用 Windows 分隔符落盘） */
export function joinPath(...parts) {
  const segs = [];
  for (const raw of parts) {
    if (!raw) continue;
    const s = String(raw).replace(/[\\/]+/g, '\\');
    if (!segs.length) segs.push(s.replace(/\\+$/, ''));
    else segs.push(s.replace(/^\\+/, '').replace(/\\+$/, ''));
  }
  return segs.join('\\');
}

/** 标题里又带一遍校名时去掉（对应 strip_school_prefix） */
export function stripSchoolPrefix(school, title) {
  const s = String(school || '').trim();
  const x = String(title || '').trim();
  if (!s || !x) return x;
  if (!x.startsWith(s)) return x;
  const rest = x.slice(s.length).replace(/^[\s　\-—:：、,，]+/, '');
  return rest || x;
}

/** 从描述里猜学校名（对应 split_school） */
export function splitSchool(desc) {
  if (!desc) return '';
  const text = String(desc).trim();
  let cut = text.length;
  for (const sep of ['（', '(']) {
    const i = text.indexOf(sep);
    if (i !== -1) cut = Math.min(cut, i);
  }
  const head = text.slice(0, cut);
  for (const suffix of ['学院', '大学', '学校', '中学', '职院', '书院']) {
    const idx = head.indexOf(suffix);
    if (idx >= 2 && idx <= 30) return head.slice(0, idx + suffix.length);
  }
  return '';
}

/**
 * 标题里没有校名时，取第一个空格前的短语当项目名。
 * 「演示环境 泛微_流程引擎E9 V10.82 部署更新」→「演示环境」。
 * 只接受含中文/字母、长度 2~24 的片段，避免把版本号、纯数字误当项目。
 */
export function guessProject(title, fallback = '') {
  const text = String(title || '').trim();
  if (!text) return fallback;
  const head = text.split(/[\s\u3000]+/)[0] || '';
  const clean = head.replace(/^[\[\]【】（）()·、,，:：\-—]+/g, '')
    .replace(/[\[\]【】（）()·、,，:：\-—]+$/g, '');
  if (clean.length >= 2 && clean.length <= 24 && /[\u4e00-\u9fa5A-Za-z]/.test(clean)) return clean;
  return fallback;
}

/**
 * 统一的「学校 / 项目」兜底。周报模板里 {{school}} 若为空会渲染出块内空行，
 * 而块之间也用空行分隔，一条记录就会被切成两段（历史文件里踩到过）。
 * 因此这里保证永远返回非空值：原始校名 → 标题推断校名 → 产品名 → 标题首段 → 通用名。
 */
export function resolveSchool(rawSchool, title, product = '', fallback = '通用事项') {
  const s = String(rawSchool || '').trim();
  if (s) return s;
  const t = String(title || '').trim();
  const p = String(product || '').trim();
  return splitSchool(t) || p || guessProject(t) || fallback;
}

const PUNCT_RE = /[\s，。、；：！？,.;:!?（）()\[\]【】《》<>"'“”‘’\-—_/\\|]+/g;

/** 归一化：去标点、去空白、转小写（对应 norm） */
export function norm(text) {
  if (!text) return '';
  return String(text).replace(PUNCT_RE, '').toLowerCase();
}

/**
 * Python difflib.SequenceMatcher(None, a, b).ratio() 的等价实现。
 * ratio = 2 * M / T，M = 递归最长匹配块长度之和（Ratcliff/Obershelp）。
 */
export function sequenceRatio(a, b) {
  if (!a && !b) return 1;
  const total = a.length + b.length;
  if (!total) return 1;
  return (2 * matchedChars(a, b)) / total;
}

/** difflib 的 b2j/junk 语义接近默认（无 junk 字母，autojunk 对短串无影响） */
function matchedChars(a, b) {
  let total = 0;
  const stack = [[0, a.length, 0, b.length]];
  while (stack.length) {
    let [alo, ahi, blo, bhi] = stack.pop();
    const m = longestMatch(a, b, alo, ahi, blo, bhi);
    if (!m) continue;
    const [i, j, size] = m;
    total += size;
    if (alo < i && blo < j) stack.push([alo, i, blo, j]);
    if (i + size < ahi && j + size < bhi) stack.push([i + size, ahi, j + size, bhi]);
  }
  return total;
}

function longestMatch(a, b, alo, ahi, blo, bhi) {
  let best = null;
  const b2j = buildB2J(b, blo, bhi);
  let j2len = new Map();
  for (let i = alo; i < ahi; i += 1) {
    const next = new Map();
    const ch = a[i];
    for (const j of b2j.get(ch) || []) {
      const k = j2len.get(j - 1) || 0;
      const len = k + 1;
      next.set(j, len);
      if (!best || len > best[2]) best = [i - len + 1, j - len + 1, len];
    }
    j2len = next;
  }
  return best;
}

function buildB2J(b, lo, hi) {
  const map = new Map();
  for (let j = lo; j < hi; j += 1) {
    const ch = b[j];
    let arr = map.get(ch);
    if (!arr) map.set(ch, (arr = []));
    arr.push(j);
  }
  return map;
}

/** 相似度（对应 similarity） */
export function similarity(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.95;
  return sequenceRatio(na, nb);
}

/** 未完成事项的进度参考（关键词 → 参考百分比 + 合并方式） */
export const PROGRESS_HINTS = [
  [['未开始', '待安排', '待排期', '计划中', '未启动', '待启动'], 15, 'min'],
  [['排查', '分析', '定位', '沟通', '对接', '确认中', '核实'], 45, 'around'],
  [['处理中', '修复中', '部署中', '配置中', '开发中', '联调', '实施', '整改'], 65, 'around'],
  [['待验证', '待确认', '待审核', '待验收', '测试中', '待反馈', '已提交'], 85, 'max'],
];

/** 进度判定（对应 progress_for）：完成=是 → 100%，否则按时间进度 + 关键词，5%~90% */
export function progressFor(done, start, end, reference, task = '') {
  if (String(done).trim() === '是') return '100%';
  let ratio = 0.5;
  if (start && end && end > start) {
    const span = Math.max(daysBetween(start, end), 1);
    const elapsed = daysBetween(start, reference);
    ratio = Math.max(0, Math.min(1, elapsed / span));
  }
  const timePct = 10 + 80 * ratio;
  let contentPct = null;
  let mode = 'around';
  const text = task || '';
  for (const [kws, pct, m] of PROGRESS_HINTS) {
    if (kws.some((k) => text.includes(k))) {
      contentPct = pct;
      mode = m;
      break;
    }
  }
  let pct;
  if (contentPct === null) pct = timePct;
  else if (mode === 'min') pct = Math.min(timePct, contentPct);
  else if (mode === 'max') pct = Math.max(timePct, contentPct);
  else pct = (timePct + contentPct) / 2;
  if (end && reference && reference > end) pct = Math.min(pct, 80);
  // Python round() 是银行家舍入；这里用 Math.round 后再修正 .5 的偶舍入差异
  return `${Math.max(5, Math.min(90, pyRound(pct)))}%`;
}

/** Python 3 的 round()（银行家舍入，四舍六入五取偶） */
export function pyRound(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (Math.abs(diff - 0.5) < 1e-9) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(x);
}

/** 解析 '1,234' / '82%' / 数字 等（对应 _as_int） */
export function asInt(v, dflt = 0) {
  if (v === null || v === undefined || v === '') return dflt;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : dflt;
  const m = /-?\d+/.exec(String(v).replace(/,/g, ''));
  return m ? Number(m[0]) : dflt;
}

/** 取第一个命中的键（对应 _pick） */
export function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return '';
}

/**
 * 北京时间「今天」（对应 Python 的 _today_cn：UTC+8）。
 * 引擎跑在用户本机，机器时区可能不是 +8，所以显式按 Asia/Shanghai 折算。
 */
export function todayCn(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return makeDate(get('year'), get('month'), get('day'));
}
