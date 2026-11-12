/**
 * 面板 UI 的交互回归测试（无头 Chrome + CDP，不依赖 jsdom）。
 *
 * 覆盖 v0.8.0：
 *   · 每张卡片各自一个「显示路径 / 隐藏路径」开关，互不影响：
 *     路径卡、系统定时任务、最近一次生成、历史
 *   · 开关状态按卡片分别记在 localStorage，刷新后保持
 *   · 系统定时任务按钮名称（不再出现「指向插件引擎」）
 *   · 品牌图标：favicon 与顶栏 logo 用的是 /icon.svg，且能正常加载
 *   · 面板服务守护卡片已随 v0.8.0 下线（页面里不该再有）
 *
 * 跑法：
 *   node dsh-weekly-report/tests/test_panel_ui.mjs [--port 8798]
 * 需要本机装了 Chrome；脚本自己起一个无头实例，用完杀掉。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 8798)
const BASE = `http://127.0.0.1:${PORT}/?diag=1`
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
  if (r.exceptionDetails) {
    const d = r.exceptionDetails
    throw new Error('evaluate failed: ' + (d.exception?.description || d.text || 'unknown')
      + ' | expr: ' + expression.slice(0, 200))
  }
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
      labels: {
        paths: btn('paths') && btn('paths').textContent.trim(),
        schedule: btn('schedule') && btn('schedule').textContent.trim(),
        lastrun: btn('lastrun') && btn('lastrun').textContent.trim(),
      },
      visible: {
        paths: !!(btn('paths') && !btn('paths').hidden),
        schedule: !!(btn('schedule') && !btn('schedule').hidden),
        lastrun: !!(btn('lastrun') && !btn('lastrun').hidden),
      },
      hasPath: {
        // 「这块有没有路径」看数据，不看当前是否遮着：路径卡有 dd 且不是「未获取到路径」；
        // 历史有列表行；定时任务/最近一次生成有 pathBlock（遮着时里面是「已隐藏」文本，但 .wr-mono 还在）
        paths: document.querySelectorAll('#paths dd').length > 0 && !document.querySelector('#paths').innerHTML.includes('未获取到路径'),
        schedule: !!document.querySelector('#schedule .wr-mono'),
        lastrun: !!document.querySelector('#last-run .wr-mono'),
      },
    };
  })()`)

  // 0. v0.8.0：面板服务守护卡片已下线
  check('页面不再有「面板服务守护」卡片', !(await evaluate(client, "document.body.innerText")).includes('面板服务守护'))
  check('页面不再有守护相关控件',
    !(await evaluate(client, "!!(document.querySelector('#watchdog') || document.querySelector('#btn-wd-toggle') || document.querySelector('#btn-wd-install'))")))

  // 1. 每张卡都有独立开关
  let s = await state()
  check('路径卡有自己的开关', s.labels.paths === '显示路径', JSON.stringify(s.labels))
  check('定时任务卡有自己的开关', s.labels.schedule === '显示路径', JSON.stringify(s.labels))
  check('最近一次生成有自己的开关', s.labels.lastrun === '显示路径', JSON.stringify(s.labels))
  check('默认全部隐藏', s.pathsHidden && s.schedHidden, JSON.stringify(s))
  // 开关只出现在「这块真的有路径」的地方，没有路径的块不给按钮
  for (const key of ['paths', 'schedule', 'lastrun']) {
    if (!s.visible[key] && !s.hasPath[key]) continue;
    check(`开关显隐与内容一致（${key}）`, s.visible[key] === s.hasPath[key],
      `visible=${s.visible[key]} hasPath=${s.hasPath[key]}`);
  }
  check('没有路径就不显示开关（至少验证一个无路径情形）',
    ['paths', 'schedule', 'lastrun'].some((k) => !s.visible[k] || !s.hasPath[k]) ||
    (s.visible.paths && s.hasPath.paths))

  // 3. 只开路径卡：其它卡不受影响
  await evaluate(client, "document.querySelector('[data-path-toggle=\"paths\"]').click()")
  await sleep(250)
  s = await state()
  check('路径卡可单独展开（出现真实路径）', !s.pathsHidden)
  check('路径卡按钮变「隐藏路径」', s.labels.paths === '隐藏路径', s.labels.paths)
  check('别的卡仍是隐藏（互不影响）', s.schedHidden === true && s.labels.schedule === '显示路径')

  // 4. 定时任务卡单独开
  await evaluate(client, "document.querySelector('[data-path-toggle=\"schedule\"]').click()")
  await sleep(250)
  s = await state()
  check('定时任务卡单独展开（出现启动命令）', !s.schedHidden)
  check('定时任务按钮变「隐藏路径」', s.labels.schedule === '隐藏路径', s.labels.schedule)
  check('路径卡不受影响（仍展开）', !s.pathsHidden)

  // 6. 关掉路径卡，其它保持
  await evaluate(client, "document.querySelector('[data-path-toggle=\"paths\"]').click()")
  await sleep(250)
  s = await state()
  check('关掉路径卡后只它隐藏', s.pathsHidden && !s.schedHidden)
  check('关掉的按钮文字回到「显示路径」', s.labels.paths === '显示路径', s.labels.paths)

  // 7. 历史模块：每条都有「打开目录」，工具栏有「打开周报目录」
  await evaluate(client, "document.querySelector('.wr-tab[data-tab=\"reports\"]').click()")
  await sleep(400)
  const hist = await evaluate(client, `(() => {
    const items = Array.from(document.querySelectorAll('#report-list .wr-item'));
    return {
      n: items.length,
      openBtns: items.filter((it) => it.querySelector('[data-open-dir]')).length,
      firstDir: items[0] && items[0].querySelector('[data-open-dir]') ? items[0].querySelector('[data-open-dir]').dataset.openDir : '',
      subHasDir: items[0] ? items[0].querySelector('.wr-rep__sub').textContent.indexOf(String.fromCharCode(24180)) >= 0 : false,
      rootBtn: !!document.querySelector('#btn-open-outdir'),
      rootBtnHidden: document.querySelector('#btn-open-outdir') ? document.querySelector('#btn-open-outdir').hidden : true,
      stillHasToggle: !!document.querySelector('[data-path-toggle="reports"]'),
    };
  })()`)
  check('历史不再有「显示路径」开关（没有作用，改成打开目录）', hist.stillHasToggle === false)
  check('工具栏有「打开输出目录」按钮', hist.rootBtn === true && hist.rootBtnHidden === false, JSON.stringify(hist))
  check('工具栏按钮文字是「打开输出目录」',
    (await evaluate(client, "document.querySelector('#btn-open-outdir').textContent.trim()")) === '打开输出目录')
  // 文件在子目录里 → 行内有「打开所在目录」；在根目录里 → 行内不显示（与工具栏同一个地方）
  const inRoot = hist.n > 0 && hist.openBtns === 0
  check('行内「打开所在目录」只在子目录场景出现', inRoot || hist.openBtns === hist.n, JSON.stringify(hist))
  if (!inRoot) {
    check('「打开所在目录」带的是绝对路径',
      hist.firstDir.length > 2 && hist.firstDir.charAt(1) === ':' && hist.firstDir.charAt(2) === String.fromCharCode(92), hist.firstDir)
    check('行内按钮文字是「打开所在目录」',
      (await evaluate(client, "document.querySelector('#report-list [data-open-dir]').textContent.trim()")) === '打开所在目录')
  }

  // 8. localStorage 按卡片记
  const saved = JSON.parse(await evaluate(client, "window.localStorage.getItem('wr-show-paths')"))
  check('localStorage 按卡片记状态', saved && saved.paths === false && saved.schedule === true, JSON.stringify(saved))

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

  // 9.6 没有路径就不出现开关：用 ?diag=1 暴露的渲染函数喂空数据，按钮必须跟着消失
  const noPath = await evaluate(client, `(() => {
    const b = (k) => document.querySelector('[data-path-toggle="' + k + '"]');
    const d = window.__wrDebug;
    if (!d) return { ok: false, reason: 'no debug hook' };
    const seen = {};
    d.renderSchedule({ installed: false });
    seen.scheduleWithoutPath = b('schedule').hidden;
    d.renderLastRun({ lines: [] });
    seen.lastrunWithoutPath = b('lastrun').hidden;
    d.renderPaths({});
    seen.pathsWithoutPath = b('paths').hidden;
    // 再喂回有路径的数据，按钮应该回来
    d.renderSchedule({ installed: true, target: 'x\\y.cmd', status: 'Ready', nextRun: '2026-11-16 22:00', pointsToPlugin: true });
    seen.scheduleWithPath = !b('schedule').hidden;
    d.renderLastRun({ startedAt: '2026-11-12T00:00:00Z', exitCode: 0, outPath: 'x\\周报.txt', lines: [] });
    seen.lastrunWithPath = !b('lastrun').hidden;
    d.renderPaths({ plugin: 'x\\plugin', outDir: 'x\\out' });
    seen.pathsWithPath = !b('paths').hidden;
    return seen;
  })()`)
  check('没有路径时：定时任务不给开关', noPath.scheduleWithoutPath === true, JSON.stringify(noPath))
  check('没有路径时：最近一次生成不给开关', noPath.lastrunWithoutPath === true, JSON.stringify(noPath))
  check('没有路径时：路径卡不给开关', noPath.pathsWithoutPath === true, JSON.stringify(noPath))
  check('有路径时：开关回来（定时任务 / 最近一次生成 / 路径卡）',
    noPath.scheduleWithPath && noPath.lastrunWithPath && noPath.pathsWithPath, JSON.stringify(noPath))

  // 9.65 日志区：自动滚动开关 + 跳到末尾
  const logCtl = await evaluate(client, `(() => {
    const pre = document.querySelector('#run-log');
    const auto = document.querySelector('#opt-log-auto');
    const tail = document.querySelector('#btn-log-tail');
    return {
      hasAuto: !!auto, autoChecked: auto && auto.checked, hasTail: !!tail,
      tailText: tail && tail.textContent.trim(),
    };
  })()`)
  check('日志区有「自动滚动」开关', logCtl.hasAuto === true && logCtl.autoChecked === true, JSON.stringify(logCtl))
  check('日志区有「跳到末尾」按钮', logCtl.hasTail === true && logCtl.tailText === '跳到末尾', JSON.stringify(logCtl))
  // 往日志里塞内容后：自动滚动开着 → 停在底部；关掉 → 位置不被拽到底
  const scrollCase = await evaluate(client, `(() => {
    const pre = document.querySelector('#run-log');
    const auto = document.querySelector('#opt-log-auto');
    const d = window.__wrDebug;
    if (!d) return { ok: false, reason: 'no debug hook' };
    const NL = String.fromCharCode(10);
    pre.textContent = Array.from({ length: 200 }, (_, i) => '第 ' + i + ' 行').join(NL);
    pre.scrollTop = pre.scrollHeight;
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight <= 8;
    // 往上翻
    pre.scrollTop = 0;
    const topBefore = pre.scrollTop;
    auto.checked = false;
    d.renderRun({ startedAt: '2026-11-12T00:00:00Z', exitCode: 0, running: false, lines: Array.from({ length: 260 }, (_, i) => '第 ' + i + ' 行') });
    const topAfter = pre.scrollTop;
    auto.checked = true;
    d.renderRun({ startedAt: '2026-11-12T00:00:00Z', exitCode: 0, running: false, lines: Array.from({ length: 300 }, (_, i) => '第 ' + i + ' 行') });
    const bottomAfter = pre.scrollHeight - pre.scrollTop - pre.clientHeight <= 8;
    return { ok: true, atBottom, topBefore, topAfter, bottomAfter };
  })()`)
  check('自动滚动开着时停在日志底部', scrollCase.atBottom === true, JSON.stringify(scrollCase))
  check('关掉自动滚动后不会把用户拽回底部（位置保持）', scrollCase.topAfter <= scrollCase.topBefore + 40, JSON.stringify(scrollCase))
  check('重新打开自动滚动后会跟到最新', scrollCase.bottomAfter === true, JSON.stringify(scrollCase))

  // 9.7 打开目录接口：输出目录内放行、目录外拒绝、空路径拒绝
  const openApi = await evaluate(client, `(async () => {
    const post = async (body) => {
      const r = await fetch('/api/open-dir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, data: await r.json() };
    };
    const state = await (await fetch('/api/state')).json();
    const dir = state.paths.outDir;
    const inside = state.reports.length ? state.reports[0].dirAbs : dir;
    return {
      inside: await post({ path: inside }),
      outside: await post({ path: 'C:/Windows' }),
      empty: await post({}),
    };
  })()`)
  check('open-dir：输出目录内的路径放行', openApi.inside.status === 200 && openApi.inside.data.ok === true, JSON.stringify(openApi.inside))
  check('open-dir：目录外路径被拒绝', openApi.outside.status === 400 && openApi.outside.data.ok === false, JSON.stringify(openApi.outside))
  check('open-dir：空路径被拒绝', openApi.empty.status === 400 && openApi.empty.data.ok === false, JSON.stringify(openApi.empty))

  // 10. 刷新后保持（各卡的状态各自恢复）
  await client.send('Page.reload', {})
  await sleep(2500)
  await waitReady(client)
  const after = await state()
  check('刷新后：关掉的卡仍隐藏', after.pathsHidden === true)
  check('刷新后：开着的卡仍显示', after.schedHidden === false)

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
