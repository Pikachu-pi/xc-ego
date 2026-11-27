# 参数补全、产出路径选择与 5 项底线检查

## 一、个人环境配置（`~/.xc-ego/preferences.json`）与产出目录

所有个人环境配置保存在用户主目录 `~/.xc-ego/preferences.json`（与公共 Skill 目录隔离）；已固化的固定流程保存在 `~/.xc-ego/workflows/`（详见 [workflow-crystallization.md](workflow-crystallization.md)）。`preferences.json` 默认结构如下：

```json
{
  "version": 1,
  "defaultBrand": null,
  "profiles": {
    "default": null,
    "hibo": null,
    "meituan": {}
  },
  "outputRoot": null,
  "storeGroups": {},
  "tableDefaults": {}
}
```

> **零配置即用**：`profiles` 各项均为 `null` / `{}` 时，脚本自动使用 EgoLite **默认资料**；仅当美团同时涉及两个不同中台账号（如小仓与乐心宜并存）或用户主动绑定自定义资料名时，才需要在 `profiles` 中填写映射。

### 产出路径选择与推荐项
1. **不默认写入 Skill 目录**：导出文件与截图保存至 `<outputRoot>/YYYYMMDD-HHmm_<中台>_<任务名>/`。
2. **首次选择与推荐项**：当 `outputRoot` 未配置且用户未在当次指令中指定保存位置时，调用 `scripts/prefs.mjs`（`action: "recommend-output-roots"`）获取本机真实推荐路径，连同其他缺失参数一次询问用户（并询问是否设为后续默认位置）：
   - **桌面（推荐）**：`<桌面>/xc-ego产出/`
   - **下载文件夹**：`<下载>/xc-ego产出/`
   - **当前工作区目录**（若存在工作区）：`<工作区>/xc-ego产出/`
   - **自定义路径**：用户提供的任意本机文件夹
3. 若用户明确回复“按默认/你决定”，则保存到 **桌面 `xc-ego产出/`** 并在完工汇报中给出完整绝对路径。

### 参数合并与询问规则
1. **合并优先级**：当次用户口头指定 > 用户主动设置的 `tableDefaults[tableKey][field]` > 全局环境配置（`defaultBrand`、`profiles`、`outputRoot`）> 缺失。
2. **一次问清**：合并后仍缺少的中台、门店名称、渠道、日期、修改数值或首次 `outputRoot` 等必填项，在一条消息中一次问完；用户不知海博门店全称时，先确定中台，再在目标页面通过 `scripts/lib/hibo_controls.mjs` 的 `listAvailableStores` 拉取真实门店列表。
3. **绝对日期与自动固化禁止**：`2026-11-26` 等具体日期严禁写入默认配置或固定流程；**禁止静默记录用户筛选历史或自动写入默认参数**，所有流程固化完全由用户在操作成功后自主选择落盘。

### 环境体检与配置脚本调用契约
按 `SKILL.md`「跨平台脚本调用约定」传入 `request.json`：
- **`scripts/preflight.mjs`**：支持 `target`（`"hibo"` / `"meituan"` / `"both"`）、`brand` / `brands`（可选）、`checkLogin`（布尔值，是否打开网页校验登录态），以及可选资料覆盖 `profileName` / `hiboProfileName` / `meituanProfileName`。返回 `stage`：`ready`、`egolite_runtime_missing`、`profile_missing`、`profile_ambiguous`、`meituan_profile_isolation_required`、`login_required`。
- **`scripts/prefs.mjs`**：支持 `action`：
  - `"get"`：读取 `~/.xc-ego/preferences.json`；
  - `"recommend-output-roots"`：返回本机桌面、下载等推荐保存路径列表；
  - `"resolve"`：传 `table`、`target`、`provided`、`requiredFields`，返回合并后的 `resolved`、`missing`、`sources` 与 `recommendedOutputRoots`（缺失 `outputRoot` 时）；
  - `"set-default"` / `"clear-default"`：按 `scope`（`"global"` 或 `"table"`）、`table`、`field`、`value` 显式维护用户授权的配置项（自动拦截绝对日期）；
  - `"build-output-dir"`：按 `brand`、`taskName`（及 `outputRoot`，未传则落到桌面 `xc-ego产出/`）创建 `YYYYMMDD-HHmm_<中台>_<任务名>` 产出目录。

---

## 二、5 项底线必要检查（不查自定义导出字段）

**跳过所有自定义导出列清单与列顺序校验**，但每次执行必须守住以下 5 项检查：

| 检查项 | 具体验证内容 | 失败时处理 |
|---|---|---|
| 1．环境、资料与登录门禁 | `ego-browser` 可执行；默认资料或用户绑定资料唯一可用（多美团中台时确认已分资料）；页面未跳转登录或验证码 | 立即停止，引导安装、分资料或保留窗口请用户人工登录后接回 |
| 2．中台与业务单元校验 | 海博切换并核对顶部业务单元（支持小仓、乐心宜及任意用户指定单元；静态顶栏先在首页切好再进入）；美团核对当前账号与目标中台一致 | 找不到或出现多个模糊候选时立即停止并展示候选项 |
| 3．筛选重置与回读确认 | 清掉挡路弹窗，必要时重置已有筛选；**能输入的控件优先输入匹配**，门店、渠道、日期选中后**回读页面实际选中态** | 找不到门店时报错并提示检查是否属于另一中台；重名歧义则列出候选 |
| 4．动态操作人防重导 | 动态读取页面右上角操作人姓名，点击导出前写入 `_recovery.json`；轮询超时或中断时只凭操作人 + 时间锚点回查原记录，绝不重复点导出 | 多条同名同秒记录无法唯一区分时停下请用户指定 |
| 5．下载终态与 `.xlsx` 验包 | 在 `chrome://downloads/` 确认下载完成且无安全拦截；用 `scripts/lib/xlsx_check.mjs` 验证扩展名、非空体积及 ZIP 工作簿必备文件（`[Content_Types].xml`、`xl/workbook.xml`），同时回报页面查询行数 | 任一校验失败则阻断交付并保留真实报错 |
