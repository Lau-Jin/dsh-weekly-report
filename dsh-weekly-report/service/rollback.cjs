#!/usr/bin/env node
/**
 * 面板驱动的「版本回退」worker（v1.5.0）
 * ------------------------------------------------------------------
 * 为什么要有它：面板服务本身就装在 <profile>/node_modules/<包>/ 里，
 * 想回退版本就必须先把这个目录解锁 —— Windows 下进程占着目录时
 * pnpm 会报 ERR_PNPM_EPERM。
 *
 * 做法（与发布工具 update-plugin.mjs 同一套）：
 *   1. 在面板端口起一个「占位应答器」（任意请求回 200）
 *   2. 杀掉真面板 → 心跳探活命中占位器 → 不再拉起 → 目录解锁
 *   3. pnpm 精确版本安装（pkg@版本），并登记供应链冷却期豁免
 *   4. 校验安装结果 → 撤掉占位器 → 心跳自动从新版拉起面板
 *
 * 这个 worker 会被复制到数据目录再执行 —— 回退时插件目录被换掉，
 * 跑着的脚本也不能跟着消失。
 *
 * 用法：node rollback.cjs --pkg <包名> --version <版本> --profile <profile 目录>
 *                     --port <面板端口> --log <日志文件> [--probe <探活路径>]
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const PKG = opt('--pkg', 'dsh-weekly-report-lau');
const VERSION = opt('--version');
const PROFILE = opt('--profile');
const PORT = Number(opt('--port', '8798'));
const PROBE_PATH = opt('--probe', '/api/state');
const LOG_FILE = opt('--log');
const WORKSPACE_YAML = PROFILE ? path.join(PROFILE, 'pnpm-workspace.yaml') : '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (LOG_FILE) {
    try {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
    } catch { /* 日志写不进去不影响流程 */ }
  }
}

/** 端口探活 */
function probe() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}${PROBE_PATH}`, { timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ body: body.slice(0, 300), ok: res.statusCode < 400 }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** 杀掉占用面板端口的进程 */
function killPanel() {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', shell: true });
    const pid = out.split('\n')
      .find((l) => l.includes(`:${PORT}`) && l.includes('LISTENING'))
      ?.trim().split(/\s+/).pop();
    if (pid && pid !== '0') {
      try { execFileSync('taskkill', ['/PID', pid, '/F'], { shell: true }); } catch { /* 尽力 */ }
      return pid;
    }
  } catch { /* 端口空闲 */ }
  return null;
}

/** 占位应答器：任意请求回 200，让心跳以为面板在线 */
function startPlaceholder() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((_req, res) => { res.writeHead(200); res.end('placeholder'); });
    const tryBind = (n) => {
      srv.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && n < 200) setTimeout(() => tryBind(n + 1), 400);
        else reject(new Error(`占位应答器无法绑定端口 ${PORT}：${e.code}`));
      });
      srv.listen(PORT, '127.0.0.1', () => resolve(srv));
    };
    tryBind(0);
  });
}

/** 找 pnpm：优先用 DSH runtime 自带的（版本固定、不需要联网下载） */
function pnpmRunner() {
  const home = process.env.USERPROFILE || '';
  const candidates = [
    path.join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { cmd: process.execPath, args: [c] };
  }
  return { cmd: 'npx', args: ['-y', 'pnpm@11.28.5'] };
}

/** 供应链冷却期豁免：minimumReleaseAgeExclude 按精确版本钉死 */
function pinReleaseExclude(version) {
  if (!WORKSPACE_YAML || !fs.existsSync(WORKSPACE_YAML)) return;
  const text = fs.readFileSync(WORKSPACE_YAML, 'utf8');
  const pin = `${PKG}@${version}`;
  if (text.includes(pin)) return;
  const re = new RegExp(`(  - )${PKG}@[^\\n]*`);
  const updated = re.test(text)
    ? text.replace(re, `$1${pin}`)
    : text.replace(/\n?$/, '\n') + `  - ${pin}\n`;
  fs.writeFileSync(WORKSPACE_YAML, updated, 'utf8');
  log(`已登记供应链豁免：${pin}`);
}

async function main() {
  if (!VERSION) throw new Error('缺少 --version');
  if (!PROFILE) throw new Error('缺少 --profile');
  log(`—— 回退 ${PKG} → ${VERSION}（profile: ${PROFILE}）——`);

  // 占位器**不能等绑定成功**再杀面板 —— 端口还被真面板占着，会死锁。
  // 正确顺序：占位器开始监听（可能先失败重试）→ 立刻开始杀面板 → 占位器接管。
  const holderPromise = startPlaceholder().catch((e) => {
    log(`占位器启动失败：${e.message}`);
    return null;
  });
  log('1. 占位应答器开始接管面板端口 …');

  let rounds = 0;
  let ready = false;
  while (rounds++ < 20) {
    const r = await probe();
    if (r && r.body.startsWith('placeholder')) { ready = true; break; }
    const killed = killPanel();
    if (killed) log(`   轮次 ${rounds}：已结束面板进程 pid=${killed}`);
    await sleep(700);
  }
  const holder = await holderPromise;
  if (!holder || !ready) {
    if (holder) { try { holder.close(); } catch { /* ignore */ } }
    throw new Error('占位器未能接管端口（心跳拉起过快），稍后重试');
  }
  log('   ✓ 占位器已接管，目录已解锁（心跳不会再拉起面板）');

  log('2. 安装指定版本 …');
  pinReleaseExclude(VERSION);
  const nm = path.join(PROFILE, 'node_modules');
  try {
    for (const junk of fs.readdirSync(nm)) {
      if (junk === '.ignored' || junk.startsWith(`${PKG}_tmp_`)) {
        try { fs.rmSync(path.join(nm, junk), { recursive: true, force: true }); } catch { /* 尽力 */ }
      }
    }
    fs.rmSync(path.join(nm, PKG), { recursive: true, force: true });
  } catch (e) {
    log(`   清理旧目录失败（继续）：${e.message}`);
  }

  const { cmd, args } = pnpmRunner();
  const out = execFileSync(cmd, [...args, 'update', `${PKG}@${VERSION}`], {
    cwd: PROFILE, encoding: 'utf8', shell: true, timeout: 300000,
  });
  if (out && out.includes('ERR_PNPM')) {
    log(`pnpm 失败：\n${String(out).slice(-600)}`);
    throw new Error('pnpm 安装失败');
  }

  const installed = JSON.parse(fs.readFileSync(path.join(nm, PKG, 'package.json'), 'utf8'));
  log(`3. ✓ 已安装 ${installed.name}@${installed.version}`);
  if (installed.version !== VERSION) throw new Error(`版本不符：期望 ${VERSION}，实际 ${installed.version}`);

  log('4. 撤掉占位器，等待心跳拉起面板 …');
  try { holder.close(); } catch { /* ignore */ }
  for (let i = 0; i < 30; i += 1) {
    await sleep(2000);
    const r = await probe();
    if (r && r.ok && !r.body.startsWith('placeholder')) {
      log(`   ✓ 面板已复活：${r.body.slice(0, 100)}`);
      log(`✅ 回退完成：${PKG}@${installed.version}。若插件页未刷新，请重启一次 DSH。`);
      return;
    }
  }
  log(`✅ 回退完成（${installed.version}），但面板 60s 内未自动复活 —— 重启 DSH 即可。`);
}

main().catch((e) => {
  log(`✗ 回退失败：${(e && e.message) || e}`);
  process.exitCode = 1;
});
