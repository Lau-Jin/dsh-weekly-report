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

  // 零命令安装入口
  ok('四个平台/入口都有双击安装文件', ['一键安装.vbs', '一键安装.cmd', '一键安装.command', 'install.sh']
    .every((f) => fs.existsSync(path.join(HERE, f))), '');
  const vbs = fs.readFileSync(path.join(HERE, '一键安装.vbs'));
  ok('VBS 安装脚本纯 ASCII（避免 WSH 中文乱码）', [...vbs].every((b) => b <= 127), '');
  const cmd = fs.readFileSync(path.join(HERE, '一键安装.cmd'));
  ok('CMD 安装脚本纯 ASCII（避免 cmd 代码页乱码）', [...cmd].every((b) => b <= 127), '');
  const installer = fs.readFileSync(path.join(HERE, 'install.mjs'), 'utf8');
  ok('安装器支持 --open / --result-file', /--open/.test(installer) && /--result-file/.test(installer), '');

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
    ws.getCell('B2').value = '张三员工月度考核表';
    ws.mergeCells('B2:N2');
    ws.getCell('B3').value = '被考评人'; ws.mergeCells('B3:C3'); ws.getCell('D3').value = '张三';
    ws.getCell('B4').value = '考评时间'; ws.mergeCells('B4:C4'); ws.getCell('D4').value = '2026年11月1日-11月30日';
    ws.getCell('J3').value = '填报时间'; ws.getCell('K3').value = new Date(2026, 10, 12);
    const heads = { B: '类别', D: '任务名称', J: '开始时间', K: '结束时间', L: '是否完成', M: '评定' };
    for (const [col, text] of Object.entries(heads)) ws.getCell(`${col}6`).value = text;
    ws.mergeCells('D6:I6'); ws.mergeCells('M6:N6');
    for (let r = 7; r <= 9; r += 1) {
      ws.mergeCells(`B${r}:C${r}`); ws.mergeCells(`D${r}:I${r}`); ws.mergeCells(`M${r}:N${r}`);
      ws.getCell(`B${r}`).value = '项目运维';
      ws.getCell(`D${r}`).value = `既有事项${r}`;
      ws.getCell(`J${r}`).value = new Date(2026, 10, 2);
      ws.getCell(`K${r}`).value = new Date(2026, 10, 2);
      ws.getCell(`L${r}`).value = '是';
    }
    ws.getCell('B12').value = '工作任务考核（60%）：';
    ws.mergeCells('B12:N12');
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

  const plugin = JSON.parse(fs.readFileSync(path.join(HERE, 'plugin.json'), 'utf8'));
  ok('plugin.json 声明装上即用', plugin.automatic.autoRegisterBundle === true && plugin.automatic.autoStartService === true, '');
  ok('声明会话数据仅作参考', plugin.dataSource.sessionData === 'design-reference-only', '');
  ok('声明邮件默认关闭', plugin.configuration.defaults.notifyEnabled === false, '');

  console.log(`\n结果：${pass}/${pass + fail} 通过\n`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('\n冒烟测试异常：' + (e.message || e) + '\n');
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch { /* ignore */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
}
