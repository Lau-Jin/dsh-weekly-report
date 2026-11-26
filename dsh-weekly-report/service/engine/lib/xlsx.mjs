/**
 * 绩效表底层读写（Node 版，exceljs）——对应 gen_weekly_text.py 的
 *   read_rows(280) / _shift_rows_down(1963) / _save_xlsx_atomic(2191)
 *
 * 与 Python 版（openpyxl）的对应关系：
 *   · 单元格「值」的语义：公式取缓存结果、富文本拼成纯文本、日期按表里的显示日；
 *     Python 用 data_only=True / str(v) / to_date(v) 做的三件事，在这里由 cellValue() 统一。
 *   · 日期的「挂钟」口径：openpyxl 的 datetime 是"墙上时间"，exceljs 的 Date 是
 *     "UTC 当墙上时间"（excelToDate 用 Date.UTC 口径还原序列号）。所以：
 *       - cellValue() 把 exceljs 的 Date 还原成「本地墙上时间」（getUTC* → new Date(...)）；
 *       - setCell() 反过来把这些本地 Date 折成 Date.UTC(...) 再交给 exceljs。
 *     这样序列号在 +08:00 / UTC-5 等任何时区都保持一致（否则 UTC 午夜在负时区会退一天）。
 *   · 合并单元格：openpyxl 里从属格是 MergedCell（写它会报错，Python 一律跳过），
 *     这里用 isMergedSlave() 判定并跳过，保证"只写左上角、其余不动"。
 *
 * exceljs 4.4.0 有一个真实文件的坑（2026-11 的绩效表就踩到了）：
 *   若绘图部件（xl/drawings/*.xml）用默认命名空间写（<wsDr> 而不是 <xdr:wsDr>，
 *   常见于 WPS / 某些导出工具），exceljs 解析出 model 为 null，
 *   reconcile() 里 `drawing.anchors` 直接 TypeError，**整张表都读不出来**。
 *   这里在内存里给绘图标签补 xdr: 前缀（不改 node_modules、不影响其它文件），
 *   保住封面上的图片；万一还是解析失败，退化为"跳过绘图"，表格照读，图片会丢。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');

/** 绩效表工作表名（模板里叫「月度考核」） */
export const PERF_SHEET_TITLE = '月度考核';

// ---------------------------------------------------------------------------
// exceljs 补丁：绘图部件的默认命名空间
// ---------------------------------------------------------------------------

/** spreadsheetDrawing 命名空间里的元素（无前缀写法时补上 xdr:） */
const DRAWING_TAGS = new Set([
  'wsDr', 'twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor',
  'from', 'to', 'ext', 'col', 'colOff', 'row', 'rowOff',
  'pic', 'nvPicPr', 'cNvPr', 'cNvPicPr', 'blipFill', 'spPr', 'clientData',
  'sp', 'nvSpPr', 'cNvSpPr', 'txBody', 'style',
  'grpSp', 'grpSpPr', 'graphicFrame', 'nvGraphicFramePr',
  'cxnSp', 'nvCxnSpPr', 'contentPart',
]);

/** 给绘图 XML 里没有前缀的元素名补 `xdr:`（只动白名单里的标签，a:/r: 一律不碰） */
export function prefixDrawingTags(xml) {
  return String(xml).replace(/<(\/?)([A-Za-z_][\w.:-]*)(?=[\s/>])/g, (whole, slash, tag) => {
    if (tag.includes(':') || !DRAWING_TAGS.has(tag)) return whole;
    return `<${slash}xdr:${tag}`;
  });
}

/** 把（zip 里的）流读成 Buffer */
async function readAll(stream) {
  if (Buffer.isBuffer(stream)) return stream;
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

let patchesInstalled = false;
let drawingsDropped = false;

/** 装补丁（幂等）；exceljs 内部结构变了就安静地不装，正常文件照读 */
function installExceljsPatches() {
  if (patchesInstalled) return;
  patchesInstalled = true;
  let XLSX;
  let DrawingXform;
  try {
    XLSX = require('exceljs/lib/xlsx/xlsx.js');
    DrawingXform = require('exceljs/lib/xlsx/xform/drawing/drawing-xform.js');
  } catch {
    return;
  }
  const origProcess = XLSX.prototype && XLSX.prototype._processDrawingEntry;
  if (typeof origProcess === 'function' && typeof DrawingXform === 'function') {
    XLSX.prototype._processDrawingEntry = async function processDrawingEntry(entry, model, name) {
      try {
        const xml = (await readAll(entry)).toString('utf8');
        const fixed = prefixDrawingTags(xml);
        model.drawings[name] = await new DrawingXform().parseStream([
          Buffer.from(fixed, 'utf8'),
        ]);
      } catch {
        // 解析不出来就当成空的绘图：表格数据/样式照常，只是这张图会丢
        drawingsDropped = true;
        model.drawings[name] = { anchors: [] };
      }
    };
  }
  const origReconcile = XLSX.prototype && XLSX.prototype.reconcile;
  if (typeof origReconcile === 'function') {
    XLSX.prototype.reconcile = function reconcile(model, options) {
      Object.keys(model.drawings || {}).forEach((name) => {
        const drawing = model.drawings[name];
        if (!drawing || !Array.isArray(drawing.anchors)) {
          drawingsDropped = true;
          model.drawings[name] = { anchors: [] };
        }
      });
      return origReconcile.call(this, model, options);
    };
  }
}

/** 最近一次 readWorkbook() 有没有因为绘图部件而丢图（供上层提示） */
export function drawingsWereDropped() {
  return drawingsDropped;
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

/**
 * 打开工作簿（保留样式 / 公式 / 合并 / 列宽 / 图片）。
 * 注意：公式单元格读到的是 { formula, result }，取值走 cellValue()。
 */
export async function readWorkbook(file) {
  installExceljsPatches();
  drawingsDropped = false;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb;
}

/**
 * 取工作表（对应 Python perf_sheet / read_rows 里的挑表逻辑）：
 *   opts.mode='contains'（默认）→ 第一个名字含 matchTitle 的表，找不到退回第 2 张；
 *   opts.mode='exact'          → 名字完全相等，找不到用最后一张（perf_sheet 的口径）。
 */
export function openSheet(wb, matchTitle = PERF_SHEET_TITLE, opts = {}) {
  const sheets = (wb && wb.worksheets) || [];
  if (!sheets.length) throw new Error('工作簿里没有工作表');
  const title = matchTitle == null ? '' : String(matchTitle);
  const exact = opts.mode === 'exact';
  const found = sheets.find((ws) => (exact ? ws.name === title : ws.name.includes(title)));
  if (found) return found;
  if (exact || opts.fallback === 'last') return sheets[sheets.length - 1];
  return sheets.length > 1 ? sheets[1] : sheets[sheets.length - 1];
}

/** exceljs 的 Date → 本地"墙上时间" Date（UTC 字段搬过来，见文件头说明） */
export function fromExcelDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return new Date(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(),
  );
}

/** 本地"墙上时间" Date → exceljs 认的 Date（Date.UTC 口径） */
export function toExcelDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(
    d.getFullYear(), d.getMonth(), d.getDate(),
    d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds(),
  ));
}

/**
 * Python 的 str()：日期/数字/布尔都按 Python 的写法转文本（对应 f"{v}" / str(v)）。
 * 日期按 datetime 写（openpyxl 读日期格式的单元格一律给 datetime，
 * str() 就带 00:00:00；实测 11 张真实表都是这个口径）。
 */
export function pyStr(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const d = fromExcelDate(v);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const time = [
      String(d.getHours()).padStart(2, '0'),
      String(d.getMinutes()).padStart(2, '0'),
      String(d.getSeconds()).padStart(2, '0'),
    ].join(':');
    const ms = d.getMilliseconds();
    return ms ? `${date} ${time}.${String(ms * 1000).padStart(6, '0')}` : `${date} ${time}`;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'object') return ''; // 公式/富文本等由 cellValue 先归一化
  return String(v);
}

/** 单元格「显示值」：兼容 公式 / 富文本 / 超链接 / 日期 / 数字（对应 openpyxl data_only 的取值） */
export function cellValue(row, col) {
  const raw = row.getCell(col).value;
  return normalizeValue(raw);
}

function normalizeValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return fromExcelDate(raw);
  if (typeof raw !== 'object') return raw;
  if (Array.isArray(raw.richText)) return raw.richText.map((t) => (t && t.text) || '').join('');
  // 超链接单元格：{ text, hyperlink }，text 本身可能又是富文本
  if ('text' in raw) return normalizeValue(raw.text);
  if ('error' in raw) return raw.error; // #N/A 之类
  if ('formula' in raw || 'sharedFormula' in raw) {
    const result = raw.result;
    if (result === undefined || result === null) return null;
    return result instanceof Date ? fromExcelDate(result) : result;
  }
  return raw;
}

/** 公式文本（带 '='，与 openpyxl cell.value 一致）；非公式返回 '' */
export function cellFormula(row, col) {
  const raw = row.getCell(col).value;
  if (!raw || typeof raw !== 'object') return '';
  if (typeof raw.formula === 'string') return `=${raw.formula.replace(/^=/, '')}`;
  if (typeof raw.sharedFormula === 'string') return `=${raw.sharedFormula}`;
  return '';
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

function colToNum(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function numToCol(n) {
  let s = '';
  let v = n;
  while (v > 0) {
    const rem = (v - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

/** 当前合并区域（[{top,left,bottom,right,text}]，text 形如 'B7:C7'，与 openpyxl 的 str(rng) 一致） */
export function listMerges(ws) {
  const merges = ws && ws._merges ? Object.values(ws._merges) : [];
  const out = [];
  for (const m of merges) {
    if (!m) continue;
    out.push({
      top: m.top, left: m.left, bottom: m.bottom, right: m.right, text: m.range,
    });
  }
  return out;
}

/** 合并区域文本集合（对应 Python `{str(rng) for rng in ws.merged_cells.ranges}`） */
export function mergeTexts(ws) {
  return new Set(listMerges(ws).map((m) => m.text));
}

/** (r,c) 是合并区的从属格吗（对应 isinstance(cell, MergedCell)） */
export function isMergedSlave(ws, r, c) {
  const merges = ws && ws._merges ? Object.values(ws._merges) : [];
  for (const m of merges) {
    if (!m) continue;
    if (r >= m.top && r <= m.bottom && c >= m.left && c <= m.right
        && !(r === m.top && c === m.left)) return true;
  }
  return false;
}

function cloneStyle(style) {
  if (!style) return undefined;
  try {
    return JSON.parse(JSON.stringify(style));
  } catch {
    return undefined;
  }
}

function cloneValue(v) {
  if (v instanceof Date) return new Date(v.getTime());
  if (v && typeof v === 'object') {
    const out = Array.isArray(v) ? v.slice() : { ...v };
    if (out.result instanceof Date) out.result = new Date(out.result.getTime());
    if (Array.isArray(out.richText)) out.richText = out.richText.map((t) => ({ ...t }));
    return out;
  }
  return v;
}

/**
 * 写一个单元格（对应 openpyxl 的 `ws.cell(r, c).value = v`）。
 *   · value 为 Date 时自动折成 exceljs 的 UTC 口径；
 *   · styleFrom 给了某个单元格就沿用它的样式（对应 `dst._style = copy(src._style)`）；
 *   · opts.numFmt / opts.font 额外套用；
 *   · 合并区从属格默认跳过（与 Python 跳过 MergedCell 一致），除非 opts.force。
 * 返回是否真的写了。
 */
export function setCell(row, col, value, styleFrom, opts = {}) {
  const ws = row.worksheet || (styleFrom && styleFrom.worksheet);
  if (!opts.force && ws && isMergedSlave(ws, row.number, col)) return false;
  const cell = row.getCell(col);
  if (value === undefined) cell.value = null;
  else if (value instanceof Date) cell.value = toExcelDate(value);
  else cell.value = value;
  if (styleFrom) {
    const style = cloneStyle(styleFrom.style);
    if (style) cell.style = style;
  }
  if (opts.numFmt) cell.numFmt = opts.numFmt;
  if (opts.font) cell.font = opts.font;
  return true;
}

/**
 * 在 atRow 处插入 n 行（对应 _shift_rows_down(1963)）。
 *
 * v1.8.1 修复：旧实现「边复制边判断合并从属格」，而合并区尚未下移，
 * 目标格若落在旧合并区内就会被整格跳过（值丢失）；随后 merge 又会把
 * 从属格的样式覆盖，导致下移后的考核区块出现空白/缺边框。改为：
 *   ① 先快照受影响区域所有格子的值/样式（含从属格）与行高、全部合并区；
 *   ② 解除受影响合并区 → ③ 从下往上整块写入目标位置（每格值+样式都覆盖）；
 *   ④ 重建下移后的合并区；
 *   ⑤ 新增行从「明细区样例行」逐格复制样式与行高，并复制该行的合并区，
 *      不再硬编码 B:C / D:I / M:N，也不再跳过从属格 → 边框与模板完全一致。
 * 只动插入点及以下的行；插入点以上的标题/信息区原封不动。
 *
 * @param {object} [opts] opts.styleFromRow 指定新增行的样式来源行（默认 atRow-1）
 */
export function insertRowsAt(ws, atRow, count, opts = {}) {
  const n = Math.trunc(count);
  if (!n || n < 1) return;
  const maxRow = ws.rowCount;
  const maxCol = ws.columnCount;
  if (maxRow < atRow) return;

  // ① 快照：受影响行（含合并从属格）的值 / 样式 / 行高，以及全部合并区
  const snap = [];
  for (let r = atRow; r <= maxRow; r += 1) {
    const row = ws.getRow(r);
    const cells = [];
    for (let c = 1; c <= maxCol; c += 1) {
      const cell = row.getCell(c);
      cells.push({ value: cloneValue(cell.value), style: cloneStyle(cell.style) });
    }
    snap.push({ r, cells, height: row.height });
  }
  const merges = listMerges(ws).map((m) => ({ top: m.top, left: m.left, bottom: m.bottom, right: m.right }));

  // ② 先解除所有涉及插入点以下的合并区，避免写入时被"从属格"判定跳过
  for (const m of merges) {
    if (m.bottom < atRow) continue;
    try { ws.unMergeCells(m.top, m.left, m.bottom, m.right); } catch { /* 已解除 */ }
  }

  // ③ 从下往上整块写入：每个格子都覆盖值与样式（从属格样式也保留，merge 会再统一）
  for (let i = snap.length - 1; i >= 0; i -= 1) {
    const s = snap[i];
    const dstRow = ws.getRow(s.r + n);
    for (let c = 1; c <= maxCol; c += 1) {
      const cell = dstRow.getCell(c);
      const info = s.cells[c - 1];
      cell.value = info.value;
      cell.style = info.style;
    }
    if (s.height) dstRow.height = s.height;
  }

  // ④ 重建合并区：起点在插入点之后的整块下移 n 行
  for (const m of merges) {
    const top = m.top >= atRow ? m.top + n : m.top;
    const bottom = m.bottom >= atRow ? m.bottom + n : m.bottom;
    try { ws.mergeCells(top, m.left, bottom, m.right); } catch { /* 冲突跳过 */ }
  }

  // ⑤ 新增行：从样例行逐格复制（含每一列的边框样式），并复制样例行的合并区
  const sample = Math.trunc(opts.styleFromRow || atRow - 1);
  const sampleRow = ws.getRow(sample);
  const sampleMerges = merges.filter((m) => m.top === sample && m.bottom === sample);
  for (let r = atRow; r < atRow + n; r += 1) {
    const dstRow = ws.getRow(r);
    for (let c = 1; c <= maxCol; c += 1) {
      const cell = dstRow.getCell(c);
      cell.value = null;
      cell.style = cloneStyle(sampleRow.getCell(c).style);
    }
    if (sampleRow.height) dstRow.height = sampleRow.height;
    for (const m of sampleMerges) {
      try { ws.mergeCells(r, m.left, r, m.right); } catch { /* 已合并 */ }
    }
  }
}

/** 文件被 Excel 占用（Python 的 PermissionError） */
export function isFileLockedError(err) {
  const code = err && err.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

/**
 * 原子保存（对应 _save_xlsx_atomic(2191)）：先写同目录 .wr_tmp_*.xlsx，再 rename 覆盖。
 * 目标被 Excel 打开时会抛 isFileLockedError 的错误（Python 抛 PermissionError）。
 */
export async function saveAtomic(wb, filePath) {
  const abs = path.resolve(String(filePath));
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.wr_tmp_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.xlsx`);
  try {
    await wb.xlsx.writeFile(tmp);
    fs.renameSync(tmp, abs);
    return abs;
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    } catch { /* 清理失败不影响结果 */ }
  }
}

export { ExcelJS, numToCol, colToNum };
