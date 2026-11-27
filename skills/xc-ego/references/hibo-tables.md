# 海博中台报表与操作手册

- **海博入口**：`https://zt.hiboos.com/index.html`
- **双中台共用入口**：小仓与乐心宜共用同一个 EgoLite 资料（默认 `采集`）与页面流程，在页内按 `brand`（`小仓` / `乐心宜`）切换并校验顶部业务单元。
- **执行策略**：不预置固定报表清单；所有海博报表导出与页面操作均按下方 SOP 通过 `ego-browser nodejs` 执行，并复用 `scripts/lib/hibo_controls.mjs` 与 `scripts/lib/xlsx_check.mjs` 的通用底层原语；单次新操作跑通后，由用户按需选择固化到 `~/.xc-ego/workflows/`（详见 [workflow-crystallization.md](workflow-crystallization.md)）。

---

## 一、海博中台标准操作 SOP

### 1. 适用范围
覆盖海博后台任意页面与报表操作，包括但不限于：订单数据/订单日报表、商品与价格管理、毛利分析、效期管理、门店商品销售、营销活动配置与批量导出等。

### 2. 双中台与字段规则
- **不校验自定义导出字段**：各用户导出列设置不同，跳过导出列清单与列顺序核对。
- **业务单元校验**：
  - `brand: "小仓"` 核对并切换到 `小仓生活`；
  - `brand: "乐心宜"` 优先匹配 `小仓生活乐心宜` / `乐心宜`（或唯一含「乐心宜」非仓店选项，多候选时停下列出请用户指定）；
  - 若目标页面顶栏业务单元为静态不可切换状态（例如仓店汇总页），先在 `#/home` 切到并校验用户目标中台，再进入目标页面并核对静态顶栏；
  - 切换业务单元后若页面自动跳回 `#/home`，须重新导航回目标路由并复核业务单元。
- **跨中台门店防呆**：门店仅归属对应中台；若找不到目标门店（`STORE_NOT_FOUND`），优先核对该门店是否属于另一个中台（小仓 / 乐心宜）。
- **动态操作人**：导出前动态读取页面右上角当前登录操作人姓名，用于筛选本人导出的记录。

### 3. 标准执行流程（6 步）
1. **后台隔离窗口**：使用 `采集`（或用户配置）资料打开独立 `taskSpace`，立即最小化窗口并设置桌面视口与后台焦点模拟（`Emulation.setFocusEmulationEnabled`）。
2. **登录与业务单元校验**：打开目标页面后核对登录态、切换并校验对应中台（小仓 / 乐心宜）业务单元，清掉「知道了」与推广等遮挡弹窗。
3. **筛选重置与回读**：点击「重置」并确认已选标签归零后，按用户要求选中门店/仓店、渠道与日期范围，并**回读实际选中态**。
4. **查询确认**：点击「查询」等待表格加载稳定，读取分页总行数（确认非报错且知悉是否空表）。
5. **防重导导出与验包落盘**：提交导出前将操作人、中台、业务单元与时间戳写入 `_recovery.json`；经「导出记录」等待完成、`chrome://downloads/` 核对安全放行后，调用 `verifyXlsxFile` 校验工作簿结构，保存至 `产出文件/YYYYMMDD-HHmm_<中台>_<任务名>/`（超时或中断时只凭 `_recovery.json` 回查原记录，严禁重新点击导出）。
6. **写操作自主判断与按需固化**：涉及修改商品、价格、库存或活动状态时，若用户意图与变动参数齐备且页面状态正常，可直接执行提交并回读核验（仅在缺参、多义或页面异常时停下确认）；若本次为未固化新操作且成功完成，完工后按 [workflow-crystallization.md](workflow-crystallization.md) 询问是否固化至 `~/.xc-ego/workflows/`。

---

## 二、可复用的底层工具

编写或执行海博 `ego-browser nodejs` 脚本时，可直接导入以下通用原语：

- **`scripts/lib/hibo_controls.mjs`**：
  - `openMinimizedTaskSpace` / `prepareTaskWindow` / `navigateKeepingViewport`：最小化窗口、桌面视口与焦点模拟
  - `readHiboIdentity` / `dismissObstructions` / `closeExportRecords` / `detectHiboPageError`：读取操作人与业务单元、清理遮挡弹窗、识别 404/无权限页
  - `ensureBusinessUnit` / `pickOrgCandidate` / `prepareReportPage`：切换并校验小仓/乐心宜业务单元、打开目标页签（自动拦截 404 与无权限页面）
  - `listAvailableStores` / `selectStoresAndVerify` / `selectChannelAndVerify`：滚动/遍历级联拉取完整门店清单、重置并回读门店与渠道（注意：`selectStoresAndVerify` 默认 `resetForm: true` 会触发整表「重置」，必须在选渠道与日期**之前**调用，或传 `{ resetForm: false }` 仅清门店标签；若页面无「重置」按钮会自动退回逐个叉号清理）
  - `selectDateRangeAndVerify` / `verifyDateRangeInputs`：快捷日期或日历起止日期选择（含 ≥15 秒动画等待与 `/确\s*定/` 按钮处理）并回读核验
  - `queryTableAndReadCount`：执行查询并稳定读取分页总行数（同时兼容标准 `<table>` 页与如订单列表等卡片列表页）
  - `submitExportAndRecover` / `resumeFromRecovery`：写入 `_recovery.json` 防重导提交、轮询导出记录并安全下载
- **`scripts/lib/xlsx_check.mjs`**：
  - `verifyXlsxFile`：纯 Node 校验 `.xlsx` 扩展名、非空体积及 ZIP 工作簿必备结构（`[Content_Types].xml`、`xl/workbook.xml`）

最小调用约定示例：

```js
const report = {
  route: '/xcosOrder/ordermanage/list', // 目标 hash 路由（示例：订单列表）
  menuText: '订单数据导出',             // 可选：下拉导出菜单项文本
  recordButtons: ['导出记录'],          // 可选：记录入口按钮，默认 ['导出记录']
  recordMenuText: undefined,            // 可选：若记录按钮是下拉菜单，则传菜单项文本
  recordHints: ['订单'],                // 可选：导出记录行匹配关键词，留空则仅按操作人与时间过滤
};
const identity = await prepareReportPage(page, report, { brand });
await selectStoresAndVerify(page, '门店', stores, { brand }); // 须先于渠道和日期调用
await selectChannelAndVerify(page, '渠道', channel);
await selectDateRangeAndVerify(page, { startDate: '2026-11-23', endDate: '2026-11-25' });
const queryResult = await queryTableAndReadCount(page);
await verifyDateRangeInputs(page, { startDate: '2026-11-23', endDate: '2026-11-25' });
await submitExportAndRecover(page, task, {
  reportKey: 'order-list',
  report,
  brand,
  brandBusinessUnit: identity.brandBusinessUnit || '',
  businessUnit: identity.businessUnit,
  operatorNames: identity.operatorNames,
  recoveryPath,
  destinationPath,
});
```

---

## 三、海博常见弹窗与踩坑避雷清单

1. **中途突发空闲弹窗与推广弹窗**（「系统检测到您较长时间未操作页面」/「知道了」、「报名开通」）：页面加载后会二次弹出；打开菜单、切组织、点查询/导出及轮询等待前均先清理弹窗，遇到菜单展开失败时清弹窗后重试一次。其中「知道了」提示音弹窗受浏览器用户手势限制，必须通过真实鼠标点击（`page.mouse.click`）才能关闭，合成 DOM `.click()` 无效。
2. **最小化窗口动画冻结与坐标偏移**：打开 `taskSpace` 最小化窗口及每次导航后，须开启并保持 `Emulation.setFocusEmulationEnabled({ enabled: true })`，避免下拉菜单停在动画首帧；弹窗按钮、关闭图标与下载图标优先在 DOM 中唯一绑定后直接 `.click()`，减少对原生鼠标坐标的依赖。
3. **导出前「自定义导出字段」提示弹窗**：部分页面点击导出商品时会弹出该提示框且没有「确定」按钮，必须点击「不设置，继续导出」才会真正创建后台导出任务。
4. **等待导出时「导出记录」弹层意外关闭**：轮询期间若记录弹层消失，应重新打开「导出记录」继续按原操作人与时间戳查任务，严禁重新点击导出。
5. **静态业务单元顶栏页面**：若目标页顶栏显示静态业务单元且不可直接点击切换（`staticHeaderOrg`），须先在 `#/home` 切到目标中台并校验，再进入目标页核对静态顶栏；超时 `resume` 时同样须先按记录的 `brandBusinessUnit` 切回原中台。
6. **切换业务单元跳回首页与数字 ID 过渡态**：`#/home` 初载时会短暂显示组织数字 ID，须等待其解析为非纯数字后再核对；切完业务单元若自动跳回 `#/home`，须重开目标路由并复核。
7. **重置残留门店标签与 `+N` 折叠计数**：点击「重置」后若仍残留已选门店标签，需逐个点击标签叉号清除；统计已选门店数时必须排除 `+N` 折叠提示节点。
8. **日期选择器「确 定」含空格与查询后重置**：确认按钮文本可能含空格，须按 `/确\s*定/` 匹配，直接按 `Esc` 会回滚回默认近 7 天；选完日期后须确认 `.hibo-picker-dropdown` 已关闭以免遮挡按钮，点击「查询」后还须二次回读日期输入框防止被页面重置。
9. **最小化窗口下的日期选择器展开等待超时（≥ 15 秒）**：即使已开启 `Emulation.setFocusEmulationEnabled({ enabled: true })`，最小化 Chromium 仍可能将 `requestAnimationFrame` 降频至约 1Hz，导致毛利分析等页面的 `rc-motion` 多帧动画日历弹层挂载耗时接近 5 秒；等待日期弹层展开与日期格可见的超时阈值必须设为 **≥ 15 秒**（不可使用 5 秒短超时）。
10. **导出交付后关闭「导出记录」弹层容错**：下载文件并完成 `chrome://downloads/` 与 `.xlsx` 结构验包后，应先将 `_recovery.json` 标记为已交付（`delivered`），再通过 DOM 直接 `.click()` 关闭「导出记录」弹层；若弹层在下载完成后已自动关闭或重渲染消失，按「已关闭」处理，**严禁将收尾关弹窗异常误判为任务失败而触发重复导出**。
