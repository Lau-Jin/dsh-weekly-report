/**
 * 数据抓取 + 本地缓存。
 * 对应 gen_weekly_text.py：normalize_tickets / extract_list / load_tickets_from_json /
 * 缓存段 / fetch_tickets_via_mcp / fetch_my_worklogs / fetch_workdays /
 * fetch_my_tasks / fetch_task_details / my_user_ids / detail_to_task / fetch_subtask_tasks。
 *
 * 打印文案与 Python 版一致：面板把 stdout 当生成日志展示，用户已经习惯这些行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_LINK, DEFAULT_MCP_URL, ENGINE_DIR, TASK_DETAIL_TOOL, TASK_LIST_TOOL } from './config.mjs';
import { McpClient, callWithRetry, mcpError, pickTicketTool, toolTexts } from './mcp.mjs';
import { isoDate, splitSchool, toDate } from './util.mjs';
import { TASK_DONE_STATUSES } from './rules.mjs';

const CACHE_TTL_MS = 6 * 3600 * 1000;

/** 缓存放数据目录（插件目录可能只读，也别把缓存混进代码目录） */
export function cacheDir() {
  const env = process.env.WEEKLY_PANEL_DATA;
  if (env) return path.join(env, 'cache');
  return path.join(ENGINE_DIR, '.cache');
}

function cachePath(name) {
  return path.join(cacheDir(), `${name}.json`);
}

/** 读缓存；超过 ttl 视为未命中。返回 items 或 null。 */
export function cacheRead(name, ttlMs = CACHE_TTL_MS) {
  const file = cachePath(name);
  try {
    const stat = fs.statSync(file);
    if (ttlMs !== null && Date.now() - stat.mtimeMs > ttlMs) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && Object.prototype.hasOwnProperty.call(data, 'items') ? data.items : null;
  } catch {
    return null;
  }
}

/** 写缓存（失败静默：缓存只是加速） */
export function cacheWrite(name, items) {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const file = cachePath(name);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), items }), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* ignore */
  }
}

/** Python 的 _pick：缺失返回 undefined（与空串区分） */
function pickRaw(obj, ...keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) {
      const v = obj[k];
      if (v !== null && v !== undefined && v !== '') return v;
    }
  }
  return undefined;
}

/** 把 MCP/JSON 里的工单记录归一化成统一形状（对应 normalize_tickets） */
export function normalizeTickets(rawList) {
  const out = [];
  for (const it of rawList || []) {
    if (!it || typeof it !== 'object') continue;
    const tid = pickRaw(it, 'id', 'ticketId', 'ticket_id', 'code', 'no', '工单编号', '编号', '工单id', '工单ID');
    const title = pickRaw(it, 'title', 'subject', 'name', 'ticketTitle', 'summary', 'content', '标题', '主题', '工单标题', '事项');
    const linkRaw = pickRaw(it, 'link', 'url', 'href', '链接', '地址');
    const handler = pickRaw(it, 'handler', 'assignee', 'handlerName', 'owner', 'dealUser', 'assigneeName', 'handleUser', 'ownerName', '处理人', '负责人', '指派给');
    const school = pickRaw(it, 'schoolName', 'school', 'projectName', '学校', '项目');
    if (tid === undefined && title === undefined) continue;
    const link = linkRaw || (tid !== undefined ? DEFAULT_LINK.replace('{id}', String(tid)) : '');
    out.push({
      id: tid !== undefined ? String(tid) : '',
      title: title ? String(title).trim() : '',
      link: link ? String(link).trim() : '',
      handler: handler ? String(handler).trim() : '',
      school: school ? String(school).trim() : '',
      status: String(pickRaw(it, 'ticketStatus', 'status') || '').trim(),
      task_id: pickRaw(it, 'taskId', 'task_id'),
      ticket_no: String(pickRaw(it, 'ticketNo', 'no') || '').trim(),
      issue: String(pickRaw(it, 'issueTypeName', 'issueType') || '').trim(),
      issue_code: String(pickRaw(it, 'issueType', 'issueTypeCode') || '').trim(),
      created_at: String(pickRaw(it, 'createdAt', 'created_at') || '').trim(),
      updated_at: String(pickRaw(it, 'updatedAt', 'updated_at') || '').trim(),
      score: pickRaw(it, 'score'),
      hours: pickRaw(it, 'totalHours', 'hours'),
    });
  }
  const seen = new Set();
  const uniq = [];
  for (const t of out) {
    const key = `${t.id}\u0000${t.title}\u0000${t.link}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(t);
  }
  return uniq;
}

/** 从任意包一层的返回里找列表（对应 extract_list） */
export function extractList(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of ['data', 'list', 'rows', 'records', 'items', 'content', 'result', 'tickets', '工单列表']) {
      const v = data[key];
      if (Array.isArray(v)) return v;
      if (v && typeof v === 'object') {
        const inner = extractList(v);
        if (inner.length) return inner;
      }
    }
  }
  return [];
}

/** 读本地工单 JSON（对应 load_tickets_from_json） */
export function loadTicketsFromJson(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return normalizeTickets(extractList(data));
}

/** 拉「我的工单」；失败抛错（CLI 会转成人话） */
export async function fetchTicketsViaMcp({ token, url = DEFAULT_MCP_URL, toolName, toolArgs, handlerFilter, useCache = true }) {
  const cached = useCache ? cacheRead('tickets') : null;
  if (cached) {
    const age = Math.round((Date.now() - fs.statSync(cachePath('tickets')).mtimeMs) / 1000);
    console.log(`工单列表：命中本地缓存（${cached.length} 条，${age} 秒前拉的）`);
    const tickets = normalizeTickets(cached);
    if (handlerFilter) {
      const mine = tickets.filter((t) => t.handler.includes(handlerFilter)).length;
      console.log(`工单共 ${tickets.length} 条，其中处理人含「${handlerFilter}」${mine} 条`
        + '（匹配时本人优先，未命中再比对全部）');
    }
    return { tickets, tools: [] };
  }

  const client = new McpClient(url, token);
  const init = await client.initialize();
  const initErr = mcpError(init);
  if (initErr) throw new Error(`MCP 初始化失败：${initErr}`);
  const serverInfo = (init.result || {}).serverInfo;
  console.log(`MCP 已连接：${serverInfo ? JSON.stringify(serverInfo) : ''}`);

  const toolsResp = await client.listTools();
  const toolsErr = mcpError(toolsResp);
  if (toolsErr) throw new Error(`获取工具列表失败：${toolsErr}`);
  const tools = (toolsResp.result || {}).tools || [];
  console.log(`MCP 工具数：${tools.length}`);

  let tool = null;
  if (toolName) {
    tool = tools.find((t) => t.name === toolName) || null;
    if (!tool) throw new Error(`未找到工具：${toolName}`);
  } else {
    tool = tools.find((t) => t.name === 'ticket_list_my_tickets') || pickTicketTool(tools);
    if (!tool) throw new Error(`没有识别到工单工具，可用工具：${tools.map((t) => t.name || '?').join(', ')}`);
  }

  const baseArgs = { ...(toolArgs || {}) };
  console.log(`调用工具：${tool.name} 参数：${JSON.stringify(baseArgs)}`);

  const allItems = [];
  let page = 1;
  let limit = 40;
  let total = null;
  while (page <= 40) {
    const resp = await callWithRetry(client, tool.name, { ...baseArgs, page, limit });
    const err = mcpError(resp);
    if (err && (String(err).includes('-32006') || String(err).includes('64KB')) && limit > 10) {
      limit = Math.max(10, Math.floor(limit / 2));
      continue;
    }
    if (err) throw new Error(`调用工具失败：${err}`);
    const text = toolTexts(resp);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`工具返回无法解析为 JSON：${text.slice(0, 300)}`);
    }
    const items = extractList(data);
    if (data && typeof data === 'object' && Number.isInteger(data.total)) total = data.total;
    if (!items.length) break;
    allItems.push(...items);
    console.log(`  第 ${page} 页：${items.length} 条（累计 ${allItems.length}/${total === null ? '?' : total}）`);
    if (total !== null && allItems.length >= total) break;
    page += 1;
  }

  if (useCache) cacheWrite('tickets', allItems);
  const tickets = normalizeTickets(allItems);
  if (handlerFilter) {
    const mine = tickets.filter((t) => t.handler.includes(handlerFilter)).length;
    console.log(`工单共 ${tickets.length} 条，其中处理人含「${handlerFilter}」${mine} 条`
      + '（匹配时本人优先，未命中再比对全部）');
  }
  return { tickets, tools };
}

/** 我在区间内的工时记录（对应 fetch_my_worklogs，缓存 10 分钟） */
export async function fetchMyWorklogs({ token, url = DEFAULT_MCP_URL, start, end, tool = 'task_list_my_worklogs', useCache = true }) {
  const ckey = start && end ? `worklogs_${isoDate(start)}_${isoDate(end)}` : '';
  if (useCache && ckey) {
    const hit = cacheRead(ckey, 600 * 1000);
    if (hit !== null) {
      console.log(`我的工时：命中本地缓存（${hit.length} 条）`);
      return hit;
    }
  }

  const client = new McpClient(url, token);
  const initErr = mcpError(await client.initialize());
  if (initErr) throw new Error(`MCP 初始化失败：${initErr}`);

  const out = [];
  let page = 1;
  while (page <= 20) {
    const resp = await callWithRetry(client, tool, {
      startDate: isoDate(start), endDate: isoDate(end), page, limit: 50,
    });
    const err = mcpError(resp);
    if (err) throw new Error(`读取工时失败：${err}`);
    const data = JSON.parse(toolTexts(resp));
    const items = data.items || [];
    out.push(...items);
    const total = data.total;
    if (!items.length || (Number.isInteger(total) && out.length >= total) || items.length < 50) break;
    page += 1;
  }
  const hours = out.reduce((n, w) => n + Number(w.hours || 0), 0);
  console.log(`我的工时：${out.length} 条（${isoDate(start)} ~ ${isoDate(end)}，合计 ${fmtG(hours)} 小时）`);
  if (useCache && ckey) cacheWrite(ckey, out);
  return out;
}

function fmtG(n) {
  // Python 的 :g 会把 8.0 打成 8
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

/** 区间内每天是否工作日（对应 fetch_workdays，按日缓存 12 小时） */
export async function fetchWorkdays({ token, url = DEFAULT_MCP_URL, start, end, useCache = true }) {
  if (!start || !end) return new Map();
  const out = new Map();
  const todo = [];
  for (let d = start; d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const key = isoDate(d);
    const hit = useCache ? cacheRead(`workday_${key}`) : null;
    if (hit !== null) out.set(key, Boolean(hit));
    else todo.push(d);
  }
  if (!todo.length) return out;
  try {
    const client = new McpClient(url, token);
    const initErr = mcpError(await client.initialize());
    if (initErr) return out;
    for (const d of todo) {
      const key = isoDate(d);
      const resp = await callWithRetry(client, 'calendar_is_workday', { date: key });
      if (mcpError(resp)) break;
      const data = JSON.parse(toolTexts(resp));
      const flag = Boolean(data.is_workday);
      out.set(key, flag);
      if (useCache) cacheWrite(`workday_${key}`, flag);
    }
  } catch {
    /* 工作日拿不到就用空表（生成照跑） */
  }
  if (out.size) {
    const days = [...out.keys()].filter((k) => out.get(k)).sort();
    console.log(`本周期工作日：${days.length} 天（${days.map((k) => k.slice(5)).join('、') || '-'}）`);
  }
  return out;
}

/** 任务中心里与我相关的任务（对应 fetch_my_tasks，缓存 6 小时） */
export async function fetchMyTasks({ token, url = DEFAULT_MCP_URL, tool = TASK_LIST_TOOL, limit = 25, useCache = true }) {
  const cached = useCache ? cacheRead('tasks') : null;
  if (cached) {
    const owner = cached.filter((x) => String(x.is_owner) === '1').length;
    console.log(`任务中心：命中本地缓存（${cached.length} 条，我负责 ${owner} 条）`);
    return cached;
  }
  const client = new McpClient(url, token);
  const initErr = mcpError(await client.initialize());
  if (initErr) throw new Error(`MCP 初始化失败：${initErr}`);

  const out = [];
  let page = 1;
  const maxPages = 200;
  while (page <= maxPages) {
    const resp = await callWithRetry(client, tool, { page, limit });
    const err = mcpError(resp);
    if (err && (String(err).includes('-32006') || String(err).includes('64KB')) && limit > 5) {
      limit = Math.max(5, Math.floor(limit / 2));
      console.log(`  任务列表响应过大，limit 降到 ${limit} 重试`);
      continue;
    }
    if (err) throw new Error(`读取任务中心失败：${err}`);
    const data = JSON.parse(toolTexts(resp));
    const items = data.items || [];
    out.push(...items);
    const total = data.total;
    if (!items.length || (Number.isInteger(total) && out.length >= total) || items.length < limit) break;
    page += 1;
  }
  if (page > maxPages) {
    console.log(`警告：任务列表翻到 ${maxPages} 页仍未取完，可能还有任务没拉下来（周报与绩效表会漏这些任务）`);
  }
  if (useCache) cacheWrite('tasks', out);
  const owner = out.filter((t) => String(t.is_owner) === '1').length;
  console.log(`任务中心：${out.length} 条（我负责 ${owner} 条）`);
  return out;
}

/** 补拉不在「我的任务」列表里的任务详情（按 id 缓存） */
export async function fetchTaskDetails({ token, taskIds, url = DEFAULT_MCP_URL, useCache = true }) {
  const out = new Map();
  const ids = (taskIds || []).filter((x) => /^\d+$/.test(String(x))).map((x) => String(x));
  if (!ids.length) return out;
  if (useCache) {
    for (const tid of ids) {
      const hit = cacheRead(`task_${tid}`);
      if (hit !== null) out.set(tid, hit);
    }
  }
  const client = new McpClient(url, token);
  const initErr = mcpError(await client.initialize());
  if (initErr) {
    console.log(`提示：任务详情读取失败（${initErr}），这些任务不单独生成`);
    return out;
  }
  for (const tid of ids) {
    if (out.has(tid)) continue;
    const resp = await callWithRetry(client, TASK_DETAIL_TOOL, { taskId: Number(tid), logLimit: 1, worklogLimit: 1 });
    if (mcpError(resp)) continue;
    try {
      const data = JSON.parse(toolTexts(resp));
      out.set(tid, data);
      if (useCache) cacheWrite(`task_${tid}`, data);
    } catch {
      /* 单条失败不影响其它 */
    }
  }
  console.log(`任务详情：补拉 ${out.size}/${ids.length} 条`);
  return out;
}

/** 从我负责的任务里反推我的 user id（判断子任务归属用） */
export function myUserIds(tasks) {
  const ids = new Set();
  for (const t of tasks || []) {
    if (String(t.is_owner) !== '1') continue;
    for (const key of ['owner_user_id', 'ownerUserId']) {
      const v = t[key];
      if (v !== undefined && v !== null && v !== '') {
        const n = Number(v);
        if (Number.isFinite(n)) ids.add(n);
      }
    }
    for (const a of t.assignees || []) {
      if (a && a.userId !== undefined && a.userId !== null) {
        const n = Number(a.userId);
        if (Number.isFinite(n)) ids.add(n);
      }
    }
  }
  return ids;
}

/** task_get_task_detail 的返回 → 列表项形状（对应 detail_to_task） */
export function detailToTask(detail, parent) {
  if (!detail || typeof detail !== 'object') return null;
  const tid = detail.taskId || detail.id;
  if (tid === undefined || tid === null) return null;
  const title = detail.title || '';
  const children = detail.children || [];
  const doneN = children.filter((c) => c && TASK_DONE_STATUSES.has(String(c.status || '').trim())).length;
  const school = splitSchool(title) || (parent && parent.school_name) || '';
  return {
    id: tid,
    title,
    status: detail.status || '',
    progress: detail.progress,
    created_at: detail.createdAt || detail.created_at || '',
    updated_at: detail.updatedAt || detail.updated_at || '',
    actual_complete_time: detail.actualCompleteTime || detail.actual_complete_time,
    owner_user_id: detail.ownerUserId || detail.owner_user_id,
    assignees: detail.assignees || [],
    parent_task_id: detail.parentTaskId || (parent && parent.id),
    child_count: children.length || detail.childCount || 0,
    child_done: doneN || detail.childDone || 0,
    school_name: school,
    product_name: (parent && parent.product_name) || '',
    // 类型留空：让 task_category 按子任务自己的标题判断
    type_name: '',
    type_l2_name: '',
  };
}

/** 补拉本期已纳入父任务的子任务（task_list_my_tasks 不返回子任务） */
export async function fetchSubtaskTasks({ token, mcpUrl, parents, myIds, knownIds, limit = 80 }) {
  const out = [];
  let used = 0;
  if (!parents || !parents.length) return out;
  const knownList = knownIds instanceof Set ? [...knownIds] : (knownIds || []);
  const existing = new Set(knownList.filter(Boolean).map(String));
  const client = new McpClient(mcpUrl, token);
  const initErr = mcpError(await client.initialize());
  if (initErr) {
    console.log(`提示：子任务补录跳过（${initErr}）`);
    return out;
  }

  for (const parent of parents) {
    if (used >= limit) {
      console.log(`子任务补录：达到请求上限 ${limit}，其余跳过`);
      break;
    }
    const pid = parent.id || parent.taskId;
    if (pid === undefined || pid === null) continue;
    let pdet = cacheRead(`task_${pid}`);
    if (pdet === null) {
      const resp = await callWithRetry(client, TASK_DETAIL_TOOL, { taskId: Number(pid), logLimit: 1, worklogLimit: 1 });
      used += 1;
      if (mcpError(resp)) continue;
      try {
        pdet = JSON.parse(toolTexts(resp));
      } catch {
        continue;
      }
      cacheWrite(`task_${pid}`, pdet);
    } else {
      used += 1;
    }

    for (const child of pdet.children || []) {
      if (used >= limit) break;
      const cid = child && child.id;
      if (cid === undefined || cid === null || existing.has(String(cid))) continue;
      let cdet = cacheRead(`task_${cid}`);
      if (cdet === null) {
        const cresp = await callWithRetry(client, TASK_DETAIL_TOOL, { taskId: Number(cid), logLimit: 1, worklogLimit: 1 });
        used += 1;
        if (mcpError(cresp)) continue;
        try {
          cdet = JSON.parse(toolTexts(cresp));
        } catch {
          continue;
        }
        cacheWrite(`task_${cid}`, cdet);
      }
      const item = detailToTask(cdet, parent);
      if (!item) continue;
      const ownerNum = item.owner_user_id === undefined || item.owner_user_id === null
        ? null : Number(item.owner_user_id);
      const assigneeIds = new Set();
      for (const a of item.assignees || []) {
        if (a && a.userId !== undefined && a.userId !== null) {
          const n = Number(a.userId);
          if (Number.isFinite(n)) assigneeIds.add(n);
        }
      }
      const intersectsMyIds = [...assigneeIds].some((id) => myIds.has(id));
      item.is_owner = (ownerNum !== null && myIds.has(ownerNum)) || intersectsMyIds ? '1' : '0';
      item.is_assignee = intersectsMyIds ? '1' : '0';
      existing.add(String(cid));
      out.push(item);
    }
  }

  if (out.length) {
    console.log(`子任务补录：${out.length} 条（来自 ${parents.length} 个本期父任务，共 ${used} 次请求）`);
  }
  return out;
}

/** 工时记录的日期集合（升序、去重） */
export function worklogDates(wls) {
  const set = new Set();
  for (const w of wls || []) {
    const d = toDate(w.work_date);
    if (d) set.add(isoDate(d));
  }
  return [...set].sort();
}
