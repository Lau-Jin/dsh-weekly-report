# -*- coding: utf-8 -*-
"""绩效表「跨周累积 + 月底核对」回归测试。

只操作临时副本，绝不写真实绩效表。

跑法（用带 openpyxl 的 Python）：
    python dsh-weekly-report/tests/test_perf.py
"""
import glob
import importlib.util
import os
import shutil
import sys
import tempfile
from datetime import date, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ENGINE = os.path.join(ROOT, "service", "engine", "gen_weekly_text.py")
REAL_DIR = os.environ.get("WEEKLY_PERF_DIR", r"D:\Perf\2026")

spec = importlib.util.spec_from_file_location("gen_weekly_text", ENGINE)
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)

PASSED, FAILED = [], []


def check(name, cond, detail=""):
    if cond:
        PASSED.append(name)
        print(f"  ✓ {name}")
    else:
        FAILED.append(name + (f" —— {detail}" if detail else ""))
        print(f"  ✗ {name}" + (f" —— {detail}" if detail else ""))


def item(category, school, subject, d1, d2=None, settled=False):
    return {"category": category, "school": school, "subject": subject,
            "d1": d1, "d2": d2 or d1, "settled": settled, "note": "无"}


def build_synthetic_template(path):
    """没有真实模板时造一份同结构的最小模板（B2/D3/D4/K3 + 任务区 + 考核区块）。"""
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "月度考核"
    ws["B2"] = "员工月度考核表"
    ws["B3"], ws["D3"] = "姓名", "张三"
    ws["B4"], ws["D4"] = "考核时间", "2026年11月1日-11月30日"
    ws["K3"] = datetime(2026, 11, 1)
    ws["B6"], ws["D6"], ws["J6"], ws["K6"], ws["L6"], ws["M6"] = (
        "序号", "工作内容", "开始时间", "结束时间", "是否完成", "备注")
    for r in range(7, 22):
        ws.merge_cells(f"B{r}:C{r}")
        ws.merge_cells(f"D{r}:I{r}")
        ws.merge_cells(f"M{r}:N{r}")
    # 三个考核区块（评分公式要能按区块位置算出来）
    ws["B22"] = "工作任务考核（60%权重）"
    for r in range(23, 28):
        ws.merge_cells(f"B{r}:C{r}")
        ws.merge_cells(f"G{r}:I{r}")
        ws.merge_cells(f"M{r}:N{r}")
    ws["B24"] = 1
    ws["B28"] = "工作绩效考核（30%权重）"
    for r in range(29, 36):
        ws.merge_cells(f"B{r}:C{r}")
        ws.merge_cells(f"G{r}:I{r}")
        ws.merge_cells(f"M{r}:N{r}")
    ws["B36"] = "品质与态度考核（10%权重）"
    for r in range(37, 42):
        ws.merge_cells(f"B{r}:C{r}")
        ws.merge_cells(f"G{r}:I{r}")
        ws.merge_cells(f"M{r}:N{r}")
    wb.save(path)
    return path


def pick_template(tmp):
    files = sorted(glob.glob(os.path.join(REAL_DIR, "*.xlsx")))
    files = [f for f in files if not os.path.basename(f).startswith("~$")]
    if files:
        tpl = files[-1]
        print(f"模板：{os.path.basename(tpl)}（真实模板副本）")
    else:
        tpl = build_synthetic_template(os.path.join(tmp, "synthetic.xlsx"))
        print(f"模板：{os.path.basename(tpl)}（合成模板）")
    out = os.path.join(tmp, "2026年11月测试员工月度考核表-交付中心.xlsx")
    shutil.copy2(tpl, out)
    # 清掉模板里已有的任务行，模拟「当月表刚建、还没有内容」
    import openpyxl
    wb = openpyxl.load_workbook(out)
    g._write_task_rows(g.perf_sheet(wb), [])
    wb.save(out)
    return out


def snapshot(path):
    """任务区以外的单元格 + 合并区域 + 行高，用来确认版式没被改动。"""
    import openpyxl
    wb = openpyxl.load_workbook(path)
    ws = g.perf_sheet(wb)
    start, cap, sec_row = g.perf_task_zone(ws)
    cells = {}
    for r in range(sec_row, ws.max_row + 1):
        for c in range(1, ws.max_column + 1):
            v = ws.cell(r, c).value
            if v is not None:
                cells[(r, c)] = v
    merges = sorted(str(x) for x in ws.merged_cells.ranges
                    if x.min_row >= sec_row or x.max_row < 7)
    heights = {r: ws.row_dimensions[r].height
               for r in range(sec_row, ws.max_row + 1)
               if ws.row_dimensions[r].height}
    return cells, merges, heights, (start, cap, sec_row)


def rows_of(path):
    import openpyxl
    wb = openpyxl.load_workbook(path)
    ws = g.perf_sheet(wb)
    return g.read_perf_rows(ws)


def main():
    tmp = tempfile.mkdtemp(prefix="perf_test_")
    try:
        path = pick_template(tmp)
        base = snapshot(path)

        # ---- 1) 第一周：3 条 ----
        week1 = [
            item("项目运维", "示例科技职业学院", "接诉即办部署", "2026-11-02", "2026-11-02", True),
            item("交付部署", "示例建筑大学", "AI体测系统升级", "2026-11-03", "2026-11-03", True),
            item("项目支撑", "示例职业技术学院", "流程引擎下拉项字段长度问题",
                 "2026-11-04", "2026-11-06", False),
        ]
        g.build_perf_xlsx(path, path, week1, 2026, 11, "测试")
        rows = rows_of(path)
        check("第一周写入 3 行", len(rows) == 3, f"实际 {len(rows)}")
        check("工作内容 = 学校 + 事项",
              any(r["content"] == "示例科技职业学院接诉即办部署" for r in rows),
              str([r["content"] for r in rows]))
        check("起止时间写入", any(r["d1"] == date(2026, 11, 4) and r["d2"] == date(2026, 11, 6)
                                for r in rows))
        check("是否完成标记", any(r["settled"] for r in rows) and any(not r["settled"] for r in rows))

        # ---- 2) 第二周：2 条跨周（时间延长、完成变是）+ 1 条新的 ----
        week2 = [
            item("项目支撑", "示例职业技术学院", "流程引擎下拉项字段长度问题",
                 "2026-11-04", "2026-11-09", False),
            item("项目运维", "示例科技职业学院", "接诉即办部署", "2026-11-02", "2026-11-02", True),
            item("交付部署", "演示环境", "示例流程引擎更新", "2026-11-09", "2026-11-15", False),
        ]
        g.build_perf_xlsx(path, path, week2, 2026, 11, "测试")
        rows = rows_of(path)
        check("第二周累积不冲掉第一周（4 行）", len(rows) == 4, f"实际 {len(rows)}")
        subj = {r["content"]: r for r in rows}
        r = subj.get("示例职业技术学院流程引擎下拉项字段长度问题")
        check("跨周事项时间取并集",
              bool(r) and r["d1"] == date(2026, 11, 4) and r["d2"] == date(2026, 11, 9),
              str(r))
        check("跨周事项不重复成两行", list(subj).count("示例科技职业学院接诉即办部署") == 1)
        check("按开始时间排序", [x["d1"] for x in rows] == sorted(x["d1"] for x in rows),
              str([str(x["d1"]) for x in rows]))

        # ---- 3) 重跑同一周：幂等 ----
        g.build_perf_xlsx(path, path, week2, 2026, 11, "测试")
        check("重跑同一周不增行", len(rows_of(path)) == 4, f"实际 {len(rows_of(path))}")

        # ---- 4) 核对通过 ----
        week_items = week1 + week2
        ok, text = g.check_perf_xlsx(path, 2026, 11, "测试",
                                     week_items=week_items,
                                     week_files=["周报_a.txt", "周报_b.txt"])
        check("核对：内容一致时通过", ok, text.replace("\n", " | ")[:400])
        check("核对报告含结论", "结论：通过" in text)

        # ---- 5) 缺一条 → 不通过 → --perf-fix 补上 ----
        extra_item = item("项目运维", "示例城市职业学院", "统一身份认证访问失败",
                          "2026-11-10", "2026-11-10", True)
        ok2, text2 = g.check_perf_xlsx(path, 2026, 11, "测试",
                                       week_items=week_items + [extra_item])
        check("核对：缺事项时不通过", not ok2 and "缺少 1 条" in text2, text2[-300:])
        ok3, text3 = g.check_perf_xlsx(path, 2026, 11, "测试",
                                       week_items=week_items + [extra_item], fix=True)
        check("--perf-fix 补齐缺失", "自动补齐 1 条" in text3 and ok3, text3[-300:])
        check("补齐后行数 5", len(rows_of(path)) == 5, f"实际 {len(rows_of(path))}")
        ok4, text4 = g.check_perf_xlsx(path, 2026, 11, "测试",
                                       week_items=week_items + [extra_item])
        check("补齐后核对通过", ok4, text4[-300:])

        # ---- 6) 版式没变 ----
        cells, merges, heights, zone = snapshot(path)
        b_cells, b_merges, b_heights, b_zone = base
        check("考核区块及其下单元格未改", cells == b_cells,
              f"差异：{set(cells.items()) ^ set(b_cells.items())}")
        check("考核区块合并区域未改", set(b_merges) <= set(merges),
              f"少了：{set(b_merges) - set(merges)}")
        check("考核区块行高未改", heights == b_heights)
        check("任务区仍从第 7 行开始", zone[0] == 7 and b_zone[0] == 7, str(zone))

        import openpyxl
        wb = openpyxl.load_workbook(path)
        ws = g.perf_sheet(wb)
        check("处理人写进 D3", str(ws["D3"].value) == "测试", str(ws["D3"].value))
        check("考核月份写进 D4", "2026年11月" in str(ws["D4"].value), str(ws["D4"].value))
        check("填报时间写进 K3", ws["K3"].value is not None)
        fonts = {(ws.cell(r, c).font.name, ws.cell(r, c).font.sz)
                 for r in range(7, 12) for c in (2, 4, 10, 11, 12)}
        check("填写单元格字体统一 微软雅黑 10", fonts == {("微软雅黑", 10)}, str(fonts))
        check("日期格式 yyyy/m/d",
              all("yyyy" in str(ws.cell(r, c).number_format) for r in range(7, 12) for c in (10, 11)))

        # ---- 6b) 考核评分公式跟着考核区块走 ----
        start, cap, sec = g.perf_task_zone(ws)
        k4, m4 = str(ws["K4"].value), str(ws["M4"].value)
        rows_in_k4 = [int(x) for pair in __import__("re").findall(r"M(\d+):N(\d+)", k4) for x in pair]
        check("K4 评分公式指向 60% 区块",
              rows_in_k4 and min(rows_in_k4) >= sec + 2 and max(rows_in_k4) <= sec + 6,
              f"K4={k4}，区块在第 {sec} 行")
        check("M4 最终评分公式含 0.6/0.3/0.1 三段",
              "0.6" in m4 and "0.3" in m4 and "0.1" in m4, m4)
        ws["K4"] = "=SUM(M24:N28)"          # 造一份「行数变过、公式没跟上」的表
        ws["M4"] = "=SUM(M24:N28)*0.6+SUM(M31:N36)*0.3+SUM(M39:N42)*0.1"
        wb.save(path)
        g.build_perf_xlsx(path, path, [], 2026, 11, "测试")
        wb3 = openpyxl.load_workbook(path)
        ws3 = g.perf_sheet(wb3)
        _, _, sec3 = g.perf_task_zone(ws3)
        check("旧公式会被校正回区块位置",
              str(ws3["K4"].value) == f"=SUM(M{sec3 + 2}:N{sec3 + 6})",
              f"{ws3['K4'].value}，区块第 {sec3} 行")
        check("校正公式后行数不变", len(rows_of(path)) == 5, f"实际 {len(rows_of(path))}")

        # ---- 7) 超过模板行数：下移考核区块，报告仍通过 ----
        many = [item("项目运维", f"测试学校{i}学院", f"事项{i}", "2026-11-02", "2026-11-25", False)
                for i in range(30)]
        g.build_perf_xlsx(path, path, many, 2026, 11, "测试")
        rows = rows_of(path)
        check("条目多于模板行数时全部写入", len(rows) == 35, f"实际 {len(rows)}")
        wb2 = openpyxl.load_workbook(path)
        ws2 = g.perf_sheet(wb2)
        merges2 = {str(x) for x in ws2.merged_cells.ranges}
        _, _, _, zone2 = snapshot(path)
        check("扩容后考核区块下移", zone2[2] > b_zone[2], f"{b_zone[2]} -> {zone2[2]}")
        ok5, text5 = g.check_perf_xlsx(path, 2026, 11, "测试",
                                       week_items=week1 + week2 + [extra_item] + many)
        check("扩容后格式仍通过", ok5, text5[-500:])
        check("扩容后合并单元格齐全（B:C / D:I / M:N）",
              all(f"B{r}:C{r}" in merges2 and f"D{r}:I{r}" in merges2 and f"M{r}:N{r}" in merges2
                  for r in range(7, 7 + len(rows))),
              str(sorted(m for m in merges2 if m.startswith(("B3", "B4")))[:2]))

        # ---- 8) 周报文本解析 ----
        rpt = os.path.join(tmp, "周报_2026-11-09_2026-11-15.txt")
        with open(rpt, "w", encoding="utf-8") as f:
            f.write("【项目运维】\n示例科技职业学院\n  时间: 2026年11月9日\n"
                    "  事项: 接诉即办部署\n  工作内容：https://x/1\n"
                    "  重要说明：无\n  进度：100%\n\n"
                    "【交付部署】\n示例科贸职业学院\n  时间: 2026年11月9日-15日\n"
                    "  事项: 理事长app闪退问题\n  工作内容：https://x/2\n"
                    "  重要说明：无\n  进度：60%\n")
        parsed = g.parse_weekly_report(rpt)
        check("周报解析出 2 条", len(parsed) == 2, str(parsed))
        check("周报时间解析（单日）", parsed[0]["d1"] == date(2026, 11, 9))
        check("周报时间解析（区间）",
              parsed[1]["d1"] == date(2026, 11, 9) and parsed[1]["d2"] == date(2026, 11, 15),
              str(parsed[1]))
        check("周报进度→完成标记", parsed[0]["settled"] and not parsed[1]["settled"])
        check("事项/学校解析", parsed[1]["school"] == "示例科贸职业学院"
              and parsed[1]["subject"] == "理事长app闪退问题")

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("")
    print(f"通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    for f in FAILED:
        print("  ✗ " + f)
    return 0 if not FAILED else 1


if __name__ == "__main__":
    sys.exit(main())
