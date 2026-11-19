/**
 * 工单归属判定（v1.5.0 测试版）
 *
 * 背景：平台按权限返回工单 —— 搜出来的列表里混着「我可见但不是我干的」工单
 * （别人建的、我只是协办、我只是创建人/报障人等）。代别人出周报时更明显：
 * 账号本人的工时会被算到目标处理人名下。
 *
 * 可用信号（都来自接口原始字段）：
 *   · ownerName / ownerUserId     处理人（工单列表就有）
 *   · initiatorName / initiatorUserId  创建人（工单列表就有）
 *   · assignees[]                 协办人（只有工单详情有）
 *   · 工时里的 user_display_name   每个工时都带记录人（task_list_task_worklogs 按 taskId 取所有人）
 *
 * 默认口径（strict）：
 *   ① 本人在该任务上有工时            → 计入（真干过，最硬的信号）
 *   ② 处理人就是本人                    → 计入
 *   ③ 创建人是本人，但处理人不是、也没本人工时 → 剔除（用户明确要求）
 *   ④ 本人只是协办人且没有本人工时      → 剔除（挂名）
 *   ⑤ 与本人完全无关（纯权限可见）      → 剔除
 *   ⑥ 工单已取消                       → 剔除（在 rules.mjs 里已有）
 *
 * 宽松口径（loose）= 改动前的行为：处理人含本人，或本人有工时就算自己的。
 */

/** 把可能带分隔符的多名字字符串拆成单个名字 */
export function splitNames(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((v) => splitNames(v && typeof v === 'object'
      ? (v.name || v.userName || v.user_display_name || v.displayName || '')
      : v));
  }
  if (typeof value === 'object') {
    return splitNames(value.name || value.userName || value.user_display_name || '');
  }
  const s = String(value);
  if (!s.trim()) return [];
  return s.split(/[,，、;；\/\s|]+/).map((x) => x.trim()).filter(Boolean);
}

/** 名字里是否含某人（支持「张 三」这类中间有空格的情况，做一次去空格比较） */
export function nameMatches(value, person) {
  const p = String(person || '').trim();
  if (!p) return false;
  if (nameIn(value, p)) return true;
  const tight = p.replace(/\s+/g, '');
  if (!tight) return false;
  return nameIn(value, tight);
}

function nameIn(value, person) {
  for (const n of splitNames(value)) {
    if (n === person) return true;
    if (n.includes(person)) return true;
  }
  return false;
}

/**
 * 判定归属
 * @param {object} item  { owner, initiator, assignees, task_id, status }
 * @param {object} ctx
 *   handler            目标处理人（周报给谁写）
 *   selfNames          账号本人的名字集合（工时里的 user_display_name）
 *   myWorklogTasks     账号本人有工时的任务 id 集合
 *   targetWorklogTasks 目标处理人有工时的任务 id 集合（代出场景才需要）
 *   mode               'strict' | 'loose'
 * @returns {{mine:boolean, reason:string, signals:object}}
 */
export function classifyOwnership(item, ctx = {}) {
  // 默认 strict；ctx.mode === 'loose' 是应急逃生口（回到旧口径）
  const mode = ctx.mode === 'loose' ? 'loose' : 'strict';
  const handler = String(ctx.handler || '').trim();
  const owner = item.owner || '';
  const initiator = item.initiator || '';
  const taskId = String(item.task_id || item.taskId || '');
  const selfNames = ctx.selfNames instanceof Set ? ctx.selfNames : new Set(ctx.selfNames || []);
  const myTasks = ctx.myWorklogTasks instanceof Set ? ctx.myWorklogTasks : new Set(ctx.myWorklogTasks || []);
  const targetTasks = ctx.targetWorklogTasks instanceof Set ? ctx.targetWorklogTasks : new Set(ctx.targetWorklogTasks || []);
  const ownedTasks = ctx.selfOwnedTasks instanceof Set ? ctx.selfOwnedTasks : new Set(ctx.selfOwnedTasks || []);

  // 有 user id 就按 id 精确比（姓名可能重名），没有再退回姓名
  const targetIds = ctx.targetIds instanceof Set ? ctx.targetIds : new Set(ctx.targetIds || []);
  const selfIds = ctx.selfIds instanceof Set ? ctx.selfIds : new Set(ctx.selfIds || []);
  const idOf = (v) => (v === undefined || v === null || v === '') ? '' : String(v);
  const ownerId = idOf(item.owner_id);
  const initiatorId = idOf(item.initiator_id);
  const isTargetById = (ids, id) => (ids.size > 0 && id) ? ids.has(id) : null;
  const isSelfById = (ids, id) => (ids.size > 0 && id) ? ids.has(id) : null;

  const selfHit = (nameVal, idVal) => {
    const byId = isSelfById(selfIds, idVal);
    if (byId !== null) return byId;
    return [...selfNames].some((n) => nameMatches(nameVal, n));
  };
  const targetHit = (nameVal, idVal) => {
    const byId = isTargetById(targetIds, idVal);
    if (byId !== null) return byId;
    return nameMatches(nameVal, handler);
  };

  // 「自出」= 目标处理人就是账号本人：两边 id 能对上（或姓名对上）
  const isSelfReport = !handler || (
    targetIds.size > 0 && selfIds.size > 0
      ? [...targetIds].some((id) => selfIds.has(String(id)))
      : [...selfNames].some((n) => nameMatches(handler, n))
  );
  // 「本人在这个任务上有工时」：
  //   自出模式 —— 我的工时就是本人的工时；
  //   代出模式 —— 账号本人的工时**不算**目标的，必须用目标自己的工时（targetTasks）
  const selfOwned = isSelfReport && ownedTasks.has(taskId);
  const targetHasWl = isSelfReport
    ? (myTasks.has(taskId) || selfOwned)
    : targetTasks.has(taskId);

  const signals = {
    isSelfReport,
    ownerIsTarget: targetHit(owner, ownerId),
    initiatorIsTarget: targetHit(initiator, initiatorId),
    ownerIsSelf: selfHit(owner, ownerId),
    initiatorIsSelf: selfHit(initiator, initiatorId),
    targetHasWl,
    selfOwned,
    isAssociate: false,   // 由调用方补：详情里 assignees 含本人且 role=associate
  };

  if (!handler) {
    return { mine: false, reason: '未指定处理人', signals };
  }
  if (mode === 'loose') {
    const mine = signals.ownerIsTarget || targetHasWl;
    return {
      mine,
      reason: mine ? (signals.ownerIsTarget ? '处理人是本人' : '本人有工时') : '与本人无关',
      signals,
    };
  }

  // strict 口径
  if (signals.targetHasWl) {
    return { mine: true, reason: '本人有工时', signals };
  }
  if (signals.ownerIsTarget) {
    return { mine: true, reason: '处理人是本人', signals };
  }
  if (signals.initiatorIsTarget) {
    // 创建人是本人，但处理人不是本人、也没本人工时 → 剔除
    return { mine: false, reason: '只是创建人（处理人与工时都不是本人）', signals };
  }
  return { mine: false, reason: '与本人无关（仅权限可见）', signals };
}

/** 汇总各类归属原因，给日志用 */
export function summarizeOwnership(items) {
  const stat = new Map();
  for (const it of items) {
    const k = it.reason || '未知';
    stat.set(k, (stat.get(k) || 0) + 1);
  }
  return [...stat.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v} 条`);
}
