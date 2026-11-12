/**
 * 周报面板 · Host 半身
 *
 * 只做一件事：保证本地面板服务（默认 127.0.0.1:8798）在运行。
 * 面板本身是纯 UI，所有读写（配置 / API Key / 生成 / 历史）都由那个服务完成，
 * 这里不碰任何凭据。
 *
 * 2026-11-11（v0.7.1）连通性优化：
 *   · 探活用轻量 /api/ping（1~2 ms），不再打 /api/state（要 spawn python，慢的时候 2~6 s，
 *     会把活着服务误判成挂了，然后反复拉起 → 日志里一堆「port in use」）
 *   · 心跳 20 秒一次，单飞（上一次拉起还没结果就不重复拉起）
 *   · 拉起后 5 秒内复核一次，只记「起来 / 没起来」两种日志，不再刷屏
 *
 * 2026-11-12（v0.8.0）：这一层成为**唯一**的保活手段。
 * 原来还有个 Windows 计划任务「周报面板守护」跑 powershell 探活，但
 * `powershell.exe -WindowStyle Hidden` 会先建控制台窗口再隐藏（桌面每 2 分钟闪一下蓝窗），
 * 已连同 service/ps/watchdog*.ps1 一起删除；这里的 spawn 用 windowsHide，全程无窗口。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = process.env.WEEKLY_PANEL_PORT || '8798'
const SERVICE = `http://127.0.0.1:${PORT}`
const PING = SERVICE + '/api/ping'
const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * server.cjs 可能的落点，按优先级：
 *   1. WEEKLY_PANEL_SERVER 显式指定
 *   2. 包内（Junction / link 安装时 HERE 指向真实路径，这一条就能命中）
 *   3. WEEKLY_PANEL_HOME 指定的目录
 *   4. 本机常见检出位置（仓库主数据源 D:\Tools\Lau-tool，其次旧的开发目录）
 */
const SERVER_CANDIDATES = [
  process.env.WEEKLY_PANEL_SERVER,
  path.resolve(HERE, '..', 'service', 'server.cjs'),
  path.resolve(HERE, '..', '..', 'service', 'server.cjs'),
  process.env.WEEKLY_PANEL_HOME
    ? path.join(process.env.WEEKLY_PANEL_HOME, 'service', 'server.cjs')
    : '',
  path.resolve('D:\\', 'Lau-tool', 'dsh-weekly-report', 'service', 'server.cjs'),
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

export function apply(ctx) {
  void ensureService()
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
