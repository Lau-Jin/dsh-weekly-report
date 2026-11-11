/**
 * 周报面板 · Host 半身
 *
 * 只做一件事：保证本地面板服务（127.0.0.1:8798）在运行。
 * 面板本身是纯 UI，所有读写（配置 / API Key / 生成 / 历史）都由那个服务完成，
 * 这里不碰任何凭据。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '0.1.0'
const SERVICE = 'http://127.0.0.1:8798'
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
    const res = await fetch(SERVICE + '/api/state', { signal: AbortSignal.timeout(1500) })
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

async function ensureService() {
  if (await reachable()) return
  const server = findServer()
  if (!server) {
    console.warn('[weekly-report] server.cjs not found, tried:\n  ' + SERVER_CANDIDATES.join('\n  '))
    return
  }
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
    console.log('[weekly-report] 面板服务已启动：' + server)
  } catch (error) {
    console.warn('[weekly-report] 启动面板服务失败：', error && error.message)
  }
}

export function apply(ctx) {
  void ensureService()
  if (ctx && typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => {
        // 服务挂了要能自己回来（DSH 重启后尤其重要）
        const revive = () => { void ensureService().catch(() => {}) }
        const timer = setInterval(revive, 60_000)
        if (typeof timer.unref === 'function') timer.unref()
        return () => clearInterval(timer)
      }, 'weekly-report: heartbeat')
    } catch {
      /* effect 是尽力而为 */
    }
  }
}
