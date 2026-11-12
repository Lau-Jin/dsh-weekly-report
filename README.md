# dsh-weekly-report

> DeepSeek Harness（DSH）的**周报面板插件**：在侧边栏里配置、生成、查看周报，自带生成引擎，不依赖外部脚本。
>
> 版本 **0.8.2** ｜ 许可 MIT ｜ Windows

---

## 它是什么

一个装进 [DeepSeek Harness](https://github.com/deepseek-ai) 的插件：侧边栏多一个「周报」图标，点开就是一个本地面板（`127.0.0.1:8798`），可以：

- 配置 **MCP 地址 / API Key / 处理人 / 相似度阈值 / 输出目录 / 绩效表目录 / 邮件 SMTP**
- 一键**生成周报**（实时日志、可终止）、查看**历史周报**
- **绩效表按月累积**：当月考核表 = 本月全部周报内容（同一事项一行，时间自动并集），格式不动；每周生成自动并表，月底自动核对
- **目录可点选**（盘符、面包屑、新建目录）
- API Key 一键测试连通性；邮件「试运行（不发信）」
- 可选：一键登记 Windows 计划任务，每周自动生成
- **保持在线**：轻量 `/api/ping` 探活 + 内存缓存的状态接口 + 宿主 20 秒心跳 + Windows 计划任务守护（每 2 分钟探活，挂了自动拉起）

生成逻辑（`.py` 引擎）随插件分发，**不需要额外安装 Python 包**——用 DSH 自带运行时即可。

## 工作原理

```
DSH 侧边栏「周报」
   └─ iframe → http://127.0.0.1:8798/           本地面板服务（Node 标准库，无依赖）
                  ├─ service/engine/gen_weekly_text.py   生成引擎（唯一真源）
                  └─ %USERPROFILE%\.dsh\weekly-report\   配置 / Key / 日志 / 默认输出
```

插件 Host 半身（`lib/index.js`）负责拉起本地服务并每 60 秒探活；浏览器半身（`lib/client.js`）往侧边栏和主面板注入页面。

## 前置要求

| 项 | 说明 |
|---|---|
| 系统 | Windows 10/11 |
| DSH | 已安装并能打开 |
| MCP 服务 | 一个实现以下工具的 MCP HTTP 端点（在面板里配置地址）：工单查询/详情、任务列表/详情、工时记录、工作日历 |
| API Key | 该 MCP 服务的访问令牌（每个人的自己的） |

> 引擎默认调用的工具名（可在 `service/engine/gen_weekly_text.py` 顶部常量里按需修改）：
> `ticket_list` / `ticket_get_detail` / `task_list_my_tasks` / `task_get_task_detail` /
> `worklog_list_mine` / `calendar_workdays`。

## 安装

### 方式 A · 本地检出 + Junction（推荐：改代码即时生效）

```powershell
git clone git@github.com:Lau-Jin/dsh-weekly-report.git D:\Tools\Lau-tool
powershell -ExecutionPolicy Bypass -File D:\Tools\Lau-tool\dsh-weekly-report\install.ps1
# 完全退出 DSH 再打开
```

| 参数 | 作用 |
|---|---|
| `-Status` | 查看安装状态（Junction / 依赖 / bundle / patch / 服务进程 / 数据目录） |
| `-Uninstall` | 卸载（保留数据） |
| `-Profile <名字>` | 装到指定 profile（默认 `desktop`） |
| `-ProfileRoot <路径>` | 直接指定 profile 目录 |
| `-Copy` | 不用 Junction，复制一份（改代码不即时生效） |

### 方式 B · DSH 插件页填仓库地址

DSH → 设置 → 插件 → **添加插件** → 填仓库地址：

```
git@github.com:Lau-Jin/dsh-weekly-report.git
```

或用 `https://github.com/Lau-Jin/dsh-weekly-report.git`。仓库根有「入口包」`package.json`，
入口指向子目录 `dsh-weekly-report/`。

### 两种方式的数据位置**相同**

```
%USERPROFILE%\.dsh\weekly-report\   ← 配置 / API Key / 日志 / 默认输出（不在仓库里）
```

所以随时切换安装方式，配置和历史都在。可用环境变量 `WEEKLY_PANEL_DATA` 覆盖。

## 打包给同事

```powershell
powershell -ExecutionPolicy Bypass -File .\pack-plugin.ps1
# 产物：dist\dsh-weekly-report-<版本>.zip（约 300 KB，自动排除配置/Key/日志）
```

## 使用

详见 [docs/使用说明.md](dsh-weekly-report/docs/使用说明.md)：安装、首次配置、界面、生成规则、
邮件、定时任务、数据位置、更新、FAQ。

## 周报长什么样

每条 6 行：类别 / 单位 / 时间 / 事项 / 工作内容（链接）/ 重要说明 / 进度。

- 纳入条件：本周期有我的工时（与处理人无关）｜本周期新建且我负责｜跨周收尾
- 子任务独立成条；子任务未全部完成时父任务不算完成
- 未完成的条目时间拉到本周周日

## 许可

[MIT](LICENSE)
