---
name: xc-ego
description: 基于 EgoLite（ego-browser）操作海博中台（zt.hiboos.com）与美团闪购/外卖商家后台（shangoue.meituan.com、waimaie.meituan.com，含小仓/乐心宜双中台）的通用浏览器自动化技能。涉及这两个后台的任何网页操作（查询、导出报表、修改设置，或将操作固化为本机流程按名复用）都触发本技能；纯本地整理或其他网站不触发。
---

# xc-ego：海博与美团 EgoLite 自动化

依托本机 **EgoLite（`ego-browser`）** 执行 **海博中台** 与 **美团商家后台**（小仓、乐心宜双中台）的报表导出与网页操作，产出默认保存至 `产出文件/YYYYMMDD-HHmm_<中台>_<任务名>/`。

## 关键不变量

1. **边界收口**：仅处理海博中台与美团商家后台任务；纯本地文件处理或其他网站任务礼貌说明不适用并退出。
2. **EgoLite 唯一执行通道**：执行前先在宿主机非沙箱环境通过 `await profiles()` 探活并体检本机 `ego-browser` 与目标资料（严禁在无 `User Data` 读写权限的沙箱或受限环境中冷启动 `ego.exe`）；未安装或未就绪时立即停止并引导安装，**不回退**到其他浏览器或编造结果。
3. **双中台同流程、分入口隔离**：小仓与乐心宜共用同一套页面路径与操作流程；**海博**共用 1 个资料（默认 `采集`）并在页内切换与校验顶部业务单元，**美团**对应 2 个独立账号资料（默认 `小仓` / `乐心宜`），禁止混用会话。
4. **后台隔离窗口**：任务窗口最小化、网页视口保持桌面尺寸在后台运行，不抢占用户前台界面。
5. **不查自定义导出字段，守住 5 项底线检查**：因各用户导出列设置不同，**不校验**导出列清单与顺序；必须完成环境登录、中台与业务单元、筛选回读、动态操作人防重导、下载终态与 `.xlsx` 结构校验这 5 项检查。
6. **路径可固化、参数不写死、选择权归用户**：开局先查本机 `~/.xc-ego/workflows/` 固定流程；绝不自动固化或静默记忆参数；未固化新操作成功后按固定框架询问一次是否固化；已固化流程只固路径与骨架，中台、门店名称、渠道、日期、修改数值等参数每次按需说明。

## 路由与按需阅读

只读取当前任务所需的参考文件：

| 场景 | 下一步动作 |
|---|---|
| 缺少 `ego-browser` / 缺少对应资料 / 登录失败 | 读 [references/install-egolite.md](references/install-egolite.md) |
| 匹配、管理或固化本机固定流程（含固定格式回复） | 读 [references/workflow-crystallization.md](references/workflow-crystallization.md) |
| 海博中台任意报表导出与页面操作 | 读 [references/hibo-tables.md](references/hibo-tables.md) |
| 美团闪购商家端 / 外卖商家版操作 | 读 [references/meituan-sop.md](references/meituan-sop.md) |
| 参数合并、本机环境配置与 5 项必要检查细则 | 读 [references/preferences-and-checks.md](references/preferences-and-checks.md) |

## 六步执行闭环

### 第 1 步：触发判别、已固化流程匹配与路由
依据：图式/脚本理论与渐进式披露。确认请求属于海博中台或美团商家后台：
- 纯本地整理或非海博/美团任务直接退出，不启动浏览器；
- 先调用 `scripts/workflows.mjs`（`action: "match"`）匹配本机固定流程（同时支持单项流程与整体串联流程）：命中唯一流程且其 `isWriteOperation` 读写属性与本次指令一致时沿用其固定路径与步骤骨架（整体流程按 `subTasks` 顺序串行执行）；返回 `status: "multi"` 时按 `matchedList` 顺序串行执行各项，并在完成后按模板 A2 询问是否固化整体串联流程（对应单项设 `alreadySaved: true`）；存在多条歧义候选时停下列出请用户点选；未命中（或旧路径仅匹配到相反读写意图的新操作）则按常规路径执行（若目标页面已改版导致旧路径失效，切回常规路径并在完成后询问是否更新流程）；
- 涉及多张表或同时涉及「小仓」与「乐心宜」时，拆成串行子任务依次执行，不混跑两个美团账号会话。

### 第 2 步：前置环境与登录体检
依据：防错核对清单。先在宿主机非沙箱环境通过 `ego-browser nodejs -e "await profiles()"` 探活（禁止在无 `User Data` 读写权限的沙箱中冷启动 `ego.exe`；若 `await profiles()` 挂起，严禁并发反复重试，应提示用户检查或重启宿主 EgoLite），确认 `ego-browser` 可执行后，再运行 `scripts/preflight.mjs` 检查目标资料与登录态：
- 命令不可用或过旧 → 按 [references/install-egolite.md](references/install-egolite.md) 引导安装或升级后停止；
- 缺少 `采集`（海博）或对应中台资料 `小仓`/`乐心宜`（美团）→ 引导新建或绑定已有资料后停止；
- 跳到登录页或出现验证码 → `preflight.mjs` 会自动恢复并保留登录窗口（`keptWindow: true`）供用户人工验证，完成后从原任务接回。

### 第 3 步：参数补全与一次问清
依据：合作原则（适量且清晰）。调用 `scripts/prefs.mjs`（`action: "resolve"`）合并用户主动配置的环境项（资料名、`outputRoot` 等）与当次口头参数，结合命中流程的 `requiredParams` 检查缺口：
- 仍缺中台、门店名称、渠道、日期或目标修改数值等必填项时**合并一次问清**；
- 用户首次选店不知精确全称时，先在对应中台目标页面通过 `scripts/lib/hibo_controls.mjs` 的 `listAvailableStores` 拉取真实门店列表供勾选。

### 第 4 步：后台独立窗口执行与回读
依据：闭环反馈控制与混合主动交互原则。
- **海博中台操作**：按 [references/hibo-tables.md](references/hibo-tables.md) 通过 `ego-browser nodejs` 执行，可复用 `scripts/lib/hibo_controls.mjs` 提供的最小化后台窗口、404/无权限识别、清弹窗、业务单元切换与校验、筛选重置与门店/渠道回读、`selectDateRangeAndVerify` 日期选择回读、查询行数读取（兼容表格与卡片列表）、防重导导出与验包原语；若报 `STORE_NOT_FOUND`，提示核对门店是否属于另一中台。
- **美团商家后台操作**：按 [references/meituan-sop.md](references/meituan-sop.md) 通过 `ego-browser nodejs` 执行，优先复用 `scripts/lib/meituan_controls.mjs` 提供的 `openMeituanTaskSpace`、`checkMeituanLoginState`、`readMeituanHeaderStore`、`verifyMeituanPoiPageReady` 与 `captureWriteSnapshot`；禁止在未核实目标门店上下文（或处于「全部门店」缺少 `wmPoiId`）的情况下直接读写单店设置。
- **写操作自主判断与提交**：无论是读操作还是改起送价、改配送费、改价、报名/取消活动等写操作，均允许固化并完整执行；当用户意图与变动参数齐备、美团目标门店经 `verifyMeituanPoiPageReady` 核验一致且页面状态正常时，先通过 `captureWriteSnapshot` 记录变更前快照，再直接执行提交并再次快照/回读核验生效，不做冗余二次确认；仅在缺参、门店上下文不匹配、目标多义或页面状态异常时停下确认。

### 第 5 步：防重导提交与终态核验
依据：幂等性与端到端校验。
- 提交导出前动态读取右上角操作人并写入 `_recovery.json`；若轮询超时或中断，**严禁重复点击导出**，必须改用 `scripts/lib/hibo_controls.mjs` 的 `resumeFromRecovery` 凭 `_recovery.json` 回查原记录；出现多条歧义记录时停下请用户指定。
- 经 `chrome://downloads/` 核对安全放行后，用 `scripts/lib/xlsx_check.mjs` 校验 `.xlsx` 工作簿结构；落盘至 `产出文件/YYYYMMDD-HHmm_<中台>_<任务名>/`（或自定义 `outputRoot`）并汇报路径、大小、查询行数与检查结果。

### 第 6 步：完工后流程固化询问与落盘
依据：用户控制与自由、命题清晰性原则。
- **仅当本次为未命中固定流程的新操作且成功完成**时，按 [references/workflow-crystallization.md](references/workflow-crystallization.md) 调用 `scripts/workflows.mjs`（`action: "format-offer"`）在汇报末尾输出固定格式询问（不叠加默认参数提问）：
  - 单张表 / 单点操作：输出模板 A1 询问是否固化；
  - 一次对话含多张表或多步操作（且未直接命中既有整体流程）：传入 `items` 输出模板 A2，询问固化**整体流程**、**指定单项**还是**都要**；
- **已命中对应固定流程跑完、任务失败中断或纯体检**，不再询问固化；
- 用户明确回复同意后，按选择调用 `scripts/workflows.mjs`（`action: "save"` 存单项或 `composite` 整体，或 `action: "save-batch"` 存「都要」），只把固定路径与 `requiredParams` 参数槽位落盘至 `~/.xc-ego/workflows/`（禁止写死门店、渠道、日期、数值等业务参数），并原样输出返回的《逻辑哲学论》固定框架说明下次如何调用。

## 跨平台脚本调用约定

`ego-browser nodejs` 不继承终端环境变量且不保证工作目录。调用 `scripts/` 下 `.mjs` 时，先把参数写入 UTF-8 临时 `request.json`，再用单行命令传入绝对路径（Windows 与 macOS 通用）：

- **PowerShell（Windows）**：
  ```powershell
  ego-browser nodejs -e "await (await import('file:///<skill_dir_forward_slashes>/scripts/<script>.mjs')).run('<abs_request_json_forward_slashes>')"
  ```
  *(示例：`file:///C:/path/to/xc-ego/scripts/workflows.mjs`)*
- **macOS / Linux / Git Bash**：
  ```bash
  ego-browser nodejs -e "await (await import('file://<abs_skill_dir>/scripts/<script>.mjs')).run('<abs_request_json>')"
  ```
  *(示例：`file:///path/to/xc-ego/scripts/workflows.mjs`)*

`scripts/workflows.mjs` 与 `scripts/prefs.mjs` 同样优先使用上方 `ego-browser nodejs` 方式调用（无需本机另装 Node.js）；若本机已安装 `node`，也可直接执行 `node <skill_dir>/scripts/<script>.mjs --request <abs_request_json>`。

## 停止条件

- 本机未安装 `ego-browser` 或缺少目标资料；
- 目标后台要求登录、扫码或验证码；
- 本机固定流程匹配出现多条歧义候选、海博业务单元无法唯一识别，或导出记录存在多条歧义候选；
- 写操作缺少明确参数、存在目标歧义或页面状态异常，尚未获用户确认。
