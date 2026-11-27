import fs from 'node:fs/promises';
import { prepareTaskWindow, restoreTaskWindowForUser } from './lib/hibo_controls.mjs';
import { checkMeituanLoginState } from './lib/meituan_controls.mjs';
import { DEFAULT_PREFS_PATH, loadPreferences, normalizeBrand, resolveProfileName } from './prefs.mjs';

const HIBO_HOME = 'https://zt.hiboos.com/index.html#/home';

async function checkHiboLogin(page, brand) {
  await page.goto(HIBO_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => {
    const names = [...document.querySelectorAll('.header-dropdown')]
      .filter((el) => el.getClientRects().length > 0)
      .flatMap((el) => (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean));
    const orgEl = document.querySelector('.switch-org .hibo-select-selection-item, .switch-org .ant-select-selection-item, .switch-org-title-ellipsis, .switch-org-title');
    const orgText = String(orgEl?.getAttribute('title') || orgEl?.textContent || '').trim();
    const hasLoginForm = [...document.querySelectorAll('input[type="password"]')]
      .some((el) => el.getClientRects().length > 0);
    return hasLoginForm || (names.length > 0 && orgText && !/^\d+$/.test(orgText));
  }, undefined, { timeout: 15000 }).catch(() => {});
  const url = await page.url();
  const state = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const names = [...document.querySelectorAll('.header-dropdown')]
      .filter((el) => el.getClientRects().length > 0)
      .flatMap((el) => (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean));
    const orgEl = document.querySelector('.switch-org .hibo-select-selection-item, .switch-org .ant-select-selection-item, .switch-org-title-ellipsis, .switch-org-title');
    const org = String(orgEl?.getAttribute('title') || orgEl?.textContent || '').trim() || null;
    const bodyText = document.body?.innerText || '';
    const hasPasswordInput = [...document.querySelectorAll('input[type="password"]')].some(visible);
    const hasLoginText = /扫码登录|账号登录|手机号登录/.test(bodyText.slice(0, 300));
    const hasLoginForm = hasPasswordInput || (names.length === 0 && hasLoginText);
    return { names, org, hasLoginForm };
  });
  const loggedIn = state.names.length > 0 && !/login/i.test(url);
  let brandMatch = null;
  if (brand === '小仓') brandMatch = state.org === '小仓生活' || state.org === '小仓生活仓店';
  else if (brand === '乐心宜') brandMatch = Boolean(state.org && state.org.includes('乐心宜'));
  else if (brand) brandMatch = Boolean(state.org && state.org.includes(brand));

  return {
    url,
    loggedIn,
    operatorNames: state.names,
    businessUnit: state.org,
    brandMatch,
    needsUserLogin: !loggedIn || state.hasLoginForm,
  };
}

function inspectProfileMatch(allProfiles, profileName) {
  const matched = allProfiles.filter((item) => item.name === profileName);
  return {
    profileName,
    exists: matched.length === 1,
    ambiguous: matched.length > 1,
    id: matched.length === 1 ? matched[0].id : null,
    source: 'configured',
    isDefaultFallback: false,
  };
}

function resolveEffectiveProfile(allProfiles, { configuredName, legacyNames = [] } = {}) {
  const explicit = configuredName ? String(configuredName).trim() : '';
  if (explicit) {
    return inspectProfileMatch(allProfiles, explicit);
  }
  for (const candidate of legacyNames) {
    const clean = String(candidate || '').trim();
    if (!clean) continue;
    const matched = allProfiles.filter((item) => item.name === clean);
    if (matched.length === 1) {
      return {
        profileName: matched[0].name,
        exists: true,
        ambiguous: false,
        id: matched[0].id,
        source: 'matched_existing',
        isDefaultFallback: false,
      };
    }
  }
  const fallback = allProfiles.find((item) => item.isDefault) || allProfiles[0] || null;
  if (fallback) {
    return {
      profileName: fallback.name,
      exists: true,
      ambiguous: false,
      id: fallback.id,
      source: 'egolite_default',
      isDefaultFallback: true,
    };
  }
  return {
    profileName: '默认资料',
    exists: allProfiles.length === 0,
    ambiguous: false,
    id: null,
    source: 'egolite_default',
    isDefaultFallback: true,
  };
}

async function runLoginCheck(profileId, label, checkFn, { keepLoginWindow = true } = {}) {
  const taskOptions = profileId ? { profileId } : {};
  const task = await globalThis.taskSpace(`xc-ego 体检 ${label} ${Date.now()}`, taskOptions);
  let keepWindow = false;
  try {
    const page = task.page('p1');
    await prepareTaskWindow(task, page);
    const res = await checkFn(page);
    if (res?.needsUserLogin && keepLoginWindow !== false) {
      keepWindow = true;
      await restoreTaskWindowForUser(task, page);
      return {
        ...res,
        keptWindow: true,
        ...(task.id ? { taskSpaceId: task.id } : {}),
      };
    }
    return { ...res, keptWindow: false };
  } finally {
    if (!keepWindow) {
      await task.finish({ keep: [] }).catch(() => {});
    }
  }
}

export async function run(input) {
  const req = typeof input === 'string'
    ? JSON.parse(await fs.readFile(input, 'utf8'))
    : (input || {});

  if (typeof globalThis.profiles !== 'function' || typeof globalThis.taskSpace !== 'function') {
    const fail = { ok: false, stage: 'egolite_runtime_missing', message: '请在 ego-browser nodejs 环境下运行 preflight.mjs' };
    console.log(JSON.stringify(fail, null, 2));
    return fail;
  }

  const prefs = await loadPreferences(req.prefsPath || DEFAULT_PREFS_PATH);
  const target = req.target || 'hibo';
  const brand = normalizeBrand(req.brand);
  const checkLogin = Boolean(req.checkLogin);
  const keepLoginWindow = req.keepLoginWindow !== false;
  const allProfiles = await globalThis.profiles();

  const hiboProfileName = req.hiboProfileName
    || (target !== 'both' ? req.profileName : null)
    || resolveProfileName(prefs, { target: 'hibo' });
  const hiboInfo = (target === 'hibo' || target === 'both')
    ? resolveEffectiveProfile(allProfiles, {
      configuredName: hiboProfileName,
      legacyNames: ['采集'],
    })
    : null;

  const rawBrands = Array.isArray(req.brands) && req.brands.length
    ? [...new Set(req.brands.map((item) => normalizeBrand(item)).filter(Boolean))]
    : (brand ? [brand] : []);
  const meituanEntries = rawBrands.length ? rawBrands : ['default'];
  const meituanProfiles = {};
  if (target === 'meituan' || target === 'both') {
    for (const entry of meituanEntries) {
      const isGenericDefault = entry === 'default';
      const configuredName = (isGenericDefault ? null : req.meituanProfileName)
        || (target !== 'both' && !isGenericDefault && req.profileName ? req.profileName : null)
        || (isGenericDefault ? resolveProfileName(prefs, { target: 'hibo' }) : resolveProfileName(prefs, { target: 'meituan', brand: entry }));
      meituanProfiles[entry] = resolveEffectiveProfile(allProfiles, {
        configuredName,
        legacyNames: isGenericDefault ? [] : [entry],
      });
    }
  }

  const missingProfiles = [];
  if (hiboInfo && !hiboInfo.exists) missingProfiles.push({ target: 'hibo', ...hiboInfo });
  for (const [b, info] of Object.entries(meituanProfiles)) {
    if (!info.exists) missingProfiles.push({ target: 'meituan', brand: b, ...info });
  }

  if (missingProfiles.length) {
    const result = {
      ok: false,
      stage: missingProfiles.some((m) => m.ambiguous) ? 'profile_ambiguous' : 'profile_missing',
      platform: process.platform,
      target,
      brand,
      missingProfiles,
      availableProfiles: allProfiles.map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault })),
      nextStep: '未找到你在配置中指定的资料；可改用默认资料，或在 ~/.xc-ego/preferences.json 中更新绑定名称。',
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (rawBrands.length >= 2) {
    const resolvedIds = rawBrands.map((b) => meituanProfiles[b]?.id).filter(Boolean);
    if (resolvedIds.length >= 2 && new Set(resolvedIds).size < rawBrands.length) {
      const result = {
        ok: false,
        stage: 'meituan_profile_isolation_required',
        platform: process.platform,
        target,
        brands: rawBrands,
        meituanProfiles,
        availableProfiles: allProfiles.map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault })),
        nextStep: '同一个 EgoLite 资料下美团商家后台只能登录一个账号；本次同时涉及多个美团中台，建议默认资料保留其中一个中台，再新建 1 个任意命名的资料登录另一个中台，并在 ~/.xc-ego/preferences.json 中绑定。仅使用单个美团中台时无需新建资料。',
      };
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
  }

  const loginReport = {};
  if (checkLogin) {
    if (hiboInfo) {
      loginReport.hibo = await runLoginCheck(
        hiboInfo.id,
        'hibo',
        (page) => checkHiboLogin(page, brand),
        { keepLoginWindow },
      );
    }
    if (Object.keys(meituanProfiles).length) {
      loginReport.meituan = {};
      for (const [b, info] of Object.entries(meituanProfiles)) {
        loginReport.meituan[b] = await runLoginCheck(
          info.id,
          `meituan-${b}`,
          (page) => checkMeituanLoginState(page),
          { keepLoginWindow },
        );
      }
    }
  }

  const loginBlocked = Boolean(
    loginReport.hibo?.needsUserLogin
    || Object.values(loginReport.meituan || {}).some((item) => item?.needsUserLogin),
  );

  const result = {
    ok: !loginBlocked,
    stage: loginBlocked ? 'login_required' : 'ready',
    platform: process.platform,
    target,
    brand,
    ...(hiboInfo ? {
      hiboProfile: {
        id: hiboInfo.id,
        name: hiboInfo.profileName,
        source: hiboInfo.source,
        isDefaultFallback: hiboInfo.isDefaultFallback,
      },
    } : {}),
    ...(Object.keys(meituanProfiles).length ? { meituanProfiles } : {}),
    availableProfiles: allProfiles.map((p) => p.name),
    checkLogin,
    loginReport,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}
