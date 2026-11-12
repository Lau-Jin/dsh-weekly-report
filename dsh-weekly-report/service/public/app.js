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
// 每张卡片各自一个开关（路径卡 / 定时任务 / 最近一次生成 / 历史），
// 默认全藏；各自独立、各自记得住，互不影响。
const PATH_KEYS = ['paths', 'schedule', 'lastrun', 'reports'];
const pathShown = { paths: false, schedule: false, lastrun: false, reports: false };
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

/** 只有这块真的会显示路径时，才给出「显示路径 / 隐藏路径」按钮。 */
function setPathToggle(key, visible) {
  const btn = document.querySelector(`[data-path-toggle="${key}"]`);
  if (btn) btn.hidden = !visible;
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
  setPathToggle('paths', rows.length > 0);
  if (!rows.length) {
    $('#paths').innerHTML = `<dt>路径</dt>
      <dd><span class="wr-muted">未获取到路径</span></dd>`;
    return;
  }
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
    setPathToggle('schedule', false);
    if (hint) hint.textContent = '';
    return;
  }
  if (!s.installed) {
    box.innerHTML = '<span class="wr-muted">未登记（不登记也能在面板里手动生成）</span>';
    setPathToggle('schedule', false);
    hint.textContent = '';
    return;
  }
  setPathToggle('schedule', Boolean(s.target));
  const chips = [];
  if (s.status) chips.push(`<span class="wr-chip">${esc(s.status)}</span>`);
  if (s.nextRun) chips.push(`<span class="wr-chip">下次 ${esc(s.nextRun)}</span>`);
  chips.push(s.pointsToPlugin
    ? '<span class="wr-chip wr-chip--ok">已接管</span>'
    : '<span class="wr-chip wr-chip--warn">未接管</span>');
  box.innerHTML = `<div class="wr-chips">${chips.join('')}</div>` + pathBlock(s.target, 'schedule');
  hint.textContent = '';
}

function renderLastRun(run) {
  const box = $('#last-run');
  const hint = $('#lastrun-hint');
  if (!run || (!run.startedAt && !(run.lines || []).length)) {
    box.innerHTML = '<span class="wr-muted">尚未生成</span>';
    setPathToggle('lastrun', false);
    hint.textContent = '';
    return;
  }
  setPathToggle('lastrun', Boolean(run.outPath));
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
function fillConfig(cfg, keyInfo, force) {
  // 轮询每 15 秒会调一次；用户正在改表单时**不能覆盖**（否则刚粘的 API Key、
  // 邮箱授权码会被静默清掉，"有未保存修改"的提示也会消失）。
  if (!force && state.dirty) return;
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
  $('#pass-hint').textContent = s.password ? `已保存 ${s.password}` : '未设置';
  $('#key-hint').textContent = keyInfo && keyInfo.present ? `${keyInfo.masked}` : '未配置';
  // 只有在"没有未保存修改"时才清掉这两个输入框（保存成功后本来也会清）
  if (force || !state.dirty) {
    $('#api-key').value = '';
    $('#smtp-pass').value = '';
    setDirty(false);
  }
}

function setDirty(v) {
  state.dirty = !!v;
  $('#dirty').hidden = !state.dirty;
}

/* ---------------------------------------------------------------- 渲染：绩效表 */
/** 绩效表内容渲染成表格（不是制表符文本——中文宽度不一，制表符必然错位）。 */
function perfTableHtml(tbl) {
  const rows = tbl.rows || [];
  const head = `
    <div class="wr-ptable__head">
      <div class="wr-ptable__meta">
        <span class="wr-ptable__name">${esc(tbl.name || '')}</span>
        <span class="wr-chip">考核期间 ${esc(tbl.period || '—')}</span>
        <span class="wr-chip">处理人 ${esc(tbl.handler || '—')}</span>
        ${tbl.dept ? `<span class="wr-chip">${esc(tbl.dept)}</span>` : ''}
        ${tbl.filled_at ? `<span class="wr-chip">填报 ${esc(String(tbl.filled_at).replace('T', ' ').slice(0, 16))}</span>` : ''}
      </div>
      <div class="wr-ptable__stats">
        <span class="wr-chip wr-chip--ok">已完成 ${tbl.done || 0}</span>
        <span class="wr-chip wr-chip--warn">未完成 ${tbl.undone || 0}</span>
        <span class="wr-chip">共 ${tbl.total || 0} 条</span>
      </div>
    </div>`;
  if (!rows.length) {
    return head + '<div class="wr-empty">这张表的任务区还没有内容</div>';
  }
  const body = rows.map((r) => {
    const d1 = r.d1_text || r.d1 || '—';
    const d2 = r.d2_text || r.d2 || '—';
    return `<tr>
      <td class="wr-ptable__cat">${esc(r.category || '')}</td>
      <td class="wr-ptable__item">${esc(r.content || '')}${r.note ? `<div class="wr-ptable__note">${esc(r.note)}</div>` : ''}</td>
      <td class="wr-ptable__when">${esc(d1)}</td>
      <td class="wr-ptable__when">${esc(d2)}</td>
      <td class="wr-ptable__done"><span class="wr-pill ${r.settled ? 'wr-pill--ok' : 'wr-pill--warn'}">${r.settled ? '是' : '否'}</span></td>
    </tr>`;
  }).join('');
  // 表头照抄表里的列名（类别 / 任务名称 / 开始时间 / 结束时间 / 是否完成）
  const hs = tbl.headers || [];
  const h = (i, fb) => esc(hs[i] || fb);
  return head + `<div class="wr-ptable__wrap"><table class="wr-ptable">
      <colgroup>
        <col class="wr-ptable__col-cat" /><col class="wr-ptable__col-item" />
        <col class="wr-ptable__col-when" /><col class="wr-ptable__col-when" />
        <col class="wr-ptable__col-done" />
      </colgroup>
      <thead><tr><th>${h(0, '类别')}</th><th>${h(1, '任务名称')}</th><th>${h(2, '开始时间')}</th><th>${h(3, '结束时间')}</th><th>${h(4, '是否完成')}</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
}

const PERIOD_TIPS = {
  current: '生成**本周**（周一~周日）一份周报，并写入本月绩效表。',
  last: '生成**上周**（周一~周日）一份周报，并写入本月绩效表。',
  lastMonth: '生成**上个月**的周报：该月每一周各一份（共 4~5 份），并写入上个月的绩效表。',
  range: '生成指定区间内**每一周**各一份周报（区间跨几周就有几份），涉及的每个月各写一份绩效表。',
};

/** 周期语义提示（说清楚"这一趟会生成什么"）。 */
function renderPeriodTip(period) {
  const el = $('#period-tip');
  if (!el) return;
  el.innerHTML = PERIOD_TIPS[period] || PERIOD_TIPS.current;
}

/** 周报模板：显示当前用的模板路径。 */
function renderReportTemplate(info) {
  const box = $('#rpt-tpl-path');
  const hint = $('#rpt-tpl-hint');
  if (!box) return;
  const tpl = (info && info.report) || '';
  const custom = (info && info.reportCustom) || '';
  box.textContent = tpl || '（未找到模板文件，使用内置默认格式）';
  if (hint) hint.textContent = custom ? '已用自定义模板' : '插件自带模板';
}

function renderPerf(perf) {
  const box = $('#perf-current');
  const hint = $('#perf-hint');
  if (!box) return;
  const info = perf || {};
  const tables = info.tables || [];
  const current = info.current || '';
  const cur = tables.find((t) => t.path === current);
  if (!info.root) {
    box.innerHTML = '<span class="wr-muted">未配置绩效表目录（配置页「绩效表目录」填一下）</span>';
    if (hint) hint.textContent = '';
    renderPerfArchive([], current);
    return;
  }
  if (!current) {
    box.innerHTML = '<span class="wr-muted">按当前配置找不到本月考核表路径</span>';
    if (hint) hint.textContent = '';
  } else if (cur) {
    box.innerHTML = `<div class="wr-chips">
        <span class="wr-chip wr-chip--ok">本月已存在</span>
        <span class="wr-chip">${esc(cur.name)}</span>
        <span class="wr-chip">${fmtSize(cur.size)}</span>
        <span class="wr-chip">${esc(fmtTime(cur.mtime))}</span>
      </div>
      <div class="wr-mono" style="font-size:11px;color:var(--fg-3);margin-top:7px;word-break:break-all">${esc(cur.path)}</div>`;
    if (hint) hint.textContent = '内容 = 本月全部周报';
  } else {
    box.innerHTML = `<div class="wr-chips">
        <span class="wr-chip wr-chip--warn">本月还没生成</span>
      </div>
      <div class="wr-mono" style="font-size:11px;color:var(--fg-3);margin-top:7px;word-break:break-all">${esc(current)}</div>`;
    if (hint) hint.textContent = '生成周报时会自动写入';
  }
  renderPerfArchive(tables.filter((t) => t.path !== current), current);
}

/** 往月绩效表：按目录（年份）收拢。

 * 展开状态记在模块级变量里 —— 页面每 15 秒轮询一次会重画这张卡，
 * 不记住的话用户刚点开就被收起了（"在查看某月绩效表中，会自动收起"）。
 */
const perfOpen = { groups: new Set(), items: new Set() };
// 展开的往月表内容（路径 → HTML）：重建 DOM 时原样恢复
const perfViewCache = new Map();   // 路径 → 展开内容的 HTML
const perfViewMeta = new Map();    // 路径 → { size, mtime }（判断文件是否被重新生成）

// 往月绩效表：数据没变就不重建 DOM —— 重建会让展开的表"突然消失"
let archiveSig = '';

function renderPerfArchive(tables, current) {
  const archive = $('#perf-archive');
  const list = $('#perf-archive-list');
  if (!archive || !list) return;
  archive.hidden = !tables.length;
  if (!tables.length) { list.innerHTML = ''; archiveSig = ''; return; }

  const sig = JSON.stringify(tables.map((x) => [x.path, x.name, x.size, x.mtime]));
  if (sig === archiveSig) return;       // 保持现状（展开的内容不丢）
  archiveSig = sig;
  // 文件变了（重新生成过）→ 旧的展开内容作废
  for (const x of tables) {
    const old = perfViewMeta.get(x.path);
    if (old && (old.size !== x.size || old.mtime !== x.mtime)) {
      perfViewCache.delete(x.path);
      perfViewMeta.delete(x.path);
      perfOpen.items.delete(x.path);
    }
    perfViewMeta.set(x.path, { size: x.size, mtime: x.mtime });
  }

  // 按目录（年份）分组
  const groups = new Map();
  for (const t of tables) {
    const key = t.dir || '.';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const keys = Array.from(groups.keys()).sort((a, b) => b.localeCompare(a, 'zh-CN'));
  list.innerHTML = keys.map((key) => {
    const items = groups.get(key);
    const label = key === '.' ? '根目录' : key;
    const open = perfOpen.groups.has(key);
    return `<details class="wr-pgroup" data-perf-group="${esc(key)}"${open ? ' open' : ''}>
      <summary class="wr-pgroup__head">
        <span class="wr-pgroup__name">${esc(label)}</span>
        <span class="wr-pgroup__count">${items.length} 张</span>
      </summary>
      <div class="wr-pgroup__body">
        ${items.map((t) => {
          const isOpen = perfOpen.items.has(t.path);
          return `
          <div class="wr-pitem" data-perf-item="${esc(t.path)}">
            <div class="wr-rep">
              <div style="min-width:0;flex:1 1 auto">
                <div class="wr-rep__name" style="font-size:12px">${esc(t.name)}</div>
                <div class="wr-rep__sub">${fmtSize(t.size)} · ${esc(fmtTime(t.mtime))}</div>
              </div>
              <button class="wr-btn wr-btn--ghost" data-perf-view="${esc(t.path)}">${isOpen ? '收起' : '查看'}</button>
              <button class="wr-btn wr-btn--ghost" data-perf-open="${esc(t.dirAbs || '')}">打开目录</button>
            </div>
            <div class="wr-pitem__view"${isOpen ? '' : ' hidden'}>${perfViewCache.get(t.path) || ''}</div>
          </div>`;
        }).join('')}
      </div>
    </details>`;
  }).join('');
}

/** 展开某张往月表：内容就地展开（限高滚动，不把下面的目录顶走），并滚到它那一行。 */
async function togglePerfItem(path, btn) {
  const item = btn.closest('[data-perf-item]');
  if (!item) return;
  const out = item.querySelector('.wr-pitem__view');
  if (!out) return;
  const open = out.hidden;
  if (open) {
    perfOpen.items.add(path);
    out.hidden = false;
    btn.textContent = '收起';
    // 滚到这一条，让人看到自己在看哪一张（不跳到页面最上面）
    try { item.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) { /* ignore */ }
    await viewPerfTable(path, out);
    perfViewCache.set(path, out.innerHTML);
  } else {
    perfOpen.items.delete(path);
    perfViewCache.delete(path);
    out.hidden = true;
    out.innerHTML = '';
    btn.textContent = '查看';
  }
}

/** 读一张绩效表并渲染（容器可以是本月卡的输出区，也可以是某一条往月表下面的展开区）。 */
async function viewPerfTable(path, container) {
  const box = typeof container === 'string' ? $(container) : container;
  if (!box) return null;
  box.hidden = false;
  box.innerHTML = '<div class="wr-muted">正在读取绩效表…</div>';
  try {
    const r = await api('/api/perf/table?path=' + encodeURIComponent(path));
    if (!r.ok) {
      box.innerHTML = `<div class="wr-pitem__err">读取失败：${esc(r.error || '未知原因')}</div>`;
      return null;
    }
    box.innerHTML = perfTableHtml(r.table || {});
    return r.table;
  } catch (e) {
    box.innerHTML = `<div class="wr-pitem__err">读取失败：${esc(e.message)}</div>`;
    return null;
  }
}

/* ---------------------------------------------------------------- 渲染：历史 */
function renderReports(reports) {
  const box = $('#report-list');
  const q = state.reportQuery.trim().toLowerCase();
  const list = q ? reports.filter((r) => r.name.toLowerCase().includes(q)) : reports;
  $('#report-hint').textContent = `${list.length} / ${reports.length} 份`;
  // 「打开周报目录」：只要输出目录本身能开就显示（哪怕所有周报都在根目录、没有子目录）
  const openRoot = $('#btn-open-outdir');
  if (openRoot) openRoot.hidden = !reports.length;
  if (!list.length) {
    box.innerHTML = `<div class="wr-empty">${reports.length ? '没有匹配的文件' : '还没生成过周报'}</div>`;
    return;
  }
  box.innerHTML = list.map((r, i) => {
    // 文件直接躺在输出根目录时，行内按钮没意义（跟「打开周报目录」是同一个地方）
    const dirLabel = r.inRoot ? '输出目录' : esc(r.dir || '');
    const dirBtn = r.inRoot ? '' : `
        <button class="wr-btn wr-btn--ghost" data-open-dir="${esc(r.dirAbs || '')}"
                title="在资源管理器里打开：${esc(r.dirAbs || '')}">打开所在目录</button>`;
    return `
    <div class="wr-item" data-report-index="${i}">
      <div class="wr-rep">
        <div style="min-width:0;flex:1 1 auto">
          <div class="wr-rep__name">${esc(r.name)}</div>
          <div class="wr-rep__sub">${dirLabel} · ${r.entries} 条 · ${fmtSize(r.size)} · ${esc(fmtTime(r.mtime))}</div>
        </div>${dirBtn}
        <button class="wr-btn" data-view="${esc(r.path)}">查看</button>
      </div>
    </div>`;
  }).join('');
  box._items = list;
}

/** 在资源管理器里打开目录（服务端只允许周报输出目录以内的位置）。 */
async function openDir(target, label) {
  if (!target) { toast('没有可打开的目录', 'err'); return; }
  try {
    const r = await post('/api/open-dir', { path: target });
    toast(r.ok ? `已打开${label ? '：' + label : '目录'}` : ('打开失败：' + (r.error || '未知原因')), r.ok ? 'ok' : 'err');
  } catch (e) {
    toast('打开失败：' + e.message, 'err');
  }
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
/* ---------------------------------------------------------------- 日志：滚动跟随 */
function logAutoScroll() {
  const box = $('#opt-log-auto');
  return !box || box.checked;
}

function isLogAtBottom(pre) {
  if (!pre) return true;
  // 差 8px 以内算「在底部」，避免像素级抖动导致回不到底
  return pre.scrollHeight - pre.scrollTop - pre.clientHeight <= 8;
}

function scrollLogToEnd() {
  const pre = $('#run-log');
  if (!pre) return;
  pre.scrollTop = pre.scrollHeight;
}

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

/** 结果模块里就地展开 / 收起某一条（周报看正文，绩效表看表格）。

 * 展开的内容记在 resultOpen（路径 → HTML），这样轮询重画时能原样恢复，
 * 不会"刷新一下就没了"，也不会把按钮文字退回「查看」。
 */
const resultOpen = new Map();          // 路径 → 展开内容的 HTML
const resultOpenMeta = new Map();      // 路径 → { count }
const resultCounts = new Map();        // 路径 → 本次产物的条数

async function toggleResultView(btn, kind) {
  const item = btn.closest('.wr-res__item');
  const out = item && item.querySelector('.wr-res__view');
  if (!out) return;
  const path = kind === 'perf' ? btn.dataset.resPerf : btn.dataset.resView;
  const open = out.hidden;
  if (!open) {
    out.hidden = true;
    out.innerHTML = '';
    resultOpen.delete(path);
    resultOpenMeta.delete(path);
    btn.textContent = '查看';
    return;
  }
  out.hidden = false;
  btn.textContent = '收起';
  out.innerHTML = '<div class="wr-muted">正在读取…</div>';
  try {
    let html = '';
    if (kind === 'perf') {
      const r = await api('/api/perf/table?path=' + encodeURIComponent(path));
      if (!r.ok) {
        out.innerHTML = `<div class="wr-pitem__err">读取失败：${esc(r.error || '未知原因')}</div>`;
        resultOpen.delete(path);
        return;
      }
      html = perfTableHtml(r.table || {});
    } else {
      const r = await api('/api/report?path=' + encodeURIComponent(path));
      html = `<pre class="wr-pre wr-pre--perf">${esc(r.text || '(空)')}</pre>`;
    }
    out.innerHTML = html;
    resultOpen.set(path, html);
    resultOpenMeta.set(path, { count: resultCounts.get(path) });
  } catch (e) {
    out.innerHTML = `<div class="wr-pitem__err">读取失败：${esc(e.message)}</div>`;
    resultOpen.delete(path);
  }
}

/** 生成结果：周报 / 绩效表 两个模块分别列出本次产物。 */
// 结果模块：数据没变就别重建 DOM —— 重建会把用户展开的内容冲掉（"查看后自动收起"）
let resultSig = '';

function renderResult(run) {
  const card = $('#result-card');
  if (!card) return;
  const art = (run && run.artifacts) || { reports: [], perf: [], weeks: [] };
  const reports = art.reports || [];
  const perf = art.perf || [];
  if (!reports.length && !perf.length) {
    card.hidden = true;
    resultSig = '';
    return;
  }
  card.hidden = false;

  const sig = JSON.stringify([reports.map((a) => [a.path, a.count, a.start, a.end]),
    perf.map((a) => [a.path, a.count])]);
  if (sig === resultSig) {
    const hint0 = $('#result-hint');
    if (hint0) hint0.textContent = `${reports.length} 份周报 · ${perf.length} 份绩效表`;
    return;                       // 内容没变 → 保持现状（不收起、不清空）
  }
  resultSig = sig;
  // 条数变了说明文件被重新生成过 → 旧的展开内容作废
  for (const [path, meta] of resultOpenMeta) {
    if (!resultCounts.get(path) || resultCounts.get(path) !== meta.count) {
      resultOpen.delete(path);
      resultOpenMeta.delete(path);
    }
  }

  const repBox = $('#result-reports');
  repBox.innerHTML = reports.length ? reports.map((a) => `
    <div class="wr-res__item">
      <div style="min-width:0;flex:1 1 auto">
        <div class="wr-res__name">${esc(a.name)}</div>
        <div class="wr-res__sub">${esc(a.start)} ~ ${esc(a.end)} · ${a.count} 条</div>
      </div>
      <button class="wr-btn wr-btn--ghost" data-res-view="${esc(a.path)}">查看</button>
      <button class="wr-btn wr-btn--ghost" data-open-dir="${esc(a.path)}" title="打开所在目录">打开目录</button>
      <div class="wr-res__view"${resultOpen.has(a.path) ? '' : ' hidden'}>${resultOpen.get(a.path) || ''}</div>
    </div>`).join('') : '<div class="wr-muted">本次没有生成周报</div>';
  reports.forEach((a) => resultCounts.set(a.path, a.count));

  const perfBox = $('#result-perf');
  perfBox.innerHTML = perf.length ? perf.map((a) => `
    <div class="wr-res__item">
      <div style="min-width:0;flex:1 1 auto">
        <div class="wr-res__name">${esc(a.name)}</div>
        <div class="wr-res__sub">${a.year}年${a.month}月 · ${a.count} 条</div>
      </div>
      <button class="wr-btn wr-btn--ghost" data-res-perf="${esc(a.path)}">查看</button>
      <button class="wr-btn wr-btn--ghost" data-open-dir="${esc(a.path)}" title="打开所在目录">打开目录</button>
      <div class="wr-res__view"${resultOpen.has(a.path) ? '' : ' hidden'}>${resultOpen.get(a.path) || ''}</div>
    </div>`).join('') : '<div class="wr-muted">本次没有写绩效表（可看「模板自检」：目录里可能还没有模板）</div>';
  perf.forEach((a) => resultCounts.set(a.path, a.count));

  const hint = $('#result-hint');
  if (hint) hint.textContent = `${reports.length} 份周报 · ${perf.length} 份绩效表`;
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
  // 运行中提示会说明这趟会生成什么（周期语义）
  const tipEl = $('#run-tip');
  if (tipEl) {
    const art = (run && run.artifacts) || {};
    const nRep = (art.reports || []).length;
    const nPerf = (art.perf || []).length;
    tipEl.innerHTML = running
      ? '按所选周期生成：周报（每周一份）+ 涉及的绩效表；结果在下方两个模块里'
      : (nRep || nPerf)
        ? `上次生成：${nRep} 份周报、${nPerf} 份绩效表`
        : '';
  }
  if (run && run.lines && run.lines.length) {
    const pre = $('#run-log');
    const text = run.lines.join('\n');
    if (pre.textContent !== text) {
      // 用户往上翻看时不要把他拽回底部：只在「本来就在底部」或「自动滚动开着」时才跟到底。
      // 不跟到底时还要把滚动位置按新增高度补偿回去，否则换文本会把人弹回顶部。
      const wasAtBottom = isLogAtBottom(pre);
      const oldTop = pre.scrollTop;
      const oldHeight = pre.scrollHeight;
      pre.textContent = text;
      if (wasAtBottom || logAutoScroll()) {
        pre.scrollTop = pre.scrollHeight;
      } else {
        pre.scrollTop = Math.max(0, oldTop + (pre.scrollHeight - oldHeight));
      }
    }
  }
  setLogState(run);
  renderResult(run);

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
  renderLastRun(data.run);
  renderNotes(data.notes || []);
  renderReports(data.reports || []);
  renderPerf(data.perf);
  renderReportTemplate(data.templates);
  // 配置损坏之类的严重问题要显眼地报出来（以前是静默重置成默认值）
  const cfgErr = $('#cfg-error');
  if (cfgErr) {
    cfgErr.hidden = !data.configError;
    if (data.configError) cfgErr.textContent = '⚠ ' + data.configError;
  }
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
      renderPeriodTip(b.dataset.period);
    };
  });
  renderPeriodTip($('#period').value || 'current');
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
      noCache: $('#opt-nocache').checked,
    };
    if (body.period === 'range') {
      body.start = $('#start').value;
      body.end = $('#end').value;
      if (!body.start || !body.end) { toast('请选择起止日期', 'err'); return; }
    }
    try {
      await post('/api/run', body);
      $('#run-log').textContent = '已启动，等待输出…';
      scrollLogToEnd();
      pollRun();
      toast('已开始生成', 'ok');
    } catch (e) { toast('启动失败：' + e.message, 'err'); }
  };

  $('#btn-cancel').onclick = async () => {
    try { await post('/api/run/cancel', {}); toast('已请求终止'); } catch (e) { toast(e.message, 'err'); }
  };

  $('#btn-log-tail').onclick = () => {
    scrollLogToEnd();
    toast('已跳到日志末尾', 'ok');
  };
  $('#opt-log-auto').onchange = (e) => {
    try { localStorage.setItem('wr-log-autoscroll', e.target.checked ? '1' : '0'); } catch (_) { /* ignore */ }
    if (e.target.checked) scrollLogToEnd();
    toast(e.target.checked ? '已开启自动滚动' : '已关闭自动滚动，可安心往回翻', 'ok');
  };
  // 记住「自动滚动」的偏好
  try {
    const saved = localStorage.getItem('wr-log-autoscroll');
    if (saved !== null) $('#opt-log-auto').checked = saved === '1';
  } catch (_) { /* ignore */ }

  $('#btn-clear-log').onclick = () => {
    const pre = $('#run-log');
    pre.textContent = '（已清空，这里只清显示）';
    pre.dataset.cleared = '1';
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

  // 打开周报输出目录（历史工具栏）
  const openOut = $('#btn-open-outdir');
  if (openOut) {
    openOut.onclick = () => {
      const dir = (state.data && state.data.paths && state.data.paths.outDir) || '';
      void openDir(dir, '周报输出目录');
    };
  }

  // 绩效表：查看 / 打开目录 / 核对
  let perfViewOpen = false;
  $('#btn-perf-view').onclick = () => {
    const cur = state.data && state.data.perf && state.data.perf.current;
    if (!cur) { toast('找不到本月绩效表路径', 'err'); return; }
    const out = $('#perf-view-out');
    const btn = $('#btn-perf-view');
    if (perfViewOpen) {                       // 再点一次收起
      perfViewOpen = false;
      btn.textContent = '查看绩效表';
      if (out) { out.hidden = true; out.innerHTML = ''; }
      return;
    }
    perfViewOpen = true;
    btn.textContent = '收起绩效表';
    void viewPerfTable(cur, out);
  };
  // 「模板自检」的结果也放这块，收起时一起收掉
  $('#btn-perf-tpl').addEventListener('click', () => {
    const out = $('#perf-view-out');
    if (out) { out.hidden = false; }
    perfViewOpen = true;
    const btn = $('#btn-perf-view');
    if (btn) btn.textContent = '收起绩效表';
  });
  $('#btn-perf-open').onclick = () => {
    const cur = state.data && state.data.perf && state.data.perf.current;
    if (!cur) { toast('找不到本月绩效表路径', 'err'); return; }
    // 用所在目录（文件在年份子目录里）
    const dir = cur.replace(/[\\/][^\\/]*$/, '');
    void openDir(dir, '绩效表所在目录');
  };
  $('#btn-perf-check2').onclick = async () => {
    const btn = $('#btn-perf-check2');
    btn.disabled = true;
    const out = $('#perf-view-out');
    if (out) {
      out.hidden = false;
      out.innerHTML = '<div class="wr-muted">正在核对本月绩效表…</div>';
    }
    try {
      const r = await post('/api/perf-check', {});
      if (out) {
        out.innerHTML = `<pre class="wr-pre wr-pre--perf">${esc(r.out || '(无输出)')}</pre>`;
      }
      toast(r.ok ? '绩效表核对通过' : '绩效表核对有提示，看下面的报告', r.ok ? 'ok' : 'err');
    } catch (e) {
      if (out) out.innerHTML = `<div class="wr-pitem__err">核对失败：${esc(e.message)}</div>`;
      toast('核对失败', 'err');
    } finally {
      btn.disabled = false;
      await refresh(true);
    }
  };
  $('#btn-perf-tpl').onclick = async () => {
    const btn = $('#btn-perf-tpl');
    const out = $('#perf-view-out');
    btn.disabled = true;
    if (out) { out.hidden = false; out.innerHTML = '<div class="wr-muted">正在检查绩效表模板…</div>'; }
    try {
      const r = await api('/api/perf/template');
      const rep = (r && r.report) || {};
      const items = rep.items || [];
      const errors = rep.errors || [];
      const hints = rep.hints || [];
      const rows = items.map((it) => `
        <tr>
          <td class="wr-ptable__item">${esc(it.name)}</td>
          <td class="wr-ptable__when">${it.ok ? '可用' : '有问题'}</td>
          <td class="wr-ptable__item">${esc((it.notes || []).join('；') || '—')}</td>
        </tr>`).join('');
      const html = `
        <div class="wr-ptable__head">
          <div class="wr-ptable__meta">
            <span class="wr-ptable__name">绩效表模板自检</span>
            <span class="wr-chip">目录 ${esc(rep.folder || '—')}</span>
          </div>
          <div class="wr-ptable__stats">
            <span class="wr-chip ${rep.ok ? 'wr-chip--ok' : 'wr-chip--warn'}">${rep.ok ? '模板可用' : '需要准备模板'}</span>
            <span class="wr-chip">${items.length} 张候选</span>
          </div>
        </div>
        ${errors.length ? `<div class="wr-pitem__err">${errors.map(esc).join('<br/>')}</div>` : ''}
        ${hints.length ? `<div class="wr-field__tip" style="margin-top:8px">${hints.map(esc).join('<br/>')}</div>` : ''}
        ${rows ? `<div class="wr-ptable__wrap"><table class="wr-ptable">
            <thead><tr><th>模板文件</th><th>状态</th><th>说明</th></tr></thead>
            <tbody>${rows}</tbody></table></div>` : ''}`;
      if (out) out.innerHTML = html;
      toast(rep.ok ? '模板可用' : '需要准备模板，看下面的说明', rep.ok ? 'ok' : 'err');
    } catch (e) {
      if (out) out.innerHTML = `<div class="wr-pitem__err">自检失败：${esc(e.message)}</div>`;
      toast('自检失败', 'err');
    } finally {
      btn.disabled = false;
    }
  };

  $('#btn-rpt-tpl-open').onclick = () => {
    const dir = (state.data && state.data.paths && state.data.paths.outDir) || '';
    if (!dir) { toast('未找到周报输出目录', 'err'); return; }
    void openDir(dir, '周报输出目录');
  };

  $('#result-card').addEventListener('click', (e) => {
    const repBtn = e.target.closest('[data-res-view]');
    if (repBtn) { void toggleResultView(repBtn, 'report'); return; }
    const perfBtn = e.target.closest('[data-res-perf]');
    if (perfBtn) { void toggleResultView(perfBtn, 'perf'); return; }
    const dirBtn = e.target.closest('[data-open-dir]');
    if (dirBtn) {
      const p = dirBtn.dataset.openDir || '';
      void openDir(p.replace(/[\\/][^\\/]*$/, ''), '所在目录');
    }
  });

  $('#perf-archive-list').addEventListener('click', (e) => {
    const viewBtn = e.target.closest('[data-perf-view]');
    if (viewBtn) { void togglePerfItem(viewBtn.dataset.perfView, viewBtn); return; }
    const openBtn = e.target.closest('[data-perf-open]');
    if (openBtn) { void openDir(openBtn.dataset.perfOpen, '绩效表所在目录'); }
  });
  // 分组展开状态也记住（重画后恢复）
  $('#perf-archive-list').addEventListener('toggle', (e) => {
    const det = e.target.closest('[data-perf-group]');
    if (!det) return;
    const key = det.dataset.perfGroup;
    if (det.open) perfOpen.groups.add(key);
    else perfOpen.groups.delete(key);
  }, true);

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
    const openBtn = e.target.closest('[data-open-dir]');
    if (openBtn) {
      e.stopPropagation();
      void openDir(openBtn.dataset.openDir, openBtn.closest('.wr-item')?.querySelector('.wr-rep__name')?.textContent || '');
      return;
    }
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

// 测试用：?diag=1 时把几个渲染函数挂到 window，方便验证「没有路径就没有开关」这类边界
if (new URLSearchParams(location.search).has('diag')) {
  window.__wrDebug = { renderPaths, renderSchedule, renderLastRun, renderReports, renderRun, renderPerf, pathShown, syncPathToggles, get state() { return state; } };
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
