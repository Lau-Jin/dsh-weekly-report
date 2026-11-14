/**
 * 周报工作台 · DSH Host 半身（v1.0）
 *
 * 只做一件事：保证本地面板服务（127.0.0.1:8798）在运行。
 * 面板是纯 UI，配置 / API Key / 生成 / 历史全部由服务负责，这里不碰任何凭据。
 *
 * v1.0 完整化：
 *   · 路径全部相对包自身解析，不再出现任何本机硬编码目录，包可整体分发；
 *   · 探活只用轻量 /api/ping，20 秒一次、单飞，拉起用 windowsHide 全程无窗口；
 *   · 服务文件名与端口沿用旧版，DSH 侧边栏 iframe 无需改动即可显示新面板；
 *   · 不装任何计划任务（避免桌面周期性弹控制台窗口）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const PORT = process.env.WEEKLY_PANEL_PORT || '8798'
const SERVICE = `http://127.0.0.1:${PORT}`
const PING = SERVICE + '/api/ping'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')

/**
 * server.cjs 落点：包内优先（Junction / link / 复制安装都能命中），
 * 其余只作环境变量兜底。没有任何写死的本机绝对路径。
 */
const SERVER_CANDIDATES = [
  process.env.WEEKLY_PANEL_SERVER,
  path.resolve(HERE, '..', 'service', 'server.cjs'),
  path.resolve(HERE, '..', '..', 'service', 'server.cjs'),
  process.env.WEEKLY_PANEL_HOME
    ? path.join(process.env.WEEKLY_PANEL_HOME, 'service', 'server.cjs')
    : '',
].filter(Boolean)

function findServer() {
  return SERVER_CANDIDATES.find((candidate) => existsSync(candidate)) || null
}

async function reachable() {
  try {
    const res = await fetch(PING, { signal: AbortSignal.timeout(1200), cache: 'no-store' })
    return res.ok
  } catch {
    return false
  }
}

function nodeBinary() {
  const candidates = [
    process.env.WEEKLY_PANEL_NODE,
    process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime',
          'dependencies', 'node', 'bin', 'node.exe')
      : '',
  ].filter(Boolean)
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return { command: found, env: process.env }
  return { command: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
}

let lastSpawnAt = 0
let lastState = ''

async function ensureService() {
  if (await reachable()) {
    if (lastState !== 'up') { lastState = 'up'; console.log('[weekly-report] 面板服务在线：' + SERVICE) }
    return
  }
  if (lastState === 'down') console.warn('[weekly-report] 面板服务仍然不在：' + SERVICE)
  lastState = 'down'
  if (Date.now() - lastSpawnAt < 8000) return
  const server = findServer()
  if (!server) {
    console.warn('[weekly-report] server.cjs not found, tried:\n  ' + SERVER_CANDIDATES.join('\n  '))
    return
  }
  lastSpawnAt = Date.now()
  try {
    const { command, env } = nodeBinary()
    const child = spawn(command, [server], {
      cwd: path.dirname(server),
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    // 拉起后复核一次：起来就报一句，没起来给个明确提示（不再每 60 秒刷一次）
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setTimeout(r, 500))
      if (await reachable()) {
        lastState = 'up'
        console.log('[weekly-report] 面板服务已启动：' + server)
        return
      }
    }
    console.warn('[weekly-report] 已尝试启动面板服务，但 5 秒内没响应：' + server)
  } catch (error) {
    console.warn('[weekly-report] 启动面板服务失败：', error && error.message)
  }
}

/**
 * 自举绩效表组件：完整包自带 node_modules 时是零成本的同步判断；
 * 精简包（例如从 DSH 插件页安装）才在后台异步补装，不阻塞 DSH 启动。
 * 这样无论用 pnpm 安装还是插件页直装，能力都一致。
 */
let bootstrapped = false
function bootstrapPerfDeps() {
  if (bootstrapped) return
  bootstrapped = true
  try {
    const PerfDeps = require('../service/perf-deps.cjs')
    if (PerfDeps.isAvailable(PLUGIN_DIR)) return
    const timer = setTimeout(() => {
      void PerfDeps.ensure(PLUGIN_DIR).then((r) => {
        if (!r.available) console.warn('[weekly-report] 绩效表组件未就绪，可在面板「设置」页补装')
      }).catch(() => {})
    }, 1500)
    if (typeof timer.unref === 'function') timer.unref()
  } catch {
    /* 尽力而为，不影响面板服务 */
  }
}

export function apply(ctx) {
  void ensureService()
  bootstrapPerfDeps()
  if (ctx && typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => {
        // 20 秒一次探活：ping 很轻，不会给服务添负担；挂了最多 20 秒就回来
        const revive = () => { void ensureService().catch(() => {}) }
        const timer = setInterval(revive, 20_000)
        if (typeof timer.unref === 'function') timer.unref()
        return () => clearInterval(timer)
      }, 'weekly-report: heartbeat')
    } catch {
      /* effect 是尽力而为 */
    }
  }
}
