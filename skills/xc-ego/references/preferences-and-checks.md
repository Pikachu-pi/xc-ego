# 参数补全、本机环境配置与 5 项必要检查

## 一、个人环境配置（`~/.xc-ego/preferences.json`）与本机流程库

所有个人环境配置保存在用户主目录 `~/.xc-ego/preferences.json`（与 Skill 目录隔离）；已固化的固定流程保存在 `~/.xc-ego/workflows/`（详见 [workflow-crystallization.md](workflow-crystallization.md)）。`preferences.json` 结构如下：

```json
{
  "version": 1,
  "defaultBrand": null,
  "profiles": {
    "default": "采集",
    "hibo": "采集",
    "meituan": {
      "小仓": "小仓",
      "乐心宜": "乐心宜"
    }
  },
  "outputRoot": null,
  "storeGroups": {},
  "tableDefaults": {}
}
```

### 参数合并与询问规则
1. **合并优先级**：当次用户口头指定 > 用户主动设置的 `tableDefaults[tableKey][field]` > 全局环境配置（`defaultBrand`、`profiles`、`outputRoot`）> 缺失。
2. **一次问清**：合并后仍缺少的中台、门店名称、渠道、日期或修改数值等必填项，在一条消息中一次问完；用户不知海博门店全称时，先确定中台，再在目标页面通过 `scripts/lib/hibo_controls.mjs` 的 `listAvailableStores` 拉取该中台真实门店列表。
3. **绝对日期与自动固化禁止**：`2026-11-26` 等具体日期严禁写入默认配置或固定流程；**禁止静默记录用户筛选历史或自动写入默认参数**，所有流程固化完全由用户在操作成功后按固定框架自主选择是否落盘（且只固路径，不写死门店/渠道/日期等业务参数）。

### 环境体检与配置脚本调用契约
按 `SKILL.md`「跨平台脚本调用约定」传入 `request.json`：
- **`scripts/preflight.mjs`**：支持 `target`（`"hibo"` / `"meituan"` / `"both"`）、`brand`（`"小仓"` / `"乐心宜"`，可选）、`checkLogin`（布尔值，是否打开网页校验登录态），以及可选资料覆盖 `profileName`（单平台时生效）或 `hiboProfileName` / `meituanProfileName`。返回 `stage`：`ready`、`egolite_runtime_missing`、`profile_missing`、`profile_ambiguous`、`login_required`。
- **`scripts/prefs.mjs`**：支持 `action`：
  - `"get"`：读取 `~/.xc-ego/preferences.json`；
  - `"resolve"`：传 `table`、`target`、`provided`、`requiredFields`，返回合并后的 `resolved`、`missing` 与 `sources`（支持标准英文键 `brand`、`stores`、`channel`、`date`、`profileName`、`outputRoot` 及固化流程中的中文 `requiredParams` 别名如 `中台`、`门店名称`、`渠道`、`日期`，自动映射归口）；
  - `"set-default"` / `"clear-default"`：按 `scope`（`"global"` 或 `"table"`）、`table`、`field`、`value` 显式维护用户授权的配置项（自动拦截绝对日期）；
  - `"build-output-dir"`：按 `brand`、`taskName`（及可选 `outputRoot`）创建 `YYYYMMDD-HHmm_<中台>_<任务名>` 产出目录。

---

## 二、5 项底线必要检查（不查自定义导出字段）

**跳过所有自定义导出列清单与列顺序校验**，但每次执行必须守住以下 5 项检查：

| 检查项 | 具体验证内容 | 失败时处理 |
|---|---|---|
| 1．环境、资料与登录门禁 | `ego-browser` 可执行；海博 `采集` 资料与美团对应中台资料（`小仓` / `乐心宜`）唯一存在；页面未跳转登录或验证码 | 立即停止，引导安装/建资料或保留窗口请用户人工登录后接回 |
| 2．中台与业务单元校验 | 海博切换并核对顶部业务单元（`小仓` → `小仓生活`，`乐心宜` → `小仓生活乐心宜`/唯一含乐心宜项；若目标页顶栏为静态不可切换，先在首页核对目标中台后再进入目标页）；美团核对所用资料与目标中台一致 | 找不到或出现多个模糊候选时立即停止并展示候选项 |
| 3．筛选重置与回读确认 | 清掉「知道了」与推广弹窗，点「重置」确认已选标签归零；门店、渠道选中后**回读页面实际选中态**；非全局表禁止留空门店 | 找不到门店时报错并提示检查该门店是否归属另一中台（小仓 / 乐心宜）；重名歧义则列出候选 |
| 4．动态操作人防重导 | 动态读取页面右上角操作人姓名，点击导出前写入 `_recovery.json`；轮询超时或中断时只凭原操作人、中台与时间戳回查导出记录，绝不重复点导出 | 多条同名记录无法唯一区分时停下请用户指定 |
| 5．下载终态与 `.xlsx` 验包 | 在 `chrome://downloads/` 确认下载完成且无安全拦截；用 `scripts/lib/xlsx_check.mjs` 验证扩展名、非空体积及 ZIP 工作簿必备文件（`[Content_Types].xml`、`xl/workbook.xml`），同时回报页面查询行数 | 任一校验失败则阻断交付并保留真实报错 |
