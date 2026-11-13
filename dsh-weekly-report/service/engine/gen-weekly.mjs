#!/usr/bin/env node
/**
 * 周报引擎 CLI（Node 版）—— 与 Python 版 gen_weekly_text.py 的参数兼容。
 *
 * 面板（service/server.cjs）与计划任务都按原来的参数调用它：
 *   node gen-weekly.mjs --config <cfg> --week current --perf-auto --log
 *   node gen-weekly.mjs --config <cfg> --start 2026-11-01 --end 2026-11-30 --notify-dry-run
 *   node gen-weekly.mjs --config <cfg> --perf-dump --perf-xlsx <xlsx>
 *   node gen-weekly.mjs --config <cfg> --perf-check --perf-fix [--perf-month 2026-11]
 *
 * v0.9.0 起引擎是 Node（无 Python 依赖）。旧的邮件回填/离线表格模式已下线：
 *   --list-replies / --apply-confirmations / --confirm-* / --init-config / --file / --tickets / --source
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_HANDLER, DEFAULT_MCP_URL, DEFAULT_THRESHOLD, ENGINE_DIR, applyConfig, defaultOutPath, enableLog, resolveToken } from './lib/config.mjs';
import { collectItems } from './lib/collect.mjs';
import { McpClient, mcpError } from './lib/mcp.mjs';
import { currentWeek, lastMonthRange, monthRange, parseMonth, weeksInRange } from './lib/period.mjs';
// 绩效表功能（exceljs）按需加载：纯周报生成不需要它，缺依赖时给出可执行的提示而不是一堆堆栈
let perfLibPromise = null;
async function perfLib() {
  if (!perfLibPromise) {
    perfLibPromise = import('./lib/perf.mjs').catch((e) => {
      console.error('错误：缺少 npm 依赖 exceljs —— 绩效表功能需要它。');
      console.error('  在插件目录执行一次：pnpm i    或    npm i exceljs');
      console.error('  用 DSH 插件页从 GitHub 安装时，pnpm 会自动装这个依赖。');
      console.error(`  原因：${e && e.message ? e.message : e}`);
      process.exit(2);
    });
  }
  return perfLibPromise;
}
import { buildMailHtml, notify, notifyCfg, perfTableHtml } from './lib/notify.mjs';
import { loadReportTemplate, renderReport } from './lib/render.mjs';
import { fmtRange, isoDate, makeDate, todayCn, toDate, weekEndOf } from './lib/util.mjs';

const FLAGS = new Set([
  'last-month', 'auto-file', 'log', 'no-cache', 'no-tasks', 'perf-auto', 'perf-template-check',
  'perf-dump', 'perf-check', 'perf-fix', 'perf-platform', 'notify', 'notify-test',
  'notify-dry-run', 'no-miss-file', 'mcp-list-tools', 'where', 'dry-run',
  'perf-allow-insert', 'perf-preview',
]);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) {
      args._.push(raw);
      continue;
    }
    const name = raw.slice(2);
    if (FLAGS.has(name)) {
      args[camel(name)] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[camel(name)] = true;
      continue;
    }
    args[camel(name)] = next;
    i += 1;
  }
  return args;
}

function camel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.source && args.source !== 'tickets') {
    throw new Error('v0.9.0 起只支持 --source tickets（按绩效表反推的旧模式已下线）');
  }
  const dropped = ['listReplies', 'applyConfirmations', 'confirmText', 'confirmFile', 'confirmReport', 'initConfig', 'file', 'tickets'];
  const usedDropped = dropped.filter((k) => args[k] !== undefined);
  if (usedDropped.length) {
    throw new Error(`v0.9.0 已下线这些参数：${usedDropped.map((k) => '--' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())).join(', ')}`);
  }

  const env = applyConfig({ config: args.config, folder: args.folder });
  const cfg = env.config;
  const handler = args.handler || cfg.handler || DEFAULT_HANDLER;
  const threshold = args.threshold !== undefined ? Number(args.threshold)
    : Number(cfg.threshold || DEFAULT_THRESHOLD);
  const mcpUrl = args.mcpUrl || cfg.mcp_url || DEFAULT_MCP_URL;
  const folder = env.perfFolder;
  const outDir = env.outDir;

  if (args.where) {
    console.log(`脚本目录   ：${ENGINE_DIR}`);
    console.log(`配置文件   ：${env.configPath}${fs.existsSync(env.configPath) ? '' : '（未找到，使用默认）'}`);
    console.log(`考核表目录 ：${folder}`);
    console.log(`API Key    ：${env.tokenFile}（${fs.existsSync(env.tokenFile) ? '存在' : '未找到'}）`);
    console.log(`输出目录   ：${outDir}`);
    console.log(`MCP 地址   ：${mcpUrl}`);
    console.log(`处理人     ：${handler}`);
    console.log(`相似度阈值 ：${threshold}`);
    return 0;
  }

  if (args.log) enableLog(outDir);

  // --perf-layout <xlsx>：把表格版式识别结果吐成 JSON，面板用来「先看清楚要写哪些格子」
  if (args.perfLayout) {
    const target = String(args.perfLayout === true ? '' : args.perfLayout) || args.perfXlsx || '';
    if (!target || !fs.existsSync(target)) {
      console.log(JSON.stringify({ ok: false, error: `表格不存在：${target}` }));
      return 2;
    }
    const [{ detectPerfLayout, describeLayout, structureSignature }, x, p] = await Promise.all([
      import('./lib/perf-map.mjs'), import('./lib/xlsx.mjs'), perfLib(),
    ]);
    const book = await x.readWorkbook(target);
    const sheet = p.perfSheetOf(book);
    if (!sheet) {
      console.log(JSON.stringify({ ok: false, error: '没找到「月度考核」工作表' }));
      return 2;
    }
    const layout = detectPerfLayout(sheet);
    const sig = structureSignature(sheet);
    console.log(JSON.stringify({
      ok: true,
      file: target,
      sheet: sheet.name,
      detected: layout.detected,
      missing: layout.missing,
      layout,
      readable: describeLayout(layout),
      rows: layout.cap,
      used: p.readPerfRows(sheet, layout.firstRow, layout.cap, layout).length,
      signature: { rowCount: sig.rowCount, mergeCount: sig.mergeCount },
    }));
    return 0;
  }

  if (args.perfTemplateCheck) {
    const [y, m] = args.perfMonth ? parseMonth(args.perfMonth) : [todayCn().getFullYear(), todayCn().getMonth() + 1];
    console.log(JSON.stringify(await (await perfLib()).perfTemplateReport(folder, handler, y, m)));
    return 0;
  }

  if (args.perfDump) {
    let target = args.perfXlsx;
    if (!target) {
      const [y, m] = args.perfMonth ? parseMonth(args.perfMonth) : [todayCn().getFullYear(), todayCn().getMonth() + 1];
      target = (await perfLib()).perfPathFor(folder, handler, y, m);
    }
    if (!fs.existsSync(target)) {
      console.log(JSON.stringify({ error: '绩效表不存在', path: target }));
      return 2;
    }
    console.log(JSON.stringify(await (await perfLib()).perfDump(target)));
    return 0;
  }

  if (args.perfCheck) {
    const [y, m] = args.perfMonth ? parseMonth(args.perfMonth) : [todayCn().getFullYear(), todayCn().getMonth() + 1];
    const checkPath = args.perfXlsx || (await perfLib()).perfPathFor(folder, handler, y, m);
    let platformItems = null;
    if (args.perfPlatform) {
      const tokenArg = args.mcpToken || (fs.existsSync(env.tokenFile) ? env.tokenFile : '');
      if (!tokenArg) throw new Error('--perf-platform 需要 API Key：--mcp-token 或 yanfa_api_key.txt');
      const [ms, me] = monthRange(y, m);
      platformItems = await collectItems({
        token: resolveToken(tokenArg), mcpUrl, handler, ws: ms, we: me,
        mcpTool: args.mcpTool,
        mcpArgs: args.mcpArgs ? JSON.parse(args.mcpArgs) : {},
        withTasks: !args.noTasks,
      });
    }
    const result = await (await perfLib()).perfCheckReport({ path: checkPath, year: y, month: m, handler, platformItems, fix: Boolean(args.perfFix), outDir });
    return result.ok ? 0 : 2;
  }

  if (args.notifyTest) {
    const n = notifyCfg(cfg);
    if (!n.webhook_url && !(n.smtp && n.smtp.host)) throw new Error('未配置通知：请在配置的 notify 中填写 webhook_url 或 smtp.host');
    console.log('发送测试通知...');
    await notify(cfg, '【周报系统】测试通知',
      `这是一条测试通知，收到说明通知配置正确。\n时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      { dryRun: Boolean(args.notifyDryRun) });
    return 0;
  }

  if (args.mcpListTools) {
    const client = new McpClient(mcpUrl, resolveToken(args.mcpToken || env.tokenFile));
    const init = await client.initialize();
    const initErr = mcpError(init);
    if (initErr) throw new Error(`MCP 初始化失败：${initErr}`);
    const resp = await client.listTools();
    const err = mcpError(resp);
    if (err) throw new Error(`获取工具列表失败：${err}`);
    const out = { serverInfo: (init.result || {}).serverInfo, tools: (resp.result || {}).tools || [] };
    const target = args.out || path.join(process.cwd(), 'mcp_tools.json');
    fs.writeFileSync(target, JSON.stringify(out, null, 2), 'utf8');
    console.log(`已写出 ${target}（${out.tools.length} 个工具）`);
    return 0;
  }

  // ---- 周期：先算出一组自然周，每段出一份周报 ----
  let periods;
  if (args.lastMonth) {
    const [s, e] = lastMonthRange();
    periods = weeksInRange(s, e);
    console.log(`上个月：${isoDate(s)} ~ ${isoDate(e)}（按周拆成 ${periods.length} 份周报）`);
  } else if (args.month) {
    const [y, m] = parseMonth(args.month);
    const [s, e] = monthRange(y, m);
    periods = weeksInRange(s, e);
    console.log(`${y}年${m}月：${isoDate(s)} ~ ${isoDate(e)}（按周拆成 ${periods.length} 份周报）`);
  } else if (args.week === 'current' || args.start === 'current') {
    const [ws, we] = currentWeek();
    periods = [[ws, we]];
    console.log(`本周：${isoDate(ws)} ~ ${isoDate(we)}`);
  } else if (args.week === 'last') {
    const [ws0, we0] = currentWeek();
    const ws = new Date(ws0.getFullYear(), ws0.getMonth(), ws0.getDate() - 7);
    const we = new Date(we0.getFullYear(), we0.getMonth(), we0.getDate() - 7);
    periods = [[ws, we]];
    console.log(`上周：${isoDate(ws)} ~ ${isoDate(we)}`);
  } else {
    if (!args.start || !args.end) throw new Error('需要 --start/--end，或 --week current');
    const ws = toDate(args.start);
    const we = toDate(args.end);
    if (!ws || !we) throw new Error('日期格式应为 YYYY-MM-DD');
    periods = weeksInRange(ws, we);
    console.log(periods.length > 1
      ? `区间 ${isoDate(ws)} ~ ${isoDate(we)}：按周拆成 ${periods.length} 份周报`
      : `区间 ${isoDate(ws)} ~ ${isoDate(we)}`);
  }

  // ---- 数据 ----
  let tokenArg = args.mcpToken;
  if (!tokenArg && fs.existsSync(env.tokenFile)) {
    tokenArg = env.tokenFile;
    console.log(`使用默认 API Key：${env.tokenFile}`);
  }
  if (!tokenArg) throw new Error('工单模式需要 API Key：--mcp-token 或 yanfa_api_key.txt');
  const token = resolveToken(tokenArg);
  const dataArgs = args.mcpArgs ? JSON.parse(args.mcpArgs) : {};
  const rptTemplate = loadReportTemplate(args.reportTemplate || cfg.report_template || '');

  const artifacts = { reports: [], perf: [], weeks: [] };
  const perfMonths = new Map();

  let spanStart = periods.reduce((min, p) => (p[0] < min ? p[0] : min), periods[0][0]);
  let spanEnd = periods.reduce((max, p) => (p[1] > max ? p[1] : max), periods[0][1]);
  const touched = new Set();
  for (const [s, e] of periods) {
    touched.add(`${s.getFullYear()}-${s.getMonth() + 1}`);
    touched.add(`${e.getFullYear()}-${e.getMonth() + 1}`);
  }
  for (const key of touched) {
    const [y, m] = key.split('-').map(Number);
    const [ms, me] = monthRange(y, m);
    if (ms < spanStart) spanStart = ms;
    if (me > spanEnd) spanEnd = me;
  }

  const allItems = await collectItems({
    token, mcpUrl, handler, ws: spanStart, we: spanEnd,
    mcpTool: args.mcpTool, mcpArgs: dataArgs,
    withTasks: !args.noTasks, useCache: !args.noCache,
  });
  console.log(`已采集 ${isoDate(spanStart)} ~ ${isoDate(spanEnd)}：${allItems.length} 条`);

  const itemsOfWeek = (weekStart, weekEnd) => {
    const out = [];
    for (const it of allItems) {
      const dates = (it.work_dates || []).map(toDate).filter(Boolean);
      const inWeek = dates.filter((d) => d >= weekStart && d <= weekEnd);
      if (!inWeek.length) {
        const created = toDate(it.created);
        if (!created || !(created >= weekStart && created <= weekEnd)) continue;
        // 本周新建、还没记工时的条目：沿用开始时间，结束时间同样不许越过本周周日
        const copy = { ...it };
        const openEnd = weekEndOf(created) > weekEnd ? weekEnd : weekEndOf(created);
        copy.d1 = isoDate(created);
        copy.d2 = isoDate(copy.settled ? (toDate(it.d2) || created) : openEnd);
        copy.time = fmtRange(created, toDate(copy.d2));
        out.push(copy);
        continue;
      }
      const w1 = inWeek[0];
      const w2 = inWeek[inWeek.length - 1];
      const copy = { ...it };
      const marks = (it.week_marks || {})[isoDate(weekStart)] || {};
      const doneByRemark = Boolean(marks.done);
      const comp = it.completion || '';
      const doneByPlatform = Boolean(it.settled_platform && comp
        && isoDate(weekStart) <= comp && comp <= isoDate(weekEnd));
      copy.settled = Boolean(doneByRemark || doneByPlatform);
      copy.done = copy.settled;
      if (copy.settled) copy.progress = '100%';
      else if (marks.progress) copy.progress = `${Math.trunc(marks.progress)}%`;

      // 周报时间口径：本周未完成的事项，结束时间取「本周周日」，
      // 不能写成月末 / 未来日期，否则周报里会出现越过本周的时间。
      const endDate = copy.settled ? w2 : (weekEndOf(w1) > weekEnd ? weekEnd : weekEndOf(w1));
      copy.d1 = isoDate(w1);
      copy.d2 = isoDate(endDate);
      copy.time = fmtRange(w1, endDate);
      out.push(copy);
    }
    // 兜底：周报里的时间一律不越过本周周日（未完成的事项尤其容易写成月末/未来）
    for (const it of out) {
      const e = toDate(it.d2);
      if (e && e > weekEnd) {
        it.d2 = isoDate(weekEnd);
        it.time = fmtRange(toDate(it.d1), weekEnd);
      }
    }
    out.sort((a, b) => cmp(a.d1) || cmp(a.school) || cmp(a.subject));
    return out;
  };

  for (const [ws, we] of periods) {
    const items = itemsOfWeek(ws, we);
    const outPath = args.out || defaultOutPath(outDir, ws, we);
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    const text = renderReport(items, rptTemplate);
    // 与历史文件保持一致：Python 版用文本模式写盘，Windows 上换行是 CRLF
    fs.writeFileSync(outPath, text.replace(/\r?\n/g, '\r\n'), 'utf8');
    console.log(`OK ${items.length} 条 out=${outPath}`);
    artifacts.reports.push({ path: outPath, name: path.basename(outPath), start: isoDate(ws), end: isoDate(we), count: items.length });
    artifacts.weeks.push({ start: isoDate(ws), end: isoDate(we), count: items.length });

    const missPath = `${outPath.replace(/\.txt$/i, '')}_未匹配.txt`;
    if (fs.existsSync(missPath)) fs.rmSync(missPath, { force: true });

    for (const key of new Set([`${ws.getFullYear()}-${ws.getMonth() + 1}`, `${we.getFullYear()}-${we.getMonth() + 1}`])) {
      const [y, m] = key.split('-').map(Number);
      if (!perfMonths.has(key)) perfMonths.set(key, []);
      perfMonths.get(key).push({ ws, we, items });
    }
  }

  // ---- 绩效表：每个月一份，把该月各周内容并进去 ----
  if (args.perfXlsx || args.perfAuto) {
    const monthKeys = [...perfMonths.keys()].sort((a, b) => {
      const [ay, am] = a.split('-').map(Number);
      const [by, bm] = b.split('-').map(Number);
      return ay - by || am - bm;
    });
    for (const key of monthKeys) {
      const [y, m] = key.split('-').map(Number);
      if (args.perfMonth) {
        const [py, pm] = parseMonth(args.perfMonth);
        if (py !== y || pm !== m) continue;
      }
      const perfOut = args.perfXlsx || (await perfLib()).perfPathFor(folder, handler, y, m);
      if (!fs.existsSync(folder)) {
        console.log(`提示：绩效目录不存在（${folder}），本次跳过绩效文档`);
        continue;
      }
      const [ms, me] = monthRange(y, m);
      const segs = perfMonths.get(key);
      const mItems = [];
      for (const seg of segs) mItems.push(...seg.items);
      const covered = ms >= spanStart && me <= spanEnd;
      if (!covered) {
        const extra = await collectItems({
          token, mcpUrl, handler, ws: ms, we: me,
          mcpTool: args.mcpTool, mcpArgs: dataArgs, withTasks: !args.noTasks, useCache: !args.noCache,
        });
        const have = new Set(mItems.map((i) => `${i.school}\u0000${i.subject}`));
        for (const i of extra) {
          const k = `${i.school}\u0000${i.subject}`;
          if (!have.has(k)) mItems.push(i);
        }
      } else {
        const have = new Set(mItems.map((i) => `${i.school}\u0000${i.subject}`));
        for (const it of allItems) {
          const a = toDate(it.d1);
          if (!a || !(a >= ms && a <= me)) continue;
          const k = `${it.school}\u0000${it.subject}`;
          if (!have.has(k)) mItems.push(it);
        }
      }
      const monthEndWeek = segs.some((seg) => seg.we >= new Date(me.getFullYear(), me.getMonth(), me.getDate() - 6));

      let tpl = args.perfTemplate || cfg.perf_template || '';
      if (!tpl) tpl = fs.existsSync(perfOut) ? perfOut : (await perfLib()).autoPickXlsx(folder, ms);
      if (!tpl || !fs.existsSync(tpl)) {
        console.log(`提示：绩效表目录里还没有可用的模板（${folder}），本次不写绩效表；`
          + '把一张月度考核表放进该目录即可自动套用');
        continue;
      }
      const built = await (await perfLib()).buildPerfXlsx({
        templatePath: tpl, outPath: perfOut, items: mItems, year: y, month: m, handler,
        allowInsert: Boolean(args.perfAllowInsert || cfg.perf_allow_insert),
        dryRun: Boolean(args.perfPreview),
      });
      const builtPath = typeof built === 'string' ? built : built.path;
      artifacts.perf.push({
        path: builtPath, name: path.basename(builtPath), year: y, month: m, count: mItems.length,
        added: typeof built === 'string' ? undefined : built.added,
        changes: typeof built === 'string' ? undefined : (built.changes || []).length,
        structure: typeof built === 'string' ? undefined : built.structural,
        backup: typeof built === 'string' ? undefined : built.backup,
      });

      const plat = allItems.filter((it) => {
        const d = toDate(it.d1);
        return d && d >= ms && d <= me;
      });
      const runItems = segs.flatMap((seg) => seg.items);
      if (!args.perfPreview) {
        await (await perfLib()).perfCheckReport({
          path: builtPath, year: y, month: m, handler,
          fix: true, platformItems: plat, extraItems: runItems, platformFix: monthEndWeek, outDir,
        });
      }
      if (monthEndWeek) {
        console.log(`（本轮已覆盖 ${y}年${m}月月末：这是月底最终核对，已用平台整月数据补全）`);
      }
    }

    // 上个月的绩效表若还没核对过，顺手补一次
    for (const key of monthKeys) {
      const [y, m] = key.split('-').map(Number);
      const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
      const prevOut = (await perfLib()).perfPathFor(folder, handler, py, pm);
      if (fs.existsSync(prevOut) && !fs.existsSync(prevOut.replace(/\.xlsx$/i, '') + '_核对.txt')) {
        console.log(`上个月（${py}年${pm}月）绩效表还没有核对报告，补一次核对`);
        await (await perfLib()).perfCheckReport({ path: prevOut, year: py, month: pm, handler, fix: true, outDir });
      }
    }
  }

  console.log(`ARTIFACTS_JSON ${JSON.stringify(artifacts)}`);

  // ---- 通知 ----
  const n = notifyCfg(cfg);
  if (args.notify || n.enabled) {
    const total = artifacts.weeks.reduce((sum, w) => sum + w.count, 0);
    const first = artifacts.weeks[0];
    const last = artifacts.weeks[artifacts.weeks.length - 1];
    const span = first && last ? `${first.start} ~ ${last.end}` : (first ? first.start : '-');
    const summary = `${span}：共 ${artifacts.reports.length} 份周报 / ${total} 条事项`;
    const subject = `【周报】${span}（${total} 条 / ${artifacts.reports.length} 份）`;
    const bodyLines = [`周期：${span}`, summary, ''];
    const reportTexts = [];
    for (const a of artifacts.reports) {
      let txt = '';
      try {
        txt = fs.readFileSync(a.path, 'utf8');
      } catch (e) {
        txt = `（读取失败：${e.message}）`;
      }
      reportTexts.push(txt);
      bodyLines.push('='.repeat(56), `周报 ${a.start} ~ ${a.end}（${a.count} 条）`, '='.repeat(56), txt.replace(/\s+$/, ''), '');
    }
    const perfLines = [];
    if (artifacts.perf.length) {
      perfLines.push('绩效表：');
      for (const a of artifacts.perf) perfLines.push(`  ${a.year}年${a.month}月：${a.count} 条  ${a.path}`);
      bodyLines.push('', ...perfLines);
    }
    let perfHtml = '';
    for (const a of artifacts.perf) {
      try {
        perfHtml += await perfTableHtml(a.path, handler);
      } catch (e) {
        perfHtml += `<p style="color:#b42318;">绩效表读取失败：${e.message}</p>`;
      }
    }
    const html = buildMailHtml(span, summary, reportTexts.join('\n\n'), perfLines.join('\n'), perfHtml);
    const webhookBody = [summary, ...artifacts.reports.map((a) => `周报：${a.path}`),
      ...artifacts.perf.map((a) => `绩效表：${a.path}`)].join('\n');
    await notify(cfg, subject, bodyLines.join('\n'), {
      dryRun: Boolean(args.notifyDryRun), html, webhookBody,
    });
  }
  return 0;
}

function cmp(a) {
  return (b) => (String(a || '') < String(b || '') ? -1 : String(a || '') > String(b || '') ? 1 : 0);
}

main().then((code) => {
  process.exitCode = code || 0;
}).catch((e) => {
  console.error(`错误：${e && e.message ? e.message : e}`);
  process.exitCode = 1;
});

export { main, parseArgs };
