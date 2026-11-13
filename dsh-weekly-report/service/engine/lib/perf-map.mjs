/**
 * 绩效表结构识别（v1.1.0）
 *
 * 背景：原实现把列位置写死（B/D/J/K/L/M）、明细固定从第 7 行开始。
 * 使用者换一张版式略有差异的模板（比如「任务名称」在 E 列、多一列「工时」）
 * 就会写错位置，甚至把整块结构改掉。
 *
 * 这里改成「按表头文字找列、按区块标题找行」，识别不出来的字段退回默认位置，
 * 并把识别结果原样暴露到面板上，让人一眼能核对「我要写的格子对不对」。
 */
import { cellValue, isMergedSlave, pyStr } from './xlsx.mjs';

/** 各字段可能的表头写法（按优先级匹配，越靠前越可靠） */
const HEADER_ALIASES = {
  category: ['类别', '分类', '类型', '工作类别'],
  content: ['任务名称', '工作任务', '工作内容', '事项名称', '任务', '事项', '内容'],
  start: ['开始时间', '开始日期', '起始时间', '起始日期', '开始'],
  end: ['结束时间', '结束日期', '完成时间', '终止时间', '结束'],
  done: ['是否完成', '完成情况', '完成状态', '状态'],
  note: ['评定', '备注', '说明', '评价'],
};

/** 默认位置（识别失败时兜底，与历史模板一致） */
export const DEFAULT_LAYOUT = {
  headerRow: 6,
  firstRow: 7,
  cap: 15,
  secRow: 22,
  cols: { category: 2, content: 4, start: 10, end: 11, done: 12, note: 13 },
  info: {
    handler: { row: 3, col: 4 },
    month: { row: 4, col: 4 },
    fillTime: { row: 3, col: 11 },
  },
  detected: false,
  missing: [],
};

function text(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return '';
  return String(v).replace(/\s+/g, '');
}

/** 在一行里按别名找列号 */
function findCol(ws, row, aliases) {
  const maxCol = Math.max(ws.columnCount || 0, 20);
  for (const alias of aliases) {
    for (let c = 1; c <= maxCol; c += 1) {
      const t = text(ws.getCell(row, c));
      if (!t) continue;
      if (t === alias || t.includes(alias)) return c;
    }
  }
  return null;
}

/** 找「被考评人 / 考评时间 / 填报时间」这类标签右侧的填写格 */
function findInfoCell(ws, labels, maxRow = 6) {
  const maxCol = Math.max(ws.columnCount || 0, 20);
  for (let r = 1; r <= Math.min(maxRow, ws.rowCount || maxRow); r += 1) {
    for (let c = 1; c <= maxCol; c += 1) {
      const t = text(ws.getCell(r, c));
      if (!t) continue;
      if (!labels.some((l) => t.includes(l))) continue;
      // 标签本身可能在合并区里，右侧第一个「非从属」格才是值
      for (let k = c + 1; k <= Math.min(maxCol, c + 8); k += 1) {
        if (isMergedSlave(ws, r, k)) continue;
        return { row: r, col: k, label: t };
      }
    }
  }
  return null;
}

/** 找「工作任务考核」区块所在行（决定可写行数） */
function findSectionRow(ws, firstRow, aliases = ['工作任务考核', '工作任务', '本月任务']) {
  for (let r = firstRow; r <= (ws.rowCount || 0); r += 1) {
    for (let c = 1; c <= 3; c += 1) {
      const t = text(ws.getCell(r, c));
      if (t && aliases.some((a) => t.includes(a))) return r;
    }
  }
  return null;
}

/**
 * 识别月度考核表的版式。
 * @returns 布局对象（含 detected/missing 便于界面提示）
 */
export function detectPerfLayout(ws) {
  const layout = {
    headerRow: DEFAULT_LAYOUT.headerRow,
    firstRow: DEFAULT_LAYOUT.firstRow,
    cap: DEFAULT_LAYOUT.cap,
    secRow: DEFAULT_LAYOUT.secRow,
    cols: { ...DEFAULT_LAYOUT.cols },
    info: {
      handler: { ...DEFAULT_LAYOUT.info.handler },
      month: { ...DEFAULT_LAYOUT.info.month },
      fillTime: { ...DEFAULT_LAYOUT.info.fillTime },
    },
    detected: false,
    missing: [],
  };

  // ① 找表头行：命中字段数最多的一行（至少 3 个字段）
  let best = { row: null, score: 0 };
  for (let r = 1; r <= Math.min(20, ws.rowCount || 0); r += 1) {
    let score = 0;
    for (const aliases of Object.values(HEADER_ALIASES)) {
      if (findCol(ws, r, aliases)) score += 1;
    }
    if (score > best.score) best = { row: r, score };
  }
  if (!best.row || best.score < 3) {
    layout.missing = Object.keys(HEADER_ALIASES);
    return layout;
  }
  layout.headerRow = best.row;
  layout.firstRow = best.row + 1;

  // ② 逐字段定位列
  layout.missing = [];
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const c = findCol(ws, best.row, aliases);
    if (c) layout.cols[key] = c;
    else layout.missing.push(key);
  }
  // 「类别」和「内容」不能是同一列，否则说明认错了
  if (layout.cols.category === layout.cols.content) layout.cols.category = DEFAULT_LAYOUT.cols.category;

  // ③ 区块行 → 可写行数
  const secRow = findSectionRow(ws, layout.firstRow);
  if (secRow && secRow > layout.firstRow) {
    layout.secRow = secRow;
    layout.cap = secRow - layout.firstRow;
  } else {
    layout.secRow = layout.firstRow + layout.cap;
  }

  // ④ 基本信息格
  const handler = findInfoCell(ws, ['被考评人', '姓名', '员工姓名']);
  const month = findInfoCell(ws, ['考评时间', '考核时间', '考核月份', '考评月份']);
  const fill = findInfoCell(ws, ['填报时间', '填表时间', '填报日期']);
  if (handler) layout.info.handler = { row: handler.row, col: handler.col };
  if (month) layout.info.month = { row: month.row, col: month.col };
  if (fill) layout.info.fillTime = { row: fill.row, col: fill.col };

  layout.detected = true;
  return layout;
}

/** 供面板展示：把布局翻译成人话 */
export function describeLayout(layout) {
  const colName = (c) => {
    let n = Number(c);
    let s = '';
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };
  const { cols } = layout;
  return {
    表头行: layout.headerRow,
    明细起止: `${layout.firstRow} ~ ${layout.firstRow + layout.cap - 1}（共 ${layout.cap} 行）`,
    区块行: layout.secRow,
    类别列: colName(cols.category),
    任务名称列: colName(cols.content),
    开始时间列: colName(cols.start),
    结束时间列: colName(cols.end),
    是否完成列: colName(cols.done),
    评定列: colName(cols.note),
    被考评人格: `${colName(layout.info.handler.col)}${layout.info.handler.row}`,
    考评时间格: `${colName(layout.info.month.col)}${layout.info.month.row}`,
    填报时间格: `${colName(layout.info.fillTime.col)}${layout.info.fillTime.row}`,
  };
}

/** 结构指纹：写前写后各取一次，用来确认「除了该填的格子，别处没被动过」 */
export function structureSignature(ws) {
  const merges = [];
  const raw = ws && ws._merges ? Object.values(ws._merges) : [];
  for (const m of raw) if (m) merges.push(String(m.range));
  merges.sort();
  const sections = [];
  for (let r = 1; r <= (ws.rowCount || 0); r += 1) {
    const t = pyStr(cellValue(ws.getRow(r), 2) || '').replace(/\s+/g, '');
    if (/考核|合计/.test(t)) sections.push(`${r}:${t.slice(0, 16)}`);
  }
  return {
    rowCount: ws.rowCount || 0,
    colCount: ws.columnCount || 0,
    mergeCount: merges.length,
    merges: merges.join('|'),
    sections: sections.join('|'),
  };
}

/** 两个指纹的差异（只报关键项，避免刷屏） */
export function signatureDiff(before, after) {
  const out = [];
  if (before.rowCount !== after.rowCount) out.push(`总行数 ${before.rowCount} → ${after.rowCount}`);
  if (before.colCount !== after.colCount) out.push(`总列数 ${before.colCount} → ${after.colCount}`);
  if (before.mergeCount !== after.mergeCount) out.push(`合并区数量 ${before.mergeCount} → ${after.mergeCount}`);
  if (before.sections !== after.sections) {
    const a = before.sections.split('|').filter(Boolean);
    const b = after.sections.split('|').filter(Boolean);
    const moved = b.filter((x) => !a.includes(x));
    if (moved.length) out.push(`考核区块移动：${moved.join('、')}`);
  }
  if (before.merges !== after.merges && before.mergeCount === after.mergeCount) {
    out.push('合并区位置发生变化');
  }
  return out;
}
