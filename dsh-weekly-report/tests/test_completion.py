# -*- coding: utf-8 -*-
"""「已完成 / 100%」判定口径的回归测试（v0.7.5）。

规则（2026-11-11 起）：不再用「本周之后没再记工时」倒推完成（那是在猜未来），
改成「平台收口 + 工时备注 / 工时进度」：

  1. 平台收口（已完成/已关闭/已评分/待评分/有评分）且完成日落在本周 → 100%
  2. 本周有我的工时，且该工时备注写了「已完成/完成/…」（不含否定词）→ 100%
  3. 本周工时里 progress 填了 100 → 100%
  4. 以上都不满足 → 未完成（进度按工时进度 / 状态估，封顶 95%）
  5. 子任务没全完成 → 不算完成（最高 95%，有工时不低于 60%）

只喂合成数据，不连平台、不写库。

跑法：python dsh-weekly-report/tests/test_completion.py
"""
import importlib.util
import os
import sys
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
ENGINE = os.path.join(PLUGIN, "service", "engine", "gen_weekly_text.py")

spec = importlib.util.spec_from_file_location("gen_weekly_text", ENGINE)
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)

WS, WE = date(2026, 11, 2), date(2026, 11, 8)   # 周一 ~ 周日
HANDLER = "张三"
PASSED, FAILED = [], []


def check(name, cond, detail=""):
    if cond:
        PASSED.append(name)
        print(f"  ✓ {name}")
    else:
        FAILED.append(name + (f" —— {detail}" if detail else ""))
        print(f"  ✗ {name}" + (f" —— {detail}" if detail else ""))


def ticket(tid, title="某校某事项", status="processing", created="2026-11-02",
           updated="2026-11-06", task_id=None, handler=HANDLER, score=None, school="某学院"):
    return {
        "id": tid, "ticket_no": f"T{tid}", "title": title, "school": school,
        "status": status, "handler": handler, "task_id": task_id or tid,
        "created_at": created, "updated_at": updated,
        "link": f"https://example.com/?ticketId={tid}", "score": score,
        "issue": "项目运维",
    }


def worklog(task_id, day, hours=1, progress=None, remark=""):
    return {"task_id": task_id, "work_date": day, "hours": hours,
            "progress": progress, "remark": remark}


def build(tickets, worklogs, child_stats=None):
    return g.build_items_from_tickets(
        tickets, worklogs, HANDLER, WS, WE,
        my_task_ids=set(), workdays=None, skip_task_ids=set(),
        child_stats=child_stats or {})


def by_subject(items):
    return {it["subject"]: it for it in items}


def main():
    print(f"周期 {WS} ~ {WE}\n")

    # 1) 本周有工时、无备注、平台还是处理中 → 不再自动 100%
    items = build([ticket(1, "A 没备注")], [worklog(1, "2026-11-03")])
    a = by_subject(items).get("A 没备注")
    check("本周有工时但没备注/未收口 → 不是 100%",
          a and a["progress"] != "100%" and a["settled"] is False,
          f"{a and a['progress']} / settled={a and a['settled']}")

    # 2) 工时备注写了「已完成」→ 100%
    items = build([ticket(2, "B 备注完成")],
                  [worklog(2, "2026-11-03"), worklog(2, "2026-11-04", remark="已完成，已上线")])
    b = by_subject(items).get("B 备注完成")
    check("工时备注写「已完成」→ 100% + 已收口",
          b and b["progress"] == "100%" and b["settled"] is True,
          f"{b and b['progress']} / settled={b and b['settled']}")

    # 3) 备注写「未完成，下周继续」→ 不算完成
    items = build([ticket(3, "C 备注未完成")],
                  [worklog(3, "2026-11-03", remark="未完成，下周继续")])
    c = by_subject(items).get("C 备注未完成")
    check("备注写「未完成/继续」→ 不算完成",
          c and c["progress"] != "100%" and c["settled"] is False,
          f"{c and c['progress']} / settled={c and c['settled']}")

    # 4) 工时 progress=100 → 100%
    items = build([ticket(4, "D 进度100")], [worklog(4, "2026-11-03", progress=100)])
    d = by_subject(items).get("D 进度100")
    check("工时进度填 100 → 100%",
          d and d["progress"] == "100%" and d["settled"] is True,
          f"{d and d['progress']}")

    # 5) 工时 progress=60 → 按 60 记（不升级到 100）
    items = build([ticket(5, "E 进度60")], [worklog(5, "2026-11-03", progress=60)])
    e = by_subject(items).get("E 进度60")
    check("工时进度 60 → 60%",
          e and e["progress"] == "60%" and e["settled"] is False,
          f"{e and e['progress']}")

    # 6) 平台已完成、完成日在本周 → 100%
    items = build([ticket(6, "F 平台完成", status="completed", updated="2026-11-05")],
                  [worklog(6, "2026-11-03")])
    f = by_subject(items).get("F 平台完成")
    check("平台已完成且完成日在本周 → 100%",
          f and f["progress"] == "100%" and f["settled"] is True,
          f"{f and f['progress']}")

    # 7) 本周有工时 + 平台已完成但完成日在下周（下周才点完成）→ 本周不算完成
    items = build([ticket(7, "G 下周才完成", status="completed", updated="2026-11-12")],
                  [worklog(7, "2026-11-03")])
    gg = by_subject(items).get("G 下周才完成")
    check("完成日不在本周（下周才点完成）→ 本周不算 100%",
          gg and gg["progress"] != "100%" and gg["settled"] is False,
          f"{gg and gg['progress']}")

    # 8) 本周之后还记了工时（但在本周已写备注完成）→ 仍按备注算 100%（备注是你写的，不再猜）
    items = build([ticket(8, "H 下周又记工时")],
                  [worklog(8, "2026-11-03", remark="完成"),
                   worklog(8, "2026-11-12", remark="补充优化")])
    h = by_subject(items).get("H 下周又记工时")
    check("备注写完成、之后又有工时 → 仍算完成（按备注，不猜未来）",
          h and h["progress"] == "100%" and h["settled"] is True,
          f"{h and h['progress']}")

    # 9) 子任务没全完成 → 父任务不算完成，进度 ≤95%
    items = build([ticket(9, "I 子任务没完", status="completed", updated="2026-11-05")],
                  [worklog(9, "2026-11-03")],
                  child_stats={"9": (3, 1)})
    i = by_subject(items).get("I 子任务没完")
    check("子任务没全完成 → 不算完成且 ≤95%",
          i and i["settled"] is False and int(i["progress"].rstrip("%")) <= 95,
          f"{i and i['progress']}")

    # 10) 跨周收尾：本周点完成、没工时、处理人是我 → 100%
    items = build([ticket(10, "J 跨周收尾", status="completed", updated="2026-11-06")], [])
    j = by_subject(items).get("J 跨周收尾")
    check("跨周收尾（本周完成、零工时）→ 100%",
          j and j["progress"] == "100%", f"{j and j['progress']}")

    # 11) 任务中心同一口径
    tasks = [
        {"id": 101, "title": "K 任务没备注", "status": "进行中", "is_owner": "1",
         "created_at": "2026-11-02", "updated_at": "2026-11-06", "product_name": "示例产品"},
        {"id": 102, "title": "L 任务备注完成", "status": "进行中", "is_owner": "1",
         "created_at": "2026-11-02", "updated_at": "2026-11-06", "product_name": "示例产品"},
        {"id": 103, "title": "M 任务已完成", "status": "已完成", "is_owner": "1",
         "created_at": "2026-11-02", "updated_at": "2026-11-05", "product_name": "示例产品"},
    ]
    wls = [worklog(101, "2026-11-03"), worklog(102, "2026-11-03", remark="已完成"),
           worklog(103, "2026-11-03")]
    titems = g.build_items_from_tasks(tasks, wls, HANDLER, WS, WE)
    tmap = by_subject(titems)
    check("任务：没备注/未完成状态 → 不是 100%",
          tmap.get("K 任务没备注") and tmap["K 任务没备注"]["progress"] != "100%",
          f"{tmap.get('K 任务没备注', {}).get('progress')}")
    check("任务：本周工时备注写完成 → 100%",
          tmap.get("L 任务备注完成") and tmap["L 任务备注完成"]["progress"] == "100%",
          f"{tmap.get('L 任务备注完成', {}).get('progress')}")
    check("任务：状态已完成且完成日在本周 → 100%",
          tmap.get("M 任务已完成") and tmap["M 任务已完成"]["progress"] == "100%",
          f"{tmap.get('M 任务已完成', {}).get('progress')}")

    # 12) 未完成的条目结束日拉到本周周日
    items = build([ticket(11, "N 未完到周日")], [worklog(11, "2026-11-03")])
    n = by_subject(items).get("N 未完到周日")
    check("未完成 → 结束日拉到本周周日",
          n and n["d2"] == WE.isoformat(), f"{n and n['d2']}")

    print("")
    print(f"通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    for f2 in FAILED:
        print("  ✗ " + f2)
    return 0 if not FAILED else 1


if __name__ == "__main__":
    sys.exit(main())
