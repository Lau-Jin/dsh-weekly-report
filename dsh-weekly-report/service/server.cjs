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
    const pkg = P.readJson(path.join(P.PLUGIN_DIR, 'package.json'));
    return (pkg && pkg.ok && pkg.data && pkg.data.version) || '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
}
const VERSION = pluginVersion();
const STARTED_AT = Date.now();

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
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...(opts.env || {}) },
      });
    } catch (e) {
      resolve({ code: -1, out: String(e.message || e) });
      return;
    }
    let out = '';
    // 上限别太小：绩效表 dump 的 JSON 有十几 KB，截断了就解析不出来
    const cap = (d) => { out += d.toString('utf8'); if (out.length > 512000) out = out.slice(-512000); };
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
        const dirAbs = path.dirname(full);
        out.push({
          name: e.name,
          path: full,
          dir: path.relative(outDir, dirAbs) || '.',
          dirAbs,                               // 绝对目录：面板上「打开目录」用
          inRoot: path.resolve(dirAbs) === path.resolve(outDir),  // 直接躺在输出根目录
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

// ---------------------------------------------------------------- 绩效表
/** 绩效表根目录（配置里的「绩效表目录」，可能指向某一年那一层）。 */
function perfRoot() {
  const cfg = getConfig();
  const raw = String(cfg.folder || '').trim();
  if (!raw) return '';
  let dir = path.isAbsolute(raw) ? raw : path.resolve(P.ENGINE_DIR, raw);
  // 配置里写的是 "…\\绩效表\\2026" 这种年份目录时，根目录是它的上一层
  if (/^\d{4}$/.test(path.basename(dir))) dir = path.dirname(dir);
  return dir;
}

/** 当月绩效表路径（与引擎 perf_path_for 保持一致）。 */
function perfFileFor(year, month) {
  const root = perfRoot();
  if (!root) return '';
  const cfg = getConfig();
  const handler = String(cfg.handler || '张三');
  return path.join(root, String(year),
    `${year}年${month}月${handler}员工月度考核表-交付中心.xlsx`);
}

/** 列出绩效表目录下的月度考核表（按月份倒序）。 */
function listPerfTables() {
  const root = perfRoot();
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!/\.xlsx$/i.test(e.name) || /^~/.test(e.name)) continue;
      try {
        const st = fs.statSync(full);
        out.push({
          name: e.name,
          path: full,
          dir: path.relative(root, path.dirname(full)) || '.',
          dirAbs: path.dirname(full),
          inRoot: path.resolve(path.dirname(full)) === path.resolve(root),
          size: st.size,
          mtime: st.mtime.toISOString(),
        });
      } catch (_) { /* ignore */ }
    }
  };
  walk(root, 0);
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return out;
}

// 读一张绩效表要起一次 python（openpyxl 打开 xlsx 约 1s），所以按「路径 + 修改时间」缓存一下，
// 面板里反复点同一张表（展开/收起）就不用每次都等几秒。
const perfTableCache = new Map();   // path -> { at, mtimeMs, data }
const PERF_CACHE_MAX = 40;

/** Map 满了就删最老的一条（缓存不能无限涨）。 */
function trimCache(map, max) {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}
const PERF_CACHE_TTL = 60 * 1000;

/** 读一张绩效表的内容（走引擎的 --perf-dump，openpyxl 在那边）。 */
async function readPerfTable(target) {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(target).mtimeMs; } catch (_) { mtimeMs = 0; }
  const hit = perfTableCache.get(target);
  if (hit && hit.mtimeMs === mtimeMs && Date.now() - hit.at < PERF_CACHE_TTL) {
    return hit.data;
  }

  const py = findPython();
  const r = await exec(py, [P.ENGINE, '--config', P.CONFIG, '--perf-dump',
    '--perf-xlsx', target], { timeout: 60000, cwd: P.ENGINE_DIR });
  const data = extractJson(r.out);
  if (!data) return { ok: false, error: (r.out || '').slice(-400) || '读取绩效表失败' };
  if (data.error) return { ok: false, error: data.error, path: data.path || '' };
  const out = { ok: true, table: data };
  perfTableCache.set(target, { at: Date.now(), mtimeMs, data: out });
  trimCache(perfTableCache, PERF_CACHE_MAX);
  return out;
}

// ---------------------------------------------------------------- 打开目录
/** 在资源管理器里打开目录（文件则打开所在目录并选中它）。

 * 只允许打开周报输出目录以内的位置，免得接口变成任意路径打开器。
 */
function _realish(p) {
  try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); } catch (_) { return p; }
}

/** target 是否在 base 之内（按路径分量判断；base 自身算在内）。 */
function _within(base, target) {
  const rel = path.relative(base, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return !rel.split(/[\\/]/).includes('..');
}

/**
 * 目标是否真的在 base 之内：**词法与 realpath 两条都要过**。
 * 之前写的是「或」，词法一旦通过 realpath 的结果就被忽略 → junction/软链可越界。
 */
function _safeInside(base, target) {
  const b = path.resolve(base);
  const f = path.resolve(target);
  if (!_within(b, f)) return false;
  const rb = _realish(b);
  const rf = _realish(f);
  if (!_within(rb, rf)) return false;
  // 目标不存在时 realish 会原样返回，词法判断已够
  return true;
}

function openInExplorer(target) {
  const raw = String(target || '').trim();
  if (!raw) return { ok: false, error: '缺少路径' };
  if (process.platform !== 'win32') return { ok: false, error: '当前系统暂不支持直接打开目录' };
  const full = path.resolve(raw);
  // 允许的范围：周报输出目录 + 绩效表目录（两者都可能带年份子目录）
  const roots = [reportsDir(), perfRoot()].filter(Boolean).map((d) => path.resolve(d));
  const ok = roots.some((base) => _safeInside(base, full));
  if (!ok) {
    return { ok: false, error: '只能打开周报输出目录或绩效表目录内的位置' };
  }
  let stat;
  try { stat = fs.statSync(full); } catch (_) { return { ok: false, error: '路径不存在' }; }
  const isFile = stat.isFile();
  // 注意：这里**不能**加 windowsHide —— explorer.exe 是 shell 程序，带 windowsHide 启动时
  // 窗口不会出现（实测：带 windowsHide 打开目录后资源管理器没有新窗口，去掉才有）。
  // explorer.exe 本身是 GUI 子系统程序，不会有控制台窗口闪出来。
  try {
    const child = spawn('explorer.exe', isFile ? [`/select,${full}`] : [full], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
  } catch (e) {
    // 兜底：走 cmd 的 start（同样是 GUI 打开，不会留控制台）
    try {
      const alt = spawn('cmd.exe', ['/c', 'start', '', isFile ? path.dirname(full) : full], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      alt.unref();
    } catch (_) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  // explorer.exe 交接到已有 shell 后自己退出，退出码 1 属正常，不代表失败
  return { ok: true, opened: full, selected: isFile, app: 'explorer' };
}

// ---------------------------------------------------------------- 注意事项
const NOTES = [
  { id: 'period', level: 'info', title: '周期口径', text: '周期固定为周一~周日。「本周」指今天所在的自然周。' },
  { id: 'cutoff', level: 'info', title: '未完成的日期会拉长', text: '进度不到 100% 的条目，结束日会拉到本周周日（表示还没收口）；100% 的保持实际工时区间。' },
  { id: 'done', level: 'info', title: '什么算「已完成 / 100%」', text: '① 平台已收口（工单已完成/已关闭/已评分/待评分/有评分、任务已完成/已归档/已关闭/已验收/待评审）且完成日在本周；② 本周工时备注写了「已完成/完成」等（不含「未完成/继续」）；③ 本周工时进度填了 100。三条都不满足就是未完成（有工时最高 95%）。不再用「下周没再记工时」倒推。' },
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
  { id: 'alive', level: 'info', title: '探活用 /api/ping', text: '/api/ping 不碰磁盘、不 spawn 进程，1~2 ms 就回；宿主心跳、侧边栏状态点都用它。面板卡不卡、红不红，以它为准。' },
  { id: 'keepalive', level: 'info', title: '服务由宿主静默保活', text: 'v0.8.0 起不再装 Windows 计划任务守护（它会拉 powershell，控制台窗口每次闪一下）。改由 DSH 宿主插件每 20 秒 fetch 一次 /api/ping，不在就静默拉起（windowsHide，无窗口）。DSH 关着时服务不常驻，重新打开 DSH 后几秒自动回来。' },
  { id: 'key', level: 'danger', title: '凭据安全', text: 'API Key 与邮箱授权码只存本机 service/data/，不要提交到代码库或随包外发。' },
];

function buildChecks(cfg, deps, task, key) {
  const checks = [];
  checks.push({
    id: 'key', level: key ? 'ok' : 'error', label: 'API Key',
    detail: key ? maskKey(key) : '未配置，请在「配置」页粘贴后保存',
  });
  checks.push({
    id: 'python',
    level: deps.pending ? 'info' : (deps.ok ? 'ok' : 'error'),
    label: 'Python 环境',
    detail: deps.pending ? '检测中…'
      : (deps.ok ? `${deps.version}（openpyxl 可用）` : (deps.detail || '不可用')),
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
    id: 'task',
    level: task.pending ? 'info' : (task.installed ? 'ok' : 'info'),
    label: '系统定时任务',
    detail: task.pending ? '查询中…'
      : (task.installed ? `已注册${task.nextRun ? '，下次 ' + task.nextRun : ''}` : '未注册（可选，面板可手动生成）'),
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
  artifacts: { reports: [], perf: [], weeks: [] },
};

function pushLine(line) {
  const text = String(line).replace(/\r$/, '');
  if (!text) return;
  run.lines.push(text);
  if (run.lines.length > 600) run.lines.splice(0, run.lines.length - 600);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/** 校验日期/月份格式，不合法就给出人话错误（别让 Python 抛堆栈）。 */
function validDate(s) {
  if (!DATE_RE.test(String(s || ''))) return false;
  const d = new Date(`${s}T00:00:00`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === String(s);
}

function resolvePeriod(body) {
  const args = ['--config', P.CONFIG];
  if (body.period === 'range' && body.start && body.end) {
    // 指定区间：**区间内每一周各出一份**周报（引擎按自然周拆）
    if (!validDate(body.start) || !validDate(body.end)) {
      throw new Error('日期格式应为 YYYY-MM-DD');
    }
    if (String(body.end) < String(body.start)) {
      throw new Error('结束日期不能早于开始日期');
    }
    args.push('--start', String(body.start), '--end', String(body.end));
  } else if (body.period === 'last') {
    args.push('--week', 'last');
  } else if (body.period === 'lastMonth') {
    args.push('--last-month');
  } else if (body.period === 'month' && body.month) {
    if (!MONTH_RE.test(String(body.month))) throw new Error('月份格式应为 YYYY-MM');
    args.push('--month', String(body.month));
  } else {
    args.push('--week', 'current');
  }
  if (body.perfAuto) args.push('--perf-auto');
  if (body.noTasks) args.push('--no-tasks');
  if (body.noCache) args.push('--no-cache');   // 不走本地缓存，重新拉工单/任务列表
  args.push(body.dryRun ? '--notify-dry-run' : '--log');
  return args;
}

function startRun(body) {
  if (run.running) return { ok: false, error: '已有生成任务在运行' };
  if (!fs.existsSync(P.ENGINE)) return { ok: false, error: '缺少内置引擎 service/engine/gen_weekly_text.py' };
  const key = P.readKey();
  if (!key) return { ok: false, error: '还没有配置 API Key' };

  const py = findPython();
  let args;
  try {
    args = [P.ENGINE, ...resolvePeriod(body)];
  } catch (e) {
    // 参数不合法 → 给一句人话，不让 Python 抛堆栈
    return { ok: false, error: e.message || '参数不合法' };
  }
  run = {
    running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
    lines: [], args, outPath: '', error: '', child: null,
    artifacts: { reports: [], perf: [], weeks: [] },
  };
  pushLine('$ ' + [py, ...args].join(' '));

  const child = spawn(py, args, {
    cwd: P.ENGINE_DIR,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
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
      const a = /^ARTIFACTS_JSON\s+(.+)$/.exec(line.trim());
      if (a) {
        try { run.artifacts = JSON.parse(a[1]); } catch (_) { /* ignore */ }
      }
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
    artifacts: run.artifacts || { reports: [], perf: [], weeks: [] },
  };
}

// ---------------------------------------------------------------- 定时任务
const TASK_NAME = '周报自动生成';
const PS_DIR = path.join(__dirname, 'ps');

function runPs(script, args = []) {
  return exec('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(PS_DIR, script), ...args], { timeout: 40000 });
}

/** 从混杂输出里抠出第一个完整的 JSON 对象（不依赖「行首是 {」）。 */
function extractJson(out) {
  const s = String(out || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  for (let end = s.length; end > start; end -= 1) {
    if (s[end - 1] !== '}') continue;
    try { return JSON.parse(s.slice(start, end)); } catch (_) { /* 继续往前找 */ }
  }
  return null;
}

function parseLastJson(out) {
  const line = (out || '').trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
  try { return JSON.parse(line || '{}'); } catch (_) { return {}; }
}

async function readTasks() {
  const r = await runPs('tasks-info.ps1', ['-ScheduleTask', TASK_NAME]);
  const d = parseLastJson(r.out);
  const s = d.schedule || {};
  const target = String(s.target || '').trim();
  const schedule = {
    installed: !!s.installed,
    status: s.state || '',
    target,
    nextRun: s.next || '',
    lastResult: s.lastResult,
    // 隐藏启动（wscript + vbs 包装）时 target 是 wscript.exe + vbs 路径，
    // 真正的命令行在 command 里；任一处带引擎名都算指向本插件。
    pointsToPlugin: (/dsh-weekly-report/i.test(target) && /gen_weekly_text\.py/i.test(target))
      || /gen_weekly_text\.py/i.test(String(s.command || '')),
  };
  return { schedule };
}

async function readSchedule(force = false) {
  if (!force && tasksCache.data) return tasksCache.data.schedule;
  const data = await readTasks();
  tasksCache = { at: Date.now(), data, refreshing: false };
  return data.schedule;
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
  tasksCache = { at: 0, data: null, refreshing: false };
  refreshTasks();
  return { ok: !!d.ok, code: r.code, next: d.next || '', action: d.action || '', out: r.out.trim().slice(-600) };
}

async function removeSchedule() {
  const r = await runPs('task-remove.ps1', ['-TaskName', TASK_NAME]);
  const d = parseLastJson(r.out);
  log(`schedule remove ok=${!!d.ok}`);
  tasksCache = { at: 0, data: null, refreshing: false };
  refreshTasks();
  return { ok: !!d.ok, reason: d.reason || '', out: r.out.trim().slice(-300) };
}

// ---------------------------------------------------------------- HTTP
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    // 不开放 CORS：面板是同源 iframe，本来就不需要。
    // 之前这里是 '*'，任意网页都能读这个接口，还能让服务端把 API Key 发给攻击者的地址。
  });
  res.end(body);
}

/**
 * 只接受同源请求（防跨站调用：改配置、发信、读文件…）。
 * 判据：Origin 的 host:port 与本次请求的 Host 一致 —— 不能写死 127.0.0.1，
 * 否则换个访问方式（localhost / 局域网 IP）自己的面板会被误拒。
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;               // 没有 Origin（同源 GET / curl）→ 放行
  try {
    const u = new URL(origin);
    const host = String(req.headers.host || '');
    if (!host) return false;
    return u.host.toLowerCase() === host.toLowerCase();
  } catch (_) {
    return false;
  }
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

let stateCache = { at: 0, data: null, refreshing: false };
const STATE_TTL = 60000;

// python 体检（spawn python ~1s）与计划任务查询（spawn powershell ~2~5s）都很贵，
// 单独缓存、后台刷新：/api/state 永远只读内存，第一次调用也不再等它们。
const DEPS_TTL = 10 * 60 * 1000;
const TASKS_TTL = 5 * 60 * 1000;

let depsCache = { at: 0, data: null, refreshing: false };
let tasksCache = { at: 0, data: null, refreshing: false };

function refreshDeps() {
  if (depsCache.refreshing) return;
  depsCache.refreshing = true;
  checkPythonDeps(findPython())
    .then((data) => { depsCache = { at: Date.now(), data, refreshing: false }; stateCache.at = 0; })
    .catch((e) => { depsCache.refreshing = false; log('deps refresh failed: ' + ((e && e.message) || e)); });
}

function refreshTasks() {
  if (tasksCache.refreshing) return;
  tasksCache.refreshing = true;
  readTasks()
    .then((data) => { tasksCache = { at: Date.now(), data, refreshing: false }; stateCache.at = 0; })
    .catch((e) => { tasksCache.refreshing = false; log('tasks refresh failed: ' + ((e && e.message) || e)); });
}

function getDeps() {
  if (!depsCache.data) { refreshDeps(); return { pending: true, ok: false, version: '', detail: '' }; }
  if (Date.now() - depsCache.at > DEPS_TTL) refreshDeps();
  return depsCache.data;
}

function getTasks() {
  if (!tasksCache.data) {
    refreshTasks();
    return {
      pending: true,
      schedule: { pending: true, installed: false, status: '', target: '', nextRun: '', pointsToPlugin: false },
    };
  }
  if (Date.now() - tasksCache.at > TASKS_TTL) refreshTasks();
  return tasksCache.data;
}

async function collectState() {
  const { config, migratedFrom } = P.loadConfig();
  const py = findPython();
  const deps = getDeps();
  const tasks = getTasks();
  const key = P.readKey();
  const schedule = tasks.schedule;
  return {
    ok: true,
    version: VERSION,
    autonomous: true,
    pid: process.pid,
    uptimeMs: Date.now() - STARTED_AT,
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
    perf: {
      root: perfRoot(),
      current: perfFileFor(new Date().getFullYear(), new Date().getMonth() + 1),
      tables: listPerfTables(),
    },
    templates: {
      // 周报模板：配置里指定 > 插件自带 > 内置默认
      report: path.join(P.ENGINE_DIR, 'templates', '周报模板.txt'),
      reportCustom: String((config.report_template || '')).trim(),
    },
    checks: buildChecks(config, deps, schedule, key),
    notes: NOTES,
    reports: listReports(),
    run: publicRun(),
    serverTime: new Date().toISOString(),
  };
}

function scheduleRefresh() {
  if (stateCache.refreshing) return;
  stateCache.refreshing = true;
  collectState()
    .then((data) => { stateCache = { at: Date.now(), data, refreshing: false }; })
    .catch((e) => {
      stateCache.refreshing = false;
      log('state refresh failed: ' + ((e && e.message) || e));
    });
}

function invalidateState() {
  stateCache.at = 0;
  scheduleRefresh();
}

async function buildState(force) {
  if (!force && stateCache.data) {
    if (Date.now() - stateCache.at > STATE_TTL) scheduleRefresh();
    return stateCache.data;
  }
  const data = await collectState();
  stateCache = { at: Date.now(), data, refreshing: false };
  return data;
}

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel);
  const full = path.resolve(PUBLIC_DIR, '.' + rel);
  // 用路径分量判断（startsWith 会把同前缀的兄弟目录也算进去）
  if (!_within(PUBLIC_DIR, full)) { json(res, 403, { error: 'forbidden' }); return; }
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
    res.writeHead(204, { 'Allow': 'GET,POST,HEAD' });
    res.end();
    return;
  }

  // 跨站请求一律拒绝（浏览器发来的跨站请求会带 Origin）
  if (!sameOrigin(req)) {
    json(res, 403, { ok: false, error: '拒绝跨站请求' });
    return;
  }

  try {
    // 轻量探活：不碰磁盘、不 spawn 进程，1~2 ms 返回，给宿主心跳 / 侧边栏状态用
    if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/api/ping' || p === '/api/health')) {
      json(res, 200, {
        ok: true,
        pid: process.pid,
        version: VERSION,
        startedAt: new Date(STARTED_AT).toISOString(),
        uptimeMs: Date.now() - STARTED_AT,
        busy: !!run.running,
      });
      return;
    }

    if (req.method === 'GET' && (p === '/api/state' || p === '/api/status')) {
      json(res, 200, await buildState(url.searchParams.get('force') === '1'));
      return;
    }

    if (req.method === 'GET' && p === '/api/watchdog') {
      // v0.8.0：PowerShell 守护任务下线，服务改由宿主插件每 20 秒静默保活
      json(res, 410, { ok: false, error: '面板服务守护已下线（v0.8.0），服务由宿主插件静默保活' });
      return;
    }

    if (req.method === 'POST' && p === '/api/watchdog') {
      json(res, 410, { ok: false, error: '面板服务守护已下线（v0.8.0），服务由宿主插件静默保活' });
      return;
    }

    if (req.method === 'POST' && p === '/api/config') {
      const body = JSON.parse(await readBody(req) || '{}');
      const merged = await saveConfig(body);
      invalidateState();
      log('config saved');
      json(res, 200, { ok: true, config: maskConfig(merged) });
      return;
    }

    if (req.method === 'POST' && p === '/api/api-key') {
      const body = JSON.parse(await readBody(req) || '{}');
      const key = String(body.key || '').trim();
      if (!key) { json(res, 400, { ok: false, error: 'key 不能为空' }); return; }
      P.writeKey(key);
      invalidateState();
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
      invalidateState();
      json(res, 200, { ok: r.code === 0, code: r.code, out: r.out.slice(-4000) });
      return;
    }

    // 绩效表：列出月度考核表
    if (req.method === 'GET' && p === '/api/perf') {
      const now = new Date();
      const y = Number(url.searchParams.get('year')) || now.getFullYear();
      const m = Number(url.searchParams.get('month')) || (now.getMonth() + 1);
      json(res, 200, {
        ok: true,
        root: perfRoot(),
        current: perfFileFor(y, m),
        tables: listPerfTables(),
      });
      return;
    }

    // 绩效表：模板自检（新装机器看"缺什么、怎么补"）
    if (req.method === 'GET' && p === '/api/perf/template') {
      const py = findPython();
      const r = await exec(py, [P.ENGINE, '--config', P.CONFIG, '--perf-template-check'],
        { timeout: 90000, cwd: P.ENGINE_DIR });
      const data = extractJson(r.out);
      if (!data) {
        json(res, 500, { ok: false, error: (r.out || '').slice(-400) || '模板自检失败' });
        return;
      }
      json(res, 200, { ok: true, report: data });
      return;
    }

    // 绩效表：读取一张表的内容（面板里直接看，不用开 Excel）
    if (req.method === 'GET' && p === '/api/perf/table') {
      const target = String(url.searchParams.get('path') || '').trim();
      if (!target) { json(res, 400, { ok: false, error: '缺少路径' }); return; }
      const roots = [perfRoot()].filter(Boolean).map((d) => path.resolve(d));
      const full = path.resolve(target);
      const allowed = roots.some((base) => _within(base, full) || _within(_realish(base), _realish(full)));
      if (!allowed) { json(res, 403, { ok: false, error: '只能读取绩效表目录内的文件' }); return; }
      const r = await readPerfTable(full);
      json(res, r.ok ? 200 : 500, r);
      return;
    }

    // 绩效表核对：对照本月各周周报，缺的补进当月表，报告写在表旁边
    if (req.method === 'POST' && p === '/api/perf-check') {
      // 生成过程中也会写绩效表 —— 两个进程同时 openpyxl.save 同一个 xlsx 会写坏
      if (run.running) {
        json(res, 409, { ok: false, error: '正在生成，请等生成结束再核对（避免同时写同一个绩效表）' });
        return;
      }
      const body = JSON.parse(await readBody(req) || '{}');
      const py = findPython();
      const args = [P.ENGINE, '--config', P.CONFIG, '--perf-check', '--perf-fix'];
      if (body.month) args.push('--perf-month', String(body.month));
      const r = await exec(py, args, { timeout: 180000, cwd: P.ENGINE_DIR });
      invalidateState();
      log(`perf-check code=${r.code}`);
      json(res, 200, { ok: r.code === 0, code: r.code, out: (r.out || '').slice(-8000) });
      return;
    }

    if (req.method === 'POST' && p === '/api/run') {
      const body = JSON.parse(await readBody(req) || '{}');
      const r = startRun(body);
      invalidateState();
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

    // 在资源管理器里打开周报目录（文件则打开所在目录并选中）
    if (req.method === 'POST' && p === '/api/open-dir') {
      const body = JSON.parse(await readBody(req) || '{}');
      const r = openInExplorer(body.path);
      json(res, r.ok ? 200 : 400, r);
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
      invalidateState();
      json(res, r.ok ? 200 : 500, r);
      return;
    }
    if (req.method === 'GET' && p === '/api/report') {
      const target = url.searchParams.get('path') || '';
      const base = path.resolve(reportsDir());
      const full = path.resolve(target);
      // 用路径分量判断 + 文件名判断（startsWith 会把 reports_2025 这类同前缀兄弟目录算进去）
      const okName = /^周报_.*\.txt$/.test(path.basename(full));
      if (!_within(base, full) || !okName || !fs.existsSync(full)) {
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

// 单个坏请求 / 坏连接不要带走整个服务
server.on('clientError', (err, socket) => {
  try { socket.destroy(); } catch (_) { /* ignore */ }
});

// 服务常驻：未捕获异常只记日志，不退出（真挂了由宿主插件 20 秒心跳拉起）
process.on('uncaughtException', (e) => {
  log('uncaughtException ' + ((e && e.stack) || e));
});
process.on('unhandledRejection', (e) => {
  log('unhandledRejection ' + ((e && e.stack) || e));
});

// 浏览器复用连接时别被过早掐断（默认 keepAliveTimeout 只有 5 秒，轮询容易撞上）
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

server.listen(PORT, HOST, () => {
  log(`weekly panel (autonomous) on http://${HOST}:${PORT} · data=${P.DATA_DIR}`);
  console.log(`周报面板服务（自主版）：http://${HOST}:${PORT}`);
  // 预热缓存：/api/state 第一次调用也不等 python 体检 / powershell 查任务
  refreshDeps();
  refreshTasks();
  scheduleRefresh();
});