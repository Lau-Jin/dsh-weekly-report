/**
 * 面板 UI 的交互回归测试（无头 Chrome + CDP，不依赖 jsdom）。
 *
 * 覆盖 v0.7.3：
 *   · 面板服务守护默认收起，点「展开」才出内容
 *   · 每张卡片各自一个「显示路径 / 隐藏路径」开关，互不影响：
 *     路径卡、系统定时任务、面板服务守护、最近一次生成、历史
 *   · 开关状态按卡片分别记在 localStorage，刷新后保持
 *   · 系统定时任务按钮名称（不再出现「指向插件引擎」）
 *   · 品牌图标：favicon 与顶栏 logo 用的是 /icon.svg，且能正常加载
 *
 * 跑法：
 *   node dsh-weekly-report/tests/test_panel_ui.mjs [--port 8798]
 * 需要本机装了 Chrome；脚本自己起一个无头实例，用完杀掉。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 8798)
const BASE = `http://127.0.0.1:${PORT}/`
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
].find((p) => p && existsSync(p))
if (!CHROME) {
  console.log('没找到 Chrome，跳过（UI 测试需要 Chrome）')
  process.exit(0)
}

const DEBUG_PORT = 9412
const profile = path.join(process.env.TEMP || '.', 'wr-ui-test-' + Date.now())
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1280,1600', 'about:blank',
], { stdio: 'ignore', windowsHide: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail })
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ' —— ' + detail}`)
}

async function wsUrl() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch { /* chrome 还没起来 */ }
    await sleep(250)
  }
  throw new Error('连不上 Chrome 调试端口')
}

function cdp(url) {
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  const events = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    } else if (msg.method && events.has(msg.method)) {
      events.get(msg.method).forEach((fn) => fn(msg.params))
    }
  })
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (e) => reject(e))
  })
  return {
    ready,
    send(method, params = {}) {
      id += 1
      const myId = id
      return new Promise((resolve, reject) => {
        pending.set(myId, { resolve, reject })
        ws.send(JSON.stringify({ id: myId, method, params }))
      })
    },
    close() { try { ws.close() } catch { /* ignore */ } },
  }
}

const evaluate = async (client, expression) => {
  const r = await client.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed')
  return r.result.value
}

const waitReady = async (client) => {
  for (let i = 0; i < 40; i += 1) {
    await sleep(250)
    const ready = await evaluate(client, "!!document.querySelector('#paths') && document.querySelectorAll('#checks .wr-check').length > 0")
    if (ready) return true
  }
  return false
}

async function main() {
  const client = cdp(await wsUrl())
  await client.ready
  await client.send('Page.enable')
  await client.send('Runtime.enable')
  await client.send('Page.navigate', { url: BASE })
  await waitReady(client)
  // 清掉上次跑测试留下的路径开关状态，保证从「默认全隐藏」开始
  await evaluate(client, "window.localStorage.removeItem('wr-show-paths')")
  await client.send('Page.reload', {})
  await sleep(2500)
  await waitReady(client)

  const state = async () => evaluate(client, `(() => {
    const btn = (k) => document.querySelector('[data-path-toggle="' + k + '"]');
    return {
      pathsHidden: document.querySelector('#paths').innerHTML.includes('已隐藏'),
      schedHidden: document.querySelector('#schedule').innerHTML.includes('已隐藏'),
      wdHidden: document.querySelector('#watchdog').innerHTML.includes('已隐藏'),
      labels: {
        paths: btn('paths') && btn('paths').textContent.trim(),
        schedule: btn('schedule') && btn('schedule').textContent.trim(),
        watchdog: btn('watchdog') && btn('watchdog').textContent.trim(),
        lastrun: btn('lastrun') && btn('lastrun').textContent.trim(),
        reports: btn('reports') && btn('reports').textContent.trim(),
      },
      wdBodyHidden: document.querySelector('#wd-body').hidden,
      wdToggle: document.querySelector('#btn-wd-toggle').textContent.trim(),
    };
  })()`)

  // 1. 守护卡默认收起
  let s = await state()
  check('面板服务守护默认收起', s.wdBodyHidden === true)
  check('守护标题旁有「展开」按钮', s.wdToggle === '展开')
  await evaluate(client, "document.querySelector('#btn-wd-toggle').click()")
  await sleep(200)
  s = await state()
  check('点「展开」后正文出现', s.wdBodyHidden === false)
  check('按钮变成「收起」', s.wdToggle === '收起')

  // 2. 每张卡都有独立开关
  check('路径卡有自己的开关', s.labels.paths === '显示路径', JSON.stringify(s.labels))
  check('定时任务卡有自己的开关', s.labels.schedule === '显示路径', JSON.stringify(s.labels))
  check('守护卡有自己的开关', s.labels.watchdog === '显示路径', JSON.stringify(s.labels))
  check('最近一次生成有自己的开关', s.labels.lastrun === '显示路径', JSON.stringify(s.labels))
  check('默认全部隐藏', s.pathsHidden && s.wdHidden, JSON.stringify(s))

  // 3. 只开路径卡：其它卡不受影响
  await evaluate(client, "document.querySelector('[data-path-toggle=\"paths\"]').click()")
  await sleep(250)
  s = await state()
  check('路径卡可单独展开（出现真实路径）', !s.pathsHidden)
  check('路径卡按钮变「隐藏路径」', s.labels.paths === '隐藏路径', s.labels.paths)
  check('别的卡仍是隐藏（互不影响）', s.wdHidden === true && s.labels.schedule === '显示路径')

  // 4. 定时任务卡单独开
  await evaluate(client, "document.querySelector('[data-path-toggle=\"schedule\"]').click()")
  await sleep(250)
  s = await state()
  check('定时任务卡单独展开（出现启动命令）', !s.schedHidden)
  check('定时任务按钮变「隐藏路径」', s.labels.schedule === '隐藏路径', s.labels.schedule)
  check('路径卡不受影响（仍展开）', !s.pathsHidden)

  // 5. 守护卡单独开（先展开卡片）
  await evaluate(client, "document.querySelector('[data-path-toggle=\"watchdog\"]').click()")
  await sleep(250)
  s = await state()
  check('守护卡单独展开（出现启动命令）', !s.wdHidden)
  check('守护按钮变「隐藏路径」', s.labels.watchdog === '隐藏路径', s.labels.watchdog)

  // 6. 关掉路径卡，其它保持
  await evaluate(client, "document.querySelector('[data-path-toggle=\"paths\"]').click()")
  await sleep(250)
  s = await state()
  check('关掉路径卡后只它隐藏', s.pathsHidden && !s.schedHidden && !s.wdHidden)
  check('关掉的按钮文字回到「显示路径」', s.labels.paths === '显示路径', s.labels.paths)

  // 7. 历史页开关独立（历史目录）
  const histHiddenBefore = await evaluate(client, "document.querySelector('#report-list').innerHTML.includes('路径已隐藏') || document.querySelector('#report-list').innerHTML.includes('还没生成过周报')")
  check('历史列表目录默认隐藏（或无记录）', histHiddenBefore)
  check('历史工具栏有自己的开关', (await evaluate(client, "document.querySelector('[data-path-toggle=\"reports\"]').textContent.trim()")) === '显示路径')
  await evaluate(client, "document.querySelector('.wr-tab[data-tab=\"reports\"]').click()")
  await sleep(300)
  await evaluate(client, "document.querySelector('[data-path-toggle=\"reports\"]').click()")
  await sleep(250)
  check('历史开关点了之后文字变「隐藏路径」', (await evaluate(client, "document.querySelector('[data-path-toggle=\"reports\"]').textContent.trim()")) === '隐藏路径')

  // 8. localStorage 按卡片记
  const saved = JSON.parse(await evaluate(client, "window.localStorage.getItem('wr-show-paths')"))
  check('localStorage 按卡片记状态', saved && saved.paths === false && saved.schedule === true && saved.watchdog === true && saved.reports === true, JSON.stringify(saved))

  // 9. 按钮名称
  const schedBtn = await evaluate(client, "document.querySelector('#btn-sched-install').textContent.trim()")
  check('定时任务按钮名正确', schedBtn === '登记每周自动生成（周日 22:00）', schedBtn)
  check('页面不再出现「指向插件引擎」', !(await evaluate(client, "document.body.innerText")).includes('指向插件引擎'))

  // 9.5 品牌图标：favicon + 顶栏 logo
  check('页面声明了 favicon（/icon.svg）',
    (await evaluate(client, "!!document.querySelector('link[rel=\"icon\"][href=\"/icon.svg\"]')")))
  check('顶栏有品牌 logo（img.wr-brand__logo）',
    (await evaluate(client, "!!document.querySelector('img.wr-brand__logo')")))
  const iconOk = await evaluate(client, `(async () => {
    const img = document.querySelector('img.wr-brand__logo');
    if (!img) return { ok: false, reason: 'no img' };
    if (!img.complete) await new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); });
    const res = await fetch('/icon.svg');
    const text = await res.text();
    return { ok: img.naturalWidth > 0 && res.ok && text.trimStart().startsWith('<svg') && text.includes('viewBox'),
             w: img.naturalWidth, type: res.headers.get('content-type'), head: text.slice(0, 40) };
  })()`)
  check('图标能加载且是合法 SVG（/icon.svg, image/svg+xml）',
    iconOk.ok && /svg/.test(iconOk.type || ''), JSON.stringify(iconOk))

  // 10. 刷新后保持（各卡的状态各自恢复）
  await client.send('Page.reload', {})
  await sleep(2500)
  await waitReady(client)
  const after = await state()
  check('刷新后：关掉的卡仍隐藏', after.pathsHidden === true)
  check('刷新后：开着的卡仍显示', after.schedHidden === false && after.wdHidden === false)
  check('刷新后：守护卡回到收起', after.wdBodyHidden === true)

  client.close()
  console.log('')
  const failed = results.filter((r) => !r.ok)
  console.log(`通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`)
  return failed.length ? 1 : 0
}

main()
  .then((code) => { chrome.kill(); process.exit(code) })
  .catch((e) => {
    console.error('测试出错：', e.message)
    chrome.kill()
    process.exit(1)
  })
