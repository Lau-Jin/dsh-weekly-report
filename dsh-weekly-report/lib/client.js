/**
 * 周报面板 · 浏览器半身
 *
 * 贡献一个全局主面板（weekly-report）和侧边栏入口：面板里 iframe 本地服务
 * http://127.0.0.1:8798/ ，服务负责配置读写与生成，本文件不碰任何凭据。
 */
window.__ModuleLoader__.load({
  id: 'dsh-weekly-report',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useRef, useCallback } = React

    const NS = 'weeklyReport'
    const PANEL_ID = 'weekly-report'
    const STORAGE_KEY = 'weekly-report.url'
    const DEFAULT_URL = 'http://127.0.0.1:8798/'
    const inject = ['slots', 'locale']

    const DICT = {
      zh: {
        panel: '周报',
        refresh: '刷新',
        open: '在浏览器打开',
        settings: '服务地址',
        url: '面板服务地址',
        save: '保存',
        close: '关闭',
        down: '周报面板服务没有响应',
        downTip: '正在自动重连（服务恢复后会自动刷新）；装了「面板服务守护」的话最多 2 分钟会被自动拉起。',
        retry: '重试',
        start: '启动服务',
      },
      en: {
        panel: 'Weekly report',
        refresh: 'Reload',
        open: 'Open in browser',
        settings: 'Service URL',
        url: 'Panel service URL',
        save: 'Save',
        close: 'Close',
        down: 'The weekly report service is not responding',
        downTip: 'Start it from dsh-weekly-report/service/server.cjs, then retry.',
        retry: 'Retry',
        start: 'Start service',
      },
    }

    const normalizeUrl = (value) => {
      let url = String(value || '').trim() || DEFAULT_URL
      if (!/^https?:\/\//i.test(url)) url = 'http://' + url
      if (!url.endsWith('/')) url += '/'
      return url
    }

    const readUrl = () => {
      try { return normalizeUrl(window.localStorage.getItem(STORAGE_KEY) || DEFAULT_URL) } catch { return DEFAULT_URL }
    }
    const writeUrl = (url) => {
      try { window.localStorage.setItem(STORAGE_KEY, normalizeUrl(url)) } catch { /* storage unavailable */ }
    }

    // ---------------------------------------------------------------- health
    // 探活用轻量 /api/ping（1~2 ms）；/api/state 要 spawn python 体检，慢的时候好几秒，
    // 拿它当健康检查会误判成「服务挂了」。状态点仍然是「ping 通 + 体检无 error」。
    const health = { state: 'unknown', listeners: new Set() }
    const setHealth = (next) => {
      if (health.state === next) return
      health.state = next
      health.listeners.forEach((listener) => listener(next))
    }
    const subscribeHealth = (listener) => {
      health.listeners.add(listener)
      listener(health.state)
      return () => { health.listeners.delete(listener) }
    }

    async function ping() {
      try {
        const res = await fetch(readUrl() + 'api/ping', { cache: 'no-store', signal: AbortSignal.timeout(2000) })
        return res.ok
      } catch {
        return false
      }
    }

    let badCheckedAt = 0
    let badCount = 0

    async function probe() {
      if (!(await ping())) { setHealth('down'); return }
      // 活着；顺手（最多 30 秒一次）看体检里有没有 error，决定绿点还是黄点
      if (Date.now() - badCheckedAt < 30000) { setHealth(badCount ? 'warn' : 'ok'); return }
      badCheckedAt = Date.now()
      try {
        const res = await fetch(readUrl() + 'api/state', { cache: 'no-store', signal: AbortSignal.timeout(8000) })
        const data = res.ok ? await res.json().catch(() => null) : null
        badCount = data && Array.isArray(data.checks)
          ? data.checks.filter((c) => c.level === 'error').length
          : 0
        setHealth(badCount ? 'warn' : 'ok')
      } catch {
        // 体检没拿到不代表服务挂了（ping 已经通过）
        setHealth('ok')
      }
    }

    let probeTimer = 0
    function startProbe() {
      if (probeTimer) return
      void probe()
      probeTimer = window.setInterval(probe, 20000)
    }

    function useHealth() {
      const [state, setState] = useState(health.state)
      useEffect(() => subscribeHealth(setState), [])
      return state
    }

    const CSS = `
.wr-panel { position: relative; display: flex; flex-direction: column; flex: 1 1 auto; height: 100%; min-height: 0; background: var(--dsw-alias-bg-layer-1, #fff); }
.wr-panel__frame { flex: 1 1 auto; width: 100%; border: 0; min-height: 0; background: transparent; }
.wr-panel__pill { position: absolute; right: 12px; bottom: 12px; display: flex; gap: 6px; opacity: .35; transition: opacity .15s; }
.wr-panel__pill:hover { opacity: 1; }
.wr-panel__btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-1, #e3e6ea); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-text-2, #5b6470); cursor: pointer; padding: 0; }
.wr-panel__btn:hover { color: var(--dsw-alias-brand-primary, #3b6cf6); border-color: currentColor; }
.wr-panel__down { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--dsw-alias-bg-layer-1, #fff); padding: 24px; }
.wr-panel__box { max-width: 420px; text-align: center; font: 13px/1.6 "微软雅黑", sans-serif; color: var(--dsw-alias-text-1, #1f2328); }
.wr-panel__box h4 { margin: 0 0 6px; font-size: 14px; }
.wr-panel__box p { margin: 0 0 12px; color: var(--dsw-alias-text-2, #5b6470); font-size: 12px; }
.wr-panel__row { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
.wr-panel__card { position: absolute; right: 12px; bottom: 48px; width: 280px; padding: 12px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-1, #e3e6ea); box-shadow: 0 6px 24px rgba(0,0,0,.12); font: 12px/1.5 "微软雅黑", sans-serif; }
.wr-panel__card h4 { margin: 0 0 8px; font-size: 12.5px; }
.wr-panel__card label { display: block; color: var(--dsw-alias-text-2, #5b6470); margin-bottom: 4px; }
.wr-panel__card input { width: 100%; padding: 5px 7px; font: inherit; border-radius: 6px; border: 1px solid var(--dsw-alias-border-1, #e3e6ea); background: transparent; color: inherit; }
`

    function Styles() {
      return h('style', { dangerouslySetInnerHTML: { __html: CSS } })
    }

    /** 侧边栏图标：日历 + 状态点 */
    function ReportIcon({ size = 18 }) {
      const state = useHealth()
      const color = state === 'ok' ? '#2fa84f' : state === 'warn' ? '#e0a020' : state === 'down' ? '#d64545' : '#9aa0ad'
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('rect', { x: 3.5, y: 5, width: 17, height: 15.5, rx: 2.4 }),
        h('path', { d: 'M3.5 9.5h17' }),
        h('path', { d: 'M8 3.5V6' }),
        h('path', { d: 'M16 3.5V6' }),
        h('path', { d: 'M7.5 13h4' }),
        h('path', { d: 'M7.5 16.5h7' }),
        h('circle', { cx: 19, cy: 19, r: 3.4, fill: color, stroke: 'var(--dsw-alias-bg-layer-1, #fff)', strokeWidth: 1.4 }))
    }

    function RefreshIcon() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M20 12a8 8 0 1 1-2.3-5.6' }),
        h('path', { d: 'M20 4v5h-5' }))
    }

    function ExternalIcon() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M14 4h6v6' }),
        h('path', { d: 'M20 4l-8 8' }),
        h('path', { d: 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' }))
    }

    function GearIcon() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', 'aria-hidden': 'true' },
        h('circle', { cx: 12, cy: 12, r: 3.2 }),
        h('path', { d: 'M12 3.5v2.2M12 18.3v2.2M4.9 7.8l1.9 1.1M17.2 15.1l1.9 1.1M4.9 16.2l1.9-1.1M17.2 8.9l1.9-1.1' }))
    }

    function ReportPage() {
      const t = useLocaleT()
      const [url, setUrl] = useState(readUrl())
      const [gen, setGen] = useState(0)
      const [down, setDown] = useState(false)
      const [settings, setSettings] = useState(false)
      const [draft, setDraft] = useState(readUrl())
      const frame = useRef(null)
      const timer = useRef(0)

      useEffect(() => {
        let alive = true
        let timer = 0
        let wasDown = false

        const tick = async () => {
          let ok = false
          try {
            const res = await fetch(url + 'api/ping', { cache: 'no-store', signal: AbortSignal.timeout(2000) })
            ok = res.ok
          } catch { ok = false }
          if (!alive) return
          setDown(!ok)
          if (ok && wasDown) {
            wasDown = false
            setGen((n) => n + 1)          // 服务回来了 → 自动把 iframe 刷成正常页面
          } else if (!ok) {
            wasDown = true
          }
          // 活着 20 秒探一次；挂了 3 秒探一次，恢复得快
          timer = window.setTimeout(tick, ok ? 20000 : 3000)
        }

        void tick()
        return () => { alive = false; if (timer) window.clearTimeout(timer) }
      }, [url])

      const applyUrl = useCallback((next) => {
        const target = normalizeUrl(next)
        writeUrl(target)
        setUrl(target)
        setSettings(false)
        setGen((n) => n + 1)
      }, [])

      return h('div', { className: 'wr-panel' },
        h(Styles),
        h('iframe', {
          key: url + ':' + gen,
          ref: frame,
          className: 'wr-panel__frame',
          src: url,
          title: t('panel'),
          referrerPolicy: 'no-referrer',
        }),
        down ? h('div', { className: 'wr-panel__down' },
          h('div', { className: 'wr-panel__box' },
            h('h4', null, t('down')),
            h('p', null, t('downTip')),
            h('div', { className: 'wr-panel__row' },
              h('button', {
                type: 'button', className: 'wr-panel__btn', style: { width: 'auto', padding: '0 12px' },
                onClick: () => setGen((n) => n + 1),
              }, t('retry')),
              h('button', {
                type: 'button', className: 'wr-panel__btn', style: { width: 'auto', padding: '0 12px' },
                onClick: () => setSettings((v) => !v),
              }, t('settings'))))) : null,
        settings ? h('div', { className: 'wr-panel__card' },
          h('h4', null, t('settings')),
          h('label', { htmlFor: 'wr-url' }, t('url')),
          h('input', {
            id: 'wr-url', value: draft, spellCheck: false,
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') applyUrl(draft) },
          }),
          h('div', { className: 'wr-panel__row', style: { marginTop: 10 } },
            h('button', { type: 'button', className: 'wr-panel__btn', style: { width: 'auto', padding: '0 10px' }, onClick: () => setSettings(false) }, t('close')),
            h('button', { type: 'button', className: 'wr-panel__btn', style: { width: 'auto', padding: '0 10px' }, onClick: () => applyUrl(draft) }, t('save')))) : null,
        h('div', { className: 'wr-panel__pill' },
          h('button', { type: 'button', className: 'wr-panel__btn', title: t('refresh'), onClick: () => setGen((n) => n + 1) }, h(RefreshIcon, null)),
          h('button', { type: 'button', className: 'wr-panel__btn', title: t('open'), onClick: () => window.open(url, '_blank', 'noopener') }, h(ExternalIcon, null)),
          h('button', { type: 'button', className: 'wr-panel__btn', title: t('settings'), onClick: () => setSettings((v) => !v) }, h(GearIcon, null))))
    }

    function useLocaleT() {
      // ctx.locale.bind 在 apply 里拿到；页面组件通过闭包共享
      return useLocaleT.bound || ((key) => key)
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), 'weekly-report: dictionaries')
      const t = ctx.locale.bind(NS)
      useLocaleT.bound = t
      startProbe()

      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, ReportPage)
      })

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 45,
        label: () => t('panel'),
        locale: NS,
      }, ReportIcon))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'weekly-report'
    return module.exports
  },
})
