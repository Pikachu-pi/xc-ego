---
name: xc-ego
description: 基于 EgoLite（ego-browser）操作海博中台（zt.hiboos.com）与美团闪购/外卖商家后台（shangoue.meituan.com、waimaie.meituan.com，含小仓/乐心宜双中台）的通用浏览器自动化技能。涉及这两个后台的任何网页操作（查询、导出报表、修改设置，或将操作固化为本机流程按名复用）都触发本技能；纯本地整理或其他网站不触发。
---

# xc-ego：海博与美团 EgoLite 自动化

依托本机 **EgoLite（`ego-browser`）** 执行 **海博中台** 与 **美团商家后台** 的报表导出与网页操作。

## 关键不变量

1. **边界收口**：仅处理海博中台与美团商家后台任务；纯本地文件处理或其他网站任务礼貌说明不适用并退出。
2. **EgoLite 唯一执行通道**：执行前先在宿主机非沙箱环境通过 `await profiles()` 探活并体检本机 `ego-browser` 与目标资料（严禁在无 `User Data` 读写权限的沙箱或受限环境中冷启动 `ego.exe`）；未安装或未就绪时立即停止并引导安装，**不回退**到其他浏览器或编造结果。
3. **默认资料直接可用、按需才新建资料**：
   - 不强制要求用户提前创建特定名称的资料；单美团中台或海博中台均可直接用 EgoLite **默认资料**打开目标网址并登录（支持同一默认资料开多个独立 `taskSpace` 窗口并行操作）；
   - **仅当美团侧需要同时登录两个不同中台账号（如小仓和乐心宜并存）** 时，因同一资料下美团域名会话只能保留一个账号，才提示用户保留默认资料登录其中一个中台、另建 1 个任意命名的资料登录另一个中台，并在 `~/.xc-ego/preferences.json` 记住映射。
4. **后台隔离窗口**：任务窗口最小化、网页视口保持桌面尺寸在后台运行，不抢占用户前台界面。
5. **能输入优先输入 + 语义观察**：所有可输入的搜索框、选择器、日期框（门店、渠道、日期、商品/活动关键词等）**优先直接输入文字匹配**，仅在控件只读或不支持搜索时再点击或滚动列表；遇到异常优先用 `page.snapshot()` 看清页面现场，**禁止无边界死循环重试**。
6. **不查自定义导出字段，守住 5 项底线检查**：因各用户导出列设置不同，**不校验**导出列清单与顺序；必须完成环境登录、中台与业务单元、筛选回读、动态操作人防重导、下载终态与 `.xlsx` 结构校验这 5 项检查。
7. **路径可固化、参数不写死、产出路径由用户定**：开局先查本机 `~/.xc-ego/workflows/` 固定流程；绝不自动固化或静默记忆参数；首次产出且未设 `outputRoot` 时提供推荐保存位置（桌面优先）请用户自选；未固化新操作成功后按固定 Markdown 框架询问一次是否固化。

## 路由与按需阅读

只读取当前任务所需的参考文件：

| 场景 | 下一步动作 |
|---|---|
| 缺少 `ego-browser` / 登录失败 / 多账号资料配置 | 读 [references/install-egolite.md](references/install-egolite.md) |
| 匹配、管理或固化本机固定流程（含 Markdown 询问/回执模板） | 读 [references/workflow-crystallization.md](references/workflow-crystallization.md) |
| 海博中台任意报表导出与页面操作方法论 | 读 [references/hibo-tables.md](references/hibo-tables.md) |
| 美团闪购商家端 / 外卖商家版操作 | 读 [references/meituan-sop.md](references/meituan-sop.md) |
| 参数合并、产出路径推荐、本机配置与 5 项底线检查 | 读 [references/preferences-and-checks.md](references/preferences-and-checks.md) |

## 六步执行闭环

### 第 1 步：触发判别、已固化流程匹配与路由
- 纯本地整理或非海博/美团任务直接退出，不启动浏览器；
- 先调用 `scripts/workflows.mjs`（`action: "match"`）匹配本机固定流程（同时支持单项流程与整体串联流程）：命中唯一流程且其 `isWriteOperation` 读写属性与本次指令一致时沿用其固定路径与步骤骨架（整体流程按 `subTasks` 顺序串行执行）；返回 `status: "multi"` 时按 `matchedList` 顺序串行执行各项，并在完成后按多项模板询问是否固化整体串联流程（对应单项设 `alreadySaved: true`）；存在多条歧义候选时停下列出请用户点选；未命中则按常规路径执行；
- 涉及多张表或同时涉及「小仓」与「乐心宜」美团后台时，拆成串行子任务依次执行，不混跑两个美团账号会话。

### 第 2 步：前置环境与登录体检
先在宿主机非沙箱环境通过 `ego-browser nodejs -e "await profiles()"` 探活（禁止在无 `User Data` 读写权限的沙箱中冷启动 `ego.exe`；若 `await profiles()` 挂起，严禁并发反复重试，应提示用户检查或重启宿主 EgoLite），再运行 `scripts/preflight.mjs` 检查目标环境与登录态：
- 命令不可用或过旧 → 按 [references/install-egolite.md](references/install-egolite.md) 引导安装或升级后停止；
- 默认资料即可直接打开海博与美团登录；仅当 `preflight.mjs` 返回 `stage: "meituan_profile_isolation_required"`（本次同时操作两个美团中台且未隔离资料）时，引导用户新建 1 个资料登录第二个美团账号；
- 跳到登录页或出现验证码 → `preflight.mjs` 会自动恢复并保留登录窗口（`keptWindow: true`）供用户人工登录，完成后从原任务接回。

### 第 3 步：参数补全、产出路径选择与一次问清
调用 `scripts/prefs.mjs`（`action: "resolve"`）合并用户配置（资料名、`outputRoot` 等）与当次口头参数，结合命中流程的 `requiredParams` 检查缺口：
- **产出路径引导**：若本次会产出文件且尚未配置 `outputRoot`（用户也没指定保存路径），调用 `prefs.mjs`（`action: "recommend-output-roots"`）并在同一次提问中列出推荐位置供用户选择（可顺便设为默认）：
  1. **桌面（推荐）**：`<桌面>/xc-ego产出/`
  2. **下载文件夹**：`<下载>/xc-ego产出/`
  3. **自定义目录**：用户指定任意本机路径
- 仍缺中台、门店名称、渠道、日期或目标修改数值等必填项时**合并一次问清**；
- 用户不知精确门店全称时，先在对应中台目标页面通过 `scripts/lib/hibo_controls.mjs` 的 `listAvailableStores` 拉取真实门店列表供勾选。

### 第 4 步：后台独立窗口执行与回读
- **通用交互原则**：能输入匹配的控件（门店、渠道、日期输入框、搜索框）一律优先直接输入匹配并等待结果稳定，不支持输入再展开点击或滚动；状态异常时用 `page.snapshot()` 看清现场后再操作。
- **海博中台操作**：按 [references/hibo-tables.md](references/hibo-tables.md) 通过 `ego-browser nodejs` 执行，可复用 `scripts/lib/hibo_controls.mjs` 提供的最小化后台窗口、404/无权限识别、清弹窗、业务单元切换与校验、输入优先的门店/渠道/日期回读、查询稳定等待与防重导导出原语；若报 `STORE_NOT_FOUND`，提示核对门店是否属于另一中台。
- **美团商家后台操作**：按 [references/meituan-sop.md](references/meituan-sop.md) 通过 `ego-browser nodejs` 执行，优先复用 `scripts/lib/meituan_controls.mjs` 提供的 `openMeituanTaskSpace`、`checkMeituanLoginState`、`readMeituanHeaderStore`、`verifyMeituanPoiPageReady` 与 `captureWriteSnapshot`；禁止在未核实目标门店上下文（或处于「全部门店」缺少 `wmPoiId`）的情况下直接读写单店设置。
- **写操作自主判断与提交**：无论是读操作还是改起送价、改配送费、改价、报名/取消活动等写操作，均允许固化并完整执行；当用户意图与变动参数齐备、目标门店上下文核验一致且页面状态正常时，先留存变更前快照，再执行提交并回读核验生效；仅在缺参、门店上下文不匹配、目标多义或页面状态异常时停下确认。

### 第 5 步：防重导提交与终态核验
- 提交导出前动态读取右上角操作人并写入 `_recovery.json`；若轮询超时或中断，**严禁重复点击导出**，必须凭 `_recovery.json` 回查原记录（以操作人 + 提交时间为核心锚点，必要时点弹层内「查询」刷新）；出现多条歧义记录时停下请用户指定。
- 经 `chrome://downloads/` 核对安全放行后，用 `scripts/lib/xlsx_check.mjs` 校验 `.xlsx` 工作簿结构；落盘至 `<用户选定或推荐的 outputRoot>/YYYYMMDD-HHmm_<中台>_<任务名>/` 并明确汇报完整保存路径、文件大小、查询行数与检查结果。

### 第 6 步：完工后流程固化询问与落盘
- **仅当本次为未命中固定流程的新操作且成功完成**时，按 [references/workflow-crystallization.md](references/workflow-crystallization.md) 调用 `scripts/workflows.mjs`（`action: "format-offer"`）在汇报末尾输出清晰的结构化 Markdown 询问卡片（不叠加默认参数提问）；
- **已命中对应固定流程跑完、任务失败中断或纯体检**，不再询问固化；
- 用户明确回复同意后，按选择调用 `scripts/workflows.mjs`（`action: "save"` 或 `"save-batch"`），只把固定路径与 `requiredParams` 参数槽位落盘至 `~/.xc-ego/workflows/`（禁止写死门店、渠道、日期、数值等业务参数），并原样输出返回的确认卡片。

## 跨平台脚本调用约定

`ego-browser nodejs` 不继承终端环境变量且不保证工作目录。调用 `scripts/` 下 `.mjs` 时，先把参数写入 UTF-8 临时 `request.json`，再用单行命令传入绝对路径（Windows 与 macOS 通用）：

- **PowerShell（Windows）**：
  ```powershell
  ego-browser nodejs -e "await (await import('file:///<skill_dir_forward_slashes>/scripts/<script>.mjs')).run('<abs_request_json_forward_slashes>')"
  ```
- **macOS / Linux / Git Bash**：
  ```bash
  ego-browser nodejs -e "await (await import('file://<abs_skill_dir>/scripts/<script>.mjs')).run('<abs_request_json>')"
  ```

`scripts/workflows.mjs` 与 `scripts/prefs.mjs` 同样优先使用上方 `ego-browser nodejs` 方式调用（无需本机另装 Node.js）；若本机已安装 `node`，也可直接执行 `node <skill_dir>/scripts/<script>.mjs --request <abs_request_json>`。

## 停止条件

- 本机未安装 `ego-browser` 或配置中显式指定的资料名不存在/重名；
- 同时操作两个美团中台账号但尚未划分独立资料（`meituan_profile_isolation_required`）；
- 目标后台要求登录、扫码或验证码；
- 本机固定流程匹配出现多条歧义候选、海博业务单元无法唯一识别，或导出记录存在多条歧义候选；
- 写操作缺少明确参数、存在目标歧义或页面状态异常，尚未获用户确认。
