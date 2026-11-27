# 美团商家后台操作 SOP

美团侧不同中台（如「小仓」与「乐心宜」）**共用同一套入口网址、页面路径与操作流程**。若仅操作单个美团中台，直接使用 EgoLite **默认资料**登录即可；只有同一台电脑需要**同时保持两个不同美团中台账号登录**时，才需要用两个独立资料隔离（严禁在同一窗口或同一资料下混切两个账号）。

---

## 一、常用美团后台公开入口

> 仅使用公共入口，禁止在文档或脚本中写入个人 `token`、`acctId`、`bsid`、`device_uuid` 等会话凭证。

- **主入口（美团闪购商家端）**：`https://shangoue.meituan.com/`
- **常用功能页**：
  - 商家端首页：`https://shangoue.meituan.com/#/page/home`
  - 门店管理：`https://shangoue.meituan.com/unif/poimanage#/poi-manage`
  - 起送价设置：`https://shangoue.meituan.com/unif/poimanage#/start-price-setting`
  - 配送费设置：`https://shangoue.meituan.com/unif/poimanage#/delivery-fee-setting-new`
  - 活动报名 / 邀请列表：`https://shangoue.meituan.com/#/marketing/shangou/pc/marketingEntry/inviteList`
  - 推广 / 广告中心：`https://shangoue.meituan.com/#https://waimaieapp.meituan.com/ad/v1/pc`
- **备用入口（美团外卖商家版）**：`https://waimaie.meituan.com/`

---

## 二、标准执行流程与可复用原语（`scripts/lib/meituan_controls.mjs`）

> **连锁账号与串店风险提醒**：美团连锁账号常处于连锁视角。当顶栏显示 **`全部门店`** 时，直接打开单店子页可能报 **`wmPoiId参数异常`**；当顶栏停留在上一次 Cookie 记忆的某一家分店时，直接跳转又会命中那家隐式门店，存在极高**读错店 / 改错店**风险。因此任何单店页面操作前**必须核对或切换门店上下文**。

可复用的美团底层原语（`scripts/lib/meituan_controls.mjs`）：
- `openMeituanTaskSpace(name, { brand, profileName })`：按配置或默认资料打开最小化后台窗口与桌面视口；
- `checkMeituanLoginState(page)`：感知 `#hashframe` 与顶栏门店状态校验登录态，避免主文档 AI 助手文案干扰误判；
- `readMeituanHeaderStore(page)`：读取顶栏当前门店（区分 `全部门店` 与具体单店）；
- `verifyMeituanPoiPageReady(page, { expectedStore })`：通用化穿透同源 `#hashframe` 校验单店页面就绪（适用于起送价、配送费、商品、活动、评价等任意单店页），在 `MEITUAN_PAGE_NOT_READY`、`MEITUAN_WMPOIID_REQUIRED`、`MEITUAN_CHAIN_LIST_ACTIVE`、`MEITUAN_STORE_UNVERIFIED` 与 `MEITUAN_STORE_MISMATCH` 时 fail-closed 阻断；
- `captureWriteSnapshot(page, { brand, storeName, action })`：记录写操作前后页面 URL（含 `#hashframe` 地址）、顶栏门店与内容摘要快照。

执行步骤：

1. **资料与中台隔离**
   - 先确定目标中台 `brand`（如 `小仓` 或 `乐心宜`）；如果只操作单一中台，可直接使用 EgoLite 默认资料；
   - 若同一请求或本机配置同时涉及两个美团中台且指向了同一个资料，立即停下提示用户新建 1 个资料分别登录，**拆成两个串行子任务**依次执行，严禁串号。
2. **登录态与风控门禁**
   - 使用 `checkMeituanLoginState(page)` 检查是否跳到登录页、`/logon/error/`、出现密码/验证码表单或未就绪壳页面；
   - 遇登录或人机验证立即停止并保留当前 `taskSpaceId`，提示用户在对应资料窗口人工完成后接回。
3. **门店上下文核对（输入优先选店，防 `wmPoiId` 异常与串店）**
   - 进入单店设置页前先读 `readMeituanHeaderStore(page)`；若当前为 `全部门店` 或不是目标门店，须先经 `#/poi-manage` **在分店搜索框直接输入门店名查询**并进入目标分店，或先在顶栏输入/切换至目标门店；
   - 进入目标页面后调用 `verifyMeituanPoiPageReady(page, { expectedStore })` 核验当前门店与页面就绪（若直达子页无外层顶栏导致 `MEITUAN_STORE_UNVERIFIED`，须退回商家端首页或 `#/poi-manage` 进入），未通过严禁读写。
4. **只读与写操作处理（写前写后双快照）**
   - **只读操作**（查起送价、配送费、门店状态、活动列表、导出或截图）：核对中台与门店上下文后直接执行；若当前账号找不到门店，提醒检查是否属于另一中台；
   - **写操作**（修改起送价、配送费、报名/退出活动、改价/上下架）：**允许固化为本机固定流程**；在意图与变动参数明确、门店上下文经 `verifyMeituanPoiPageReady` 核验通过且页面状态正常时，先调用 `captureWriteSnapshot` 记录变更前状态，再执行提交，提交后再次调用 `captureWriteSnapshot` 并回读页面核验生效；仅在缺参、目标歧义、门店不匹配或页面状态异常时停下确认。
5. **缺参、产出路径与固化选择**
   - 缺中台、门店、日期、修改值或首次未定 `outputRoot` 时，先查 `~/.xc-ego/preferences.json`，剩余缺项（连同推荐保存目录）一次问清；
   - 单次未固化新操作成功后，按 [workflow-crystallization.md](workflow-crystallization.md) 输出 Markdown 询问卡片，不自动固化。
6. **产出保存**
   - 导出的表格或截图统一保存至 `<用户选定或推荐的 outputRoot>/YYYYMMDD-HHmm_<中台>_<任务名>/`（未配置时优先推荐桌面 `xc-ego产出/`）；`.xlsx` 文件须经 `scripts/lib/xlsx_check.mjs` 验包后再汇报完整路径。
