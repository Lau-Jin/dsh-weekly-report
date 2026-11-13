#!/usr/bin/env node
/**
 * 周报文本修复器 · 修复「空学校/项目」把一条记录切成两段的历史文件
 *
 * 背景：模板 `【{{category}}】\n{{school}}\n  时间:` 在 school 为空时会渲染出
 * 块内空行，而周报条目之间也用空行分隔，解析器（以及人眼）就会把一条记录
 * 看成「只有类别行的一段」+「只有字段的一段」。
 *
 * 修法：不再按空行切块，改为按 `【类别】` 行作为块起点重新分块；
 * 对缺 school 的块用 resolveSchool 从「事项」推断项目名补回；
 * 块内空行一律清掉，块间统一一个空行。对正常文件是幂等的。
 *
 * 用法：
 *   node repair-report.mjs                      # 扫描配置里的周报输出目录
 *   node repair-report.mjs --file <周报.txt>    # 只修一份
 *   node repair-report.mjs --dir <目录>         # 扫描指定目录
 *   node repair-report.mjs --dry-run            # 只看会改什么，不写盘
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSchool } from './lib/util.mjs';

const CATEGORY_RE = /^【[^\n]+】$/;
const FIELD_RE = /^(时间|事项|工作内容|重要说明|进度)\s*[:：]/;

/** 纯函数：返回修复后的文本与改动清单，供面板接口复用。 */
export function repairText(input) {
  const source = String(input == null ? '' : input).replace(/^\uFEFF/, '');
  if (!source.trim()) return { text: source, fixed: 0, changes: [] };
  const crlf = source.includes('\r\n');
  const lines = source.replace(/\r\n/g, '\n').split('\n');

  const blocks = [];
  let cur = null;
  for (const line of lines) {
    if (CATEGORY_RE.test(line.trim())) {
      if (cur) blocks.push(cur);
      cur = [line.trim()];
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur) blocks.push(cur);
  if (!blocks.length) return { text: source, fixed: 0, changes: [] };

  const changes = [];
  const rendered = blocks.map((raw, idx) => {
    const b = raw.filter((l) => l.trim() !== '');
    const second = (b[1] || '').trim();
    // 第二行本该是「学校 / 项目」；空缺或直接就是字段行都说明它被切断了
    if (!second || FIELD_RE.test(second)) {
      const subjectLine = b.find((l) => /^\s*事项\s*[:：]/.test(l)) || '';
      const subject = subjectLine.replace(/^\s*事项\s*[:：]\s*/, '').trim();
      const guessed = resolveSchool('', subject) || '通用事项';
      if (FIELD_RE.test(second)) b.splice(1, 0, guessed);
      else b[1] = guessed;
      changes.push(`条目 #${idx + 1}：补全学校/项目为「${guessed}」`);
    }
    return b.join('\n');
  });

  // 没有真正缺学校时原样返回：正常文件绝不被重写（幂等）
  if (!changes.length) return { text: source, fixed: 0, changes: [] };

  let text = rendered.join('\n\n') + '\n';
  if (crlf) text = text.replace(/\n/g, '\r\n');
  return { text, fixed: changes.length, changes };
}

function collect(dir, depth = 0, out = []) {
  if (depth > 3) return out;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) collect(full, depth + 1, out);
    else if (/^周报_.*\.txt$/i.test(it.name)) out.push(full);
  }
  return out;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : '';
  };
  const dry = args.includes('--dry-run');
  let files = [];
  const single = flag('--file');
  const dir = flag('--dir');
  if (single) files = [path.resolve(single)];
  else if (dir) files = collect(path.resolve(dir));
  else {
    const dataDir = process.env.WEEKLY_DATA_DIR || process.env.WEEKLY_PANEL_DATA
      || path.join(process.env.USERPROFILE || os.homedir(), '.dsh', 'weekly-report');
    const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')); } catch { return {}; } })();
    files = collect(cfg.out_dir || path.join(dataDir, 'reports'));
  }
  if (!files.length) { console.log('没有找到周报文件'); return 0; }

  let total = 0;
  for (const file of files) {
    const original = fs.readFileSync(file, 'utf8');
    const r = repairText(original);
    if (!r.fixed) continue;
    total += r.fixed;
    console.log(`${path.basename(file)}：${r.fixed} 处`);
    r.changes.forEach((c) => console.log('  · ' + c));
    if (!dry) {
      fs.copyFileSync(file, `${file}.bak-${stamp()}`);
      fs.writeFileSync(file, r.text, 'utf8');
    }
  }
  console.log(dry ? `预览完成：共 ${total} 处待修复` : `修复完成：共 ${total} 处`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}

export { collect };
