/**
 * 周报工作台 · 面板交互（纯原生，无框架、无外部依赖）
 * 所有读写都走本地 127.0.0.1 面板服务，浏览器半身不持有任何凭据。
 */
(() => {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const S = {
    state: null, view: 'overview', period: 'current', reports: [],
    selected: '', fsTarget: '', fsPath: '', runTimer: 0, tplText: '', previewReal: false,
  };

  async function api(url, options) {
    const res = await fetch(url, {
      cache: 'no-store',
      ...options,
      headers: options && options.body ? { 'Content-Type': 'application/json' } : undefined,
    });
    return res.json().catch(() => ({ ok: false, error: '服务返回异常' }));
  }
  const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body || {}) });

  let toastTimer = 0;
  function toast(text, kind = 'ok') {
    const el = $('#toast');
    el.textContent = text;
    el.style.background = kind === 'err' ? '#b84444' : kind === 'warn' ? '#9a6520' : '#2b3242';
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
  }

  /** 统一的「打开目录 / 选中文件」：给明确反馈，失败自动复制路径兜底。 */
  async function openPath(target, label = '目录') {
    const p = String(target || '').trim();
    if (!p || p.startsWith('（') || p.startsWith('还没有')) { toast('暂无可打开的路径', 'warn'); return; }
    try {
      const r = await post('/api/open-dir', { path: p });
      if (r.ok) toast(`已打开${label}：${r.path}`);
      else {
        toast(`打开失败：${r.error || '未知原因'}`, 'err');
        try { await navigator.clipboard.writeText(p); toast('路径已复制，可粘贴到资源管理器'); } catch { /* ignore */ }
      }
    } catch (e) { toast('请求失败：' + (e.message || e), 'err'); }
  }

  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const fmtSize = (n) => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;

  // ---------------------------------------------------------------- 开关状态
  /** 开关的「已开启 / 已关闭」徽标跟随勾选状态，一眼能看出当前是否生效。 */
  function syncSwitchStates() {
    $$('.ws-switch').forEach((sw) => {
      const input = sw.querySelector('input[type="checkbox"]');
      const badge = sw.querySelector('.ws-switch__state');
      if (!input || !badge) return;
      badge.textContent = input.checked ? '已开启' : '已关闭';
    });
  }
  document.addEventListener('change', (e) => {
    const input = e.target;
    if (input && input.matches && input.matches('.ws-switch input[type="checkbox"]')) syncSwitchStates();
  });
  syncSwitchStates();

  // ---------------------------------------------------------------- 展开 / 收起
  /** 统一的内容块折叠：按钮文案随状态切换，收起后不留空白。 */
  function setExpanded(btn, panels, expanded, labels = ['展开', '收起']) {
    const list = Array.isArray(panels) ? panels : [panels];
    list.forEach((p) => { if (p) p.hidden = !expanded; });
    if (btn) {
      btn.textContent = expanded ? labels[1] : labels[0];
      btn.setAttribute('aria-expanded', String(expanded));
    }
  }
  function bindCollapse(btn, panels, labels) {
    btn.addEventListener('click', () => {
      const first = Array.isArray(panels) ? panels[0] : panels;
      setExpanded(btn, panels, Boolean(first && first.hidden), labels);
    });
  }

  // ---------------------------------------------------------------- 导航
  function switchView(name) {
    S.view = name;
    $$('.ws-nav__item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
    $$('.ws-view').forEach((v) => v.classList.toggle('is-active', v.dataset.pane === name));
    try {
      const u = new URL(location.href);
      u.searchParams.set('view', name);
      history.replaceState(null, '', u);
    } catch { /* ignore */ }
    if (name === 'history') void loadReports();
    if (name === 'settings') void loadTemplate();
    if (name === 'generate') void refreshRun();
  }

  $$('.ws-nav__item').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

  // ---------------------------------------------------------------- 状态
  async function loadState() {
    try {
      const st = await api('/api/state');
      if (!st.ok) throw new Error(st.error || '服务未就绪');
      S.state = st;
      const dot = $('#svc-dot');
      dot.className = 'ws-dot is-ok';
      $('#svc-text').textContent = `在线 · v${st.version}`;
      renderOverview(st);
      fillSettings(st);
    } catch (e) {
      $('#svc-dot').className = 'ws-dot is-bad';
      $('#svc-text').textContent = '服务未连接';
    }
  }

  function renderOverview(st) {
    const checks = st.checks || [];
    const done = checks.filter((c) => c.level === 'ok').length;
    $('#ready-num').textContent = String(done);
    $('#ready-ring').style.setProperty('--pct', String(Math.round(done / Math.max(checks.length, 1) * 100)));
    $('.ws-hero__ringlabel').textContent = `就绪项 / 共 ${checks.length} 项`;

    $('#checks-list').innerHTML = checks.length
      ? checks.map((c) => `<div class="ws-check">
          <span class="ws-check__dot ${esc(c.level)}"></span>
          <div class="ws-check__body"><div class="ws-check__title">${esc(c.title)}</div>
          <div class="ws-check__text">${esc(c.text)}</div></div></div>`).join('')
      : '<div class="ws-empty">暂无检查项</div>';

    const recent = (st.reports || []).slice(0, 4);
    $('#recent-list').innerHTML = recent.length
      ? recent.map((r) => `<div class="ws-recent__item" data-report="${esc(r.path)}">
          <span class="ws-recent__ico">≡</span>
          <div style="min-width:0"><div class="ws-recent__name">${esc(r.name)}</div>
          <div class="ws-recent__meta">${esc(r.entries)} 条 · ${fmtTime(r.mtime)} · ${fmtSize(r.size)}</div></div></div>`).join('')
      : '<div class="ws-empty">还没有生成过周报</div>';
    $$('#recent-list [data-report]').forEach((el) => el.addEventListener('click', () => {
      S.selected = el.dataset.report; switchView('history'); void showReport(S.selected);
    }));
  }

  function fillSettings(st) {
    const c = st.config || {};
    $('#f-mcp').value = c.mcp_url || '';
    $('#f-handler').value = c.handler || '';
    $('#f-out').value = c.out_dir || '';
    $('#f-folder').value = c.folder || '';
    $('#f-perf-template').value = c.perf_template || '';
    $('#f-perf-insert').checked = Boolean(c.perf_allow_insert);
    $('#f-threshold').value = c.threshold ?? 0.85;
    $('#f-notify').checked = Boolean(c.notify && c.notify.enabled);
    $('#smtp-box').hidden = !$('#f-notify').checked;
    $('#notify-badge').textContent = $('#f-notify').checked ? '已开启' : '默认关闭';
    $('#notify-badge').className = 'ws-badge' + ($('#f-notify').checked ? ' ws-badge--warn' : '');
    syncSwitchStates();
    const smtp = (c.notify && c.notify.smtp) || {};
    $('#f-smtp-host').value = smtp.host || '';
    $('#f-smtp-port').value = smtp.port || 465;
    $('#f-smtp-user').value = smtp.user || '';
    $('#f-smtp-to').value = (smtp.to || []).join(', ');
    $('#f-smtp-pass').value = '';
    $('#f-smtp-pass').placeholder = smtp.password ? '已保存，留空表示不修改' : '授权码';
    $('#key-note').textContent = st.key && st.key.present
      ? `已提供 ${esc(st.key.masked)} · 保存在本机数据目录，不会随插件分发`
      : '未提供。填入后保存在本机数据目录，不会随插件分发。';
    $('#f-key').placeholder = st.key && st.key.present ? '已保存，留空表示不修改' : '粘贴你的研发平台 API Key';
    $('#excel-badge').textContent = st.excelAvailable ? '已就绪 · 随包自带' : '未安装（可选）';
    $('#excel-badge').className = 'ws-badge' + (st.excelAvailable ? ' ws-badge--ok' : ' ws-badge--warn');
    $('#deps-desc').textContent = st.excelAvailable
      ? '组件已随插件自带，写入 .xlsx 无需联网；纯周报 txt 生成不依赖它。'
      : '未检测到组件。点「检测 / 补装组件」自动安装；纯周报 txt 生成不受影响。';
    $('#btn-install-deps').textContent = st.excelAvailable ? '重新检测组件' : '检测 / 补装组件';
    const perf = st.probe && st.probe.perf;
    $('#perf-note').textContent = perf && perf.count
      ? `已识别 ${perf.count} 张 xlsx，生成时可同步写入。`
      : '未识别到绩效表；提供目录后可同步写入（格式保持不变）。';
    $('#run-tip').textContent = st.key && st.key.present ? '可以开始生成' : '先在「设置」里填写 API Key';
    $('#btn-quick-run').disabled = !(st.key && st.key.present);
    $('#btn-run').disabled = !(st.key && st.key.present);
  }

  // ---------------------------------------------------------------- 模板
  /** 概览预览用的示例数据；真实生成时这些值全部由工单/任务数据替换。 */
  const SAMPLE_ITEM = {
    category: '项目运维', school: '四川传媒学院', time: '2026年11月9日',
    subject: '帆软报表健康巡检异常提示',
    work: 'https://yanfa.scedu.tech/?tab=ticket-detail&ticketId=195',
    note: '无', progress: '100%',
  };

  function renderFormatPreview(template, label) {
    // 用「当前生效模板」渲染，而不是内置模板；未知占位符原样保留，方便发现拼写错误
    const text = String(template || '').replace(/\{\{(\w+)\}\}/g,
      (_, k) => String(SAMPLE_ITEM[k] == null ? `{{${k}}}` : SAMPLE_ITEM[k]));
    $('#format-preview').textContent = text.replace(/\n+$/, '');
    $('#format-source').textContent = label;
  }

  async function loadTemplate() {
    const r = await api('/api/template');
    if (!r.ok) { toast(r.error || '模板读取失败', 'err'); return; }
    S.tplText = r.text;
    $('#f-template').value = r.text;
    const keys = Array.from(new Set((r.text.match(/\{\{\w+\}\}/g) || [])));
    $('#tpl-chips').innerHTML = keys.map((k) => `<span class="ws-chip">${esc(k)}</span>`).join('');
    if (!S.previewReal) renderFormatPreview(r.text, r.builtin ? '内置模板 · 示例值' : '自定义模板 · 示例值');
  }

  /** 切换到最近一份真实周报的首条记录，直观看出字段值不是写死的。 */
  $('#btn-format-real').addEventListener('click', async () => {
    const btn = $('#btn-format-real');
    if (S.previewReal) {
      S.previewReal = false;
      btn.textContent = '看真实数据';
      const t = await api('/api/template');
      if (t.ok) renderFormatPreview(t.text, t.builtin ? '内置模板 · 示例值' : '自定义模板 · 示例值');
      return;
    }
    const list = await api('/api/reports');
    const first = (list.reports || [])[0];
    if (!first) { toast('还没有历史周报，先生成一份再来看', 'warn'); return; }
    const r = await api('/api/report?path=' + encodeURIComponent(first.path));
    if (!r.ok) { toast(r.error || '读取周报失败', 'err'); return; }
    const block = String(r.text).replace(/\r/g, '').trim().split(/\n\s*\n/)[0] || '（这份周报没有内容）';
    $('#format-preview').textContent = block;
    $('#format-source').textContent = '真实周报 · ' + first.name;
    S.previewReal = true;
    btn.textContent = '返回模板示例';
  });

  // ---------------------------------------------------------------- 设置保存
  async function saveSettings() {
    const cfg = {
      mcp_url: $('#f-mcp').value.trim(),
      handler: $('#f-handler').value.trim(),
      out_dir: $('#f-out').value.trim(),
      folder: $('#f-folder').value.trim(),
      perf_template: $('#f-perf-template').value.trim(),
      perf_allow_insert: $('#f-perf-insert').checked,
      threshold: Number($('#f-threshold').value) || 0.85,
      notify: {
        enabled: $('#f-notify').checked,
        smtp: {
          host: $('#f-smtp-host').value.trim(),
          port: Number($('#f-smtp-port').value) || 465,
          ssl: true,
          user: $('#f-smtp-user').value.trim(),
          to: $('#f-smtp-to').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        },
      },
    };
    if ($('#f-smtp-pass').value) cfg.notify.smtp.password = $('#f-smtp-pass').value;
    const key = $('#f-key').value.trim();
    const tpl = $('#f-template').value;
    try {
      if (key) { const r = await post('/api/api-key', { key }); if (!r.ok) throw new Error(r.error || 'Key 保存失败'); $('#f-key').value = ''; }
      if (tpl && S.tplText && tpl !== S.tplText) {
        const r = await post('/api/template', { text: tpl });
        if (!r.ok) throw new Error(r.error || '模板保存失败');
        S.tplText = tpl;
      }
      const r = await post('/api/config', { config: cfg });
      if (!r.ok) throw new Error(r.error || '配置保存失败');
      toast('设置已保存');
      S.previewReal = false;
      $('#btn-format-real').textContent = '看真实数据';
      await loadState();
      await loadTemplate();
    } catch (e) { toast(e.message || '保存失败', 'err'); }
  }

  $('#btn-save').addEventListener('click', () => void saveSettings());
  $('#btn-show-key').addEventListener('click', () => {
    const el = $('#f-key');
    const show = el.type === 'password';
    el.type = show ? 'text' : 'password';
    $('#btn-show-key').textContent = show ? '隐藏' : '显示';
  });
  $('#f-notify').addEventListener('change', () => {
    $('#smtp-box').hidden = !$('#f-notify').checked;
    $('#notify-badge').textContent = $('#f-notify').checked ? '已开启' : '默认关闭';
    $('#notify-badge').className = 'ws-badge' + ($('#f-notify').checked ? ' ws-badge--warn' : '');
    syncSwitchStates();
  });
  $('#btn-test-key').addEventListener('click', async () => {
    toast('正在测试连接…');
    const r = await post('/api/test-key', {});
    toast(r.ok ? `连接正常，识别出 ${r.tools} 个工具` : `连接失败：${r.error || r.detail || '检查 Key 与 MCP 地址'}`, r.ok ? 'ok' : 'err');
  });
  $('#btn-reset-template').addEventListener('click', async () => {
    const r = await post('/api/template/reset', {});
    if (r.ok) { toast('已恢复内置模板'); await loadTemplate(); }
  });
  $('#f-template').addEventListener('input', (e) => {
    const keys = Array.from(new Set((e.target.value.match(/\{\{\w+\}\}/g) || [])));
    $('#tpl-chips').innerHTML = keys.map((k) => `<span class="ws-chip">${esc(k)}</span>`).join('');
  });

  // ---------------------------------------------------------------- 组件 / 复核
  /** 统一的输出面板：带状态、可收起、失败给手动命令。 */
  function showDepsOutput(text, status, ok, hint) {
    $('#deps-output').hidden = false;
    $('#deps-log').textContent = text || '（无输出）';
    const badge = $('#deps-status');
    badge.textContent = status;
    badge.className = 'ws-output__status ' + (ok ? 'is-ok' : 'is-warn');
    const hintBox = $('#deps-hint');
    hintBox.hidden = !hint;
    if (hint) {
      const m = String(hint).match(/cd \/d[^\r\n]*$/);
      $('#deps-command').textContent = m ? m[0] : hint;
    }
    setExpanded($('#btn-deps-collapse'), $('#deps-log'), true, ['展开输出', '收起输出']);
  }
  bindCollapse($('#btn-deps-collapse'), $('#deps-log'), ['展开输出', '收起输出']);
  $('#btn-copy-command').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#deps-command').textContent); toast('已复制命令'); }
    catch { toast('复制失败，请手动选中', 'err'); }
  });

  $('#btn-install-deps').addEventListener('click', async () => {
    const btn = $('#btn-install-deps');
    btn.disabled = true;
    showDepsOutput('正在检测 / 补装绩效表组件…', '处理中', true, '');
    try {
      const r = await post('/api/install-deps', {});
      const text = [r.out || '', r.hint || ''].filter(Boolean).join('\n') || (r.ok ? '组件已就绪。' : '补装未完成。');
      const status = r.mode === 'bundled' ? '组件已自带' : r.ok ? '补装完成' : '未完成';
      showDepsOutput(text, status, Boolean(r.ok && r.available), r.ok ? '' : r.hint);
      toast(r.ok && r.available ? '绩效表组件已就绪' : '补装未完成，请查看输出', r.ok && r.available ? 'ok' : 'warn');
    } catch (e) {
      showDepsOutput(String(e.message || e), '请求失败', false, '请确认面板服务在线');
      toast('补装请求失败', 'err');
    }
    btn.disabled = false;
    await loadState();
  });
  $('#btn-perf-check').addEventListener('click', async () => {
    showDepsOutput('正在复核本月绩效表内容…', '处理中', true, '');
    const r = await post('/api/perf-check', { fix: false });
    showDepsOutput(r.out || r.error || '复核结束', r.ok ? '复核完成' : '未完成', Boolean(r.ok), r.ok ? '' : r.error);
    toast(r.ok ? '复核完成' : (r.error || '复核未完成'), r.ok ? 'ok' : 'warn');
  });

  /**
   * 检测绩效表结构：把「会写哪些格子」摊开给使用者核对。
   * 这一步不写任何文件，纯读取。
   */
  $('#btn-perf-layout').addEventListener('click', async () => {
    const btn = $('#btn-perf-layout');
    const box = $('#perf-layout-output');
    const target = ($('#f-perf-template').value || '').trim();
    const folder = ($('#f-folder').value || '').trim();
    if (!target && !folder) {
      toast('先填写绩效表目录或指定模板文件', 'warn');
      return;
    }
    btn.disabled = true;
    box.hidden = false;
    box.innerHTML = '<div class="ws-output__body"><div class="ws-output__status is-ok">识别中…</div></div>';
    try {
      const q = target ? `?file=${encodeURIComponent(target)}` : `?folder=${encodeURIComponent(folder)}`;
      const r = await api('/api/perf-layout' + q);
      if (!r || !r.ok) {
        box.innerHTML = `<div class="ws-output__body"><div class="ws-output__status is-warn">未能识别</div><pre class="ws-log" style="margin-top:8px">${esc(r && r.error ? r.error : '未知错误')}</pre></div>`;
        toast('未能识别该表格', 'warn');
        return;
      }
      const rows = Object.entries(r.readable || {})
        .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(String(v))}</td></tr>`).join('');
      const warn = (r.missing && r.missing.length)
        ? `<div class="ws-output__status is-warn" style="margin-top:10px">有 ${r.missing.length} 个字段没认出来，已退回默认列：${esc(r.missing.join('、'))}</div>`
        : '';
      box.innerHTML = `
        <div class="ws-output__body">
        <div class="ws-output__status is-ok">已识别 · ${esc(r.sheet || '月度考核')} ·
          明细 ${esc(String(r.rows))} 行，已用 ${esc(String(r.used))} 行</div>
        <table class="ws-kv">${rows}</table>
        ${warn}
        <div class="ws-card__hint" style="margin-top:8px">文件：${esc(r.file || target)}</div>
        </div>`;
      toast('结构识别完成');
      $('#perf-layout-hint').textContent = `已识别 ${Object.keys(r.readable || {}).length} 项位置`;
    } catch (e) {
      box.innerHTML = `<div class="ws-output__body"><div class="ws-output__status is-warn">请求失败</div><pre class="ws-log" style="margin-top:8px">${esc(String(e.message || e))}</pre></div>`;
    }
    btn.disabled = false;
  });

  // ---------------------------------------------------------------- 目录选择
  function openFs(targetId, initial) {
    S.fsTarget = targetId;
    S.fsPath = initial && initial.trim() ? initial.trim() : '';
    void browse(S.fsPath);
    $('#fs-modal').hidden = false;
  }
  async function browse(p) {
    const r = await api('/api/fs?path=' + encodeURIComponent(p || ''));
    if (!r.ok) return;
    S.fsPath = r.path;
    $('#fs-path').value = r.path;
    $('#fs-crumbs').textContent = r.path;
    $('#fs-drives').innerHTML = (r.drives || []).map((d) => `<button class="ws-drive" data-drive="${esc(d)}" type="button">${esc(d)}</button>`).join('');
    $$('#fs-drives [data-drive]').forEach((b) => b.addEventListener('click', () => void browse(b.dataset.drive)));
    const up = r.parent ? `<div class="ws-fs-item ws-fs-item--up" data-dir="${esc(r.parent)}">↑ 上一级</div>` : '';
    $('#fs-list').innerHTML = up + (r.dirs || []).map((d) => `<div class="ws-fs-item" data-dir="${esc(d.path)}">▸ ${esc(d.name)}</div>`).join('');
    $$('#fs-list [data-dir]').forEach((el) => el.addEventListener('click', () => void browse(el.dataset.dir)));
  }
  $$('[data-browse]').forEach((b) => b.addEventListener('click', () => openFs(b.dataset.browse, $('#' + b.dataset.browse).value)));
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => { $('#fs-modal').hidden = true; }));
  $('#fs-ok').addEventListener('click', () => {
    const p = $('#fs-path').value.trim();
    if (!p) { toast('请选择一个目录', 'warn'); return; }
    $('#' + S.fsTarget).value = p;
    $('#fs-modal').hidden = true;
    toast('已填入目录，记得点「保存设置」');
  });
  $('#fs-new').addEventListener('click', async () => {
    const p = $('#fs-path').value.trim();
    if (!p) return;
    const r = await post('/api/fs/mkdir', { path: p });
    if (r.ok) { toast('目录已创建'); await browse(p); }
    else toast(r.error || '创建失败', 'err');
  });

  // ---------------------------------------------------------------- 生成
  $$('#period-seg button').forEach((b) => b.addEventListener('click', () => {
    S.period = b.dataset.period;
    $$('#period-seg button').forEach((x) => x.classList.toggle('is-active', x === b));
    const row = $('#range-row');
    row.hidden = !(S.period === 'range' || S.period === 'month');
    row.classList.toggle('is-month', S.period === 'month');
    if (S.period === 'range') {
      const now = new Date();
      const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
      const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
      const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!$('#range-start').value) $('#range-start').value = iso(mon);
      if (!$('#range-end').value) $('#range-end').value = iso(sun);
    }
    if (S.period === 'month' && !$('#range-month').value) {
      const d = new Date(); $('#range-month').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
  }));

  function runBody() {
    return {
      period: S.period,
      start: $('#range-start').value, end: $('#range-end').value, month: $('#range-month').value,
      perfAuto: $('#opt-perf').checked,
      noCache: $('#opt-nocache').checked,
      noTasks: $('#opt-notasks').checked,
    };
  }

  async function startGenerate() {
    const r = await post('/api/run', runBody());
    if (!r.ok) { toast(r.error || '无法开始生成', 'err'); return; }
    $('#log-card').hidden = false;
    $('#result-card').hidden = true;
    $('#btn-run').disabled = true;
    $('#btn-cancel').hidden = false;
    toast('开始生成…');
    clearInterval(S.runTimer);
    S.runTimer = setInterval(() => void refreshRun(), 1200);
    void refreshRun();
  }

  async function refreshRun() {
    const r = await api('/api/run');
    if (!r || r.ok === false) return;
    if (r.lines && r.lines.length) {
      $('#log-card').hidden = false;
      $('#run-log').textContent = r.lines.join('\n');
      const log = $('#run-log'); log.scrollTop = log.scrollHeight;
    }
    if (r.running) {
      $('#btn-run').disabled = true; $('#btn-cancel').hidden = false;
      $('#run-tip').textContent = '正在生成，请稍候…';
      return;
    }
    clearInterval(S.runTimer); S.runTimer = 0;
    $('#btn-run').disabled = false; $('#btn-cancel').hidden = true;
    if (!r.finishedAt) return;
    const ok = r.exitCode === 0;
    $('#result-card').hidden = false;
    $('#result-badge').textContent = ok ? '完成' : '未完成';
    $('#result-badge').className = 'ws-badge ' + (ok ? 'ws-badge--ok' : 'ws-badge--warn');
    $('#result-path').textContent = r.outPath || r.error || '（没有输出文件）';
    setExpanded($('#btn-view-result'), $('#result-text'), false, ['查看内容', '收起内容']);
    $('#run-tip').textContent = ok ? '生成完成' : (r.error || '生成未成功');
    if (ok) toast('周报已生成'); else toast(r.error || '生成未成功，请查看日志', 'err');
    await loadState();
  }

  $('#btn-run').addEventListener('click', () => void startGenerate());
  $('#btn-quick-run').addEventListener('click', () => { S.period = 'current'; $$('#period-seg button').forEach((x) => x.classList.toggle('is-active', x.dataset.period === 'current')); $('#range-row').hidden = true; switchView('generate'); void startGenerate(); });
  $('#btn-cancel').addEventListener('click', async () => { await post('/api/run/cancel', {}); toast('已请求取消'); });
  bindCollapse($('#btn-toggle-log'), $('#run-log'), ['展开日志', '收起']);
  // 传完整文件路径，资源管理器会直接选中这个周报文件
  $('#btn-open-out').addEventListener('click', () => void openPath($('#result-path').textContent.trim(), '周报文件'));
  $('#btn-view-result').addEventListener('click', async () => {
    const el = $('#result-text');
    if (!el.hidden) { setExpanded($('#btn-view-result'), el, false, ['查看内容', '收起内容']); return; }
    const p = $('#result-path').textContent.trim();
    const r = await api('/api/report?path=' + encodeURIComponent(p));
    if (r.ok) { el.textContent = r.text; setExpanded($('#btn-view-result'), el, true, ['查看内容', '收起内容']); }
    else toast(r.error || '读取失败', 'err');
  });

  // ---------------------------------------------------------------- 历史
  async function loadReports() {
    const r = await api('/api/reports');
    S.reports = r.reports || [];
    renderReports();
  }
  function renderReports() {
    const q = ($('#report-search').value || '').trim().toLowerCase();
    const list = S.reports.filter((r) => !q || r.name.toLowerCase().includes(q));
    $('#report-count').textContent = q
      ? `显示 ${list.length} / ${S.reports.length} 份`
      : `共 ${S.reports.length} 份`;
    $('#report-list').innerHTML = list.length
      ? list.map((r) => `<div class="ws-report-item ${S.selected === r.path ? 'is-active' : ''}" data-path="${esc(r.path)}">
          <div class="ws-report-item__name">${esc(r.name)}</div>
          <div class="ws-report-item__meta">${esc(r.entries)} 条 · ${fmtTime(r.mtime)} · ${esc(r.dir)}</div></div>`).join('')
      : '<div class="ws-empty">没有匹配的周报</div>';
    $$('#report-list [data-path]').forEach((el) => el.addEventListener('click', () => void showReport(el.dataset.path)));
  }
  function setReportExpanded(expanded) {
    setExpanded($('#btn-toggle-report'), [$('#report-text'), $('#report-actions')], expanded, ['展开内容', '收起内容']);
    // 收起后让详情区不再撑满剩余高度，避免留下一大块空白
    $('#report-detail').classList.toggle('is-collapsed', !expanded);
  }
  async function showReport(p) {
    const r = await api('/api/report?path=' + encodeURIComponent(p));
    if (!r.ok) { toast(r.error || '读取失败', 'err'); return; }
    S.selected = p;
    $('#report-empty').hidden = true;
    $('#report-detail').hidden = false;
    $('#report-meta').textContent = r.path;
    $('#report-text').textContent = r.text;
    $('#report-text').scrollTop = 0;
    setReportExpanded(true);
    renderReports();
  }
  $('#btn-toggle-report').addEventListener('click', () => setReportExpanded($('#report-text').hidden));
  $('#report-search').addEventListener('input', renderReports);
  $('#btn-repair-reports').addEventListener('click', async () => {
    const btn = $('#btn-repair-reports');
    btn.disabled = true;
    try {
      const r = await post('/api/reports/repair', {});
      if (!r.ok) { toast(r.error || '检查失败', 'err'); return; }
      if (r.fixed) {
        toast(`已修复 ${r.fixed} 处被切断的记录（原文件已备份）`);
        await loadReports();
        if (S.selected) await showReport(S.selected);
      } else toast(`已检查 ${r.scanned} 份周报，格式都正常`);
    } finally { btn.disabled = false; }
  });
  $('#btn-open-report-dir').addEventListener('click', () => void openPath(S.selected, '周报文件'));
  $('#btn-copy-report').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#report-text').textContent); toast('已复制全文'); }
    catch { toast('复制失败，请手动选中', 'err'); }
  });

  // ---------------------------------------------------------------- 其它入口
  bindCollapse($('#btn-toggle-format'), $('#format-preview'), ['展开', '收起']);
  $('#btn-go-settings').addEventListener('click', () => switchView('settings'));
  $('#btn-all-reports').addEventListener('click', () => switchView('history'));
  $('#btn-open-data').addEventListener('click', () => {
    if (S.state && S.state.dataDir) void openPath(S.state.dataDir, '数据目录');
    else toast('数据目录尚未就绪', 'warn');
  });
  $('#opt-perf').addEventListener('change', () => {
    if ($('#opt-perf').checked && S.state && !S.state.excelAvailable) toast('绩效表写入需要先在「设置」里补装组件', 'warn');
  });

  // ---------------------------------------------------------------- 启动
  const initial = new URL(location.href).searchParams.get('view');
  if (initial && ['overview', 'generate', 'settings', 'history'].includes(initial)) switchView(initial);
  void loadState();
  void loadTemplate();
  setInterval(() => { if (!S.runTimer) void loadState(); }, 20000);
})();
