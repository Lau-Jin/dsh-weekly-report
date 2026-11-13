/**
 * 绩效表（月度考核表）——Node 版，对应 gen_weekly_text.py 的「绩效文档」段：
 *   perf_sheet / perf_month_text / perf_task_zone / perf_path_for / perf_template_report
 *   _perf_date_text / perf_dump / read_perf_rows / items_to_perf_rows / perf_key
 *   merge_perf_rows / _write_task_rows / _score_formulas / _fix_score_formulas
 *   _d4_matches_month / build_perf_xlsx / auto_pick_xlsx
 *   parse_report_time / parse_weekly_report / weekly_reports_for_month
 *   collect_week_items / _perf_row_line / _range_covers / check_perf_xlsx / perf_check_report
 *
 * 口径：只写 B/D/J/K/L/M 六列，模板的其它单元格、合并区域、字体、行高、列宽、
 * 公式与其它 sheet 一概不动（openpyxl 那边靠 MergedCell 跳过，这里靠 isMergedSlave）。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  readWorkbook, openSheet, cellValue, cellFormula, setCell, saveAtomic, insertRowsAt,
  mergeTexts, isMergedSlave, pyStr, fromExcelDate, isFileLockedError, PERF_SHEET_TITLE,
} from './xlsx.mjs';
import { toDate, isoDate, makeDate, norm, weekEndOf } from './util.mjs';
import { detectPerfLayout, structureSignature, signatureDiff } from './perf-map.mjs';

// ---------------------------------------------------------------------------
// 常量（与 Python 一一对应）
// ---------------------------------------------------------------------------

export const PERF_CAT_COL = 2;      // B 类别
export const PERF_CONTENT_COL = 4;  // D 任务名称（学校+事项）
export const PERF_START_COL = 10;   // J 开始时间
export const PERF_END_COL = 11;     // K 结束时间
export const PERF_DONE_COL = 12;    // L 是否完成
export const PERF_NOTE_COL = 13;    // M 评定（备注）
export const PERF_FIRST_ROW = 7;    // 明细从第 7 行起

// 默认处理人留空：分发包不预置任何个人信息，处理人在面板「设置」里由使用者自己填写
export const DEFAULT_HANDLER = '';
export const PERF_FILE_SUFFIX = '员工月度考核表-交付中心.xlsx';

// 台账名也一起导出，方便调用方判断"这张表是不是月度考核表"
export { PERF_SHEET_TITLE };

const PERF_COLS = [PERF_CAT_COL, PERF_CONTENT_COL, PERF_START_COL, PERF_END_COL, PERF_DONE_COL, PERF_NOTE_COL];

/** 表结构常量（对应 perf_sheet 那一段的常量与挑表口径） */
export function perfSheet() {
  return {
    name: PERF_SHEET_TITLE,
    firstRow: PERF_FIRST_ROW,
    catCol: PERF_CAT_COL,
    contentCol: PERF_CONTENT_COL,
    startCol: PERF_START_COL,
    endCol: PERF_END_COL,
    doneCol: PERF_DONE_COL,
    noteCol: PERF_NOTE_COL,
    columns: PERF_COLS.slice(),
  };
}

/** 工作表名（面板/CLI 提示用） */
export function perfSheetName() {
  return PERF_SHEET_TITLE;
}

/** 月度考核表所在工作表（对应 perf_sheet：名字完全等于「月度考核」，否则用最后一张） */
export function perfSheetOf(wb) {
  return openSheet(wb, PERF_SHEET_TITLE, { mode: 'exact' });
}

/** '2026年11月' */
export function perfMonthText(year, month) {
  return `${year}年${month}月`;
}

/** 任务区：(起始行, 可填行数, 「工作任务考核」区块所在行) */
export function perfTaskZone(ws) {
  let secRow = null;
  const maxRow = ws.rowCount;
  for (let r = PERF_FIRST_ROW; r <= maxRow; r += 1) {
    const v = ws.getCell(r, PERF_CAT_COL).value;
    if (typeof v === 'string' && v.includes('工作任务考核')) {
      secRow = r;
      break;
    }
  }
  if (secRow === null) secRow = 22;
  return [PERF_FIRST_ROW, Math.max(1, secRow - PERF_FIRST_ROW), secRow];
}

/**
 * 当月绩效表路径：
 *   <绩效表目录>/<YYYY>/YYYY年M月<处理人>员工月度考核表-交付中心.xlsx
 * 目录本身已经是「…\2026」这种年份目录时先退到上一层（与 Python 一致）。
 */
export function perfPathFor(folder, handler, year, month) {
  let root = path.normalize(String(folder || ''));
  if (root.length > 3) root = root.replace(/[\\/]+$/, '');
  if (/^\d{4}$/.test(path.basename(root))) root = path.dirname(root);
  return path.join(root, String(year), `${year}年${month}月${handler}${PERF_FILE_SUFFIX}`);
}

/** Python 的 str(cell.value or "") / str(v)（None 显示成 None 的地方用 rawText） */
function cellText(ws, r, c) {
  return pyStr(cellValue(ws.getRow(r), c));
}

function rawText(v) {
  if (v === null || v === undefined) return 'None';
  if (v instanceof Date) return pyStr(v);
  return pyStr(v);
}

/** 对应 _perf_date_text：日期按表里的显示格式（yyyy/m/d，补零） */
export function perfDateText(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    return `${v.getFullYear()}/${String(v.getMonth() + 1).padStart(2, '0')}/${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v);
}

/** Python datetime/date.isoformat() 的口径（filled_at 用） */
function isoFormatLike(v) {
  if (!(v instanceof Date)) return '';
  const d = fromExcelDate(v);
  if (!d) return '';
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // openpyxl 对日期格式的单元格一律给 datetime（没有时间也是 00:00:00），isoformat 也就带时间部分
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  const ms = d.getMilliseconds();
  return ms ? `${date}T${time}.${String(ms * 1000).padStart(6, '0')}` : `${date}T${time}`;
}

// ---------------------------------------------------------------------------
// dump（--perf-dump）
// ---------------------------------------------------------------------------

/** 与 Python `json.dumps(..., ensure_ascii=False)` 同格式（', ' 与 ': ' 分隔） */
export function jsonDumpsPy(value) {
  const enc = (v) => {
    if (v === null || v === undefined) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(enc).join(', ')}]`;
    const keys = Object.keys(v).filter((k) => v[k] !== undefined);
    return `{${keys.map((k) => `${JSON.stringify(k)}: ${enc(v[k])}`).join(', ')}}`;
  };
  return enc(value);
}

/** 与 `--perf-dump` 完全同构的 JSON 结构 */
export async function perfDump(file) {
  const wb = await readWorkbook(file);
  const ws = perfSheetOf(wb);
  const [start, cap] = perfTaskZone(ws);
  const rows = readPerfRows(ws, start, cap);
  const items = rows.map((r) => ({
    category: r.category || '',
    content: r.content || '',
    d1: r.d1 ? isoDate(r.d1) : '',
    d2: r.d2 ? isoDate(r.d2) : '',
    d1_text: perfDateText(r.d1),
    d2_text: perfDateText(r.d2),
    settled: !!r.settled,
    note: typeof r.note === 'string' ? r.note : '',
  }));
  const doneN = items.filter((it) => it.settled).length;
  const headers = [PERF_CAT_COL, PERF_CONTENT_COL, PERF_START_COL, PERF_END_COL,
    PERF_DONE_COL, PERF_NOTE_COL].map((c) => {
    const v = ws.getCell(6, c).value;
    return typeof v === 'string' && v.trim() ? v.trim() : '';
  });
  const filledRaw = ws.getCell(3, 11).value;
  return {
    path: path.resolve(String(file)),
    name: path.basename(String(file)),
    sheet: ws.name, // exceljs 的工作表名在 name 上（openpyxl 是 title）
    handler: cellText(ws, 3, 4),
    dept: cellText(ws, 3, 8),
    period: cellText(ws, 4, 4),
    filled_at: filledRaw instanceof Date ? isoFormatLike(filledRaw) : '',
    headers,
    rows: items,
    total: items.length,
    done: doneN,
    undone: items.length - doneN,
  };
}

/** perfDump 的文本形式（与 Python 打印的一行 JSON 逐字符对齐，便于直接 diff） */
export async function perfDumpText(file) {
  return jsonDumpsPy(await perfDump(file));
}

// ---------------------------------------------------------------------------
// 读任务行 / 条目互转 / 合并
// ---------------------------------------------------------------------------

/** 读任务区里已有的条目（对应 read_perf_rows；按识别到的列读，识别失败退回默认列） */
export function readPerfRows(ws, start = PERF_FIRST_ROW, cap = null, layout = null) {
  const lay = layout || detectPerfLayout(ws);
  const cols = lay.cols;
  let s = start;
  let n = cap;
  if (n === null || n === undefined) {
    s = lay.firstRow || PERF_FIRST_ROW;
    n = lay.cap;
  }
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const r = s + i;
    const row = ws.getRow(r);
    const content = cellValue(row, cols.content);
    if (content === null || content === undefined) continue;
    const text = pyStr(content).trim();
    if (!text) continue;
    const cat = cellValue(row, cols.category);
    const done = cellValue(row, cols.done);
    rows.push({
      category: cat === null || cat === undefined ? '' : pyStr(cat).trim(),
      content: text,
      d1: toDate(cellValue(row, cols.start)),
      d2: toDate(cellValue(row, cols.end)),
      settled: pyStr(done || '').trim() === '是',
      note: cellValue(row, cols.note),
    });
  }
  return rows;
}

/** 周报条目 → 绩效表行（内容 = 学校名 + 事项，与模板填法一致） */
export function itemsToPerfRows(items) {
  const rows = [];
  for (const it of items || []) {
    const content = `${it.school || ''}${it.subject || ''}`.trim();
    if (!content) continue;
    const note = it.note;
    const d1 = toDate(it.d1);
    let d2 = toDate(it.d2);
    // 未完成的事项：结束时间一律落在「本周周日」，不写月末或未来日期
    if (!it.settled && d1) {
      const sun = weekEndOf(d1);
      if (sun && (!d2 || d2 > sun)) d2 = sun;
    }
    rows.push({
      category: String(it.category || '').trim(),
      content,
      d1,
      d2,
      settled: !!it.settled,
      note: note === null || note === undefined || note === '' || note === '无' ? null : note,
    });
  }
  return rows;
}

/** 同一事项的判定键：忽略空格、标点与大小写（对应 perf_key） */
export function perfKey(content) {
  return norm(content) || String(content || '').trim();
}

function isBlankNote(v) {
  return v === null || v === undefined || v === '' || v === '无';
}

/**
 * 把多组条目并成一个月度清单（对应 merge_perf_rows）：
 * 同一事项只留一行，时间取并集、完成取「或」；preferNew 时以最后一组为准。
 * 兼容两种调用：mergePerfRows(a, b, { preferNew: true }) 或 mergePerfRows([a, b])。
 */
export function mergePerfRows(...args) {
  let preferNew = false;
  const groups = [];
  for (const a of args) {
    if (a && !Array.isArray(a) && typeof a === 'object' && Object.prototype.hasOwnProperty.call(a, 'preferNew')) {
      preferNew = !!a.preferNew;
      if (Array.isArray(a.groups)) groups.push(a.groups);
      continue;
    }
    groups.push(a);
  }
  const merged = [];
  const index = new Map();
  for (const group of groups) {
    for (const row of group || []) {
      const content = String(row.content || '').trim();
      if (!content) continue;
      const key = perfKey(content);
      const cur = index.get(key);
      if (!cur) {
        const copyRow = { ...row, content };
        index.set(key, copyRow);
        merged.push(copyRow);
        continue;
      }
      const d1s = [cur.d1, row.d1].filter(Boolean);
      cur.d1 = d1s.length ? new Date(Math.min(...d1s.map((d) => d.getTime()))) : null;
      const wasSettled = !!cur.settled;
      const nowSettled = !!row.settled;
      if (!wasSettled && !nowSettled) {
        // 两边都没完成：以「本轮算出来的周口径」为准（开始~本周周日），
        // 否则表里遗留的月末日期永远盖不掉新值。
        cur.d2 = row.d2 || cur.d2;
      } else {
        const d2s = [cur.d2, row.d2].filter(Boolean);
        cur.d2 = d2s.length ? new Date(Math.max(...d2s.map((d) => d.getTime()))) : null;
      }
      cur.settled = preferNew ? nowSettled : (wasSettled || nowSettled);
      if (!cur.category) cur.category = String(row.category || '').trim();
      if (isBlankNote(cur.note) && !isBlankNote(row.note)) cur.note = row.note;
    }
  }
  merged.sort((a, b) => {
    const ka = a.d1 ? isoDate(a.d1) : '';
    const kb = b.d1 ? isoDate(b.d1) : '';
    if (ka !== kb) return ka < kb ? -1 : 1;
    const pa = perfKey(a.content);
    const pb = perfKey(b.content);
    if (pa !== pb) return pa < pb ? -1 : 1;
    const ca = a.content || '';
    const cb = b.content || '';
    if (ca === cb) return 0;
    return ca < cb ? -1 : 1;
  });
  return merged;
}

// ---------------------------------------------------------------------------
// 写任务行 / 评分公式
// ---------------------------------------------------------------------------

/**
 * 把条目写进任务区（v1.1.0 重写）。
 *
 * 与原实现的区别：
 *   · 不再「先把整块六列清空再重写」—— 只改真正需要变的格子，
 *     表里其它列（评定说明、工时、附件等）以及样式、行高、合并区都不碰；
 *   · 日期格式沿用模板该列已有的数字格式，不强行改成 yyyy/m/d；
 *   · 不再统一覆盖字体，空格子才从上面的样例行借样式；
 *   · 返回逐格差异，面板可以直接列给使用者看。
 *
 * @returns {{changes: Array, rowsWritten: number, overflow: number}}
 */
export function writeTaskRows(ws, rows, start = PERF_FIRST_ROW, layout = null) {
  const lay = layout || detectPerfLayout(ws);
  const cols = lay.cols;
  const list = rows || [];
  const secRow = lay.secRow || (start + lay.cap);
  const cap = Math.max(0, secRow - start);

  // 模板该列已有的日期格式（取第一条有值的明细行），保持表里的显示方式不变
  const dateFmt = (() => {
    for (let i = 0; i < Math.min(cap, 30); i += 1) {
      const c = ws.getCell(start + i, cols.start);
      if (c && c.numFmt && /[ymd]/.test(String(c.numFmt))) return c.numFmt;
    }
    return 'yyyy/m/d';
  })();
  const sampleRow = ws.getRow(start);

  const changes = [];

  /** 写一格；返回 true 表示值确实变了，并把前后值记进差异表 */
  const put = (r, c, value, label, opts = {}) => {
    const row = ws.getRow(r);
    if (isMergedSlave(ws, r, c)) return false;
    const cell = row.getCell(c);
    const before = cell.value;
    if (sameValue(before, value)) return false;
    // 空格子借样例行的样式（边框、字体），已有内容只改值不动样式
    const empty = before === null || before === undefined || before === '';
    setCell(row, c, value, empty ? sampleRow.getCell(c) : null,
      opts.numFmt ? { numFmt: opts.numFmt } : {});
    changes.push({
      row: r, col: c, label, before: fmtCell(before), after: fmtCell(value),
    });
    return true;
  };

  const limit = Math.min(list.length, cap);
  for (let i = 0; i < limit; i += 1) {
    const r = start + i;
    const it = list[i];
    put(r, cols.category, it.category || null, '类别');
    put(r, cols.content, it.content || null, '任务名称');
    if (it.d1) put(r, cols.start, it.d1, '开始时间', { numFmt: dateFmt });
    if (it.d2) put(r, cols.end, it.d2, '结束时间', { numFmt: dateFmt });
    put(r, cols.done, it.settled ? '是' : '否', '是否完成');
    if (!isBlankNote(it.note)) put(r, cols.note, it.note, '评定');
  }

  return { changes, rowsWritten: limit, overflow: Math.max(0, list.length - cap), cap, dateFmt };
}

/** 单元格值归一化比较（日期按序列值比，字符串去空白） */
function sameValue(a, b) {
  const normOne = (v) => {
    if (v === null || v === undefined || v === '') return '';
    if (v instanceof Date) return `d:${v.getFullYear()}-${v.getMonth() + 1}-${v.getDate()}`;
    if (typeof v === 'object' && v && v.result !== undefined) return `d:${new Date(v.result).toISOString().slice(0, 10)}`;
    if (typeof v === 'object' && v && v.formula) return `f:${v.formula}`;
    if (typeof v === 'number') {
      const d = fromExcelDate(v);
      if (d) return `d:${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      return `n:${v}`;
    }
    return `s:${String(v).trim()}`;
  };
  return normOne(a) === normOne(b);
}

function fmtCell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return `${v.getFullYear()}/${v.getMonth() + 1}/${v.getDate()}`;
  if (typeof v === 'object' && v && v.formula) return `=${v.formula}`;
  if (typeof v === 'number') {
    const d = fromExcelDate(v);
    if (d) return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }
  return String(v).slice(0, 60);
}

/** 三个考核区块的「考核评分 / 最终评分」公式（对应 _score_formulas），区块不全返回 null */
export function scoreFormulas(ws) {
  const secs = {};
  for (let r = PERF_FIRST_ROW; r <= ws.rowCount; r += 1) {
    const v = ws.getCell(r, PERF_CAT_COL).value;
    if (typeof v !== 'string') continue;
    if (v.includes('工作任务考核')) {
      if (secs.task === undefined) secs.task = r;
    } else if (v.includes('工作绩效考核')) {
      if (secs.work === undefined) secs.work = r;
    } else if (v.includes('品质')) {
      if (secs.moral === undefined) secs.moral = r;
    }
  }
  if (secs.task === undefined || secs.work === undefined || secs.moral === undefined) return null;
  const s1 = secs.task;
  const s2 = secs.work;
  const s3 = secs.moral;
  const total = `SUM(M${s1 + 2}:N${s1 + 6})`;
  return [
    `=${total}`,
    `=${total}*0.6+SUM(M${s2 + 2}:N${s2 + 7})*0.3+SUM(M${s3 + 2}:N${s3 + 5})*0.1`,
  ];
}

/** 把考核评分公式校正到当前区块位置；改了就返回 true（对应 _fix_score_formulas） */
export function fixScoreFormulas(ws) {
  const wanted = scoreFormulas(ws);
  if (!wanted) return false;
  let changed = false;
  for (const [col, val] of [[11, wanted[0]], [13, wanted[1]]]) { // K4 / M4
    const row = ws.getRow(4);
    const cell = row.getCell(col);
    if (cellFormula(row, col) !== val) {
      setCell(row, col, { formula: val.replace(/^=/, '') }, null, { force: true });
      changed = true;
    }
  }
  return changed;
}

/** D4（考核时间）是不是这个月（对应 _d4_matches_month） */
export function d4MatchesMonth(d4, year, month) {
  const tag = perfMonthText(year, month);
  if (typeof d4 === 'string') return d4.includes(tag);
  if (d4 instanceof Date) {
    return d4.getFullYear() === Number(year) && d4.getMonth() + 1 === Number(month);
  }
  return false;
}

function nowSecond() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
}

// ---------------------------------------------------------------------------
// 写整张表（build_perf_xlsx）
// ---------------------------------------------------------------------------

/**
 * 把本月条目写进月度考核表（v1.1.0）。
 *
 * 原则：**只填该填的格子，其余一律不动**。
 *   · 版式按表头文字自动识别（见 perf-map.mjs），不再依赖写死的 B/D/J/K/L/M；
 *   · 写前把原文件备份到同目录 .perf-backup/，可随时还原；
 *   · 写前写后各取一次结构指纹（合并区、区块位置、行列数），有变化如实报告；
 *   · 行数不够时默认**不下移区块**，而是把超出部分报出来（避免结构被改），
 *     使用者确认要扩行时传 allowInsert: true。
 *
 * @returns {Promise<{path: string, added: number, rows: number, changes: Array,
 *   overflow: number, structureChanged: boolean, structureDiff: string[], backup: string,
 *   layout: object}>}
 */
export async function buildPerfXlsx(opts) {
  const {
    templatePath, outPath, items, year, month,
    handler = DEFAULT_HANDLER, accumulate = true, allowInsert = false, dryRun = false, log = console.log,
  } = opts || {};
  const wb = await readWorkbook(templatePath);
  const ws = perfSheetOf(wb);
  const layout = detectPerfLayout(ws);
  const start = layout.firstRow;

  const sameFile = path.resolve(String(templatePath)) === path.resolve(String(outPath));
  const tag = perfMonthText(year, month);
  let existing = [];
  if (accumulate && sameFile) {
    const d4 = cellValue(ws.getRow(layout.info.month.row), layout.info.month.col);
    if (d4MatchesMonth(d4, year, month)) existing = readPerfRows(ws, start, layout.cap, layout);
    else if (log) log(`提示：表头月份（${rawText(d4)}）不是 ${tag}，本次按模板重填任务行（不累积旧行）`);
  } else if (accumulate && fs.existsSync(String(outPath))) {
    if (log) log('提示：用外部模板生成，表里已有的条目未参与累积（别把 --perf-template 当日常用法）');
  }

  const before = new Set(existing.filter((r) => r.content).map((r) => perfKey(r.content)));
  const rows = mergePerfRows(existing, itemsToPerfRows(items));
  const added = rows.filter((r) => !before.has(perfKey(r.content || ''))).length;

  if (rows.length > layout.cap && allowInsert) {
    insertRowsAt(ws, layout.secRow, rows.length - layout.cap);
    if (log) log(`提示：明细区只有 ${layout.cap} 行，已按需下移考核区块 ${rows.length - layout.cap} 行`);
  } else if (rows.length > layout.cap) {
    if (log) {
      log(`警告：明细区只剩 ${layout.cap} 行，本月共 ${rows.length} 条，超出的 ${rows.length - layout.cap} 条本次未写入`
        + '（为避免改动表格结构，未自动插行；可在设置里勾选「允许自动扩展行」后重试）');
    }
  }

  const sigBefore = structureSignature(ws);
  const written = writeTaskRows(ws, rows, start, layout);

  // 基本信息：处理人 / 考核月份 / 填报时间（位置来自识别结果）
  try {
    const infoChanges = [];
    const putInfo = (cellRef, value, label) => {
      const r = cellRef.row; const c = cellRef.col;
      if (isMergedSlave(ws, r, c)) return;
      const cur = ws.getCell(r, c).value;
      if (sameValue(cur, value)) return;
      setCell(ws.getRow(r), c, value);
      infoChanges.push({ row: r, col: c, label, before: fmtCell(cur), after: fmtCell(value) });
    };
    if (handler) putInfo(layout.info.handler, handler, '被考评人');
    const last = [1, 3, 5, 7, 8, 10, 12].includes(month) ? 31 : (month !== 2 ? 30 : 28);
    putInfo(layout.info.month, `${year}年${month}月1日-${month}月${last}日`, '考评时间');
    putInfo(layout.info.fillTime, nowSecond(), '填报时间');
    written.changes.unshift(...infoChanges);
  } catch { /* 基本信息写不进去不影响任务行 */ }

  // 行数变了，考核评分公式要跟着区块走
  if (fixScoreFormulas(ws) && log) log('已校正考核评分公式（K4/M4）指向本次的考核区块');

  const sigAfter = structureSignature(ws);
  const structureDiff = signatureDiff(sigBefore, sigAfter);

  const result = {
    path: String(outPath),
    added,
    rows: rows.length,
    changes: written.changes,
    overflow: written.overflow,
    structural: structureDiff.length ? structureDiff : [],
    structureChanged: structureDiff.length > 0,
    backup: '',
    layout,
  };

  if (dryRun) {
    if (log) {
      log(`[预览] 将改动 ${written.changes.length} 个单元格，本月共 ${rows.length} 条（新增 ${added} 条）`);
      for (const ch of written.changes.slice(0, 40)) log(`  ${ch.label} (第 ${ch.row} 行)：${ch.before || '空'} → ${ch.after}`);
    }
    return result;
  }

  // 公式被重写过，让 Excel 打开时重算
  try {
    wb.calcProperties = { fullCalcOnLoad: true };
  } catch { /* 老版本没有这个属性 */ }

  // 写前备份：同一份表每周都会被重写，留最近几份便于回退
  if (sameFile && fs.existsSync(String(outPath))) {
    try {
      result.backup = backupPerf(outPath);
      if (log) log(`已备份原表：${result.backup}`);
    } catch (e) {
      if (log) log(`提示：备份失败（${e.message}），仍继续写入`);
    }
  }

  fs.mkdirSync(path.dirname(path.resolve(String(outPath))), { recursive: true });
  try {
    await saveAtomic(wb, outPath);
  } catch (err) {
    if (!isFileLockedError(err)) throw err;
    const alt = `${path.join(path.dirname(String(outPath)), path.basename(String(outPath), path.extname(String(outPath))))}_新.xlsx`;
    await saveAtomic(wb, alt);
    if (log) {
      log(`警告：${outPath} 正被 Excel 占用，已改写到 ${alt}，关闭 Excel 后重跑即可覆盖原文件`);
    }
    result.path = alt;
    return result;
  }
  if (log) {
    log(`绩效文档：${result.path}（本月共 ${rows.length} 条，本次新增 ${added} 条，`
      + `沿用表内原有 ${existing.length} 条，实际改动 ${written.changes.length} 个单元格）`);
    if (result.structureChanged) log(`注意：表格结构发生变化 → ${structureDiff.join('；')}`);
  }
  return result;
}

/** 备份绩效表：<同目录>/.perf-backup/<名字>.<时间戳>.xlsx，只留最近 8 份 */
export function backupPerf(file) {
  const dir = path.join(path.dirname(path.resolve(String(file))), '.perf-backup');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = stampForFile();
  const ext = path.extname(String(file));
  const base = path.basename(String(file), ext);
  const target = path.join(dir, `${base}.${stamp}${ext}`);
  fs.copyFileSync(file, target);
  const olds = fs.readdirSync(dir)
    .filter((n) => n.startsWith(`${base}.`) && n.endsWith(ext))
    .map((n) => path.join(dir, n))
    .sort();
  while (olds.length > 8) {
    const drop = olds.shift();
    try { fs.rmSync(drop, { force: true }); } catch { /* ignore */ }
  }
  return target;
}

// ---------------------------------------------------------------------------
// 模板自检（perf_template_report）
// ---------------------------------------------------------------------------

function walkXlsx(folder) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.toLowerCase().endsWith('.xlsx') && !e.name.startsWith('~$')) files.push(full);
    }
  };
  walk(String(folder), 0);
  return files.sort();
}

/** 检查绩效表模板能不能用（新装机器自检用，对应 perf_template_report） */
export async function perfTemplateReport(folder, handler = DEFAULT_HANDLER, year = null, month = null) {
  const out = { folder, ok: false, items: [], errors: [], hints: [] };
  if (!folder || !fs.existsSync(String(folder)) || !fs.statSync(String(folder)).isDirectory()) {
    out.errors.push(`绩效表目录不存在：${folder}`);
    out.hints.push('在「配置 → 绩效表目录」里填一个存在的目录');
    return out;
  }
  const files = walkXlsx(folder);
  if (!files.length) {
    out.errors.push(`目录里没有任何 .xlsx 模板：${folder}`);
    out.hints.push('把一张当月的《员工月度考核表》复制到这个目录（名字随意），下次生成就会自动套用它；'
      + '或从模板另存一份空的放进去');
    return out;
  }
  for (const f of files) {
    const item = { name: path.basename(f), path: f, ok: true, notes: [] };
    try {
      const wb = await readWorkbook(f);
      const hasPerf = wb.worksheets.some((ws) => ws.name === PERF_SHEET_TITLE);
      const ws = perfSheetOf(wb);
      if (!hasPerf) item.notes.push(`没有「月度考核」工作表，将使用最后一个（${ws.name}）`);
      const zone = perfTaskZone(ws);
      item.task_rows = zone[1];
      item.section_row = zone[2];
      if (cellValue(ws.getRow(3), 4) === null || cellValue(ws.getRow(3), 4) === '') {
        item.notes.push('D3（被考评人）是空的');
      }
      if (cellValue(ws.getRow(4), 4) === null || cellValue(ws.getRow(4), 4) === '') {
        item.notes.push('D4（考评时间）是空的');
      }
      if (item.notes.length) item.ok = true;
    } catch (e) {
      item.ok = false;
      item.notes.push(`打不开：${e.message}`);
    }
    out.items.push(item);
  }
  out.ok = out.items.some((i) => i.ok);
  if (year && month) {
    const want = perfPathFor(folder, handler, year, month);
    out.current_target = want;
    out.current_exists = fs.existsSync(want) && fs.statSync(want).isFile();
  }
  return out;
}

// ---------------------------------------------------------------------------
// 周报解析 / 收集（collect_week_items 系列）
// ---------------------------------------------------------------------------

const WEEK_FILE_RE = /周报_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.txt$/;
const REPORT_TIME_RE = /(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*[-~—–至到]\s*(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})日)?/;

/** 「2026年11月9日」/「2026年11月9日-15日」/「2026年11月9日-12月15日」→ [d1, d2] */
export function parseReportTime(text) {
  const m = REPORT_TIME_RE.exec(String(text || ''));
  if (!m) return [null, null];
  const d1 = makeDate(Number(m[1]), Number(m[2]), Number(m[3]));
  if (!d1) return [null, null];
  if (!m[6]) return [d1, d1];
  const d2 = makeDate(Number(m[4] || m[1]), Number(m[5] || m[2]), Number(m[6]));
  if (!d2) return [null, null];
  return [d1, d2];
}

/** 解析一份周报 txt（引擎输出的固定格式），返回条目列表（对应 parse_weekly_report） */
export function parseWeeklyReport(file) {
  let text = fs.readFileSync(String(file), 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r\n|[\r\n\v\f\u0085\u2028\u2029]/);
  const items = [];
  let cur = null;
  const indent = (s) => s.startsWith(' ') || s.startsWith('\t');
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) continue;
    const head = /^【(.+?)】$/.exec(stripped);
    if (head && !indent(line)) {
      if (cur && cur.subject) items.push(cur);
      cur = {
        category: head[1].trim(), school: '', time: '', subject: '', work: '', progress: '',
      };
      continue;
    }
    if (cur === null) continue;
    if (!indent(line)) {
      if (!cur.school) cur.school = stripped;
      continue;
    }
    for (const [key, label] of [['time', '时间'], ['subject', '事项'], ['work', '工作内容'], ['progress', '进度']]) {
      const m = new RegExp(`^${label}\\s*[:：]\\s*(.*)$`).exec(stripped);
      if (m) {
        cur[key] = m[1].trim();
        break;
      }
    }
  }
  if (cur && cur.subject) items.push(cur);

  return items.map((it) => {
    const [d1, d2] = parseReportTime(it.time);
    return {
      category: it.category,
      school: it.school,
      subject: it.subject,
      d1,
      d2,
      settled: it.progress.startsWith('100'),
      note: null,
      file: path.basename(String(file)),
    };
  });
}

/** 本月各周的周报文件（按周结束日期所在月归属，对应 weekly_reports_for_month） */
export function weeklyReportsForMonth(outDir, year, month) {
  const out = [];
  const root = String(outDir || '');
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return out;
  const folders = [root];
  try {
    for (const name of fs.readdirSync(root)) {
      const full = path.join(root, name);
      try {
        if (fs.statSync(full).isDirectory()) folders.push(full);
      } catch { /* 跳过打不开的项 */ }
    }
  } catch { /* 目录读不了 */ }
  for (const folder of folders) {
    let names;
    try {
      names = fs.readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('周报_') || !name.endsWith('.txt')) continue;
      const m = WEEK_FILE_RE.exec(name);
      if (!m) continue;
      const end = toDate(m[2]);
      if (!end) continue;
      if (end.getFullYear() === Number(year) && end.getMonth() + 1 === Number(month)) {
        out.push(path.join(folder, name));
      }
    }
  }
  return [...new Set(out)].sort();
}

/** 读本月各周周报，返回 { items, files }（对应 collect_week_items） */
export function collectWeekItems(outDir, year, month, log = console.log) {
  const items = [];
  const files = [];
  for (const p of weeklyReportsForMonth(outDir, year, month)) {
    let got;
    try {
      got = parseWeeklyReport(p);
    } catch (e) {
      if (log) log(`提示：周报读取失败 ${path.basename(p)}：${e.message}`);
      continue;
    }
    if (!got.length) {
      if (log) log(`提示：周报里没解析出条目 ${path.basename(p)}`);
      continue;
    }
    items.push(...got);
    files.push(path.basename(p));
  }
  return { items, files };
}

// ---------------------------------------------------------------------------
// 核对（check_perf_xlsx / perf_check_report）
// ---------------------------------------------------------------------------

function dateText(d) {
  return d ? isoDate(d) : 'None';
}

/** `内容，起~止`（对应 _perf_row_line） */
export function perfRowLine(row) {
  const d1 = row && row.d1;
  const d2 = row && row.d2;
  let when = '';
  if (d1 && d2) when = isoDate(d1) !== isoDate(d2) ? `，${isoDate(d1)}~${isoDate(d2)}` : `，${isoDate(d1)}`;
  return `${(row && row.content) || ''}${when}`;
}

/** 表里的时间范围是否覆盖要求的时间范围（对应 _range_covers） */
export function rangeCovers(tableRow, expectedRow) {
  const t1 = tableRow.d1;
  const t2 = tableRow.d2;
  const e1 = expectedRow.d1;
  const e2 = expectedRow.d2;
  if (e1 && (!t1 || isoDate(t1) > isoDate(e1))) return false;
  if (e2 && (!t2 || isoDate(t2) < isoDate(e2))) return false;
  return true;
}

function pyEqual(a, b) {
  const blankA = a === null || a === undefined;
  const blankB = b === null || b === undefined;
  if (blankA || blankB) return blankA && blankB;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

function rowEquals(a, b) {
  return String(a.category || '') === String(b.category || '')
    && String(a.content || '') === String(b.content || '')
    && dateText(a.d1) === dateText(b.d1)
    && dateText(a.d2) === dateText(b.d2)
    && !!a.settled === !!b.settled
    && pyEqual(a.note, b.note);
}

/** 备份文件名用的时间戳：Windows 文件名不允许冒号，统一用 - 与 _ */
function stampForFile() {
  const d = new Date();
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function stampNow() {
  const d = new Date();
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 核对绩效表：内容（对照本月周报）/ 时间 / 完成标记 / 格式（对应 check_perf_xlsx）。
 * 返回 { ok, text }；fix=true 时先补齐/校正再出报告。
 */
export async function checkPerfXlsx(file, year, month, handler = DEFAULT_HANDLER, opts = {}) {
  const {
    weekItems = null, weekFiles = null, platformItems = null,
    fix = false, platformFix = false, log = console.log,
  } = opts || {};

  const tag = perfMonthText(year, month);
  const head = [`绩效表核对 · ${tag} · ${handler}`, `核对时间：${stampNow()}`, `文件：${file}`];
  if (!fs.existsSync(String(file)) || !fs.statSync(String(file)).isFile()) {
    return { ok: false, text: [...head, '', '结论：不通过（找不到绩效表文件）'].join('\n') };
  }

  let wb = await readWorkbook(file);
  let ws = perfSheetOf(wb);
  let lay = detectPerfLayout(ws);
  let start = lay.firstRow;
  let cap = lay.cap;
  let secRow = lay.secRow;
  let rawRows = readPerfRows(ws, start, cap, lay);
  const problems = [];
  const tips = [];
  const contentLines = [];
  const fixLines = [];

  // ---- 先修再核 ----
  if ((fix && weekItems !== null && weekItems !== undefined) || (platformFix && platformItems)) {
    let expected = mergePerfRows(itemsToPerfRows(weekItems || []));
    if (platformFix && platformItems) expected = mergePerfRows(expected, itemsToPerfRows(platformItems));
    const merged = mergePerfRows(rawRows, expected, { preferNew: true });
    const before = new Map(rawRows.map((r) => [perfKey(r.content), r]));
    const after = new Map(merged.map((r) => [perfKey(r.content), r]));
    const added = [...after.keys()].filter((k) => !before.has(k)).map((k) => after.get(k));
    const updated = [...after.keys()].filter((k) => before.has(k) && !rowEquals(after.get(k), before.get(k)))
      .map((k) => after.get(k));
    if (added.length || updated.length) {
      writeTaskRows(ws, merged, start, lay);
      fixScoreFormulas(ws);
      let target = file;
      try {
        await saveAtomic(wb, file);
      } catch (e) {
        if (!isFileLockedError(e)) {
          target = null;
          problems.push(`修补失败：${e.message}`);
        } else {
          target = `${path.join(path.dirname(String(file)), path.basename(String(file), path.extname(String(file))))}_新.xlsx`;
          try {
            await saveAtomic(wb, target);
            head.push(`（原文件被 Excel 占用，修补结果写到 ${path.basename(target)}；关掉 Excel 后再点一次即可直接写回原文件）`);
          } catch (e2) {
            target = null;
            problems.push(`修补失败：${e2.message}`);
          }
        }
      }
      if (target) {
        wb = await readWorkbook(target);
        ws = perfSheetOf(wb);
        lay = detectPerfLayout(ws);
        start = lay.firstRow;
        cap = lay.cap;
        secRow = lay.secRow;
        rawRows = readPerfRows(ws, start, cap, lay);
        if (added.length) {
          const more = added.length > 10 ? '…' : '';
          fixLines.push(`自动补齐 ${added.length} 条：${added.slice(0, 10).map(perfRowLine).join('；')}${more}`);
        }
        if (updated.length) {
          const more = updated.length > 10 ? '…' : '';
          fixLines.push(`校正 ${updated.length} 条（起止时间 / 完成标记）：${updated.slice(0, 10).map((r) => r.content).join('；')}${more}`);
        }
      }
      void log;
    }
  }

  const table = mergePerfRows(rawRows);

  if (weekItems !== null && weekItems !== undefined) {
    const expected = mergePerfRows(itemsToPerfRows(weekItems));
    const byKey = new Map(table.map((r) => [perfKey(r.content), r]));
    const expKey = new Map(expected.map((r) => [perfKey(r.content), r]));
    const missing = [...expKey.entries()].filter(([k]) => !byKey.has(k)).map(([, r]) => r);
    const extra = [...byKey.entries()].filter(([k]) => !expKey.has(k)).map(([, r]) => r);
    const dateBad = [];
    const doneBad = [];
    for (const [k, exp] of expKey.entries()) {
      const got = byKey.get(k);
      if (!got) continue;
      if (!rangeCovers(got, exp)) dateBad.push([got, exp]);
      if (!!got.settled !== !!exp.settled) doneBad.push([got, exp]);
    }
    const dupKeys = new Map();
    for (const r of rawRows) {
      const k = perfKey(r.content);
      dupKeys.set(k, (dupKeys.get(k) || 0) + 1);
    }
    const dups = [...dupKeys.entries()].filter(([, c]) => c > 1).map(([k]) => k);

    contentLines.push(`  本月周报 ${(weekFiles || []).length} 篇`
      + ((weekFiles && weekFiles.length) ? `：${weekFiles.join('、')}` : ''));
    contentLines.push(`  周报事项 ${(weekItems || []).length} 条（合并同一事项后 ${expected.length} 条）`);
    contentLines.push(`  表内事项 ${table.length} 条`);
    if (missing.length) {
      problems.push(`缺少 ${missing.length} 条周报事项`);
      contentLines.push(`  ✗ 缺少 ${missing.length} 条（周报里有、表里没有）`);
      for (const r of missing.slice(0, 30)) contentLines.push(`    - ${perfRowLine(r)}`);
    } else {
      contentLines.push('  ✓ 周报里的事项都在表内');
    }
    if (dateBad.length) {
      problems.push(`时间不一致 ${dateBad.length} 条`);
      contentLines.push(`  ✗ 起止时间与周报不一致 ${dateBad.length} 条`);
      for (const [got, exp] of dateBad.slice(0, 30)) {
        contentLines.push(`    - ${exp.content}：表里 ${dateText(got.d1)}~${dateText(got.d2)}，周报 ${dateText(exp.d1)}~${dateText(exp.d2)}`);
      }
    } else {
      contentLines.push('  ✓ 起止时间与周报一致');
    }
    if (doneBad.length) {
      problems.push(`完成标记不一致 ${doneBad.length} 条`);
      contentLines.push(`  ✗ 完成标记与周报进度不一致 ${doneBad.length} 条`);
      for (const [got, exp] of doneBad.slice(0, 30)) {
        contentLines.push(`    - ${exp.content}：表里 ${got.settled ? '是' : '否'}，周报进度 ${exp.settled ? '100%' : '未完成'}`);
      }
    } else {
      contentLines.push('  ✓ 完成标记与周报进度一致');
    }
    if (dups.length) {
      problems.push(`表内重复 ${dups.length} 条`);
      contentLines.push(`  ✗ 同一事项出现多行 ${dups.length} 条`);
      for (const k of dups.slice(0, 10)) contentLines.push(`    - ${k}`);
    } else {
      contentLines.push('  ✓ 没有重复行');
    }
    if (extra.length) {
      tips.push(`表里另有 ${extra.length} 条不在本月周报里（可能是手工补录或往月遗留，未动）`);
      contentLines.push(`  · 表里多出 ${extra.length} 条（周报里没有）`);
      for (const r of extra.slice(0, 10)) contentLines.push(`    - ${perfRowLine(r)}`);
    }
  } else {
    contentLines.push(`  表内事项 ${table.length} 条（本次没有可比对的本月周报）`);
  }

  // ---- 格式 ----
  const fmtLines = [];
  let fmtOk = true;
  const mark = (cond, okText, badText) => {
    if (cond) {
      fmtLines.push(`  ✓ ${okText}`);
    } else {
      fmtLines.push(`  ✗ ${badText}`);
      problems.push(badText);
      fmtOk = false;
    }
  };

  mark(!!cellValue(ws.getRow(2), 2), '表头标题在（B2）', '表头标题丢了（B2 为空）');
  const d3 = cellText(ws, 3, 4);
  mark(d3.trim() === String(handler).trim(), `处理人 ${handler}（D3）`,
    `处理人不是 ${handler}（D3=${rawText(cellValue(ws.getRow(3), 4))}）`);
  const d4 = cellText(ws, 4, 4);
  mark(d4.includes(tag), `考核月份 ${tag}（D4）`,
    `考核月份不是 ${tag}（D4=${rawText(cellValue(ws.getRow(4), 4))}）`);
  mark(cellValue(ws.getRow(3), 11) !== null, '填报时间已填（K3）', '填报时间为空（K3）');

  const incomplete = [];
  table.forEach((row, i) => {
    if (!(row.content && row.category && row.d1 && row.d2)) incomplete.push(start + i);
  });
  mark(!incomplete.length,
    `${table.length} 行数据完整（类别 / 内容 / 起止时间 / 是否完成）`,
    `${incomplete.length} 行数据不完整：第 ${incomplete.join('、')} 行`);

  const used = [];
  for (let i = 0; i < cap; i += 1) {
    const v = cellValue(ws.getRow(start + i), PERF_CONTENT_COL);
    if (v !== null && v !== '') used.push(start + i);
  }
  const gap = used.length > 0 && used.some((r, i) => r !== used[0] + i);
  mark(!gap,
    used.length ? `任务行连续（第 ${used[0]}–${used[used.length - 1]} 行）` : '任务行没有数据',
    '任务行中间有空洞，打印出来会断开');

  const mergedRanges = mergeTexts(ws);
  const broken = [];
  for (let i = 0; i < table.length; i += 1) {
    for (const rng of [`B${start + i}:C${start + i}`, `D${start + i}:I${start + i}`, `M${start + i}:N${start + i}`]) {
      if (!mergedRanges.has(rng)) broken.push(rng);
    }
  }
  mark(!broken.length, '合并单元格齐全（B:C / D:I / M:N）',
    `合并单元格缺失：${broken.slice(0, 8).join('、')}`);

  const fontsBad = [];
  const fmtBad = [];
  for (let i = 0; i < table.length; i += 1) {
    const r = start + i;
    const row = ws.getRow(r);
    for (const c of [PERF_CAT_COL, PERF_CONTENT_COL, PERF_START_COL, PERF_END_COL, PERF_DONE_COL]) {
      const font = row.getCell(c).font || {};
      if ((font.name || '') !== '微软雅黑' || (font.size || 0) !== 10) {
        fontsBad.push(`${String.fromCharCode(64 + c)}${r}`);
      }
    }
    for (const c of [PERF_START_COL, PERF_END_COL]) {
      const nf = row.getCell(c).numFmt || '';
      if (!nf.includes('y')) fmtBad.push(`${String.fromCharCode(64 + c)}${r}`);
    }
  }
  mark(!fontsBad.length, '字体统一（微软雅黑 10 号）', `字体不一致：${fontsBad.slice(0, 8).join('、')}`);
  mark(!fmtBad.length, '日期格式 yyyy/m/d', `日期格式不对：${fmtBad.slice(0, 8).join('、')}`);

  const secVal = ws.getCell(secRow, PERF_CAT_COL).value;
  mark(typeof secVal === 'string' && secVal.includes('工作任务考核'),
    `考核区块位置正常（第 ${secRow} 行）`,
    `考核区块位置异常（第 ${secRow} 行不是「工作任务考核」）`);

  const wanted = scoreFormulas(ws);
  if (wanted) {
    const k4 = cellFormula(ws.getRow(4), 11);
    const m4 = cellFormula(ws.getRow(4), 13);
    mark(k4 === wanted[0] && m4 === wanted[1],
      '考核评分公式指向考核区块（K4/M4）',
      `考核评分公式没跟着区块走（K4=${rawText(k4)} / M4=${rawText(m4)}）`);
  }

  // ---- 研发平台比对（只提示，不参与结论） ----
  const platLines = [];
  if (platformItems) {
    const platExp = mergePerfRows(itemsToPerfRows(platformItems));
    const keys = new Set(table.map((r) => perfKey(r.content)));
    const platMissing = platExp.filter((r) => !keys.has(perfKey(r.content)));
    platLines.push(`  平台本月事项 ${platExp.length} 条，表内缺 ${platMissing.length} 条`);
    if (platMissing.length) {
      tips.push(`平台本月还有 ${platMissing.length} 条不在表里（多半是还没生成到对应周的周报，未自动补）`);
      for (const r of platMissing.slice(0, 20)) platLines.push(`    · ${perfRowLine(r)}`);
    }
  }

  const conclusion = problems.length ? `不通过（${problems.length} 项待处理）` : '通过';
  const out = [...head, '', '一、内容（对照本月各周周报）', ...contentLines];
  out.push('', '二、格式', ...fmtLines);
  if (platLines.length) out.push('', '三、研发平台比对（仅供参考）', ...platLines);
  if (tips.length) out.push('', '· 提示（不算错误）', ...tips.map((t) => `  - ${t}`));
  if (fixLines.length) out.push('', '· 本次顺手修补', ...fixLines.map((t) => `  - ${t}`));
  out.push('', `结论：${conclusion}`);
  void fmtOk;
  return { ok: !problems.length, text: out.join('\n') };
}

/**
 * 跑一次核对，打印报告并写旁边同名 `_核对.txt`（对应 perf_check_report）。
 * opts.outDir 是周报目录（Python 的 OUT_DIR），用来收集本月各周周报。
 */
export async function perfCheckReport(opts) {
  const {
    path: perfPath, year, month, handler = DEFAULT_HANDLER, platformItems = null,
    fix = false, saveReport = true, extraItems = null, platformFix = false,
    outDir = process.env.WEEKLY_OUT_DIR || '', log = console.log,
  } = opts || {};

  const collected = collectWeekItems(outDir, year, month, log);
  let weekItems = collected.items;
  const weekFiles = collected.files;
  if (extraItems && extraItems.length) weekItems = [...weekItems, ...extraItems];
  const { ok, text } = await checkPerfXlsx(perfPath, year, month, handler, {
    weekItems, weekFiles, platformItems, fix, platformFix, log,
  });
  log('');
  log(text);
  log('');
  let reportPath = null;
  if (saveReport) {
    reportPath = `${path.join(path.dirname(String(perfPath)), path.basename(String(perfPath), path.extname(String(perfPath))))}_核对.txt`;
    try {
      // Python 用文本模式写，Windows 上是 CRLF；这里照抄，报告文件逐字节同构
      const body = `${text}\n`.replace(/\n/g, process.platform === 'win32' ? '\r\n' : '\n');
      fs.writeFileSync(reportPath, body, 'utf8');
      log(`核对报告：${reportPath}`);
    } catch (e) {
      log(`提示：核对报告写入失败：${e.message}`);
      reportPath = null;
    }
  }
  return { ok, text, reportPath };
}

// ---------------------------------------------------------------------------
// 挑表（auto_pick_xlsx）
// ---------------------------------------------------------------------------

/**
 * 在考核表目录里挑出目标日期所在月份的文件；没有则用最近修改的那张。
 * 返回 null 表示目录里一张表都没有（新装机器就是这样）。
 */
export function autoPickXlsx(folder, targetDate, log = console.log) {
  let names;
  try {
    names = fs.readdirSync(String(folder));
  } catch {
    return null;
  }
  const files = names
    .filter((n) => n.toLowerCase().endsWith('.xlsx') && !n.startsWith('~$'))
    .map((n) => path.join(String(folder), n))
    .sort();
  if (!files.length) return null;
  const tag = `${targetDate.getFullYear()}年${String(targetDate.getMonth() + 1).padStart(2, '0')}月`;
  for (const f of files) {
    if (path.basename(f).includes(tag)) return f;
  }
  const mtime = (f) => {
    try {
      return fs.statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  };
  let newest = files[0];
  for (const f of files) {
    const a = mtime(f);
    const b = mtime(newest);
    if (a > b || (a === b && f > newest)) newest = f;
  }
  if (log) {
    log(`警告：没有 ${targetDate.getFullYear()}年${targetDate.getMonth() + 1}月 的考核表，`
      + `改用最近修改的 ${path.basename(newest)}`);
  }
  return newest;
}
