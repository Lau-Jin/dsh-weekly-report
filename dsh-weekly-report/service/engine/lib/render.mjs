/**
 * 周报正文渲染（Node 版）
 *
 * 对应 gen_weekly_text.py 的：
 *   build_text(2679) / build_miss_text(2786) / render_item(3196) / render_report(3213)
 *   load_report_template(3176) / DEFAULT_REPORT_TEMPLATE(3164)
 *   meta_path_for(3159) / find_latest_meta(3491) / save_report_bundle(3515)
 *   misses_from_meta(3220) / extract_ids(3240) / ID_RE(3156)
 *
 * 口径：同一份 items（或同一批考核表行 + 同一批工单），本模块输出的周报正文与
 * Python 版**逐字一致**（分隔、缩进、冒号全半角、行尾处理都照抄）。
 *
 * 与 Python 的两点差别（都不影响正文一致性）：
 *   1. Python 的 build_text 收「考核表行」（task/start/end/done/remark），
 *      这里的 buildText 同时收两种形状：Python 那种行，或 SPEC.md 的 item（d1/d2/school/subject/progress）。
 *      item 形状里已经算好的 school/subject/progress/note 直接沿用，缺的才用 Python 的口径补算。
 *   2. Python 写文件是文本模式（Windows 上会把 \n 翻成 \r\n），这里写文件也照做，
 *      所以落盘的周报文件与 Python 生成的字节一致；内存里的字符串统一是 \n。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  fmtRange, isoDate, makeDate, minDate, progressFor, pyRound, resolveSchool, similarity, splitSchool, startOfDay, toDate,
} from './util.mjs';
import { DEFAULT_HANDLER, DEFAULT_OUT_DIR, DEFAULT_THRESHOLD, ENGINE_DIR } from './config.mjs';

// ---------------------------------------------------------------------------
// 模板（对应 DEFAULT_REPORT_TEMPLATE / _TEMPLATE_DIR / load_report_template）
// ---------------------------------------------------------------------------

/** 内置默认模板；与 templates/周报模板.txt 内容一致（末尾带一个换行，Python 版也是这样） */
export const DEFAULT_REPORT_TEMPLATE = `【{{category}}】
{{school}}
  时间: {{time}}
  事项: {{subject}}
  工作内容：{{work}}
  重要说明：{{note}}
  进度：{{progress}}
`;

/** 插件自带的模板目录：service/engine/templates */
export const TEMPLATE_DIR = path.join(ENGINE_DIR, 'templates');

/**
 * 取周报模板：命令行指定 > 插件自带 templates/周报模板.txt > 内置默认。
 * 读取时按 Python 的 open(..., encoding="utf-8-sig") 口径：去 BOM + 通用换行（CRLF→LF），
 * 然后 .strip("\n")（只削首尾换行，不动空格）。
 */
export function loadReportTemplate(customPath) {
  const cands = [];
  if (customPath) cands.push(String(customPath));
  cands.push(path.join(TEMPLATE_DIR, '周报模板.txt'));
  for (const p of cands) {
    if (!p) continue;
    let raw = null;
    try {
      if (!fs.statSync(p).isFile()) continue;
      raw = fs.readFileSync(p, 'utf8');
    } catch (e) {
      // Python 只在打开成功、读取失败时打印；文件不存在直接跳过
      if (e && e.code !== 'ENOENT' && e.code !== 'ENOTDIR') {
        console.log(`提示：读取周报模板失败（${p}）：${e.message}；改用内置默认格式`);
      }
      continue;
    }
    const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '');
    if (text.trim()) {
      console.log(`周报模板：${p}`);
      return text;
    }
  }
  console.log('周报模板：内置默认格式');
  return DEFAULT_REPORT_TEMPLATE;
}

// ---------------------------------------------------------------------------
// 单条 / 整份（对应 render_item / render_report）
// ---------------------------------------------------------------------------

/**
 * 按模板渲染一条周报条目（占位符 {{字段}}）。
 * 注意 note 缺省是「无」，与 Python 的 `it.get("note") or "无"` 一致。
 */
export function renderItem(template, item) {
  const it = item || {};
  /**
   * 周报用「空行」分隔条目，所以任何字段里的换行、以及空 school 渲染出的空行，
   * 都会把一条记录切成两段（历史文件里真实出现过）。这里做第二层兜底：
   *   1. 每个字段压成单行；2. 空值给可读兜底；3. 模板里的空行也压掉。
   */
  const clean = (v, fallback = '') => String(v == null ? '' : v)
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim() || fallback;
  const fields = {
    category: clean(it.category, '其他'),
    // 与 rules.mjs 用同一套推断，避免兜底成类别名或留下空行
    school: clean(it.school, resolveSchool('', clean(it.subject), '', '通用事项')),
    time: clean(it.time, '本周期'),
    subject: clean(it.subject, '事项'),
    work: clean(it.work, '—'),
    note: clean(it.note, '无'),
    progress: clean(it.progress, '100%'),
  };
  let out = template === undefined || template === null || template === '' ? DEFAULT_REPORT_TEMPLATE : String(template);
  for (const [key, val] of Object.entries(fields)) {
    out = out.split(`{{${key}}}`).join(String(val));
  }
  out = out.replace(/\n[ \t]*\n+/g, '\n');
  return out.replace(/\n+$/, '');
}

/** 按模板渲染整份周报（一条一个块，块之间空一行）。 */
export function renderReport(items, template) {
  const tpl = template || DEFAULT_REPORT_TEMPLATE;
  const blocks = (items || []).map((it) => renderItem(tpl, it));
  return pyRStrip(blocks.join('\n\n')) + '\n';
}

// ---------------------------------------------------------------------------
// 未匹配清单（对应 build_miss_text）
// ---------------------------------------------------------------------------

/**
 * 未匹配清单：每条候选带编号，回复该编号即可自动回填。
 * @param {Array} misses buildText 的 misses（candidates 是 [score, ticket, isMine] 三元组）
 * @param {Date|string} weekStart
 * @param {Date|string} weekEnd
 * @param {number} threshold
 */
export function buildMissText(misses, weekStart, weekEnd, threshold) {
  const list = misses || [];
  const hasCands = list.some((m) => candList(m).length > 0);
  const out = [
    '周报未匹配工单清单',
    `周期：${dateText(weekStart)} ~ ${dateText(weekEnd)}`,
    `生成时间：${nowStamp()}`,
    `说明：以下事项未匹配到工单（阈值 ${thresholdText(threshold)}）。`,
  ];
  if (hasCands) {
    out.push(
      '',
      '【怎么确认】直接回复本邮件，正文写「确认 编号」，例如：',
      '    确认 1',
      '多个用逗号分隔：确认 1,3',
      '',
    );
  }
  out.push('');
  list.forEach((m, idx) => {
    const miss = m || {};
    out.push(`[事项 ${idx + 1}] 【${miss.category ?? ''}】${miss.school ?? ''}`);
    out.push(`    时间: ${miss.time ?? ''}`);
    out.push(`    事项: ${miss.subject ?? ''}`);
    out.push(`    当前工作内容: ${miss.work ?? ''}`);
    out.push(`    原因: ${miss.why ?? ''}`);
    const cands = candList(miss);
    if (cands.length) {
      out.push('    可选工单（回复前面的编号即可）:');
      for (const c of cands) {
        const [score, t, isMine] = unpackCand(c);
        const sid = t.id === undefined || t.id === null ? '' : String(t.id);
        const tag = sid ? `#${sid}` : '-';
        const school = t.school || '-';
        const owner = `${t.handler || '-'}${isMine ? '，本人' : '，非本人'}`;
        const no = 'confirm_no' in t && t.confirm_no !== null && t.confirm_no !== undefined ? t.confirm_no : '?';
        out.push(`      ${no}) ${t.title}   ${tag}   ${school}   ${owner}   相似度 ${scoreText(score)}`);
      }
    } else {
      out.push('    可选工单: 无（可直接回复工单号，如 确认 #123）');
    }
    out.push('');
  });
  return pyRStrip(out.join('\n')) + '\n';
}

/** misses 的 candidates 既接受 [score, ticket, isMine]，也接受 {score,ticket,isMine} / 候选对象本身 */
function candList(miss) {
  const c = miss && miss.candidates;
  return Array.isArray(c) ? c : [];
}

function unpackCand(c) {
  if (Array.isArray(c)) return [Number(c[0] ?? 0), c[1] || {}, !!c[2]];
  if (c && typeof c === 'object') {
    if ('score' in c && ('ticket' in c || 'item' in c)) {
      return [Number(c.score ?? 0), c.ticket || c.item || {}, !!(c.isMine ?? c.mine)];
    }
    // 直接就是候选工单对象（带 score 字段，meta 里的形状）
    return [Number(c.score ?? 0), c, !!(c.isMine ?? c.mine)];
  }
  return [0, {}, false];
}

// ---------------------------------------------------------------------------
// meta 快照（对应 meta_path_for / save_report_bundle / find_latest_meta / misses_from_meta / extract_ids）
// ---------------------------------------------------------------------------

/** <周报>.txt → <周报>_meta.json（Python 是 os.path.splitext(...)[0] + "_meta.json"） */
export function metaPathFor(reportPath) {
  return replaceExt(reportPath, '_meta.json');
}

/** <周报>.txt → <周报>_未匹配.txt */
export function missPathFor(reportPath) {
  return replaceExt(reportPath, '_未匹配.txt');
}

/** 把周报正文 + 未匹配清单 + meta 快照一起落盘（对应 save_report_bundle） */
export async function saveReportBundle(meta, reportPath) {
  const m = meta || {};
  const items = m.items || [];
  // Python 版由调用方 makedirs；这里顺手建好（面板换月/换目录时少一处踩坑）
  await fs.promises.mkdir(path.dirname(reportPath), { recursive: true });
  await writeTextFile(reportPath, renderReport(items));

  const missPath = missPathFor(reportPath);
  const handler = m.handler || DEFAULT_HANDLER;
  const misses = missesFromMeta(m, handler);
  const threshold = m.threshold === undefined || m.threshold === null ? DEFAULT_THRESHOLD : m.threshold;
  if (misses.length) {
    const ws = toDate((m.period && m.period.start) || '');
    const we = toDate((m.period && m.period.end) || '');
    await writeTextFile(missPath, buildMissText(misses, ws, we, threshold));
  } else if (await isFile(missPath)) {
    await fs.promises.unlink(missPath);
  }

  const metaPath = metaPathFor(reportPath);
  // 对应 json.dump(meta, f, ensure_ascii=False, indent=2)
  await fs.promises.writeFile(metaPath, JSON.stringify(m, null, 2), 'utf8');
  return { reportPath, metaPath, missPath: misses.length ? missPath : '', misses: misses.length };
}

/**
 * 目录下最新的 meta 快照（Python find_latest_meta 是 OUT_DIR\*\<*_meta.json> 取 mtime 最大者）。
 * @param {string} [dir] 缺省用配置的 out_dir
 * @returns {Promise<string|null>}
 */
export async function findLatestMeta(dir) {
  const root = dir || DEFAULT_OUT_DIR;
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const found = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const sub = path.join(root, ent.name);
    let files;
    try {
      files = await fs.promises.readdir(sub, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('_meta.json')) continue;
      const full = path.join(sub, f.name);
      try {
        const st = await fs.promises.stat(full);
        found.push([st.mtimeMs, full]);
      } catch {
        /* 读不到的文件跳过 */
      }
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => b[0] - a[0]);
  return found[0][1];
}

/**
 * 从 meta 里挑出「未匹配」事项（对应 misses_from_meta）。
 * candidates 仍用 Python 的三元组形状 [score, 候选工单, 是否本人]，这样 buildMissText 与 Python 一一对应。
 */
export function missesFromMeta(meta, handler = '') {
  const out = [];
  for (const it of (meta && meta.items) || []) {
    const cands = (it && it.candidates) || [];
    if (!cands.length) continue;
    out.push({
      category: it.category ?? '',
      school: it.school ?? '',
      subject: it.subject ?? '',
      time: it.time ?? '',
      work: it.work ?? '',
      why: '未找到足够相似的工单，请在回复中写「确认 编号」',
      candidates: cands.map((c) => {
        const score = c && c.score !== undefined && c.score !== null ? c.score : 0.0;
        const who = String((c && c.handler) || '');
        return [score, c, !!handler && who.includes(handler)];
      }),
    });
  }
  return out;
}

/** 对应 ID_RE：(#|ticketId=|ticketId%3D) + 至多 6 位数字，忽略大小写 */
const ID_RE = /(?:#|ticketId=|ticketId%3D)\s*(\d{1,6})/gi;

/** 从一段文本里抽出工单号（去重、保序） */
export function extractIds(text) {
  const ids = [];
  for (const m of String(text || '').matchAll(ID_RE)) {
    const v = m[1];
    if (!ids.includes(v)) ids.push(v);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// 周报正文（对应 build_text）
// ---------------------------------------------------------------------------

/**
 * 生成周报正文。与 Python build_text 同序同格式：
 *   【类别】/ 校名 / 时间 / 事项 / 工作内容 / 重要说明 / 进度 + 空行，条与条之间不分节。
 * 同时返回命中数、未匹配明细、命中他人工单数、meta 条目（items_out）。
 *
 * 返回值刻意做成「数组 + 同名字段」两种取法都行（与 Python 的 5 元组一一对应）：
 *   const [text, matched, misses, matchedOther, items] = buildText(...);
 *   const r = buildText(...); r.text / r.misses / r.items …
 *
 * @param {Array} items  考核表行（task/start/end/done/remark）或 SPEC item（d1/d2/school/subject/…）
 * @param {Date|string} weekStart 本周起（含）
 * @param {Date|string} weekEnd   本周止（含）
 * @param {object} [opts]
 *   tickets: 工单数组（undefined/null 表示「不比对」，与 Python 的 tickets=None 一致；
 *            传空数组 [] 会写入未匹配清单，也是 Python 的行为）
 *   threshold: 相似度阈值，默认 0.85
 *   reference: 进度参考日，默认 min(今天(北京), weekEnd)（与 Python 一致）
 *   handler: 处理人，默认 DEFAULT_HANDLER（Python 函数默认 None，但 CLI 总把配置里的处理人传进来）
 *   includeMiss: false 时不记未匹配清单（Python 没有这个开关，等价于不传 tickets）
 *   useItemNote: true 时「重要说明」用 item.note（默认照 Python 写「无」）
 */
export function buildText(items, weekStart, weekEnd, opts) {
  const o = opts || {};
  const ws = toDate(weekStart);
  const we = toDate(weekEnd);
  if (!ws || !we) throw new Error('buildText：weekStart / weekEnd 必须是日期');

  const tickets = o.tickets;
  const ticketList = Array.isArray(tickets) ? tickets : [];
  const ticketsProvided = tickets !== undefined && tickets !== null;
  const threshold = o.threshold === undefined || o.threshold === null ? DEFAULT_THRESHOLD : Number(o.threshold);
  const handler = o.handler === undefined ? DEFAULT_HANDLER : String(o.handler || '');
  const reference = o.reference ? toDate(o.reference) : minDate(todayCN(), we);
  const recordMiss = o.includeMiss !== false;
  const useItemNote = !!o.useItemNote;

  const lines = [];
  const misses = [];
  const itemsOut = [];
  let matched = 0;
  let matchedOther = 0;

  for (const raw of items || []) {
    const it = raw || {};

    // ---- 起止日：考核表行用 start/end，SPEC item 用 d1/d2；都没有就试着从 time 反解 ----
    let s = toDate(it.start !== undefined ? it.start : it.d1);
    let e = toDate(it.end !== undefined ? it.end : it.d2);
    if (!s && !e) {
      const r = parseTimeRange(it.time);
      if (r) [s, e] = r;
    }
    if (!s && !e) continue;                       // Python：起止都空的行直接跳过
    const lo = s || e;
    const hi = e || s;
    if (hi < ws || lo > we) continue;              // 与本周无交集

    // ---- 校名 / 事项（对应 split_school + 剥校名前缀） ----
    const category = it.category ?? '';
    const hasTask = typeof it.task === 'string' && it.task !== '';
    // 考核表行：task 里带校名，照 Python 现算；SPEC item：已经拆好的 school/subject 直接用
    const task = hasTask ? it.task : String(it.subject ?? '');
    const school = hasTask
      ? (splitSchool(task) || category)
      : (it.school || splitSchool(task) || category);
    let subject = task;
    if (school && subject.startsWith(school)) subject = subject.slice(school.length).trim();
    if (!subject) subject = task;

    // ---- 进度：item 上已有就用（规则模块算的更准），否则进度按 Python progress_for ----
    const doneText = it.done === true ? '是' : it.done === false ? '否' : String(it.done ?? '');
    const progress = it.progress ? String(it.progress) : progressFor(doneText, lo, hi, reference, task);

    // ---- 工单匹配（优先级：本人 > 他人；学校名交叉校验） ----
    // SPEC item 可能已带工作内容（例如按工单生成的那条），照用；考核表行没有这个字段。
    // 「无」按没内容算，这样未匹配的事项仍会进未匹配清单（与 Python 口径一致）。
    let work = it.work && String(it.work) !== '无' ? String(it.work) : '';
    let cands = [];
    let mineAll = [];
    let otherAll = [];
    if (ticketsProvided && ticketList.length) {
      for (const t of ticketList) {
        if (!t) continue;
        // 已取消的工单无效，不参与匹配（与按工单生成的口径一致）
        if (isCancelledStatus(t.status)) continue;
        // 学校名交叉校验：两边都有学校且不一致，直接跳过，避免跨校串号
        if (school && t.school && similarity(school, t.school) < 0.6) continue;
        const score = Math.max(similarity(subject, t.title), similarity(task, t.title));
        const flag = !!handler && String(t.handler ?? '').includes(handler);
        (flag ? mineAll : otherAll).push({ score, t, flag });
      }
      mineAll = mineAll.sort((a, b) => b.score - a.score);
      otherAll = otherAll.sort((a, b) => b.score - a.score);
      const mineBest = mineAll[0] || null;
      const otherBest = otherAll[0] || null;
      if (mineBest && mineBest.score >= threshold) {
        work = mineBest.t.link ?? '';
        matched += 1;
      } else if (otherBest && otherBest.score >= threshold) {
        work = otherBest.t.link ?? '';
        matched += 1;
        matchedOther += 1;
      }
    }

    const remark = it.remark ? String(it.remark) : '';
    if (!work && ticketsProvided && recordMiss) {
      cands = mineAll.slice(0, 3).concat(otherAll.slice(0, 3));
      const best = cands.reduce((m, c) => Math.max(m, c.score), 0.0);
      const why = cands.length
        ? `最高相似度 ${scoreText(best)} < 阈值 ${thresholdText(threshold)}`
        : '没有可比对的工单（学校名均不一致）';
      misses.push({
        category,
        school,
        subject,
        time: fmtRange(lo, hi),
        work: remark || '无',
        why,
        candidates: cands.map((c) => [c.score, c.t, c.flag]),
      });
    }
    if (!work) work = remark || '无';

    // ---- 正文（格式照抄 Python：半角冒号 + 4 空格缩进 + 条目后空一行） ----
    const noteText = useItemNote && it.note ? String(it.note) : '无';
    const timeText = fmtRange(lo, hi);
    lines.push(
      `【${category}】`,
      String(school),
      `    时间: ${timeText}`,
      `    事项: ${subject}`,
      `    工作内容: ${work}`,
      `    重要说明: ${noteText}`,
      `    进度: ${progress}`,
      '',
    );
    itemsOut.push({
      category,
      school,
      subject,
      time: timeText,
      work,
      progress,
      note: noteText,
      candidates: cands.map((c) => ({
        id: c.t.id === undefined || c.t.id === null ? '' : String(c.t.id),
        title: c.t.title ?? '',
        school: c.t.school ?? '',
        link: c.t.link ?? '',
        handler: c.t.handler ?? '',
        score: pyRound(c.score * 100) / 100,
      })),
    });
  }

  const text = pyRStrip(lines.join('\n')) + '\n';
  const out = [text, matched, misses, matchedOther, itemsOut];
  out.text = text;
  out.matched = matched;
  out.misses = misses;
  out.matchedOther = matchedOther;
  out.items = itemsOut;
  return out;
}

// ---------------------------------------------------------------------------
// 内部小工具
// ---------------------------------------------------------------------------

/** Python 的 str.rstrip()（去尾部所有空白） */
function pyRStrip(s) {
  return String(s ?? '').replace(/\s+$/, '');
}

/** f"{x:.2f}" */
function scoreText(x) {
  return Number(x ?? 0).toFixed(2);
}

/** f"{x}"（阈值这类小数：0.85 → "0.85"，0.8 → "0.8"） */
function thresholdText(x) {
  return String(x);
}

/** date / 'YYYY-MM-DD' → 'YYYY-MM-DD'（f"{week_start}" 的口径） */
function dateText(v) {
  if (v instanceof Date) return isoDate(startOfDay(v));
  return String(v ?? '');
}

/** datetime.now():%Y-%m-%d %H:%M:%S（本地时间） */
function nowStamp() {
  const d = new Date();
  return `${isoDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 北京时间（UTC+8）的今天（Python 用 timezone(timedelta(hours=8))） */
function todayCN() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const shifted = new Date(utcMs + 8 * 3600000);
  return new Date(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
}

/** 对应 CANCELLED_STATUSES / is_cancelled_status（rules.mjs 也有同名实现，这里留一份避免循环依赖） */
const CANCELLED_STATUSES = new Set(['cancelled', 'canceled', '已取消', '作废', '已作废', '取消']);

export function isCancelledStatus(status) {
  const s = String(status ?? '').trim().toLowerCase();
  if (!s) return false;
  if (CANCELLED_STATUSES.has(s)) return true;
  return s.includes('取消') || s.includes('作废');
}

/** 'YYYY-MM-DD'-friendly 扩展名替换（对应 os.path.splitext(p)[0] + suffix） */
function replaceExt(p, suffix) {
  const s = String(p ?? '');
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const dir = s.slice(0, cut + 1);
  const base = s.slice(cut + 1);
  const dot = base.lastIndexOf('.');
  // Python 的 splitext：首个字符就是点（如 ".foo"）不算扩展名
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return dir + stem + suffix;
}

/**
 * 按 Python 的文本模式写文件：Windows 上 \n → \r\n（Python open(..., "w") 的默认行为），
 * 这样落盘的周报文件与 Python 生成的字节一致。
 */
async function writeTextFile(file, text) {
  const body = process.platform === 'win32' ? String(text).replace(/\r?\n/g, '\r\n') : String(text);
  await fs.promises.writeFile(file, body, 'utf8');
}

async function isFile(p) {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * 从 fmt_range 的文案反解起止日（只在 item 缺 d1/d2/start/end 时兜底用）。
 * 支持：'2026年11月10日'、'2026年11月10日-14日'、'2026年11月10日-12月3日'、'2025年12月30日-2026年1月2日'
 */
export function parseTimeRange(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})年(\d{1,2})月(\d{1,2})日\s*[-~—－]\s*(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(s);
  if (m) return [makeDate(+m[1], +m[2], +m[3]), makeDate(+m[4], +m[5], +m[6])];
  m = /^(\d{4})年(\d{1,2})月(\d{1,2})日\s*[-~—－]\s*(\d{1,2})月(\d{1,2})日$/.exec(s);
  if (m) return [makeDate(+m[1], +m[2], +m[3]), makeDate(+m[1], +m[4], +m[5])];
  m = /^(\d{4})年(\d{1,2})月(\d{1,2})日\s*[-~—－]\s*(\d{1,2})日$/.exec(s);
  if (m) return [makeDate(+m[1], +m[2], +m[3]), makeDate(+m[1], +m[2], +m[4])];
  const d = toDate(s);
  if (d) return [d, d];
  return null;
}
