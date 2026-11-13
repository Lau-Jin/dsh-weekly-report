/**
 * 通知发送（Node 版，零第三方依赖）
 *
 * 对应 gen_weekly_text.py 的：
 *   _notify_cfg(2952) / _http_post_json(2943) / send_webhook(2982) / send_mail(2995)
 *   build_mail_html(3046) / perf_table_html(3080) / notify(3120)
 *
 * SMTP 用 node:net / node:tls 手写：465（SSL）与 587（STARTTLS）都支持，AUTH LOGIN，
 * 主题走 RFC 2047 的 =?UTF-8?B?...?= 编码，DATA 阶段按 RFC 5321 做点填充，端口连接有超时。
 *
 * 返回值沿用 Python 的元组形状（这里用数组，可解构）：
 *   sendWebhook / sendMail → [ok:boolean, detail:string]
 *   notify                 → [[通道, ok, 说明], ...]
 */
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { DEFAULT_HANDLER } from './config.mjs';

/** SMTP 连接/读超时（Python 是 smtplib timeout=20） */
const SMTP_TIMEOUT_MS = 20000;
/** webhook 超时（Python _http_post_json timeout=15） */
const HTTP_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// 配置（对应 _notify_cfg）
// ---------------------------------------------------------------------------

/** 取 notify 段；字段名保持 Python 的 snake_case，配置可以原样互用 */
export function notifyCfg(cfg) {
  const n = (cfg && cfg.notify) || {};
  return {
    enabled: !!n.enabled,
    webhook_url: String(n.webhook_url || '').trim(),
    webhook_type: String(n.webhook_type || 'wecom').trim(),
    smtp: n.smtp || {},
  };
}

// ---------------------------------------------------------------------------
// webhook（对应 _http_post_json / send_webhook）
// ---------------------------------------------------------------------------

/** POST 一个 JSON（对应 _http_post_json）；失败时抛中文错误 */
export async function httpPostJson(url, payload, timeout = HTTP_TIMEOUT_MS) {
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new Error(`webhook 请求失败：${netErrText(e, url)}`);
  }
  const body = await resp.text();
  return { status: resp.status, body };
}

/**
 * 企业微信 / 钉钉 / 飞书 群机器人文本消息。
 * Python 里两个分支的 payload 完全一样（都是 msgtype=text），这里照抄成一份通用格式。
 */
export async function sendWebhook(webhookUrl, text, kind = 'wecom') {
  const url = String(webhookUrl || '').trim();
  if (!url) return [false, '未配置 webhook_url'];
  // 钉钉/飞书 与 企业微信 的文本消息体相同；保留 kind 只为与 Python 签名一致
  void kind;
  const payload = { msgtype: 'text', text: { content: String(text ?? '') } };
  let res;
  try {
    res = await httpPostJson(url, payload);
  } catch (e) {
    // 与 sendMail 一样：失败以 [false, 可读原因] 返回，不把异常抛给主流程
    return [false, e && e.message ? e.message : String(e)];
  }
  const { status, body } = res;
  const low = String(body || '').toLowerCase();
  if (low.includes('"errcode":0') || low.includes('"code":0') || low.includes('"status":"ok"')) {
    return [true, `HTTP ${status} 发送成功`];
  }
  return [false, `HTTP ${status} 返回：${String(body || '').slice(0, 200)}`];
}

// ---------------------------------------------------------------------------
// SMTP（对应 send_mail）
// ---------------------------------------------------------------------------

/**
 * SMTP 发信，支持 SSL(465) 与 STARTTLS(587)；有 html 时发 multipart/alternative。
 * @param {object} smtp {host, port, ssl, starttls, user, password, to}
 * @returns {Promise<[boolean, string]>}
 */
export async function sendMail(smtp, subject, body, html) {
  const cfg = smtp || {};
  const host = String(cfg.host || '').trim();
  if (!host) return [false, '未配置 smtp.host'];

  const useSsl = cfg.ssl === undefined || cfg.ssl === null ? true : !!cfg.ssl;
  let port;
  try {
    port = Number.parseInt(cfg.port || (useSsl ? 465 : 587), 10);
    if (!Number.isFinite(port) || port <= 0) throw new Error('bad port');
  } catch {
    port = 465;
  }
  const user = String(cfg.user || '').trim();
  const pwd = cfg.password ?? '';
  let to = cfg.to || (user ? [user] : []);
  if (typeof to === 'string') to = to.replace(/;/g, ',').split(',').map((x) => x.trim()).filter(Boolean);
  to = (Array.isArray(to) ? to : [to]).map((x) => String(x).trim()).filter(Boolean);
  if (!to.length) return [false, '未配置 smtp.to'];

  // Python：ssl 为真走 SMTP_SSL；否则 starttls 显式配置优先，缺省看端口是否 587
  const useStarttls = useSsl ? false : (cfg.starttls === undefined || cfg.starttls === null ? port === 587 : !!cfg.starttls);
  const rejectUnauthorized = cfg.rejectUnauthorized !== false;
  const from = user || to[0];

  let session = null;
  try {
    const sock = useSsl
      ? await connectTls(host, port, SMTP_TIMEOUT_MS, rejectUnauthorized)
      : await connectPlain(host, port, SMTP_TIMEOUT_MS);
    session = new SmtpSession(SMTP_TIMEOUT_MS).attach(sock);

    let res = await session.read();
    if (res.code !== 220) throw new Error(`SMTP 服务拒绝连接：${oneLine(res.text)}`);

    const helo = 'localhost';
    await session.cmd(`EHLO ${helo}`, [250], 'EHLO');

    if (!useSsl && useStarttls) {
      await session.cmd('STARTTLS', [220], 'STARTTLS');
      const plain = session.detach();
      session = null;
      const secured = await upgradeTls(plain, host, SMTP_TIMEOUT_MS, rejectUnauthorized);
      session = new SmtpSession(SMTP_TIMEOUT_MS).attach(secured);
      await session.cmd(`EHLO ${helo}`, [250], 'EHLO（STARTTLS 之后）');
    }

    if (user) {
      await session.cmd('AUTH LOGIN', [334], 'AUTH LOGIN');
      await session.cmd(b64(user), [334], 'AUTH LOGIN（用户名）');
      await session.cmd(b64(pwd), [235], 'AUTH LOGIN（密码）');
    }

    const payload = buildMimeMessage({ from, to, subject, body, html });
    await session.cmd(`MAIL FROM:<${from}>`, [250], 'MAIL FROM');
    for (const rcpt of to) {
      await session.cmd(`RCPT TO:<${rcpt}>`, [250, 251], 'RCPT TO');
    }
    await session.cmd('DATA', [354], 'DATA');
    session.writeRaw(payload.stuffed);
    res = await session.read();
    if (res.code !== 250) throw new Error(`邮件正文被拒收：${oneLine(res.text)}`);

    // QUIT 失败无所谓（邮件已经收了）
    try {
      session.writeLine('QUIT');
      await session.read();
    } catch {
      /* 忽略 */
    }
    return [true, `已发送至 ${to.join(', ')}`];
  } catch (e) {
    return [false, mailErrText(e, host, port)];
  } finally {
    if (session) session.close();
  }
}

/**
 * 拼 MIME 报文（对应 Python 的 MIMEText / MIMEMultipart("alternative")）。
 * 返回 { headers, body, stuffed }：stuffed 是「DATA 阶段该发的东西」（点填充 + 结尾 "."）。
 */
export function buildMimeMessage({ from, to, subject, body, html }) {
  const headers = [
    `Subject: ${encodeHeaderWord(subject)}`,
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    'MIME-Version: 1.0',
  ];
  let text;
  if (html) {
    const boundary = `----=_WeeklyReport_${Math.random().toString(36).slice(2, 12)}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    text = [
      headers.join('\r\n'),
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="utf-8"',
      'Content-Transfer-Encoding: base64',
      '',
      b64Wrap(Buffer.from(String(body ?? ''), 'utf8')),
      `--${boundary}`,
      'Content-Type: text/html; charset="utf-8"',
      'Content-Transfer-Encoding: base64',
      '',
      b64Wrap(Buffer.from(String(html), 'utf8')),
      `--${boundary}--`,
      '',
    ].join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset="utf-8"', 'Content-Transfer-Encoding: base64');
    text = [headers.join('\r\n'), '', b64Wrap(Buffer.from(String(body ?? ''), 'utf8')), ''].join('\r\n');
  }
  return { headers, text, stuffed: dotStuff(text) };
}

/** RFC 5321 4.5.2：行首的 "." 要再补一个点，否则会被当成结束标记；结尾补 ".\r\n" */
export function dotStuff(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  const body = normalized.replace(/^\./gm, '..').replace(/\n/g, '\r\n');
  return body.endsWith('\r\n') ? `${body}.\r\n` : `${body}\r\n.\r\n`;
}

/** 主题编码：纯 ASCII 原样；含中文走 =?UTF-8?B?...?=，过长按 RFC 2047 折行 */
export function encodeHeaderWord(value) {
  const s = String(value ?? '');
  // 与 Python 的 email.header.Header 类似：能原样发就不编码
  if (!/[^\x20-\x7e]/.test(s)) return s;
  const b = Buffer.from(s, 'utf8').toString('base64');
  const prefix = '=?UTF-8?B?';
  const suffix = '?=';
  const maxWord = 76; // 单个 encoded-word 不超过 75 字符，这里留一点余量
  const chunkSize = Math.max(4, Math.floor((maxWord - prefix.length - suffix.length) / 4) * 4);
  const words = [];
  for (let i = 0; i < b.length; i += chunkSize) {
    words.push(prefix + b.slice(i, i + chunkSize) + suffix);
  }
  return words.join('\r\n ');
}

/** base64 折行（RFC 2045：每行不超过 76 字符） */
function b64Wrap(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(String(buf), 'utf8').toString('base64');
  const lines = [];
  for (let i = 0; i < s.length; i += 76) lines.push(s.slice(i, i + 76));
  return lines.join('\r\n');
}

function b64(s) {
  return Buffer.from(String(s ?? ''), 'utf8').toString('base64');
}

/** 一行化服务器应答（多行应答只取最后一行 + 前几行，避免把整个报文塞进日志） */
function oneLine(text) {
  const t = String(text || '').replace(/\r?\n/g, ' / ');
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
}

/** 发信失败的可读中文说明（面板会把这段展示给用户） */
function mailErrText(e, host, port) {
  const msg = e && e.message ? e.message : String(e);
  if (e && e.code) return `SMTP 连接失败（${host}:${port}）：${netErrText(e, '')}`;
  return msg;
}

/** 从（可能是嵌套的）网络错误里挖出错误码：undici 会把连接错误包在 cause / AggregateError 里 */
function errCodeOf(e, depth = 0) {
  if (!e || depth > 4 || typeof e !== 'object') return '';
  if (e.code) return String(e.code);
  let inner = e.cause;
  if (!inner && e.errors) {
    const list = Array.isArray(e.errors) ? e.errors : Array.from(e.errors);
    inner = list[0];
  }
  return inner ? errCodeOf(inner, depth + 1) : '';
}

/** 网络错误 → 中文 */
function netErrText(e, url) {
  const msg = e && e.message ? e.message : String(e);
  const code = errCodeOf(e);
  const host = url ? safeHost(url) : '';
  const where = host ? `（${host}）` : '';
  const name = e && e.name ? e.name : '';
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT') {
    return `连接超时${where}：15 秒内没有响应`;
  }
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `域名解析失败${where}，请检查地址或网络`;
    case 'ECONNREFUSED':
      return `连接被拒绝${where}，端口没开或被防火墙拦了`;
    case 'ECONNRESET':
      return `连接被重置${where}`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `网络不可达${where}`;
    case 'CERT_HAS_EXPIRED':
      return `证书已过期${where}`;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `证书校验失败${where}（自签名或证书链不全）`;
    default:
      return msg + where;
  }
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 极简 SMTP 会话（node:net / node:tls）
// ---------------------------------------------------------------------------

class SmtpSession {
  constructor(timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buf = '';
    this.pending = null;
    this.failure = null;
  }

  attach(socket) {
    this.socket = socket;
    this.buf = '';
    this.failure = null;
    this._onData = (chunk) => {
      this.buf += chunk.toString('utf8');
      this._drain();
    };
    this._onError = (e) => this._fail(e instanceof Error ? e : new Error(String(e)));
    this._onTimeout = () => this._fail(new Error(`SMTP 连接超时（${Math.round(this.timeoutMs / 1000)} 秒没有响应）`));
    this._onClose = () => this._fail(new Error('SMTP 连接被服务器关闭'));
    socket.setTimeout(this.timeoutMs);
    socket.on('data', this._onData);
    socket.on('error', this._onError);
    socket.on('timeout', this._onTimeout);
    socket.on('close', this._onClose);
    return this;
  }

  /** 摘下监听（STARTTLS 升级前用），返回原 socket */
  detach() {
    const s = this.socket;
    this.socket = null;
    if (!s) return null;
    s.removeListener('data', this._onData);
    s.removeListener('error', this._onError);
    s.removeListener('timeout', this._onTimeout);
    s.removeListener('close', this._onClose);
    s.setTimeout(0);
    return s;
  }

  close() {
    const s = this.detach();
    if (s && !s.destroyed) s.destroy();
  }

  _fail(e) {
    this.failure = e;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.reject(e);
    }
  }

  /** 从缓冲区里切出一个完整应答（多行应答形如 "250-...\r\n250 ..."） */
  _drain() {
    let pos = 0;
    const parts = [];
    for (;;) {
      const nl = this.buf.indexOf('\n', pos);
      if (nl === -1) return; // 还没收全
      const line = this.buf.slice(pos, nl).replace(/\r$/, '');
      parts.push(line);
      pos = nl + 1;
      if (line.length >= 4 && line[3] === '-') continue; // 续行
      this.buf = this.buf.slice(pos);
      const code = Number((/^(\d{3})/.exec(parts[0]) || [])[1] || 0);
      const p = this.pending;
      this.pending = null;
      if (p) p.resolve({ code, lines: parts, text: parts.join('\n') });
      return;
    }
  }

  read() {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error('SMTP 会话被并发使用'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this._drain();
    });
  }

  writeLine(line) {
    if (!this.socket) throw new Error('SMTP 连接已关闭');
    this.socket.write(`${line}\r\n`, 'utf8');
  }

  writeRaw(text) {
    if (!this.socket) throw new Error('SMTP 连接已关闭');
    this.socket.write(text, 'utf8');
  }

  /** 发一条命令并校验返回码 */
  async cmd(line, expectCodes, label) {
    const shown = label || String(line).split(' ')[0];
    this.writeLine(line);
    const res = await this.read();
    if (!expectCodes.includes(res.code)) {
      throw new Error(`SMTP ${shown} 失败：${oneLine(res.text)}`);
    }
    return res;
  }
}

function connectPlain(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`SMTP 连接超时（${host}:${port}）`));
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      const err = new Error(`SMTP 连接失败（${host}:${port}）：${netErrText(e, '')}`);
      err.code = e && e.code;
      reject(err);
    });
  });
}

function connectTls(host, port, timeoutMs, rejectUnauthorized) {
  return new Promise((resolve, reject) => {
    // 传 IP 时不要带 servername（RFC 6066 不允许，Node 会告警）
    const opts = { host, port, rejectUnauthorized };
    if (!net.isIP(host)) opts.servername = host;
    const sock = tls.connect(opts);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`SMTP(SSL) 连接超时（${host}:${port}）`));
    }, timeoutMs);
    sock.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      const err = new Error(`SMTP(SSL) 连接失败（${host}:${port}）：${netErrText(e, '')}`);
      err.code = e && e.code;
      reject(err);
    });
  });
}

function upgradeTls(socket, host, timeoutMs, rejectUnauthorized) {
  return new Promise((resolve, reject) => {
    const opts = { socket, rejectUnauthorized };
    if (!net.isIP(host)) opts.servername = host;
    const secured = tls.connect(opts);
    const timer = setTimeout(() => {
      secured.destroy();
      reject(new Error(`STARTTLS 握手超时（${host}）`));
    }, timeoutMs);
    secured.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(secured);
    });
    secured.once('error', (e) => {
      clearTimeout(timer);
      const err = new Error(`STARTTLS 握手失败：${netErrText(e, host)}`);
      err.code = e && e.code;
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// HTML（对应 build_mail_html / perf_table_html）
// ---------------------------------------------------------------------------

/** Python html.escape(quote=True)：& < > " ' */
export function pyEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * 邮件 HTML 版：正文内嵌周报，便于在邮箱里直接阅读。
 * perfHtml：绩效表的 HTML 表格（可选）+ 打开链接。
 */
export function buildMailHtml(title, summary, report, missText, perfHtml = '') {
  const pre = (s) => `<pre style="font-family:Consolas,Menlo,'Microsoft YaHei',monospace;`
    + 'font-size:12.5px;line-height:1.7;white-space:pre-wrap;word-break:break-all;'
    + 'background:#f6f8fa;border:1px solid #e1e4e8;border-radius:6px;'
    + `padding:14px;margin:10px 0;">${pyEscape(s)}</pre>`;

  const parts = [
    "<div style=\"font-family:'Microsoft YaHei',Arial,sans-serif;font-size:14px;"
      + 'color:#24292f;line-height:1.6;">',
    `<h2 style="margin:0 0 6px;font-size:18px;">周报 ${pyEscape(title)}</h2>`,
    `<p style="margin:0 0 14px;color:#57606a;">${pyEscape(summary)}</p>`,
    '<h3 style="margin:18px 0 4px;font-size:15px;">周报正文</h3>',
    pre(report),
  ];
  if (perfHtml) {
    parts.push('<h3 style="margin:18px 0 4px;font-size:15px;">绩效表（本月月度考核表）</h3>');
    parts.push(perfHtml);
  }
  if (missText) {
    parts.push('<h3 style="margin:18px 0 4px;font-size:15px;">未匹配工单清单</h3>');
    parts.push(pre(missText));
  }
  parts.push('<p style="color:#8b949e;font-size:12px;margin-top:16px;">本邮件由周报自动生成脚本发送</p>');
  parts.push('</div>');
  return parts.join('');
}

/**
 * 绩效表 → 邮件里的 HTML 表格（限行数），附「点击打开查看」的链接。
 * 数据来自 perf.mjs 的 perfDump（port-perf 负责）；模块还没就绪时给出可读错误，不抛异常。
 */
export async function perfTableHtml(filePath, handler = DEFAULT_HANDLER, maxRows = 60) {
  let data;
  try {
    // 动态引入：perf.mjs 由 port-perf 并行开发，缺它也不影响通知其它部分
    const perf = await import('./perf.mjs');
    data = typeof filePath === 'object' && filePath ? filePath : await perf.perfDump(filePath);
  } catch (e) {
    return `<p style="color:#b42318;">绩效表读取失败：${pyEscape(errText(e))}</p>`;
  }

  const rows = (data && data.rows) || [];
  const head = '<table border="1" cellspacing="0" cellpadding="5" '
    + 'style="border-collapse:collapse;font-size:12px;width:100%;">'
    + '<thead><tr style="background:#f0f2f5;">'
    + '<th align="left">类别</th><th align="left">任务名称</th>'
    + '<th align="left">开始</th><th align="left">结束</th>'
    + '<th align="center">是否完成</th></tr></thead><tbody>';
  let body = '';
  for (const r of rows.slice(0, maxRows)) {
    const settled = !!r.settled;
    const ok = settled ? '是' : '否';
    const color = settled ? '#1a7f37' : '#9a6700';
    body += '<tr>'
      + `<td>${pyEscape(r.category || '')}</td>`
      + `<td>${pyEscape(r.content || '')}</td>`
      + `<td>${pyEscape(r.d1_text || r.d1 || '')}</td>`
      + `<td>${pyEscape(r.d2_text || r.d2 || '')}</td>`
      + `<td align="center" style="color:${color};font-weight:600;">${ok}</td>`
      + '</tr>';
  }
  if (rows.length > maxRows) {
    body += '<tr><td colspan="5" style="color:#57606a;">'
      + `…共 ${rows.length} 条，邮件里只列前 ${maxRows} 条</td></tr>`;
  }
  body += '</tbody></table>';
  const fileHref = String(filePath || '').replace(/\\/g, '/');
  const link = '<p style="margin:8px 0 0;font-size:12px;">'
    + `考核期间 ${pyEscape((data && data.period) || '-')}　`
    + `处理人 ${pyEscape((data && data.handler) || handler)}　`
    + `共 ${(data && data.total) || 0} 条（已完成 ${(data && data.done) || 0}）</p>`
    + '<p style="margin:6px 0 0;font-size:12px;">'
    + `<a href="file:///${pyEscape(fileHref)}" style="color:#0969da;">`
    + '点击打开绩效表查看完整内容 →</a> '
    + `<span style="color:#8b949e;">${pyEscape(baseName(filePath))}</span></p>`;
  return head + body + link;
}

function baseName(p) {
  const s = String(p || '');
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return s.slice(cut + 1) || path.basename(s);
}

function errText(e) {
  return e && e.message ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// 统一入口（对应 notify）
// ---------------------------------------------------------------------------

/**
 * 按配置发送通知；任何异常都不影响主流程。返回 [[通道, 是否成功, 说明]]。
 * @param {object} cfg 整个配置（取 cfg.notify）
 * @param {string} subject 标题
 * @param {string} body 纯文本正文
 * @param {{dryRun?:boolean, only?:'webhook'|'mail'|null, html?:string, webhookBody?:string}} [opts]
 */
export async function notify(cfg, subject, body, opts) {
  const o = opts || {};
  const dryRun = !!o.dryRun;
  const only = o.only === undefined || o.only === null || o.only === '' ? null : String(o.only);
  const html = o.html || null;
  const webhookBody = o.webhookBody || null;

  const n = notifyCfg(cfg);
  const results = [];
  const channels = [];
  if (n.webhook_url && (only === null || only === 'webhook')) {
    channels.push(['webhook', n.webhook_url, n.webhook_type]);
  }
  if ((only === null || only === 'mail') && (n.smtp.host || only === 'mail')) {
    channels.push(['mail', n.smtp, null]);
  }
  if (!channels.length) {
    console.log('通知：未配置 webhook_url 或 smtp.host，跳过发送');
    return results;
  }

  for (const [kind, target, extra] of channels) {
    const text = kind === 'webhook' ? webhookBody || body : body;
    if (dryRun) {
      console.log(`\n--- 通知预览（${kind}，未实际发送）---`);
      console.log(`标题：${subject}`);
      console.log(text);
      results.push([kind, true, 'dry-run']);
      continue;
    }
    let ok = false;
    let detail = '';
    try {
      [ok, detail] = kind === 'webhook'
        ? await sendWebhook(target, text, extra)
        : await sendMail(target, subject, body, html);
    } catch (e) {
      // 绝不因为通知失败影响周报
      ok = false;
      detail = errText(e);
    }
    console.log(`通知[${kind}]：${ok ? '成功' : '失败'} - ${detail}`);
    results.push([kind, ok, detail]);
  }
  return results;
}
