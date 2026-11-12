# -*- coding: utf-8 -*-
# ============================================================================
# ⚠ 本文件是周报生成引擎的【唯一真源】（canonical source）
#
#   后续所有修改、调试都改这里：
#     D:\Tools\Lau-tool\dsh-weekly-report\service\engine\gen_weekly_text.py
#
#   然后跑一次同步，让桌面留档副本跟上（桌面那份不再单独维护）：
#     powershell -ExecutionPolicy Bypass -File "D:\Tools\Lau-tool\dsh-weekly-report\sync-desktop.ps1"
#
#   桌面副本：D:\Reports\gen_weekly_text.py（镜像，勿直接改）
#   插件说明：dsh-weekly-report/README.md
# ============================================================================
"""
从绩效考核表生成「周报事项」格式的文本，并通过研发平台 MCP 自动匹配工单，
把工单链接写入「工作内容」。

用法：
    # 0) 首次部署：生成配置模板 / 查看当前生效路径
    python gen_weekly_text.py --init-config
    python gen_weekly_text.py --where

    # 1) 只按考核表生成
    python gen_weekly_text.py --file <xlsx> --start 2026-06-01 --end 2026-06-07 --out <txt>

    # 2) 用导出的工单 JSON 匹配
    python gen_weekly_text.py --file <xlsx> --start ... --end ... --out <txt> --tickets tickets.json

    # 3) 通过 MCP 拉取工单（推荐）
    python gen_weekly_text.py --file <xlsx> --start ... --end ... --out <txt> \
        --mcp-token <API Key>

    # 4) 先看看 MCP 提供了哪些工具
    python gen_weekly_text.py --mcp-token <API Key> --mcp-list-tools --out tools.json

    # 5) 日常/定时任务：本周 + 自动挑表 + 自动归档 + 日志
    python gen_weekly_text.py --week current --auto-file --log

    # 6) 绩效表核对（月底检查 / 随时抽查；只读周报与绩效表，不需要 API Key）
    #    报告写在绩效表旁边 *_核对.txt；加 --perf-fix 把周报里有、表里缺的补进去
    python gen_weekly_text.py --perf-check --perf-fix [--perf-month 2026-11]

路径优先级：命令行 > 环境变量(WEEKLY_FOLDER/WEEKLY_TOKEN_FILE/WEEKLY_OUT_DIR)
            > weekly_config.json > 内置默认。
weekly_config.json 中的相对路径以本脚本所在目录为基准，整个目录可直接拷到其他电脑。

输出格式：
【项目运维】
学校名称
    时间: 2026年6月1日-6月2日
    事项: 去掉校名后的事项
    工作内容: https://mcp.example.com/?tab=ticket-detail&ticketId=1234
    重要说明: 无
    进度: 100%
"""

import argparse
import glob
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, date, timedelta
from difflib import SequenceMatcher

from openpyxl import load_workbook

DEFAULT_MCP_URL = "https://mcp.example.com/api/mcp"
DEFAULT_LINK = "https://mcp.example.com/?tab=ticket-detail&ticketId={id}"
# 任务中心的单个任务页（前端路由：?tab=task-detail&taskId=<id>）
DEFAULT_TASK_LINK = "https://mcp.example.com/?tab=task-detail&taskId={id}"
TASK_LIST_TOOL = "task_list_my_tasks"
TASK_DETAIL_TOOL = "task_get_task_detail"
DEFAULT_TOKEN_FILE = r"D:\Reports\api_key.txt"
DEFAULT_OUT_DIR = r"D:\Reports"
DEFAULT_FOLDER = r"D:\Perf\2026"
DEFAULT_HANDLER = "张三"
DEFAULT_THRESHOLD = 0.85
MCP_PROTOCOL = "2025-06-18"

# 脚本所在目录：配置文件与相对路径都基于这里，便于整个目录拷到其他电脑
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_NAME = "weekly_config.json"

# 运行期生效的路径（由 weekly_config.json / 命令行覆盖）
OUT_DIR = DEFAULT_OUT_DIR
TOKEN_FILE = DEFAULT_TOKEN_FILE
PERF_FOLDER = DEFAULT_FOLDER
CONFIG_PATH = os.path.join(SCRIPT_DIR, CONFIG_NAME)


def _abs(p):
    """相对路径按脚本目录解析，保证目录整体搬迁后仍可用。"""
    if not p:
        return p
    p = os.path.expandvars(os.path.expanduser(str(p)))
    return p if os.path.isabs(p) else os.path.normpath(os.path.join(SCRIPT_DIR, p))


def load_config():
    path = CONFIG_PATH
    if not os.path.isfile(path):
        return {}
    with open(path, "r", encoding="utf-8-sig") as f:
        try:
            return json.load(f) or {}
        except json.JSONDecodeError as e:
            print(f"警告：{os.path.basename(path)} 解析失败（{e}），改用默认配置")
            return {}


def apply_config(args=None):
    """按 命令行 > 环境变量 > weekly_config.json > 内置默认 的优先级确定路径。"""
    global OUT_DIR, TOKEN_FILE, PERF_FOLDER, CONFIG_PATH
    if args is not None and getattr(args, "config", None):
        CONFIG_PATH = _abs(args.config)
    cfg = load_config()

    OUT_DIR = _abs(os.environ.get("WEEKLY_OUT_DIR")
                   or cfg.get("out_dir")
                   or DEFAULT_OUT_DIR)
    TOKEN_FILE = _abs(os.environ.get("WEEKLY_TOKEN_FILE")
                      or cfg.get("token_file")
                      or DEFAULT_TOKEN_FILE)
    PERF_FOLDER = _abs(os.environ.get("WEEKLY_FOLDER")
                       or cfg.get("folder")
                       or DEFAULT_FOLDER)
    return cfg

# 未完成事项的进度参考（内容关键词 → 参考百分比, 与时间进度如何合并）
PROGRESS_HINTS = [
    (("未开始", "待安排", "待排期", "计划中", "未启动", "待启动"), 15, "min"),
    (("排查", "分析", "定位", "沟通", "对接", "确认中", "核实"), 45, "around"),
    (("处理中", "修复中", "部署中", "配置中", "开发中", "联调", "实施", "整改"), 65, "around"),
    (("待验证", "待确认", "待审核", "待验收", "测试中", "待反馈", "已提交"), 85, "max"),
]


def progress_for(done, start, end, reference, task=""):
    """
    进度判定：
      是否完成=是 → 100%
      否 → 结合「时间进度」（已过天数/计划跨度）与「内容关键词」给出 5%~90%，永不为 100%
    """
    if str(done).strip() == "是":
        return "100%"

    # 时间维度：按计划跨度算已推进比例
    if start and end and end > start:
        span = max((end - start).days, 1)
        elapsed = (reference - start).days
        ratio = max(0.0, min(1.0, elapsed / span))
    else:
        ratio = 0.5
    time_pct = 10 + 80 * ratio

    # 内容维度
    content_pct, mode = None, "around"
    text = task or ""
    for kws, pct, m in PROGRESS_HINTS:
        if any(k in text for k in kws):
            content_pct, mode = pct, m
            break

    if content_pct is None:
        pct = time_pct
    elif mode == "min":
        pct = min(time_pct, content_pct)
    elif mode == "max":
        pct = max(time_pct, content_pct)
    else:
        pct = (time_pct + content_pct) / 2

    # 已过计划完成时间仍未完成：封顶 80%，避免显得快收尾
    if end and reference and reference > end:
        pct = min(pct, 80)

    return f"{max(5, min(90, round(pct)))}%"


def default_out_path(week_start, week_end):
    r"""按周期归档：D:\Reports\2026年11月\周报_2026-11-02_2026-11-08.txt"""
    folder = os.path.join(OUT_DIR, f"{week_start.year}年{week_start.month:02d}月")
    return os.path.join(folder, f"周报_{week_start.isoformat()}_{week_end.isoformat()}.txt")


# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------
def fmt_date(d):
    return f"{d.year}年{d.month}月{d.day}日"


def fmt_range(start, end):
    if end is None:
        return fmt_date(start)
    if start == end:
        return fmt_date(start)
    if start.year == end.year and start.month == end.month:
        return f"{start.year}年{start.month}月{start.day}日-{end.day}日"
    if start.year == end.year:
        return f"{start.year}年{start.month}月{start.day}日-{end.month}月{end.day}日"
    return f"{fmt_date(start)}-{fmt_date(end)}"


def to_date(v):
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    s = str(v).strip()
    for f in ("%Y-%m-%d", "%Y/%m/%d", "%Y年%m月%d日", "%Y.%m.%d"):
        try:
            return datetime.strptime(s, f).date()
        except ValueError:
            continue
    return None


def split_school(desc):
    if not desc:
        return ""
    text = desc.strip()
    cut = len(text)
    for sep in ("（", "("):
        i = text.find(sep)
        if i != -1:
            cut = min(cut, i)
    head = text[:cut]
    for suffix in ("学院", "大学", "学校", "中学", "职院", "书院"):
        idx = head.find(suffix)
        if 2 <= idx <= 30:
            return head[: idx + len(suffix)]
    return ""


_PUNCT = re.compile(r"[\s，。、；：！？,.;:!?（）()\[\]【】《》<>\"'“”‘’\-—_/\\|]+")


def norm(text):
    if not text:
        return ""
    return _PUNCT.sub("", str(text)).lower()


def similarity(a, b):
    na, nb = norm(a), norm(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    if na in nb or nb in na:
        return 0.95
    return SequenceMatcher(None, na, nb).ratio()


# --------------------------------------------------------------------------
# 考核表读取
# --------------------------------------------------------------------------
def read_rows(xlsx_path):
    wb = load_workbook(xlsx_path, data_only=True)
    ws = None
    for candidate in wb.worksheets:
        if "月度考核" in candidate.title:
            ws = candidate
            break
    if ws is None:
        ws = wb.worksheets[1]

    rows = []
    for r in range(7, ws.max_row + 1):
        cat = ws.cell(row=r, column=2).value
        task = ws.cell(row=r, column=4).value
        start = ws.cell(row=r, column=10).value
        end = ws.cell(row=r, column=11).value
        done = ws.cell(row=r, column=12).value
        remark = ws.cell(row=r, column=13).value

        if not cat or not task:
            break
        cat_s = str(cat).strip()
        if "考核" in cat_s or "得分" in cat_s:
            break

        rows.append({
            "category": cat_s,
            "task": str(task).strip(),
            "start": to_date(start),
            "end": to_date(end),
            "done": str(done).strip() if done is not None else "",
            "remark": str(remark).strip() if remark is not None else "",
        })
    wb.close()
    return rows


# --------------------------------------------------------------------------
# 工单字段归一化
# --------------------------------------------------------------------------
def _pick(d, *keys):
    for k in keys:
        if k in d and d[k] not in (None, ""):
            return d[k]
    return None


def normalize_tickets(raw_list):
    out = []
    for it in raw_list:
        if not isinstance(it, dict):
            continue
        tid = _pick(it, "id", "ticketId", "ticket_id", "code", "no",
                    "工单编号", "编号", "工单id", "工单ID")
        title = _pick(it, "title", "subject", "name", "ticketTitle", "summary",
                      "content", "标题", "主题", "工单标题", "事项")
        link = _pick(it, "link", "url", "href", "链接", "地址")
        handler = _pick(it, "handler", "assignee", "handlerName", "owner",
                        "dealUser", "assigneeName", "handleUser", "ownerName",
                        "处理人", "负责人", "指派给")
        school = _pick(it, "schoolName", "school", "projectName", "学校", "项目")
        if tid is None and title is None:
            continue
        if not link and tid is not None:
            link = DEFAULT_LINK.format(id=tid)
        out.append({
            "id": str(tid) if tid is not None else "",
            "title": str(title).strip() if title else "",
            "link": str(link).strip() if link else "",
            "handler": str(handler).strip() if handler else "",
            "school": str(school).strip() if school else "",
            "status": str(_pick(it, "ticketStatus", "status") or "").strip(),
            "task_id": _pick(it, "taskId", "task_id"),
            "ticket_no": str(_pick(it, "ticketNo", "no") or "").strip(),
            "issue": str(_pick(it, "issueTypeName", "issueType") or "").strip(),
            "issue_code": str(_pick(it, "issueType", "issueTypeCode") or "").strip(),
            "created_at": str(_pick(it, "createdAt", "created_at") or "").strip(),
            "updated_at": str(_pick(it, "updatedAt", "updated_at") or "").strip(),
            "score": _pick(it, "score"),
            "hours": _pick(it, "totalHours", "hours"),
        })

    seen, uniq = set(), []
    for t in out:
        key = (t["id"], t["title"], t["link"])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(t)
    return uniq


def extract_list(data):
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("data", "list", "rows", "records", "items", "content",
                    "result", "tickets", "工单列表"):
            v = data.get(key)
            if isinstance(v, list):
                return v
            if isinstance(v, dict):
                inner = extract_list(v)
                if inner:
                    return inner
    return []


def load_tickets_from_json(path):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return normalize_tickets(extract_list(data))


# --------------------------------------------------------------------------
# MCP 客户端（HTTP + JSON-RPC）
# --------------------------------------------------------------------------
def _parse_sse(text):
    """把 text/event-stream 里的 data: 行拼成 JSON 文本。"""
    chunks = []
    for line in text.splitlines():
        if line.startswith("data:"):
            chunks.append(line[5:].strip())
    return "\n".join(chunks)


class McpClient:
    def __init__(self, url, token, timeout=30):
        self.url = url
        self.token = token
        self.timeout = timeout
        self.session = None
        self._id = 0

    def _post(self, payload):
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(self.url, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json, text/event-stream")
        if self.token:
            req.add_header("Authorization", "Bearer " + self.token)
        if self.session:
            req.add_header("Mcp-Session-Id", self.session)

        last_err = None
        sid = ctype = body = None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    sid = r.headers.get("Mcp-Session-Id")
                    ctype = r.headers.get("Content-Type", "")
                    body = r.read().decode("utf-8", "replace")
                break
            except urllib.error.HTTPError as e:
                sid = e.headers.get("Mcp-Session-Id")
                ctype = e.headers.get("Content-Type", "")
                body = e.read().decode("utf-8", "replace")
                break
            except (urllib.error.URLError, OSError) as e:
                last_err = e
                if attempt < 2:
                    wait = 5 * (attempt + 1)
                    print(f"  网络异常：{e}，{wait} 秒后重试")
                    time.sleep(wait)
        if body is None:
            raise SystemExit(f"连接研发平台失败（已重试 3 次）：{last_err}")
        if sid:
            self.session = sid
        if "text/event-stream" in (ctype or ""):
            body = _parse_sse(body)
        try:
            return json.loads(body) if body.strip() else {}
        except json.JSONDecodeError:
            return {"_raw": body}

    def request(self, method, params=None, notify=False):
        payload = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if not notify:
            self._id += 1
            payload["id"] = self._id
        return self._post(payload)

    def initialize(self):
        resp = self.request("initialize", {
            "protocolVersion": MCP_PROTOCOL,
            "capabilities": {},
            "clientInfo": {"name": "weekly-report", "version": "1.0"},
        })
        self.request("notifications/initialized", {}, notify=True)
        return resp

    def list_tools(self):
        return self.request("tools/list", {})

    def call_tool(self, name, arguments):
        return self.request("tools/call", {"name": name, "arguments": arguments})


def mcp_error(resp):
    err = resp.get("error")
    if err:
        return f"{err.get('code')}: {err.get('message')}"
    return None


RATE_LIMIT_MARKS = ("-32003", "频率超限", "too many requests", "rate limit")


def call_with_retry(client, tool, args, retries=3, wait=20):
    """调一次工具；撞到服务端频率限制（每分钟 60 次）就等一会儿重试。"""
    resp = None
    for attempt in range(retries + 1):
        resp = client.call_tool(tool, args)
        err = mcp_error(resp)
        if err and any(k in str(err) for k in RATE_LIMIT_MARKS) and attempt < retries:
            print(f"  请求频率超限，等待 {wait} 秒重试（{attempt + 1}/{retries}）…")
            time.sleep(wait)
            continue
        return resp
    return resp


def tool_texts(resp):
    """把 tools/call 返回的 content 文本拼起来。"""
    result = resp.get("result") or {}
    parts = []
    for item in result.get("content") or []:
        if isinstance(item, dict) and item.get("type") == "text":
            parts.append(item.get("text", ""))
    text = "\n".join(parts).strip()
    if not text and isinstance(result.get("structuredContent"), (dict, list)):
        text = json.dumps(result["structuredContent"], ensure_ascii=False)
    return text


def pick_ticket_tool(tools):
    """从工具列表里挑一个和工单相关的工具。"""
    keywords = ("ticket", "工单", "issue", "bug", "my", "mine", "assigned", "待办")
    scored = []
    for t in tools:
        name = (t.get("name") or "").lower()
        desc = (t.get("description") or "").lower()
        score = 0
        for kw in keywords:
            if kw in name:
                score += 3
            if kw in desc:
                score += 1
        if "list" in name or "query" in name or "list" in desc or "查询" in desc:
            score += 2
        if score:
            scored.append((score, t))
    if not scored:
        return None
    scored.sort(key=lambda x: -x[0])
    return scored[0][1]


def fetch_tickets_via_mcp(token, url=DEFAULT_MCP_URL, tool_name=None,
                          tool_args=None, handler_filter=None):
    client = McpClient(url, token)
    init = client.initialize()
    err = mcp_error(init)
    if err:
        raise SystemExit(f"MCP 初始化失败：{err}")
    print(f"MCP 已连接：{init.get('result', {}).get('serverInfo')}")

    tools_resp = client.list_tools()
    err = mcp_error(tools_resp)
    if err:
        raise SystemExit(f"获取工具列表失败：{err}")
    tools = (tools_resp.get("result") or {}).get("tools") or []
    print(f"MCP 工具数：{len(tools)}")

    tool = None
    if tool_name:
        tool = next((t for t in tools if t.get("name") == tool_name), None)
        if tool is None:
            raise SystemExit(f"未找到工具：{tool_name}")
    else:
        # 优先用「我的工单」列表工具，避免误选问题类型字典等辅助工具
        tool = next((t for t in tools if t.get("name") == "ticket_list_my_tickets"), None)
        if tool is None:
            tool = pick_ticket_tool(tools)
        if tool is None:
            names = ", ".join(t.get("name", "?") for t in tools)
            raise SystemExit(f"没有识别到工单工具，可用工具：{names}")

    base_args = dict(tool_args or {})
    print(f"调用工具：{tool.get('name')} 参数：{base_args}")

    all_items, page, limit = [], 1, 40
    total = None
    while page <= 40:
        args = {**base_args, "page": page, "limit": limit}
        resp = call_with_retry(client, tool.get("name"), args)
        err = mcp_error(resp)
        if err and ("-32006" in str(err) or "64KB" in str(err)) and limit > 10:
            limit = max(10, limit // 2)
            continue
        if err:
            raise SystemExit(f"调用工具失败：{err}")

        text = tool_texts(resp)
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            raise SystemExit(f"工具返回无法解析为 JSON：{text[:300]}")

        items = extract_list(data)
        if isinstance(data, dict) and isinstance(data.get("total"), int):
            total = data["total"]
        if not items:
            break
        all_items.extend(items)
        print(f"  第 {page} 页：{len(items)} 条（累计 {len(all_items)}/{total}）")
        if isinstance(total, int) and len(all_items) >= total:
            break
        page += 1

    tickets = normalize_tickets(all_items)
    if handler_filter:
        mine = sum(1 for t in tickets if handler_filter in t["handler"])
        print(f"工单共 {len(tickets)} 条，其中处理人含「{handler_filter}」{mine} 条"
              f"（匹配时本人优先，未命中再比对全部）")
    return tickets, tools


# --------------------------------------------------------------------------
# 工单驱动：处理人为我 / 工单中有我的工时记录
# --------------------------------------------------------------------------
CATEGORY_MAP = {
    "服务部署": "交付部署", "迭代升级": "交付部署",
    "问题解决": "项目运维", "问题跟踪": "项目运维",
    "BUG修复": "项目运维", "漏洞修复": "项目运维",
    "问题答疑": "项目支撑", "需求变更": "项目支撑",
    "数据排查": "项目支撑", "远程支持": "项目支撑",
}
ISSUE_CODE_MAP = {
    "service_deploy": "交付部署", "upgrade": "交付部署",
    "issue_resolve": "项目运维", "issue_track": "项目运维",
    "bug_fix": "项目运维", "vuln_fix": "项目运维",
    "consult": "项目支撑", "requirement_change": "项目支撑",
    "data_investigate": "项目支撑",
}


def ticket_category(t):
    """工单 → 周报类别：优先中文问题类型，其次 code，最后兜底。"""
    name = (t.get("issue") or "").strip()
    if name in CATEGORY_MAP:
        return CATEGORY_MAP[name]
    code = (t.get("issue_code") or "").strip()
    if code in ISSUE_CODE_MAP:
        return ISSUE_CODE_MAP[code]
    return "项目支撑"
STATUS_PROGRESS = {
    "completed": 100, "pending_review": 80, "processing": 60,
    "assigned": 30, "created": 10, "cancelled": 0,
}

# 「已取消」的工单/任务属于无效记录，不写进周报
CANCELLED_STATUSES = {"cancelled", "canceled", "已取消", "作废", "已作废", "取消"}
# 任务中心的任务状态是中文枚举
TASK_DONE_STATUSES = {"已完成", "已归档", "已关闭", "已验收", "待评审"}
TASK_STATUS_PROGRESS = {"新建": 10, "进行中": 60, "已暂停": 30, "待评审": 80, "已完成": 100, "已归档": 100}
# 任务类型 → 周报类别（对应工单的问题类型映射）
TASK_TYPE_CATEGORY = {
    "项目问题反馈": "项目运维", "问题排查": "项目运维", "漏洞修复": "项目运维",
    "问题解决": "项目运维", "问题跟踪": "项目运维", "BUG修复": "项目运维",
    "服务支持": "项目支撑", "其他安排": "项目支撑", "周期性事项": "项目支撑",
    "数据支撑": "项目支撑", "技术支撑": "项目支撑", "需求变更": "项目支撑",
    "服务部署": "交付部署", "迭代升级": "交付部署", "部署实施": "交付部署",
}


def is_cancelled_status(status):
    """工单状态（英文 code）或任务状态（中文）是否「已取消」。"""
    s = str(status or "").strip().lower()
    if not s:
        return False
    if s in CANCELLED_STATUSES:
        return True
    return ("取消" in s) or ("作废" in s)


def fetch_my_worklogs(token, url=DEFAULT_MCP_URL, start=None, end=None,
                      tool="task_list_my_worklogs"):
    """取我在指定日期区间的工时记录（含 task_id / 工作日期 / 工时 / 进度）。"""
    client = McpClient(url, token)
    init = client.initialize()
    err = mcp_error(init)
    if err:
        raise SystemExit(f"MCP 初始化失败：{err}")

    out, page = [], 1
    while page <= 20:
        args = {"startDate": str(start), "endDate": str(end),
                "page": page, "limit": 50}
        resp = call_with_retry(client, tool, args)
        err = mcp_error(resp)
        if err:
            raise SystemExit(f"读取工时失败：{err}")
        data = json.loads(tool_texts(resp))
        items = data.get("items") or []
        out.extend(items)
        total = data.get("total")
        if not items or (isinstance(total, int) and len(out) >= total) or len(items) < 50:
            break
        page += 1
    print(f"我的工时：{len(out)} 条（{start} ~ {end}，合计 "
          f"{sum(float(w.get('hours') or 0) for w in out):g} 小时）")
    return out


# --------------------------------------------------------------------------
# 周期与完成判断（以工单状态 + 工时记录为准）
# --------------------------------------------------------------------------
DONE_MARKERS = ("已完成", "完成", "已关闭", "已处理", "搞定", "结束", "交付完成", "上线完成")
UNDONE_MARKERS = ("未完成", "待完成", "未结束", "待续", "继续", "进行中")
_WORKDAY_CACHE = {}


def _today_cn():
    from datetime import timezone
    return datetime.now(timezone(timedelta(hours=8))).date()


def fetch_workdays(token, url=DEFAULT_MCP_URL, start=None, end=None):
    """周期内每个日期是否工作日（calendar_is_workday）；读取失败时返回空。"""
    if not start or not end:
        return {}
    out = {}
    try:
        client = McpClient(url, token)
        init = client.initialize()
        if mcp_error(init):
            return {}
        d = start
        while d <= end:
            key = d.isoformat()
            if key in _WORKDAY_CACHE:
                out[d] = _WORKDAY_CACHE[key]
            else:
                resp = call_with_retry(client, "calendar_is_workday", {"date": key})
                if mcp_error(resp):
                    break
                data = json.loads(tool_texts(resp))
                flag = bool(data.get("is_workday"))
                _WORKDAY_CACHE[key] = flag
                out[d] = flag
            d += timedelta(days=1)
    except SystemExit:
        pass
    except Exception:
        pass
    if out:
        days = [k for k in sorted(out) if out[k]]
        print(f"本周期工作日：{len(days)} 天"
              f"（{('、'.join(d.isoformat()[5:] for d in days)) or '-'}）")
    return out


def worklog_dates(wls):
    return sorted({d for d in (to_date(w.get("work_date")) for w in wls) if d})


def remark_done(remark):
    """工时备注里是否标记「已完成」（「未完成」等否定标记优先）。"""
    s = str(remark or "")
    if not s:
        return False
    if any(k in s for k in UNDONE_MARKERS):
        return False
    return any(k in s for k in DONE_MARKERS)


def completion_date(settled, all_wls, updated, created):
    """完成日期：状态已完成看最后工时/更新时间；状态未完成则看最后一条工时备注是否标记完成。"""
    dates = worklog_dates(all_wls)
    last = dates[-1] if dates else None
    if settled:
        cands = [d for d in (last, updated, created) if d]
        return max(cands) if cands else None
    if all_wls:
        last_wl = max(all_wls, key=lambda w: to_date(w.get("work_date")) or date.min)
        if remark_done(last_wl.get("remark")):
            return to_date(last_wl.get("work_date"))
    return None


def snap_workday(d, workdays, forward=True):
    """把非工作日的日期挪到相邻工作日（只用于没有工时记录时的时间边界）。"""
    if not d or not workdays or workdays.get(d, True):
        return d
    days = [x for x in sorted(workdays) if workdays[x]]
    if not days:
        return d
    if forward:
        later = [x for x in days if x >= d]
        return later[0] if later else d
    earlier = [x for x in days if x <= d]
    return earlier[-1] if earlier else d


def build_items_from_tickets(tickets, worklogs, handler, ws, we, my_task_ids=None,
                             workdays=None, skip_task_ids=None, child_stats=None):
    """工单 → 周报条目。纳入条件：处理人是我 / 本周期内我有工时 / 关联任务我负责。

    完成判断（2026-11-11 起：平台状态 + 工时备注，不再猜「下周还会不会记工时」）：
    - 平台已收口（已完成/已关闭/已评分/待评分/有评分）且完成日落在本周期 → 完成；
    - 本周期有我的工时，且**该工时备注写了完成**（已完成/完成/已关闭/已处理/搞定/结束/交付完成/
      上线完成，且不含未完成/待完成/继续…）→ 完成；工时里 progress 填了 100 → 也算完成；
    - 两者都不满足 → 本周期记未完成（进度按工时进度 / 工单状态估算，封顶 95%）；
    - 没有本周期工时（本周期新建或跨周收尾）→ 只看完成日是否落在本周期；
    - 补充工单（我的工时都早于建单日，事后补录）不生成：那种已记在之前周期的周报里。

    child_stats：{task_id: (子任务总数, 已完成数)}。工单本身没有子任务，但它关联的任务有；
    关联任务子任务没做完时，不再凭「本周期最后一次工时之后没新工时」直接判 100%。
    """
    my_task_ids = {str(x) for x in (my_task_ids or set()) if str(x)}
    child_stats = {str(k): v for k, v in (child_stats or {}).items()}
    by_task = {}
    for w in worklogs:
        by_task.setdefault(str(w.get("task_id")), []).append(w)

    items, mine_n, wl_n, task_n, cancelled_n, supp_n, seen = [], 0, 0, 0, 0, 0, set()
    for t in tickets:
        status_raw = (t.get("status") or "").strip()
        if is_cancelled_status(status_raw):
            cancelled_n += 1
            continue
        task_id = str(t.get("task_id") or "")
        all_wls = by_task.get(task_id) or []
        p_dates = [d for d in worklog_dates(all_wls) if ws <= d <= we]
        created = to_date((t.get("created_at") or "")[:10])
        created_in_period = bool(created and ws <= created <= we)
        is_mine = bool(handler) and handler in (t.get("handler") or "")
        task_is_mine = task_id in my_task_ids
        last_wl = max(worklog_dates(all_wls)) if all_wls else None
        # 补充工单：本周期新建、但工时都记在本周期之前（先干活后补单）。
        # 这种工单的活已记在之前周期的周报里，不再重复生成；对应任务也一并跳过。
        if created_in_period and not p_dates and all_wls:
            supp_n += 1
            if skip_task_ids is not None and task_id:
                skip_task_ids.add(task_id)
            continue
        updated = to_date((t.get("updated_at") or "")[:10])
        status = status_raw.lower()
        score = t.get("score")
        # 已完成 / 已评分 / 待评分 都算「平台侧已收口」
        settled = status in ("completed", "closed", "rated", "pending_review") or (
            score not in (None, "", 0))
        completion = completion_date(settled, all_wls, updated, created)
        # 本周的工时记录（用来判断「自报完成」：备注写了完成，或工时进度填了 100）
        p_wls = [w for w in all_wls
                 if ws <= (to_date(w.get("work_date")) or date.min) <= we]
        last_p_wl = max(p_wls, key=lambda w: to_date(w.get("work_date")) or date.min) \
            if p_wls else None
        p_prog = max([w.get("progress") for w in p_wls
                      if isinstance(w.get("progress"), (int, float)) and w.get("progress")],
                     default=None)
        self_done = bool((last_p_wl and remark_done(last_p_wl.get("remark"))) or p_prog == 100)
        if p_dates:
            # 本周有我的工时：只有「平台收口且完成日落在本周」或「本周工时自报完成」才算 100%。
            # 不再用「之后没再记工时」倒推——那是在猜未来：下周还会不会接着写工时，本周无从得知。
            completed_in_period = bool(
                (settled and completion and ws <= completion <= we) or self_done)
        else:
            completed_in_period = bool(completion and ws <= completion <= we)

        # 只收本周期的内容：
        #   本周期内我有工时，或
        #   本周期新建（且是我处理/我负责的），或
        #   本周期内「收口完成」且处理人是我、且这张工单**没有任何工时记录**
        #   （跨周收尾：本周被点完成但没记工时。若有过工时、且工时都在周期外，
        #     说明活是之前干的、之前周报已记过，不能再算一次 —— 与「补充工单」同一原则）
        if not p_dates \
                and not (created_in_period and (is_mine or task_is_mine)) \
                and not (completed_in_period and is_mine and not all_wls):
            continue

        if p_dates:
            # 时间只用本周期内的工时日期（顺延到下周期的不算进来）
            lo, hi = p_dates[0], p_dates[-1]
        elif completed_in_period and completion:
            # 本周收尾完成、但没有本周工时：日期就是完成日
            lo = hi = completion
        else:
            lo = created
            hi = updated if (settled or updated) else created
            if workdays and lo:
                lo = snap_workday(lo, workdays, forward=True)
            if workdays and hi:
                hi = snap_workday(hi, workdays, forward=False)
        if not lo:
            continue
        if not hi or hi < lo:
            hi = lo
        if hi < ws or lo > we:
            continue
        lo = max(lo, ws)
        hi = min(hi, we)

        key = (t.get("school") or "", t.get("title") or "")
        if key in seen:
            continue
        seen.add(key)

        if is_mine:
            mine_n += 1
        if p_dates:
            wl_n += 1
        if task_is_mine and not is_mine and not p_dates:
            task_n += 1

        prog = None
        for w in all_wls:
            d = to_date(w.get("work_date"))
            if not (d and ws <= d <= we):
                continue
            p = w.get("progress")
            if isinstance(p, (int, float)) and p:
                prog = max(prog or 0, p)
        if completed_in_period:
            prog = 100
        elif prog is None:
            # 已完成但本周期还没完成 → 未完成，按处理中估算
            prog = 80 if settled else STATUS_PROGRESS.get(status, 50)
        if p_dates and not completed_in_period:
            # 本周期记了工时说明在推进，进度不低于 60%
            prog = max(prog, 60)

        # 关联任务的子任务情况（工单自身没有子任务，子任务挂在它关联的任务上）
        # 规则：子任务没全部完成 → 父任务/工单不算完成（进度最高 95%，有工时则不低于 60%）
        child_cc, child_cd = child_stats.get(task_id, (0, 0))
        children_pending = bool(child_cc) and child_cd < child_cc
        if children_pending:
            completed_in_period = False
            ratio = int(round(child_cd * 100.0 / child_cc))
            prog = min(prog, max(60, min(ratio, 95)))
        prog = max(0, min(100, int(prog)))
        # 周内未完成（进度不到 100%）→ 日期一直显示到本周周日，表示这件活还没收口
        if prog < 100 and hi < we:
            hi = we

        items.append({
            "category": ticket_category(t),
            "school": t.get("school") or "",
            "subject": t.get("title") or "",
            "time": fmt_range(lo, hi),
            "work": t.get("link") or "",
            "progress": f"{prog}%",
            "note": important_note(t, all_wls, ws, we),
            "candidates": [],
            "d1": lo.isoformat(),
            "d2": hi.isoformat(),
            "ticket_id": t.get("id", ""),
            "ticket_no": t.get("ticket_no", ""),
            "task_id": t.get("task_id", ""),
            "hours": round(sum(float(w.get("hours") or 0) for w in all_wls
                               if ws <= (to_date(w.get("work_date")) or date.min) <= we), 2),
            "source": "我处理" if is_mine else ("我记工时" if p_dates else "任务我负责"),
            "settled": completed_in_period,
            "done": completed_in_period,
        })

    items.sort(key=lambda x: (x["d1"], x["school"], x["subject"]))
    print(f"工单命中 {len(items)} 条（处理人是我 {mine_n} 条，本周期我记工时 {wl_n} 条，"
          f"任务我负责 {task_n} 条；跳过已取消 {cancelled_n} 条、补充工单 {supp_n} 条）")
    return items


# --------------------------------------------------------------------------
# 任务中心：我负责的任务 / 我有工时记录的任务
# --------------------------------------------------------------------------
def fetch_my_tasks(token, url=DEFAULT_MCP_URL, tool=TASK_LIST_TOOL, limit=25):
    """任务中心里与我相关的任务（作为负责人或参与人），分页拉全。"""
    client = McpClient(url, token)
    init = client.initialize()
    err = mcp_error(init)
    if err:
        raise SystemExit(f"MCP 初始化失败：{err}")

    out, page = [], 1
    while page <= 30:
        resp = call_with_retry(client, tool, {"page": page, "limit": limit})
        err = mcp_error(resp)
        # 任务正文长，响应会撞 64KB 预算：按服务端提示缩小分页重试
        if err and ("-32006" in str(err) or "64KB" in str(err)) and limit > 5:
            limit = max(5, limit // 2)
            print(f"  任务列表响应过大，limit 降到 {limit} 重试")
            continue
        if err:
            raise SystemExit(f"读取任务中心失败：{err}")
        data = json.loads(tool_texts(resp))
        items = data.get("items") or []
        out.extend(items)
        total = data.get("total")
        if not items or (isinstance(total, int) and len(out) >= total) or len(items) < limit:
            break
        page += 1
    owner = sum(1 for t in out if str(t.get("is_owner")) == "1")
    print(f"任务中心：{len(out)} 条（我负责 {owner} 条）")
    return out


def fetch_task_details(token, task_ids, url=DEFAULT_MCP_URL):
    """补拉不在「我的任务」列表里的任务详情（多为只记过工时、负责人是别人）。"""
    out = {}
    ids = [int(x) for x in task_ids if str(x).isdigit()]
    if not ids:
        return out
    client = McpClient(url, token)
    init = client.initialize()
    err = mcp_error(init)
    if err:
        print(f"提示：任务详情读取失败（{err}），这些任务不单独生成")
        return out
    for tid in ids:
        resp = call_with_retry(client, TASK_DETAIL_TOOL,
                                {"taskId": tid, "logLimit": 1, "worklogLimit": 1})
        if mcp_error(resp):
            continue
        try:
            out[str(tid)] = json.loads(tool_texts(resp))
        except json.JSONDecodeError:
            continue
    print(f"任务详情：补拉 {len(out)}/{len(ids)} 条")
    return out


def my_user_ids(tasks):
    """从我负责的任务里反推「我的 user id」（用于判断子任务的归属）。"""
    ids = set()
    for t in tasks or []:
        if str(t.get("is_owner")) != "1":
            continue
        for key in ("owner_user_id", "ownerUserId"):
            v = t.get(key)
            if v:
                try:
                    ids.add(int(v))
                except (TypeError, ValueError):
                    pass
        for a in (t.get("assignees") or []):
            if isinstance(a, dict) and a.get("userId"):
                try:
                    ids.add(int(a["userId"]))
                except (TypeError, ValueError):
                    pass
    return ids


def detail_to_task(detail, parent=None):
    """把 task_get_task_detail 的返回转成列表项的形状（供 build_items_from_tasks 复用）。

    注意（2026-11-11 实测踩过）：
    - 子任务标题常自带学校（「示例职业技术学院 示例产品_… 部署更新」），要**先按标题取学校**，
      只有标题里没有时才继承父任务的学校；否则所有子任务都会被归到父任务那所学校。
    - 子任务的类型/学校在详情里没有，**不能**直接继承父任务的 type_name——父任务可能是
      「项目问题反馈」（→项目运维），而子任务是「…部署更新」（应→交付部署）。
      这里留空，让 task_category 走标题关键词判断。
    """
    if not isinstance(detail, dict):
        return None
    tid = detail.get("taskId") or detail.get("id")
    if tid is None:
        return None
    title = detail.get("title") or ""
    children = detail.get("children") or []
    done_n = sum(1 for c in children
                 if isinstance(c, dict) and str(c.get("status") or "").strip() in TASK_DONE_STATUSES)
    school = split_school(title) or (parent or {}).get("school_name") or ""
    return {
        "id": tid,
        "title": title,
        "status": detail.get("status") or "",
        "progress": detail.get("progress"),
        "created_at": detail.get("createdAt") or detail.get("created_at") or "",
        "updated_at": detail.get("updatedAt") or detail.get("updated_at") or "",
        "actual_complete_time": detail.get("actualCompleteTime") or detail.get("actual_complete_time"),
        "owner_user_id": detail.get("ownerUserId") or detail.get("owner_user_id"),
        "assignees": detail.get("assignees") or [],
        "parent_task_id": detail.get("parentTaskId") or (parent or {}).get("id"),
        "child_count": len(children) or detail.get("childCount") or 0,
        "child_done": done_n or detail.get("childDone") or 0,
        "school_name": school,
        "product_name": (parent or {}).get("product_name") or "",
        # 类型留空：让 task_category 按子任务自己的标题判断
        "type_name": "",
        "type_l2_name": "",
    }


def fetch_subtask_tasks(token, mcp_url, parents, my_ids, known_ids, limit=80):
    """补拉「本期已纳入父任务」的子任务。

    背景（2026-11-11 实测）：task_list_my_tasks **不返回子任务**——父任务 1765 的
    两个子任务 1769/1770 明明负责人是我、本周期新建，却不在列表里，导致周报漏掉。
    这里只对「本期已确定纳入的父任务」逐个取 children（开销可控：每个父任务 1 次 + 每个子任务 1 次），
    再把子任务转成列表项形状返回，交给 build_items_from_tasks 按同一套规则判断。
    """
    out, used = [], 0
    if not parents:
        return out
    existing = {str(x) for x in (known_ids or set()) if str(x)}
    client = McpClient(mcp_url, token)
    init = client.initialize()
    if mcp_error(init):
        print(f"提示：子任务补录跳过（{mcp_error(init)}）")
        return out

    for parent in parents:
        if used >= limit:
            print(f"子任务补录：达到请求上限 {limit}，其余跳过")
            break
        pid = parent.get("id") or parent.get("taskId")
        if pid is None:
            continue
        resp = call_with_retry(client, TASK_DETAIL_TOOL,
                                {"taskId": pid, "logLimit": 1, "worklogLimit": 1})
        used += 1
        if mcp_error(resp):
            continue
        try:
            pdet = json.loads(tool_texts(resp))
        except json.JSONDecodeError:
            continue

        for child in (pdet.get("children") or []):
            if used >= limit:
                break
            cid = child.get("id")
            if cid is None or str(cid) in existing:
                continue
            cresp = call_with_retry(client, TASK_DETAIL_TOOL,
                                     {"taskId": cid, "logLimit": 1, "worklogLimit": 1})
            used += 1
            if mcp_error(cresp):
                continue
            try:
                cdet = json.loads(tool_texts(cresp))
            except json.JSONDecodeError:
                continue
            item = detail_to_task(cdet, parent)
            if not item:
                continue
            owner = item.get("owner_user_id")
            try:
                owner = int(owner) if owner is not None else None
            except (TypeError, ValueError):
                owner = None
            assignee_ids = set()
            for a in (item.get("assignees") or []):
                if isinstance(a, dict) and a.get("userId"):
                    try:
                        assignee_ids.add(int(a["userId"]))
                    except (TypeError, ValueError):
                        pass
            item["is_owner"] = "1" if (owner in my_ids or assignee_ids & my_ids) else "0"
            item["is_assignee"] = "1" if assignee_ids & my_ids else "0"
            existing.add(str(cid))
            out.append(item)

    if out:
        print(f"子任务补录：{len(out)} 条（来自 {len(parents)} 个本期父任务，"
              f"共 {used} 次请求）")
    return out


def task_category(t):
    """任务类型 → 周报类别。"""
    for name in (t.get("type_name"), t.get("typeName"), t.get("type_l2_name")):
        name = str(name or "").strip()
        if not name:
            continue
        if name in TASK_TYPE_CATEGORY:
            return TASK_TYPE_CATEGORY[name]
        for key, cat in TASK_TYPE_CATEGORY.items():
            if key in name:
                return cat
        for kw, cat in (("部署", "交付部署"), ("实施", "交付部署"), ("升级", "交付部署"),
                        ("运维", "项目运维"), ("排查", "项目运维"), ("修复", "项目运维"),
                        ("故障", "项目运维")):
            if kw in name:
                return cat
    # 只有任务详情、没有类型名时（如只记过工时的任务），按标题关键词兜底
    title = str(t.get("title") or "")
    for kw, cat in (("漏洞", "项目运维"), ("BUG", "项目运维"), ("bug", "项目运维"),
                    ("问题", "项目运维"), ("故障", "项目运维"), ("部署", "交付部署"),
                    ("实施", "交付部署"), ("升级", "交付部署")):
        if kw in title:
            return cat
    return "项目支撑"


def _as_int(v, default=0):
    """宽松转 int：None/空串/非法值都给默认值，绝不抛异常。"""
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def task_child_stats(t):
    """任务的子任务统计 → (child_count, child_done)；没有子任务返回 (0, 0)。

    数据来源有两处，合并取较全的那个：
    - 列表接口 task_list_my_tasks：child_count / child_done（快，不用额外请求）
    - 详情接口 task_get_task_detail：children 列表（只有 id/title/status/progress，**不含工时**）
    注意：children 里没有工时明细，想算子任务工时要逐个再查，本次不用。
    """
    if not isinstance(t, dict):
        return 0, 0
    cc = _as_int(t.get("child_count", t.get("childCount")), 0)
    cd = _as_int(t.get("child_done", t.get("childDone")), 0)
    children = t.get("children")
    if isinstance(children, list) and children:
        cc = max(cc, len(children))
        done_n = sum(
            1 for c in children
            if isinstance(c, dict) and str(c.get("status") or "").strip() in TASK_DONE_STATUSES
        )
        cd = max(cd, done_n)
    cc = max(0, cc)
    return cc, max(0, min(cd, cc))


def task_parent_id(t):
    """任务的父任务 ID（顶级任务返回空串）。只有列表接口返回 parent_task_id。"""
    if not isinstance(t, dict):
        return ""
    v = t.get("parent_task_id", t.get("parentTaskId"))
    if v in (None, "", 0, "0"):
        return ""
    return str(v)


def subtask_note(cd, cc, folded=None):
    """子任务进度文案：'子任务 27/34 完成'。

    注意：2026-11-11 起「重要说明」列默认只写「无」，子任务进度不再塞进这一列
    （用户要求保留原格式）；子任务改为独立成条，见 important_note()。
    """
    parts = []
    if cc:
        parts.append(f"子任务 {cd}/{cc} 完成")
    names = [n for n in (folded or []) if n]
    if names:
        shown = "、".join(names[:3])
        if len(names) > 3:
            shown += f" 等 {len(names)} 项"
        parts.append(f"含子任务：{shown}")
    return "；".join(parts) if parts else "无"


# 「重要说明」列：默认写「无」；只有带特别标记的内容才填入
# （风险预警字段、或本周期工时备注里出现下面这些词）
IMPORTANT_MARKERS = ("重要", "注意", "风险", "延期", "阻塞", "遗留", "待跟进", "紧急", "重点", "待确认")


def important_note(t, all_wls=None, ws=None, we=None):
    """重要说明：默认「无」；有特别标记才填。

    取值顺序：
    1. 任务的「风险预警」字段（risk_warning）非空 → 直接填它
    2. 本周期工时备注里含 IMPORTANT_MARKERS 里的词 → 填该备注
    3. 否则「无」
    """
    if isinstance(t, dict):
        risk = str(t.get("risk_warning") or t.get("riskWarning") or "").strip()
        if risk:
            return risk[:60]
    for w in (all_wls or []):
        d = to_date(w.get("work_date"))
        if ws and we and not (d and ws <= d <= we):
            continue
        note = str(w.get("remark") or "").strip()
        if note and any(k in note for k in IMPORTANT_MARKERS):
            return note[:60]
    return "无"


def bulk_import_hours(tasks, window_hours=1, min_count=20):
    """找出「批量补录」的创建时间段，返回 {小时键: 该小时内我负责的新建数}。

    背景（2026-11-11 实测）：平台在 11-10 19:23~19:40 的 18 分钟里批量创建了 130+ 个
    我负责的任务，创建/开始/完成都在同一秒，但工时全是 2026 年 1 月的——属于历史数据补录。
    这类任务如果因为「本周期新建且我负责」被写进周报，本周会凭空多出 130 多条 1 月的活。

    判据：同一小时内「我负责 + 本周期新建」的任务数 >= min_count（默认 20）——
    一个人一小时内手建 20 个任务基本不可能，只有批量导入会这样。
    命中这个小时的任务，必须本周期有我的工时才算（工时才是真凭据）。
    """
    from collections import Counter
    cnt = Counter()
    for t in tasks or []:
        if str(t.get("is_owner")) != "1":
            continue
        ca = str(t.get("created_at") or t.get("createdAt") or "")
        if len(ca) >= 13:
            cnt[ca[:13]] += 1          # "YYYY-MM-DD HH"
    return {hour: n for hour, n in cnt.items() if n >= max(2, int(min_count))}


def build_items_from_tasks(tasks, worklogs, handler, ws, we,
                           covered_task_ids=None, details=None, ticket_links=None,
                           workdays=None, skip_task_ids=None):
    """任务中心 → 周报条目：本周期内我有工时的任务，或本周期新建且我负责的任务；已取消跳过。

    - 不按「日期跨度有交集」兜底：上周期就已完成、本周只是到期日变动的旧任务不会进来；
    - 完成判断与工单一致：任务状态 / 完成时间，或本周工时备注写了完成 / 工时进度 100；
      完成日不在本周期 → 本周期记未完成；
    - covered_task_ids：已由工单生成条目的任务，避免重复；
    - details / ticket_links：同前。
    """
    covered = {str(x) for x in (covered_task_ids or set()) if str(x)}
    skip_tasks = {str(x) for x in (skip_task_ids or set()) if str(x)}
    ticket_links = {str(k): v for k, v in (ticket_links or {}).items() if v}
    by_id = {}
    for t in tasks or []:
        tid = t.get("id", t.get("taskId"))
        if tid is not None:
            by_id[str(tid)] = t
    for tid, d in (details or {}).items():
        if str(tid) not in by_id and isinstance(d, dict):
            by_id[str(tid)] = d

    by_task = {}
    for w in worklogs or []:
        by_task.setdefault(str(w.get("task_id")), []).append(w)
    for tid in by_task:
        by_id.setdefault(tid, {})

    items, owner_n, wl_n, cancelled_n, bulk_n, seen = [], 0, 0, 0, 0, set()
    bulk_hours = bulk_import_hours(tasks)
    for tid, t in by_id.items():
        status = str(t.get("status") or "").strip()
        if is_cancelled_status(status):
            cancelled_n += 1
            continue
        is_owner = str(t.get("is_owner", t.get("isOwner", ""))) == "1"
        all_wls = by_task.get(tid) or []
        p_dates = [d for d in worklog_dates(all_wls) if ws <= d <= we]
        created = to_date(str(t.get("created_at") or t.get("createdAt") or "")[:10])
        created_in_period = bool(created and ws <= created <= we)
        # 先算完成情况（下面纳入判断要用）
        _updated0 = to_date(str(t.get("updated_at") or t.get("updatedAt") or "")[:10])
        _complete0 = to_date(str(t.get("actual_complete_time")
                                 or t.get("actualCompleteTime") or "")[:10])
        _done0 = status in TASK_DONE_STATUSES or bool(_complete0)
        _completion0 = completion_date(_done0, all_wls, _updated0, created)
        done_in_period = bool(_completion0 and ws <= _completion0 <= we)

        if not p_dates:
            # 本周期没有我的工时：
            #   本周期新建且我负责，或
            #   本周期内收口完成且我负责、且这个任务**没有任何工时记录**
            #   （有过工时但都在周期外的，是之前干的活，不能重复算）
            ok_created = created_in_period
            ok_done = done_in_period and not all_wls
            if not (is_owner and (ok_created or ok_done)):
                continue
            # 批量补录的任务：创建时间落在批量导入时段，且本周期没有我的工时 → 不是本周的活
            hour_key = str(t.get("created_at") or t.get("createdAt") or "")[:13]
            if hour_key in bulk_hours:
                bulk_n += 1
                continue
        if tid in covered or tid in skip_tasks:
            continue

        title = str(t.get("title") or "").strip()
        if not title and all_wls:
            title = str(all_wls[0].get("task_name") or "").strip()
        if not title:
            continue

        school = str(t.get("school_name") or t.get("schoolName") or "").strip()
        product = str(t.get("product_name") or t.get("productName") or "").strip()
        if not school:
            school = split_school(title) or product
        # 任务标题常带学校前缀（「XX学院 …」），事项列去掉，避免和学校列重复
        subject = title
        if school and subject.startswith(school):
            subject = subject[len(school):].strip(" -—·")
        if not subject:
            subject = title

        updated = to_date(str(t.get("updated_at") or t.get("updatedAt") or "")[:10])
        complete = to_date(str(t.get("actual_complete_time") or t.get("actualCompleteTime") or "")[:10])
        done = status in TASK_DONE_STATUSES or bool(complete)
        completion = completion_date(done, all_wls, updated, created)
        # 与工单同一口径：本周有工时 → 平台收口（完成日在本周）或本周工时自报完成才算 100%
        p_wls = [w for w in all_wls
                 if ws <= (to_date(w.get("work_date")) or date.min) <= we]
        last_p_wl = max(p_wls, key=lambda w: to_date(w.get("work_date")) or date.min) \
            if p_wls else None
        p_prog = max([w.get("progress") for w in p_wls
                      if isinstance(w.get("progress"), (int, float)) and w.get("progress")],
                     default=None)
        self_done = bool((last_p_wl and remark_done(last_p_wl.get("remark"))) or p_prog == 100)
        if p_dates:
            completed_in_period = bool(
                (done and completion and ws <= completion <= we) or self_done)
        else:
            completed_in_period = bool(completion and ws <= completion <= we)

        if p_dates:
            lo, hi = p_dates[0], p_dates[-1]
        elif completed_in_period and completion:
            # 本周收尾完成、但没有本周工时：日期就是完成日
            lo = hi = completion
        else:
            lo = created
            hi = min(updated, we) if updated else created
            if workdays and lo:
                lo = snap_workday(lo, workdays, forward=True)
            if workdays and hi:
                hi = snap_workday(hi, workdays, forward=False)
        if not lo:
            continue
        if not hi or hi < lo:
            hi = lo
        if hi < ws or lo > we:
            continue
        lo = max(lo, ws)
        hi = min(hi, we)

        key = (school or "", subject)
        if key in seen:
            continue
        seen.add(key)
        if is_owner:
            owner_n += 1
        if p_dates:
            wl_n += 1

        prog = None
        for w in all_wls:
            d = to_date(w.get("work_date"))
            if not (d and ws <= d <= we):
                continue
            p = w.get("progress")
            if isinstance(p, (int, float)) and p:
                prog = max(prog or 0, p)
        if completed_in_period:
            prog = 100
        elif prog is None:
            task_prog = t.get("progress")
            if isinstance(task_prog, (int, float)) and task_prog:
                prog = int(task_prog)
        if prog is None:
            prog = 80 if done else TASK_STATUS_PROGRESS.get(status, 50)
        # 子任务完成率：比任务状态更接近真实进展
        # （实测「一平三端 FIX 1 漏洞修复」状态是「新建」，但子任务已完成 27/34）
        # 规则：子任务没全部完成 → 父任务不算完成，进度最高 95%
        child_cc, child_cd = task_child_stats(t)
        children_pending = bool(child_cc) and child_cd < child_cc
        if child_cc:
            ratio = int(round(child_cd * 100.0 / child_cc))
            if children_pending:
                completed_in_period = False
                prog = min(prog, max(60, min(ratio, 95)))
            else:
                # 子任务全完成，但父任务可能还没点「完成」——留 5% 余地，不臆断 100%
                prog = max(prog, 95)
        if p_dates and not completed_in_period:
            # 本周期记了工时说明在推进，进度不低于 60%
            prog = max(prog, 60)
        prog = max(0, min(100, int(prog)))
        # 周内未完成（进度不到 100%）→ 日期一直显示到本周周日，表示这件活还没收口
        if prog < 100 and hi < we:
            hi = we

        items.append({
            "category": task_category(t),
            "school": school,
            "subject": subject,
            "time": fmt_range(lo, hi),
            "work": ticket_links.get(tid) or DEFAULT_TASK_LINK.format(id=tid),
            "progress": f"{prog}%",
            "note": important_note(t, all_wls, ws, we),
            "candidates": [],
            "d1": lo.isoformat(),
            "d2": hi.isoformat(),
            "ticket_id": "",
            "ticket_no": "",
            "task_id": tid,
            "parent_id": task_parent_id(t),
            "child_cc": child_cc,
            "child_cd": child_cd,
            "hours": round(sum(float(w.get("hours") or 0) for w in all_wls
                               if ws <= (to_date(w.get("work_date")) or date.min) <= we), 2),
            "source": "我负责" if is_owner else "任务我记工时",
            "settled": completed_in_period,
            "done": completed_in_period,
        })

    items.sort(key=lambda x: (x["d1"], x["school"], x["subject"]))
    print(f"任务中心命中 {len(items)} 条（我负责 {owner_n} 条，本周期我记工时 {wl_n} 条；"
          f"跳过已取消 {cancelled_n} 条、批量补录 {bulk_n} 条）")
    return items


def merge_items(*groups):
    """合并多组条目：同一 (学校, 事项) 只留先出现的，最后按开始日期排序。"""
    out, seen = [], set()
    for group in groups:
        for it in group or []:
            key = (it.get("school") or "", it.get("subject") or "")
            if key in seen:
                continue
            seen.add(key)
            out.append(it)
    out.sort(key=lambda x: (x["d1"], x["school"], x["subject"]))
    return out


def collect_items(token, mcp_url, handler, ws, we, mcp_tool=None, mcp_args=None,
                  with_tasks=True):
    """周报条目总入口：工单（处理人/本周期工时/关联任务我负责）＋ 任务中心（本周期工时/本周期新建我负责）。

    工时按「周期前 60 天 ~ 今天」拉取：既知道本周期记了哪些，也能判断周期之后是否还有
    工时（有 → 说明该周期还没做完）。
    """
    tickets, _ = fetch_tickets_via_mcp(token, mcp_url, mcp_tool, mcp_args,
                                       handler_filter=handler)
    wl_start = ws - timedelta(days=60)
    wl_end = max(we, _today_cn())
    worklogs = fetch_my_worklogs(token, mcp_url, wl_start, wl_end)
    workdays = fetch_workdays(token, mcp_url, ws, we)

    my_task_ids, task_items = set(), []
    supp_task_ids = set()
    if with_tasks:
        try:
            tasks = fetch_my_tasks(token, mcp_url)
            my_task_ids = {str(t.get("id")) for t in tasks
                           if str(t.get("is_owner")) == "1"}
            # 工单本身没有子任务字段，子任务挂在它关联的任务上；先备好映射给工单用
            child_stats = {str(t.get("id")): task_child_stats(t) for t in tasks
                           if t.get("id") is not None}
            items = build_items_from_tickets(tickets, worklogs, handler, ws, we,
                                             my_task_ids=my_task_ids,
                                             workdays=workdays,
                                             skip_task_ids=supp_task_ids,
                                             child_stats=child_stats)
            covered = {str(i.get("task_id")) for i in items if i.get("task_id")}
            wl_task_ids = {str(w.get("task_id")) for w in worklogs
                           if w.get("task_id") is not None}
            known = {str(t.get("id")) for t in tasks}
            missing = sorted(wl_task_ids - known)
            details = fetch_task_details(token, mcp_url, missing) if missing else {}

            # 子任务补录：列表接口不返回子任务，只有「本期已纳入的父任务」才去取 children
            # （如工单 505 关联任务 1765 的两个子任务 1769/1770，本周期新建、负责人是我）
            known_all = known | set(details)
            parents_to_expand = []
            for t in tasks:
                cc = int(task_child_stats(t)[0] or 0)
                if cc <= 0:
                    continue
                tid = str(t.get("id"))
                p_dates = [d for d in worklog_dates(
                    [w for w in worklogs if str(w.get("task_id")) == tid]) if ws <= d <= we]
                created = to_date(str(t.get("created_at") or t.get("createdAt") or "")[:10])
                created_in_period = bool(created and ws <= created <= we)
                done_period = False
                if not p_dates and str(t.get("is_owner")) != "1":
                    continue
                if p_dates or (str(t.get("is_owner")) == "1" and created_in_period) or done_period:
                    parents_to_expand.append(t)
            subtasks = fetch_subtask_tasks(token, mcp_url, parents_to_expand,
                                           my_user_ids(tasks), known_all)
            if subtasks:
                tasks = list(tasks) + subtasks
                my_task_ids |= {str(t.get("id")) for t in subtasks
                                if str(t.get("is_owner")) == "1"}

            # 任务有对应工单时，「工作内容」优先给工单链接（工单页比任务页更完整）
            ticket_links = {str(t.get("task_id")): t.get("link")
                            for t in tickets if t.get("task_id") is not None}
            task_items = build_items_from_tasks(tasks, worklogs, handler, ws, we,
                                                covered_task_ids=covered, details=details,
                                                ticket_links=ticket_links,
                                                workdays=workdays,
                                                skip_task_ids=supp_task_ids)
        except SystemExit as e:
            print(f"提示：任务中心读取失败，本次只按工单生成（{e}）")
            items = build_items_from_tickets(tickets, worklogs, handler, ws, we,
                                             workdays=workdays)
    else:
        items = build_items_from_tickets(tickets, worklogs, handler, ws, we,
                                         workdays=workdays)

    merged = merge_items(items, task_items)
    if task_items:
        print(f"合计 {len(merged)} 条（工单 {len(items)} + 任务中心 {len(task_items)}，"
              f"去重后 {len(merged)}）")
    return merged


# --------------------------------------------------------------------------
# 绩效文档：本月全部周报内容 → 月度考核表（跨周累积，模板格式保持不变）
#
# 规则（2026-11-11 起）：
#   · 绩效表 = 本月所有周报内容的合集；每周生成周报时把本周条目并进当月表；
#   · 同一事项（学校+事项，忽略空格与标点）跨周只占一行：起止时间取并集、
#     「是否完成」取或、备注（M 列）保留，不再因为每周重跑把前几周的内容冲掉；
#   · 只写 B/D/J/K/L/M 六列，模板其它单元格、合并区域、字体、行高一概不动；
#   · 每次生成后自检（对照本月各周周报文本）并补齐缺失；月底（本轮已覆盖月末）
#     输出完整核对报告（内容 / 时间 / 完成标记 / 格式）。
# --------------------------------------------------------------------------
PERF_CAT_COL, PERF_CONTENT_COL = 2, 4            # 类别 / 学校+事项
PERF_START_COL, PERF_END_COL = 10, 11            # 开始时间 / 结束时间
PERF_DONE_COL, PERF_NOTE_COL = 12, 13            # 是否完成 / 备注


def perf_sheet(wb):
    """月度考核表所在工作表（模板里叫「月度考核」，没有就用最后一个）。"""
    return wb["月度考核"] if "月度考核" in wb.sheetnames else wb[wb.sheetnames[-1]]


def perf_month_text(year, month):
    return f"{year}年{month}月"


def perf_task_zone(ws):
    """任务区：(起始行, 可填行数, 「工作任务考核」区块所在行)。"""
    sec_row = None
    for r in range(7, ws.max_row + 1):
        v = ws.cell(r, PERF_CAT_COL).value
        if isinstance(v, str) and "工作任务考核" in v:
            sec_row = r
            break
    if sec_row is None:
        sec_row = 22
    return 7, max(1, sec_row - 7), sec_row


def perf_path_for(folder, handler, year, month):
    """当月绩效表路径：<绩效表目录>/<YYYY>/YYYY年M月<处理人>员工月度考核表-交付中心.xlsx"""
    root = os.path.normpath(folder)
    if re.fullmatch(r"\d{4}", os.path.basename(root)):
        root = os.path.dirname(root)
    return os.path.join(root, str(year),
                        f"{year}年{month}月{handler}员工月度考核表-交付中心.xlsx")


def perf_dump(path):
    """把绩效表读成可展示的结构（JSON 友好）：基本信息 + 任务区每一行。"""
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = perf_sheet(wb)
    start, cap, sec_row = perf_task_zone(ws)
    rows = read_perf_rows(ws, start, cap)
    items = []
    for r in rows:
        d1, d2 = r.get("d1"), r.get("d2")
        items.append({
            "category": r.get("category") or "",
            "content": r.get("content") or "",
            "d1": d1.isoformat() if d1 else "",
            "d2": d2.isoformat() if d2 else "",
            "settled": bool(r.get("settled")),
            "note": (r.get("note") or "") if isinstance(r.get("note"), str) else "",
        })
    done_n = sum(1 for it in items if it["settled"])
    return {
        "path": os.path.abspath(path),
        "name": os.path.basename(path),
        "sheet": ws.title,
        "handler": str(ws.cell(3, 4).value or ""),
        "period": str(ws.cell(4, 4).value or ""),
        "filled_at": (ws.cell(3, 11).value.isoformat()
                      if hasattr(ws.cell(3, 11).value, "isoformat") else ""),
        "rows": items,
        "total": len(items),
        "done": done_n,
        "undone": len(items) - done_n,
    }


def _shift_rows_down(ws, at_row, n):
    """在 at_row 处插入 n 行：整体下移单元格、样式、行高与合并区域。"""
    from copy import copy as _copy
    from openpyxl.cell.cell import MergedCell
    max_row, max_col = ws.max_row, ws.max_column

    for r in range(max_row, at_row - 1, -1):
        for c in range(1, max_col + 1):
            src = ws.cell(r, c)
            dst = ws.cell(r + n, c)
            if isinstance(dst, MergedCell):
                continue
            if not isinstance(src, MergedCell):
                dst.value = src.value
            if src.has_style:
                try:
                    dst._style = _copy(src._style)
                except Exception:
                    pass
        h = ws.row_dimensions[r].height
        if h:
            ws.row_dimensions[r + n].height = h

    # 合并区域整体下移（区间起点在插入点之后的）
    moved = []
    for rng in list(ws.merged_cells.ranges):
        if rng.min_row >= at_row:
            moved.append(rng)
            ws.unmerge_cells(str(rng))
    for rng in moved:
        ws.merge_cells(start_row=rng.min_row + n, start_column=rng.min_col,
                       end_row=rng.max_row + n, end_column=rng.max_col)

    # 插入出来的空行：清空值，样式沿用上方数据行
    for r in range(at_row, at_row + n):
        for c in range(1, max_col + 1):
            cell = ws.cell(r, c)
            src = ws.cell(at_row - 1, c)
            if not isinstance(cell, MergedCell):
                cell.value = None
                if src.has_style:
                    try:
                        cell._style = _copy(src._style)
                    except Exception:
                        pass
        for rng in (f"B{r}:C{r}", f"D{r}:I{r}", f"M{r}:N{r}"):
            try:
                ws.merge_cells(rng)
            except Exception:
                pass


def read_perf_rows(ws, start=7, cap=None):
    """读任务区里已有的条目（跨周累积、月底核对共用）。"""
    if cap is None:
        start, cap, _ = perf_task_zone(ws)
    rows = []
    for i in range(cap):
        r = start + i
        content = ws.cell(r, PERF_CONTENT_COL).value
        cat = ws.cell(r, PERF_CAT_COL).value
        if content is None:
            continue
        text = str(content).strip()
        if not text:
            continue
        rows.append({
            "category": str(cat).strip() if cat is not None else "",
            "content": text,
            "d1": to_date(ws.cell(r, PERF_START_COL).value),
            "d2": to_date(ws.cell(r, PERF_END_COL).value),
            "settled": str(ws.cell(r, PERF_DONE_COL).value or "").strip() == "是",
            "note": ws.cell(r, PERF_NOTE_COL).value,
        })
    return rows


def items_to_perf_rows(items):
    """周报条目 → 绩效表行（内容 = 学校名 + 事项，与模板填法一致）。"""
    rows = []
    for it in items or []:
        content = f"{it.get('school') or ''}{it.get('subject') or ''}".strip()
        if not content:
            continue
        note = it.get("note")
        rows.append({
            "category": (it.get("category") or "").strip(),
            "content": content,
            "d1": to_date(it.get("d1")),
            "d2": to_date(it.get("d2")),
            "settled": bool(it.get("settled")),
            "note": None if note in (None, "", "无") else note,
        })
    return rows


def perf_key(content):
    """同一事项的判定键：忽略空格、标点与大小写。"""
    return norm(content) or (content or "").strip()


def merge_perf_rows(*groups):
    """把多组条目并成一个月度清单：同一事项只留一行（时间取并集、完成取或）。"""
    merged, index = [], {}
    for group in groups:
        for row in group or []:
            content = (row.get("content") or "").strip()
            if not content:
                continue
            key = perf_key(content)
            cur = index.get(key)
            if cur is None:
                copy_row = dict(row)
                copy_row["content"] = content
                index[key] = copy_row
                merged.append(copy_row)
                continue
            d1s = [d for d in (cur.get("d1"), row.get("d1")) if d]
            d2s = [d for d in (cur.get("d2"), row.get("d2")) if d]
            cur["d1"] = min(d1s) if d1s else None
            cur["d2"] = max(d2s) if d2s else None
            cur["settled"] = bool(cur.get("settled")) or bool(row.get("settled"))
            if not cur.get("category"):
                cur["category"] = (row.get("category") or "").strip()
            if (cur.get("note") in (None, "", "无")) and (row.get("note") not in (None, "", "无")):
                cur["note"] = row["note"]
    merged.sort(key=lambda r: (r.get("d1") or date.min,
                               perf_key(r.get("content")), r.get("content") or ""))
    return merged


def _write_task_rows(ws, rows, start=7):
    """把条目写进任务区：只动 B/D/J/K/L/M 六列；行数不够时下移考核区块，版面不变。"""
    from openpyxl.cell.cell import MergedCell
    from openpyxl.styles import Font as _Font

    _, cap, sec_row = perf_task_zone(ws)
    n = len(rows)
    if n > cap:
        _shift_rows_down(ws, sec_row, n - cap)
        cap = n

    owned = (PERF_CAT_COL, PERF_CONTENT_COL, PERF_START_COL,
             PERF_END_COL, PERF_DONE_COL, PERF_NOTE_COL)
    for i in range(cap):
        r = start + i
        for c in owned:
            cell = ws.cell(r, c)
            if isinstance(cell, MergedCell):
                continue
            cell.value = None

    for i, row in enumerate(rows):
        r = start + i
        ws.cell(r, PERF_CAT_COL).value = row.get("category") or None
        ws.cell(r, PERF_CONTENT_COL).value = row.get("content")
        d1, d2 = row.get("d1"), row.get("d2")
        c1, c2 = ws.cell(r, PERF_START_COL), ws.cell(r, PERF_END_COL)
        if d1:
            c1.value = datetime.combine(d1, datetime.min.time())
            c1.number_format = "yyyy/m/d"
        if d2:
            c2.value = datetime.combine(d2, datetime.min.time())
            c2.number_format = "yyyy/m/d"
        ws.cell(r, PERF_DONE_COL).value = "是" if row.get("settled") else "否"
        if row.get("note") not in (None, "", "无"):
            ws.cell(r, PERF_NOTE_COL).value = row["note"]

    # 统一字体：填写的单元格都用微软雅黑 10 号，颜色沿用模板基准色，
    # 避免部分行继承了默认字体（宋体/其它颜色）导致观感不一致
    base = ws.cell(start, PERF_CAT_COL).font
    color = base.color if (base.color and base.color.type == "rgb") else None
    for i in range(cap):
        r = start + i
        for c in (PERF_CAT_COL, PERF_CONTENT_COL, PERF_START_COL,
                  PERF_END_COL, PERF_DONE_COL):
            cell = ws.cell(r, c)
            if isinstance(cell, MergedCell):
                continue
            cell.font = _Font(name="微软雅黑", size=10, bold=False,
                              italic=False, color=color)


def _score_formulas(ws):
    """按月表的三个考核区块算出「考核评分 / 最终评分」应有的公式。

    模板里 K4 = SUM(M{60%区块评分首行}:N{末行})、M4 = 60%*0.6 + 30%*0.3 + 10%*0.1；
    行数变化（任务区扩容）后这些引用必须跟着区块走，不能还指着任务区。
    """
    secs = {}
    for r in range(7, ws.max_row + 1):
        v = ws.cell(r, PERF_CAT_COL).value
        if not isinstance(v, str):
            continue
        if "工作任务考核" in v:
            secs.setdefault("task", r)
        elif "工作绩效考核" in v:
            secs.setdefault("work", r)
        elif "品质" in v:
            secs.setdefault("moral", r)
    if len(secs) != 3:
        return None
    s1, s2, s3 = secs["task"], secs["work"], secs["moral"]
    total = f"SUM(M{s1 + 2}:N{s1 + 6})"
    return f"={total}", (f"={total}*0.6+SUM(M{s2 + 2}:N{s2 + 7})*0.3"
                         f"+SUM(M{s3 + 2}:N{s3 + 5})*0.1")


def _fix_score_formulas(ws):
    """把考核评分公式校正到当前区块位置；改了就返回 True。"""
    wanted = _score_formulas(ws)
    if not wanted:
        return False
    changed = False
    for coord, val in (("K4", wanted[0]), ("M4", wanted[1])):
        cell = ws[coord]
        if cell.value != val:
            cell.value = val
            changed = True
    return changed


def build_perf_xlsx(template_path, out_path, items, year, month, handler="张三",
                    accumulate=True):
    """把本月条目写进月度考核表（模板版式保持不变，只填任务行）。

    template_path 与 out_path 是同一个文件时（就地重填），先读出表里已有的行再合并，
    于是每周生成只会在当月表上追加/更新，不会把前几周内容冲掉。
    返回实际写出的路径（文件被 Excel 占用时会写成 *_新.xlsx）。
    """
    import openpyxl
    from datetime import datetime as _dt

    wb = openpyxl.load_workbook(template_path)
    ws = perf_sheet(wb)
    start, cap, _sec = perf_task_zone(ws)

    same_file = os.path.abspath(str(template_path)) == os.path.abspath(str(out_path))
    tag = perf_month_text(year, month)
    existing = []
    if accumulate and same_file:
        d4 = ws.cell(4, 4).value
        if isinstance(d4, str) and tag in d4:
            existing = read_perf_rows(ws, start, cap)
        else:
            print(f"提示：表头月份（{d4}）不是 {tag}，本次按模板重填任务行（不累积旧行）")
    elif accumulate and os.path.isfile(out_path):
        print("提示：用外部模板生成，表里已有的条目未参与累积（别把 --perf-template 当日常用法）")

    before = {perf_key(r["content"]) for r in existing if r.get("content")}
    rows = merge_perf_rows(existing, items_to_perf_rows(items))
    added = sum(1 for r in rows if perf_key(r.get("content")) not in before)

    _write_task_rows(ws, rows)

    # 基本信息：处理人 / 考核月份 / 填报时间
    try:
        ws["D3"] = handler
        last = 31 if month in (1, 3, 5, 7, 8, 10, 12) else (30 if month != 2 else 28)
        ws["D4"] = f"{year}年{month}月1日-{month}月{last}日"
        ws["K3"] = _dt.now().replace(microsecond=0)
    except Exception:
        pass

    # 行数变了，考核评分公式要跟着区块走（模板本来对得上时这句话什么也不改）
    if _fix_score_formulas(ws):
        print("已校正考核评分公式（K4/M4）指向本次的考核区块")

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    try:
        wb.save(out_path)
    except PermissionError:
        alt = os.path.splitext(out_path)[0] + "_新.xlsx"
        wb.save(alt)
        print(f"警告：{out_path} 正被 Excel 占用，已改写到 {alt}，"
              f"关闭 Excel 后重跑即可覆盖原文件")
        return alt
    print(f"绩效文档：{out_path}（本月共 {len(rows)} 条，本次新增 {added} 条，"
          f"沿用表内原有 {len(existing)} 条）")
    return out_path


# --------------------------------------------------------------------------
# 绩效表核对：内容对本月各周周报、时间、完成标记、格式
# --------------------------------------------------------------------------
_WEEK_FILE_RE = re.compile(r"周报_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.txt$")
_REPORT_TIME_RE = re.compile(
    r"(\d{4})年(\d{1,2})月(\d{1,2})日"
    r"(?:\s*[-~—–至到]\s*(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})日)?")


def parse_report_time(text):
    """「2026年11月9日」/「2026年11月9日-15日」/「2026年11月9日-12月15日」→ (d1, d2)。"""
    m = _REPORT_TIME_RE.search(text or "")
    if not m:
        return None, None
    y, mo, d, y2, mo2, d2 = m.groups()
    try:
        d1 = date(int(y), int(mo), int(d))
        if not d2:
            return d1, d1
        return d1, date(int(y2 or y), int(mo2 or mo), int(d2))
    except ValueError:
        return None, None


def parse_weekly_report(path):
    """解析一份周报 txt（引擎输出的固定格式），返回条目列表。"""
    with open(path, "r", encoding="utf-8-sig") as f:
        lines = f.read().splitlines()
    items, cur = [], None
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        head = re.match(r"^【(.+?)】$", stripped)
        if head and not line.startswith((" ", "\t")):
            if cur and cur.get("subject"):
                items.append(cur)
            cur = {"category": head.group(1).strip(), "school": "",
                   "time": "", "subject": "", "work": "", "progress": ""}
            continue
        if cur is None:
            continue
        if not line.startswith((" ", "\t")):
            if not cur["school"]:
                cur["school"] = stripped
            continue
        for key, label in (("time", "时间"), ("subject", "事项"),
                           ("work", "工作内容"), ("progress", "进度")):
            m = re.match(rf"^{label}\s*[:：]\s*(.*)$", stripped)
            if m:
                cur[key] = m.group(1).strip()
                break
    if cur and cur.get("subject"):
        items.append(cur)

    out = []
    for it in items:
        d1, d2 = parse_report_time(it["time"])
        out.append({
            "category": it["category"],
            "school": it["school"],
            "subject": it["subject"],
            "d1": d1, "d2": d2,
            "settled": it["progress"].startswith("100"),
            "note": None,
            "file": os.path.basename(path),
        })
    return out


def weekly_reports_for_month(year, month):
    """本月各周的周报文件：按「周结束日期所在月」归属（与绩效表的月份口径一致）。"""
    out = []
    if not os.path.isdir(OUT_DIR):
        return out
    folders = [OUT_DIR]
    try:
        folders += [os.path.join(OUT_DIR, d) for d in os.listdir(OUT_DIR)]
    except OSError:
        pass
    for folder in folders:
        if not os.path.isdir(folder):
            continue
        for path in glob.glob(os.path.join(folder, "周报_*.txt")):
            m = _WEEK_FILE_RE.search(os.path.basename(path))
            if not m:
                continue
            try:
                end = datetime.strptime(m.group(2), "%Y-%m-%d").date()
            except ValueError:
                continue
            if (end.year, end.month) == (year, month):
                out.append(path)
    return sorted(set(out))


def collect_week_items(year, month):
    """读本月各周周报，返回 (条目列表, 文件名列表)。"""
    items, names = [], []
    for path in weekly_reports_for_month(year, month):
        try:
            got = parse_weekly_report(path)
        except Exception as e:
            print(f"提示：周报读取失败 {os.path.basename(path)}：{e}")
            continue
        if not got:
            print(f"提示：周报里没解析出条目 {os.path.basename(path)}")
            continue
        items.extend(got)
        names.append(os.path.basename(path))
    return items, names


def _perf_row_line(row):
    d1, d2 = row.get("d1"), row.get("d2")
    when = ""
    if d1 and d2:
        when = f"，{d1}~{d2}" if d1 != d2 else f"，{d1}"
    return f"{row.get('content') or ''}{when}"


def _range_covers(table_row, expected_row):
    """表里的时间范围是否覆盖周报要求的时间范围。"""
    t1, t2 = table_row.get("d1"), table_row.get("d2")
    e1, e2 = expected_row.get("d1"), expected_row.get("d2")
    if e1 and (not t1 or t1 > e1):
        return False
    if e2 and (not t2 or t2 < e2):
        return False
    return True


def check_perf_xlsx(path, year, month, handler="张三", week_items=None,
                    week_files=None, platform_items=None, fix=False):
    """核对绩效表：内容（对照本月周报）/ 时间 / 完成标记 / 格式。

    返回 (是否通过, 报告文本)。fix=True 时把周报里有的、表里缺的事项补进去。
    """
    import openpyxl

    tag = perf_month_text(year, month)
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    head = [f"绩效表核对 · {tag} · {handler}",
            f"核对时间：{stamp}",
            f"文件：{path}"]
    if not os.path.isfile(path):
        return False, "\n".join(head + ["", "结论：不通过（找不到绩效表文件）"])

    wb = openpyxl.load_workbook(path)
    ws = perf_sheet(wb)
    start, cap, sec_row = perf_task_zone(ws)
    raw_rows = read_perf_rows(ws, start, cap)
    problems, tips, content_lines, fix_lines = [], [], [], []

    # ---- 先修再核：把本月周报里的事项并进表（缺的补、时间取并集、完成取或） ----
    if fix and week_items is not None:
        expected = merge_perf_rows(items_to_perf_rows(week_items))
        merged = merge_perf_rows(raw_rows, expected)
        before = {perf_key(r["content"]): r for r in raw_rows}
        after = {perf_key(r["content"]): r for r in merged}
        added = [after[k] for k in after if k not in before]
        updated = [after[k] for k in after if k in before and after[k] != before[k]]
        if added or updated:
            _write_task_rows(ws, merged)
            _fix_score_formulas(ws)
            target = path
            try:
                wb.save(path)
            except PermissionError:
                target = os.path.splitext(path)[0] + "_新.xlsx"
                try:
                    wb.save(target)
                    head.append(f"（原文件被 Excel 占用，修补结果写到 {os.path.basename(target)}；"
                                f"关掉 Excel 后再点一次即可直接写回原文件）")
                except Exception as e:
                    target = None
                    problems.append(f"修补失败：{e}")
            if target:
                wb = openpyxl.load_workbook(target)
                ws = perf_sheet(wb)
                start, cap, sec_row = perf_task_zone(ws)
                raw_rows = read_perf_rows(ws, start, cap)
                if added:
                    more = "…" if len(added) > 10 else ""
                    fix_lines.append(f"自动补齐 {len(added)} 条："
                                     + "；".join(_perf_row_line(r) for r in added[:10]) + more)
                if updated:
                    more = "…" if len(updated) > 10 else ""
                    fix_lines.append(f"校正 {len(updated)} 条（起止时间 / 完成标记）："
                                     + "；".join(r["content"] for r in updated[:10]) + more)

    table = merge_perf_rows(raw_rows)

    if week_items is not None:
        expected = merge_perf_rows(items_to_perf_rows(week_items))
        by_key = {perf_key(r["content"]): r for r in table}
        exp_key = {perf_key(r["content"]): r for r in expected}
        missing = [r for k, r in exp_key.items() if k not in by_key]
        extra = [r for k, r in by_key.items() if k not in exp_key]
        date_bad, done_bad = [], []
        for k, exp in exp_key.items():
            got = by_key.get(k)
            if not got:
                continue
            if not _range_covers(got, exp):
                date_bad.append((got, exp))
            if bool(got["settled"]) != bool(exp["settled"]):
                done_bad.append((got, exp))
        dup_keys = {}
        for r in raw_rows:
            k = perf_key(r["content"])
            dup_keys[k] = dup_keys.get(k, 0) + 1
        dups = [k for k, c in dup_keys.items() if c > 1]

        content_lines.append(f"  本月周报 {len(week_files or [])} 篇"
                             + (f"：{'、'.join(week_files)}" if week_files else ""))
        content_lines.append(f"  周报事项 {len(week_items)} 条"
                             f"（合并同一事项后 {len(expected)} 条）")
        content_lines.append(f"  表内事项 {len(table)} 条")
        if missing:
            problems.append(f"缺少 {len(missing)} 条周报事项")
            content_lines.append(f"  ✗ 缺少 {len(missing)} 条（周报里有、表里没有）")
            content_lines += [f"    - {_perf_row_line(r)}" for r in missing[:30]]
        else:
            content_lines.append("  ✓ 周报里的事项都在表内")
        if date_bad:
            problems.append(f"时间不一致 {len(date_bad)} 条")
            content_lines.append(f"  ✗ 起止时间与周报不一致 {len(date_bad)} 条")
            for got, exp in date_bad[:30]:
                content_lines.append(
                    f"    - {exp['content']}：表里 {got['d1']}~{got['d2']}，"
                    f"周报 {exp['d1']}~{exp['d2']}")
        else:
            content_lines.append("  ✓ 起止时间与周报一致")
        if done_bad:
            problems.append(f"完成标记不一致 {len(done_bad)} 条")
            content_lines.append(f"  ✗ 完成标记与周报进度不一致 {len(done_bad)} 条")
            for got, exp in done_bad[:30]:
                content_lines.append(
                    f"    - {exp['content']}：表里 {'是' if got['settled'] else '否'}，"
                    f"周报进度 {'100%' if exp['settled'] else '未完成'}")
        else:
            content_lines.append("  ✓ 完成标记与周报进度一致")
        if dups:
            problems.append(f"表内重复 {len(dups)} 条")
            content_lines.append(f"  ✗ 同一事项出现多行 {len(dups)} 条")
            content_lines += [f"    - {k}" for k in dups[:10]]
        else:
            content_lines.append("  ✓ 没有重复行")
        if extra:
            tips.append(f"表里另有 {len(extra)} 条不在本月周报里（可能是手工补录或往月遗留，未动）")
            content_lines.append(f"  · 表里多出 {len(extra)} 条（周报里没有）")
            content_lines += [f"    - {_perf_row_line(r)}" for r in extra[:10]]
    else:
        content_lines.append(f"  表内事项 {len(table)} 条（本次没有可比对的本月周报）")

    # ---- 格式 ----
    fmt_lines, fmt_ok = [], True

    def mark(cond, ok_text, bad_text):
        nonlocal fmt_ok
        if cond:
            fmt_lines.append("  ✓ " + ok_text)
        else:
            fmt_lines.append("  ✗ " + bad_text)
            problems.append(bad_text)
            fmt_ok = False

    mark(bool(ws.cell(2, 2).value), "表头标题在（B2）", "表头标题丢了（B2 为空）")
    mark(str(ws.cell(3, 4).value or "").strip() == str(handler).strip(),
         f"处理人 {handler}（D3）",
         f"处理人不是 {handler}（D3={ws.cell(3, 4).value}）")
    mark(tag in str(ws.cell(4, 4).value or ""), f"考核月份 {tag}（D4）",
         f"考核月份不是 {tag}（D4={ws.cell(4, 4).value}）")
    mark(ws.cell(3, 11).value is not None, "填报时间已填（K3）", "填报时间为空（K3）")

    incomplete = []
    for i, row in enumerate(table):
        r = start + i
        if not (row.get("content") and row.get("category")
                and row.get("d1") and row.get("d2")):
            incomplete.append(r)
    mark(not incomplete,
         f"{len(table)} 行数据完整（类别 / 内容 / 起止时间 / 是否完成）",
         f"{len(incomplete)} 行数据不完整：第 {'、'.join(map(str, incomplete))} 行")

    used = [start + i for i in range(cap)
            if ws.cell(start + i, PERF_CONTENT_COL).value not in (None, "")]
    gap = bool(used) and used != list(range(used[0], used[0] + len(used)))
    mark(not gap,
         f"任务行连续（第 {used[0]}–{used[-1]} 行）" if used else "任务行没有数据",
         "任务行中间有空洞，打印出来会断开")

    merged_ranges = {str(rng) for rng in ws.merged_cells.ranges}
    broken = [rng for i in range(len(table)) for rng in
              (f"B{start + i}:C{start + i}", f"D{start + i}:I{start + i}",
               f"M{start + i}:N{start + i}") if rng not in merged_ranges]
    mark(not broken, "合并单元格齐全（B:C / D:I / M:N）",
         f"合并单元格缺失：{'、'.join(broken[:8])}")

    fonts_bad, fmt_bad = [], []
    for i in range(len(table)):
        r = start + i
        for c in (PERF_CAT_COL, PERF_CONTENT_COL, PERF_START_COL,
                  PERF_END_COL, PERF_DONE_COL):
            cell = ws.cell(r, c)
            if (cell.font.name or "") != "微软雅黑" or (cell.font.sz or 0) != 10:
                fonts_bad.append(cell.coordinate)
        for c in (PERF_START_COL, PERF_END_COL):
            if "y" not in (ws.cell(r, c).number_format or ""):
                fmt_bad.append(ws.cell(r, c).coordinate)
    mark(not fonts_bad, "字体统一（微软雅黑 10 号）",
         f"字体不一致：{'、'.join(fonts_bad[:8])}")
    mark(not fmt_bad, "日期格式 yyyy/m/d", f"日期格式不对：{'、'.join(fmt_bad[:8])}")

    sec_val = ws.cell(sec_row, PERF_CAT_COL).value
    mark(isinstance(sec_val, str) and "工作任务考核" in sec_val,
         f"考核区块位置正常（第 {sec_row} 行）",
         f"考核区块位置异常（第 {sec_row} 行不是「工作任务考核」）")

    wanted = _score_formulas(ws)
    if wanted:
        mark(ws["K4"].value == wanted[0] and ws["M4"].value == wanted[1],
             "考核评分公式指向考核区块（K4/M4）",
             f"考核评分公式没跟着区块走（K4={ws['K4'].value} / M4={ws['M4'].value}）")

    # ---- 研发平台比对（只提示，不参与结论） ----
    plat_lines = []
    if platform_items:
        plat_exp = merge_perf_rows(items_to_perf_rows(platform_items))
        keys = {perf_key(r["content"]) for r in table}
        plat_missing = [r for r in plat_exp if perf_key(r["content"]) not in keys]
        plat_lines.append(f"  平台本月事项 {len(plat_exp)} 条，"
                          f"表内缺 {len(plat_missing)} 条")
        if plat_missing:
            tips.append(f"平台本月还有 {len(plat_missing)} 条不在表里"
                        f"（多半是还没生成到对应周的周报，未自动补）")
            plat_lines += [f"    · {_perf_row_line(r)}" for r in plat_missing[:20]]

    # ---- 补齐（已在开头做完，这里只写进报告） ----
    conclusion = "通过" if not problems else f"不通过（{len(problems)} 项待处理）"
    out = head + [""] + ["一、内容（对照本月各周周报）"] + content_lines
    out += [""] + ["二、格式"] + fmt_lines
    if plat_lines:
        out += [""] + ["三、研发平台比对（仅供参考）"] + plat_lines
    if tips:
        out += [""] + ["· 提示（不算错误）"] + [f"  - {t}" for t in tips]
    if fix_lines:
        out += [""] + ["· 本次顺手修补"] + [f"  - {t}" for t in fix_lines]
    out += ["", f"结论：{conclusion}"]
    return not problems, "\n".join(out)


def perf_check_report(perf_path, year, month, handler="张三", platform_items=None,
                      fix=False, save_report=True):
    """跑一次核对，打印报告并写旁边同名 _核对.txt。返回是否通过。"""
    week_items, week_files = collect_week_items(year, month)
    ok, text = check_perf_xlsx(perf_path, year, month, handler,
                               week_items=week_items, week_files=week_files,
                               platform_items=platform_items, fix=fix)
    print("")
    print(text)
    print("")
    if save_report:
        report = os.path.splitext(perf_path)[0] + "_核对.txt"
        try:
            with open(report, "w", encoding="utf-8") as f:
                f.write(text + "\n")
            print(f"核对报告：{report}")
        except Exception as e:
            print(f"提示：核对报告写入失败：{e}")
    return ok


# --------------------------------------------------------------------------
# 生成文本
# --------------------------------------------------------------------------
def build_text(rows, week_start, week_end, tickets=None, threshold=0.85, reference=None,
               handler=None):
    """返回 (周报文本, 命中数, 未匹配明细, 命中他人工单数)。"""
    lines = []
    matched = 0
    matched_other = 0
    misses = []
    items_out = []
    if reference is None:
        from datetime import timedelta, timezone
        today = datetime.now(timezone(timedelta(hours=8))).date()
        reference = min(today, week_end)
    for item in rows:
        s, e = item["start"], item["end"]
        if s is None and e is None:
            continue
        lo = s or e
        hi = e or s
        if hi < week_start or lo > week_end:
            continue

        school = split_school(item["task"]) or item["category"]
        subject = item["task"]
        if school and subject.startswith(school):
            subject = subject[len(school):].strip()
        if not subject:
            subject = item["task"]

        progress = progress_for(item["done"], lo, hi, reference, item["task"])

        work = ""
        cands = []
        mine_best = other_best = None
        mine_all, other_all = [], []
        if tickets:
            for t in tickets:
                # 已取消的工单无效，不参与匹配（与按工单生成的口径一致）
                if is_cancelled_status(t.get("status")):
                    continue
                # 学校名交叉校验：两边都有学校且不一致，直接跳过，避免跨校串号
                if school and t.get("school"):
                    if similarity(school, t["school"]) < 0.6:
                        continue
                score = max(similarity(subject, t["title"]),
                            similarity(item["task"], t["title"]))
                flag = bool(handler) and handler in t.get("handler", "")
                (mine_all if flag else other_all).append((score, t, flag))
            mine_all.sort(key=lambda x: -x[0])
            other_all.sort(key=lambda x: -x[0])
            mine_best = mine_all[0] if mine_all else None
            other_best = other_all[0] if other_all else None

            # 匹配优先级：本人工单 > 其他人工单（绩效表事项始终是主语）
            if mine_best and mine_best[0] >= threshold:
                work = mine_best[1]["link"]
                matched += 1
            elif other_best and other_best[0] >= threshold:
                work = other_best[1]["link"]
                matched += 1
                matched_other += 1

        if not work and tickets is not None:
            cands = mine_all[:3] + other_all[:3]
            best = max([c[0] for c in cands], default=0.0)
            if not cands:
                why = "没有可比对的工单（学校名均不一致）"
            else:
                why = f"最高相似度 {best:.2f} < 阈值 {threshold}"
            misses.append({
                "category": item["category"],
                "school": school,
                "subject": subject,
                "time": fmt_range(lo, hi),
                "work": item["remark"] if item["remark"] else "无",
                "why": why,
                "candidates": cands,
            })

        if not work:
            work = item["remark"] if item["remark"] else "无"

        lines.append(f"【{item['category']}】")
        lines.append(school)
        lines.append(f"    时间: {fmt_range(lo, hi)}")
        lines.append(f"    事项: {subject}")
        lines.append(f"    工作内容: {work}")
        lines.append(f"    重要说明: 无")
        lines.append(f"    进度: {progress}")
        lines.append("")
        items_out.append({
            "category": item["category"],
            "school": school,
            "subject": subject,
            "time": fmt_range(lo, hi),
            "work": work,
            "progress": progress,
            "note": "无",
            "candidates": [
                {"id": str(t.get("id", "")), "title": t["title"],
                 "school": t.get("school", ""), "link": t["link"],
                 "handler": t.get("handler", ""), "score": round(sc, 2)}
                for sc, t, _mine in cands
            ],
        })
    return ("\n".join(lines).rstrip() + "\n", matched, misses, matched_other, items_out)


def build_miss_text(misses, week_start, week_end, threshold):
    """未匹配清单：每条候选带编号，回复该编号即可自动回填。"""
    has_cands = any(m["candidates"] for m in misses)
    out = [
        "周报未匹配工单清单",
        f"周期：{week_start} ~ {week_end}",
        f"生成时间：{datetime.now():%Y-%m-%d %H:%M:%S}",
        f"说明：以下事项未匹配到工单（阈值 {threshold}）。",
    ]
    if has_cands:
        out += [
            "",
            "【怎么确认】直接回复本邮件，正文写「确认 编号」，例如：",
            "    确认 1",
            "多个用逗号分隔：确认 1,3",
            "",
        ]
    out.append("")
    for idx, m in enumerate(misses, 1):
        out.append(f"[事项 {idx}] 【{m['category']}】{m['school']}")
        out.append(f"    时间: {m['time']}")
        out.append(f"    事项: {m['subject']}")
        out.append(f"    当前工作内容: {m['work']}")
        out.append(f"    原因: {m['why']}")
        if m["candidates"]:
            out.append("    可选工单（回复前面的编号即可）:")
            for score, t, is_mine in m["candidates"]:
                sid = t.get("id", "")
                tag = f"#{sid}" if sid else "-"
                school = t.get("school") or "-"
                owner = (t.get("handler") or "-") + ("，本人" if is_mine else "，非本人")
                no = t.get("confirm_no", "?")
                out.append(f"      {no}) {t['title']}   {tag}   {school}   {owner}   相似度 {score:.2f}")
        else:
            out.append("    可选工单: 无（可直接回复工单号，如 确认 #123）")
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def current_week(today=None):
    """本周一 ~ 本周日（北京时间 UTC+8）。"""
    from datetime import timedelta, timezone
    today = today or datetime.now(timezone(timedelta(hours=8))).date()
    monday = today - timedelta(days=today.weekday())
    return monday, monday + timedelta(days=6)


def auto_pick_xlsx(folder, target_date):
    """在考核表目录里挑出目标日期所在月份的文件；没有则用最新的一个。"""
    import glob
    files = sorted(glob.glob(os.path.join(folder, "*.xlsx")))
    if not files:
        raise SystemExit(f"目录下没有 xlsx：{folder}")
    tag = f"{target_date.year}年{target_date.month:02d}月"
    for f in files:
        if tag in os.path.basename(f):
            return f
    print(f"警告：没有 {target_date.year}年{target_date.month}月 的考核表，改用 {os.path.basename(files[-1])}")
    return files[-1]


def resolve_token(value):
    """
    支持三种写法：
      env:变量名        → 从环境变量读
      file:路径         → 从文本文件读（推荐，Key 不进入对话）
      其他              → 直接当 Key 用
    """
    if not value:
        return None
    v = value.strip()
    if v.startswith("env:"):
        return (os.environ.get(v[5:]) or "").strip() or None
    if v.startswith("file:"):
        path = v[5:].strip()
        with open(path, "r", encoding="utf-8-sig") as f:
            return f.read().strip() or None
    if os.path.isfile(v):
        with open(v, "r", encoding="utf-8-sig") as f:
            return f.read().strip() or None
    return v


class _Tee:
    """同时写控制台和日志文件。"""

    def __init__(self, *streams):
        self.streams = streams

    def write(self, s):
        for st in self.streams:
            try:
                st.write(s)
            except Exception:
                pass

    def flush(self):
        for st in self.streams:
            try:
                st.flush()
            except Exception:
                pass


def enable_log():
    """把 stdout/stderr 同时写入 工作记录\\周报\\logs\\run.log。"""
    log_dir = os.path.join(OUT_DIR, "logs")
    os.makedirs(log_dir, exist_ok=True)
    f = open(os.path.join(log_dir, "run.log"), "a", encoding="utf-8")
    sys.stdout = _Tee(sys.__stdout__, f)
    sys.stderr = _Tee(sys.__stderr__, f)
    print(f"\n===== {datetime.now():%Y-%m-%d %H:%M:%S} =====")


# --------------------------------------------------------------------------
# 通知（企业微信/钉钉/飞书 群机器人 webhook + SMTP 邮件）
# --------------------------------------------------------------------------
def _http_post_json(url, payload, timeout=15):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json; charset=utf-8"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read().decode("utf-8", "replace")


def _notify_cfg(cfg):
    n = (cfg or {}).get("notify") or {}
    return {
        "enabled": bool(n.get("enabled")),
        "webhook_url": (n.get("webhook_url") or "").strip(),
        "webhook_type": (n.get("webhook_type") or "wecom").strip(),
        "smtp": n.get("smtp") or {},
    }


def _imap_cfg(cfg):
    """回复确认用的 IMAP 参数：confirm 段优先，缺省复用 smtp 账号。"""
    n = _notify_cfg(cfg)
    smtp = n["smtp"]
    conf = (cfg or {}).get("confirm") or {}
    user = (conf.get("user") or smtp.get("user") or "").strip()
    pwd = conf.get("password") or smtp.get("password") or ""
    host = (conf.get("imap_host") or "").strip()
    if not host and "@" in user:
        host = "imap." + user.split("@", 1)[1]
    try:
        port = int(conf.get("imap_port") or 993)
        days = int(conf.get("lookback_days") or 14)
    except (TypeError, ValueError):
        port, days = 993, 14
    return {"host": host or "imap.163.com", "port": port, "user": user,
            "password": pwd, "days": days,
            "keyword": (conf.get("subject_keyword") or "周报").strip()}


def send_webhook(webhook_url, text, kind="wecom"):
    """企业微信/钉钉/飞书 群机器人文本消息。"""
    if kind in ("dingtalk", "feishu", "lark"):
        payload = {"msgtype": "text", "text": {"content": text}}
    else:  # wecom 及大多数兼容格式
        payload = {"msgtype": "text", "text": {"content": text}}
    status, body = _http_post_json(webhook_url, payload)
    low = (body or "").lower()
    if '"errcode":0' in low or '"code":0' in low or '"status":"ok"' in low:
        return True, f"HTTP {status} 发送成功"
    return False, f"HTTP {status} 返回：{(body or '')[:200]}"


def send_mail(smtp, subject, body, html=None):
    """SMTP 发信，支持 SSL(465) 与 STARTTLS(587)；有 html 时发 multipart/alternative。"""
    import smtplib
    from email.header import Header
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    host = (smtp.get("host") or "").strip()
    if not host:
        return False, "未配置 smtp.host"
    try:
        port = int(smtp.get("port") or (465 if smtp.get("ssl", True) else 587))
    except (TypeError, ValueError):
        port = 465
    user = (smtp.get("user") or "").strip()
    pwd = smtp.get("password") or ""
    to = smtp.get("to") or ([smtp["user"]] if smtp.get("user") else [])
    if isinstance(to, str):
        to = [x.strip() for x in to.replace(";", ",").split(",") if x.strip()]
    if not to:
        return False, "未配置 smtp.to"

    if html:
        msg = MIMEMultipart("alternative")
        msg.attach(MIMEText(body, "plain", "utf-8"))
        msg.attach(MIMEText(html, "html", "utf-8"))
    else:
        msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = user or to[0]
    msg["To"] = ", ".join(to)

    try:
        if smtp.get("ssl", True):
            server = smtplib.SMTP_SSL(host, port, timeout=20)
        else:
            server = smtplib.SMTP(host, port, timeout=20)
            use_tls = smtp.get("starttls")
            if use_tls is None:
                use_tls = (port == 587)
            if use_tls:
                server.starttls()
        if user:
            server.login(user, pwd)
        server.sendmail(user or to[0], to, msg.as_string())
        server.quit()
        return True, f"已发送至 {', '.join(to)}"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def build_mail_html(title, summary, report, miss_text):
    """邮件 HTML 版：正文内嵌周报，便于在邮箱里直接阅读。"""
    import html as _h

    def pre(s):
        return ("<pre style=\"font-family:Consolas,Menlo,'Microsoft YaHei',monospace;"
                "font-size:12.5px;line-height:1.7;white-space:pre-wrap;word-break:break-all;"
                "background:#f6f8fa;border:1px solid #e1e4e8;border-radius:6px;"
                "padding:14px;margin:10px 0;\">" + _h.escape(s) + "</pre>")

    parts = [
        "<div style=\"font-family:'Microsoft YaHei',Arial,sans-serif;font-size:14px;"
        "color:#24292f;line-height:1.6;\">",
        f"<h2 style=\"margin:0 0 6px;font-size:18px;\">周报 {_h.escape(title)}</h2>",
        f"<p style=\"margin:0 0 14px;color:#57606a;\">{_h.escape(summary)}</p>",
        "<h3 style=\"margin:18px 0 4px;font-size:15px;\">周报正文</h3>",
        pre(report),
    ]
    if miss_text:
        parts.append("<h3 style=\"margin:18px 0 4px;font-size:15px;\">未匹配工单清单</h3>")
        parts.append(pre(miss_text))
    parts.append("<p style=\"color:#8b949e;font-size:12px;margin-top:16px;\">"
                 "本邮件由周报自动生成脚本发送</p>")
    parts.append("</div>")
    return "".join(parts)


def notify(cfg, subject, body, dry_run=False, only=None, html=None, webhook_body=None):
    """按配置发送通知；任何异常都不影响主流程。返回 [(通道, 是否成功, 说明)]。"""
    n = _notify_cfg(cfg)
    results = []
    channels = []
    if n["webhook_url"] and only in (None, "webhook"):
        channels.append(("webhook", n["webhook_url"], n["webhook_type"]))
    if only in (None, "mail") and (n["smtp"].get("host") or only == "mail"):
        channels.append(("mail", n["smtp"], None))

    if not channels:
        print("通知：未配置 webhook_url 或 smtp.host，跳过发送")
        return results

    for kind, target, extra in channels:
        if dry_run:
            print(f"\n--- 通知预览（{kind}，未实际发送）---")
            print(f"标题：{subject}")
            print(body)
            results.append((kind, True, "dry-run"))
            continue
        try:
            if kind == "webhook":
                ok, detail = send_webhook(target, webhook_body or body, extra)
            else:
                ok, detail = send_mail(target, subject, body, html)
        except Exception as e:  # 绝不因为通知失败影响周报
            ok, detail = False, f"{type(e).__name__}: {e}"
        print(f"通知[{kind}]：{'成功' if ok else '失败'} - {detail}")
        results.append((kind, ok, detail))
    return results


# --------------------------------------------------------------------------
# 手机回复确认：解析邮件里的工单号 → 回填周报
# --------------------------------------------------------------------------
ID_RE = re.compile(r"(?:#|ticketId=|ticketId%3D)\s*(\d{1,6})", re.I)


def meta_path_for(report_path):
    return os.path.splitext(report_path)[0] + "_meta.json"


def render_report(items):
    lines = []
    for it in items:
        lines.extend([
            f"【{it['category']}】",
            it["school"],
            f"  时间: {it['time']}",
            f"  事项: {it['subject']}",
            f"  工作内容：{it['work']}",
            f"  重要说明：{it.get('note') or '无'}",
            f"  进度：{it['progress']}",
            "",
        ])
    return "\n".join(lines).rstrip() + "\n"


def misses_from_meta(meta, handler=""):
    out = []
    for it in meta["items"]:
        cands = it.get("candidates") or []
        if not cands:
            continue
        out.append({
            "category": it["category"],
            "school": it["school"],
            "subject": it["subject"],
            "time": it["time"],
            "work": it["work"],
            "why": "未找到足够相似的工单，请在回复中写「确认 编号」",
            "candidates": [(c.get("score", 0.0), c,
                            bool(handler) and handler in (c.get("handler") or ""))
                           for c in cands],
        })
    return out


def extract_ids(text):
    ids = []
    for m in ID_RE.finditer(text or ""):
        v = m.group(1)
        if v not in ids:
            ids.append(v)
    return ids


CONFIRM_NO_RE = re.compile(r"确认\s*[:：]?\s*([0-9]+(?:\s*[,，、和及/]\s*[0-9]+)*)")


def parse_reply(text):
    """从回复正文解析「确认 编号」或「#工单号」。返回 (工单号列表, 编号列表)。"""
    text = (text or "").strip()
    ids = extract_ids(text)
    nos = []
    m = CONFIRM_NO_RE.search(text)
    if m:
        nos = re.findall(r"\d+", m.group(1))
    elif re.fullmatch(r"[0-9,，、\s]+", text):
        nos = re.findall(r"\d+", text)
    return ids, nos


def assign_confirm_numbers(items):
    """给所有候选统一编号（跨事项连续），邮件里提示「确认 编号」。"""
    n = 0
    for it in items:
        for c in (it.get("candidates") or []):
            n += 1
            c["confirm_no"] = n
    return n


def apply_to_meta(meta, ids, nos):
    """按编号或工单号回填，返回变更列表。"""
    by_no, by_id = {}, {}
    for it in meta["items"]:
        for c in (it.get("candidates") or []):
            if c.get("confirm_no") is not None:
                by_no[str(c["confirm_no"])] = (it, c)
            if c.get("id"):
                by_id[str(c["id"])] = (it, c)

    changed, done = [], set()
    done_items = {id(it) for it in meta["items"]
                  if it.get("work", "无") != "无" and not it.get("candidates")}
    applied_keys = set()
    for key in list(nos) + list(ids):
        hit = by_no.get(str(key)) if key in nos else by_id.get(str(key))
        if not hit:
            continue
        it, c = hit
        if id(it) in done or id(it) in done_items:
            continue
        if c.get("id") in applied_keys:
            continue
        it["work"] = c["link"]
        it["candidates"] = []
        done.add(id(it))
        applied_keys.add(c.get("id"))
        changed.append((it["school"], it["subject"], c))
    return changed


QUOTE_CUT_RES = [
    re.compile(r"^\s*-{2,}\s*.*(原始邮件|原邮件|Original Message|Forwarded message).*$", re.I),
    re.compile(r"^\s*\|\s*(发件人|发送日期|收件人|主题)\s*\|", re.I),
    re.compile(r"^\s*在\s*\d{4}[-/年].{0,80}写道\s*[:：]?\s*$"),
    re.compile(r"^\s*\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?.{0,60}写道\s*[:：]?\s*$"),
    re.compile(r"^\s*(发件人|From|Sent|发送时间|日期|收件人|To)\s*[:：]", re.I),
    re.compile(r"^\s*_{10,}\s*$"),
    re.compile(r"^\s*-{5,}\s*$"),
    re.compile(r"^\s*>{1,}"),
]


def strip_quoted(text):
    """去掉回复里引用的原文，避免误抓历史工单号。"""
    out = []
    for line in (text or "").splitlines():
        if any(r.match(line) for r in QUOTE_CUT_RES):
            break
        out.append(line)
    return "\n".join(out).strip()


def _decode_header(value):
    from email.header import decode_header
    parts = []
    for text, enc in decode_header(value or ""):
        if isinstance(text, bytes):
            parts.append(text.decode(enc or "utf-8", "replace"))
        else:
            parts.append(text)
    return "".join(parts)


def _extract_body(msg):
    plain, html = [], []
    if msg.is_multipart():
        for part in msg.walk():
            ct = (part.get_content_type() or "").lower()
            if ct not in ("text/plain", "text/html"):
                continue
            try:
                raw = part.get_payload(decode=True) or b""
                charset = part.get_content_charset() or "utf-8"
                text = raw.decode(charset, "replace")
            except Exception:
                continue
            (plain if ct == "text/plain" else html).append(text)
    else:
        try:
            raw = msg.get_payload(decode=True) or b""
            text = raw.decode(msg.get_content_charset() or "utf-8", "replace")
            if "html" in (msg.get_content_type() or ""):
                html.append(text)
            else:
                plain.append(text)
        except Exception:
            pass
    if plain:
        return "\n".join(plain)
    text = "\n".join(html)
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", text)
    text = re.sub(r"(?i)<br\s*/?>|</p>|</div>", "\n", text)
    text = re.sub(r"<[^>]+>", " ", text)
    return text


REPLY_SUBJECT_RE = re.compile(r"^\s*(re|re:|回复|答复)\s*[:：]", re.I)
OWN_MAIL_MARKERS = ("========== 周报正文 ==========",
                    "本邮件由周报自动生成脚本发送",
                    "周报未匹配工单清单",
                    "以下事项已按你的邮件回复更新到周报")


def looks_like_reply(subject, body):
    """判断是否是「确认」回复：排除本程序自己发的模板邮件；
    标题带 Re:/回复 的放行，没有前缀时要求正文开头就是确认指令。"""
    body = body or ""
    if REPLY_SUBJECT_RE.match(subject or ""):
        return True
    head = body[:300]
    for marker in OWN_MAIL_MARKERS:
        if marker in head:
            return False
    if re.search(r"确认\s*[:：]?\s*\d", head):
        return True
    if re.fullmatch(r"[\s\d,，、#]+", body.strip() or "x"):
        return bool(re.search(r"\d", body))
    return False


def imap_replies(user, password, host="imap.163.com", port=993, days=14,
                 keyword="周报", limit=50, only_from_self=True, require_reply=True):
    """抓取最近若干天、标题含关键字的本人邮件（含回复）。"""
    import imaplib
    import ssl
    from email import message_from_bytes

    imaplib.Commands.setdefault("ID", ("NONAUTH", "AUTH", "SELECTED"))
    conn = imaplib.IMAP4_SSL(host, port, ssl_context=ssl.create_default_context(), timeout=30)
    try:
        try:  # 163/126 要求客户端上报身份
            conn._command("ID", '("name" "dsh-weekly" "version" "1.0" "vendor" "dsh")')
        except Exception:
            pass
        conn.login(user, password)
        conn.select("INBOX", readonly=True)

        since = (datetime.now() - timedelta(days=days)).strftime("%d-%b-%Y")
        typ, data = conn.search(None, f"(SINCE {since})")
        nums = (data[0].split() if data and data[0] else [])[-limit:]
        out = []
        for num in reversed(nums):
            typ, d = conn.fetch(num, "(RFC822)")
            if typ != "OK" or not d or not isinstance(d[0], tuple):
                continue
            msg = message_from_bytes(d[0][1])
            subject = _decode_header(msg.get("Subject"))
            sender = msg.get("From", "")
            if keyword and keyword not in subject:
                continue
            if only_from_self and user.lower() not in sender.lower():
                continue
            body = strip_quoted(_extract_body(msg))
            if require_reply and not looks_like_reply(subject, body):
                continue
            out.append({
                "msgid": (msg.get("Message-ID") or "").strip(),
                "subject": subject,
                "from": sender,
                "date": msg.get("Date", ""),
                "body": body,
            })
        return out
    finally:
        try:
            conn.logout()
        except Exception:
            pass


def imap_delete_matching(cfg, pred, days=None, keyword="周报", limit=200, dry_run=False):
    """按条件删除标题含 keyword 的邮件（维护/清理测试用）。pred(subject, body) -> bool"""
    import imaplib
    import ssl
    from email import message_from_bytes

    ic = _imap_cfg(cfg)
    days = days or ic["days"]
    imaplib.Commands.setdefault("ID", ("NONAUTH", "AUTH", "SELECTED"))
    conn = imaplib.IMAP4_SSL(ic["host"], ic["port"],
                             ssl_context=ssl.create_default_context(), timeout=30)
    n = 0
    try:
        try:
            conn._command("ID", '("name" "dsh-weekly" "version" "1.0" "vendor" "dsh")')
        except Exception:
            pass
        conn.login(ic["user"], ic["password"])
        conn.select("INBOX", readonly=False)
        since = (datetime.now() - timedelta(days=days)).strftime("%d-%b-%Y")
        typ, data = conn.search(None, f"(SINCE {since})")
        nums = (data[0].split() if data and data[0] else [])[-limit:]
        for num in nums:
            typ, d = conn.fetch(num, "(RFC822)")
            if typ != "OK" or not d or not isinstance(d[0], tuple):
                continue
            msg = message_from_bytes(d[0][1])
            subject = _decode_header(msg.get("Subject"))
            if keyword and keyword not in subject:
                continue
            if pred(subject, strip_quoted(_extract_body(msg))):
                n += 1
                print(f"  删除：{subject[:60]}")
                if not dry_run:
                    conn.store(num, "+FLAGS", "\\Deleted")
        if not dry_run:
            conn.expunge()
        return n
    finally:
        try:
            conn.logout()
        except Exception:
            pass


def find_latest_meta():
    import glob
    files = glob.glob(os.path.join(OUT_DIR, "*", "*_meta.json"))
    if not files:
        return None
    return max(files, key=os.path.getmtime)


def apply_ids_to_meta(meta, ids):
    """把回复里的工单号回填到对应事项；返回变更列表。"""
    changed = []
    for it in meta["items"]:
        cands = it.get("candidates") or []
        if not cands:
            continue
        for c in cands:
            if c.get("id") and c["id"] in ids:
                it["work"] = c["link"]
                it["candidates"] = []
                changed.append((it["school"], it["subject"], c))
                break
    return changed


def save_report_bundle(meta, report_path):
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(render_report(meta["items"]))
    miss_path = os.path.splitext(report_path)[0] + "_未匹配.txt"
    handler = meta.get("handler") or DEFAULT_HANDLER
    misses = misses_from_meta(meta, handler)
    if misses:
        ws = datetime.strptime(meta["period"]["start"], "%Y-%m-%d").date()
        we = datetime.strptime(meta["period"]["end"], "%Y-%m-%d").date()
        with open(miss_path, "w", encoding="utf-8") as f:
            f.write(build_miss_text(misses, ws, we, meta.get("threshold", 0.85)))
    elif os.path.isfile(miss_path):
        os.remove(miss_path)
    with open(meta_path_for(report_path), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)


def run_apply(cfg, texts, report_path=None, dry_run=False, do_notify=True):
    """texts: [(来源标签, 正文)]，按顺序套用到周报。"""
    report_path = report_path or find_latest_meta()
    if report_path and report_path.endswith("_meta.json"):
        meta_path = report_path
        report_path = report_path.replace("_meta.json", ".txt")
    else:
        meta_path = meta_path_for(report_path)
    if not os.path.isfile(meta_path):
        print(f"找不到快照文件：{meta_path}")
        return []

    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)
    applied_msgs = set(meta.get("applied_ids") or [])

    all_changed = []
    for label, text in texts:
        ids, nos = parse_reply(text)
        if not ids and not nos:
            print(f"[{label}] 未识别到「确认 编号」或工单号，跳过（正文前 60 字：{text[:60]!r}）")
            continue
        if label in applied_msgs:
            print(f"[{label}] 已处理过，跳过")
            continue
        changed = apply_to_meta(meta, ids, nos)
        if changed:
            applied_msgs.add(label)
            all_changed.extend(changed)
            for school, subject, c in changed:
                print(f"[{label}] 回填（确认 {c.get('confirm_no', '-')}）："
                      f"{school} / {subject} -> #{c['id']} {c['title']}")
        else:
            already = [f"{it['school']}/{it['subject']}" for it in meta["items"]
                       if any(f"ticketId={i}" in (it.get("work") or "") for i in ids)]
            extra = f"（{'、'.join(already)} 此前已确认，无需重复）" if already else ""
            print(f"[{label}] 编号 {nos or '-'} / 工单号 {ids or '-'} 不在本期待确认列表中{extra}")

    if not all_changed:
        print("没有需要更新的内容")
        return []

    meta["applied_ids"] = sorted(applied_msgs)
    if dry_run:
        print("\n--- dry-run：周报将变为 ---")
        print(render_report(meta["items"]))
        return all_changed

    save_report_bundle(meta, report_path)
    print(f"已更新：{report_path}")

    # 默认不再单独发「已更新」邮件（每周只发一封周报邮件）；
    # 需要回执时在配置里设 confirm.send_mail = true
    conf = (cfg or {}).get("confirm") or {}
    if do_notify and conf.get("send_mail"):
        lines = [f"以下事项已按你的邮件回复更新到周报（{meta['period']['start']} ~ {meta['period']['end']}）：", ""]
        for school, subject, c in all_changed:
            lines.append(f"· {school} / {subject}")
            lines.append(f"  → 工单 #{c['id']} {c['title']}")
            lines.append(f"  {c['link']}")
        lines += ["", f"周报：{report_path}"]
        n = _notify_cfg(cfg)
        if n["smtp"].get("host") or n["webhook_url"]:
            notify(cfg, f"【周报已更新】{meta['period']['start']} ~ {meta['period']['end']}",
                   "\n".join(lines), only="mail", html=build_mail_html(
                       f"{meta['period']['start']} ~ {meta['period']['end']}（已更新）",
                       f"按回复回填 {len(all_changed)} 条", render_report(meta["items"]), ""))
    return all_changed


def write_config_template(path=None, force=False):
    path = path or CONFIG_PATH
    if os.path.isfile(path) and not force:
        print(f"配置已存在，未覆盖：{path}")
        print("如需覆盖请加 --force（会先备份为 .bak）")
        return False
    if os.path.isfile(path):
        import shutil
        shutil.copy2(path, path + ".bak")
        print(f"已备份原配置：{path}.bak")
    tpl = {
        "folder": DEFAULT_FOLDER,
        "token_file": "api_key.txt",
        "out_dir": "周报",
        "handler": DEFAULT_HANDLER,
        "threshold": DEFAULT_THRESHOLD,
        "mcp_url": DEFAULT_MCP_URL,
        "confirm": {
            "send_mail": False,
            "imap_host": "",
            "imap_port": 993,
            "lookback_days": 14,
            "subject_keyword": "周报",
        },
        "notify": {
            "enabled": False,
            "webhook_url": "",
            "webhook_type": "wecom",
            "smtp": {
                "host": "",
                "port": 465,
                "ssl": True,
                "user": "",
                "password": "",
                "to": [],
            },
        },
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(tpl, f, ensure_ascii=False, indent=2)
    print(f"已生成配置模板：{path}")
    print("按实际环境修改后即可使用（相对路径以脚本所在目录为基准）。")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file")
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--week", help="填 current 表示自动取本周（周一~周日）")
    ap.add_argument("--folder", help="考核表目录（默认读配置）")
    ap.add_argument("--auto-file", action="store_true", help="按周期自动挑选当月考核表")
    ap.add_argument("--out", help="不传则按周期自动归档到配置的输出目录")
    ap.add_argument("--tickets", help="本地工单 JSON 文件")
    ap.add_argument("--threshold", type=float, help="工单标题相似度阈值（默认 0.85）")
    ap.add_argument("--mcp-url", help="MCP 地址（默认读配置）")
    ap.add_argument("--mcp-token", help="API Key、file:路径 或 env:变量名")
    ap.add_argument("--mcp-tool")
    ap.add_argument("--mcp-args", help="工具参数的 JSON 字符串")
    ap.add_argument("--mcp-list-tools", action="store_true")
    ap.add_argument("--handler", help="只看该处理人的工单（默认 张三）")
    ap.add_argument("--log", action="store_true", help="同时写运行日志到 <输出目录>\\logs\\run.log")
    ap.add_argument("--source", choices=["tickets", "appraisal"], default="tickets",
                    help="tickets=按工单+任务中心生成（处理人/工时/我负责的任务）；appraisal=按绩效表生成")
    ap.add_argument("--no-tasks", action="store_true",
                    help="只按工单生成，不读取任务中心（我负责的任务 / 我有工时记录的任务）")
    ap.add_argument("--perf-xlsx", help="同时生成绩效文档（xlsx），值为输出路径")
    ap.add_argument("--perf-auto", action="store_true",
                    help="按周期自动生成绩效文档到 输出目录\\绩效\\YYYY年MM月绩效_学校工单.xlsx")
    ap.add_argument("--perf-template", help="绩效文档模板（默认取当月的月度考核表）")
    ap.add_argument("--perf-month", help="绩效文档月份 YYYY-MM，默认取周期所在月")
    ap.add_argument("--perf-dump", action="store_true",
                    help="把绩效表读成 JSON 输出（面板「查看绩效表」用）")
    ap.add_argument("--perf-check", action="store_true",
                    help="核对当月绩效表：与本月各周周报逐条比对（内容/时间/完成标记/格式），"
                         "报告写在表旁边 *_核对.txt")
    ap.add_argument("--perf-fix", action="store_true",
                    help="配合 --perf-check：把周报里有、表里缺的事项补进去")
    ap.add_argument("--perf-platform", action="store_true",
                    help="配合 --perf-check：额外与研发平台本月数据比对（只提示，需 API Key）")
    ap.add_argument("--list-replies", action="store_true",
                    help="列出收件箱中标题含关键词的邮件（排查回复为什么没生效）")
    ap.add_argument("--apply-confirmations", action="store_true",
                    help="读邮箱里的回复，把工单号回填进周报")
    ap.add_argument("--confirm-text", help="直接给一段回复文本（调试用）")
    ap.add_argument("--confirm-file", help="从文件读取回复文本（调试用）")
    ap.add_argument("--confirm-report", help="指定目标周报（默认取最新的快照）")
    ap.add_argument("--confirm-dry-run", action="store_true", help="只预览不写文件")
    ap.add_argument("--config", help="使用指定的配置文件（默认脚本目录下的 weekly_config.json）")
    ap.add_argument("--init-config", action="store_true", help="生成 weekly_config.json 模板后退出")
    ap.add_argument("--force", action="store_true", help="配合 --init-config 覆盖已有配置（先备份 .bak）")
    ap.add_argument("--where", action="store_true", help="打印当前生效的路径与参数后退出")
    ap.add_argument("--notify", action="store_true", help="生成后按配置发送通知")
    ap.add_argument("--notify-test", action="store_true", help="发送一条测试通知后退出")
    ap.add_argument("--notify-dry-run", action="store_true", help="只打印通知内容，不实际发送")
    ap.add_argument("--no-miss-file", action="store_true", help="不输出未匹配清单")
    args = ap.parse_args()

    if args.init_config:
        write_config_template(args.config or CONFIG_PATH, force=args.force)
        return

    cfg = apply_config(args)
    handler = args.handler or cfg.get("handler") or DEFAULT_HANDLER
    threshold = args.threshold if args.threshold is not None else float(
        cfg.get("threshold") or DEFAULT_THRESHOLD)
    mcp_url = args.mcp_url or cfg.get("mcp_url") or DEFAULT_MCP_URL
    folder = _abs(args.folder) if args.folder else PERF_FOLDER

    if args.where:
        print(f"脚本目录   ：{SCRIPT_DIR}")
        print(f"配置文件   ：{CONFIG_PATH}"
              f"{'' if os.path.isfile(CONFIG_PATH) else '（未找到，使用默认）'}")
        print(f"考核表目录 ：{folder}")
        print(f"API Key    ：{TOKEN_FILE}（{'存在' if os.path.isfile(TOKEN_FILE) else '未找到'}）")
        print(f"输出目录   ：{OUT_DIR}")
        print(f"MCP 地址   ：{mcp_url}")
        print(f"处理人     ：{handler}")
        print(f"相似度阈值 ：{threshold}")
        return

    if args.log:
        enable_log()

    if args.perf_dump:
        target = args.perf_xlsx
        if not target:
            if args.perf_month:
                y0, m0 = [int(x) for x in args.perf_month.split("-")]
            else:
                today0 = _today_cn()
                y0, m0 = today0.year, today0.month
            target = perf_path_for(folder, handler, y0, m0)
        if not os.path.isfile(target):
            print(json.dumps({"error": "绩效表不存在", "path": target}, ensure_ascii=False))
            sys.exit(2)
        print(json.dumps(perf_dump(target), ensure_ascii=False, default=str))
        return

    if args.perf_check:
        # 单独核对：不影响周报生成，也不需要周期参数
        if args.perf_month:
            y, m = [int(x) for x in args.perf_month.split("-")]
        else:
            today = _today_cn()
            y, m = today.year, today.month
        check_path = args.perf_xlsx or perf_path_for(folder, handler, y, m)
        platform_items = None
        if args.perf_platform:
            token_arg = args.mcp_token
            if not token_arg and os.path.isfile(TOKEN_FILE):
                token_arg = TOKEN_FILE
            if not token_arg:
                raise SystemExit("--perf-platform 需要 API Key：--mcp-token 或 api_key.txt")
            ms = date(y, m, 1)
            me = (date(y + (1 if m == 12 else 0), (m % 12) + 1, 1) - timedelta(days=1))
            platform_items = collect_items(
                resolve_token(token_arg), mcp_url, handler, ms, me,
                mcp_tool=args.mcp_tool,
                mcp_args=json.loads(args.mcp_args) if args.mcp_args else {},
                with_tasks=not args.no_tasks)
        ok = perf_check_report(check_path, y, m, handler,
                               platform_items=platform_items, fix=args.perf_fix)
        sys.exit(0 if ok else 2)

    if args.list_replies:
        ic = _imap_cfg(cfg)
        if not ic["user"] or not ic["password"]:
            raise SystemExit("未配置邮箱账号或授权码：请先运行 设置邮箱授权码.ps1，"
                             "或填写 weekly_config.json 的 notify.smtp.user / password")
        print(f"连接 {ic['host']}:{ic['port']}，读取近 {ic['days']} 天标题含「{ic['keyword']}」的邮件…")
        try:
            mails = imap_replies(ic["user"], ic["password"], ic["host"], ic["port"],
                                 ic["days"], ic["keyword"], require_reply=False)
        except Exception as e:
            raise SystemExit(f"IMAP 读取失败：{type(e).__name__}: {e}")
        print(f"共 {len(mails)} 封\n")
        for m in mails:
            ok = "可处理" if looks_like_reply(m["subject"], m["body"]) else "将被忽略"
            ids, nos = parse_reply(m["body"])
            print(f"[{m['date'][:25]}] {ok} | 编号={nos} 工单号={ids}")
            print(f"    标题: {m['subject'][:70]}")
            print(f"    正文: {m['body'][:100]!r}")
        return

    if args.apply_confirmations or args.confirm_text or args.confirm_file:
        texts = []
        if args.confirm_text:
            texts.append(("命令行文本", args.confirm_text))
        if args.confirm_file:
            with open(args.confirm_file, "r", encoding="utf-8-sig") as f:
                texts.append((os.path.basename(args.confirm_file), f.read()))
        if not texts:
            ic = _imap_cfg(cfg)
            if not ic["user"] or not ic["password"]:
                raise SystemExit("未配置 IMAP 账号：请在 weekly_config.json 的 notify.smtp "
                                 "或 confirm 段填写 user/password")
            print(f"连接 {ic['host']}:{ic['port']} 读取近 {ic['days']} 天邮件…")
            try:
                mails = imap_replies(ic["user"], ic["password"], ic["host"],
                                     ic["port"], ic["days"], ic["keyword"])
            except Exception as e:
                raise SystemExit(
                    f"IMAP 读取失败：{type(e).__name__}: {e}\n"
                    "提示：163/126 需要在 设置 → POP3/SMTP/IMAP 里单独开启 IMAP 服务")
            print(f"匹配到 {len(mails)} 封邮件")
            texts = [(m["msgid"] or f"{m['subject']}@{m['date']}", m["body"]) for m in mails]
            if not texts:
                print("没有可处理的回复")
                return
        run_apply(cfg, texts, report_path=args.confirm_report,
                  dry_run=args.confirm_dry_run)
        return

    if args.notify_test:
        n = _notify_cfg(cfg)
        if not n["webhook_url"] and not n["smtp"].get("host"):
            raise SystemExit("未配置通知：请在 weekly_config.json 的 notify 中填写 webhook_url 或 smtp.host")
        print("发送测试通知...")
        notify(cfg, "【周报系统】测试通知",
               "这是一条测试通知，收到说明通知配置正确。\n"
               f"时间：{datetime.now():%Y-%m-%d %H:%M:%S}",
               dry_run=args.notify_dry_run)
        return

    if args.mcp_list_tools:
        client = McpClient(mcp_url, resolve_token(args.mcp_token or TOKEN_FILE))
        init = client.initialize()
        err = mcp_error(init)
        if err:
            raise SystemExit(f"MCP 初始化失败：{err}")
        resp = client.list_tools()
        err = mcp_error(resp)
        if err:
            raise SystemExit(f"获取工具列表失败：{err}")
        out = {"serverInfo": init.get("result", {}).get("serverInfo"),
               "tools": (resp.get("result") or {}).get("tools", [])}
        target = args.out or os.path.join(SCRIPT_DIR, "mcp_tools.json")
        with open(target, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        print(f"已写出 {target}（{len(out['tools'])} 个工具）")
        return

    if args.week == "current" or args.start == "current":
        ws, we = current_week()
        print(f"本周：{ws} ~ {we}")
    else:
        if not (args.start and args.end):
            ap.error("需要 --start/--end，或 --week current")
        ws = datetime.strptime(args.start, "%Y-%m-%d").date()
        we = datetime.strptime(args.end, "%Y-%m-%d").date()

    if args.source == "tickets":
        token_arg = args.mcp_token
        if not token_arg and os.path.isfile(TOKEN_FILE):
            token_arg = TOKEN_FILE
            print(f"使用默认 API Key：{TOKEN_FILE}")
        if not token_arg:
            raise SystemExit("工单模式需要 API Key：--mcp-token 或 api_key.txt")
        token = resolve_token(token_arg)
        data_args = json.loads(args.mcp_args) if args.mcp_args else {}
        items = collect_items(token, mcp_url, handler, ws, we,
                              mcp_tool=args.mcp_tool, mcp_args=data_args,
                              with_tasks=not args.no_tasks)

        out_path = args.out or default_out_path(ws, we)
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        text = render_report(items)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"OK {len(items)} 条 out={out_path}")

        miss_path = os.path.splitext(out_path)[0] + "_未匹配.txt"
        if os.path.isfile(miss_path):
            os.remove(miss_path)

        perf_out = args.perf_xlsx
        if perf_out or args.perf_auto:
            if args.perf_month:
                y, m = [int(x) for x in args.perf_month.split("-")]
            else:
                y, m = we.year, we.month
                if (ws.year, ws.month) != (we.year, we.month):
                    print(f"注意：周期跨月，绩效文档按 {y}年{m}月 生成"
                          f"（可用 --perf-month 指定）")
            if not perf_out:
                perf_out = perf_path_for(folder, handler, y, m)
            if not os.path.isdir(folder):
                print(f"提示：绩效目录不存在（{folder}），本次跳过绩效文档")
            else:
                ms = date(y, m, 1)
                me = (date(y + (1 if m == 12 else 0), (m % 12) + 1, 1)
                      - timedelta(days=1))
                full_month = not (ms <= ws and we <= me)
                if full_month:
                    m_items = collect_items(token, mcp_url, handler, ms, me,
                                            mcp_tool=args.mcp_tool,
                                            mcp_args=data_args,
                                            with_tasks=not args.no_tasks)
                else:
                    m_items = items
                if args.perf_template:
                    tpl = args.perf_template
                elif os.path.isfile(perf_out):
                    tpl = perf_out          # 当月表已存在 → 就地累积（先读旧行再合并）
                else:
                    tpl = auto_pick_xlsx(folder, ms)
                built = build_perf_xlsx(tpl, perf_out, m_items, y, m, handler)

                # 自检：对照本月各周周报补齐缺失；本周覆盖月末时就是月底核对
                month_end_week = we >= me - timedelta(days=6)
                perf_check_report(built, y, m, handler, fix=True,
                                  platform_items=(m_items if full_month else None))
                if month_end_week:
                    print(f"（本轮已覆盖 {y}年{m}月月末，上面就是月底核对报告）")

                # 上个月的绩效表若还没核对过，顺手补一次（纯文本比对，不额外调接口）
                py_, pm_ = (y - 1, 12) if m == 1 else (y, m - 1)
                prev_out = perf_path_for(folder, handler, py_, pm_)
                if (os.path.isfile(prev_out)
                        and not os.path.isfile(os.path.splitext(prev_out)[0] + "_核对.txt")):
                    print(f"上个月（{py_}年{pm_}月）绩效表还没有核对报告，补一次核对")
                    perf_check_report(prev_out, py_, pm_, handler, fix=True)

        n = _notify_cfg(cfg)
        if args.notify or n["enabled"]:
            total = len(items)
            schools = len({i["school"] for i in items})
            mine = sum(1 for i in items if i.get("source") == "我处理")
            wl_n = sum(1 for i in items if i.get("source") == "我记工时")
            task_n = sum(1 for i in items
                         if i.get("source") in ("我负责", "任务我记工时", "任务我负责"))
            summary = (f"{ws} ~ {we}：工单/任务 {total} 条，涉及 {schools} 所学校"
                       f"（我处理 {mine} 条，我记工时 {wl_n} 条，任务中心 {task_n} 条）")
            subject = f"【周报】{ws} ~ {we}（{total} 条）"
            body = "\n".join([f"周期：{ws} ~ {we}", summary, "",
                              "========== 周报正文 ==========", text.rstrip(), "",
                              f"文件：{out_path}"])
            html = build_mail_html(f"{ws} ~ {we}", summary, text.rstrip(), "")
            webhook_body = "\n".join([summary, f"周报：{out_path}"])
            notify(cfg, subject, body, dry_run=args.notify_dry_run,
                   html=html, webhook_body=webhook_body)
        return

    xlsx = args.file
    if not xlsx or args.auto_file:
        xlsx = auto_pick_xlsx(folder, ws)
    print(f"考核表：{os.path.basename(xlsx)}")

    tickets = None
    token_arg = args.mcp_token
    if not token_arg and os.path.isfile(TOKEN_FILE):
        token_arg = TOKEN_FILE
        print(f"使用默认 API Key：{TOKEN_FILE}")
    if token_arg:
        tool_args = json.loads(args.mcp_args) if args.mcp_args else {}
        tickets, _ = fetch_tickets_via_mcp(resolve_token(token_arg), mcp_url,
                                           args.mcp_tool, tool_args,
                                           handler_filter=handler)
    elif args.tickets:
        tickets = load_tickets_from_json(args.tickets)

    if tickets is not None:
        print(f"工单数：{len(tickets)}")

    rows = read_rows(xlsx)
    text, matched, misses, matched_other, items = build_text(
        rows, ws, we, tickets, threshold, handler=handler)
    out_path = args.out or default_out_path(ws, we)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    print(f"OK rows={len(rows)} matched={matched}（他人工单 {matched_other}）"
          f" threshold={threshold} out={out_path}")

    # 快照：记录每条事项与候选，供「回复确认」回填；
    # 重跑时保留此前已确认的回填，避免被覆盖
    meta_path = meta_path_for(out_path)
    old_meta = None
    if os.path.isfile(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                old_meta = json.load(f)
        except Exception:
            old_meta = None
    if old_meta:
        prev = {(i["school"], i["subject"]): i for i in old_meta.get("items", [])}
        for it in items:
            p = prev.get((it["school"], it["subject"]))
            if p and it["work"] == "无" and p.get("work") not in (None, "", "无"):
                it["work"] = p["work"]
                it["candidates"] = []
    # 给候选统一编号，邮件里提示「确认 1、确认 2…」
    assign_confirm_numbers(items)
    meta = {
        "period": {"start": str(ws), "end": str(we)},
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "handler": handler,
        "threshold": threshold,
        "items": items,
        "applied_ids": (old_meta or {}).get("applied_ids", []),
    }
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    # 以快照为准渲染，保证回填写进最终文件
    text = render_report(items)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(text)

    # 未匹配清单：有遗漏才写，没有则清掉上一次的旧文件
    miss_path = os.path.splitext(out_path)[0] + "_未匹配.txt"
    miss_entries = misses_from_meta(meta, handler)
    miss_text = ""
    if miss_entries and not args.no_miss_file:
        miss_text = build_miss_text(miss_entries, ws, we, threshold)
        with open(miss_path, "w", encoding="utf-8") as f:
            f.write(miss_text)
        print(f"未匹配 {len(miss_entries)} 条，清单：{miss_path}")
    else:
        if os.path.isfile(miss_path):
            os.remove(miss_path)
            print(f"未匹配 0 条，已移除旧清单：{miss_path}")

    # 通知：配置里 enabled=true 或命令行 --notify 时发送（正文内嵌周报全文）
    n = _notify_cfg(cfg)
    if args.notify or n["enabled"]:
        total = len(items)
        summary = (f"本周有安排的事项 {total} 条：匹配工单 {matched} 条"
                   f"（其中他人处理 {matched_other} 条），未匹配 {len(miss_entries)} 条")
        subject = f"【周报】{ws} ~ {we}（{total} 条 / 匹配 {matched}）"

        lines = [f"周期：{ws} ~ {we}", summary, ""]
        if miss_entries:
            lines += ["未匹配事项请在回复中写「确认 编号」（例如：确认 1），系统会自动回填。", ""]
        lines += ["========== 周报正文 ==========", text.rstrip(), ""]
        if miss_text:
            lines += ["========== 未匹配清单 ==========", miss_text.rstrip(), ""]
        lines += [f"文件：{out_path}",
                  f"未匹配清单：{miss_path if miss_text else '无'}"]
        body = "\n".join(lines)

        html = build_mail_html(f"{ws} ~ {we}", summary, text.rstrip(),
                               miss_text.rstrip() if miss_text else "")
        webhook_body = "\n".join([summary, f"周报：{out_path}"])
        notify(cfg, subject, body, dry_run=args.notify_dry_run,
               html=html, webhook_body=webhook_body)


if __name__ == "__main__":
    main()

