#!/usr/bin/env node
/**
 * 周报面板 · 本地服务（自主版）
 *
 * 完全自主：生成引擎（service/engine/gen_weekly_text.py）、配置、API Key、
 * 输出目录全部在插件内部，不再依赖 D:\Reports。
 *
 *   1. 读写 service/data/config.json（GET 时脱敏）
 *   2. 读写 service/data/api-key.txt
 *   3. 调内置引擎生成周报（异步、可轮询、可终止）
 *   4. 列出 / 读取 service/data/reports 下的历史周报
 *   5. 体检 + 注意事项
 *
 * 启动：node service/server.cjs    端口 127.0.0.1:8798
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const P = require('./paths.cjs');

/** 版本号统一从 package.json 读，避免两处不一致 */
function pluginVersion() {
  try {
    return P.readJson(path.join(P.PLUGIN_DIR, 'package.json')).version || '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
}
const VERSION = pluginVersion();

const HOST = process.env.WEEKLY_PANEL_HOST || '127.0.0.1';
const PORT = Number(process.env.WEEKLY_PANEL_PORT || 8798);
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOG_FILE = path.join(P.LOGS, 'panel.log');

// ---------------------------------------------------------------- 日志
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try { P.ensureDirs(); fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) { /* ignore */ }
  if (process.stdout.isTTY) console.log(line);
}

// ---------------------------------------------------------------- 配置
const SECRET_KEYS = new Set(['password', 'passwd', 'pwd']);

function maskConfig(cfg) {
  const clone = JSON.parse(JSON.stringify(cfg || {}));
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object') walk(v);
      else if (SECRET_KEYS.has(k.toLowerCase()) && typeof v === 'string' && v) {
        node[k] = '••••••••' + `(${v.length})`;
      }
    }
  };
  walk(clone);
  return clone;
}

function getConfig() {
  return P.loadConfig().config;
}

async function saveConfig(patch) {
  const current = getConfig();
  const merged = {
    ...current,
    ...patch,
    notify: { ...(current.notify || {}), ...(patch.notify || {}) },
    confirm: { ...(current.confirm || {}), ...(patch.confirm || {}) },
  };
  if (patch.notify && patch.notify.smtp) {
    merged.notify.smtp = { ...(current.notify && current.notify.smtp || {}), ...patch.notify.smtp };
    const pw = merged.notify.smtp.password;
    if (typeof pw === 'string' && pw.startsWith('••')) {
      merged.notify.smtp.password = (current.notify && current.notify.smtp || {}).password || '';
    }
  }
  // Key 永远指向数据目录里那份；输出目录统一存绝对路径（相对值按 data/ 解析）
  merged.token_file = P.KEY;
  const rawOut = String(merged.out_dir || '').trim();
  merged.out_dir = !rawOut
    ? P.REPORTS
    : (path.isAbsolute(rawOut) ? rawOut : path.resolve(P.DATA_DIR, rawOut));
  P.saveConfig(merged);
  return merged;
}

// ---------------------------------------------------------------- 环境探测
function findPython() {
  const candidates = [
    process.env.WEEKLY_PYTHON,
    process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime',
          'dependencies', 'python', 'python.exe')
      : '',
    'python',
    'py',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === 'python' || c === 'py') return c;
    try { if (fs.existsSync(c)) return c; } catch (_) { /* next */ }
  }
  return 'python';
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 12) return '••••';
  return `${key.slice(0, 6)}…${key.slice(-4)}（${key.length} 位）`;
}

function exec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd || P.ENGINE_DIR,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...(opts.env || {}) },
      });
    } catch (e) {
      resolve({ code: -1, out: String(e.message || e) });
      return;
    }
    let out = '';
    const cap = (d) => { out += d.toString('utf8'); if (out.length > 8000) out = out.slice(-8000); };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* ignore */ } }, opts.timeout || 20000);
    child.on('error', (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ code: -1, out: String(e.message || e) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

async function checkPythonDeps(py) {
  const r = await exec(py, ['-c', 'import openpyxl,sys;print(sys.version.split()[0])'], { timeout: 15000 });
  return {
    ok: r.code === 0,
    python: py,
    version: r.code === 0 ? r.out.trim().split('\n').pop() : '',
    detail: r.code === 0 ? '' : r.out.trim().split('\n').slice(-3).join(' ').slice(0, 300),
  };
}

async function checkScheduledTask() {
  const r = await exec('schtasks', ['/Query', '/TN', '周报自动生成', '/FO', 'LIST'], { timeout: 15000 });
  if (r.code !== 0) return { installed: false, detail: '' };
  const next = /Next Run Time:\s*(.+)/i.exec(r.out);
  return {
    installed: true,
    status: (/Status:\s*(.+)/i.exec(r.out) || [])[1] || '',
    nextRun: next ? next[1].trim() : '',
  };
}

// ---------------------------------------------------------------- 历史
/** 周报目录：跟着配置走（绝对路径直接 use；相对路径按引擎目录解析，跟 Python 一致） */
function reportsDir() {
  const cfg = getConfig();
  const raw = String(cfg.out_dir || '').trim();
  if (!raw) return P.REPORTS;
  return path.isAbsolute(raw) ? raw : path.resolve(P.ENGINE_DIR, raw);
}

function countEntries(file) {
  try {
    return (fs.readFileSync(file, 'utf8').match(/^【/gm) || []).length;
  } catch (_) {
    return 0;
  }
}

function listReports() {
  const outDir = reportsDir();
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!/^周报_.*\.txt$/.test(e.name)) continue;
      try {
        const st = fs.statSync(full);
        out.push({
          name: e.name,
          path: full,
          dir: path.relative(outDir, path.dirname(full)) || '.',
          size: st.size,
          mtime: st.mtime.toISOString(),
          entries: countEntries(full),
        });
      } catch (_) { /* ignore */ }
    }
  };
  walk(outDir, 0);
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return out;
}

// ---------------------------------------------------------------- 注意事项
const NOTES = [
  { id: 'period', level: 'info', title: '周期口径', text: '周期固定为周一~周日。「本周」指今天所在的自然周。' },
  { id: 'cutoff', level: 'info', title: '未完成的日期会拉长', text: '进度不到 100% 的条目，结束日会拉到本周周日（表示还没收口）；100% 的保持实际工时区间。' },
  { id: 'subtask', level: 'info', title: '子任务独立成条', text: '父任务和子任务各出一条，工时/时间各算各的。子任务没全部完成时，父任务不算完成（进度最高 95%、有工时最低 60%）。' },
  { id: 'note', level: 'info', title: '重要说明默认「无」', text: '只有任务「风险预警」字段有值，或本周期工时备注含 重要/注意/风险/延期/阻塞/遗留/待跟进/紧急/重点/待确认 时才填入。' },
  { id: 'bulk', level: 'warn', title: '批量补录会被跳过', text: '同一小时内「我负责 + 本周期新建」任务 ≥20 个，判定为历史数据批量导入；这类任务必须本周期有我的工时才算。' },
  { id: 'supp', level: 'warn', title: '补充工单不重复生成', text: '本周期新建但工时全在本周期之前的工单（先干活后补单），不在本周期生成；对应任务也跳过。' },
  { id: 'crossweek', level: 'info', title: '跨周收尾', text: '本周期内被点完成、处理人是我、且整张工单零工时记录 → 也算本周完成（100%，时间取完成日）。有过工时但都在周期外的，不重复计入。' },
  { id: 'perf', level: 'info', title: '绩效表按月累积', text: '当月考核表 = 本月全部周报内容：每周生成时把本周条目并进去（同一事项只占一行，起止时间取并集），不会再把前几周内容冲掉；格式只写类别/内容/起止时间/是否完成/备注六列，其余一律不动。' },
  { id: 'perfcheck', level: 'warn', title: '月底核对绩效表', text: '每次生成后自动对照本月各周周报核一遍当月表，缺的事项自动补齐；本周覆盖月末时就是月底核对。报告写在表旁边 *_核对.txt，也能在概览页手动点「核对本月绩效表」。' },
  { id: 'rate', level: 'warn', title: '接口限流', text: '研发平台 MCP 限 60 次/分钟；撞限会等 20 秒重试，生成一次通常 1~3 分钟，期间别重复点。' },
  { id: 'cancel', level: 'info', title: '已取消不写', text: '工单状态 cancelled / 任务「已取消」一律跳过。' },
  { id: 'engine', level: 'info', title: '引擎随插件走', text: '生成脚本在 service/engine/gen_weekly_text.py，配置与 Key 在 service/data/，输出在 service/data/reports/，不依赖外部目录。' },
  { id: 'key', level: 'danger', title: '凭据安全', text: 'API Key 与邮箱授权码只存本机 service/data/，不要提交到代码库或随包外发。' },
];

function buildChecks(cfg, deps, task, key) {
  const checks = [];
  checks.push({
    id: 'key', level: key ? 'ok' : 'error', label: 'API Key',
    detail: key ? maskKey(key) : '未配置，请在「配置」页粘贴后保存',
  });
  checks.push({
    id: 'python', level: deps.ok ? 'ok' : 'error', label: 'Python 环境',
    detail: deps.ok ? `${deps.version}（openpyxl 可用）` : (deps.detail || '不可用'),
  });
  checks.push({
    id: 'engine', level: fs.existsSync(P.ENGINE) ? 'ok' : 'error', label: '内置引擎',
    detail: fs.existsSync(P.ENGINE) ? 'gen_weekly_text.py 已就位' : '缺少 service/engine/gen_weekly_text.py',
  });
  const smtp = (cfg.notify && cfg.notify.smtp) || {};
  const notifyOn = !!(cfg.notify && cfg.notify.enabled);
  checks.push({
    id: 'mail', level: !notifyOn ? 'info' : (smtp.password && smtp.user ? 'ok' : 'warn'), label: '邮件通知',
    detail: !notifyOn ? '未启用'
      : (smtp.password && smtp.user ? `${smtp.user}（${smtp.host || 'smtp'}）` : '已启用但账号或授权码为空'),
  });
  checks.push({
    id: 'task', level: task.installed ? 'ok' : 'info', label: '系统定时任务',
    detail: task.installed ? `已注册${task.nextRun ? '，下次 ' + task.nextRun : ''}` : '未注册（可选，面板可手动生成）',
  });
  checks.push({
    id: 'perf', level: (cfg.folder && fs.existsSync(cfg.folder)) ? 'ok' : 'info', label: '绩效表目录',
    detail: (cfg.folder && fs.existsSync(cfg.folder)) ? cfg.folder : '不存在（只影响绩效 xlsx，周报不受影响）',
  });
  checks.push({
    id: 'outdir', level: 'ok', label: '输出目录', detail: reportsDir(),
  });
  return checks;
}

// ---------------------------------------------------------------- 运行
let run = {
  running: false, startedAt: null, finishedAt: null, exitCode: null,
  lines: [], args: [], outPath: '', error: '', child: null,
};

function pushLine(line) {
  const text = String(line).replace(/\r$/, '');
  if (!text) return;
  run.lines.push(text);
  if (run.lines.length > 600) run.lines.splice(0, run.lines.length - 600);
}

function resolvePeriod(body) {
  const args = ['--config', P.CONFIG];
  if (body.period === 'range' && body.start && body.end) {
    args.push('--start', String(body.start), '--end', String(body.end));
  } else if (body.period === 'last') {
    args.push('--week', 'last');
  } else {
    args.push('--week', 'current');
  }
  if (body.perfAuto) args.push('--perf-auto');
  if (body.noTasks) args.push('--no-tasks');
  args.push(body.dryRun ? '--notify-dry-run' : '--log');
  return args;
}

function startRun(body) {
  if (run.running) return { ok: false, error: '已有生成任务在运行' };
  if (!fs.existsSync(P.ENGINE)) return { ok: false, error: '缺少内置引擎 service/engine/gen_weekly_text.py' };
  const key = P.readKey();
  if (!key) return { ok: false, error: '还没有配置 API Key' };

  const py = findPython();
  const args = [P.ENGINE, ...resolvePeriod(body)];
  run = {
    running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
    lines: [], args, outPath: '', error: '', child: null,
  };
  pushLine('$ ' + [py, ...args].join(' '));

  const child = spawn(py, args, {
    cwd: P.ENGINE_DIR,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  run.child = child;

  const onData = (buf) => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) pushLine(line);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => {
    run.error = String(e.message || e);
    pushLine('启动失败：' + run.error);
  });
  child.on('close', (code) => {
    run.running = false;
    run.exitCode = code;
    run.finishedAt = new Date().toISOString();
    run.child = null;
    for (const line of run.lines) {
      const m = /^OK\s+\d+\s+条\s+out=(.+)$/.exec(line.trim());
      if (m) run.outPath = m[1].trim();
    }
    if (code !== 0 && !run.error) run.error = `退出码 ${code}`;
    log(`run finished code=${code} out=${run.outPath}`);
  });
  return { ok: true, args };
}

function publicRun() {
  return {
    running: run.running, startedAt: run.startedAt, finishedAt: run.finishedAt,
    exitCode: run.exitCode, lines: run.lines.slice(-250), args: run.args,
    outPath: run.outPath, error: run.error,
  };
}

// ---------------------------------------------------------------- 定时任务
const TASK_NAME = '周报自动生成';
const PS_DIR = path.join(__dirname, 'ps');

function runPs(script, args = []) {
  return exec('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(PS_DIR, script), ...args], { timeout: 40000 });
}

function parseLastJson(out) {
  const line = (out || '').trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
  try { return JSON.parse(line || '{}'); } catch (_) { return {}; }
}

async function readSchedule() {
  const r = await runPs('task-info.ps1', ['-TaskName', TASK_NAME]);
  const d = parseLastJson(r.out);
  if (!d.installed) return { installed: false, target: '', nextRun: '', status: '', pointsToPlugin: false };
  const target = [d.execute, d.arguments].filter(Boolean).join(' ').trim();
  return {
    installed: true,
    status: d.state || '',
    target,
    nextRun: d.next || '',
    lastResult: d.lastResult,
    pointsToPlugin: /dsh-weekly-report/i.test(target) && /gen_weekly_text\.py/i.test(target),
  };
}

async function installSchedule(body) {
  const py = findPython();
  const r = await runPs('task-install.ps1', [
    '-Python', py,
    '-Engine', P.ENGINE,
    '-Config', P.CONFIG,
    '-TaskName', TASK_NAME,
    '-Day', String(body.day || 'Sunday'),
    '-Time', String(body.time || '22:00'),
  ]);
  const d = parseLastJson(r.out);
  log(`schedule install code=${r.code} ok=${!!d.ok}`);
  return { ok: !!d.ok, code: r.code, next: d.next || '', action: d.action || '', out: r.out.trim().slice(-600) };
}

async function removeSchedule() {
  const r = await runPs('task-remove.ps1', ['-TaskName', TASK_NAME]);
  const d = parseLastJson(r.out);
  log(`schedule remove ok=${!!d.ok}`);
  return { ok: !!d.ok, reason: d.reason || '', out: r.out.trim().slice(-300) };
}

// ---------------------------------------------------------------- HTTP
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (d) => {
      chunks.push(d);
      if (chunks.reduce((n, c) => n + c.length, 0) > 4 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

let stateCache = { at: 0, data: null };

async function buildState(force) {
  if (!force && stateCache.data && Date.now() - stateCache.at < 15000) return stateCache.data;
  const { config, migratedFrom } = P.loadConfig();
  const py = findPython();
  const [deps, task] = await Promise.all([checkPythonDeps(py), checkScheduledTask()]);
  const key = P.readKey();
  const schedule = await readSchedule();
  const data = {
    ok: true,
    version: VERSION,
    autonomous: true,
    migratedFrom: migratedFrom || '',
    paths: {
      plugin: P.PLUGIN_DIR,
      engine: P.ENGINE,
      config: P.CONFIG,
      key: P.KEY,
      data: P.DATA_DIR,
      outDir: reportsDir(),
    },
    config: maskConfig(config),
    key: { present: !!key, masked: maskKey(key) },
    python: { path: py, ok: deps.ok, version: deps.version },
    schedule,
    checks: buildChecks(config, deps, schedule, key),
    notes: NOTES,
    reports: listReports(),
    run: publicRun(),
    serverTime: new Date().toISOString(),
  };
  stateCache = { at: Date.now(), data };
  return data;
}

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel);
  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) { json(res, 403, { error: 'forbidden' }); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { json(res, 404, { error: 'not found' }); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && (p === '/api/state' || p === '/api/status')) {
      json(res, 200, await buildState(url.searchParams.get('force') === '1'));
      return;
    }

    if (req.method === 'POST' && p === '/api/config') {
      const body = JSON.parse(await readBody(req) || '{}');
      const merged = await saveConfig(body);
      stateCache.at = 0;
      log('config saved');
      json(res, 200, { ok: true, config: maskConfig(merged) });
      return;
    }

    if (req.method === 'POST' && p === '/api/api-key') {
      const body = JSON.parse(await readBody(req) || '{}');
      const key = String(body.key || '').trim();
      if (!key) { json(res, 400, { ok: false, error: 'key 不能为空' }); return; }
      P.writeKey(key);
      stateCache.at = 0;
      log('api key updated, len=' + key.length);
      json(res, 200, { ok: true, masked: maskKey(key) });
      return;
    }

    // 用给定（或已保存）的 Key 调一次 MCP tools/list，验证连通性
    if (req.method === 'POST' && p === '/api/test-key') {
      const body = JSON.parse(await readBody(req) || '{}');
      const key = String(body.key || '').trim() || P.readKey();
      if (!key) { json(res, 400, { ok: false, error: '还没有 API Key' }); return; }
      const cfg = getConfig();
      const url = String(cfg.mcp_url || 'https://mcp.example.com/api/mcp').trim();
      const started = Date.now();
      try {
        const res2 = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: 'Bearer ' + key,
            'MCP-Protocol-Version': '2025-06-18',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
          signal: AbortSignal.timeout(20000),
        });
        const raw = await res2.text();
        if (!res2.ok) {
          json(res, 200, { ok: false, status: res2.status, ms: Date.now() - started,
            error: `HTTP ${res2.status}：${raw.slice(0, 200)}` });
          return;
        }
        let payload = raw;
        for (const line of raw.split(/\r?\n/)) {
          if (line.trim().startsWith('data:')) { payload = line.trim().slice(5).trim(); break; }
        }
        const data = JSON.parse(payload);
        const err = data && data.error;
        if (err) {
          json(res, 200, { ok: false, ms: Date.now() - started, error: (err.message || String(err)).slice(0, 200) });
          return;
        }
        const tools = (data.result && data.result.tools) || [];
        json(res, 200, {
          ok: true, tools: tools.length, ms: Date.now() - started,
          detail: `MCP 正常，可用工具 ${tools.length} 个`,
        });
      } catch (e) {
        json(res, 200, { ok: false, ms: Date.now() - started, error: String((e && e.message) || e).slice(0, 200) });
      }
      return;
    }

    if (req.method === 'POST' && p === '/api/test-mail') {
      const py = findPython();
      const r = await exec(py, [P.ENGINE, '--config', P.CONFIG, '--week', 'current',
        '--notify-dry-run', '--no-miss-file'], { timeout: 180000 });
      stateCache.at = 0;
      json(res, 200, { ok: r.code === 0, code: r.code, out: r.out.slice(-4000) });
      return;
    }

    // 绩效表核对：对照本月各周周报，缺的补进当月表，报告写在表旁边
    if (req.method === 'POST' && p === '/api/perf-check') {
      const body = JSON.parse(await readBody(req) || '{}');
      const py = findPython();
      const args = [P.ENGINE, '--config', P.CONFIG, '--perf-check', '--perf-fix'];
      if (body.month) args.push('--perf-month', String(body.month));
      const r = await exec(py, args, { timeout: 180000, cwd: P.ENGINE_DIR });
      stateCache.at = 0;
      log(`perf-check code=${r.code}`);
      json(res, 200, { ok: r.code === 0, code: r.code, out: (r.out || '').slice(-8000) });
      return;
    }

    if (req.method === 'POST' && p === '/api/run') {
      const body = JSON.parse(await readBody(req) || '{}');
      const r = startRun(body);
      stateCache.at = 0;
      json(res, r.ok ? 200 : 409, r);
      return;
    }
    if (req.method === 'GET' && p === '/api/run') {
      json(res, 200, publicRun());
      return;
    }
    if (req.method === 'POST' && p === '/api/run/cancel') {
      if (run.child) {
        try { run.child.kill('SIGKILL'); } catch (_) { /* ignore */ }
        pushLine('已请求终止');
      }
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && p === '/api/reports') {
      json(res, 200, { ok: true, reports: listReports() });
      return;
    }

    if (req.method === 'GET' && p === '/api/schedule') {
      json(res, 200, { ok: true, schedule: await readSchedule(), taskName: TASK_NAME });
      return;
    }

    // ---- 目录浏览（给「浏览…」选目录用） ----
    if (req.method === 'GET' && p === '/api/fs') {
      const raw = url.searchParams.get('path') || '';
      let dir = raw ? path.resolve(raw) : '';
      if (!dir) dir = P.DATA_DIR;
      try {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
          const up = fs.existsSync(dir) ? path.dirname(dir) : '';
          dir = up && fs.existsSync(up) ? up : (path.parse(dir).root || P.DATA_DIR);
        }
      } catch (_) {
        dir = P.DATA_DIR;
      }

      let dirs = [];
      try {
        dirs = fs.readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('$') && e.name !== 'System Volume Information')
          .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      } catch (e) {
        json(res, 200, { ok: false, path: dir, error: '无法读取目录：' + String(e.message || e), dirs: [] });
        return;
      }

      const root = path.parse(dir).root;
      const parent = dir === root ? null : path.dirname(dir);
      let writable = false;
      try { fs.accessSync(dir, fs.constants.W_OK); writable = true; } catch (_) { /* read-only */ }

      const drives = [];
      if (process.platform === 'win32') {
        for (let c = 65; c <= 90; c += 1) {
          const letter = String.fromCharCode(c) + ':\\';
          try { if (fs.existsSync(letter)) drives.push(letter); } catch (_) { /* skip */ }
        }
      } else {
        drives.push('/');
      }

      // 快捷入口：桌面 / 文档 / 插件数据 / 当前周报目录 / 绩效表目录
      const cfgNow = getConfig();
      const home = os.homedir();
      const rawShortcuts = [
        { label: '桌面', path: path.join(home, 'Desktop') },
        { label: '文档', path: path.join(home, 'Documents') },
        { label: '插件数据', path: P.DATA_DIR },
        { label: '周报目录', path: reportsDir() },
        { label: '绩效表目录', path: String(cfgNow.folder || '') },
      ];
      const shortcuts = rawShortcuts
        .filter((s) => s.path && fs.existsSync(s.path))
        .map((s) => ({ label: s.label, path: path.resolve(s.path) }));

      json(res, 200, { ok: true, path: dir, root, parent, dirs, drives, shortcuts, writable });
      return;
    }

    if (req.method === 'POST' && p === '/api/fs/mkdir') {
      const body = JSON.parse(await readBody(req) || '{}');
      const parent = String(body.parent || '').trim();
      const name = String(body.name || '').trim();
      if (!parent || !name) { json(res, 400, { ok: false, error: '缺少目录或名称' }); return; }
      if (/[\\/:*?"<>|]/.test(name)) {
        json(res, 400, { ok: false, error: '名称不能包含 \\ / : * ? " < > |' });
        return;
      }
      const target = path.join(path.resolve(parent), name);
      try {
        fs.mkdirSync(target, { recursive: true });
        log('mkdir ' + target);
        json(res, 200, { ok: true, path: target });
      } catch (e) {
        json(res, 500, { ok: false, error: String(e.message || e) });
      }
      return;
    }
    if (req.method === 'POST' && p === '/api/schedule') {
      const body = JSON.parse(await readBody(req) || '{}');
      const r = body.action === 'remove'
        ? await removeSchedule()
        : await installSchedule(body);
      stateCache.at = 0;
      json(res, r.ok ? 200 : 500, r);
      return;
    }
    if (req.method === 'GET' && p === '/api/report') {
      const target = url.searchParams.get('path') || '';
      const base = path.resolve(reportsDir());
      const full = path.resolve(target);
      if (!full.startsWith(base) || !/周报_.*\.txt$/.test(full) || !fs.existsSync(full)) {
        json(res, 403, { ok: false, error: '不允许读取该路径' });
        return;
      }
      json(res, 200, { ok: true, path: full, text: fs.readFileSync(full, 'utf8') });
      return;
    }

    if (req.method === 'GET' && !p.startsWith('/api/')) {
      serveStatic(res, p);
      return;
    }

    json(res, 404, { ok: false, error: 'not found: ' + p });
  } catch (e) {
    log('error ' + p + ' ' + (e && e.message));
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    log(`port ${PORT} in use — another panel service is running; exit 0`);
    process.exit(0);
  }
  log('server error ' + (e && e.message));
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`weekly panel (autonomous) on http://${HOST}:${PORT} · data=${P.DATA_DIR}`);
  console.log(`周报面板服务（自主版）：http://${HOST}:${PORT}`);
});