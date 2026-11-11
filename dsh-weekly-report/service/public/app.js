/* 周报面板前端逻辑：无框架，纯 DOM。所有接口与 server.cjs 对齐。 */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  data: null,
  pollTimer: 0,
  runTimer: 0,
  elapsedTimer: 0,
  noteLevel: 'all',
  reportQuery: '',
  dirty: false,
};

/* ---------------------------------------------------------------- 基础 */
function toast(msg, kind) {
  let el = $('.wr-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'wr-toast';
    document.body.appendChild(el);
  }
  el.className = 'wr-toast show' + (kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : '');
  el.textContent = msg;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

async function api(path, options) {
  const res = await fetch(path, Object.assign({ cache: 'no-store' }, options || {}));
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { error: text.slice(0, 300) }; }
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

const post = (path, body) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const fmtSize = (n) => (n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B');

/* ---------------------------------------------------------------- 路径显示开关 */
// 每张卡片各自一个开关（路径卡 / 定时任务 / 面板服务守护 / 最近一次生成 / 历史），
// 默认全藏；各自独立、各自记得住，互不影响。
const PATH_KEYS = ['paths', 'schedule', 'watchdog', 'lastrun', 'reports'];
const pathShown = { paths: false, schedule: false, watchdog: false, lastrun: false, reports: false };
try {
  const saved = JSON.parse(window.localStorage.getItem('wr-show-paths') || '{}');
  if (saved && typeof saved === 'object') {
    PATH_KEYS.forEach((k) => { pathShown[k] = saved[k] === true; });
  }
} catch (e) { /* 无 localStorage / 旧格式 */ }

const PATH_HIDDEN = '<span class="wr-muted">•••• 已隐藏</span>';

function pathText(value, key) {
  if (!value) return '—';
  return pathShown[key] ? esc(value) : PATH_HIDDEN;
}

function pathBlock(value, key) {
  if (!value) return '—';
  return `<div class="wr-mono" style="font-size:11px;color:var(--fg-3);margin-top:7px;word-break:break-all">${pathText(value, key)}</div>`;
}

function savePathMode() {
  try { window.localStorage.setItem('wr-show-paths', JSON.stringify(pathShown)); } catch (e) { /* ignore */ }
}

function syncPathToggles() {
  $$('[data-path-toggle]').forEach((b) => {
    const key = b.dataset.pathToggle;
    b.textContent = pathShown[key] ? '隐藏路径' : '显示路径';
    b.title = pathShown[key] ? '收起这张卡片里的路径' : '显示这张卡片里的路径';
  });
}

/* ---------------------------------------------------------------- 渲染：顶栏 */
function renderStatus(checks, migratedFrom) {
  const el = $('#status');
  const errs = checks.filter((c) => c.level === 'error');
  const warns = checks.filter((c) => c.level === 'warn');
  el.className = 'wr-status' + (errs.length ? ' err' : warns.length ? ' warn' : ' ok');
  el.textContent = errs.length
    ? `${errs[0].label}需要处理`
    : warns.length
      ? `${warns.length} 项提醒`
      : '运行正常';
  el.title = migratedFrom ? `配置迁移自：${migratedFrom}` : '';
}

/* ---------------------------------------------------------------- 渲染：概览 */
function renderChecks(checks) {
  const box = $('#checks');
  box.innerHTML = checks.map((c) => `
    <div class="wr-check ${esc(c.level || 'info')}">
      <span class="wr-check__mark">${c.level === 'ok' ? '✓' : c.level === 'error' ? '!' : c.level === 'warn' ? '!' : 'i'}</span>
      <span class="wr-check__main">
        <span class="wr-check__label">${esc(c.label)}</span>
        <span class="wr-check__detail">${esc(c.detail)}</span>
      </span>
    </div>`).join('');
  const okN = checks.filter((c) => c.level === 'ok').length;
  $('#checks-hint').textContent = `${okN}/${checks.length} 项正常`;
}

function renderPaths(paths) {
  const rows = [
    ['插件目录', paths.plugin],
    ['生成引擎', paths.engine || paths.script],
    ['配置文件', paths.config],
    ['API Key', paths.key],
    ['输出目录', paths.outDir],
  ].filter(([, v]) => v);
  if (!pathShown.paths) {
    $('#paths').innerHTML = `<dt>路径</dt>
      <dd><span class="wr-muted">•••• 已隐藏（点这张卡右上角的「显示路径」查看）</span></dd>`;
    return;
  }
  $('#paths').innerHTML = rows.map(([k, v]) => `
    <dt>${esc(k)}</dt>
    <dd><span>${esc(v)}</span>
      <button class="wr-minibtn" data-copy="${esc(v)}" type="button" style="margin-left:6px">复制</button>
    </dd>`).join('');
}

function renderSchedule(s) {
  const box = $('#schedule');
  const hint = $('#sched-hint');
  if (!s || s.pending) {
    box.innerHTML = '<span class="wr-muted">查询中…（后台在问 Windows 计划任务）</span>';
    if (hint) hint.textContent = '';
    return;
  }
  if (!s.installed) {
    box.innerHTML = '<span class="wr-muted">未登记（不登记也能在面板里手动生成）</span>';
    hint.textContent = '';
    return;
  }
  const chips = [];
  if (s.status) chips.push(`<span class="wr-chip">${esc(s.status)}</span>`);
  if (s.nextRun) chips.push(`<span class="wr-chip">下次 ${esc(s.nextRun)}</span>`);
  chips.push(s.pointsToPlugin
    ? '<span class="wr-chip wr-chip--ok">已接管</span>'
    : '<span class="wr-chip wr-chip--warn">未接管</span>');
  box.innerHTML = `<div class="wr-chips">${chips.join('')}</div>` + pathBlock(s.target, 'schedule');
  hint.textContent = '';
}

function renderWatchdog(wd) {
  const box = $('#watchdog');
  const hint = $('#wd-hint');
  if (!box) return;
  if (!wd || wd.pending) {
    box.innerHTML = '<span class="wr-muted">查询中…</span>';
    if (hint) hint.textContent = '';
    return;
  }
  if (!wd.installed) {
    box.innerHTML = '<span class="wr-muted">未装守护（服务挂了只能靠 DSH 宿主 20 秒心跳拉起）</span>';
    if (hint) hint.textContent = '';
    return;
  }
  const chips = [];
  if (wd.state) chips.push(`<span class="wr-chip">${esc(wd.state)}</span>`);
  if (wd.next) chips.push(`<span class="wr-chip">下次 ${esc(wd.next)}</span>`);
  chips.push('<span class="wr-chip wr-chip--ok">每 2 分钟探活</span>');
  box.innerHTML = `<div class="wr-chips">${chips.join('')}</div>` + pathBlock(wd.target, 'watchdog');
  if (hint) hint.textContent = '';
}

function renderLastRun(run) {
  const box = $('#last-run');
  const hint = $('#lastrun-hint');
  if (!run || (!run.startedAt && !(run.lines || []).length)) {
    box.innerHTML = '<span class="wr-muted">尚未生成</span>';
    hint.textContent = '';
    return;
  }
  const okRun = run.exitCode === 0;
  const chips = [
    run.running
      ? '<span class="wr-chip wr-chip--warn">进行中</span>'
      : okRun
        ? '<span class="wr-chip wr-chip--ok">成功</span>'
        : `<span class="wr-chip wr-chip--err">失败 ${esc(run.exitCode)}</span>`,
    `<span class="wr-chip">${esc(fmtTime(run.finishedAt || run.startedAt))}</span>`,
  ];
  box.innerHTML = `<div class="wr-chips">${chips.join('')}</div>` +
    (run.outPath ? pathBlock(run.outPath, 'lastrun') : '') +
    (run.error
      ? `<div style="color:var(--err);font-size:11.5px;margin-top:5px">${esc(run.error)}</div>`
      : '');
  hint.textContent = '';
}

/* ---------------------------------------------------------------- 渲染：表单 */
function fillConfig(cfg, keyInfo) {
  const set = (id, v) => { const el = $(id); if (el) el.value = v == null ? '' : v; };
  set('#mcp-url', cfg.mcp_url);
  set('#handler', cfg.handler);
  set('#out-dir', cfg.out_dir === '../data/reports' ? '' : cfg.out_dir);
  set('#folder', cfg.folder);

  const t = Number(cfg.threshold) || 0.85;
  set('#threshold', t);
  const range = $('#threshold-range');
  if (range) range.value = t;
  $('#threshold-hint').textContent = t.toFixed(2);

  const n = cfg.notify || {};
  const s = n.smtp || {};
  $('#notify-enabled').checked = !!n.enabled;
  set('#smtp-host', s.host);
  set('#smtp-port', s.port);
  set('#smtp-user', s.user);
  set('#smtp-to', (s.to || []).join(', '));
  $('#smtp-pass').value = '';
  $('#pass-hint').textContent = s.password ? `已保存 ${s.password}` : '未设置';
  $('#key-hint').textContent = keyInfo && keyInfo.present ? `${keyInfo.masked}` : '未配置';
  $('#api-key').value = '';
  setDirty(false);
}

function setDirty(v) {
  state.dirty = !!v;
  $('#dirty').hidden = !state.dirty;
}

/* ---------------------------------------------------------------- 渲染：历史 */
function renderReports(reports) {
  const box = $('#report-list');
  const q = state.reportQuery.trim().toLowerCase();
  const list = q ? reports.filter((r) => r.name.toLowerCase().includes(q)) : reports;
  $('#report-hint').textContent = `${list.length} / ${reports.length} 份`;
  if (!list.length) {
    box.innerHTML = `<div class="wr-empty">${reports.length ? '没有匹配的文件' : '还没生成过周报'}</div>`;
    return;
  }
  box.innerHTML = list.map((r, i) => `
    <div class="wr-item" data-report-index="${i}">
      <div class="wr-rep">
        <div style="min-width:0;flex:1 1 auto">
          <div class="wr-rep__name">${esc(r.name)}</div>
          <div class="wr-rep__sub">${pathShown.reports ? esc(r.dir) : '路径已隐藏'} · ${r.entries} 条 · ${fmtSize(r.size)} · ${esc(fmtTime(r.mtime))}</div>
        </div>
        <button class="wr-btn" data-view="${esc(r.path)}">查看</button>
      </div>
    </div>`).join('');
  box._items = list;
}

async function openReport(path, name) {
  try {
    const data = await api('/api/report?path=' + encodeURIComponent(path));
    $('#report-view-title').textContent = name || '内容';
    $('#report-view').textContent = data.text;
    $('#report-view-wrap').hidden = false;
    $('#report-view-wrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    toast('读取失败：' + e.message, 'err');
  }
}

/* ---------------------------------------------------------------- 渲染：注意事项 */
function renderNotes(notes) {
  const box = $('#notes-list');
  state.notes = notes || [];
  $('#notes-badge').textContent = String(state.notes.length);
  const list = state.noteLevel === 'all'
    ? state.notes
    : state.notes.filter((n) => n.level === state.noteLevel);
  if (!list.length) {
    box.innerHTML = '<div class="wr-empty">没有这一类注意事项</div>';
    return;
  }
  box.innerHTML = list.map((n) => `
    <div class="wr-item wr-item--${esc(n.level || 'info')}">
      <div class="wr-item__head">
        <span class="wr-item__title">${esc(n.title)}</span>
        <span class="wr-item__meta">${n.level === 'warn' ? '注意' : n.level === 'danger' ? '重要' : '规则'}</span>
      </div>
      <div class="wr-item__text">${esc(n.text)}</div>
    </div>`).join('');
}

/* ---------------------------------------------------------------- 渲染：运行 */
function setLogState(run) {
  const dot = $('#log-dot');
  const text = $('#log-state');
  if (!run || (!run.startedAt && !(run.lines || []).length)) {
    dot.className = 'wr-logbar__dot';
    text.textContent = '等待生成';
    return;
  }
  if (run.running) {
    dot.className = 'wr-logbar__dot running';
    const secs = run.startedAt ? Math.max(0, Math.round((Date.now() - new Date(run.startedAt)) / 1000)) : 0;
    text.textContent = `生成中… 已用 ${Math.floor(secs / 60)}分${secs % 60}秒`;
    return;
  }
  dot.className = 'wr-logbar__dot ' + (run.exitCode === 0 ? 'ok' : 'err');
  text.textContent = run.exitCode === 0 ? '生成完成' : `已结束（退出码 ${run.exitCode}）`;
}

function renderRun(run) {
  const running = !!(run && run.running);
  $('#btn-run').disabled = running;
  $('#btn-cancel').disabled = !running;
  $('#run-hint').textContent = running
    ? '约 1~3 分钟，期间别重复点'
    : run && run.exitCode === 0
      ? '上次生成成功'
      : run && run.exitCode != null
        ? `上次退出码 ${run.exitCode}`
        : '';
  if (run && run.lines && run.lines.length) {
    const pre = $('#run-log');
    pre.textContent = run.lines.join('\n');
    pre.scrollTop = pre.scrollHeight;
  }
  setLogState(run);

  clearInterval(state.elapsedTimer);
  if (running) {
    state.elapsedTimer = setInterval(() => setLogState(run), 1000);
  }
}

function applyState(data) {
  state.data = data;
  renderStatus(data.checks || [], data.migratedFrom);
  renderChecks(data.checks || []);
  renderPaths(data.paths || {});
  renderSchedule(data.schedule);
  renderWatchdog(data.watchdog);
  renderLastRun(data.run);
  renderNotes(data.notes || []);
  renderReports(data.reports || []);
  fillConfig(data.config || {}, data.key);
  renderRun(data.run);
}

/* ---------------------------------------------------------------- 轮询 */
async function refresh(force) {
  try {
    const data = await api('/api/state' + (force ? '?force=1' : ''));
    applyState(data);
    return data;
  } catch (e) {
    const el = $('#status');
    el.className = 'wr-status err';
    el.textContent = '服务未响应';
    return null;
  }
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(() => {
    if (document.hidden) return;
    refresh(false);
  }, 15000);
}

function pollRun() {
  clearInterval(state.runTimer);
  state.runTimer = setInterval(async () => {
    try {
      const run = await api('/api/run');
      renderRun(run);
      if (!run.running) {
        clearInterval(state.runTimer);
        state.runTimer = 0;
        await refresh(true);
        toast(run.exitCode === 0 ? '生成完成' : '生成结束（有错误）', run.exitCode === 0 ? 'ok' : 'err');
      }
    } catch (_) {
      clearInterval(state.runTimer);
      state.runTimer = 0;
    }
  }, 1500);
}

/* ---------------------------------------------------------------- 交互 */
function bindTabs() {
  $$('.wr-tab').forEach((btn) => {
    btn.onclick = () => {
      $$('.wr-tab').forEach((b) => b.classList.toggle('is-active', b === btn));
      $$('.wr-pane').forEach((p) => p.classList.toggle('is-active', p.dataset.pane === btn.dataset.tab));
      try { history.replaceState(null, '', '?tab=' + btn.dataset.tab); } catch { /* ignore */ }
    };
  });
}

/** 支持 ?tab=config 直接打开某个页签（也方便截图/排查） */
function applyTabFromUrl() {
  const want = new URLSearchParams(location.search).get('tab');
  if (!want) return;
  const btn = $$('.wr-tab').find((b) => b.dataset.tab === want);
  if (!btn) return;
  $$('.wr-tab').forEach((b) => b.classList.toggle('is-active', b === btn));
  $$('.wr-pane').forEach((p) => p.classList.toggle('is-active', p.dataset.pane === want));
}

function bindPeriodSeg() {
  $$('#period-seg button').forEach((b) => {
    b.onclick = () => {
      $$('#period-seg button').forEach((x) => x.classList.toggle('is-active', x === b));
      $('#period').value = b.dataset.period;
      $('#range-wrap').hidden = b.dataset.period !== 'range';
    };
  });
}

function bindNoteFilter() {
  $$('#note-filter button').forEach((b) => {
    b.onclick = () => {
      $$('#note-filter button').forEach((x) => x.classList.toggle('is-active', x === b));
      state.noteLevel = b.dataset.level;
      renderNotes(state.notes || []);
    };
  });
}

function bindConfigDirty() {
  const ids = ['#mcp-url', '#handler', '#threshold', '#out-dir', '#folder', '#smtp-host',
    '#smtp-port', '#smtp-user', '#smtp-pass', '#smtp-to'];
  ids.forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('input', () => setDirty(true));
  });
  $('#notify-enabled').addEventListener('change', () => setDirty(true));

  // 阈值滑块与数字互相同步
  const range = $('#threshold-range');
  const num = $('#threshold');
  range.addEventListener('input', () => {
    num.value = Number(range.value).toFixed(2);
    $('#threshold-hint').textContent = Number(range.value).toFixed(2);
    setDirty(true);
  });
  num.addEventListener('input', () => {
    const v = Math.min(1, Math.max(0, Number(num.value) || 0));
    range.value = v;
    $('#threshold-hint').textContent = v.toFixed(2);
  });
}

function bindRevealButtons() {
  $$('[data-toggle]').forEach((btn) => {
    btn.onclick = () => {
      const el = $(btn.dataset.toggle);
      if (!el) return;
      const show = el.type === 'password';
      el.type = show ? 'text' : 'password';
      btn.textContent = show ? '隐藏' : '显示';
      btn.classList.toggle('is-on', show);
    };
  });
}

function bindCopyButtons() {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const text = btn.dataset.copy;
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制', 'ok');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('已复制', 'ok'); } catch { toast('复制失败', 'err'); }
      ta.remove();
    }
  });
}

function bindActions() {
  $('#btn-refresh').onclick = async () => { await refresh(true); toast('已刷新', 'ok'); };
  $('#btn-open').onclick = () => window.open(location.href, '_blank', 'noopener');

  $('#btn-save-key').onclick = async () => {
    const key = $('#api-key').value.trim();
    if (!key) { toast('请先粘贴 API Key', 'err'); $('#api-key').focus(); return; }
    try {
      await post('/api/api-key', { key });
      toast('API Key 已保存', 'ok');
      await refresh(true);
    } catch (e) { toast('保存失败：' + e.message, 'err'); }
  };
  $('#api-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-save-key').click(); });

  $('#btn-test-key').onclick = async () => {
    const btn = $('#btn-test-key');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '测试中…';
    try {
      const r = await post('/api/test-key', { key: $('#api-key').value.trim() });
      if (r.ok) toast(`${r.detail}（${r.ms}ms）`, 'ok');
      else toast('Key 不可用：' + (r.error || '未知错误'), 'err');
    } catch (e) {
      toast('测试失败：' + e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };

  $('#btn-save-config').onclick = async () => {
    const to = $('#smtp-to').value.split(/[,，;；\s]+/).filter(Boolean);
    const pass = $('#smtp-pass').value;
    const smtp = {
      host: $('#smtp-host').value.trim(),
      port: Number($('#smtp-port').value) || 465,
      ssl: true,
      starttls: false,
      user: $('#smtp-user').value.trim(),
      to,
    };
    if (pass) smtp.password = pass;
    const body = {
      mcp_url: $('#mcp-url').value.trim(),
      handler: $('#handler').value.trim(),
      threshold: Number($('#threshold').value) || 0.85,
      out_dir: $('#out-dir').value.trim(),
      folder: $('#folder').value.trim(),
      notify: { enabled: $('#notify-enabled').checked, smtp },
    };
    try {
      await post('/api/config', body);
      toast('配置已保存', 'ok');
      setDirty(false);
      await refresh(true);
    } catch (e) { toast('保存失败：' + e.message, 'err'); }
  };

  $('#btn-test-mail').onclick = async () => {
    const pre = $('#test-out');
    pre.hidden = false;
    pre.textContent = '正在试运行（不发信），约 1~2 分钟…';
    try {
      const r = await post('/api/test-mail', {});
      pre.textContent = r.out || '(无输出)';
      toast(r.ok ? '试运行通过' : '试运行有错误', r.ok ? 'ok' : 'err');
    } catch (e) {
      pre.textContent = '失败：' + e.message;
      toast('试运行失败', 'err');
    }
  };

  $('#btn-run').onclick = async () => {
    const body = {
      period: $('#period').value,
      perfAuto: $('#opt-perf').checked,
      dryRun: $('#opt-dry').checked,
      noTasks: $('#opt-notasks').checked,
    };
    if (body.period === 'range') {
      body.start = $('#start').value;
      body.end = $('#end').value;
      if (!body.start || !body.end) { toast('请选择起止日期', 'err'); return; }
    }
    try {
      await post('/api/run', body);
      $('#run-log').textContent = '已启动，等待输出…';
      pollRun();
      toast('已开始生成', 'ok');
    } catch (e) { toast('启动失败：' + e.message, 'err'); }
  };

  $('#btn-cancel').onclick = async () => {
    try { await post('/api/run/cancel', {}); toast('已请求终止'); } catch (e) { toast(e.message, 'err'); }
  };

  $('#btn-clear-log').onclick = () => {
    const pre = $('#run-log');
    pre.textContent = '（已清空，这里只清显示）';
    pre.dataset.cleared = '1';
  };

  $('#btn-wd-install').onclick = async () => {
    const btn = $('#btn-wd-install');
    btn.disabled = true;
    try {
      const r = await post('/api/watchdog', { action: 'install' });
      toast(r.ok ? '守护已装好：每 2 分钟探活' : '装守护失败', r.ok ? 'ok' : 'err');
      await refresh(true);
    } catch (e) { toast('失败：' + e.message, 'err'); } finally { btn.disabled = false; }
  };

  $('#btn-wd-remove').onclick = async () => {
    if (!confirm('移除面板服务守护？之后服务挂了只能靠 DSH 宿主心跳拉起。')) return;
    try {
      const r = await post('/api/watchdog', { action: 'remove' });
      toast(r.ok ? '守护已移除' : '移除失败', r.ok ? 'ok' : 'err');
      await refresh(true);
    } catch (e) { toast('失败：' + e.message, 'err'); }
  };

  $('#btn-wd-toggle').onclick = () => {
    const body = $('#wd-body');
    const btn = $('#btn-wd-toggle');
    const open = body.hidden;
    body.hidden = !open;
    btn.textContent = open ? '收起' : '展开';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  // 路径开关：每张卡各管各的，只刷新自己那一块
  $$('[data-path-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.pathToggle;
      pathShown[key] = !pathShown[key];
      savePathMode();
      syncPathToggles();
      const d = state.data;
      if (!d) return;
      if (key === 'paths') renderPaths(d.paths || {});
      else if (key === 'schedule') renderSchedule(d.schedule);
      else if (key === 'watchdog') renderWatchdog(d.watchdog);
      else if (key === 'lastrun') renderLastRun(d.run);
      else if (key === 'reports') renderReports(d.reports || []);
    });
  });
  syncPathToggles();

  $('#btn-sched-install').onclick = async () => {
    if (!confirm('将创建/覆盖 Windows 计划任务「周报自动生成」：每周日 22:00 自动生成周报并发送通知。继续？')) return;
    try {
      const r = await post('/api/schedule', { action: 'install' });
      toast(r.ok ? '定时任务已登记' : '登记失败', r.ok ? 'ok' : 'err');
      await refresh(true);
    } catch (e) { toast('失败：' + e.message, 'err'); }
  };

  // 绩效表核对：对照本月各周周报，缺的事项自动补进当月表
  $('#btn-perf-check').onclick = async () => {
    const pre = $('#perf-check-out');
    const st = $('#perf-check-state');
    const btn = $('#btn-perf-check');
    pre.hidden = false;
    pre.textContent = '正在核对：读本月各周周报，逐条比对当月绩效表…';
    st.textContent = '';
    btn.disabled = true;
    try {
      const r = await post('/api/perf-check', {});
      pre.textContent = r.out || '(无输出)';
      st.textContent = r.ok ? '通过' : '有需要看的项';
      toast(r.ok ? '绩效表核对通过' : '绩效表核对有提示，看下面的报告', r.ok ? 'ok' : 'err');
    } catch (e) {
      pre.textContent = '失败：' + e.message;
      toast('核对失败', 'err');
    } finally {
      btn.disabled = false;
    }
  };

  $('#btn-sched-remove').onclick = async () => {
    if (!confirm('删除计划任务「周报自动生成」？之后只能手动生成。')) return;
    try {
      const r = await post('/api/schedule', { action: 'remove' });
      toast(r.ok ? '已移除' : '移除失败', r.ok ? 'ok' : 'err');
      await refresh(true);
    } catch (e) { toast('失败：' + e.message, 'err'); }
  };

  $('#btn-reload-reports').onclick = async () => {
    try {
      const d = await api('/api/reports');
      renderReports(d.reports || []);
      toast('已重新扫描', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  $('#report-search').addEventListener('input', (e) => {
    state.reportQuery = e.target.value;
    renderReports((state.data && state.data.reports) || []);
  });

  $('#report-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    const list = $('#report-list')._items || [];
    const hit = list.find((r) => r.path === btn.dataset.view);
    openReport(btn.dataset.view, hit && hit.name);
  });

  $('#btn-close-report').onclick = () => { $('#report-view-wrap').hidden = true; };

  // 概览快捷操作
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-quick]');
    if (!btn) return;
    const kind = btn.dataset.quick;
    if (kind === 'reports') {
      $$('.wr-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === 'reports'));
      $$('.wr-pane').forEach((p) => p.classList.toggle('is-active', p.dataset.pane === 'reports'));
      return;
    }
    $$('.wr-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === 'run'));
    $$('.wr-pane').forEach((p) => p.classList.toggle('is-active', p.dataset.pane === 'run'));
    $$('#period-seg button').forEach((b) => b.classList.toggle('is-active', b.dataset.period === 'current'));
    $('#period').value = 'current';
    $('#range-wrap').hidden = true;
    $('#opt-dry').checked = kind === 'run-dry';
    setTimeout(() => $('#btn-run').click(), 60);
  });
}

/* ---------------------------------------------------------------- 目录选择器 */
const fsPicker = {
  target: null,    // 结果写回哪个输入框
  current: '',     // 当前所在目录
  parent: null,
  selected: '',    // 列表中选中的子目录（空=选当前目录）
};

const FOLDER_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.6 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H4.5A1.5 1.5 0 0 1 3 17.5z"/></svg>';
const CHEV_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

/** 把绝对路径切成可点击的面包屑 */
function buildCrumbs(full) {
  const norm = String(full || '').replace(/\//g, '\\');
  const out = [];
  const drive = /^([A-Za-z]:)\\?(.*)$/.exec(norm);
  if (drive) {
    out.push({ label: drive[1] + '\\', path: drive[1] + '\\' });
    let acc = drive[1] + '\\';
    for (const seg of drive[2].split('\\').filter(Boolean)) {
      acc = acc.endsWith('\\') ? acc + seg : acc + '\\' + seg;
      out.push({ label: seg, path: acc });
    }
    return out;
  }
  out.push({ label: '/', path: '/' });
  let acc = '';
  for (const seg of norm.split('\\').filter(Boolean)) {
    acc += '/' + seg;
    out.push({ label: seg, path: acc });
  }
  return out;
}

function updatePickedLabel() {
  const willPick = fsPicker.selected || fsPicker.current;
  $('#fs-picked').textContent = willPick || '—';
  $('#fs-picked').title = willPick || '';
}

function markSelected(path) {
  fsPicker.selected = path || '';
  $$('#fs-list .wr-fs-item').forEach((el) => {
    el.classList.toggle('is-selected', el.dataset.fsDir === fsPicker.selected);
  });
  updatePickedLabel();
}

function openFsPicker(selector) {
  fsPicker.target = selector;
  fsPicker.selected = '';
  const input = $(selector);
  const start = (input && input.value.trim()) || '';
  $('#fs-modal').hidden = false;
  $('#fs-newname').value = '';
  $('#fs-pathrow').hidden = true;
  $('#fs-title').textContent = selector === '#out-dir' ? '选择周报输出目录' : '选择绩效表目录';
  loadFsDir(start);
}

function closeFsPicker() {
  $('#fs-modal').hidden = true;
  fsPicker.target = null;
  fsPicker.selected = '';
}

async function loadFsDir(p) {
  const list = $('#fs-list');
  list.innerHTML = '<div class="wr-fs-loading"><span class="wr-spinner"></span>读取中…</div>';
  fsPicker.selected = '';
  try {
    const d = await api('/api/fs' + (p ? '?path=' + encodeURIComponent(p) : ''));
    if (!d.ok) {
      list.innerHTML = `<div class="wr-fs-empty">${esc(d.error || '无法读取该目录')}</div>`;
      $('#fs-picked').textContent = d.path || '—';
      return;
    }
    fsPicker.current = d.path;
    fsPicker.parent = d.parent;
    $('#fs-up').disabled = !d.parent;

    // 面包屑
    const crumbs = buildCrumbs(d.path);
    $('#fs-crumbs').innerHTML = crumbs.map((c, i) => {
      const last = i === crumbs.length - 1;
      return (i ? '<span class="wr-crumb__sep">›</span>' : '') +
        `<button type="button" class="wr-crumb${last ? ' is-last' : ''}" data-fs-go="${esc(c.path)}">${esc(c.label)}</button>`;
    }).join('');

    // 快捷入口
    $('#fs-shortcuts').innerHTML = (d.shortcuts || []).map((s) =>
      `<button class="wr-chip" type="button" data-fs-go="${esc(s.path)}" title="${esc(s.path)}">${esc(s.label)}</button>`
    ).join('');

    // 盘符
    const curRoot = (d.path.match(/^[A-Za-z]:\\/) || [''])[0];
    $('#fs-drives').innerHTML = (d.drives || []).map((dr) =>
      `<button class="wr-chip${dr === curRoot ? ' is-active' : ''}" type="button" data-fs-go="${esc(dr)}">${esc(dr)}</button>`
    ).join('');

    // 子目录
    if (!d.dirs.length) {
      list.innerHTML = '<div class="wr-fs-empty">这个文件夹里没有子文件夹<br>可以直接「选此文件夹」</div>';
    } else {
      list.innerHTML = d.dirs.map((it) => `
        <div class="wr-fs-item" data-fs-dir="${esc(it.path)}" title="${esc(it.path)}">
          <span class="wr-fs-item__icon">${FOLDER_SVG}</span>
          <span class="wr-fs-item__name">${esc(it.name)}</span>
          <span class="wr-fs-item__chev">${CHEV_SVG}</span>
        </div>`).join('');
    }
    updatePickedLabel();
  } catch (e) {
    list.innerHTML = `<div class="wr-fs-empty">${esc(e.message)}</div>`;
  }
}

async function makeFsDir() {
  const name = $('#fs-newname').value.trim();
  if (!name) { toast('请先输入文件夹名称', 'err'); $('#fs-newname').focus(); return; }
  try {
    const r = await post('/api/fs/mkdir', { parent: fsPicker.current, name });
    if (!r.ok) { toast('新建失败：' + (r.error || ''), 'err'); return; }
    toast('已创建并进入', 'ok');
    $('#fs-newname').value = '';
    loadFsDir(r.path);
  } catch (e) { toast('新建失败：' + e.message, 'err'); }
}

function bindFsPicker() {
  document.addEventListener('click', (e) => {
    const browse = e.target.closest('[data-browse]');
    if (browse) { openFsPicker(browse.dataset.browse); return; }
    if (e.target.closest('[data-fs-close]')) { closeFsPicker(); return; }

    const go = e.target.closest('[data-fs-go]');
    if (go) { loadFsDir(go.dataset.fsGo); return; }

    const item = e.target.closest('[data-fs-dir]');
    if (item) { markSelected(item.dataset.fsDir); return; }
  });

  // 双击进入目录
  $('#fs-list').addEventListener('dblclick', (e) => {
    const item = e.target.closest('[data-fs-dir]');
    if (item) loadFsDir(item.dataset.fsDir);
  });

  $('#fs-up').onclick = () => { if (fsPicker.parent) loadFsDir(fsPicker.parent); };
  $('#fs-go').onclick = () => loadFsDir($('#fs-path').value.trim());
  $('#fs-edit-path').onclick = () => {
    const row = $('#fs-pathrow');
    row.hidden = !row.hidden;
    if (!row.hidden) {
      $('#fs-path').value = fsPicker.current || '';
      $('#fs-path').focus();
      $('#fs-path').select();
    }
  };
  $('#fs-path').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      loadFsDir($('#fs-path').value.trim());
      $('#fs-pathrow').hidden = true;
    }
  });
  $('#fs-mkdir').onclick = makeFsDir;
  $('#fs-newname').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); makeFsDir(); }
  });
  $('#fs-pick').onclick = () => {
    if (!fsPicker.target) return;
    const value = fsPicker.selected || fsPicker.current;
    if (!value) return;
    $(fsPicker.target).value = value;
    setDirty(true);
    closeFsPicker();
    toast('已选择：' + value, 'ok');
  };

  document.addEventListener('keydown', (e) => {
    if ($('#fs-modal').hidden) return;
    if (e.key === 'Escape') { closeFsPicker(); return; }
    if (e.key === 'Backspace' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      if (fsPicker.parent) loadFsDir(fsPicker.parent);
    }
  });
}

/* ---------------------------------------------------------------- 启动 */
function runLayoutDiag() {
  // 开发用：?diag=1 时把各表单控件的计算样式打到页面上，方便核对一致性
  const panes = $$('.wr-pane');
  panes.forEach((p) => { p.style.display = 'block'; });
  const rangeWrap = $('#range-wrap');
  const rangeWasHidden = rangeWrap ? rangeWrap.hidden : false;
  if (rangeWrap) rangeWrap.hidden = false;
  const rows = [];
  $$('input, select, textarea').forEach((el) => {
    if (el.type === 'hidden') return;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width <= 0 || r.height <= 0) return;
    rows.push({
      id: el.id || '(no-id)',
      type: el.type || el.tagName.toLowerCase(),
      h: Math.round(r.height),
      w: Math.round(r.width),
      border: cs.borderTopWidth + ' ' + cs.borderTopColor,
      radius: cs.borderTopLeftRadius,
      padL: cs.paddingLeft,
      font: cs.fontSize,
      bg: cs.backgroundColor,
    });
  });
  panes.forEach((p) => { p.style.display = ''; });
  if (rangeWrap) rangeWrap.hidden = rangeWasHidden;

  const uniq = {};
  rows.forEach((x) => {
    const key = [x.h, x.border, x.radius, x.padL, x.font, x.bg].join(' | ');
    (uniq[key] = uniq[key] || []).push(x.id);
  });
  const pre = document.createElement('pre');
  pre.id = '__diag';
  pre.textContent = JSON.stringify({ total: rows.length, groups: uniq, rows }, null, 2);
  document.body.appendChild(pre);
}

document.addEventListener('DOMContentLoaded', () => {
  bindTabs();
  bindPeriodSeg();
  bindNoteFilter();
  bindConfigDirty();
  bindRevealButtons();
  bindCopyButtons();
  bindFsPicker();
  bindActions();

  refresh(true).then(() => {
    startPolling();
    const run = state.data && state.data.run;
    if (run && run.running) pollRun();
    applyTabFromUrl();
    if (new URLSearchParams(location.search).has('diag')) runLayoutDiag();
  });
});
