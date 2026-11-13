/**
 * 配置与路径（对应 gen_weekly_text.py 的常量段 + load_config/apply_config/
 * resolve_token/_Tee/enable_log/default_out_path）。
 *
 * 优先级：命令行 > 环境变量(WEEKLY_OUT_DIR/WEEKLY_TOKEN_FILE/WEEKLY_FOLDER)
 *         > config.json > 内置默认。
 * config.json 里的相对路径以「引擎目录」为基准，整个目录可以整体搬走。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { absPath, isoDate } from './util.mjs';

export const DEFAULT_MCP_URL = 'https://yanfa.scedu.tech/api/mcp';
export const DEFAULT_LINK = 'https://yanfa.scedu.tech/?tab=ticket-detail&ticketId={id}';
export const DEFAULT_TASK_LINK = 'https://yanfa.scedu.tech/?tab=task-detail&taskId={id}';
export const TASK_LIST_TOOL = 'task_list_my_tasks';
export const TASK_DETAIL_TOOL = 'task_get_task_detail';

/**
 * v1.0 完整化改造：默认值里不再出现任何本机绝对路径 / 个人信息。
 * 真实路径一律由面板写入 <data>/config.json（绝对路径），这里只作兜底。
 * 数据目录可用 WEEKLY_DATA_DIR 覆盖（server.cjs 启动引擎时会注入）。
 */
export const DATA_DIR = process.env.WEEKLY_DATA_DIR
  || process.env.WEEKLY_PANEL_DATA
  || path.join(os.homedir(), '.dsh', 'weekly-report');
export const DEFAULT_TOKEN_FILE = path.join(DATA_DIR, 'api-key.txt');
export const DEFAULT_OUT_DIR = path.join(DATA_DIR, 'reports');
export const DEFAULT_FOLDER = path.join(DATA_DIR, 'perf');
export const DEFAULT_HANDLER = '';
export const DEFAULT_THRESHOLD = 0.85;
export const MCP_PROTOCOL = '2025-06-18';

/** 引擎目录（service/engine）；配置里的相对路径都相对它 */
export const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_NAME = 'weekly_config.json';
export const DEFAULT_CONFIG_PATH = path.join(ENGINE_DIR, CONFIG_NAME);

/** 读配置；文件缺失/损坏都退回空对象（与 Python 一致：损坏时报一句警告） */
export function loadConfig(configPath) {
  const file = configPath || DEFAULT_CONFIG_PATH;
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      console.log(`警告：${path.basename(file)} 解析失败（${e.message}），改用默认配置`);
    }
    return {};
  }
}

/**
 * 按优先级解析运行期路径。
 * @param {{config?: string, folder?: string, out?: string}} args 命令行参数
 * @returns {{config: object, configPath: string, outDir: string, tokenFile: string, perfFolder: string}}
 */
export function applyConfig(args = {}) {
  const configPath = args.config ? absPath(args.config, ENGINE_DIR) : DEFAULT_CONFIG_PATH;
  const cfg = loadConfig(configPath);
  const outDir = absPath(process.env.WEEKLY_OUT_DIR || cfg.out_dir || DEFAULT_OUT_DIR, ENGINE_DIR);
  const tokenFile = absPath(process.env.WEEKLY_TOKEN_FILE || cfg.token_file || DEFAULT_TOKEN_FILE, ENGINE_DIR);
  const perfFolder = args.folder
    ? absPath(args.folder, ENGINE_DIR)
    : absPath(process.env.WEEKLY_FOLDER || cfg.folder || DEFAULT_FOLDER, ENGINE_DIR);
  return { config: cfg, configPath, outDir, tokenFile, perfFolder };
}

/**
 * 解析 Key：env:变量名 / file:路径 / 直接当 Key（也支持传一个存在的文件路径）。
 * @returns {string|null}
 */
export function resolveToken(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (v.startsWith('env:')) return (process.env[v.slice(4)] || '').trim() || null;
  if (v.startsWith('file:')) return readKeyFile(v.slice(5).trim());
  try {
    if (fs.statSync(v).isFile()) return readKeyFile(v);
  } catch {
    /* 不是文件就当 Key 用 */
  }
  return v || null;
}

function readKeyFile(p) {
  try {
    return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim() || null;
  } catch {
    return null;
  }
}

/** 按周期归档：<outDir>\2026年11月\周报_2026-11-10_2026-11-16.txt */
export function defaultOutPath(outDir, weekStart, weekEnd) {
  const month = `${weekStart.getFullYear()}年${String(weekStart.getMonth() + 1).padStart(2, '0')}月`;
  return path.join(outDir, month, `周报_${isoDate(weekStart)}_${isoDate(weekEnd)}.txt`);
}

/**
 * --log：把 stdout/stderr 同时追加写到 <outDir>\logs\run.log。
 * 返回还原函数（测试/CLI 结束时调用）。
 */
export function enableLog(outDir) {
  const logDir = path.join(outDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, 'run.log');
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const fd = fs.openSync(file, 'a');
  const tee = (orig) => (chunk, encoding, cb) => {
    try {
      fs.writeSync(fd, typeof chunk === 'string' ? chunk : Buffer.from(chunk));
    } catch {
      /* 日志写不进去不影响主流程 */
    }
    return orig(chunk, encoding, cb);
  };
  process.stdout.write = tee(originalOut);
  process.stderr.write = tee(originalErr);
  const stamp = new Date();
  console.log(`\n===== ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} `
    + `${pad(stamp.getHours())}:${pad(stamp.getMinutes())}:${pad(stamp.getSeconds())} =====`);
  return () => {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    try { fs.closeSync(fd); } catch { /* ignore */ }
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}
