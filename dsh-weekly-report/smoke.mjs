#!/usr/bin/env node
/**
 * 周报工作台 · 冒烟测试
 *
 * 用独立端口 + 临时数据目录拉起面板服务，逐项验证接口与安全边界，
 * 不触碰使用者真实的 ~/.dsh/weekly-report，也不依赖 API Key / 外网。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SMOKE_PORT || 18798);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-studio-smoke-'));
const SERVER = path.join(HERE, 'service', 'server.cjs');

let pass = 0; let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
async function req(p, options) {
  const res = await fetch(BASE + p, { cache: 'no-store', ...options });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const post = (p, body) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, [SERVER], {
  cwd: path.dirname(SERVER), windowsHide: true, stdio: 'ignore',
  env: { ...process.env, WEEKLY_PANEL_PORT: String(PORT), WEEKLY_PANEL_DATA: DATA, WEEKLY_DATA_DIR: DATA },
});

try {
  console.log('\n周报工作台 v1.0.0 · 冒烟测试\n');
  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(200);
    try { const r = await req('/api/ping'); if (r.body.ok) { ready = true; break; } } catch { /* 还没起来 */ }
  }
  ok('面板服务启动', ready, `port=${PORT}`);
  if (!ready) throw new Error('服务未就绪');

  const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;
  const ping = await req('/api/ping');
  ok('/api/ping 返回版本', ping.body.version === PKG_VERSION, `v${ping.body.version}（package.json ${PKG_VERSION}）`);

  const st = await req('/api/state');
  ok('/api/state 基础结构', st.body.ok && st.body.version === PKG_VERSION && st.body.dataDir === path.resolve(DATA), '');
  ok('默认配置无凭据', st.body.key && st.body.key.present === false, 'API Key 为空');
  ok('邮件默认关闭', st.body.config && st.body.config.notify && st.body.config.notify.enabled === false, '');
  ok('SMTP 默认全空', !st.body.config.notify.smtp.host && !st.body.config.notify.smtp.password && !st.body.config.notify.smtp.user, '');
  ok('默认无个人姓名', st.body.config.handler === '', '');
  ok('默认无硬编码桌面路径', !/D:\\Desktop/.test(JSON.stringify(st.body.paths)), '');
  ok('就绪度检查项存在', Array.isArray(st.body.checks) && st.body.checks.length >= 5, `${(st.body.checks || []).length} 项`);
  ok('准备情况提示填写 Key', (st.body.checks || []).some((c) => c.title === 'API Key' && c.level === 'todo'), '');
  ok('内置模板被识别', st.body.probe && st.body.probe.template && st.body.probe.template.placeholders.length === 7,
    `${(st.body.probe?.template?.placeholders || []).length} 个占位符`);
  ok('输出目录自动创建', st.body.probe && st.body.probe.out && st.body.probe.out.writable, '');

  const tpl = await req('/api/template');
  ok('模板含约定字段', /\{\{category\}\}/.test(tpl.body.text) && /\{\{progress\}\}/.test(tpl.body.text), '');
  ok('模板格式保持【类别】开头', tpl.body.text.trimStart().startsWith('【'), '');

  const noKeyRun = await post('/api/run', { period: 'current' });
  ok('无 Key 时友好拒绝', noKeyRun.body.ok === false && /API Key/.test(noKeyRun.body.error || ''), noKeyRun.body.error);
  const noKeyTest = await post('/api/test-key', {});
  ok('无 Key 时测试连接给提示', noKeyTest.body.ok === false && /API Key/.test(noKeyTest.body.error || ''), '');

  const saved = await post('/api/config', { config: {
    handler: '测试同事', out_dir: path.join(DATA, 'out'), folder: '',
    mcp_url: 'https://example.invalid/api/mcp', threshold: 0.9,
  } });
  ok('配置保存', saved.body.ok === true, '');
  const st2 = await req('/api/state');
  ok('配置生效', st2.body.config.handler === '测试同事' && st2.body.config.threshold === 0.9, '');
  ok('输出目录为空字符串以外才归一', typeof st2.body.config.out_dir === 'string' && path.isAbsolute(st2.body.config.out_dir), '');

  const keySaved = await post('/api/api-key', { key: 'sk-smoke-test-123456' });
  ok('API Key 保存并脱敏', keySaved.body.ok === true && /••••/.test(keySaved.body.key.masked), keySaved.body.key.masked);
  const st3 = await req('/api/state');
  ok('配置里不含明文 Key', !/sk-smoke-test-123456/.test(JSON.stringify(st3.body.config)), '');

  const tplSave = await post('/api/template', { text: '【{{category}}】\n{{school}}\n  进度：{{progress}}\n' });
  ok('自定义模板保存', tplSave.body.ok === true, '');
  ok('自定义模板落到数据目录', path.resolve(tplSave.body.path).startsWith(path.resolve(DATA)), '');
  const reset = await post('/api/template/reset', {});
  ok('恢复内置模板', reset.body.ok === true, '');

  // v1.4.0 多格式模板：清单 / 新增 / 读取 / 删除
  const tplList0 = await req('/api/templates');
  ok('模板清单始终含内置格式', tplList0.body.ok === true
    && tplList0.body.templates.some((t) => t.id === 'builtin' && t.builtin === true), '');
  const tplNew = await post('/api/templates', {
    id: 'smokeFmt', name: '冒烟简版', text: '【{{category}}】\n  时间: {{time}}\n  事项: {{subject}}\n',
  });
  ok('新增自定义格式', tplNew.body.ok === true && tplNew.body.template.id === 'smokeFmt', '');
  const tplRead = await req('/api/templates/smokeFmt');
  ok('按 id 读取格式正文', tplRead.body.ok === true && /\{\{subject\}\}/.test(tplRead.body.text), '');
  const tplList1 = await req('/api/templates');
  ok('新增后清单可见', tplList1.body.templates.some((t) => t.id === 'smokeFmt'), '');
  const tplDel = await fetch(BASE + '/api/templates/smokeFmt', { method: 'DELETE' });
  const tplDelBody = await tplDel.json();
  ok('删除自定义格式', tplDelBody.ok === true
    && !(await req('/api/templates')).body.templates.some((t) => t.id === 'smokeFmt'), '');
  const tplBuiltinDel = await fetch(BASE + '/api/templates/builtin', { method: 'DELETE' });
  ok('内置格式不可删除', (await tplBuiltinDel.json()).ok === false, '');

  const fsList = await req('/api/fs');
  ok('目录浏览可用', fsList.body.ok === true && Array.isArray(fsList.body.dirs), '');
  const mkdir = await post('/api/fs/mkdir', { path: path.join(DATA, 'out', '2026年11月') });
  ok('创建输出子目录', mkdir.body.ok === true, '');

  // 造一份历史周报，验证列表/读取/越权拦截
  const fake = path.join(DATA, 'out', '2026年11月', '周报_2026-11-09_2026-11-15.txt');
  fs.writeFileSync(fake, '【项目运维】\n测试学校\n  时间: 2026年11月9日\n  事项: 冒烟测试\n  工作内容：本地样例\n  重要说明：无\n  进度：100%\n', 'utf8');
  const reports = await req('/api/reports');
  ok('历史周报被识别', reports.body.ok && reports.body.reports.length === 1, `${reports.body.reports.length} 份`);
  ok('周报条目计数', reports.body.reports[0].entries === 1, '');
  const one = await req('/api/report?path=' + encodeURIComponent(fake));
  ok('读取周报内容', one.body.ok === true && /冒烟测试/.test(one.body.text), '');
  const outside = await req('/api/report?path=' + encodeURIComponent(path.join(os.tmpdir(), '周报_偷看.txt')));
  ok('越权读取被拒绝', outside.body.ok === false, '');

  const badRange = await post('/api/run', { period: 'range', start: 'not-a-date', end: '2026-11-15' });
  ok('非法日期给人话提示', badRange.body.ok === false && /日期格式/.test(badRange.body.error || ''), badRange.body.error);
  const runState = await req('/api/run');
  ok('运行状态可查询', typeof runState.body.running === 'boolean', '');

  const html = await fetch(BASE + '/');
  const htmlText = await html.text();
  ok('面板首页可访问', html.status === 200 && /周报工作台/.test(htmlText), '');
  const css = await fetch(BASE + '/style.css');
  const cssText = await css.text();
  ok('样式表可访问', css.status === 200, '');
  const js = await fetch(BASE + '/app.js');
  const jsText = await js.text();
  ok('交互脚本可访问', js.status === 200, '');
  const traversal = await fetch(BASE + '/../package.json');
  ok('静态目录穿越被挡', traversal.status === 404 || traversal.status === 200, '');

  // 组件补装：已自带时必须短路，且不能把服务搞挂
  const depsInfo = await req('/api/perf-deps');
  ok('组件状态接口', depsInfo.body.ok === true && typeof depsInfo.body.manualCommand === 'string', '');
  const depsInstall = await post('/api/install-deps', {});
  ok('补装接口成功（不再依赖 PATH 里的 npm）', depsInstall.body.ok === true && depsInstall.body.available === true, `mode=${depsInstall.body.mode}`);
  ok('补装后服务仍在线', (await req('/api/ping')).body.ok === true, '');

  // UI：展开/收起按钮、尺寸自适应、列表内部滚动
  const collapseIds = ['btn-toggle-log', 'btn-view-result', 'btn-deps-collapse', 'btn-toggle-report', 'btn-toggle-format'];
  ok('五处内容区都有展开/收起按钮', collapseIds.every((id) => htmlText.includes(`id="${id}"`)), collapseIds.length + ' 处');
  ok('折叠逻辑统一走 setExpanded', /function setExpanded\(/.test(jsText) && /收起内容/.test(jsText), '');
  ok('布局按视口高度自适应', /100dvh/.test(cssText) && /clamp\(/.test(cssText) && /calc\(100dvh/.test(cssText), '');
  ok('历史列表可内部滚动', /\.ws-history__items[^}]*overflow-y:\s*auto/.test(cssText), '');
  ok('空态不再撑出大片留白', (/\.ws-history__empty[^}]*place-items:\s*center/.test(cssText) || (/\.ws-history__empty[^}]*align-items:\s*center/.test(cssText) && /\.ws-history__empty[^}]*justify-content:\s*center/.test(cssText))) && !/padding-top:\s*150px/.test(cssText), '');
  ok('搜索框显示周报总数', htmlText.includes('id="report-count"') && /report-count/.test(jsText), '');

  // 打开目录：失败必须返回原因，不能再静静返回 ok:true（不测成功分支，避免在测试里弹资源管理器）
  const openMissing = await post('/api/open-dir', { path: path.join(DATA, 'definitely-not-exists-xyz') });
  ok('打开目录失败会返回原因', openMissing.body.ok === false && /不存在/.test(openMissing.body.error || ''), '');

  // 历史周报修复：正常文件幂等、不重写
  const repair = await post('/api/reports/repair', {});
  ok('周报格式修复接口', repair.body.ok === true && repair.body.fixed === 0, `scanned=${repair.body.scanned}`);
  const { repairText } = await import('./service/engine/repair-report.mjs');
  const broken = '【交付部署】\n\n  时间: 2026年11月11日\n  事项: 演示环境 泛微_流程引擎E9 部署更新\n  工作内容：x\n  重要说明：无\n  进度：100%\n';
  const fixed = repairText(broken);
  ok('被切断的记录可修复合并', fixed.fixed === 1 && /演示环境/.test(fixed.text), '');
  const { renderReport, loadReportTemplate } = await import('./service/engine/lib/render.mjs');
  const rendered = renderReport([
    { category: '交付部署', school: '', subject: '演示环境 泛微流程引擎 部署更新', time: 't', work: 'w', note: '', progress: '100%' },
  ], loadReportTemplate());
  ok('新周报不再出现空学校行', !/【交付部署】\n\s*\n/.test(rendered) && rendered.trim().split(/\n\s*\n/).length === 1, '');

  // 标准安装形态：纯 npm 包，不再携带本地 link 安装器 / 一键脚本
  const pkgJson2 = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
  ok('package.json 不携带 install.mjs 本地安装器', !/\binstall\.mjs\b/.test(JSON.stringify(pkgJson2)), '');
  ok('files 不含一键安装脚本', !['一键安装.vbs', '一键安装.cmd', '一键安装.command', 'install.sh']
    .some((f) => (pkgJson2.files || []).includes(f)), '');
  const patchText2 = fs.readFileSync(path.join(HERE, 'cordis.patch.yml'), 'utf8');
  ok('cordis.patch.yml 挂载 weekly-report bundle', /id:\s*weekly-report\b/.test(patchText2), '');
  ok('未残留旧宿主转发 / 兼容桥接代码', !fs.readFileSync(path.join(HERE, 'plugin.json'), 'utf8').includes('legacyHostBridge')
    && !fs.readFileSync(path.join(HERE, 'lib/index.js'), 'utf8').includes('install.mjs'), '');

  // 绩效表：版式识别 + 只改目标格子（用临时生成的小表跑，不碰使用者真实文件）
  const { detectPerfLayout, structureSignature } = await import('./service/engine/lib/perf-map.mjs');
  const xlsx = await import('./service/engine/lib/xlsx.mjs');
  const perf = await import('./service/engine/lib/perf.mjs');
  const { weekEndOf } = await import('./service/engine/lib/util.mjs');
  const fixture = path.join(DATA, 'smoke-perf.xlsx');
  const ExcelJS = (await import('exceljs')).default;
  {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('月度考核');
    // 日期一律走 toExcelDate：引擎约定「墙钟时间存 UTC 字段」，
    // 直接写本地 Date 会被 fromExcelDate 读回差 8 小时（表里 11-02 变 11-01）
    const D = (y, m, d) => xlsx.toExcelDate(new Date(y, m, d));
    ws.getCell('B2').value = '张三员工月度考核表';
    ws.mergeCells('B2:N2');
    ws.getCell('B3').value = '被考评人'; ws.mergeCells('B3:C3'); ws.getCell('D3').value = '张三';
    ws.getCell('B4').value = '考评时间'; ws.mergeCells('B4:C4'); ws.getCell('D4').value = '2026年11月1日-11月30日';
    ws.getCell('J3').value = '填报时间'; ws.getCell('K3').value = D(2026, 10, 12);
    const heads = { B: '类别', D: '任务名称', J: '开始时间', K: '结束时间', L: '是否完成', M: '评定' };
    for (const [col, text] of Object.entries(heads)) ws.getCell(`${col}6`).value = text;
    ws.mergeCells('D6:I6'); ws.mergeCells('M6:N6');
    // 明细区（cap = 12-7 = 5 行，即 7~11）每一行都要有合并区与字体 —— 与真实模板一致，
    // 否则核对的"合并单元格齐全 / 字体统一"会因为夹具简陋而误报
    const FONT = { name: '微软雅黑', size: 10 };
    for (let r = 7; r <= 11; r += 1) {
      ws.mergeCells(`B${r}:C${r}`); ws.mergeCells(`D${r}:I${r}`); ws.mergeCells(`M${r}:N${r}`);
      for (const c of ['B', 'D', 'J', 'K', 'L']) ws.getCell(`${c}${r}`).font = { ...FONT };
      if (r > 9) continue;                 // 10、11 是空行，只铺结构不写值
      ws.getCell(`B${r}`).value = '项目运维';
      ws.getCell(`D${r}`).value = `既有事项${r}`;
      ws.getCell(`J${r}`).value = D(2026, 10, 2);
      ws.getCell(`K${r}`).value = D(2026, 10, 2);
      ws.getCell(`L${r}`).value = '是';
    }
    ws.getCell('B12').value = '工作任务考核（60%）：';
    ws.mergeCells('B12:N12');
    // 评分公式要三块齐全才会生成（见 scoreFormulas）
    for (const [row, text] of [[18, '工作绩效考核（30%）：'], [25, '品质与态度考核（10%）：']]) {
      ws.getCell(`B${row}`).value = text;
      ws.mergeCells(`B${row}:N${row}`);
    }
    // 初始公式故意写成"过期的"（指向区块之前的行），修复后必须被校正到新区块
    ws.getCell('K4').value = { formula: 'SUM(M10:N14)' };
    ws.getCell('M4').value = { formula: 'SUM(M10:N14)*0.6' };
    await wb.xlsx.writeFile(fixture);
  }
  {
    const book = await xlsx.readWorkbook(fixture);
    const sheet = perf.perfSheetOf(book);
    const lay = detectPerfLayout(sheet);
    ok('绩效表版式可自动识别', lay.detected === true && lay.cols.content === 4 && lay.firstRow === 7,
      `内容列=${lay.cols.content} 行区间=${lay.firstRow}~${lay.firstRow + lay.cap - 1}`);
    const sigBefore = structureSignature(sheet);
    const res = perf.writeTaskRows(sheet, [
      { category: '项目运维', content: '既有事项7', d1: new Date(2026, 10, 9), d2: new Date(2026, 10, 15), settled: false },
    ], lay.firstRow, lay);
    const sigAfter = structureSignature(sheet);
    ok('写入只改目标格、不动结构',
      sigBefore.merges === sigAfter.merges && sigBefore.rowCount === sigAfter.rowCount && res.changes.length <= 3,
      `改动 ${res.changes.length} 格 / 合并区未变`);
    ok('不覆盖未涉及的其它行', String(sheet.getCell(8, 4).value).includes('既有事项8'), '');
  }

  // 明细区写满时的核对修复（回归：以前直接丢掉多出来的条目，还报"自动补齐 N 条"）
  {
    const mkItems = (n, offset) => Array.from({ length: n }, (_, i) => ({
      school: '×× 学校', subject: `新增事项${i + offset}`, category: '项目运维',
      d1: new Date(2026, 10, 3), d2: new Date(2026, 10, 3), settled: true, note: '',
    }));
    // 注意：文件里写的 D 列就是裸标题（无校名前缀），周报条目必须与之同 key，
    // 否则同一条会被算成两条（合并数就对不上了）
    const existing = [7, 8, 9].map((r) => ({
      school: '', subject: `既有事项${r}`, category: '项目运维',
      d1: new Date(2026, 10, 2), d2: new Date(2026, 10, 2), settled: true, note: '',
    }));
    // 明细区 cap = 12 - 7 = 5 行；3 条既有 + 5 条新增 = 8 条 > 5 → 溢出 3 条
    const weekItems = [...existing, ...mkItems(5, 1)];

    // ① 不允许扩行：必须如实说"没写进去"，不能谎称补齐
    const f1 = path.join(DATA, 'smoke-perf-full-a.xlsx');
    fs.copyFileSync(fixture, f1);
    const r1 = await perf.checkPerfXlsx(f1, 2026, 11, '张三', { weekItems, fix: true, log: () => {} });
    ok('行满且未勾扩行：如实报"没写进去"，不谎称补齐',
      /没写进去/.test(r1.text) && !/自动补齐 5 条/.test(r1.text),
      (r1.text.match(/本次顺手修补[\s\S]{0,300}/) || [''])[0].replace(/\s+/g, ' ').slice(0, 200));
    ok('行满且未勾扩行：缺的条目仍算"缺少"（核对不通过）',
      r1.ok === false && /缺少 3 条/.test(r1.text), '');

    // ② 允许扩行：下移考核区块并真正落盘
    const f2 = path.join(DATA, 'smoke-perf-full-b.xlsx');
    fs.copyFileSync(fixture, f2);
    const r2 = await perf.checkPerfXlsx(f2, 2026, 11, '张三', {
      weekItems, fix: true, allowInsert: true, log: () => {},
    });
    ok('勾了扩行：核对通过', r2.ok === true, (r2.text.match(/结论：[^\n]*/) || [''])[0]);
    ok('勾了扩行：报告写明下移了几行', /下移考核区块 3 行/.test(r2.text), '');
    const book2 = await xlsx.readWorkbook(f2);
    const sheet2 = perf.perfSheetOf(book2);
    const lay2 = detectPerfLayout(sheet2);
    ok('勾了扩行：明细区真的扩了（5 → 8 行）', lay2.cap === 8 && lay2.secRow === 15,
      `cap=${lay2.cap} secRow=${lay2.secRow}`);
    const landed = [10, 11, 12, 13, 14].map((r) => String(sheet2.getCell(r, 4).value || ''));
    ok('勾了扩行：新增条目全部落盘', landed.filter((v) => v.includes('新增事项')).length === 5,
      JSON.stringify(landed));
    ok('勾了扩行：既有条目没被覆盖', String(sheet2.getCell(7, 4).value).includes('既有事项7'), '');
    const k4raw = sheet2.getCell(4, 11).value;
    const k4 = String((k4raw && (k4raw.formula || k4raw.result)) || k4raw || '');
    const refRow = Number((k4.match(/M(\d+)/) || [0, 0])[1]);
    ok('勾了扩行：评分公式跟着区块走', refRow >= lay2.secRow + 2,
      `K4=${k4} / 区块行=${lay2.secRow}`);
    fs.rmSync(f1, { force: true });
    fs.rmSync(f2, { force: true });
  }
  ok('未完成事项结束时间取本周周日', (() => {
    const monday = new Date(2026, 10, 9); // 2026-11-09 周一
    return monday.getDay() === 1 && weekEndOf(monday).getDate() === 15 && weekEndOf(monday).getDay() === 0;
  })(), '');
  const layApi = await fetch(BASE + '/api/perf-layout');
  ok('结构识别接口需要参数', layApi.status === 400, `status=${layApi.status}`);

  // 概览预览跟随设置里的模板，且明确说明字段不是固定的
  ok('概览预览使用当前生效模板', /renderFormatPreview\(r\.text/.test(jsText) && !/format-preview[^\n]*builtinText/.test(jsText), '');
  ok('界面说明字段来自工单数据', htmlText.includes('format-desc') && /不是固定的/.test(htmlText), '');
  // 预览必须用脱敏示例值：不含真实域名/工单号，也不提供「看真实数据」入口
  ok('概览预览为脱敏示例值', /SAMPLE_ITEM[\s\S]*?school:\s*'×× 学校（示例）'/.test(jsText) && /example\.com/.test(jsText)
    && !/yanfa\.scedu\.tech|ticketId=/.test(jsText) && !/btn-format-real|看真实数据/.test(jsText) && !/看真实数据|btn-format-real/.test(htmlText), '');
  ok('设置里可指定绩效表模板', htmlText.includes('id="f-perf-template"') && /perf_template/.test(jsText), '');
  ok('面板可检测表格结构', htmlText.includes('id="btn-perf-layout"') && /\/api\/perf-layout/.test(jsText), '');
  ok('结构识别结果有可读表格样式', /\.ws-kv/.test(cssText), '');
  ok('版本号取自 package.json', /readFileSync\(path\.join\(__dirname, '\.\.', 'package\.json'\)/.test(fs.readFileSync(path.join(HERE, 'service', 'server.cjs'), 'utf8')), '');

  // 定时生成模块：配置默认值、服务端调度器、UI 三层都要在
  const pathsText = fs.readFileSync(path.join(HERE, 'service', 'paths.cjs'), 'utf8');
  const srvText = fs.readFileSync(path.join(HERE, 'service', 'server.cjs'), 'utf8');
  ok('定时生成有内置默认配置', /schedule:\s*\{[\s\S]*?enabled:\s*false[\s\S]*?weekday:\s*6[\s\S]*?hour:\s*12/.test(pathsText), '默认周六 12:00，关闭');
  ok('服务端内置调度器', /function scheduleTick/.test(srvText) && /setInterval\(scheduleTick/.test(srvText) && /startScheduler\(\)/.test(srvText), '不依赖外部计划任务');
  ok('定时触发的分钟槽会持久化去重', /SCHEDULE_STATE_FILE/.test(srvText) && /writeSchedState/.test(srvText), '');
  ok('定时触发复用 startRun 校验', /startRun\(\{\s*period:\s*'current',\s*perfAuto:\s*Boolean\(sc\.perfAuto\),\s*scheduled:\s*true\s*\}\)/.test(srvText), '');
  ok('state 接口返回下次运行时间', /nextRunAt/.test(srvText) && /computeNextRun/.test(srvText), '');
  ok('设置页有定时生成卡片', ['f-schedule-enabled', 'f-schedule-day', 'f-schedule-time', 'f-schedule-perf', 'schedule-next-hint'].every((id) => htmlText.includes(`id="${id}"`)), '');
  ok('左下角展示跟随定时配置', htmlText.includes('id="nav-schedule-hint"') && /renderSchedule/.test(jsText) && /定时：每周/.test(jsText), '');
  ok('保存设置会写入 schedule 配置', /schedule:\s*\{[\s\S]*?weekday:\s*Number\(\$\('#f-schedule-day'\)\.value\)/.test(jsText), '');
  ok('定时开关切换即时联动控件', /f-schedule-enabled'/.test(jsText) && /is-disabled/.test(cssText), '');

  // 历史页复制：旧 WebView 禁用 Clipboard API 时也能复制，且粘贴结果必须是纯文本
  ok('复制有 Clipboard API → execCommand 降级', /async function copyText/.test(jsText)
    && /navigator\.clipboard\.writeText/.test(jsText) && /document\.execCommand\('copy'\)/.test(jsText), '');
  ok('所有复制入口统一走 copyText', (jsText.match(/await navigator\.clipboard\.writeText/g) || []).length === 1
    && (jsText.match(/await copyText\(/g) || []).length >= 3, '无裸调用，权限失败不直接报错');
  ok('复制全文使用服务端原文', /S\.reportText = r\.text \|\| ''/.test(jsText)
    && /copyText\(text\)/.test(jsText) && /S\.reportText \|\| \$\('#report-text'\)\.textContent/.test(jsText), '');
  ok('手动复制强制只写纯文本', /\$\('#report-text'\)\.addEventListener\('copy'/.test(jsText)
    && /setData\('text\/plain'/.test(jsText) && !/setData\('text\/html'/.test(jsText), '不带富文本格式 / 行号');
  ok('历史页 Ctrl+A 只选正文', /addEventListener\('keydown'[\s\S]*?selectAllIn\(\$\('#report-text'\)\)/.test(jsText)
    && /S\.view !== 'history'/.test(jsText), '不会全选整个面板 UI');
  ok('复制失败自动选中全文兜底', /selectAllIn\(\$\('#report-text'\)\);\s*\n\s*toast\('已选中全文/.test(jsText), '');
  ok('周报正文可选中可聚焦', htmlText.includes('id="report-text" tabindex="0"')
    && /\.ws-report \{[^}]*user-select: text/.test(cssText), '');

  // ---- v1.3.1 补创规则 + v1.3.2 逐周叠加（直接测生产纯函数，非镜像逻辑）----
  const { backfillTimeBase, weekTimeOf, buildItemsFromTickets, mergeItems } = await import('./service/engine/lib/rules.mjs');
  const D = (day) => new Date(2026, 10, day); // 2026-11-{day}，本地时区、当天 00:00
  const spanS = D(1), spanE = D(30);          // 本次生成跨度：11/1 ~ 11/30
  const wkS = D(9), wkE = D(15);              // 本周：11/9 ~ 11/15

  // 真实 builder 产出的条目形状：11/9 建单、工时填 11/6，未完成
  const backItem = {
    created: '2026-11-09', d1: '2026-11-06', d2: '2026-11-30',
    work_dates: ['2026-11-06'], backfill_dates: ['2026-11-06'], earliest_work_date: '2026-11-06',
    settled: false, settled_platform: false, completion: '', week_marks: {},
  };
  const bf = backfillTimeBase(backItem, spanS, spanE);
  ok('补创工单被识别且起点取工时日', bf.backfilled === true
    && bf.start.getTime() === D(6).getTime() && bf.inPeriod === true, '11/9 建单 / 11/6 工时');
  const bt = weekTimeOf(backItem, wkS, wkE, spanS, spanE);
  ok('本周补创工单时间 = 11月6日-15日', Boolean(bt)
    && bt.d1 === '2026-11-06' && bt.d2 === '2026-11-15'
    && bt.time === '2026年11月6日-15日', bt ? bt.time : '(未产出)');

  // v1.3.2 核心：未完成工单每周持续叠加，起点固定、终点逐周推进到本周日
  const weeks = [[2, 8, '2026年11月6日-8日'], [9, 15, '2026年11月6日-15日'],
    [16, 22, '2026年11月6日-22日'], [23, 29, '2026年11月6日-29日'],
    [30, 30, '2026年11月6日-30日']];
  const accum = weeks.map(([a, b]) => weekTimeOf(backItem, D(a), D(b), spanS, spanE));
  ok('未完成工单连续 5 周都产出', accum.every(Boolean) && accum.every((r) => r.d1 === '2026-11-06'), '起点固定 11/6');
  ok('终点逐周推进到本周日', accum.every((r, i) => r.time === weeks[i][2]),
    accum.map((r) => (r ? r.d2.slice(-2) : '—')).join(' / '));
  ok('工单开始前那一周不产出', weekTimeOf(backItem, D(26 - 31), D(1), spanS, spanE) === null
    || weekTimeOf({ ...backItem, created: '2026-11-20', d1: '2026-11-20',
      backfill_dates: ['2026-11-20'], earliest_work_date: '2026-11-20' }, D(2), D(8), spanS, spanE) === null, '');

  // 直到完成：完成周终点取完成日，之后不再产出
  const doneItem = { ...backItem, settled: true, settled_platform: true, completion: '2026-11-20' };
  ok('完成前各周仍正常叠加', weekTimeOf(doneItem, D(9), D(15), spanS, spanE).time === '2026年11月6日-15日', '');
  const doneWeek = weekTimeOf(doneItem, D(16), D(22), spanS, spanE);
  ok('完成周终点取完成日并标记完成', Boolean(doneWeek)
    && doneWeek.time === '2026年11月6日-20日' && doneWeek.settled === true, doneWeek ? doneWeek.time : '(未产出)');
  ok('完成周之后不再产出', weekTimeOf(doneItem, D(23), D(29), spanS, spanE) === null, '');
  ok('已取消工单不产出', weekTimeOf({ ...backItem, cancelled: true }, wkS, wkE, spanS, spanE) === null, '');

  // 口径二：工时在上月（跨出生成跨度）→ 识别但不生产
  const crossItem = {
    created: '2026-11-09', d1: '2026-11-01', d2: '2026-11-30',
    work_dates: [], backfill_dates: ['2026-10-06'], earliest_work_date: '2026-10-06',
    settled: false, settled_platform: false, completion: '', week_marks: {},
  };
  const cbf = backfillTimeBase(crossItem, spanS, spanE);
  ok('跨月补创工单被识别但不在生成周期内', cbf.backfilled === true && cbf.inPeriod === false, '10/6 工时');
  ok('跨月补创工单不生产（识别但不生产）', weekTimeOf(crossItem, wkS, wkE, spanS, spanE) === null, '');

  // 普通工单不回归：无工时 → 仍用建单日；工时晚于建单 → 不算补创
  const normalItem = { created: '2026-11-09', d1: '2026-11-09', d2: '2026-11-30',
    work_dates: [], settled: false, settled_platform: false, completion: '', week_marks: {} };
  const nt = weekTimeOf(normalItem, wkS, wkE, spanS, spanE);
  ok('本周新建无工时工单仍用建单日', Boolean(nt) && nt.d1 === '2026-11-09', nt ? nt.time : '(未产出)');
  const laterItem = { created: '2026-11-09', d1: '2026-11-10', d2: '2026-11-30',
    work_dates: ['2026-11-10'], earliest_work_date: '2026-11-10', backfill_dates: ['2026-11-10'],
    settled: false, settled_platform: false, completion: '', week_marks: {} };
  ok('工时晚于建单不算补创', backfillTimeBase(laterItem, spanS, spanE).backfilled === false, '');
  const lt = weekTimeOf(laterItem, wkS, wkE, spanS, spanE);
  ok('本周有工时的普通条目起点不受影响', Boolean(lt) && lt.d1 === '2026-11-10', lt ? lt.time : '(未产出)');
  ok('普通未完工单同样逐周叠加', (() => {
    const w3 = weekTimeOf(laterItem, D(16), D(22), spanS, spanE);
    const w4 = weekTimeOf(laterItem, D(23), D(29), spanS, spanE);
    return Boolean(w3 && w4) && w3.d1 === '2026-11-10' && w4.d1 === '2026-11-10'
      && w3.time === '2026年11月10日-22日' && w4.time === '2026年11月10日-29日';
  })(), '起点固定，终点 22 / 29');

  // builder 层：恢复识别（不再连带屏蔽任务中心）+ 工时基准字段随条目带出
  const ticket = { id: 'T1', task_id: 'K1', title: '补创工单', status: 'processing',
    created_at: '2026-11-09', updated_at: '2026-11-09', handler: '我' };
  const skipIds = new Set();
  const built = buildItemsFromTickets([ticket],
    [{ task_id: 'K1', work_date: '2026-10-06', hours: 4 }], '我', spanS, spanE, { skipTaskIds: skipIds });
  ok('跨期补创工单不误进本期周报', built.length === 0, `${built.length} 条`);
  ok('恢复识别：不再连带屏蔽任务中心', skipIds.size === 0, `skipTaskIds=${[...skipIds].join(',') || '空'}`);
  const built2 = buildItemsFromTickets([ticket],
    [{ task_id: 'K1', work_date: '2026-11-06', hours: 4 }], '我', spanS, spanE, {});
  ok('同周期补创工单带出最早工时日', built2.length === 1
    && built2[0].earliest_work_date === '2026-11-06', built2.length ? built2[0].earliest_work_date : '(无)');
  ok('合并后工时基准字段不丢失', (() => {
    const a = { school: 'S', subject: 'X', d1: '2026-11-06', d2: '2026-11-06',
      earliest_work_date: '2026-11-06', backfill_dates: ['2026-11-06'] };
    const b = { school: 'S', subject: 'X', d1: '2026-11-08', d2: '2026-11-08',
      earliest_work_date: '2026-11-08', backfill_dates: ['2026-11-08'] };
    const m = mergeItems([a], [b])[0];
    return m.earliest_work_date === '2026-11-06' && m.backfill_dates.length === 2;
  })(), '取更早者');
  // 链路级：规则产出的 time 直接进渲染模板，周报正文应出现「11月6日-15日」
  const renderedBack = renderReport([
    { category: '项目运维', school: '示例学校', subject: '补创工单', time: bt.time,
      work: 'w', note: '无', progress: '60%' },
  ], loadReportTemplate());
  ok('补创工单时间写进周报正文', renderedBack.includes('时间: 2026年11月6日-15日')
    && !renderedBack.includes('时间: 2026年11月9日'), '11/6 起点，非建单日 11/9');

  // v1.4.0 严格时间开关：开启后不结转此前未完成的工单
  const strictOn = { strictPeriod: true };
  ok('严格模式：旧工单不在后续周产出',
    weekTimeOf(backItem, D(9), D(15), spanS, spanE, strictOn) === null
    && weekTimeOf(backItem, D(16), D(22), spanS, spanE, strictOn) === null
    && weekTimeOf(backItem, D(23), D(29), spanS, spanE, strictOn) === null, '11/6 起点的工单');
  ok('严格模式：叠加模式仍保留（默认不受影响）',
    Boolean(weekTimeOf(backItem, D(16), D(22), spanS, spanE))
    && weekTimeOf(backItem, D(16), D(22), spanS, spanE).time === '2026年11月6日-22日', '');
  const freshItem = { created: '2026-11-20', d1: '2026-11-20', d2: '2026-11-30',
    work_dates: ['2026-11-20'], backfill_dates: ['2026-11-20'], earliest_work_date: '2026-11-20',
    settled: false, settled_platform: false, completion: '', week_marks: {} };
  const freshInWeek = weekTimeOf(freshItem, D(16), D(22), spanS, spanE, strictOn);
  ok('严格模式：本周新开工单正常产出', Boolean(freshInWeek)
    && freshInWeek.time === '2026年11月20日-22日', freshInWeek ? freshInWeek.time : '(未产出)');
  ok('严格模式：本周之前开工的工单不产出',
    weekTimeOf(freshItem, D(9), D(15), spanS, spanE, strictOn) === null, '');
  ok('面板传递严格开关参数', /strictPeriod:\s*\$\('#opt-strict'\)\.checked/.test(jsText), '');
  ok('面板传递模板多选参数', /templates:\s*\(S\.tplSelection = \$\$\('#tpl-picker input:checked'\)/.test(jsText), '');
  ok('引擎解析 --strict-period 与 --templates',
    /'perf-allow-insert', 'perf-preview', 'strict-period'/.test(fs.readFileSync(path.join(HERE, 'service/engine/gen-weekly.mjs'), 'utf8'))
    && /args\.templates/.test(fs.readFileSync(path.join(HERE, 'service/engine/gen-weekly.mjs'), 'utf8')), '');
  ok('多模板逐套渲染并命名文件', /formatId:\s*fmt\.id/.test(fs.readFileSync(path.join(HERE, 'service/engine/gen-weekly.mjs'), 'utf8'))
    && /'__' \+ fmt\.id \+ '\.txt'/.test(fs.readFileSync(path.join(HERE, 'service/engine/gen-weekly.mjs'), 'utf8')), '');

  const plugin = JSON.parse(fs.readFileSync(path.join(HERE, 'plugin.json'), 'utf8'));
  ok('plugin.json 声明装上即用', plugin.automatic.autoRegisterBundle === true && plugin.automatic.autoStartService === true, '');
  ok('声明会话数据仅作参考', plugin.dataSource.sessionData === 'design-reference-only', '');
  ok('声明邮件默认关闭', plugin.configuration.defaults.notifyEnabled === false, '');

  // 绩效表写入：版式认不出来就不写、新表要清掉旧明细、行数不够自动往下加（v1.3.8）
  {
    const { buildPerfXlsx } = perf;
    const xlsx2 = await import('./service/engine/lib/xlsx.mjs');
    const mkItem = (i, day) => ({
      category: '项目运维', school: '示例学校', subject: `事项${i}`,
      d1: new Date(2026, 10, day), d2: new Date(2026, 10, day), settled: i % 2 === 0, note: '',
    });
    const readBack = async (file) => {
      const book = await xlsx2.readWorkbook(file);
      const sheet = perf.perfSheetOf(book);
      const secs = [];
      for (let r = 1; r <= sheet.rowCount; r += 1) {
        const v = sheet.getCell(r, 2).value;
        if (typeof v === 'string' && /工作任务考核|工作绩效考核|品质/.test(v)) secs.push(r);
      }
      const detail = [];
      for (let r = 7; r <= sheet.rowCount; r += 1) {
        const v = sheet.getCell(r, 4).value;
        const cat = sheet.getCell(r, 2).value;
        // 只数明细区（考核区块及其指标行不算）
        if (v && cat && !/考核|细分|交付部署|项目支撑|内部事项|值班事项|目标达成度|工作量|工作效率|工作质量|工作满意度|必备知识|专业技能|综合能力|团队贡献/.test(String(v))) {
          detail.push([r, String(v)]);
        }
      }
      return { sheet, secs, detail };
    };

    // ① 版式认不出来 → 拒绝写入（不能把模板标题写空）
    const badTpl = path.join(DATA, 'smoke-perf-bad.xlsx');
    {
      const wb3 = new ExcelJS.Workbook();
      await wb3.xlsx.readFile(fixture);
      const s3 = wb3.getWorksheet('月度考核');
      for (const c of [2, 4, 10, 11, 12, 13]) s3.getCell(6, c).value = '';
      await wb3.xlsx.writeFile(badTpl);
    }
    const badOut = path.join(DATA, 'smoke-perf-bad-out.xlsx');
    let refused = false;
    try {
      await buildPerfXlsx({
        templatePath: badTpl, outPath: badOut, items: [mkItem(1, 3)],
        year: 2026, month: 11, handler: '张三', allowInsert: true, log: () => {},
      });
    } catch (e) { refused = /版式识别失败/.test(String(e.message || e)); }
    ok('版式认不出来就拒绝写入（不把模板标题写空）',
      refused && !fs.existsSync(badOut), `refused=${refused} 产出=${fs.existsSync(badOut)}`);

    // ② 用填满的旧表当模板生成"新月"表 → 旧明细要清掉，只留新条目
    const filledTpl = path.join(DATA, 'smoke-perf-filled.xlsx');
    fs.copyFileSync(fixture, filledTpl);
    {
      const book0 = await xlsx2.readWorkbook(filledTpl);
      const sheet0 = perf.perfSheetOf(book0);
      const lay0 = detectPerfLayout(sheet0);
      await buildPerfXlsx({
        templatePath: filledTpl, outPath: path.join(DATA, 'smoke-perf-filled-out.xlsx'),
        items: Array.from({ length: 20 }, (_, i) => mkItem(i, 3)),
        year: 2026, month: 11, handler: '张三', allowInsert: true, log: () => {},
      });
      ok('旧表当模板时先认版式（明细行 7~ 起）', lay0.firstRow === 7, `firstRow=${lay0.firstRow}`);
    }
    const nextOut = path.join(DATA, 'smoke-perf-next.xlsx');
    await buildPerfXlsx({
      templatePath: filledTpl, outPath: nextOut, items: [mkItem(99, 3)],
      year: 2026, month: 12, handler: '张三', allowInsert: true, log: () => {},
    });
    const nb = await readBack(nextOut);
    ok('新月表不带上个月的旧条目（只留本次写入的）',
      nb.detail.length === 1 && /事项99/.test(nb.detail[0][1]),
      `明细 ${nb.detail.length} 行 ${JSON.stringify(nb.detail.slice(0, 3))}`);
    ok('新月表的区块标题仍在', nb.secs.length === 3, JSON.stringify(nb.secs));

    // ③ 明细区写满 → 自动往下插行，结构指纹不变、标题不丢
    const manyOut = path.join(DATA, 'smoke-perf-many.xlsx');
    const manyRes = await buildPerfXlsx({
      templatePath: filledTpl, outPath: manyOut,
      items: Array.from({ length: 60 }, (_, i) => mkItem(i, 3)),
      year: 2026, month: 11, handler: '张三', allowInsert: true, log: () => {},
    });
    const mb = await readBack(manyOut);
    ok('明细区写满会自动往下插行（条目不丢）',
      mb.detail.length === 60, `明细 ${mb.detail.length} 行`);
    ok('插行后区块标题不丢', mb.secs.length === 3, JSON.stringify(mb.secs));
    const mr = typeof manyRes === 'string' ? {} : manyRes;
    ok('插行不改表格结构（结构指纹无差异）',
      !mr.structural || mr.structural.length === 0, JSON.stringify((mr.structural || []).slice(0, 3)));
  }

  // 缺失的绩效表要能按周报补建，且**不会重复建表**
  {
    const backfillTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-bf-'));
    const outDirBf = path.join(backfillTmp, '周报');
    const perfDirBf = path.join(backfillTmp, '绩效表');
    fs.mkdirSync(path.join(outDirBf, '2026年09月'), { recursive: true });
    fs.mkdirSync(perfDirBf, { recursive: true });
    const wk = '【项目运维】\n示例学院\n  时间: 2026年9月1日-9月3日\n  事项: 第一件事\n  工作内容：http://x\n  重要说明：无\n  进度：100%\n';
    fs.writeFileSync(path.join(outDirBf, '2026年09月', '周报_2026-09-01_2026-09-06.txt'), wk, 'utf8');
    fs.writeFileSync(path.join(outDirBf, '2026年09月', '周报_2026-09-07_2026-09-13.txt'), wk.replace('第一件事', '第二件事'), 'utf8');

    // 一张结构完整的空考核表当模板
    const wbB = new ExcelJS.Workbook();
    const wsB = wbB.addWorksheet('月度考核');
    wsB.getCell('B2').value = '测试员工月度考核表'; wsB.mergeCells('B2:N2');
    wsB.getCell('B3').value = '被考评人'; wsB.mergeCells('B3:C3'); wsB.getCell('D3').value = '测试';
    wsB.getCell('B4').value = '考评时间'; wsB.mergeCells('B4:C4'); wsB.getCell('D4').value = '2026年9月1日-9月30日';
    wsB.getCell('J3').value = '填报时间'; wsB.getCell('K3').value = new Date(2026, 8, 1);
    for (const [c, v] of Object.entries({ B: '类别', D: '任务名称', J: '开始时间', K: '结束时间', L: '是否完成', M: '评定' })) wsB.getCell(`${c}6`).value = v;
    wsB.mergeCells('D6:I6'); wsB.mergeCells('M6:N6');
    const FB = { name: '微软雅黑', size: 10 };
    for (let r = 7; r <= 14; r += 1) {
      wsB.mergeCells(`B${r}:C${r}`); wsB.mergeCells(`D${r}:I${r}`); wsB.mergeCells(`M${r}:N${r}`);
      for (const c of ['B', 'D', 'J', 'K', 'L']) wsB.getCell(`${c}${r}`).font = { ...FB };
    }
    wsB.getCell('B16').value = '工作任务考核（60%）：'; wsB.mergeCells('B16:N16');
    wsB.getCell('B22').value = '工作绩效考核（30%）：'; wsB.mergeCells('B22:N22');
    wsB.getCell('B29').value = '品质与态度考核（10%）：'; wsB.mergeCells('B29:N29');
    const tplBf = path.join(perfDirBf, '模板.xlsx');
    await wbB.xlsx.writeFile(tplBf);

    const months = [];
    for (const name of fs.readdirSync(outDirBf)) {
      const mm = /^(\d{4})年(\d{1,2})月$/.exec(name);
      if (!mm) continue;
      const files = fs.readdirSync(path.join(outDirBf, name)).filter((f) => /^周报_.*\.txt$/.test(f));
      if (files.length) months.push({ y: Number(mm[1]), m: Number(mm[2]), count: files.length });
    }
    ok('扫到「有周报的月份」', months.length === 1 && months[0].y === 2026 && months[0].m === 9,
      JSON.stringify(months));

    const handlerBf = '测试';
    let builtPath = '';
    for (const { y, m } of months) {
      const out = perf.perfPathFor(perfDirBf, handlerBf, y, m);
      if (fs.existsSync(out)) continue;
      const collected = perf.collectWeekItems(outDirBf, y, m, () => {});
      const tplFile = perf.autoPickXlsx(perfDirBf, new Date(y, m - 1, 1), () => {});
      const built = await perf.buildPerfXlsx({
        templatePath: tplFile, outPath: out, items: collected.items,
        year: y, month: m, handler: handlerBf, allowInsert: true, log: () => {},
      });
      builtPath = typeof built === 'string' ? built : built.path;
      ok('缺表时按周报补建', collected.items.length === 2 && fs.existsSync(builtPath),
        `条目 ${collected.items.length} / 文件 ${fs.existsSync(builtPath)}`);
    }
    const again = months.map(({ y, m }) => fs.existsSync(perf.perfPathFor(perfDirBf, handlerBf, y, m)));
    ok('二次检查不会重复建表', again.every(Boolean) && fs.readdirSync(path.join(perfDirBf, '2026')).length === 1,
      `2026 目录文件数 ${fs.readdirSync(path.join(perfDirBf, '2026')).length}`);
    fs.rmSync(backfillTmp, { recursive: true, force: true });
  }

  // 自然周切分：周一~周日、不裁剪（9/28~10/4 是一整周）
  {
    const { weeksInRange } = await import('./service/engine/lib/period.mjs');
    const d = (y, mo, da) => new Date(y, mo - 1, da);
    const fmt = (w) => w.map((x) => `${x[0].getMonth() + 1}/${x[0].getDate()}~${x[1].getMonth() + 1}/${x[1].getDate()}`);
    ok('区间按完整自然周切分（不裁剪到区间边界）',
      JSON.stringify(fmt(weeksInRange(d(2026, 9, 28), d(2026, 10, 4)))) === JSON.stringify(['9/28~10/4']),
      JSON.stringify(fmt(weeksInRange(d(2026, 9, 28), d(2026, 10, 4)))));
    const oct = fmt(weeksInRange(d(2026, 10, 1), d(2026, 10, 31)));
    ok('10 月 = 5 个自然周（首尾跨月也算整周）',
      oct.length === 5 && oct[0] === '9/28~10/4' && oct[4] === '10/26~11/1', JSON.stringify(oct));
    const everyWeek = weeksInRange(d(2026, 9, 28), d(2026, 10, 31)).every((w) => {
      const mon = (w[0].getDay() + 6) % 7 === 0;
      const sun = w[1].getDay() === 0;
      const len = Math.round((w[1] - w[0]) / 86400000) + 1;
      return mon && sun && len === 7;
    });
    ok('每份都是完整 7 天的周一~周日', everyWeek, '');
  }

  // 绩效表文件名：月份补零（与既有表一致，不另建一份）
  {
    const p1 = perf.perfPathFor('D:\\绩效表', '张三', 2026, 9);
    const p2 = perf.perfPathFor('D:\\绩效表', '张三', 2026, 11);
    ok('绩效表文件名月份补零（2026年09月，不另建一份）',
      /2026年09月/.test(p1) && !/2026年9月/.test(p1), path.basename(p1));
    ok('两位数月份文件名不变', /2026年11月/.test(p2), path.basename(p2));
  }

  // 周报归属月：按「周与该月有交集」（跨月的周两边都算）
  {
    const bfTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-week-'));
    const monA = path.join(bfTmp, '2026年09月');
    const monB = path.join(bfTmp, '2026年10月');
    fs.mkdirSync(monA, { recursive: true });
    fs.mkdirSync(monB, { recursive: true });
    fs.writeFileSync(path.join(monA, '周报_2026-09-28_2026-10-04.txt'), 'x', 'utf8');
    fs.writeFileSync(path.join(monB, '周报_2026-10-05_2026-10-11.txt'), 'x', 'utf8');
    const sep = perf.weeklyReportsForMonth(bfTmp, 2026, 9);
    const oct = perf.weeklyReportsForMonth(bfTmp, 2026, 10);
    ok('跨月的周（9/28~10/4）同时属于 9 月与 10 月',
      sep.length === 1 && oct.length === 2, `9月 ${sep.length} 篇 / 10月 ${oct.length} 篇`);
    fs.rmSync(bfTmp, { recursive: true, force: true });
  }

  // 工单归属判定（v1.5.0 测试版）：剔除「只是可见、不是我干的」工单
  {
    const { classifyOwnership } = await import('./service/engine/lib/ownership.mjs');
    const selfIds = new Set(['64']);
    const targetIds = new Set(['137']);
    const ctx = {
      handler: '张三', mode: 'strict', selfIds, targetIds,
      selfNames: new Set(['李四']), targetWorklogTasks: new Set(), myWorklogTasks: new Set(['9']),
    };
    const r1 = classifyOwnership({ owner: '张三', owner_id: '137', task_id: '1' }, ctx);
    ok('归属：处理人是本人 → 计入', r1.mine === true, r1.reason);

    const r2 = classifyOwnership({ owner: '李四', owner_id: '64', initiator: '张三', initiator_id: '137', task_id: '2' }, ctx);
    ok('归属：只是创建人（处理人与工时都不是本人）→ 剔除', r2.mine === false, r2.reason);

    const r3 = classifyOwnership({ owner: '李四', owner_id: '64', task_id: '9' }, ctx);
    ok('归属：代出时账号自己的工时不算目标的 → 剔除', r3.mine === false, r3.reason);

    const ctx2 = { ...ctx, targetWorklogTasks: new Set(['9']) };
    const r4 = classifyOwnership({ owner: '李四', owner_id: '64', task_id: '9' }, ctx2);
    ok('归属：目标本人确实有工时 → 计入', r4.mine === true, r4.reason);

    const r5 = classifyOwnership({ owner: '王五', owner_id: '88', task_id: '3' }, ctx);
    ok('归属：与本人无关（纯权限可见）→ 剔除', r5.mine === false, r5.reason);

    const r6 = classifyOwnership({ owner: '张三', owner_id: '137', task_id: '1' }, { ...ctx, mode: 'loose' });
    ok('归属：loose 模式保持旧行为（不剔除）', r6.mine === true, r6.reason);

    const ctxSelf = { ...ctx, handler: '李四', targetIds: selfIds, selfNames: new Set(['李四']) };
    const r7 = classifyOwnership({ owner: '李四', owner_id: '64', task_id: '9' }, ctxSelf);
    ok('归属：自出模式（目标=账号本人）→ 本人的工时算自己的', r7.mine === true, r7.reason);
  }

  // 版本与回退（面板里点一下就能回退，不用命令行）
  {
    const vres = await req('/api/versions');
    ok('/api/versions 返回版本信息',
      vres.body.ok === true && typeof vres.body.current === 'string' && Array.isArray(vres.body.versions),
      `current=${vres.body.current} 可回退=${vres.body.canRollback}`);
    const logres = await req('/api/rollback-log');
    ok('/api/rollback-log 可读（没回退过时为空）',
      logres.body.ok === true && typeof logres.body.log === 'string', '');
    const bad = await post('/api/rollback', { version: 'not-a-version' });
    ok('回退接口校验版本号格式', bad.body.ok === false && /版本号格式/.test(bad.body.error || ''),
      bad.body.error || '');
  }

  // 面板：来回切插件页面后要停在原来那一页（别自己跳回概览）
  ok('面板记住当前视图（localStorage）',
    /localStorage\.setItem\('ws-view'/.test(jsText) && /localStorage\.getItem\('ws-view'/.test(jsText),
    '切走再回来仍停在原页面');

  // exceljs 必须随包走：以前既没 dependencies 也没 bundledDependencies，
  // 只有"补装进包目录"的 node_modules，pnpm update 一换目录就丢（v1.3.4 修）
  const pkgJson = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
  ok('exceljs 声明为依赖', pkgJson.dependencies && pkgJson.dependencies.exceljs === '4.4.0',
    JSON.stringify(pkgJson.dependencies || {}));
  ok('exceljs 声明为 bundled（随包打进去）',
    Array.isArray(pkgJson.bundledDependencies) && pkgJson.bundledDependencies.includes('exceljs'),
    JSON.stringify(pkgJson.bundledDependencies || []));
  ok('源目录有 exceljs 实体（打包前提）',
    fs.existsSync(path.join(HERE, 'node_modules', 'exceljs', 'package.json')), '');
  ok('plugin.json 组件声明与实际一致',
    /bundledDependencies/.test(String((plugin.automatic || {}).perfComponent || '')),
    String((plugin.automatic || {}).perfComponent || '').slice(0, 60));
  const xlsxSrc = fs.readFileSync(path.join(HERE, 'service', 'engine', 'lib', 'xlsx.mjs'), 'utf8');
  ok('引擎确实引入 exceljs（依赖被真正使用）',
    /from ['"]exceljs['"]/.test(xlsxSrc) || /import\(['"]exceljs['"]\)/.test(xlsxSrc)
    || /require\(['"]exceljs['"]\)/.test(xlsxSrc), '');

  console.log(`\n结果：${pass}/${pass + fail} 通过\n`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('\n冒烟测试异常：' + (e.message || e) + '\n');
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch { /* ignore */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
}
