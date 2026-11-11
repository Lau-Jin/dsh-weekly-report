# -*- coding: utf-8 -*-
"""面板服务「保持在线」回归测试（v0.7.1）。

只动临时目录 + 测试端口，绝不碰 8798 上的正式服务。

覆盖：
  1. /api/ping 轻量探活（毫秒级、不 spawn 进程）
  2. /api/state 走缓存（首次也快），不会每次请求都 spawn powershell
  3. 端口被占用时，第二个实例自己退出（不会顶掉在跑的）
  4. 服务被杀掉后，watchdog.ps1 能把它拉起来，并写一行 watchdog.log

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
WATCHDOG = os.path.join(PLUGIN, "service", "ps", "watchdog.ps1")
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
        check("缓存生效：powershell 进程没增加", before == after, f"{before} -> {after}")

        # 第二个实例：端口被占 → 自己退出（不顶掉在跑的）
        dup = start_server(node, env)
        code = dup.wait(timeout=20)
        check("第二个实例检测到端口占用后自行退出", code == 0, f"exit={code}")
        check("原实例仍在服务", json.loads(get("/api/ping")[1]).get("ok") is True)

        # 杀掉服务 → watchdog 拉起
        kill(proc)
        procs.clear()
        time.sleep(1.5)
        try:
            get("/api/ping", timeout=2)
            down = False
        except Exception:
            down = True
        check("服务已被杀掉", down)

        log_file = os.path.join(os.path.expanduser("~"), ".dsh", "weekly-report", "logs", "watchdog.log")
        size_before = os.path.getsize(log_file) if os.path.isfile(log_file) else 0
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-File", WATCHDOG, "-Port", str(PORT), "-Server", SERVER],
            capture_output=True, text=True, timeout=120,
        )
        check("watchdog 执行成功", r.returncode == 0, (r.stdout or r.stderr or "")[-200:])
        check("watchdog 把服务拉回来了", wait_up(20))

        time.sleep(0.8)
        size_after = os.path.getsize(log_file) if os.path.isfile(log_file) else 0
        check("watchdog 写了日志", size_after > size_before, f"{size_before} -> {size_after}")

        # 再跑一次：服务在 → 立刻退出、不写日志
        size1 = size_after
        r2 = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-File", WATCHDOG, "-Port", str(PORT), "-Server", SERVER],
            capture_output=True, text=True, timeout=60,
        )
        check("服务在时 watchdog 空跑", r2.returncode == 0 and os.path.getsize(log_file) == size1)
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
