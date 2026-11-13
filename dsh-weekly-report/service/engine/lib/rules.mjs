/**
 * 业务规则：分类、完成判定、进度、备注、批量补录、子任务、合并。
 * 对应 gen_weekly_text.py 的 CATEGORY_MAP 段、ticket_category、is_cancelled_status、
 * DONE_MARKERS 段、week_marks、remark_done、completion_date、snap_workday、
 * task_category、task_child_stats、task_parent_id、subtask_note、important_note、
 * bulk_import_hours、build_items_from_tickets、build_items_from_tasks、merge_items。
 *
 * 这里的每一条「口径」都直接影响写进周报/绩效表的内容，改之前先对齐 Python 并跑对照。
 */
import { DEFAULT_TASK_LINK } from './config.mjs';
import {
  fmtRange, isoDate, makeDate, pyRound, stripSchoolPrefix, splitSchool, resolveSchool, toDate, todayCn,
} from './util.mjs';

export const CATEGORY_MAP = {
  服务部署: '交付部署', 迭代升级: '交付部署',
  问题解决: '项目运维', 问题跟踪: '项目运维',
  BUG修复: '项目运维', 漏洞修复: '项目运维',
  问题答疑: '项目支撑', 需求变更: '项目支撑',
  数据排查: '项目支撑', 远程支持: '项目支撑',
};

export const ISSUE_CODE_MAP = {
  service_deploy: '交付部署', upgrade: '交付部署',
  issue_resolve: '项目运维', issue_track: '项目运维',
  bug_fix: '项目运维', vuln_fix: '项目运维',
  consult: '项目支撑', requirement_change: '项目支撑',
  data_investigate: '项目支撑',
};

export const STATUS_PROGRESS = {
  completed: 100, pending_review: 80, processing: 60,
  assigned: 30, created: 10, cancelled: 0,
};

/** 已取消的工单/任务属于无效记录，不写进周报 */
export const CANCELLED_STATUSES = new Set(['cancelled', 'canceled', '已取消', '作废', '已作废', '取消']);
/** 任务中心的任务状态是中文枚举 */
export const TASK_DONE_STATUSES = new Set(['已完成', '已归档', '已关闭', '已验收', '待评审']);
export const TASK_STATUS_PROGRESS = {
  新建: 10, 进行中: 60, 已暂停: 30, 待评审: 80, 已完成: 100, 已归档: 100,
};
/** 任务类型 → 周报类别（对应工单的问题类型映射） */
export const TASK_TYPE_CATEGORY = {
  项目问题反馈: '项目运维', 问题排查: '项目运维', 漏洞修复: '项目运维',
  问题解决: '项目运维', 问题跟踪: '项目运维', BUG修复: '项目运维',
  服务支持: '项目支撑', 其他安排: '项目支撑', 周期性事项: '项目支撑',
  数据支撑: '项目支撑', 技术支撑: '项目支撑', 需求变更: '项目支撑',
  服务部署: '交付部署', 迭代升级: '交付部署', 部署实施: '交付部署',
};

export const DONE_MARKERS = ['已完成', '完成', '已关闭', '已处理', '搞定', '结束', '交付完成', '上线完成'];
export const UNDONE_MARKERS = ['未完成', '待完成', '未结束', '待续', '继续', '进行中'];
export const IMPORTANT_MARKERS = ['重要', '注意', '风险', '延期', '阻塞', '遗留', '待跟进', '紧急', '重点', '待确认'];

/** 工单 → 周报类别（对应 ticket_category） */
export function ticketCategory(t) {
  const name = String(t.issue || '').trim();
  if (CATEGORY_MAP[name]) return CATEGORY_MAP[name];
  const code = String(t.issue_code || '').trim();
  if (ISSUE_CODE_MAP[code]) return ISSUE_CODE_MAP[code];
  return '项目支撑';
}

/** 任务类型 → 周报类别（对应 task_category） */
export function taskCategory(t) {
  for (const raw of [t.type_name, t.typeName, t.type_l2_name]) {
    const name = String(raw || '').trim();
    if (!name) continue;
    if (TASK_TYPE_CATEGORY[name]) return TASK_TYPE_CATEGORY[name];
    for (const [key, cat] of Object.entries(TASK_TYPE_CATEGORY)) {
      if (name.includes(key)) return cat;
    }
    for (const [kw, cat] of [['部署', '交付部署'], ['实施', '交付部署'], ['升级', '交付部署'],
      ['运维', '项目运维'], ['排查', '项目运维'], ['修复', '项目运维'], ['故障', '项目运维']]) {
      if (name.includes(kw)) return cat;
    }
  }
  const title = String(t.title || '');
  for (const [kw, cat] of [['漏洞', '项目运维'], ['BUG', '项目运维'], ['bug', '项目运维'],
    ['问题', '项目运维'], ['故障', '项目运维'], ['部署', '交付部署'],
    ['实施', '交付部署'], ['升级', '交付部署']]) {
    if (title.includes(kw)) return cat;
  }
  return '项目支撑';
}

export function isCancelledStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s) return false;
  if (CANCELLED_STATUSES.has(s)) return true;
  return s.includes('取消') || s.includes('作废');
}

/** 工时备注里是否标记「已完成」（否定标记优先；对应 remark_done） */
export function remarkDone(remark) {
  const s = String(remark || '');
  if (!s) return false;
  if (UNDONE_MARKERS.some((k) => s.includes(k))) return false;
  return DONE_MARKERS.some((k) => s.includes(k));
}

/** 工时日期集合（升序、去重，返回 Date[]） */
export function worklogDates(wls) {
  const map = new Map();
  for (const w of wls || []) {
    const d = toDate(w.work_date);
    if (d) map.set(isoDate(d), d);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((e) => e[1]);
}

/** 完成日期（对应 completion_date） */
export function completionDate(settled, allWls, updated, created) {
  const dates = worklogDates(allWls);
  const last = dates.length ? dates[dates.length - 1] : null;
  if (settled) {
    const cands = [last, updated, created].filter(Boolean);
    if (!cands.length) return null;
    return cands.reduce((a, b) => (a > b ? a : b));
  }
  if (allWls && allWls.length) {
    const lastWl = allWls.reduce((best, w) => {
      const d = toDate(w.work_date);
      if (!best) return w;
      const bd = toDate(best.work_date);
      if (!bd) return d ? w : best;
      if (!d) return best;
      return d >= bd ? w : best;
    }, null);
    if (lastWl && remarkDone(lastWl.remark)) return toDate(lastWl.work_date);
  }
  return null;
}

/** 非工作日边界挪到相邻工作日（对应 snap_workday；workdays 是 Map<iso, bool>） */
export function snapWorkday(d, workdays, forward = true) {
  if (!d || !workdays || workdays.size === 0) return d;
  const key = isoDate(d);
  if (workdays.get(key) !== false) return d;
  const days = [...workdays.entries()].filter(([, v]) => v).map(([k]) => k).sort();
  if (!days.length) return d;
  if (forward) {
    const later = days.find((k) => k >= key);
    return later ? toDate(later) : d;
  }
  const earlier = days.filter((k) => k <= key);
  return earlier.length ? toDate(earlier[earlier.length - 1]) : d;
}

/** 把某条事项的全部工时按自然周分组，算每周完成标记与进度（对应 week_marks） */
export function weekMarks(allWls) {
  const groups = new Map();
  for (const w of allWls || []) {
    const d = toDate(w.work_date);
    if (!d) continue;
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    const key = isoDate(monday);
    let g = groups.get(key);
    if (!g) {
      g = { dates: [], progress: null, lastRemark: '', lastDate: null };
      groups.set(key, g);
    }
    g.dates.push(d);
    const p = w.progress;
    if (typeof p === 'number' && p) g.progress = Math.max(g.progress || 0, Math.trunc(p));
    if (!g.lastDate || d >= g.lastDate) {
      g.lastDate = d;
      g.lastRemark = String(w.remark || '');
    }
  }
  const out = {};
  for (const [key, g] of groups) {
    const sorted = g.dates.slice().sort((a, b) => (a < b ? -1 : 1));
    out[key] = {
      done: remarkDone(g.lastRemark),
      progress: g.progress,
      remark: g.lastRemark,
      first: isoDate(sorted[0]),
      last: isoDate(sorted[sorted.length - 1]),
    };
  }
  return out;
}

/**
 * 工单 → 周报条目（对应 build_items_from_tickets）。
 * @param {object[]} tickets normalizeTickets 的结果
 * @param {object[]} worklogs 我的工时
 * @param {string} handler 处理人
 * @param {Date} ws 周期起
 * @param {Date} we 周期止
 * @param {{myTaskIds?: Set<string>, workdays?: Map<string, boolean>, skipTaskIds?: Set<string>, childStats?: Map<string, [number, number]>}} opts
 */
export function buildItemsFromTickets(tickets, worklogs, handler, ws, we, opts = {}) {
  const myTaskIds = opts.myTaskIds || new Set();
  const childStats = opts.childStats || new Map();
  const workdays = opts.workdays || null;
  const skipTaskIds = opts.skipTaskIds || null;
  const byTask = new Map();
  for (const w of worklogs || []) {
    const key = String(w.task_id);
    if (!byTask.has(key)) byTask.set(key, []);
    byTask.get(key).push(w);
  }

  const items = [];
  let mineN = 0;
  let wlN = 0;
  let taskN = 0;
  let cancelledN = 0;
  let suppN = 0;
  const seen = new Set();

  for (const t of tickets || []) {
    const statusRaw = String(t.status || '').trim();
    if (isCancelledStatus(statusRaw)) {
      cancelledN += 1;
      continue;
    }
    const taskId = String(t.task_id || '');
    const allWls = byTask.get(taskId) || [];
    const pDates = worklogDates(allWls).filter((d) => d >= ws && d <= we);
    const created = toDate(String(t.created_at || '').slice(0, 10));
    const createdInPeriod = Boolean(created && created >= ws && created <= we);
    const isMine = Boolean(handler) && String(t.handler || '').includes(handler);
    const taskIsMine = myTaskIds.has(taskId);
    const allDates = worklogDates(allWls);
    // 补充工单：本周期新建、但工时都记在本周期之前（先干活后补单）
    if (createdInPeriod && !pDates.length && allWls.length) {
      suppN += 1;
      if (skipTaskIds && taskId) skipTaskIds.add(taskId);
      continue;
    }
    const updated = toDate(String(t.updated_at || '').slice(0, 10));
    const status = statusRaw.toLowerCase();
    const score = t.score;
    const settled = ['completed', 'closed', 'rated', 'pending_review'].includes(status)
      || (score !== undefined && score !== null && score !== '' && Number(score) !== 0);
    const completion = completionDate(settled, allWls, updated, created);

    const pWls = allWls.filter((w) => {
      const d = toDate(w.work_date);
      return d && d >= ws && d <= we;
    });
    const lastPWl = pWls.length
      ? pWls.reduce((best, w) => {
        const d = toDate(w.work_date) || new Date(0);
        const bd = toDate(best.work_date) || new Date(0);
        return d >= bd ? w : best;
      }, pWls[0])
      : null;
    const progValues = pWls
      .map((w) => w.progress)
      .filter((p) => typeof p === 'number' && p);
    const pProg = progValues.length ? Math.max(...progValues) : null;
    const selfDone = Boolean((lastPWl && remarkDone(lastPWl.remark)) || pProg === 100);

    let completedInPeriod;
    if (pDates.length) {
      completedInPeriod = Boolean((settled && completion && completion >= ws && completion <= we) || selfDone);
    } else {
      completedInPeriod = Boolean(completion && completion >= ws && completion <= we);
    }

    if (!pDates.length
      && !(createdInPeriod && (isMine || taskIsMine))
      && !(completedInPeriod && isMine && !allWls.length)) {
      continue;
    }

    let lo;
    let hi;
    if (pDates.length) {
      lo = pDates[0];
      hi = pDates[pDates.length - 1];
    } else if (completedInPeriod && completion) {
      lo = completion;
      hi = completion;
    } else {
      lo = created;
      hi = settled || updated ? updated : created;
      if (workdays && lo) lo = snapWorkday(lo, workdays, true);
      if (workdays && hi) hi = snapWorkday(hi, workdays, false);
    }
    if (!lo) continue;
    if (!hi || hi < lo) hi = lo;
    if (hi < ws || lo > we) continue;
    lo = lo < ws ? ws : lo;
    hi = hi > we ? we : hi;

    const key = `${t.school || ''}\u0000${t.title || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (isMine) mineN += 1;
    if (pDates.length) wlN += 1;
    if (taskIsMine && !isMine && !pDates.length) taskN += 1;

    let prog = null;
    for (const w of allWls) {
      const d = toDate(w.work_date);
      if (!(d && d >= ws && d <= we)) continue;
      const p = w.progress;
      if (typeof p === 'number' && p) prog = Math.max(prog || 0, p);
    }
    if (completedInPeriod) prog = 100;
    else if (prog === null) prog = settled ? 80 : (STATUS_PROGRESS[status] ?? 50);
    if (pDates.length && !completedInPeriod) prog = Math.max(prog, 60);

    const [childCc, childCd] = childStats.get(taskId) || [0, 0];
    const childrenPending = Boolean(childCc) && childCd < childCc;
    if (childrenPending) {
      completedInPeriod = false;
      const ratio = pyRound((childCd * 100) / childCc);
      prog = Math.min(prog, Math.max(60, Math.min(ratio, 95)));
    }
    prog = Math.max(0, Math.min(100, Math.trunc(prog)));
    if (prog < 100 && hi < we) hi = we;

    // {{school}} 为空会在周报里渲染出块内空行，把一条记录切成两段，因此必须兜底
    const rawSchool = String(t.school || '').trim();
    const ticketTitle = String(t.title || '').trim();
    const school = resolveSchool(rawSchool, ticketTitle, String(t.product_name || t.productName || ''));
    let subject = stripSchoolPrefix(rawSchool, ticketTitle);
    if (!rawSchool && school !== '通用事项') subject = stripSchoolPrefix(school, subject) || subject;
    if (!subject) subject = ticketTitle || '事项';

    items.push({
      category: ticketCategory(t),
      school,
      subject,
      time: fmtRange(lo, hi),
      work: t.link || '',
      progress: `${prog}%`,
      note: importantNote(t, allWls, ws, we),
      candidates: [],
      d1: isoDate(lo),
      d2: isoDate(hi),
      ticket_id: t.id || '',
      ticket_no: t.ticket_no || '',
      task_id: t.task_id || '',
      hours: round2(allWls.filter((w) => {
        const d = toDate(w.work_date);
        return d && d >= ws && d <= we;
      }).reduce((n, w) => n + Number(w.hours || 0), 0)),
      source: isMine ? '我处理' : (pDates.length ? '我记工时' : '任务我负责'),
      settled: completedInPeriod,
      done: completedInPeriod,
      work_dates: pDates.map(isoDate),
      week_marks: weekMarks(allWls),
      completion: completion ? isoDate(completion) : '',
      settled_platform: Boolean(settled),
      created: created ? isoDate(created) : '',
    });
  }

  items.sort(cmpItems);
  console.log(`工单命中 ${items.length} 条（处理人是我 ${mineN} 条，本周期我记工时 ${wlN} 条，`
    + `任务我负责 ${taskN} 条；跳过已取消 ${cancelledN} 条、补充工单 ${suppN} 条）`);
  return items;
}

/** 任务中心 → 周报条目（对应 build_items_from_tasks） */
export function buildItemsFromTasks(tasks, worklogs, handler, ws, we, opts = {}) {
  const covered = new Set([...(opts.coveredTaskIds || [])].filter(Boolean).map(String));
  const skipTasks = new Set([...(opts.skipTaskIds || [])].filter(Boolean).map(String));
  const ticketLinks = new Map(Object.entries(opts.ticketLinks || {}).filter(([, v]) => v));
  const workdays = opts.workdays || null;
  const details = opts.details || new Map();

  const byId = new Map();
  for (const t of tasks || []) {
    const tid = t.id ?? t.taskId;
    if (tid !== undefined && tid !== null) byId.set(String(tid), t);
  }
  for (const [tid, d] of details) {
    if (!byId.has(String(tid)) && d && typeof d === 'object') byId.set(String(tid), d);
  }
  const byTask = new Map();
  for (const w of worklogs || []) {
    const key = String(w.task_id);
    if (!byTask.has(key)) byTask.set(key, []);
    byTask.get(key).push(w);
  }
  for (const tid of byTask.keys()) if (!byId.has(tid)) byId.set(tid, {});

  const items = [];
  let ownerN = 0;
  let wlN = 0;
  let cancelledN = 0;
  let bulkN = 0;
  const seen = new Set();
  const bulkHours = bulkImportHours(tasks);

  for (const [tid, t] of byId) {
    const status = String(t.status || '').trim();
    if (isCancelledStatus(status)) {
      cancelledN += 1;
      continue;
    }
    const isOwner = String(t.is_owner ?? t.isOwner ?? '') === '1';
    const allWls = byTask.get(tid) || [];
    const pDates = worklogDates(allWls).filter((d) => d >= ws && d <= we);
    const created = toDate(String(t.created_at || t.createdAt || '').slice(0, 10));
    const createdInPeriod = Boolean(created && created >= ws && created <= we);

    const updated0 = toDate(String(t.updated_at || t.updatedAt || '').slice(0, 10));
    const complete0 = toDate(String(t.actual_complete_time || t.actualCompleteTime || '').slice(0, 10));
    const done0 = TASK_DONE_STATUSES.has(status) || Boolean(complete0);
    const completion0 = completionDate(done0, allWls, updated0, created);
    const doneInPeriod = Boolean(completion0 && completion0 >= ws && completion0 <= we);

    if (!pDates.length) {
      const okCreated = createdInPeriod;
      const okDone = doneInPeriod && !allWls.length;
      if (!(isOwner && (okCreated || okDone))) continue;
      const hourKey = String(t.created_at || t.createdAt || '').slice(0, 13);
      if (bulkHours.has(hourKey)) {
        bulkN += 1;
        continue;
      }
    }
    if (covered.has(tid) || skipTasks.has(tid)) continue;

    let title = String(t.title || '').trim();
    if (!title && allWls.length) title = String(allWls[0].task_name || '').trim();
    if (!title) continue;

    const rawSchool = String(t.school_name || t.schoolName || '').trim();
    const product = String(t.product_name || t.productName || '').trim();
    // 与工单分支同一套兜底，保证任务中心的条目也不会出现空 school
    const school = resolveSchool(rawSchool, title, product);
    let subject = title;
    if (rawSchool && subject.startsWith(rawSchool)) {
      subject = subject.slice(rawSchool.length).replace(/^[\s\-—·]+|[\s\-—·]+$/g, '');
    } else if (!rawSchool && school !== '通用事项') {
      subject = stripSchoolPrefix(school, subject) || subject;
    }
    if (!subject) subject = title;

    const updated = toDate(String(t.updated_at || t.updatedAt || '').slice(0, 10));
    const complete = toDate(String(t.actual_complete_time || t.actualCompleteTime || '').slice(0, 10));
    const done = TASK_DONE_STATUSES.has(status) || Boolean(complete);
    const completion = completionDate(done, allWls, updated, created);

    const pWls = allWls.filter((w) => {
      const d = toDate(w.work_date);
      return d && d >= ws && d <= we;
    });
    const lastPWl = pWls.length
      ? pWls.reduce((best, w) => {
        const d = toDate(w.work_date) || new Date(0);
        const bd = toDate(best.work_date) || new Date(0);
        return d >= bd ? w : best;
      }, pWls[0])
      : null;
    const progValues = pWls.map((w) => w.progress).filter((p) => typeof p === 'number' && p);
    const pProg = progValues.length ? Math.max(...progValues) : null;
    const selfDone = Boolean((lastPWl && remarkDone(lastPWl.remark)) || pProg === 100);

    let completedInPeriod;
    if (pDates.length) {
      completedInPeriod = Boolean((done && completion && completion >= ws && completion <= we) || selfDone);
    } else {
      completedInPeriod = Boolean(completion && completion >= ws && completion <= we);
    }

    let lo;
    let hi;
    if (pDates.length) {
      lo = pDates[0];
      hi = pDates[pDates.length - 1];
    } else if (completedInPeriod && completion) {
      lo = completion;
      hi = completion;
    } else {
      lo = created;
      hi = updated ? (updated > we ? we : updated) : created;
      if (workdays && lo) lo = snapWorkday(lo, workdays, true);
      if (workdays && hi) hi = snapWorkday(hi, workdays, false);
    }
    if (!lo) continue;
    if (!hi || hi < lo) hi = lo;
    if (hi < ws || lo > we) continue;
    lo = lo < ws ? ws : lo;
    hi = hi > we ? we : hi;

    const key = `${school || ''}\u0000${subject}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isOwner) ownerN += 1;
    if (pDates.length) wlN += 1;

    let prog = null;
    for (const w of allWls) {
      const d = toDate(w.work_date);
      if (!(d && d >= ws && d <= we)) continue;
      const p = w.progress;
      if (typeof p === 'number' && p) prog = Math.max(prog || 0, p);
    }
    if (completedInPeriod) prog = 100;
    else if (prog === null) {
      const taskProg = t.progress;
      if (typeof taskProg === 'number' && taskProg) prog = Math.trunc(taskProg);
    }
    if (prog === null) prog = done ? 80 : (TASK_STATUS_PROGRESS[status] ?? 50);

    const [childCc, childCd] = taskChildStats(t);
    const childrenPending = Boolean(childCc) && childCd < childCc;
    if (childCc) {
      const ratio = pyRound((childCd * 100) / childCc);
      if (childrenPending) {
        completedInPeriod = false;
        prog = Math.min(prog, Math.max(60, Math.min(ratio, 95)));
      } else {
        prog = Math.max(prog, 95);
      }
    }
    if (pDates.length && !completedInPeriod) prog = Math.max(prog, 60);
    prog = Math.max(0, Math.min(100, Math.trunc(prog)));
    if (prog < 100 && hi < we) hi = we;

    items.push({
      category: taskCategory(t),
      school,
      subject,
      time: fmtRange(lo, hi),
      work: ticketLinks.get(tid) || DEFAULT_TASK_LINK.replace('{id}', tid),
      progress: `${prog}%`,
      note: importantNote(t, allWls, ws, we),
      candidates: [],
      d1: isoDate(lo),
      d2: isoDate(hi),
      ticket_id: '',
      ticket_no: '',
      task_id: tid,
      parent_id: taskParentId(t),
      child_cc: childCc,
      child_cd: childCd,
      hours: round2(allWls.filter((w) => {
        const d = toDate(w.work_date);
        return d && d >= ws && d <= we;
      }).reduce((n, w) => n + Number(w.hours || 0), 0)),
      source: isOwner ? '我负责' : '任务我记工时',
      settled: completedInPeriod,
      done: completedInPeriod,
      work_dates: pDates.map(isoDate),
      week_marks: weekMarks(allWls),
      completion: completion ? isoDate(completion) : '',
      settled_platform: Boolean(done),
      created: created ? isoDate(created) : '',
    });
  }

  items.sort(cmpItems);
  console.log(`任务中心命中 ${items.length} 条（我负责 ${ownerN} 条，本周期我记工时 ${wlN} 条；`
    + `跳过已取消 ${cancelledN} 条、批量补录 ${bulkN} 条）`);
  return items;
}

/** 合并多组条目：同一 (学校, 事项) 合成一条（对应 merge_items） */
export function mergeItems(...groups) {
  const out = [];
  const index = new Map();
  for (const group of groups) {
    for (const it of group || []) {
      const key = `${it.school || ''}\u0000${it.subject || ''}`;
      const cur = index.get(key);
      if (!cur) {
        index.set(key, it);
        out.push(it);
        continue;
      }
      const d1s = [cur.d1, it.d1].filter(Boolean).sort();
      const d2s = [cur.d2, it.d2].filter(Boolean).sort();
      if (d1s.length) cur.d1 = d1s[0];
      if (d2s.length) cur.d2 = d2s[d2s.length - 1];
      cur.settled = Boolean(cur.settled) || Boolean(it.settled);
      cur.done = cur.settled;
      cur.settled_platform = Boolean(cur.settled_platform) || Boolean(it.settled_platform);
      const comps = [cur.completion, it.completion].filter(Boolean).sort();
      if (comps.length) cur.completion = comps[0];
      cur.week_marks = { ...(cur.week_marks || {}), ...(it.week_marks || {}) };
      cur.work_dates = [...new Set([...(cur.work_dates || []), ...(it.work_dates || [])])].sort();
      const p1 = parseInt(String(cur.progress || '0').replace('%', ''), 10) || 0;
      const p2 = parseInt(String(it.progress || '0').replace('%', ''), 10) || 0;
      cur.progress = `${Math.max(p1, p2)}%`;
      if (!cur.work && it.work) cur.work = it.work;
      if ((cur.note === undefined || cur.note === null || cur.note === '' || cur.note === '无')
        && it.note !== undefined && it.note !== null && it.note !== '' && it.note !== '无') {
        cur.note = it.note;
      }
    }
  }
  out.sort((a, b) => cmpStr(a.d1 || '', b.d1 || '') || cmpStr(a.school || '', b.school || '')
    || cmpStr(a.subject || '', b.subject || ''));
  return out;
}

/** 任务的子任务统计 → [child_count, child_done]（对应 task_child_stats） */
export function taskChildStats(t) {
  if (!t || typeof t !== 'object') return [0, 0];
  let cc = asInt(t.child_count ?? t.childCount, 0);
  let cd = asInt(t.child_done ?? t.childDone, 0);
  const children = t.children;
  if (Array.isArray(children) && children.length) {
    cc = Math.max(cc, children.length);
    const doneN = children.filter((c) => c && TASK_DONE_STATUSES.has(String(c.status || '').trim())).length;
    cd = Math.max(cd, doneN);
  }
  cc = Math.max(0, cc);
  return [cc, Math.max(0, Math.min(cd, cc))];
}

/** 任务的父任务 ID（顶级返回空串） */
export function taskParentId(t) {
  if (!t || typeof t !== 'object') return '';
  const v = t.parent_task_id ?? t.parentTaskId;
  if (v === undefined || v === null || v === '' || v === 0 || v === '0') return '';
  return String(v);
}

/** 子任务进度文案（对应 subtask_note；当前「重要说明」默认不写它） */
export function subtaskNote(cd, cc, folded) {
  const parts = [];
  if (cc) parts.push(`子任务 ${cd}/${cc} 完成`);
  const names = (folded || []).filter(Boolean);
  if (names.length) {
    let shown = names.slice(0, 3).join('、');
    if (names.length > 3) shown += ` 等 ${names.length} 项`;
    parts.push(`含子任务：${shown}`);
  }
  return parts.length ? parts.join('；') : '无';
}

/** 重要说明：默认「无」；风险预警字段或本周期工时备注带标记才填（对应 important_note） */
export function importantNote(t, allWls, ws, we) {
  if (t && typeof t === 'object') {
    const risk = String(t.risk_warning || t.riskWarning || '').trim();
    if (risk) return risk.slice(0, 60);
  }
  for (const w of allWls || []) {
    const d = toDate(w.work_date);
    if (ws && we && !(d && d >= ws && d <= we)) continue;
    const note = String(w.remark || '').trim();
    if (note && IMPORTANT_MARKERS.some((k) => note.includes(k))) return note.slice(0, 60);
  }
  return '无';
}

/** 批量补录时段：{小时键: 该小时我负责新建数}，命中说明是历史数据导入（对应 bulk_import_hours） */
export function bulkImportHours(tasks, minCount = 20) {
  const cnt = new Map();
  for (const t of tasks || []) {
    if (String(t.is_owner) !== '1') continue;
    const ca = String(t.created_at || t.createdAt || '');
    if (ca.length >= 13) {
      const key = ca.slice(0, 13);
      cnt.set(key, (cnt.get(key) || 0) + 1);
    }
  }
  const out = new Map();
  for (const [hour, n] of cnt) if (n >= Math.max(2, minCount)) out.set(hour, n);
  return out;
}

function asInt(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 条目排序：开始日 → 学校 → 事项（Python 的同名排序键） */
export function cmpItems(a, b) {
  return cmpStr(a.d1 || '', b.d1 || '') || cmpStr(a.school || '', b.school || '')
    || cmpStr(a.subject || '', b.subject || '');
}

export { todayCn, makeDate };
