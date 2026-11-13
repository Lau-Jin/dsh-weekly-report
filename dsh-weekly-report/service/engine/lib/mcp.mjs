/**
 * MCP 客户端（HTTP + JSON-RPC，streamable-HTTP）。
 * 对应 gen_weekly_text.py 的 _parse_sse / McpClient / mcp_error / call_with_retry /
 * tool_texts / pick_ticket_tool。
 *
 * 只依赖 fetch（Node 20+ 内置）：POST JSON-RPC，支持 text/event-stream 响应、
 * Mcp-Session-Id 会话保持、网络异常重试（3 次，5/10 秒退避）。
 */
import { MCP_PROTOCOL } from './config.mjs';

/** 把 text/event-stream 里的 data: 行拼成 JSON 文本（对应 _parse_sse） */
export function parseSse(text) {
  const chunks = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('data:')) chunks.push(line.slice(5).trim());
  }
  return chunks.join('\n');
}

export class McpClient {
  /**
   * @param {string} url MCP 端点
   * @param {string|null} token API Key（Bearer）
   * @param {number} [timeout] 单次请求超时（毫秒）
   */
  constructor(url, token, timeout = 30000) {
    this.url = url;
    this.token = token;
    this.timeout = timeout;
    this.session = null;
    this.nextId = 0;
  }

  async post(payload) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.session) headers['Mcp-Session-Id'] = this.session;

    let lastErr = null;
    let body = null;
    let contentType = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeout),
        });
        const sid = res.headers.get('mcp-session-id');
        contentType = res.headers.get('content-type') || '';
        if (sid) this.session = sid;
        body = await res.text();
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < 2) {
          const wait = 5 * (attempt + 1);
          console.log(`  网络异常：${e.message}，${wait} 秒后重试`);
          await sleep(wait * 1000);
        }
      }
    }
    if (body === null) throw new Error(`连接研发平台失败（已重试 3 次）：${lastErr && lastErr.message}`);
    if (contentType.includes('text/event-stream')) body = parseSse(body);
    const trimmed = body.trim();
    if (!trimmed) return {};
    try {
      return JSON.parse(trimmed);
    } catch {
      return { _raw: body };
    }
  }

  request(method, params = {}, notify = false) {
    const payload = { jsonrpc: '2.0', method, params };
    if (!notify) {
      this.nextId += 1;
      payload.id = this.nextId;
    }
    return this.post(payload);
  }

  async initialize() {
    const resp = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'weekly-report', version: '1.0' },
    });
    await this.request('notifications/initialized', {}, true);
    return resp;
  }

  listTools() {
    return this.request('tools/list', {});
  }

  callTool(name, args) {
    return this.request('tools/call', { name, arguments: args });
  }
}

/** 取 JSON-RPC 错误文案（对应 mcp_error） */
export function mcpError(resp) {
  const err = resp && resp.error;
  if (!err) return null;
  return `${err.code}: ${err.message}`;
}

const RATE_LIMIT_MARKS = ['-32003', '频率超限', 'too many requests', 'rate limit'];

/** 调工具；撞服务端频率限制就等一会儿重试（对应 call_with_retry） */
export async function callWithRetry(client, tool, args, retries = 3, waitSeconds = 20) {
  let resp = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    resp = await client.callTool(tool, args);
    const err = mcpError(resp);
    if (err && RATE_LIMIT_MARKS.some((k) => String(err).toLowerCase().includes(k)) && attempt < retries) {
      console.log(`  请求频率超限，等待 ${waitSeconds} 秒重试（${attempt + 1}/${retries}）…`);
      await sleep(waitSeconds * 1000);
      continue;
    }
    return resp;
  }
  return resp;
}

/** 把 tools/call 的 content 文本拼起来（对应 tool_texts） */
export function toolTexts(resp) {
  const result = (resp && resp.result) || {};
  const parts = [];
  for (const item of result.content || []) {
    if (item && item.type === 'text') parts.push(item.text || '');
  }
  let text = parts.join('\n').trim();
  if (!text && result.structuredContent && typeof result.structuredContent === 'object') {
    text = JSON.stringify(result.structuredContent);
  }
  return text;
}

/** 从工具列表里挑一个和工单相关的（对应 pick_ticket_tool） */
export function pickTicketTool(tools) {
  const keywords = ['ticket', '工单', 'issue', 'bug', 'my', 'mine', 'assigned', '待办'];
  const scored = [];
  for (const t of tools || []) {
    const name = String(t.name || '').toLowerCase();
    const desc = String(t.description || '').toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (name.includes(kw)) score += 3;
      if (desc.includes(kw)) score += 1;
    }
    if (name.includes('list') || name.includes('query') || desc.includes('list') || desc.includes('查询')) score += 2;
    if (score) scored.push([score, t]);
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b[0] - a[0]);
  return scored[0][1];
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
