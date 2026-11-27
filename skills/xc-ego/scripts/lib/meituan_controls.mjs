import { setTimeout as sleep } from 'node:timers/promises';
import { prepareTaskWindow } from './hibo_controls.mjs';
import { DEFAULT_PREFS_PATH, loadPreferences, normalizeBrand, resolveProfileName } from '../prefs.mjs';

export const MEITUAN_URLS = {
  root: 'https://shangoue.meituan.com/',
  home: 'https://shangoue.meituan.com/#/page/home',
  poiManage: 'https://shangoue.meituan.com/unif/poimanage#/poi-manage',
  startPrice: 'https://shangoue.meituan.com/unif/poimanage#/start-price-setting',
  deliveryFee: 'https://shangoue.meituan.com/unif/poimanage#/delivery-fee-setting-new',
  inviteList: 'https://shangoue.meituan.com/#/marketing/shangou/pc/marketingEntry/inviteList',
  adCenter: 'https://shangoue.meituan.com/#https://waimaieapp.meituan.com/ad/v1/pc',
  fallbackWaimaie: 'https://waimaie.meituan.com/',
};

export function classifyMeituanLoginSnapshot({
  url = '',
  title = '',
  bodyText = '',
  hasHashFrame = false,
  hasLoginForm = false,
  headerStore = '',
} = {}) {
  if (/passport|login|logon\/error/i.test(url)) {
    return { loggedIn: false, needsUserLogin: true, reason: 'login_url' };
  }
  if (
    hasLoginForm
    || (/登录|扫码|验证码|安全验证|滑块/.test(bodyText)
      && !hasHashFrame
      && !/平台消息|全部门店|营业中|门店管理/.test(bodyText))
  ) {
    return { loggedIn: false, needsUserLogin: true, reason: 'login_or_captcha_form' };
  }
  if (
    hasHashFrame
    || Boolean(String(headerStore || '').trim())
    || /平台消息|全部门店|营业中|配送方案|分店名称/.test(bodyText)
  ) {
    return { loggedIn: true, needsUserLogin: false, reason: 'authenticated_shell' };
  }
  if (/登录/.test(title)) {
    return { loggedIn: false, needsUserLogin: true, reason: 'login_title' };
  }
  return { loggedIn: false, needsUserLogin: true, reason: 'unconfirmed_shell' };
}

export function classifyMeituanPoiPageSnapshot({
  url = '',
  bodyText = '',
  hasBranchTable = false,
} = {}) {
  if (/wmPoiId参数异常|数据加载异常/.test(bodyText)) {
    return { mode: 'wmPoiId_error', ready: false, url };
  }
  if (hasBranchTable || /分店名称搜索|分店id|搜索结果（共\d+家）/.test(bodyText)) {
    return { mode: 'chain_list', ready: true, url };
  }
  if (/配送方案|起送价设置|顾客配送费设置|正常时段/.test(bodyText)) {
    return { mode: 'single_store', ready: true, url };
  }
  return { mode: 'unknown', ready: false, url };
}

export async function openMeituanTaskSpace(
  name,
  { brand, profileName, prefsPath = DEFAULT_PREFS_PATH } = {},
) {
  const normalizedBrand = normalizeBrand(brand);
  let targetProfileName = profileName ? String(profileName).trim() : '';
  if (!targetProfileName) {
    if (!normalizedBrand) {
      throw new Error('MEITUAN_BRAND_REQUIRED: 打开美团资料窗口必须指定 brand（小仓 / 乐心宜）或 profileName');
    }
    const prefs = await loadPreferences(prefsPath);
    targetProfileName = resolveProfileName(prefs, { target: 'meituan', brand: normalizedBrand });
  }
  const allProfiles = await globalThis.profiles();
  const matches = allProfiles.filter((item) => item.name === targetProfileName);
  if (matches.length !== 1) {
    throw new Error(`PROFILE_NOT_UNIQUE: Ego 中未找到唯一名为「${targetProfileName}」的美团资料`);
  }
  const task = await globalThis.taskSpace(name, { profileId: matches[0].id });
  const page = task.page('p1');
  try {
    await prepareTaskWindow(task, page);
    return { task, page, profile: matches[0], brand: normalizedBrand };
  } catch (error) {
    await task.finish({ keep: [] }).catch(() => {});
    throw error;
  }
}

export async function readMeituanHeaderStore(page) {
  const headerStore = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const ignoreRe = /小闪|编辑图片|下载图片|使用图片|平台消息|在线联系|全部未读|查看详情|转人工|加载更多|新对话|全部技能|经营快报|滞销分析|评价回复|商品信息违规|营业中|退出|帮助|反馈/;
    const findInDoc = (doc) => {
      if (!doc) return '';
      const candidates = [...doc.querySelectorAll('header span, header div, [class*="header"] span, [class*="header"] div, [class*="poi"] span, [class*="store"] span, [class*="shop"] span')]
        .filter(visible)
        .map((el) => {
          const r = el.getBoundingClientRect();
          const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          return { text, top: r.top, left: r.left, width: r.width, children: el.children.length };
        })
        .filter((x) => x.text && x.text.length >= 2 && x.text.length <= 40 && x.top >= 0 && x.top < 100 && !ignoreRe.test(x.text));

      const exactAll = candidates.find((x) => x.text === '全部门店');
      if (exactAll) return '全部门店';
      const leafStoreLike = candidates.find((x) => x.children === 0 && /[（(].+[)）]|店$/.test(x.text) && !/门店管理|分店/.test(x.text));
      if (leafStoreLike) return leafStoreLike.text;
      const storeLike = candidates.find((x) => /[（(].+[)）]|店$/.test(x.text) && !/门店管理|分店/.test(x.text));
      if (storeLike) return storeLike.text;
      const leaf = candidates.find((x) => x.children === 0 && !/^\d+$/.test(x.text) && !/^xc[a-z0-9]+$/i.test(x.text));
      return leaf ? leaf.text : '';
    };

    const topStore = findInDoc(document);
    if (topStore) return topStore;
    const frame = document.querySelector('iframe#hashframe, iframe[name="hashframe"]');
    let frameDoc = null;
    try {
      frameDoc = frame?.contentDocument || null;
    } catch {
      frameDoc = null;
    }
    return findInDoc(frameDoc);
  });
  return {
    headerStore: headerStore || '',
    isAllStores: headerStore === '全部门店',
  };
}

export async function checkMeituanLoginState(page, { timeoutMs = 15000 } = {}) {
  await page.goto(MEITUAN_URLS.root, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let shellFirstSeenAt = 0;
  let lastSnapshot = null;
  let lastClassified = null;

  do {
    const url = await page.url();
    const domSnap = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const hasLoginForm = [...document.querySelectorAll('input[type="password"],input[placeholder*="密码"],input[placeholder*="验证码"]')]
        .some(visible);
      const hasHashFrame = Boolean(document.querySelector('iframe#hashframe,iframe[name="hashframe"]'));
      return {
        title: document.title || '',
        bodyText: (document.body?.innerText || '').slice(0, 800),
        hasLoginForm,
        hasHashFrame,
      };
    });
    const { headerStore } = await readMeituanHeaderStore(page);
    lastSnapshot = { url, ...domSnap, headerStore };
    lastClassified = classifyMeituanLoginSnapshot(lastSnapshot);
    if (lastClassified.reason === 'authenticated_shell') {
      if (headerStore) break;
      if (!shellFirstSeenAt) shellFirstSeenAt = Date.now();
      if (Date.now() - shellFirstSeenAt >= 2500) break;
    } else if (lastClassified.reason !== 'unconfirmed_shell') {
      break;
    }
    await sleep(250);
  } while (Date.now() < deadline);

  return {
    url: lastSnapshot?.url || '',
    title: lastSnapshot?.title || '',
    loggedIn: Boolean(lastClassified?.loggedIn),
    needsUserLogin: Boolean(lastClassified?.needsUserLogin),
    reason: lastClassified?.reason || 'unconfirmed_shell',
    headerStore: lastSnapshot?.headerStore || '',
    isAllStores: lastSnapshot?.headerStore === '全部门店',
  };
}

export function validateMeituanPoiContext({
  snap = {},
  headerStore = '',
  expectedStore = '',
  requireSingleStore = Boolean(expectedStore),
} = {}) {
  const classified = classifyMeituanPoiPageSnapshot(snap);

  if (classified.mode === 'wmPoiId_error') {
    throw new Error(
      'MEITUAN_WMPOIID_REQUIRED: 当前美团账号处于「全部门店」连锁视角，直达该页面缺少 wmPoiId；请先经 #/poi-manage 搜索目标分店或切换顶部门店后再进入',
    );
  }
  if (!classified.ready) {
    throw new Error(
      `MEITUAN_PAGE_NOT_READY: 美团门店页面未就绪或无法识别页面状态 (${snap.frameUrl || snap.url || 'unknown'})`,
    );
  }

  const storeNorm = String(expectedStore || '').trim();
  if ((storeNorm || requireSingleStore) && classified.mode !== 'single_store') {
    throw new Error(
      `MEITUAN_CHAIN_LIST_ACTIVE: 当前仍停留在连锁分店列表页，尚未进入${storeNorm ? `目标门店「${storeNorm}」的` : ''}单店设置页`,
    );
  }

  if (storeNorm) {
    if (!headerStore || headerStore === '全部门店') {
      throw new Error(
        `MEITUAN_STORE_UNVERIFIED: 期望操作门店「${storeNorm}」，但当前页面未能确认单店上下文（顶栏门店：「${headerStore || '未识别'}」）；请从商家端主页或 #/poi-manage 切换并确认目标门店后再操作`,
      );
    }
    if (!(headerStore.includes(storeNorm) || storeNorm.includes(headerStore))) {
      throw new Error(
        `MEITUAN_STORE_MISMATCH: 期望操作门店「${storeNorm}」，但当前美团会话门店为「${headerStore}」；已阻断以防误改其他门店`,
      );
    }
  }

  return {
    url: snap.url || '',
    ...(snap.frameUrl ? { frameUrl: snap.frameUrl } : {}),
    mode: classified.mode,
    ready: classified.ready,
    headerStore,
  };
}

export async function verifyMeituanPoiPageReady(
  page,
  { expectedStore = '', headerStore = '', requireSingleStore = Boolean(expectedStore), timeoutMs = 8000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastSnap = null;
  let detectedHeader = '';

  do {
    lastSnap = await page.evaluate(() => {
      const frame = document.querySelector('iframe#hashframe, iframe[name="hashframe"]');
      let frameDoc = null;
      let frameUrl = '';
      try {
        frameDoc = frame?.contentDocument || null;
        frameUrl = frame?.contentWindow?.location?.href || frame?.getAttribute('src') || '';
      } catch {
        frameDoc = null;
      }
      const outerText = (document.body?.innerText || '').slice(0, 1500);
      const frameText = (frameDoc?.body?.innerText || '').slice(0, 1500);
      const bodyText = frameText ? `${frameText}\n${outerText}`.slice(0, 2000) : outerText;
      const roots = frameDoc ? [frameDoc, document] : [document];
      const hasBranchTable = roots
        .flatMap((root) => [...root.querySelectorAll('tbody tr, table tr')])
        .some((row) => /^\s*\d{6,}\s/.test(String(row.innerText || '').trim()));
      return {
        url: location.href,
        frameUrl,
        bodyText,
        hasBranchTable,
      };
    });
    detectedHeader = headerStore || (await readMeituanHeaderStore(page)).headerStore;
    const classified = classifyMeituanPoiPageSnapshot(lastSnap);
    if (classified.mode === 'wmPoiId_error') break;
    if (classified.ready && (!expectedStore || (detectedHeader && detectedHeader !== '全部门店'))) {
      break;
    }
    if (Date.now() >= deadline) break;
    await sleep(250);
  } while (Date.now() < deadline);

  return validateMeituanPoiContext({
    snap: lastSnap,
    headerStore: detectedHeader,
    expectedStore,
    requireSingleStore,
  });
}

export async function captureWriteSnapshot(page, { brand = '', storeName = '', action = '', extra = {} } = {}) {
  const { headerStore } = await readMeituanHeaderStore(page).catch(() => ({ headerStore: '' }));
  const pageSnap = await page.evaluate(() => {
    const frame = document.querySelector('iframe#hashframe, iframe[name="hashframe"]');
    let frameDoc = null;
    let frameUrl = '';
    try {
      frameDoc = frame?.contentDocument || null;
      frameUrl = frame?.contentWindow?.location?.href || frame?.getAttribute('src') || '';
    } catch {
      frameDoc = null;
    }
    const frameText = (frameDoc?.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const docText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    return {
      url: location.href,
      ...(frameUrl ? { frameUrl } : {}),
      title: document.title || '',
      bodySnippet: (frameText || docText).slice(0, 600),
    };
  });
  return {
    capturedAt: new Date().toISOString(),
    brand,
    storeName,
    action,
    headerStore,
    ...pageSnap,
    ...extra,
  };
}
