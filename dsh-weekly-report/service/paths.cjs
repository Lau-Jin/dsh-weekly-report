/**
 * 周报工作台 · 路径与配置层（CommonJS，零第三方依赖）
 *
 * 设计原则（v1.0 完整化）：
 *   1. 数据目录与代码目录彻底分离，包整体可搬走 / 可分发；
 *   2. 默认配置不含任何凭据、本机绝对路径或个人信息；
 *   3. 所有真实路径（输出目录 / 绩效表 / 自定义模板）由使用者在面板提供后写入配置；
 *   4. 配置与 Key 写前备份、原子落盘，损坏文件不静默覆盖。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVICE_DIR = __dirname;
const PLUGIN_DIR = path.resolve(SERVICE_DIR, '..');
const ENGINE_DIR = path.join(SERVICE_DIR, 'engine');
const ENGINE = path.join(ENGINE_DIR, 'gen-weekly.mjs');
const PUBLIC_DIR = path.join(SERVICE_DIR, 'public');
const TEMPLATE_FILE = path.join(ENGINE_DIR, 'templates', '周报模板.txt');

/** 数据目录：用户目录优先，可用 WEEKLY_PANEL_DATA / WEEKLY_DATA_DIR 覆盖。 */
function pickDataDir() {
  const home = process.env.USERPROFILE || os.homedir();
  const candidates = [
    process.env.WEEKLY_PANEL_DATA,
    process.env.WEEKLY_DATA_DIR,
    path.join(home, '.dsh', 'weekly-report'),
    path.join(os.homedir(), '.dsh', 'weekly-report'),
    path.join(os.tmpdir(), 'dsh-weekly-report'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return path.resolve(dir);
    } catch { /* 换下一个 */ }
  }
  return path.join(os.tmpdir(), 'dsh-weekly-report');
}

const DATA_DIR = pickDataDir();
const CONFIG = path.join(DATA_DIR, 'config.json');
const KEY = path.join(DATA_DIR, 'api-key.txt');
const REPORTS = path.join(DATA_DIR, 'reports');
const LOGS = path.join(DATA_DIR, 'logs');

function ensureDirs() {
  for (const dir of [DATA_DIR, REPORTS, LOGS]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 备份一份再覆盖；备份失败不阻断主流程。 */
function backup(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const dst = `${file}.bak-${stamp()}`;
    fs.copyFileSync(file, dst);
    return dst;
  } catch { return null; }
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** 全新安装的默认配置：邮件关闭、SMTP 全空、无凭据、无个人姓名。 */
function defaultConfig() {
  return {
    token_file: KEY,
    out_dir: REPORTS,
    folder: '',
    perf_template: '',
    perf_allow_insert: false,
    report_template: '',
    handler: '',
    threshold: 0.85,
    mcp_url: 'https://yanfa.scedu.tech/api/mcp',
    schedule: {
      enabled: false,  // 定时生成默认关闭，由使用者在「设置」页开启
      weekday: 6,      // 0=周日 … 6=周六（Date#getDay 口径），默认每周六
      hour: 12,
      minute: 0,
      perfAuto: true,  // 定时生成时同步写入绩效表（提供目录才写）
    },
    confirm: { send_mail: false, imap_host: '', imap_port: 993, lookback_days: 14, subject_keyword: '周报' },
    notify: {
      enabled: false,
      webhook_url: '',
      webhook_type: 'wecom',
      smtp: { host: '', port: 465, ssl: true, starttls: false, user: '', password: '', to: [] },
    },
  };
}

function readJson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, missing: true, data: null, error: null };
    return { ok: false, missing: false, data: null, error: String((e && e.message) || e) };
  }
  try { return { ok: true, data: JSON.parse(raw), error: null }; }
  catch (e) { return { ok: false, missing: false, data: null, error: `JSON 解析失败：${e.message}` }; }
}

/** 深合并（只合并普通对象，数组按新值覆盖）。 */
function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = merge(out[k], v);
    } else if (v !== undefined) out[k] = v;
  }
  return out;
}

/** 载入配置；首次自动创建空配置；损坏文件另存备份不静默丢弃。 */
function loadConfig() {
  ensureDirs();
  const r = readJson(CONFIG);
  if (r.ok) {
    const cfg = merge(defaultConfig(), r.data);
    cfg.token_file = KEY; // Key 永远落在数据目录，避免配置里指到别处
    return { config: cfg, error: null, created: false };
  }
  let error = r.error;
  if (!r.missing) {
    try { backup(CONFIG); } catch { /* ignore */ }
    error = `${error}；已备份原文件并重建默认配置`;
  }
  const cfg = defaultConfig();
  try { atomicWrite(CONFIG, JSON.stringify(cfg, null, 2) + '\n'); } catch { /* ignore */ }
  return { config: cfg, error, created: true };
}

/** 保存配置：密码掩码开头的值保留旧密码。 */
function saveConfig(patch) {
  const current = loadConfig().config;
  const incoming = { ...(patch || {}) };
  if (incoming.notify && incoming.notify.smtp && typeof incoming.notify.smtp.password === 'string'
      && incoming.notify.smtp.password.startsWith('••')) {
    incoming.notify = { ...incoming.notify, smtp: { ...incoming.notify.smtp } };
    delete incoming.notify.smtp.password;
  }
  const next = merge(current, incoming);
  next.token_file = KEY;
  // 归一化：空字符串保持为空（使用者未填），非空路径转绝对路径
  for (const field of ['out_dir', 'folder', 'report_template']) {
    if (next[field]) next[field] = path.resolve(String(next[field]));
  }
  atomicWrite(CONFIG, JSON.stringify(next, null, 2) + '\n');
  return next;
}

function maskConfig(cfg) {
  const copy = JSON.parse(JSON.stringify(cfg || {}));
  if (copy.notify && copy.notify.smtp && copy.notify.smtp.password) {
    copy.notify.smtp.password = '••••••••(' + String(copy.notify.smtp.password).length + ')';
  }
  return copy;
}

function readKey() {
  try { return fs.readFileSync(KEY, 'utf8').replace(/^\uFEFF/, '').trim(); } catch { return ''; }
}
function writeKey(value) {
  atomicWrite(KEY, String(value || '').trim() + '\n');
}
function keyInfo() {
  const k = readKey();
  return { present: Boolean(k), masked: k ? `${k.slice(0, 4)}••••${k.slice(-4)}` : '' };
}

/** 列出输出目录下的周报（最多 3 层，只认 周报_*.txt）。 */
function listReports(outDir) {
  const root = outDir && fs.existsSync(outDir) ? outDir : REPORTS;
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { walk(full, depth + 1); continue; }
      if (!/^周报_.*\.txt$/i.test(it.name)) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      out.push({
        name: it.name, path: full, dir: path.relative(root, dir) || '.',
        size: st.size, mtime: st.mtimeMs,
        entries: countBlocks(full),
      });
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

function countBlocks(file) {
  try { return (fs.readFileSync(file, 'utf8').match(/^【.+】$/gm) || []).length; } catch { return 0; }
}

/** 读单份周报；限制在输出目录内，防目录穿越。 */
function readReport(file, outDir) {
  const root = path.resolve(outDir && fs.existsSync(outDir) ? outDir : REPORTS);
  const full = path.resolve(String(file || ''));
  if (!full.startsWith(root + path.sep) && full !== root) return { ok: false, error: '路径不在周报输出目录内' };
  if (!/^周报_.*\.txt$/i.test(path.basename(full))) return { ok: false, error: '不是周报文件' };
  try { return { ok: true, path: full, text: fs.readFileSync(full, 'utf8') }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
}

/** 目录浏览：给面板的路径选择器用，只列目录、不列文件内容。 */
function listDirs(input) {
  const drives = [];
  if (process.platform === 'win32') {
    for (let i = 65; i <= 90; i += 1) {
      const d = String.fromCharCode(i) + ':\\';
      try { if (fs.existsSync(d)) drives.push(d); } catch { /* ignore */ }
    }
  }
  let target = String(input || '').trim();
  if (!target) target = process.platform === 'win32' ? (drives.find((d) => /^[C-Z]:/i.test(d)) || drives[0] || 'C:\\') : os.homedir();
  target = path.resolve(target);
  let dirs = [];
  let writable = false;
  try {
    const items = fs.readdirSync(target, { withFileTypes: true });
    dirs = items.filter((x) => x.isDirectory() && !x.name.startsWith('.'))
      .map((x) => ({ name: x.name, path: path.join(target, x.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    writable = true;
  } catch { /* 不可读 */ }
  const parent = path.dirname(target) === target ? null : path.dirname(target);
  return { ok: true, path: target, parent, dirs, drives, writable };
}

/** 识别使用者提供的模板 / 绩效表目录，供概览页展示「已识别到什么」。 */
function probeUserPaths(cfg) {
  const result = { template: null, perf: null, out: null };
  const tpl = cfg.report_template || TEMPLATE_FILE;
  try {
    if (fs.existsSync(tpl) && fs.statSync(tpl).isFile()) {
      const text = fs.readFileSync(tpl, 'utf8').replace(/^\uFEFF/, '');
      result.template = { path: tpl, builtin: !cfg.report_template, placeholders: (text.match(/\{\{\w+\}\}/g) || []) };
    }
  } catch { /* ignore */ }
  try {
    if (cfg.folder && fs.existsSync(cfg.folder)) {
      const files = fs.readdirSync(cfg.folder).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$'));
      result.perf = { path: cfg.folder, tables: files.slice(0, 30), count: files.length };
    }
  } catch { /* ignore */ }
  try {
    if (cfg.out_dir) {
      fs.mkdirSync(cfg.out_dir, { recursive: true });
      result.out = { path: cfg.out_dir, writable: true };
    }
  } catch { result.out = { path: cfg.out_dir || '', writable: false }; }
  return result;
}

function log(line) {
  try {
    ensureDirs();
    fs.appendFileSync(path.join(LOGS, 'panel.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch { /* ignore */ }
}

module.exports = {
  SERVICE_DIR, PLUGIN_DIR, ENGINE_DIR, ENGINE, PUBLIC_DIR, TEMPLATE_FILE,
  DATA_DIR, CONFIG, KEY, REPORTS, LOGS,
  ensureDirs, defaultConfig, loadConfig, saveConfig, maskConfig,
  readKey, writeKey, keyInfo, listReports, readReport, listDirs, probeUserPaths,
  backup, atomicWrite, log,
};
