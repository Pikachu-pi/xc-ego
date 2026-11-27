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
  };
}

async function runLoginCheck(profileId, label, checkFn, { keepLoginWindow = true } = {}) {
  const task = await globalThis.taskSpace(`xc-ego 体检 ${label} ${Date.now()}`, { profileId });
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
    ? inspectProfileMatch(allProfiles, hiboProfileName)
    : null;

  const meituanBrands = brand ? [brand] : ['小仓', '乐心宜'];
  const meituanProfiles = {};
  if (target === 'meituan' || target === 'both') {
    for (const b of meituanBrands) {
      const name = req.meituanProfileName
        || (target !== 'both' && brand && req.profileName ? req.profileName : null)
        || resolveProfileName(prefs, { target: 'meituan', brand: b });
      meituanProfiles[b] = inspectProfileMatch(allProfiles, name);
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
      nextStep: '请在 EgoLite 中创建唯一对应的资料，或在 ~/.xc-ego/preferences.json 中绑定已有资料名。',
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
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
    ...(hiboInfo ? { hiboProfile: { id: hiboInfo.id, name: hiboInfo.profileName } } : {}),
    ...(Object.keys(meituanProfiles).length ? { meituanProfiles } : {}),
    availableProfiles: allProfiles.map((p) => p.name),
    checkLogin,
    loginReport,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}
