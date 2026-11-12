# dsh-weekly-report · 周报面板插件（自主版 v0.8.1）

**完全自主**：生成引擎、配置、API Key、输出目录全部在插件内，不再依赖 `D:\Reports` 里的脚本和配置。
装进 DSH 后在**侧边栏**用，也能单独用浏览器打开。

> ⚠ **主数据源是本仓库**（本机检出 `D:\Tools\Lau-tool`）。引擎唯一真源：`service/engine/gen_weekly_text.py`。
> 后续所有修改、调试都改这个文件；桌面 `D:\Reports\gen_weekly_text.py` 只是留档镜像，
> 改完跑一次同步即可：
>
> ```powershell
> powershell -ExecutionPolicy Bypass -File .\dsh-weekly-report\sync-desktop.ps1          # 同步
> powershell -ExecutionPolicy Bypass -File .\dsh-weekly-report\sync-desktop.ps1 -Check   # 只比较
> ```
>
> 同步脚本有差异才覆盖、覆盖前自动备份 `<文件>.bak-时间戳`。

```
DSH 侧边栏「周报」
   └─ iframe → http://127.0.0.1:8798/     （本地面板服务）
                  ├─ service/engine/gen_weekly_text.py   ← 引擎唯一真源
                  ├─ <data>/config.json                  插件配置
                  ├─ <data>/api-key.txt                  插件 Key
                  └─ <data>/reports/                     默认输出目录
```

## 目录

| 路径 | 作用 |
|---|---|
| `icon.svg` | 插件图标：插件页 / 面板 favicon / 顶栏 logo 都用它（`service/public/icon.svg` 是同一份） |
| `locale/*.json` | 插件页上显示的名字与说明（`meta.title` / `meta.description`，中英各一份） |
| `lib/index.js` | Host 半身：保证面板服务在跑（20 秒心跳，挂了自动拉起，见「保持在线」） |
| `lib/client.js` | 浏览器半身：主面板 + 侧边栏入口（图标带状态点） |
| `service/server.cjs` | 面板服务（`127.0.0.1:8798`，仅 Node 标准库） |
| `service/paths.cjs` | 路径与配置：插件自有目录、首次从旧位置迁移 |
| `service/engine/gen_weekly_text.py` | **随插件分发的生成引擎**（与桌面版同一份逻辑） |
| `service/ps/*.ps1` | 计划任务查询 / 注册 / 删除 |
| `service/public/` | 面板网页：概览 / 配置 / 生成 / 历史 / 注意事项 |
| `service/data/` | 配置、Key、日志、默认输出（**含凭据，别外发**） |

## 安装（两种方式，数据同一处）

两种方式装同一份代码；**数据永远在 `%USERPROFILE%\.dsh\weekly-report`**，所以可随意切换。

### 方式 A · 本地检出 + Junction（推荐）

```powershell
git clone git@github.com:Lau-Jin/dsh-weekly-report.git D:\Tools\Lau-tool
powershell -ExecutionPolicy Bypass -File D:\Tools\Lau-tool\dsh-weekly-report\install.ps1
# 完全退出 DSH 再打开
```

脚本做的事（幂等，可重复执行）：

1. `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-weekly-report` 建 **Junction** → 仓库里的插件目录
2. profile 的 `package.json`：`dependencies` 写 `link:<插件目录>`、`dsh.profile.bundles` 加 `dsh-weekly-report`（顺带去重）
3. profile 的 `cordis.patch.yml`：insert `weekly-report`

| 参数 | 作用 |
|---|---|
| `-Status` | 查看状态（Junction / 依赖写法 / bundle / patch / 服务进程 / 数据目录） |
| `-Uninstall` | 卸载（保留数据） |
| `-Profile <名字>` | 装到指定 profile（默认 `desktop`） |
| `-ProfileRoot <路径>` | 直接指定 profile 目录 |
| `-Copy` | 不用 Junction，复制一份（改代码不即时生效） |

### 方式 B · DSH 插件页填仓库地址

DSH → 设置 → 插件 → **添加插件** → 填：

```
git@github.com:Lau-Jin/dsh-weekly-report.git
```

或用 `https://github.com/Lau-Jin/dsh-weekly-report.git`。仓库根有入口包 `package.json`
（`name` = `dsh-weekly-report`，入口指向本目录），装完重启 DSH。

- 更新：插件页「更新」或重新填地址 → 重启 DSH
- 卸载：插件页「卸载」

### 两种方式对比

| | A · Junction | B · 插件页 |
|---|---|---|
| 插件实体 | 指向仓库目录 | 复制进 `node_modules` |
| 改代码 | 重启 DSH 即生效 | 要重装 |
| 更新 | `git pull` + 重启 | 点「更新」+ 重启 |
| 数据 | `%USERPROFILE%\.dsh\weekly-report` | 同左 |

### 判断当前是哪种

```powershell
powershell -ExecutionPolicy Bypass -File D:\Tools\Lau-tool\dsh-weekly-report\install.ps1 -Status
```

| 输出 | 结论 |
|---|---|
| `dependency : link:...` + `link : Junction -> ...` | 方式 A |
| `dependency : github:...` / `link : real directory` | 方式 B |

### 数据存放位置

| 内容 | 位置 |
|---|---|
| 配置 / API Key / 日志 / 默认输出 | `%USERPROFILE%\.dsh\weekly-report\`（**不进 git**） |
| 实际周报输出 | 面板「配置 → 周报输出目录」 |
| 覆盖位置 | 环境变量 `WEEKLY_PANEL_DATA` |

首次启动会按顺序迁移旧数据（只读）：① 插件目录内 `service/data`（旧版）② `D:\Reports`（更早桌面版）。

## 首次启动会做什么

插件配置不存在时，**只读一次**旧位置并迁移过来：

| 迁移项 | 来源 |
|---|---|
| 处理人 / 阈值 / MCP 地址 / 绩效表目录 | `D:\Reports\weekly_config.json` |
| 邮件开关与 SMTP 全套（含授权码） | 同上 |
| API Key | `D:\Reports\api_key.txt` |
| 输出目录 | 旧配置里的 `out_dir`；存在就**沿用原周报目录**，保证周报继续落原处 |

迁移后写入 `service/data/config.json`，**之后不再读旧文件**。
概览页会显示「迁移来源」，方便确认。

## 面板功能

> UI v0.2.1 重做：卡片式布局、健康徽标、快捷操作、表单即时校验与未保存提示。

### 迁移/换目录后报「包元信息错误 … package.json: ENOENT」

插件目录**搬家过**（例如从 `D:\Tools\Lau-tool\dsh-weekly-report` 换到 `D:\Tools\Lau-tool\dsh-weekly-report`）时，
DSH 进程可能还持有旧路径，插件页就会报这个错。处理：

```powershell
# 1) 旧路径建兼容 Junction（让旧引用能解析到新目录）
mklink /J "D:\Tools\Lau-tool\dsh-weekly-report" "D:\Tools\Lau-tool\dsh-weekly-report"

# 2) 完全退出 DSH 再打开（这一步才会丢掉旧路径缓存）
```

之后兼容 Junction 可留可删——`install.ps1 -Status` 显示 `Junction -> 新路径` 即为正常。
### 子任务补录（2026-11-11 修复）

平台「我的任务列表」接口**不返回子任务**，父任务（如工单关联的「示例流程引擎更新」）下面的子任务
本来会漏掉。现在引擎会对「本周期已纳入的父任务」额外取 `children`，再逐个判断归属：

- 子任务负责人/参与人是我 → 纳入
- 本周期内新建 → 纳入（进度按状态，10% 起）
- 学校优先取子任务标题里的学校，标题没有才继承父任务；类型按子任务自己标题判断

开销可控（每个父任务 1 次 + 每个子任务 1 次，上限 80 次），日志会打印「子任务补录：N 条…」。

### 概览
顶部徽标一眼看状态（绿=正常 / 黄=有提醒 / 红=要处理）；下面是卡片：

| 卡片 | 内容 |
|---|---|
| 健康状态 | 7 项体检，每项带 ✓ / ! 标记与说明，右上角显示「n/7 项正常」 |
| 快捷操作 | **生成本周周报** / 只试运行 / 查看历史，一键直达 |
| 绩效表核对 | 「核对本月绩效表（缺的自动补）」按钮 + 核对报告正文 |
| 系统定时任务 | 状态、下次运行、是否已接管，附带「登记每周自动生成（周日 22:00）」/「移除定时任务」按钮 |
| 最近一次生成 | 成功/失败徽标 + 时间 + 产物路径（默认隐藏，卡片右上角单独开） |
| 路径 | 默认隐藏；**每张卡片各自一个「显示路径 / 隐藏路径」按钮**（路径 / 定时任务 / 最近一次生成 / 历史），互不影响，选择分别记住 |

体检项：API Key、Python 环境、内置引擎、邮件通知、系统定时任务、绩效表目录、输出目录。

### 配置
三张卡片 + 底部固定操作条：

1. **研发平台接入** — API Key（眼睛图标切换明文）+ **保存** + **测试**（真调一次 MCP，回「可用工具 70 个 / 241ms」）
2. **生成参数** — 处理人、**相似度阈值（滑块 + 数字联动）**、输出目录、绩效表目录
   - **「处理人」不是过滤条件**：周报不只收「处理人是我」的工单，本周期内**有我的工时记录**的工单也会计入（处理人是谁都算）。
     这个字段用于三处归属判断：① 本周期新建工单是否算我的；② 跨周收尾（本周完成但没记工时）是否算我的；③ 日志里的「我处理」标记。
   - **目录可点选**：「浏览…」打开目录选择器，支持盘符切换、逐级进入、新建文件夹、双击直接选中，选中后回填绝对路径
3. **邮件通知** — 开关、SMTP、端口、发件人、授权码（可切换明文）、收件人

填写体验：
- 所有文本框/密码框/数字框/日期框/搜索框**外观完全一致**（35px 高、1px 边框、8px 圆角、10px 内距、12.5px 字号），
  滑块与复选框保持原生形态
- 改动后底部出现**「有未保存修改」**黄点提示
- 授权码留空 = 不修改（不会清掉已存的）
- 底部固定条常驻「保存配置」「试运行（不发信）」，滚到哪都能点
- 深链：`?tab=config` / `?tab=run` / `?tab=reports` / `?tab=notes` 直接打开对应页签
- 自检：`?diag=1` 会把各控件的计算样式打到页面末尾，用来核对输入框是否一致

### 生成
- 周期用**分段控件**：本周 / 上周 / **上个月** / 自定义区间，下面有一行说明这趟会生成什么
- **周期语义**：区间内**每一周**各出一份周报（区间跨几周就有几份），涉及的每个月各写一份绩效表；
  「上个月」= 上个月整月按周拆（4~5 份周报 + 1 份绩效表）
- **周报模板**：周报按 `service/engine/templates/周报模板.txt` 渲染（每条事项一块，
  支持 `{{category}}` `{{school}}` `{{time}}` `{{subject}}` `{{work}}` `{{note}}` `{{progress}}`），
  改模板文件即可改周报样子；配置里 `report_template` 可指定自己的模板
- **生成结果**：生成完在下方分「周报」「绩效表」两个模块列出本次产物；点「查看」在**对应那条下面就地展开**
  （周报看正文、绩效表看表格），再点一次收起
- **完成判定**：周报里的「完成」= 平台已收口（状态完成/已评分…）或本周工时备注写了完成；
  绩效表里同一工单在多周周报重复出现时，**以完成度 100% 的那条为准**
- **速度**：工单/任务列表、任务详情、工时、工作日都会缓存在本地（默认 6 小时，工时 10 分钟），
  重复生成/重跑几乎不花时间；面板上可勾「不用缓存重新拉取」强制刷新（慢但数据最新）
- 选项做成**带说明的整行可点区域**，不是小方框
- 主按钮「开始生成」，旁边「终止」
- 日志卡片有状态条：灰点=等待、蓝点闪烁=生成中（显示已用时长）、绿点=完成、红点=失败；可一键清空
- **绩效表卡片**：显示本月考核表的状态（是否存在、大小、更新时间、路径），四个按钮——
  **查看绩效表**（直接在面板里看表内容，不用开 Excel）、**打开所在目录**、**打开绩效表目录**、**核对本月绩效表**；
  下方可展开「往月的绩效表」，每张表也能查看 / 打开目录

### 历史
搜索框即时过滤文件名；每条显示目录、条数、大小、时间，点「查看」在下方展开正文，可收起。
周报放在子目录里时，每条右边有 **「打开所在目录」** 按钮（资源管理器打开该文件所在目录，打开文件时顺带选中文件）；
工具栏的 **「打开输出目录」** 打开输出根目录。文件直接放在输出根目录（没有子目录）时，行内按钮不出现——
它和「打开输出目录」是同一个地方。服务端只允许打开周报输出目录以内的位置。

### 注意事项
16 条内置规则，可按「全部 / 注意 / 重要」筛选，左侧色条区分级别。

## 绩效表模板（新装机器怎么准备）

绩效表**没有随插件分发模板**：引擎是拿绩效表目录里已有的月度考核表当模板套用的。
所以新机器第一次用要先准备一张模板：

| 要求 | 说明 |
|---|---|
| 目录 | 配置页「绩效表目录」填一个存在的目录，例如 `D:\...\绩效表\2026`（插件会在其下按年份建子目录） |
| 文件 | 放**至少一张** `.xlsx` 月度考核表（名字随意，`~$` 开头的临时文件会被忽略）；引擎优先挑名字里带当年当月的，否则用最新那张 |
| 结构 | 工作表名最好是「月度考核」（没有就用最后一个）；第 7 行起是任务区（类别 / 任务名称 / 开始时间 / 结束时间 / 是否完成 / 评定）；下面要有「工作任务考核（60%）」等区块，否则评分的公式无从指向 |
| 公式 | 模板里的 `K4`/`M4` 评分公式会随任务区行数自动校正；缺失也不影响写入任务行 |
| 缺模板 | **不会再把整次周报生成带崩**：周报照常生成，只是提示「绩效表目录里还没有可用的模板」 |

面板上点 **模板自检** 可以直接看到当前目录的模板状态与补救提示；
命令行也能查：`python gen_weekly_text.py --config <配置> --perf-template-check`。

## 绩效表（月度考核表）：按月累积 + 月底核对

**以前的问题**：每次生成拿当月表当模板就地重填，只写当周条目，前面几周的内容会被冲掉；
一个月里跑几次，绩效表里就只剩最后一次。

现在的口径（v0.7.0 起，引擎 `build_perf_xlsx` / `check_perf_xlsx`）：

| 规则 | 说明 |
|---|---|
| 内容 = 本月全部周报 | 每周生成时把本周条目**并进**当月表，先读表里已有的行再合并 |
| 同一事项一行 | 学校+事项（忽略空格标点）相同就合并：起止时间取并集、「是否完成」取或、备注（M 列）保留 |
| 只写六列 | B 类别 / D 学校+事项 / J 开始 / K 结束 / L 是否完成 / M 备注；其它单元格、合并区域、字体、行高、列宽都不动 |
| 行数不够自动加 | 超过模板任务行数时下移「工作任务考核」等区块，并同步校正 K4/M4 评分公式，版式不变 |
| 生成后自动核对 | 每次生成都对照**本月各周周报文本**逐条比对：内容、起止时间、完成标记、格式；缺的自动补齐 |
| 月底报告 | 本周覆盖月末（`we >= 月末-6 天`）时输出完整核对报告；上个月的绩效表还没核对过也会补一次 |

核对报告写在绩效表旁边：`<绩效表名>_核对.txt`，长这样：

```
绩效表核对 · 2026年11月 · 张三
核对时间：2026-11-30 22:01:03
文件：D:\Perf\2026\2026年11月张三员工月度考核表-交付中心.xlsx

一、内容（对照本月各周周报）
  本月周报 3 篇：周报_2026-11-02_2026-11-08.txt、… 
  周报事项 41 条（合并同一事项后 35 条）
  表内事项 35 条
  ✓ 周报里的事项都在表内
  ✓ 起止时间与周报一致
  ✓ 完成标记与周报进度一致
  ✓ 没有重复行

二、格式
  ✓ 表头标题在（B2）  ✓ 处理人 张三（D3）  ✓ 考核月份 2026年11月（D4）  ✓ 填报时间已填（K3）
  ✓ 35 行数据完整  ✓ 任务行连续  ✓ 合并单元格齐全  ✓ 字体统一 微软雅黑 10
  ✓ 日期格式 yyyy/m/d  ✓ 考核区块位置正常  ✓ 考核评分公式指向考核区块

结论：通过
```

手动核对（也是「月底检查」的兜底）：

```powershell
# 只核对当前月（快，不调接口；只读本周报目录 + 绩效表）
python "<插件>\service\engine\gen_weekly_text.py" --config "<插件>\service\data\config.json" --perf-check

# 核对并把周报里有、表里缺的补进去
... --perf-check --perf-fix

# 指定月份 / 额外与研发平台本月数据比对（要 Key）
... --perf-check --perf-month 2026-11 --perf-platform
```

面板里也有按钮：概览 →「绩效表核对」→ **核对本月绩效表（缺的自动补）**。

## 保持在线（连通性，v0.7.1）

以前面板偶尔「服务没响应」、侧边栏变红，不是服务真挂了，而是**探活打错了接口**：
宿主心跳和侧边栏都拿 `/api/state` 当健康检查，而 `/api/state` 要 spawn python 体检
（约 1 秒）+ powershell 查计划任务（约 2~5 秒），慢的时候超过探活超时 → 判成「挂了」→
反复拉起 → 日志里一堆 `port 8798 in use`，面板还可能卡在「服务没有响应」。

现在分四层：

| 层 | 做法 |
|---|---|
| 探活接口 | 新增 **`GET /api/ping`**：不碰磁盘、不 spawn 进程，1~2 ms 返回 `{ok,pid,version,uptimeMs,busy}` |
| 状态接口 | `/api/state` 全部读内存缓存：python 体检缓存 10 分钟、计划任务查询缓存 5 分钟，**先回旧值、后台刷新**，第一次调用也是毫秒级 |
| 宿主心跳 | `lib/index.js` 改 ping 探活、20 秒一次、单飞（上一次拉起没结果不重复拉），拉起后 5 秒内复核，只记「起来／没起来」两种日志。**这也是唯一的一层保活**（v0.8.0 起） |
| 面板/侧边栏 | 也改 ping；面板挂了时 3 秒一探，**服务回来后自动刷新 iframe**，不用手点「重试」 |

实测（本机）：`/api/ping` 0~1 ms，`/api/state` 首次 14 ms、之后 5~12 ms（改之前首次 4.9~6.4 秒）；
20 次 `/api/state` 期间 powershell 进程数不增加；杀掉服务后宿主心跳 20 秒内拉起。

### 为什么不再装 `周报面板守护` 计划任务（v0.8.0 删除）

v0.7.1 起装过一个 Windows 计划任务 `周报面板守护`：每 2 分钟跑
`powershell.exe -WindowStyle Hidden ... watchdog.ps1` 探一次 ping。问题是
**`-WindowStyle Hidden` 是 PowerShell 自己启动后才应用的**，控制台窗口会先建出来再隐藏——
桌面上每隔 2 分钟闪一个蓝色控制台窗口（实测可见 0.45 秒，`ConsoleWindowClass`）。

它要的能力本来就有：`lib/index.js` 的宿主心跳每 20 秒 `fetch /api/ping`，不在就用
`spawn(..., { windowsHide: true, detached: true })` 拉起，**全程无窗口、不依赖 PowerShell**。
所以 v0.8.0 把这个计划任务、`service/ps/watchdog*.ps1`、面板上的「面板服务守护」卡片、
`/api/watchdog` 的读写实现全部删掉：

- `GET/POST /api/watchdog` 还在，但只回 **410**（告诉老面板「已下线」，不再安装任何东西）
- `install.ps1` 的 `-NoWatchdog` 参数一并去掉；`-Uninstall` 与安装末尾会顺手清掉老任务
- 老版本装过的任务用一句 `Unregister-ScheduledTask -TaskName '周报面板守护' -Confirm:$false` 清掉即可

代价：DSH 完全退出时服务不再常驻（以前靠那个计划任务），重新打开 DSH 后几秒自动回来。
需要「DSH 不开也要活着」的话，自己用「任务计划程序」建一个 **wscript 拉起的隐藏任务**，
不要再用 `powershell.exe -WindowStyle Hidden`（会闪窗）。

## 定时任务接管

概览页按钮「登记每周自动生成（周日 22:00）」会**创建/覆盖** Windows 计划任务 `周报自动生成`。

**v0.8.0 起是隐藏启动**：任务动作不再是 `python.exe ...`，而是

```
wscript.exe //nologo "%USERPROFILE%\.dsh\weekly-report\run-weekly-hidden.vbs"
```

那个 VBS 由 `service/ps/task-install.ps1` 自动生成，里面一行
`sh.Run "<python>" "<插件>\service\engine\gen_weekly_text.py" --config ... --week current --perf-auto --log, 0, True`，
窗口样式 `0` = **从创建起就没有窗口**（`wscript.exe` 本身是 GUI 子系统程序，也不带控制台）。
真正的命令行以注释形式写在 VBS 里（`' COMMAND: ...`），面板据此判断「任务是否指向本插件」。

直接跑 `python.exe` 的老任务会在每周日 22:00 闪一个控制台窗口；重新点一次「登记每周自动生成」
就会换成隐藏启动（想手工改也行，见 `task-install.ps1`）。

仍在**你自己的 Windows 计划任务**里；随时可用「移除定时任务」还原。
不接管也能用——面板里手动点「开始生成」一样跑。

## API（面板内部用，也方便脚本调用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ping` | 轻量探活（不 spawn 进程），1~2 ms 返回 pid/version/uptimeMs/busy |
| GET | `/api/state` | 体检 + 配置(脱敏) + 定时任务 + 历史 + 注意事项 + 运行状态（内存缓存，毫秒级） |
| GET/POST | `/api/watchdog` | v0.8.0 起已下线，只回 **410**（服务由宿主心跳静默保活） |
| POST | `/api/config` | 保存配置（密码占位符回传不会覆盖真实值） |
| POST | `/api/api-key` | 保存 API Key |
| POST | `/api/test-key` | 用给定/已存 Key 调一次 MCP，返回工具数与耗时 |
| POST | `/api/run` | 生成（`{period,start,end,perfAuto,dryRun,noTasks}`） |
| GET | `/api/run` | 轮询运行状态与日志 |
| POST | `/api/run/cancel` | 终止 |
| GET | `/api/reports` / `/api/report?path=` | 历史列表 / 读正文（限制在输出目录内） |
| GET | `/api/fs?path=` | 列目录（盘符 + 子目录 + 是否可写），给目录选择器用 |
| POST | `/api/fs/mkdir` | 新建文件夹（`{parent, name}`，名称拒绝 `\ / : * ? " < > \|`） |
| GET/POST | `/api/schedule` | 查询 / `{action:'install'|'remove'}` |
| POST | `/api/test-mail` | 试运行（不发信） |
| POST | `/api/perf-check` | 核对当月绩效表（`{month?}`，缺的自动补），返回报告正文 |

## 手动运维

```powershell
# 起服务（DSH 会自动拉起，这里只是手动方式）
node "D:\Tools\Lau-tool\dsh-weekly-report\service\server.cjs"

# 直接开面板（不经过 DSH）
start http://127.0.0.1:8798/

# 状态
Invoke-RestMethod http://127.0.0.1:8798/api/state | ConvertTo-Json -Depth 4
```

日志：`service/data/logs/panel.log`。

## 安全

- 服务只绑 `127.0.0.1`。
- `GET /api/state` 里密码类字段替换为 `••••••••(长度)`。
- Key 与授权码只在 `service/data/`，**不要提交到代码库、不要随包外发**。
- 读历史周报限定在输出目录内且文件名匹配 `周报_*.txt`，越权返回 403。

## 与桌面版脚本的关系

`service/engine/gen_weekly_text.py` 是桌面版脚本的复制件，**产物逐字节一致**（已比对 SHA256）。
两边独立：改桌面版不会自动同步到插件，反之亦然。要同步就把新脚本复制进
`service/engine/`（插件不需要重新安装，服务重启或直接生成即可生效）。

## 公开脱敏版（对外开源 / 给同事装）

| 用途 | 位置 |
|---|---|
| 自己用（真实数据、内部逻辑） | 私有仓库 `Lau-Jin/dsh-weekly-report`（检出 `D:\Tools\Lau-tool`） |
| 对外开源、任何人可装 | 公开仓库 `Lau-Jin/dsh-weekly-report`（检出 `D:\Tools\Lau-tool-public`） |
| 给同事（不给仓库权限） | `pack-plugin.ps1` 打的离线包 `dist\dsh-weekly-report-<版本>.zip` |

公开版是**脱敏后的副本**，不是自动同步：改完私有版要手动跑一次

```powershell
# 只看会改哪些文件 + 脱敏自检（有无真实人名/域名/校名/本机路径残留）
python dsh-weekly-report\tools\sanitize_public.py --check
# 真正写进 D:\Tools\Lau-tool-public，再自己 commit/push
python dsh-weekly-report\tools\sanitize_public.py --write
```

替换规则在脚本顶部 `RULES` 里（人名→张三、内部域名→mcp.example.com、本机路径→D:\Reports / D:\Perf / D:\Tools\Lau-tool、真实校名→示例…），
`docs/screenshots`、`docs/同事安装说明.md`、`service/data` 一律不进公开版。

## 卸载

1. 删 profile 的 Junction
2. `profile/package.json` 去掉 `dependencies.dsh-weekly-report` 与 `bundles` 里的 `dsh-weekly-report`
3. `profile/cordis.patch.yml` 删掉 `- insert: - id: weekly-report` 那段
4. 重启 DSH
5. 想还原定时任务：把计划任务改回原外部脚本命令