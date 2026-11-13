/**
 * 绩效表组件（exceljs）管理 · 服务端与安装器共用（CommonJS，零第三方依赖）
 *
 * 失败的旧做法：spawn('npm.cmd', ..., { shell: true })。
 * 面板服务由 DSH 内置 Node 启动，那个目录里只有 node.exe、没有 npm，
 * 进程环境的 PATH 里也没有 node —— 于是 npm.cmd 内部调用 node 时报
 * 「'node' 不是内部或外部命令」，按钮永远失败。而且组件已装好时也重复安装。
 *
 * 现在：
 *   1. 先检测是否已可用，已可用直接短路（最常见，且零副作用）；
 *   2. 完整安装包自带 node_modules/exceljs，装完即用，完全离线；
 *   3. 精简包才走在线补装：用当前 Node 的绝对路径直调 npm-cli.js，
 *      不依赖 shell / .cmd / PATH，并把 node 所在目录注入子进程 PATH；
 *   4. 全链路带 error 监听、超时、可读中文原因与手动命令，绝不抛未捕获异常。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PKG = 'exceljs@4.4.0';
const TIMEOUT_MS = 150000;

function marker(pluginDir) {
  return path.join(pluginDir, 'node_modules', 'exceljs', 'package.json');
}
function isAvailable(pluginDir) {
  try { return fs.statSync(marker(pluginDir)).isFile(); } catch { return false; }
}

/** npm-cli.js 是纯 JS，用任何一个 Node 20+ 都能跑；关键是别依赖 PATH。 */
function findNpmCli() {
  const home = process.env.USERPROFILE || os.homedir();
  const nodeDir = path.dirname(process.execPath);
  const list = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
  ];
  // WorkBuddy / 其它版本化 Node 安装
  const versionsDir = path.join(home, '.workbuddy', 'binaries', 'node', 'versions');
  try {
    for (const v of fs.readdirSync(versionsDir)) {
      list.push(path.join(versionsDir, v, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
  } catch { /* 目录不存在 */ }
  const npmPrefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX;
  if (npmPrefix) list.push(path.join(npmPrefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  return list.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

/** Windows 中文控制台可能输出 GBK，尽力解码，失败退回 UTF-8。 */
function decode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  for (const enc of ['utf8', 'gbk']) {
    try { return new TextDecoder(enc, { fatal: false }).decode(b); } catch { /* 换下一个 */ }
  }
  return b.toString('utf8');
}

function manualCommand(pluginDir) {
  return `cd /d "${pluginDir}" && npm install ${PKG} --no-save --no-audit --no-fund --omit=dev`;
}

/**
 * 确保组件可用。永远 resolve，不抛异常。
 * @returns {Promise<{ok:boolean, mode:string, available:boolean, out:string, hint:string}>}
 */
async function ensure(pluginDir, options = {}) {
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  if (isAvailable(pluginDir)) {
    return {
      ok: true, mode: 'bundled', available: true,
      out: '绩效表组件已随插件自带，无需补装。',
      hint: '',
    };
  }

  const cli = findNpmCli();
  if (!cli) {
    const hint = '本机没有找到 npm。可把完整插件包里的 node_modules 目录整体拷贝过来，或在有 Node 的终端执行：' + manualCommand(pluginDir);
    return { ok: false, mode: 'no-npm', available: false, out: hint, hint };
  }

  const nodeDir = path.dirname(process.execPath);
  const env = {
    ...process.env,
    PATH: nodeDir + path.delimiter + (process.env.PATH || ''),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
  const args = [cli, 'install', PKG, '--no-save', '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error'];
  onLog(`$ ${process.execPath} ${args.join(' ')}`);

  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let child;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ available: isAvailable(pluginDir), out: out.trim().slice(-3000), ...result });
    };
    const timer = setTimeout(() => {
      try { child && child.kill(); } catch { /* ignore */ }
      done({ ok: false, mode: 'timeout', hint: '补装超时，可稍后重试或手动执行：' + manualCommand(pluginDir) });
    }, TIMEOUT_MS);

    try {
      child = spawn(process.execPath, args, {
        cwd: pluginDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
      });
    } catch (e) {
      return done({ ok: false, mode: 'spawn-error', hint: `无法启动安装进程：${e.message}` });
    }
    const collect = (chunk) => { const t = decode(chunk); out += t; onLog(t); };
    child.stdout && child.stdout.on('data', collect);
    child.stderr && child.stderr.on('data', collect);
    child.on('error', (e) => {
      collect(Buffer.from(`\n启动失败：${e.message}\n`));
      done({ ok: false, mode: 'spawn-error', hint: '无法启动安装进程：' + e.message });
    });
    child.on('close', (code) => {
      if (isAvailable(pluginDir)) {
        return done({ ok: true, mode: 'npm-installed', hint: '' });
      }
      done({
        ok: false, mode: 'npm-failed',
        hint: `安装未成功（退出码 ${code}）。可在终端手动执行：${manualCommand(pluginDir)}`,
      });
    });
  });
}

module.exports = { PKG, isAvailable, findNpmCli, ensure, manualCommand, decode };
