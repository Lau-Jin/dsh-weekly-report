/**
 * 周报工作台 · 本地面板服务（CommonJS，仅 Node 标准库）
 *
 * v1.0：文件名与端口沿用旧版（server.cjs / 8798），因此 DSH 里已加载的侧边栏
 * iframe 与宿主保活心跳无需任何改动，安装后立刻能看到新界面 —— 这是「免重启」的关键。
 *
 * 只监听 127.0.0.1；所有写操作都发生在 <data> 或使用者指定的输出目录内。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const P = require('./paths.cjs');
const PerfDeps = require('./perf-deps.cjs');

/**
 * 版本号只从 package.json 读一次，避免改了包版本而面板还显示旧号。
 * 版本规则（使用者约定）：小改动走最后一位（1.0.0 → 1.0.1），
 * 功能级/行为变化走第二位（1.0.x → 1.1.0）。
 */
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
})();
const PORT = Number(process.env.WEEKLY_PANEL_PORT || 8798);
const HOST = '127.0.0.1';
const STARTED = Date.now();
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon', '.png': 'image/png',
};

let run = {
  running: false, startedAt: null, finishedAt: null, exitCode: null,
  lines: [], args: [], outPath: '', error: '', child: null,
  artifacts: { reports: [], perf: [], weeks: [] },
};

// ---------------------------------------------------------------- 定时生成
/**
 * 内置调度器：不依赖系统计划任务 / 外部 cron，面板服务常驻即生效。
 *   - 每 20 秒 tick 一次，命中「周几 + 时 + 分」且未触发过该分钟槽才触发；
 *   - 触发动作完全复用 startRun（API Key / 绩效表目录 / 组件等校验、运行日志全部一致）；
 *   - 已触发的分钟槽持久化到数据目录，服务被心跳拉起重启后不会在同一分钟内重复生成。
 */
const SCHEDULE_TICK_MS = 20000;
const SCHEDULE_STATE_FILE = () => path.join(P.DATA_DIR, 'schedule-state.json');
let sched = { lastSlot: '', lastRunAt: null, lastResult: null, timer: null };

function pad2(n) { return String(n).padStart(2, '0'); }

/** 计算下一次运行时刻；未开启或配置非法返回 null。 */
function computeNextRun(sc, now) {
  if (!sc || !sc.enabled) return null;
  const wd = Number(sc.weekday); const hh = Number(sc.hour); const mm = Number(sc.minute);
  if (!Number.isInteger(wd) || wd < 0 || wd > 6) return null;
  if (!Number.isInteger(hh) || hh < 0 || hh > 23) return null;
  if (!Number.isInteger(mm) || mm < 0 || mm > 59) return null;
  const base = now || new Date();
  for (let i = 0; i < 8; i += 1) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, hh, mm, 0, 0);
    if (d.getDay() === wd && d.getTime() > base.getTime()) return d;
  }
  return null;
}

function readSchedState() {
  try { return JSON.parse(fs.readFileSync(SCHEDULE_STATE_FILE(), 'utf8')) || {}; } catch { return {}; }
}

function writeSchedState(patch) {
  try { P.atomicWrite(SCHEDULE_STATE_FILE(), JSON.stringify({ ...readSchedState(), ...patch }, null, 2) + '\n'); } catch { /* ignore */ }
}

/** 到点触发：复用 startRun 的全部校验与日志，并在运行日志里标注来源。 */
function scheduledFire(now) {
  const slot = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  if (sched.lastSlot === slot || readSchedState().lastSlot === slot) return; // 本分钟已触发过
  sched.lastSlot = slot;
  writeSchedState({ lastSlot: slot });
  const sc = P.loadConfig().config.schedule || {};
  P.log(`schedule: fire ${slot} weekday=${sc.weekday} perfAuto=${sc.perfAuto ? 1 : 0}`);
  const r = startRun({ period: 'current', perfAuto: Boolean(sc.perfAuto), scheduled: true });
  sched.lastRunAt = new Date().toISOString();
  sched.lastResult = r.ok ? 'started' : String(r.error || 'failed');
  if (!r.ok) P.log(`schedule: trigger rejected: ${r.error || '未知原因'}`);
  else pushLine(`[scheduled] 定时任务已触发（${slot}）`);
}

function scheduleTick() {
  try {
    const sc = P.loadConfig().config.schedule;
    if (!sc || !sc.enabled) return;
    const now = new Date();
    if (now.getDay() !== Number(sc.weekday)) return;
    if (now.getHours() !== Number(sc.hour) || now.getMinutes() !== Number(sc.minute)) return;
    if (run.running) return; // 有手动任务在跑就不抢，下个周期再触发
    scheduledFire(now);
  } catch (e) { P.log(`schedule tick error: ${(e && e.message) || e}`); }
}

function startScheduler() {
  if (sched.timer) clearInterval(sched.timer);
  const st = readSchedState();
  sched.lastSlot = String(st.lastSlot || '');
  if (typeof st.lastRunAt === 'string') sched.lastRunAt = st.lastRunAt;
  if (typeof st.lastResult === 'string') sched.lastResult = st.lastResult;
  sched.timer = setInterval(scheduleTick, SCHEDULE_TICK_MS);
  if (sched.timer && typeof sched.timer.unref === 'function') sched.timer.unref();
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error(`JSON 解析失败：${e.message}`)); }
    });
    req.on('error', reject);
  });
}

function engineNode() {
  const candidates = [
    process.env.WEEKLY_PANEL_NODE,
    process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
      : '',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || process.execPath;
}

function excelAvailable() {
  // exceljs 是可选的：纯周报 txt 不需要，只有写绩效表 xlsx 才用。
  // 用文件存在性判断（require.resolve 会缓存失败结果，补装后状态不会刷新）。
  return PerfDeps.isAvailable(P.PLUGIN_DIR);
}

function pushLine(line) {
  if (line === '' || line === undefined) return;
  run.lines.push(String(line));
  if (run.lines.length > 400) run.lines.shift();
}

/** 把面板上的周期选择翻译成引擎 CLI 参数。 */
function resolvePeriod(body, cfg) {
  const args = ['--config', P.CONFIG];
  const period = body.period || 'current';
  if (period === 'range' && body.start && body.end) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.start) || !/^\d{4}-\d{2}-\d{2}$/.test(body.end)) {
      throw new Error('日期格式应为 YYYY-MM-DD');
    }
    if (body.end < body.start) throw new Error('结束日期不能早于开始日期');
    args.push('--start', body.start, '--end', body.end);
  } else if (period === 'last') args.push('--week', 'last');
  else if (period === 'lastMonth') args.push('--last-month');
  else if (period === 'month' && /^\d{4}-\d{2}$/.test(String(body.month || ''))) args.push('--month', body.month);
  else args.push('--week', 'current');

  if (body.perfAuto) args.push('--perf-auto');
  if (body.noTasks) args.push('--no-tasks');
  if (body.noCache) args.push('--no-cache');
  args.push('--log');
  return args;
}

function startRun(body) {
  if (run.running) return { ok: false, error: '已有生成任务在运行' };
  if (!fs.existsSync(P.ENGINE)) return { ok: false, error: '缺少内置引擎 service/engine/gen-weekly.mjs' };
  const cfg = P.loadConfig().config;
  const key = P.readKey();
  if (!key) return { ok: false, error: '还没有填写 API Key，请到「设置」页提供' };
  if (body.perfAuto && !excelAvailable()) {
    return { ok: false, error: '绩效表写入需要 exceljs，请到「设置」页点「补装绩效表组件」' };
  }
  if (body.perfAuto && !cfg.folder) {
    return { ok: false, error: '勾选了绩效表，但还没有提供绩效表目录' };
  }

  let args;
  try { args = resolvePeriod(body, cfg); }
  catch (e) { return { ok: false, error: e.message }; }

  run = {
    running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
    lines: [], args, outPath: '', error: '', child: null,
    artifacts: { reports: [], perf: [], weeks: [] },
  };
  const nodeExe = engineNode();
  pushLine('$ ' + [nodeExe, P.ENGINE, ...args].join(' '));
  const child = spawn(nodeExe, [P.ENGINE, ...args], {
    cwd: P.ENGINE_DIR, windowsHide: true,
    env: { ...process.env, WEEKLY_DATA_DIR: P.DATA_DIR, WEEKLY_PANEL_DATA: P.DATA_DIR },
  });
  run.child = child;
  const onData = (buf) => { for (const l of buf.toString('utf8').split(/\r?\n/)) pushLine(l); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => { run.error = String(e.message || e); pushLine('启动失败：' + run.error); });
  child.on('close', (code) => {
    run.running = false; run.exitCode = code; run.finishedAt = new Date().toISOString(); run.child = null;
    for (const line of run.lines) {
      const m = /^OK\s+\d+\s+条\s+out=(.+)$/.exec(line.trim());
      if (m) run.outPath = m[1].trim();
      const a = /^ARTIFACTS_JSON\s+(.+)$/.exec(line.trim());
      if (a) { try { run.artifacts = JSON.parse(a[1]); } catch { /* ignore */ } }
      if (/连接研发平台失败|MCP 初始化失败/.test(line)) run.error = '连不上研发平台，请检查 MCP 地址与 API Key';
      if (/缺少 npm 依赖 exceljs/.test(line)) run.error = '绩效表组件未安装';
    }
    if (code !== 0 && !run.error) run.error = `引擎退出码 ${code}，请查看下方日志`;
    P.log(`run finished code=${code} out=${run.outPath}`);
  });
  return { ok: true, args };
}

function publicRun() {
  return {
    running: run.running, startedAt: run.startedAt, finishedAt: run.finishedAt,
    exitCode: run.exitCode, lines: run.lines.slice(-250), args: run.args,
    outPath: run.outPath, error: run.error,
    artifacts: run.artifacts || { reports: [], perf: [], weeks: [] },
  };
}

/** 概览页的「准备度」：把缺口说人话，不给一堆红错。 */
function buildChecks(cfg) {
  const key = P.readKey();
  const probe = P.probeUserPaths(cfg);
  const checks = [];
  checks.push(key
    ? { level: 'ok', title: 'API Key', text: '已提供，可以读取工单数据' }
    : { level: 'todo', title: 'API Key', text: '需要你提供研发平台 API Key，才能获取工单数据' });
  checks.push(cfg.handler
    ? { level: 'ok', title: '处理人', text: `当前：${cfg.handler}` }
    : { level: 'todo', title: '处理人', text: '填写你的姓名，用于匹配本人负责的工单' });
  checks.push({
    level: probe.out && probe.out.writable ? 'ok' : 'warn',
    title: '周报输出目录',
    text: probe.out && probe.out.writable ? probe.out.path : '尚未指定可写的输出目录',
  });
  checks.push({
    level: probe.template ? 'ok' : 'warn',
    title: '周报模板',
    text: probe.template
      ? `${probe.template.builtin ? '内置模板' : path.basename(probe.template.path)} · ${probe.template.placeholders.length} 个占位符`
      : '未找到模板，将使用内置格式',
  });
  checks.push({
    level: probe.perf && probe.perf.count ? 'ok' : 'info',
    title: '绩效表',
    text: probe.perf && probe.perf.count
      ? `已识别 ${probe.perf.count} 张 xlsx（${probe.perf.path}）`
      : '可选：提供绩效表目录后，生成时同步写入（格式保持不变）',
  });
  if (cfg.folder && !excelAvailable()) {
    checks.push({ level: 'warn', title: '绩效表组件', text: '缺少 exceljs，到「设置」页一键补装即可' });
  }
  return { checks, probe };
}

function collectState() {
  const loaded = P.loadConfig();
  const cfg = loaded.config;
  const extra = buildChecks(cfg);
  const reports = P.listReports(cfg.out_dir);
  return {
    ok: true, version: VERSION, pid: process.pid, startedAt: new Date(STARTED).toISOString(),
    uptimeMs: Date.now() - STARTED, busy: run.running,
    dataDir: P.DATA_DIR,
    paths: {
      plugin: P.PLUGIN_DIR, engine: P.ENGINE, config: P.CONFIG, key: P.KEY,
      reports: cfg.out_dir || P.REPORTS, template: cfg.report_template || P.TEMPLATE_FILE,
    },
    config: P.maskConfig(cfg), configError: loaded.error,
    key: P.keyInfo(), excelAvailable: excelAvailable(),
    schedule: {
      config: cfg.schedule || null,
      nextRunAt: (() => { const d = computeNextRun(cfg.schedule, new Date()); return d ? d.toISOString() : null; })(),
      lastRunAt: sched.lastRunAt, lastResult: sched.lastResult,
      running: run.running,
    },
    checks: extra.checks, probe: extra.probe,
    reports: reports.slice(0, 12), reportCount: reports.length,
    run: publicRun(), serverTime: new Date().toISOString(),
  };
}

/**
 * 打开目录 / 在资源管理器里选中文件。
 *
 * 旧实现 execFile('explorer.exe', ..., () => {}) 把异步错误整个吞掉，永远返回
 * ok:true；服务又由 DSH 内置 Node 启动，PATH 里未必能解析到 explorer.exe，
 * 于是按钮点了「成功」却什么也没发生。现在用 WINDIR 绝对路径 + spawn，
 * 预检路径与目标存在性，并把真实结果返回给前端做提示。
 * 注意：explorer.exe 打开目录时常返回非零退出码但仍正常弹窗，因此不等待退出码。
 */
/** 在绩效目录里挑一张「最像本月」的表：先按 年月 匹配，再退到最新的 xlsx */
function pickPerfFile(folder) {
  const now = new Date();
  const tag = `${now.getFullYear()}年${now.getMonth() + 1}月`;
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of names) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!ent.name.startsWith('.')) walk(full, depth + 1);
      } else if (/\.xlsx$/i.test(ent.name) && !ent.name.startsWith('~$')) {
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
        found.push({ full, name: ent.name, mtime });
      }
    }
  };
  walk(folder, 0);
  if (!found.length) return '';
  const hit = found.filter((f) => f.name.includes(tag)).sort((a, b) => b.mtime - a.mtime)[0];
  return (hit || found.sort((a, b) => b.mtime - a.mtime)[0]).full;
}

async function openDir(target) {
  const dir = path.resolve(String(target || P.DATA_DIR));
  if (!fs.existsSync(dir)) return { ok: false, error: `路径不存在：${dir}`, path: dir };
  let isFile = false;
  try { isFile = fs.statSync(dir).isFile(); }
  catch (e) { return { ok: false, error: String(e.message || e), path: dir }; }

  let exe; let args; let method;
  if (process.platform === 'win32') {
    const win = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
    exe = path.join(win, 'explorer.exe');
    if (!fs.existsSync(exe)) return { ok: false, error: '找不到 explorer.exe', path: dir };
    args = isFile ? [`/select,${dir}`] : [dir];
    method = 'explorer.exe';
  } else if (process.platform === 'darwin') {
    exe = '/usr/bin/open';
    if (!fs.existsSync(exe)) return { ok: false, error: '找不到 open', path: dir };
    args = isFile ? ['-R', dir] : [dir];
    method = 'open';
  } else {
    exe = '/usr/bin/xdg-open';
    if (!fs.existsSync(exe)) return { ok: false, error: '找不到 xdg-open', path: dir };
    args = [isFile ? path.dirname(dir) : dir];
    method = 'xdg-open';
  }
  /**
   * 关键：windowsHide 必须为 false。
   * explorer.exe 会继承启动信息里的「显示窗口」标志，设成 hidden 时新窗口
   * 照样被创建，但永远不可见 —— 表现就是「点了没反应」（进程确实起来了）。
   * 2026-11-13 实测：hidden 时带窗口的 explorer 数量不变，visible 时 +1。
   */
  const launch = (cmd, argv, extra = {}) => new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(cmd, argv, { detached: true, stdio: 'ignore', windowsHide: false, ...extra });
    } catch (e) {
      done({ ok: false, error: String((e && e.message) || e) });
      return;
    }
    child.on('error', (e) => done({ ok: false, error: String((e && e.message) || e) }));
    // explorer 成功打开也常返回 1，所以只把「立刻失败」当错误，成功态先返回
    const timer = setTimeout(() => { try { child.unref(); } catch { /* ignore */ } done({ ok: true }); }, 350);
    child.on('exit', (code) => {
      clearTimeout(timer);
      try { child.unref(); } catch { /* ignore */ }
      // 0 与 1 都视为已转交资源管理器；其它码当作失败原因
      if (code === 0 || code === 1 || code === null) done({ ok: true });
      else done({ ok: false, error: `${path.basename(cmd)} 退出码 ${code}` });
    });
  });

  try {
    let r = await launch(exe, args);
    if (!r.ok && process.platform === 'win32' && isFile) {
      // /select 偶发失败时退回「打开所在目录」，至少让使用者看到位置
      r = await launch(exe, [path.dirname(dir)]);
    }
    if (!r.ok && process.platform === 'win32') {
      // 最后兜底：走 cmd 的 start（不依赖 PATH 里的 explorer）
      const comspec = process.env.ComSpec || path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'cmd.exe');
      r = await launch(comspec, ['/c', 'start', '', isFile ? `/select,${dir}` : dir]);
    }
    if (!r.ok) {
      P.log(`open-dir ${method} failed: ${r.error} (${dir})`);
      return { ok: false, error: `未能唤起资源管理器：${r.error}`, path: dir, method };
    }
    P.log(`open-dir ${method} ${isFile ? '/select,' : ''}${dir}`);
    return { ok: true, path: dir, method, selected: isFile };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), path: dir, method };
  }
}

/** 修复历史周报里被空 school 切断的记录（纯函数来自引擎，写前备份）。 */
async function repairReports(onlyFile) {
  const cfg = P.loadConfig().config;
  const root = cfg.out_dir && fs.existsSync(cfg.out_dir) ? cfg.out_dir : P.REPORTS;
  const mod = await import(pathToFileURL(path.join(P.ENGINE_DIR, 'repair-report.mjs')).href);
  const { repairText, collect } = mod;
  const files = onlyFile ? [path.resolve(onlyFile)] : collect(root);
  const details = [];
  let fixed = 0;
  for (const file of files) {
    // 只允许修周报输出目录内的 周报_*.txt
    const abs = path.resolve(file);
    if (!abs.startsWith(path.resolve(root) + path.sep) || !/^周报_.*\.txt$/i.test(path.basename(abs))) continue;
    let original;
    try { original = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const r = repairText(original);
    if (!r.fixed) continue;
    P.backup(abs);
    fs.writeFileSync(abs, r.text, 'utf8');
    fixed += r.fixed;
    details.push({ file: path.basename(abs), changes: r.changes });
  }
  P.log(`repair reports scanned=${files.length} fixed=${fixed}`);
  return { ok: true, scanned: files.length, fixed, details };
}

function serveStatic(res, pathname) {
  let rel = '/index.html';
  try { rel = decodeURIComponent(pathname || '/'); } catch { /* ignore */ }
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(P.PUBLIC_DIR, rel.replace(/^\/+/, ''));
  if (!full.startsWith(P.PUBLIC_DIR)) return json(res, 403, { ok: false, error: '禁止访问' });
  fs.readFile(full, (err, buf) => {
    if (err) return json(res, 404, { ok: false, error: '文件不存在：' + rel });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  try {
    if ((method === 'GET' || method === 'HEAD') && (p === '/api/ping' || p === '/api/health')) {
      return json(res, 200, { ok: true, version: VERSION, pid: process.pid, startedAt: new Date(STARTED).toISOString(), uptimeMs: Date.now() - STARTED, busy: run.running });
    }
    if (method === 'GET' && (p === '/api/state' || p === '/api/status')) return json(res, 200, collectState());

    if (method === 'POST' && p === '/api/config') {
      const body = await readBody(req);
      const cfg = P.saveConfig(body.config || body);
      P.log('config saved');
      return json(res, 200, { ok: true, config: P.maskConfig(cfg) });
    }
    if (method === 'POST' && p === '/api/api-key') {
      const body = await readBody(req);
      P.writeKey(body.key || body.apiKey || '');
      P.log('api key updated');
      return json(res, 200, { ok: true, key: P.keyInfo() });
    }

    if (method === 'GET' && p === '/api/template') {
      const cfg = P.loadConfig().config;
      const file = cfg.report_template || P.TEMPLATE_FILE;
      try {
        return json(res, 200, {
          ok: true, path: file, builtin: !cfg.report_template,
          text: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''),
          builtinText: fs.readFileSync(P.TEMPLATE_FILE, 'utf8').replace(/^\uFEFF/, ''),
        });
      } catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    if (method === 'POST' && p === '/api/template') {
      const body = await readBody(req);
      const text = String(body.text || '');
      if (!text.trim()) return json(res, 400, { ok: false, error: '模板内容不能为空' });
      const file = path.join(P.DATA_DIR, '周报模板.txt');
      P.atomicWrite(file, text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
      P.saveConfig({ report_template: file });
      return json(res, 200, { ok: true, path: file });
    }
    if (method === 'POST' && p === '/api/template/reset') {
      P.saveConfig({ report_template: '' });
      return json(res, 200, { ok: true, path: P.TEMPLATE_FILE });
    }

    if (method === 'POST' && p === '/api/run') return json(res, 200, startRun(await readBody(req)));
    if (method === 'GET' && p === '/api/run') return json(res, 200, publicRun());
    if (method === 'POST' && p === '/api/run/cancel') {
      if (run.child) { try { run.child.kill(); } catch { /* ignore */ } }
      return json(res, 200, { ok: true });
    }

    if (method === 'GET' && p === '/api/reports') {
      const cfg = P.loadConfig().config;
      return json(res, 200, { ok: true, reports: P.listReports(cfg.out_dir) });
    }
    if (method === 'POST' && p === '/api/reports/repair') {
      const body = await readBody(req);
      return json(res, 200, await repairReports(body.path || ''));
    }
    if (method === 'GET' && p === '/api/report') {
      const cfg = P.loadConfig().config;
      return json(res, 200, P.readReport(url.searchParams.get('path'), cfg.out_dir));
    }
    if (method === 'POST' && p === '/api/open-dir') {
      const body = await readBody(req);
      return json(res, 200, await openDir(body.path || body.dir));
    }

    if (method === 'GET' && p === '/api/fs') return json(res, 200, P.listDirs(url.searchParams.get('path')));
    if (method === 'POST' && p === '/api/fs/mkdir') {
      const body = await readBody(req);
      const target = String(body.path || '').trim();
      if (!target || /[<>:"|?*]/.test(path.basename(target))) return json(res, 400, { ok: false, error: '目录名不合法' });
      fs.mkdirSync(target, { recursive: true });
      return json(res, 200, { ok: true, path: target });
    }

    if (method === 'POST' && p === '/api/test-key') {
      const cfg = P.loadConfig().config;
      if (!P.readKey()) return json(res, 200, { ok: false, error: '还没有填写 API Key' });
      const out = path.join(P.DATA_DIR, 'mcp-tools.json');
      const args = [P.ENGINE, '--config', P.CONFIG, '--mcp-list-tools', '--mcp-token', P.KEY, '--out', out];
      const child = spawn(engineNode(), args, { cwd: P.ENGINE_DIR, windowsHide: true });
      let buf = '';
      let replied = false;
      const reply = (extra) => {
        if (replied) return;
        replied = true;
        let count = 0;
        try { count = (JSON.parse(fs.readFileSync(out, 'utf8')).tools || []).length; } catch { /* ignore */ }
        json(res, 200, { tools: count, detail: buf.trim().slice(-1200), ...extra });
      };
      child.stdout.on('data', (d) => { buf += PerfDeps.decode(d); });
      child.stderr.on('data', (d) => { buf += PerfDeps.decode(d); });
      child.on('error', (e) => { buf += `\n启动失败：${e.message}`; reply({ ok: false, code: -1 }); });
      child.on('close', (code) => reply({ ok: code === 0, code }));
      return;
    }

    if (method === 'POST' && p === '/api/perf-check') {
      if (!excelAvailable()) return json(res, 200, { ok: false, error: '绩效表组件未安装' });
      const body = await readBody(req);
      const month = /^\d{4}-\d{2}$/.test(String(body.month || '')) ? body.month : undefined;
      const args = [P.ENGINE, '--config', P.CONFIG, '--perf-check'];
      if (month) args.push('--perf-month', month);
      if (body.fix) args.push('--perf-fix');
      const child = spawn(engineNode(), args, {
        cwd: P.ENGINE_DIR, windowsHide: true,
        env: { ...process.env, WEEKLY_DATA_DIR: P.DATA_DIR },
      });
      let buf = '';
      let replied = false;
      const reply = (extra) => {
        if (replied) return;
        replied = true;
        json(res, 200, { out: buf.trim().slice(-4000), ...extra });
      };
      child.stdout.on('data', (d) => { buf += PerfDeps.decode(d); });
      child.stderr.on('data', (d) => { buf += PerfDeps.decode(d); });
      child.on('error', (e) => { buf += `\n启动失败：${e.message}`; reply({ ok: false, code: -1 }); });
      child.on('close', (code) => reply({ ok: code === 0, code }));
      return;
    }

    // 识别使用者提供的绩效表版式：告诉面板「会写哪些格子」，写之前先让人核对
    if (method === 'GET' && p === '/api/perf-layout') {
      let file = String(url.searchParams.get('file') || '').trim();
      const folder = String(url.searchParams.get('folder') || '').trim();
      if (!file && folder) file = pickPerfFile(folder);
      if (!file) return json(res, 400, { ok: false, error: '缺少 file 或 folder 参数' });
      if (!fs.existsSync(file)) return json(res, 200, { ok: false, error: `表格不存在：${file}` });
      if (!excelAvailable()) return json(res, 200, { ok: false, error: '绩效表组件未安装' });
      const child = spawn(engineNode(), [P.ENGINE, '--config', P.CONFIG, '--perf-layout', file], {
        cwd: P.ENGINE_DIR, windowsHide: true,
        env: { ...process.env, WEEKLY_DATA_DIR: P.DATA_DIR },
      });
      let buf = '';
      let replied = false;
      const reply = (payload) => {
        if (replied) return;
        replied = true;
        json(res, 200, payload);
      };
      child.stdout.on('data', (d) => { buf += PerfDeps.decode(d); });
      child.stderr.on('data', (d) => { buf += PerfDeps.decode(d); });
      child.on('error', (e) => reply({ ok: false, error: `启动失败：${e.message}` }));
      child.on('close', () => {
        const line = buf.trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
        try {
          reply(JSON.parse(line));
        } catch {
          reply({ ok: false, error: '识别失败', out: buf.trim().slice(-1200) });
        }
      });
      return;
    }

    if (method === 'GET' && p === '/api/perf-deps') {
      const available = PerfDeps.isAvailable(P.PLUGIN_DIR);
      return json(res, 200, {
        ok: true, available, bundled: available,
        npmCli: available ? null : PerfDeps.findNpmCli(),
        manualCommand: PerfDeps.manualCommand(P.PLUGIN_DIR),
      });
    }
    if (method === 'POST' && p === '/api/install-deps') {
      // 已随包自带就直接返回，绝不再重复跑 npm（旧版在这里必然失败）
      const result = await PerfDeps.ensure(P.PLUGIN_DIR);
      P.log(`perf-deps mode=${result.mode} ok=${result.ok} available=${result.available}`);
      return json(res, 200, {
        ok: result.ok, mode: result.mode, available: result.available,
        out: result.out, hint: result.hint,
      });
    }

    if (method === 'GET' && !p.startsWith('/api/')) return serveStatic(res, p);
    return json(res, 404, { ok: false, error: '未知接口：' + p });
  } catch (e) {
    P.log('error ' + p + ' ' + String(e.message || e));
    return json(res, 500, { ok: false, error: String(e.message || e) });
  }
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    P.log(`port ${PORT} in use — another panel service is running; exit 0`);
    process.exit(0);
  }
  P.log('server error: ' + String(e.message || e));
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  P.ensureDirs();
  P.loadConfig();
  startScheduler();
  P.log(`weekly studio v${VERSION} on http://${HOST}:${PORT} · data=${P.DATA_DIR} · node=${process.version}`);
  console.log(`weekly studio v${VERSION} on http://${HOST}:${PORT} · data=${P.DATA_DIR}`);
});
