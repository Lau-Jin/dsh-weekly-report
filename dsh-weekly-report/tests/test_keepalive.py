# -*- coding: utf-8 -*-
"""面板服务「保持在线」回归测试（v0.8.0）。

只动临时目录 + 测试端口，绝不碰 8798 上的正式服务。

覆盖：
  1. /api/ping 轻量探活（毫秒级、不 spawn 进程）
  2. /api/state 走缓存（首次也快），不会每次请求都 spawn powershell
  3. 端口被占用时，第二个实例自己退出（不会顶掉在跑的）
  4. /api/watchdog 已下线（v0.8.0 删掉 PowerShell 守护任务），只回 410
  5. 宿主式静默拉起（node + detached + windowsHide，不带 powershell）能把被杀的服务拉回来
  6. 计划任务的隐藏启动器（wscript + VBS，窗口样式 0）能跑完命令且不留窗口

跑法：
    python dsh-weekly-report/tests/test_keepalive.py
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
SERVER = os.path.join(PLUGIN, "service", "server.cjs")
PORT = int(os.environ.get("KEEPALIVE_PORT", "8899"))

PASSED, FAILED = [], []


def check(name, cond, detail=""):
    if cond:
        PASSED.append(name)
        print(f"  ✓ {name}")
    else:
        FAILED.append(name + (f" —— {detail}" if detail else ""))
        print(f"  ✗ {name}" + (f" —— {detail}" if detail else ""))


def find_node():
    cands = [
        os.environ.get("WEEKLY_PANEL_NODE"),
        os.path.expandvars(r"%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"),
        r"D:\DEEPSEEK\resources\runtime\primary-runtime\dependencies\node\bin\node.exe",
    ]
    for c in cands:
        if c and os.path.isfile(c):
            return c
    found = shutil.which("node")
    if found:
        return found
    raise SystemExit("找不到 node.exe（可设 WEEKLY_PANEL_NODE）")


def get(path, timeout=10):
    t0 = time.time()
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=timeout) as r:
        body = r.read()
    return (time.time() - t0) * 1000, body


def post(path, body, timeout=20):
    """POST JSON 到测试实例，返回 (状态码, 解析后的 JSON)。"""
    import urllib.error
    import urllib.request
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def explorer_windows():
    """当前 explorer 有标题的窗口标题列表（用来确认「打开目录」真的弹了窗口）。"""
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "$OutputEncoding=[Text.Encoding]::UTF8; Get-Process explorer -ErrorAction SilentlyContinue "
             "| Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle }"],
            capture_output=True, timeout=25,
        )
        out = r.stdout.decode("utf-8", "replace")
        return [x.strip() for x in out.replace("\r\n", "\n").split("\n") if x.strip()]
    except Exception:
        return []


def close_explorer_windows():
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } "
             "| ForEach-Object { $_.CloseMainWindow() | Out-Null }"],
            capture_output=True, timeout=25,
        )
    except Exception:
        pass
    time.sleep(1.2)


def wait_up(seconds=25):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            ms, body = get("/api/ping", timeout=2)
            if body:
                return True
        except Exception:
            pass
        time.sleep(0.4)
    return False


def port_free(port):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def ps_count():
    """当前 powershell 进程数（用来确认缓存生效、没有每次请求都 spawn）。"""
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             "(Get-Process powershell -ErrorAction SilentlyContinue | Measure-Object).Count"],
            capture_output=True, text=True, timeout=20,
        ).stdout.strip()
        return int(out or 0)
    except Exception:
        return -1


def start_server(node, env):
    return subprocess.Popen([node, SERVER], env=env, cwd=os.path.dirname(SERVER),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def kill(proc):
    try:
        proc.kill()
    except Exception:
        pass


def main():
    node = find_node()
    tmp = tempfile.mkdtemp(prefix="wr_keepalive_")
    data_dir = os.path.join(tmp, "data")
    os.makedirs(data_dir, exist_ok=True)
    env = {**os.environ, "WEEKLY_PANEL_PORT": str(PORT), "WEEKLY_PANEL_DATA": data_dir,
           "PYTHONIOENCODING": "utf-8"}
    procs = []
    try:
        if not port_free(PORT):
            print(f"端口 {PORT} 已被占用，跳过（换个端口：KEEPALIVE_PORT=xxxx）")
            return 0

        proc = start_server(node, env)
        procs.append(proc)
        check("服务 25 秒内起来", wait_up(25))

        ms, body = get("/api/ping")
        ping = json.loads(body)
        check("ping 返回 ok/pid/version", ping.get("ok") and ping.get("pid") and ping.get("version"), str(ping))
        check("ping 很快（<300ms，通常 1~2ms）", ms < 300, f"{ms:.0f} ms")

        lat = []
        for _ in range(5):
            ms, _b = get("/api/ping")
            lat.append(ms)
        check("连续 ping 都很快（<100ms）", max(lat) < 100, f"{[round(x, 1) for x in lat]}")

        ms_state, body_state = get("/api/state", timeout=20)
        state = json.loads(body_state)
        check("/api/state 首次也是毫秒级（<2000ms）", ms_state < 2000, f"{ms_state:.0f} ms")
        check("/api/state 带 pid / checks", bool(state.get("pid")) and isinstance(state.get("checks"), list))

        # 缓存生效：连着打 10 次，powershell 进程数不该涨
        before = ps_count()
        t0 = time.time()
        for _ in range(10):
            get("/api/state", timeout=20)
        total = (time.time() - t0) * 1000
        after = ps_count()
        check("10 次 /api/state 平均 <200ms", total / 10 < 200, f"平均 {total/10:.0f} ms")
        # 别处（面板/别的测试）也可能起/停 powershell，留 1 个容差，避免偶发抖动
        check("缓存生效：powershell 进程没增加", after <= before + 1, f"{before} -> {after}")

        # 第二个实例：端口被占 → 自己退出（不顶掉在跑的）
        dup = start_server(node, env)
        code = dup.wait(timeout=20)
        check("第二个实例检测到端口占用后自行退出", code == 0, f"exit={code}")
        check("原实例仍在服务", json.loads(get("/api/ping")[1]).get("ok") is True)

        # v0.8.0：PowerShell 守护任务已下线，接口只回 410
        try:
            get("/api/watchdog", timeout=5)
            wd_code = 200
        except urllib.error.HTTPError as e:
            wd_code = e.code
        except Exception:
            wd_code = -1
        check("/api/watchdog 已下线（410）", wd_code == 410, f"HTTP {wd_code}")

        # 杀掉服务 → 宿主式静默拉起（node + detached + windowsHide，不起 powershell）
        ps_base = ps_count()
        kill(proc)
        procs.clear()
        time.sleep(1.5)
        try:
            get("/api/ping", timeout=2)
            down = False
        except Exception:
            down = True
        check("服务已被杀掉", down)

        out_log = open(os.path.join(tmp, "respawn.log"), "wb")
        respawn = subprocess.Popen(
            [node, SERVER], env=env, cwd=os.path.dirname(SERVER),
            stdout=out_log, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        procs.append(respawn)
        check("宿主式不带窗口的拉起让服务回来", wait_up(30))

        # 隐藏启动器：wscript + VBS（窗口样式 0）跑命令 → 有副作用、桌面不弹窗
        for exe in ("wscript.exe", "wscript"):
            if shutil.which(exe) or os.path.isfile(os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "System32", "wscript.exe")):
                wscript = exe
                break
        else:
            wscript = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "System32", "wscript.exe")
        marker = os.path.join(tmp, "hidden-ok.txt")
        child = os.path.join(tmp, "hidden_child.py")
        with open(child, "w", encoding="utf-8") as f:
            f.write("open(r'%s', 'w').write('ok')\n" % marker.replace("\\", "\\\\"))
        command = '"%s" "%s"' % (sys.executable, child)
        vbs = os.path.join(tmp, "run-hidden-test.vbs")
        with open(vbs, "w", encoding="mbcs", errors="replace") as f:
            f.write("Option Explicit\r\nDim sh\r\nSet sh = CreateObject(\"WScript.Shell\")\r\n")
            f.write("sh.Run \"%s\", 0, True\r\n" % command.replace('"', '""'))
        r3 = subprocess.run([wscript, "//nologo", vbs], capture_output=True, timeout=120)
        check("隐藏启动器执行成功", os.path.isfile(marker), (r3.stderr or b"").decode("utf-8", "replace")[-200:])
        # 拉起后服务自己会 spawn 一次 powershell 查计划任务（windowsHide，进程很快退出），
        # 所以留 1 个容差；这里只防「常驻了一堆 powershell」这种回归。
        time.sleep(3.0)
        ps_after = ps_count()
        check("拉起/隐藏执行都没有额外 powershell 常驻", ps_after <= ps_base + 1, f"{ps_base} -> {ps_after}")
        # 打开目录：接口放行 + **资源管理器真的弹窗**（windowsHide 会让窗口不出现）
        if sys.platform == "win32":
            out_dir = os.path.join(tmp, "weekly")
            os.makedirs(os.path.join(out_dir, "2026年11月"), exist_ok=True)
            sample = os.path.join(out_dir, "2026年11月", "周报_2026-11-09_2026-11-15.txt")
            with open(sample, "w", encoding="utf-8") as f:
                f.write("【项目运维】\n示例学校\n  进度：100%\n")
            # 让测试实例的输出目录指向临时目录
            cfg_path = os.path.join(data_dir, "config.json")
            cfg = {"handler": "测试", "out_dir": out_dir, "folder": out_dir,
                   "token_file": os.path.join(data_dir, "api-key.txt")}
            with open(cfg_path, "w", encoding="utf-8") as f:
                json.dump(cfg, f, ensure_ascii=False)

            close_explorer_windows()
            code, r = post("/api/open-dir", {"path": os.path.join(out_dir, "2026年11月")})
            time.sleep(2.5)
            titles = explorer_windows()
            check("open-dir：目录内路径放行", code == 200 and r.get("ok") is True, f"{code} {r}")
            # 窗口标题一般是目录名，但也可能是「文件资源管理器」（还没切到该目录）——两种都算弹出来了
            check("open-dir：资源管理器真的弹出窗口",
                  bool(titles) and any(("2026" in x or "月" in x or "文件资源管理器" in x) for x in titles),
                  f"windows={titles}")
            close_explorer_windows()

            code, r = post("/api/open-dir", {"path": sample})
            time.sleep(2.5)
            check("open-dir：文件路径也放行（打开所在目录并选中）",
                  code == 200 and r.get("ok") is True and r.get("selected") is True, f"{code} {r}")
            close_explorer_windows()

            # 绩效表：列表 / 读内容 / 打开目录（绩效表目录也算允许范围）
            _ms, perf = get("/api/perf", timeout=30)
            pj = json.loads(perf)
            check("perf：接口返回 ok", pj.get("ok") is True, str(pj)[:120])
            check("perf：给出绩效表根目录与当月表路径",
                  bool(pj.get("root")) and bool(pj.get("current")), str(pj)[:200])
            # 造一张测试用绩效表放进绩效表目录（结构与真表一致：第 7 行起是任务区）
            import openpyxl
            perf_root = os.path.join(tmp, "perf")
            os.makedirs(os.path.join(perf_root, "2026"), exist_ok=True)
            sample_perf = os.path.join(perf_root, "2026", "2026年11月测试员工月度考核表-交付中心.xlsx")
            wbk = openpyxl.Workbook()
            wsh = wbk.active
            wsh.title = "月度考核"
            wsh["B2"] = "员工月度考核表"
            wsh["B3"], wsh["D3"] = "被考评人", "测试"
            wsh["B4"], wsh["D4"] = "考评时间", "2026年11月1日-11月30日"
            wsh["K3"] = __import__("datetime").datetime(2026, 11, 12, 10, 0, 0)
            for rr in range(7, 22):
                wsh.merge_cells(f"B{rr}:C{rr}")
                wsh.merge_cells(f"D{rr}:I{rr}")
                wsh.merge_cells(f"M{rr}:N{rr}")
            wsh["B22"] = "工作任务考核（60%权重）"
            wsh["B7"], wsh["D7"] = "项目运维", "示例学校某事项"
            wsh["J7"] = __import__("datetime").datetime(2026, 11, 2)
            wsh["K7"] = __import__("datetime").datetime(2026, 11, 3)
            wsh["L7"] = "是"
            wbk.save(sample_perf)
            cfg["folder"] = perf_root
            with open(cfg_path, "w", encoding="utf-8") as f:
                json.dump(cfg, f, ensure_ascii=False)
            time.sleep(0.6)

            _ms, body = get("/api/perf", timeout=30)
            pj = json.loads(body)
            names = [t2["name"] for t2 in pj.get("tables", [])]
            check("perf：列出月度考核表", len(pj.get("tables") or []) > 0, str(len(pj.get("tables") or [])))
            check("perf：列表里能看到刚造的表",
                  any("2026年11月" in n for n in names), str(names[:3]))
            code, r = post("/api/open-dir", {"path": perf_root})
            check("open-dir：绩效表目录也允许打开", code == 200 and r.get("ok") is True, f"{code} {r}")
            code, r = post("/api/open-dir", {"path": os.path.join(perf_root, "2026")})
            check("open-dir：绩效表的年份子目录也允许打开", code == 200 and r.get("ok") is True, f"{code} {r}")
            _ms, body = get("/api/perf/table?path=" + urllib.parse.quote(sample_perf), timeout=60)
            rj = json.loads(body)
            check("perf/table：能读出表内容",
                  rj.get("ok") is True and (rj.get("table") or {}).get("total", 0) >= 1,
                  str(rj)[:200])
            code, body = 0, ""
            try:
                _ms, body = get("/api/perf/table?path=" + urllib.parse.quote("C:/Windows/win.ini"), timeout=30)
            except Exception as e:
                code = getattr(e, "code", 0)
                body = str(e)
            check("perf/table：绩效表目录外的文件被拒绝",
                  code == 403 or "ok" not in (json.loads(body) if body.startswith("{") else {}),
                  f"{code} {str(body)[:120]}")

            # 模板自检（GET）
            _ms, body = get("/api/perf/template", timeout=90)
            tj = json.loads(body)
            check("perf/template：自检可用", tj.get("ok") is True and bool((tj.get("report") or {}).get("items")),
                  str(tj)[:160])
            check("perf/template：认出刚造的模板",
                  any("2026年11月" in (it.get("name") or "") for it in tj["report"]["items"]),
                  str([it.get("name") for it in tj["report"]["items"]])[:160])

            # 空目录（别人新装）：模板自检要给出可执行的提示，而不是崩
            empty_perf = os.path.join(tmp, "perf_empty")
            os.makedirs(empty_perf, exist_ok=True)
            cfg["folder"] = empty_perf
            with open(cfg_path, "w", encoding="utf-8") as f:
                json.dump(cfg, f, ensure_ascii=False)
            time.sleep(0.6)
            _ms, body = get("/api/perf/template", timeout=90)
            ej = json.loads(body)
            rep = ej.get("report") or {}
            check("perf/template：空目录时报告不通过", rep.get("ok") is False, str(rep)[:160])
            check("perf/template：空目录时给出补救提示",
                  bool(rep.get("errors")) and bool(rep.get("hints")), str(rep)[:200])

            # 模板缺失时 auto_pick_xlsx 不再抛异常（避免整次生成被带崩）
            import importlib.util as _ilu
            _spec = _ilu.spec_from_file_location("gen_weekly_text", os.path.join(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "service", "engine", "gen_weekly_text.py"))
            _g = _ilu.module_from_spec(_spec)
            _spec.loader.exec_module(_g)
            import datetime as _dt
            picked = _g.auto_pick_xlsx(empty_perf, _dt.date(2026, 11, 1))
            check("auto_pick_xlsx：目录为空时返回 None 而不是抛错", picked is None, repr(picked))
            picked2 = _g.auto_pick_xlsx(os.path.dirname(sample_perf), _dt.date(2026, 11, 1))
            check("auto_pick_xlsx：能挑到当月的表", picked2 is not None and "2026年11月" in os.path.basename(picked2),
                  repr(picked2))

            cfg["folder"] = perf_root
            with open(cfg_path, "w", encoding="utf-8") as f:
                json.dump(cfg, f, ensure_ascii=False)
            time.sleep(0.4)

            code, r = post("/api/open-dir", {"path": "C:/Windows"})
            check("open-dir：输出目录外被拒绝", code == 400 and r.get("ok") is False, f"{code} {r}")
            code, r = post("/api/open-dir", {})
            check("open-dir：空路径被拒绝", code == 400 and r.get("ok") is False, f"{code} {r}")

            # 场景：周报文件**直接躺在输出根目录**（没有子目录）——按钮不能失效
            flat = os.path.join(tmp, "flat")
            os.makedirs(flat, exist_ok=True)
            with open(os.path.join(flat, "周报_2026-11-02_2026-11-08.txt"), "w", encoding="utf-8") as f:
                f.write("【项目运维】\n示例学校\n  进度：100%\n")
            cfg["out_dir"] = flat
            with open(cfg_path, "w", encoding="utf-8") as f:
                json.dump(cfg, f, ensure_ascii=False)
            time.sleep(0.6)
            ms, body = get("/api/state?force=1", timeout=20)   # force=1 绕过 30 秒状态缓存
            flat_state = json.loads(body)
            flat_reports = flat_state["reports"]
            check("扁平目录：报告仍被列出", len(flat_reports) == 1, str(len(flat_reports)))
            if flat_reports:
                fr = flat_reports[0]
                check("扁平目录：inRoot 标记为真", fr.get("inRoot") is True, str(fr))
                check("扁平目录：dirAbs 指向输出根目录",
                      os.path.normcase(os.path.dirname(fr["path"])) == os.path.normcase(flat), str(fr))
            code, r = post("/api/open-dir", {"path": flat})
            check("扁平目录：打开输出根目录成功", code == 200 and r.get("ok") is True, f"{code} {r}")
            if flat_reports:
                code, r = post("/api/open-dir", {"path": flat_reports[0]["path"]})
                check("扁平目录：打开周报文件（选中）成功",
                      code == 200 and r.get("ok") is True and r.get("selected") is True, f"{code} {r}")
    finally:
        # 收拾：先按 ping 报的 pid 精确杀掉（watchdog 拉起的那个进程是 detached 的）
        try:
            pid = json.loads(get("/api/ping", timeout=2)[1]).get("pid")
            if pid:
                subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, timeout=20)
        except Exception:
            pass
        for p in procs:
            kill(p)
        # 兜底：清掉测试数据目录起的实例（env 里的 WEEKLY_PANEL_DATA 会出现在命令行？没有，按 tmp 名兜一次）
        try:
            subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command",
                 "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | "
                 f"Where-Object {{ $_.CommandLine -match 'wr_keepalive_' -or $_.CommandLine -match '{PORT}' }} | "
                 "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"],
                capture_output=True, text=True, timeout=30,
            )
        except Exception:
            pass
        shutil.rmtree(tmp, ignore_errors=True)

    print("")
    print(f"通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    for f in FAILED:
        print("  ✗ " + f)
    return 0 if not FAILED else 1


if __name__ == "__main__":
    sys.exit(main())
