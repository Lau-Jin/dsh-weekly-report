# dsh-weekly-report · DSH 周报工作台

> DeepSeek Harness（DSH）的**完全化周报插件**：双击安装、装上即用、免重启，面板里完成配置、生成、绩效表写入与历史查看。
>
> 版本 **1.1.2** ｜ 许可 MIT ｜ Windows / macOS / Linux

---

## 它是什么

一个装进 DeepSeek Harness 的独立插件包，双击 `一键安装.vbs` 后侧边栏多一个「周报」入口，打开就是本地面板（`127.0.0.1:8798`）：

- **四页面板**：概览（就绪情况 + 格式预览）/ 生成（周期选择 + 实时日志 + 结果展开收起）/ 设置（API Key、路径、模板、邮件）/ 历史（搜索、全文查看、格式修复）
- **一键生成周报**：按工单 / 任务中心 / 工时数据自动整理，条目格式 `【类别】/ 学校 / 时间 / 事项 / 工作内容 / 重要说明 / 进度`
- **绩效表同步写入**：本月全部周报内容写入月度考核表，逐格 diff、结构指纹校验、写前自动备份，不改表格样式与结构；可先「检测表格结构」核对待写位置
- **时间口径**：已完成 = 开始 ~ 实际完成；未完成 = 开始 ~ 所在周周日，绝不越界
- **邮件默认关闭**，插件不预置任何凭据；API Key、路径、模板全部由使用者自己提供
- **保持在线**：宿主 20 秒心跳静默拉起，装完不用重启 DSH，也不装计划任务

引擎（`service/engine/`，纯 Node）随包分发，**不需要额外安装任何东西**；绩效表组件（exceljs）随包自带，缺了也会自动补装。

## 安装（装完即用）

```powershell
git clone https://github.com/Lau-Jin/dsh-weekly-report.git
cd dsh-weekly-report\dsh-weekly-report
# 方式一：双击 一键安装.vbs（推荐）
# 方式二：node install.mjs
# 方式三：DSH 插件页添加仓库地址 https://github.com/Lau-Jin/dsh-weekly-report.git
```

安装器自动注册 profile 链接、bundle 依赖与 cordis 插入，并拉起面板服务；旧宿主心跳路径自动兼容，**无需重启 DSH**。

## 使用者只需三件事

1. **设置 → 研发平台接入**：粘贴你的 API Key、填处理人姓名，可点「测试连接」验证；
2. **设置 → 输出与模板**：填周报输出目录；需要绩效表时填绩效表目录（放入月度考核表 .xlsx），可点「检测表格结构」核对待写位置；
3. **生成**：选本周 / 上周 / 本月 / 自定义区间，点「开始生成」。

详细说明见 [`dsh-weekly-report/README.md`](dsh-weekly-report/README.md) 与 [`dsh-weekly-report/操作使用手册.html`](dsh-weekly-report/操作使用手册.html)（单文件手册，双击即可打开）。

## 工作原理

```
DSH 侧边栏「周报」
   └─ iframe → http://127.0.0.1:8798/        ← service/server.cjs（Node 标准库，零运行时依赖）
                 ├─ service/public/          面板 UI（原生 HTML/CSS/JS）
                 ├─ service/engine/          gen-weekly.mjs + lib/*.mjs（采集 / 渲染 / 绩效表）
                 └─ %USERPROFILE%\.dsh\weekly-report\
                       config.json / api-key.txt / reports/ / logs/
```

- 所有配置、API Key、历史周报都保存在用户数据目录，**不随仓库分发**；
- 面板只监听 `127.0.0.1`，浏览器半身不持有任何凭据；
- `node install.mjs --verify` 可随时自检（9 项全绿即健康）。

## 自检与卸载

```powershell
node install.mjs --verify     # 9 项自检
node install.mjs --uninstall  # 完整回滚（链接/依赖/patch/转发全部还原，数据保留）
```

## 许可

见 [LICENSE](LICENSE)。
