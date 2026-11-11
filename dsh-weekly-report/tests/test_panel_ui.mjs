/**
 * 面板 UI 的交互回归测试（无头 Chrome + CDP，不依赖 jsdom）。
 *
 * 覆盖 v0.7.2：
 *   · 面板服务守护默认收起，点「展开」才出内容
 *   · 路径默认隐藏；点「显示路径」出真实路径 + 复制按钮；再点回隐藏
 *   · 历史页的同款按钮与概览联动（同一开关，localStorage 记住）
 *   · 系统定时任务按钮名称（不再出现「指向插件引擎」）
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

const DEBUG_PORT = 9411
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
    on(method, fn) {
      if (!events.has(method)) events.set(method, [])
      events.get(method).push(fn)
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

async function main() {
  const client = cdp(await wsUrl())
  await client.ready
  await client.send('Page.enable')
  await client.send('Runtime.enable')
  const loads = []
  client.on('Page.loadEventFired', () => loads.push(Date.now()))
  await client.send('Page.navigate', { url: BASE })
  // 等页面把 state 拉回来并渲染
  for (let i = 0; i < 40; i += 1) {
    await sleep(250)
    const ready = await evaluate(client, "!!document.querySelector('#paths') && document.querySelectorAll('#checks .wr-check').length > 0")
    if (ready) break
  }

  // 1. 守护卡默认收起
  check('面板服务守护默认收起（卡片正文隐藏）', await evaluate(client, "document.querySelector('#wd-body').hidden === true"))
  check('守护标题旁有「展开」按钮', (await evaluate(client, "document.querySelector('#btn-wd-toggle').textContent.trim()")) === '展开')
  await evaluate(client, "document.querySelector('#btn-wd-toggle').click()")
  await sleep(200)
  check('点「展开」后正文出现', await evaluate(client, "document.querySelector('#wd-body').hidden === false"))
  check('按钮变成「收起」', (await evaluate(client, "document.querySelector('#btn-wd-toggle').textContent.trim()")) === '收起')
  await evaluate(client, "document.querySelector('#btn-wd-toggle').click()")
  await sleep(200)
  check('再点回到「收起」状态', await evaluate(client, "document.querySelector('#wd-body').hidden === true"))

  // 2. 路径默认隐藏
  const pathsHtml = await evaluate(client, "document.querySelector('#paths').innerHTML")
  check('路径默认隐藏（出现「已隐藏」）', pathsHtml.includes('已隐藏'), pathsHtml.slice(0, 120))
  check('路径默认不显示真实目录', !pathsHtml.includes('dsh-weekly-report'), pathsHtml.slice(0, 120))
  check('路径卡按钮是「显示路径」', (await evaluate(client, "document.querySelector('#btn-toggle-paths').textContent.trim()")) === '显示路径')

  // 3. 点开显示路径
  await evaluate(client, "document.querySelector('#btn-toggle-paths').click()")
  await sleep(250)
  const pathsOn = await evaluate(client, "document.querySelector('#paths').innerHTML")
  check('点「显示路径」后出现真实路径', /[A-Za-z]:\\\\|dsh-weekly-report/.test(pathsOn) || pathsOn.includes('dsh-weekly-report'), pathsOn.slice(0, 160))
  check('出现「复制」按钮', pathsOn.includes('复制'))
  check('按钮变成「隐藏路径」', (await evaluate(client, "document.querySelector('#btn-toggle-paths').textContent.trim()")) === '隐藏路径')
  check('localStorage 记住开关', (await evaluate(client, "window.localStorage.getItem('wr-show-paths')")) === '1')

  // 4. 定时任务卡：按钮名称 & 路径也跟着开关
  const schedBtn = await evaluate(client, "document.querySelector('#btn-sched-install').textContent.trim()")
  check('定时任务按钮改名为「登记每周自动生成（周日 22:00）」', schedBtn === '登记每周自动生成（周日 22:00）', schedBtn)
  check('页面不再出现「指向插件引擎」', !(await evaluate(client, "document.body.innerText")).includes('指向插件引擎'))

  // 5. 历史页按钮联动 + 路径显隐
  await evaluate(client, "document.querySelector('.wr-tab[data-tab=\"reports\"]').click()")
  await sleep(300)
  const histToggle = await evaluate(client, "Array.from(document.querySelectorAll('[data-path-toggle]')).map(b=>b.textContent.trim())")
  check('历史页也有路径开关且与大开关同步', histToggle.filter((t) => t === '隐藏路径').length >= 2, JSON.stringify(histToggle))
  await evaluate(client, "document.querySelectorAll('[data-path-toggle]')[1].click()")
  await sleep(250)
  check('从历史页关掉后概览卡也回到隐藏', (await evaluate(client, "document.querySelector('#paths').innerHTML")).includes('已隐藏'))

  // 6. 刷新后保持隐藏
  await client.send('Page.reload', {})
  await sleep(2500)
  check('刷新后仍是隐藏状态', (await evaluate(client, "document.querySelector('#paths').innerHTML")).includes('已隐藏'))

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
