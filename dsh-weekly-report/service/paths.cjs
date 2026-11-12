/**
 * 插件路径与配置
 *
 * 代码可以两种方式装（数据位置不受影响）：
 *   A. 本地检出 + Junction（改代码即时生效）
 *   B. 在 DSH 插件页填仓库地址（pnpm 依赖，装进 node_modules）
 *
 * 无论哪种，**数据永远在同一个用户目录**，避免「两套配置 / 两套历史」：
 *   %USERPROFILE%\.dsh\weekly-report\
 *     ├── config.json    插件配置（含 SMTP 授权码）
 *     ├── api-key.txt    研发平台 API Key
 *     ├── reports/       默认周报输出目录
 *     └── logs/          运行日志
 * 可用环境变量 WEEKLY_PANEL_DATA 覆盖。
 *
 * 首次启动会按顺序尝试迁移旧位置（只读）：
 *   1. <插件>/service/data（旧版 Junction 安装的数据目录）
 *   2. D:\Reports\weekly_config.json + api_key.txt（更早的桌面版）
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVICE_DIR = __dirname;                       // .../dsh-weekly-report/service
const PLUGIN_DIR = path.resolve(SERVICE_DIR, '..');  // .../dsh-weekly-report
const ENGINE_DIR = path.join(SERVICE_DIR, 'engine');
const ENGINE = path.join(ENGINE_DIR, 'gen_weekly_text.py');

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/** 数据目录：始终在用户目录，和安装方式无关。 */
function pickDataDir() {
  const userHome = process.env.USERPROFILE || os.homedir();
  const candidates = [
    process.env.WEEKLY_PANEL_DATA,
    path.join(userHome, '.dsh', 'weekly-report'),
    path.join(os.homedir(), '.dsh', 'weekly-report'),
    path.join(os.tmpdir(), 'dsh-weekly-report'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (writable(dir)) return path.resolve(dir);
  }
  return path.join(os.tmpdir(), 'dsh-weekly-report');
}

const DATA_DIR = pickDataDir();
const CONFIG = path.join(DATA_DIR, 'config.json');
const KEY = path.join(DATA_DIR, 'api-key.txt');
const REPORTS = path.join(DATA_DIR, 'reports');
const LOGS = path.join(DATA_DIR, 'logs');

/** 旧位置 1：插件目录内的 service/data（Junction 版之前的默认） */
const LEGACY_PLUGIN_DATA = path.join(SERVICE_DIR, 'data');
/** 旧位置 2：更早的桌面版 */
const LEGACY_DIR = process.env.WEEKLY_LEGACY_DIR || 'D:\\Desktop\\工作记录';
const LEGACY_CONFIG = path.join(LEGACY_DIR, 'weekly_config.json');
const LEGACY_KEY = path.join(LEGACY_DIR, 'api_key.txt');

function ensureDirs() {
  for (const dir of [DATA_DIR, REPORTS, LOGS]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
  }
}

/** 读 JSON。返回 { ok, data, error } —— 区分「文件不存在」与「文件损坏」。

 * 以前损坏也返回 null，loadConfig 会当成"没有配置" → 静默用默认值覆盖，
 * 把输出目录、绩效表目录、邮箱授权码全重置掉。
 */
function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, missing: true, data: null, error: null };
    return { ok: false, missing: false, data: null, error: String((e && e.message) || e) };
  }
  try {
    return { ok: true, missing: false, data: JSON.parse(raw), error: null };
  } catch (e) {
    return { ok: false, missing: false, data: null, error: `JSON 解析失败：${e.message}` };
  }
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 插件默认配置：路径一律用绝对路径（数据在用户目录，和引擎所在位置无关） */
function defaultConfig() {
  return {
    token_file: KEY,
    out_dir: REPORTS,
    folder: 'D:\\Desktop\\绩效\\绩效表\\2026',
    handler: '张三',
    threshold: 0.85,
    mcp_url: 'https://mcp.example.com/api/mcp',
    confirm: {
      send_mail: false,
      imap_host: '',
      imap_port: 993,
      lookback_days: 14,
      subject_keyword: '周报',
    },
    notify: {
      enabled: false,
      webhook_url: '',
      webhook_type: 'wecom',
      smtp: {
        host: 'smtp.163.com',
        port: 465,
        ssl: true,
        starttls: false,
        user: '',
        password: '',
        to: [],
      },
    },
  };
}

/** 把旧数据目录里的东西搬到 DATA_DIR（不覆盖已有文件）。返回搬了哪些。 */
function migrateFromDir(srcDir) {
  const moved = [];
  if (!srcDir || !fs.existsSync(srcDir)) return moved;
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const from = path.join(dir, e.name);
      const to = path.join(DATA_DIR, rel, e.name);
      if (e.isDirectory()) {
        try { fs.mkdirSync(to, { recursive: true }); } catch (_) { /* ignore */ }
        walk(from, path.join(rel, e.name));
        continue;
      }
      if (fs.existsSync(to)) continue;           // 目标已有 → 不覆盖
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        moved.push(path.join(rel, e.name));
      } catch (_) { /* ignore */ }
    }
  };
  walk(srcDir, '');
  return moved;
}

/**
 * 加载插件配置；不存在时尝试迁移一次。
 * 迁移顺序：① <插件>/service/data（Junction 版旧数据） ② D:\Reports（更早桌面版）
 * 返回 { config, migratedFrom }
 */
function loadConfig() {
  ensureDirs();
  const existing = readJson(CONFIG);
  if (existing.ok) return { config: mergeDefaults(existing.data), migratedFrom: '', error: '' };
  if (!existing.missing) {
    // 配置损坏：**不要用默认值覆盖**（会把输出目录、绩效表目录、邮箱授权码全重置）。
    // 先把损坏的文件改名留档，再用默认值重建，让用户能手工捞回来。
    const broken = `${CONFIG}.corrupt-${ts()}`;
    try { fs.copyFileSync(CONFIG, broken); fs.renameSync(CONFIG, CONFIG + '.tmp-old'); } catch (_) { /* ignore */ }
    const base = defaultConfig();
    try { saveConfig(base); } catch (_) { /* ignore */ }
    return {
      config: base, migratedFrom: '',
      error: `配置文件损坏（${existing.error}），已备份为 ${path.basename(broken)}，并用默认配置重建`,
    };
  }

  // ① 插件目录内的旧数据（含 config/key/reports/logs）
  const moved = migrateFromDir(LEGACY_PLUGIN_DATA);

  const base = defaultConfig();
  const legacyRes = readJson(LEGACY_CONFIG);
  const legacy = legacyRes.ok ? legacyRes.data : null;
  let migratedFrom = moved.length ? LEGACY_PLUGIN_DATA : '';
  if (legacy) {
    const l = legacy.notify && legacy.notify.smtp ? legacy.notify.smtp : {};
    base.handler = legacy.handler || base.handler;
    base.threshold = typeof legacy.threshold === 'number' ? legacy.threshold : base.threshold;
    base.mcp_url = legacy.mcp_url || base.mcp_url;
    // 绩效表目录保留旧值（插件里没有这张模板）
    if (legacy.folder) base.folder = legacy.folder;
    base.notify.enabled = !!(legacy.notify && legacy.notify.enabled);
    base.notify.smtp.host = l.host || base.notify.smtp.host;
    base.notify.smtp.port = l.port || base.notify.smtp.port;
    base.notify.smtp.ssl = l.ssl !== false;
    base.notify.smtp.starttls = !!l.starttls;
    base.notify.smtp.user = l.user || '';
    base.notify.smtp.password = l.password || '';
    base.notify.smtp.to = Array.isArray(l.to) && l.to.length ? l.to : [];
    if (legacy.confirm) base.confirm = { ...base.confirm, ...legacy.confirm };
    // 输出目录：沿用旧位置（周报继续落在原来那个文件夹），不存在才用插件内目录
    const legacyOut = legacy.out_dir
      ? (path.isAbsolute(legacy.out_dir) ? legacy.out_dir : path.join(LEGACY_DIR, legacy.out_dir))
      : path.join(LEGACY_DIR, '周报');
    if (fs.existsSync(legacyOut)) base.out_dir = legacyOut;
    migratedFrom = LEGACY_CONFIG;
  }

  // 迁移 Key
  try {
    if (!fs.existsSync(KEY) && fs.existsSync(LEGACY_KEY)) {
      const k = fs.readFileSync(LEGACY_KEY, 'utf8').replace(/^\uFEFF/, '').trim();
      if (k) {
        fs.writeFileSync(KEY, k, 'utf8');
        migratedFrom = migratedFrom || LEGACY_KEY;
      }
    }
  } catch (_) { /* ignore */ }

  saveConfig(base);
  return { config: base, migratedFrom };
}

function mergeDefaults(cfg) {
  const base = defaultConfig();
  const out = { ...base, ...cfg };
  out.notify = { ...base.notify, ...(cfg.notify || {}) };
  out.notify.smtp = { ...base.notify.smtp, ...((cfg.notify && cfg.notify.smtp) || {}) };
  out.confirm = { ...base.confirm, ...(cfg.confirm || {}) };
  if (!Array.isArray(out.notify.smtp.to)) out.notify.smtp.to = [];
  // Key 永远指向 DATA_DIR 里的那份（绝对路径，不受安装位置影响）
  out.token_file = KEY;
  if (!out.out_dir || !String(out.out_dir).trim()) out.out_dir = REPORTS;
  return out;
}

function saveConfig(cfg) {
  ensureDirs();
  if (fs.existsSync(CONFIG)) {
    try { fs.copyFileSync(CONFIG, CONFIG + '.bak-' + ts()); } catch (_) { /* ignore */ }
  }
  // 原子写：先写临时文件再改名（写到一半被杀会留下半截配置）
  const tmp = CONFIG + '.tmp-' + ts();
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG);
  return cfg;
}

function readKey() {
  try {
    return fs.readFileSync(KEY, 'utf8').replace(/^\uFEFF/, '').trim();
  } catch (_) {
    return '';
  }
}

function writeKey(key) {
  ensureDirs();
  if (fs.existsSync(KEY)) {
    try { fs.copyFileSync(KEY, KEY + '.bak-' + ts()); } catch (_) { /* ignore */ }
  }
  fs.writeFileSync(KEY, String(key || '').trim(), 'utf8');
}

module.exports = {
  SERVICE_DIR, PLUGIN_DIR, ENGINE_DIR, DATA_DIR, ENGINE,
  CONFIG, KEY, REPORTS, LOGS, LEGACY_DIR, LEGACY_PLUGIN_DATA,
  ensureDirs, defaultConfig, loadConfig, saveConfig, readKey, writeKey,
  migrateFromDir, readJson, ts,
};
