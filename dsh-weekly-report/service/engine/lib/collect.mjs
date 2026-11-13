/**
 * collectItems：周报条目总入口（对应 gen_weekly_text.py 的 collect_items）。
 *
 * 工单（处理人是我 / 本周期我有工时 / 关联任务我负责）
 * + 任务中心（本周期我有工时 / 本周期新建我负责）+ 子任务补录，最后按 (学校, 事项) 合并。
 */
import { fetchMyTasks, fetchMyWorklogs, fetchSubtaskTasks, fetchTaskDetails, fetchTicketsViaMcp, fetchWorkdays, myUserIds } from './fetch.mjs';
import {
  buildItemsFromTasks, buildItemsFromTickets, mergeItems, taskChildStats, worklogDates,
} from './rules.mjs';
import { makeDate, toDate, todayCn } from './util.mjs';

/**
 * @param {object} opts
 * @param {string} opts.token API Key
 * @param {string} opts.mcpUrl MCP 地址
 * @param {string} opts.handler 处理人
 * @param {Date} opts.ws 周期起
 * @param {Date} opts.we 周期止
 * @param {string} [opts.mcpTool]
 * @param {object} [opts.mcpArgs]
 * @param {boolean} [opts.withTasks]
 * @param {boolean} [opts.useCache]
 * @returns {Promise<object[]>} 合并后的 items
 */
export async function collectItems({ token, mcpUrl, handler, ws, we, mcpTool, mcpArgs, withTasks = true, useCache = true }) {
  const t0 = Date.now();
  const { tickets } = await fetchTicketsViaMcp({
    token, url: mcpUrl, toolName: mcpTool, toolArgs: mcpArgs, handlerFilter: handler, useCache,
  });
  const t1 = Date.now();
  const wlStart = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() - 60);
  const today = todayCn();
  const wlEnd = we > today ? we : today;
  const worklogs = await fetchMyWorklogs({ token, url: mcpUrl, start: wlStart, end: wlEnd });
  const t2 = Date.now();
  const workdays = await fetchWorkdays({ token, url: mcpUrl, start: ws, end: we });
  const t3 = Date.now();
  console.log(`[计时] 工单 ${secs(t1 - t0)}s · 工时 ${secs(t2 - t1)}s · 工作日 ${secs(t3 - t2)}s`);

  let myTaskIds = new Set();
  let taskItems = [];
  let ticketItems;
  const suppTaskIds = new Set();

  if (withTasks) {
    try {
      const t4 = Date.now();
      let tasks = await fetchMyTasks({ token, url: mcpUrl, useCache });
      const t5 = Date.now();
      console.log(`[计时] 任务列表 ${secs(t5 - t4)}s`);

      myTaskIds = new Set(tasks.filter((t) => String(t.is_owner) === '1').map((t) => String(t.id)));
      const childStats = new Map();
      for (const t of tasks) {
        if (t.id !== undefined && t.id !== null) childStats.set(String(t.id), taskChildStats(t));
      }

      ticketItems = buildItemsFromTickets(tickets, worklogs, handler, ws, we, {
        myTaskIds,
        workdays,
        skipTaskIds: suppTaskIds,
        childStats,
      });
      const covered = new Set(ticketItems.filter((i) => i.task_id).map((i) => String(i.task_id)));
      const wlTaskIds = new Set(worklogs.filter((w) => w.task_id !== undefined && w.task_id !== null).map((w) => String(w.task_id)));
      const known = new Set(tasks.map((t) => String(t.id)));
      const missing = [...wlTaskIds].filter((id) => !known.has(id)).sort();
      const t6 = Date.now();
      const details = missing.length ? await fetchTaskDetails({ token, taskIds: missing, url: mcpUrl }) : new Map();
      const t7 = Date.now();
      console.log(`[计时] 补拉任务详情 ${secs(t7 - t6)}s（${missing.length} 个）`);

      // 子任务补录：只对「本期已纳入的父任务」取 children
      const knownAll = new Set([...known, ...details.keys()]);
      const parentsToExpand = [];
      for (const t of tasks) {
        const cc = taskChildStats(t)[0] || 0;
        if (cc <= 0) continue;
        const tid = String(t.id);
        const pDates = worklogDates(worklogs.filter((w) => String(w.task_id) === tid))
          .filter((d) => d >= ws && d <= we);
        const created = toDate(String(t.created_at || t.createdAt || '').slice(0, 10));
        const createdInPeriod = Boolean(created && created >= ws && created <= we);
        if (!pDates.length && String(t.is_owner) !== '1') continue;
        if (pDates.length || (String(t.is_owner) === '1' && createdInPeriod)) parentsToExpand.push(t);
      }
      const t8 = Date.now();
      let subtasks = [];
      try {
        subtasks = await fetchSubtaskTasks({
          token, mcpUrl, parents: parentsToExpand, myIds: myUserIds(tasks), knownIds: knownAll,
        });
      } catch (subErr) {
        // 子任务补录是「锦上添花」：失败只记一句，不能把整批任务条目丢掉
        console.log(`提示：子任务补录失败（${subErr.message || subErr}），按已拿到的任务继续`);
      }
      console.log(`[计时] 子任务补录 ${secs(Date.now() - t8)}s（${subtasks.length} 条）`);
      if (subtasks.length) {
        tasks = [...tasks, ...subtasks];
        for (const t of subtasks) if (String(t.is_owner) === '1') myTaskIds.add(String(t.id));
      }

      // 任务有对应工单时，「工作内容」优先给工单链接
      const ticketLinks = {};
      for (const t of tickets) {
        if (t.task_id !== undefined && t.task_id !== null) ticketLinks[String(t.task_id)] = t.link;
      }
      taskItems = buildItemsFromTasks(tasks, worklogs, handler, ws, we, {
        coveredTaskIds: covered,
        details,
        ticketLinks,
        workdays,
        skipTaskIds: suppTaskIds,
      });
    } catch (e) {
      console.log(`提示：任务中心读取失败，本次只按工单生成（${e.message || e}）`);
      ticketItems = buildItemsFromTickets(tickets, worklogs, handler, ws, we, { workdays });
    }
  } else {
    ticketItems = buildItemsFromTickets(tickets, worklogs, handler, ws, we, { workdays });
  }

  const merged = mergeItems(ticketItems, taskItems);
  if (taskItems.length) {
    console.log(`合计 ${merged.length} 条（工单 ${ticketItems.length} + 任务中心 ${taskItems.length}，`
      + `去重后 ${merged.length}）`);
  }
  return merged;
}

function secs(ms) {
  return (ms / 1000).toFixed(1);
}

export { makeDate };
