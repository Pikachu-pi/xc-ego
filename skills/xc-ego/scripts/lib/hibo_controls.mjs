import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { verifyXlsxFile } from './xlsx_check.mjs';

export const HIBO_BASE_URL = 'https://zt.hiboos.com/index.html';
const DEFAULT_RECENT_EXPORTS_PATH = path.join(os.homedir(), '.xc-ego', 'recent-hibo-exports.json');

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactTextPattern(text) {
  return new RegExp(`^\\s*${escapeRegex(text)}\\s*$`);
}

function inspectDom({ steps, operation, marker, callback }) {
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const textOf = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ');

  function query(root, selector) {
    const matches = [...root.querySelectorAll(selector)];
    if (root.shadowRoot) matches.push(...query(root.shadowRoot, selector));
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) matches.push(...query(el.shadowRoot, selector));
    }
    return matches;
  }

  function resolve(stepList, roots = [document]) {
    for (const step of stepList) {
      if (step.index !== undefined) {
        const picked = roots.at(step.index);
        roots = picked ? [picked] : [];
      } else if (step.dropdownPopup) {
        if (roots.length !== 1) return [];
        const trigger = roots[0];
        const anchor = trigger.getBoundingClientRect();
        const controls = trigger.getAttribute('aria-controls');
        const allMenus = query(
          document,
          '.hibo-dropdown:not(.hibo-dropdown-hidden),.ant-dropdown:not(.ant-dropdown-hidden),[role="menu"]',
        ).filter((popup) => shown(popup) && popup.getBoundingClientRect().width > 0 && popup.getBoundingClientRect().height > 0);
        if (controls) {
          const ctrlEl = document.getElementById(controls);
          const controlled = allMenus.filter((popup) => popup.contains(ctrlEl));
          if (controlled.length) {
            roots = controlled;
            continue;
          }
        }
        const nearMenus = allMenus.filter((popup) => {
          const rect = popup.getBoundingClientRect();
          const gap = Math.min(Math.abs(rect.top - anchor.bottom), Math.abs(anchor.top - rect.bottom));
          return gap <= 32 && rect.right > anchor.left - 24 && rect.left < anchor.right + 24;
        });
        roots = nearMenus.length ? nearMenus : (allMenus.length === 1 ? allMenus : []);
      } else if (step.has) {
        roots = roots.filter((root) => resolve(step.has, [root]).length > 0);
      } else if (step.text !== undefined) {
        const re = step.regex ? new RegExp(step.text, step.flags) : null;
        roots = roots.filter((root) => (re ? re.test(textOf(root)) : textOf(root).includes(step.text)));
      } else {
        const visibleOnly = step.css.includes(':visible');
        const selector = step.css.replaceAll(':visible', '');
        roots = [...new Set(roots.flatMap((root) => query(root, selector)))]
          .filter((root) => !visibleOnly || shown(root));
        if (step.exactText !== undefined) {
          roots = roots.filter((root) => textOf(root) === step.exactText);
        }
      }
    }
    return roots;
  }

  const matches = resolve(steps);
  if (operation === 'count') return matches.length;
  if (operation === 'visible') return matches.some(shown);
  if (operation === 'values') return (0, eval)(`(${callback})`)(matches);
  if (matches.length !== 1) return null;
  const el = matches[0];
  if (operation === 'value') return el.value ?? '';
  if (operation === 'text') return el.innerText ?? '';
  if (operation === 'attribute') return el.getAttribute(callback);
  if (operation === 'blur') {
    el.blur();
    return true;
  }
  if (operation === 'open-dropdown' && shown(el) && !el.disabled) {
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, composed: true }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));
    return true;
  }
  if (operation === 'activate' && shown(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true') {
    el.click();
    return true;
  }
  if ((operation === 'mark' && shown(el)) || (operation === 'mark-file' && el.matches('input[type=file]:not([disabled])'))) {
    el.setAttribute('data-xc-ego-target', marker);
    return true;
  }
  return null;
}

export function createDomLocator(page, steps = []) {
  const inspect = (operation, extras = {}) => page.evaluate(inspectDom, { steps, operation, ...extras });
  const extend = (step) => createDomLocator(page, [...steps, step]);

  const waitFor = async ({ state = 'visible', timeout = 15000 } = {}) => {
    const deadline = Date.now() + timeout;
    do {
      const match = await inspect(state === 'attached' || state === 'detached' ? 'count' : 'visible');
      if (Boolean(match) === (state === 'visible' || state === 'attached')) return;
      await sleep(100);
    } while (Date.now() < deadline);
    throw new Error(`控件等待超时: ${JSON.stringify(steps)}`);
  };

  const use = async (action, args = [], options = {}) => {
    const isFile = action === 'setInputFiles';
    await waitFor({ state: isFile ? 'attached' : 'visible', timeout: options?.timeout });
    const marker = crypto.randomUUID();
    if (!(await inspect(isFile ? 'mark-file' : 'mark', { marker }))) {
      throw new Error(`控件无法唯一定位: ${JSON.stringify(steps)}`);
    }
    const selector = `[data-xc-ego-target="${marker}"]`;
    try {
      return await page[action](selector, ...args);
    } catch (err) {
      if (action === 'click' && /intercepts pointer events/i.test(String(err?.message || ''))) {
        await dismissObstructions(page).catch(() => {});
        return await page[action](selector, ...args);
      }
      throw err;
    } finally {
      await page.evaluate((sel) => {
        const clear = (root) => {
          root.querySelector(sel)?.removeAttribute('data-xc-ego-target');
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) clear(el.shadowRoot);
          }
        };
        clear(document);
      }, selector).catch(() => {});
    }
  };

  return {
    steps,
    locator: (css) => extend({ css }),
    getByText: (exactText) => extend({ css: 'label,span,div,a,button', exactText }),
    dropdownPopup: () => extend({ dropdownPopup: true }),
    filter: ({ has, hasText }) => extend(
      has
        ? { has: has.steps }
        : hasText instanceof RegExp
          ? { text: hasText.source, regex: true, flags: hasText.flags }
          : { text: hasText },
    ),
    first: () => extend({ index: 0 }),
    last: () => extend({ index: -1 }),
    count: () => inspect('count'),
    waitFor,
    blur: () => inspect('blur'),
    openDropdown: async () => {
      await waitFor();
      if (!(await inspect('open-dropdown'))) throw new Error(`下拉菜单无法唯一定位: ${JSON.stringify(steps)}`);
    },
    activate: async (beforeActivate = () => {}) => {
      await waitFor();
      beforeActivate();
      if (!(await inspect('activate'))) throw new Error(`控件无法唯一点击: ${JSON.stringify(steps)}`);
    },
    click: (options) => use('click', [{ label: '操作海博报表控件' }], options),
    fill: (value, options) => use('fill', [value], options),
    press: (key, options) => use('press', [key], options),
    inputValue: () => inspect('value'),
    innerText: () => inspect('text'),
    getAttribute: (name) => inspect('attribute', { callback: name }),
    evaluateAll: (fn) => inspect('values', { callback: fn.toString() }),
  };
}

export async function waitForCondition({ probe, timeoutMs, intervalMs = 100, errorMessage }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await probe();
    if (val) return val;
    await sleep(intervalMs);
  }
  throw new Error(errorMessage);
}

export async function prepareTaskWindow(task, page) {
  const { windowId, bounds } = await page.cdp('Browser.getWindowForTarget');
  if (bounds?.windowState !== 'minimized') {
    await task.cdp('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await waitForCondition({
      probe: async () => (await task.cdp('Browser.getWindowBounds', { windowId }))?.bounds?.windowState === 'minimized',
      timeoutMs: 2500,
      intervalMs: 100,
      errorMessage: 'Ego 采集窗口未能最小化',
    });
  }
  const workArea = await page.evaluate(() => ({
    width: screen.availWidth || 1524,
    height: screen.availHeight || 750,
  }));
  await page.cdp('Emulation.setDeviceMetricsOverride', {
    width: workArea.width,
    height: workArea.height,
    deviceScaleFactor: 0,
    mobile: false,
  });
  await page.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
}

export async function restoreTaskWindowForUser(task, page) {
  await page.cdp('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await page.cdp('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
  const targetInfo = await page.cdp('Browser.getWindowForTarget').catch(() => null);
  if (targetInfo?.windowId !== undefined) {
    await task.cdp('Browser.setWindowBounds', {
      windowId: targetInfo.windowId,
      bounds: { windowState: 'normal' },
    }).catch(() => {});
  }
}

export async function openMinimizedTaskSpace(name, profileName = null) {
  const all = await globalThis.profiles();
  let chosen = null;
  const requested = profileName ? String(profileName).trim() : '';
  if (requested) {
    const matches = all.filter((profile) => profile.name === requested);
    if (matches.length !== 1) {
      throw new Error(`PROFILE_NOT_UNIQUE: Ego 中未找到唯一名为「${requested}」的资料`);
    }
    chosen = matches[0];
  } else {
    chosen = all.find((profile) => profile.isDefault) || all[0] || null;
  }
  const task = await globalThis.taskSpace(name, chosen ? { profileId: chosen.id } : {});
  const page = task.page('p1');
  try {
    await prepareTaskWindow(task, page);
    return { task, page, profile: chosen };
  } catch (error) {
    await task.finish({ keep: [] }).catch(() => {});
    throw error;
  }
}

export async function navigateKeepingViewport(page, url, timeout = 30000) {
  const size = await page.evaluate(() => ({ width: innerWidth || 1524, height: innerHeight || 750 }));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.cdp('Emulation.setDeviceMetricsOverride', {
    width: size.width,
    height: size.height,
    deviceScaleFactor: 0,
    mobile: false,
  });
  await page.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
}

export async function readHiboIdentity(page) {
  await page.waitForFunction(() => {
    if (/login/i.test(location.href)) return true;
    const names = [...document.querySelectorAll('.header-dropdown')]
      .filter((el) => el.getClientRects().length > 0)
      .flatMap((el) => (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean));
    const orgEl = document.querySelector('.switch-org .hibo-select-selection-item, .switch-org .ant-select-selection-item, .switch-org-title-ellipsis, .switch-org-title');
    const org = String(orgEl?.getAttribute('title') || orgEl?.textContent || '').trim();
    return names.length > 0 && org && !/^\d+$/.test(org);
  }, undefined, { timeout: 15000 }).catch(() => {});

  const currentUrl = await page.url();
  if (/login/i.test(currentUrl)) {
    throw new Error(`HIBO_LOGIN_REQUIRED: 当前停留在登录页 (${currentUrl})`);
  }
  await page.waitForSelector('.header-dropdown', { state: 'visible', timeout: 10000 }).catch(() => {
    throw new Error('HIBO_LOGIN_REQUIRED: 未检测到已登录海博页头，请先在 EgoLite 中登录海博');
  });
  const info = await page.evaluate(() => {
    const orgEl = document.querySelector('.switch-org .hibo-select-selection-item, .switch-org .ant-select-selection-item, .switch-org-title-ellipsis, .switch-org-title');
    const org = String(orgEl?.getAttribute('title') || orgEl?.textContent || '').trim();
    const names = [...document.querySelectorAll('.header-dropdown')]
      .filter((el) => el.getClientRects().length > 0)
      .flatMap((el) => (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean));
    return { org, names };
  });
  if (!info.names.length) {
    throw new Error('HIBO_LOGIN_REQUIRED: 无法读取当前登录操作人姓名');
  }
  return { ...info, operatorNames: info.names };
}

export async function dismissObstructions(page) {
  const findKnownPos = () => page.evaluate(() => {
    const norm = (val) => String(val || '').replace(/\s+/g, '');
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const idleBtn = [...document.querySelectorAll('[role="dialog"],.hibo-modal-wrap,.ant-modal-wrap')]
      .filter(visible)
      .filter((dlg) => {
        const t = dlg.innerText || '';
        return t.includes('系统检测到您较长时间未操作页面') || t.includes('提示音');
      })
      .flatMap((dlg) => [...dlg.querySelectorAll('button,.hibo-btn,.ant-btn')])
      .filter(visible)
      .find((el) => norm(el.innerText || el.textContent) === '知道了');
    const btn = idleBtn || [...document.querySelectorAll('button,.hibo-btn,.ant-btn')]
      .filter(visible)
      .find((el) => norm(el.innerText || el.textContent) === '知道了');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pos = await findKnownPos();
    if (!pos) break;
    await page.mouse.click(pos.x, pos.y, { label: '关闭海博空闲提示弹窗' });
    await waitForCondition({
      probe: async () => !(await page.evaluate(() => {
        const norm = (val) => String(val || '').replace(/\s+/g, '');
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
        };
        return [...document.querySelectorAll('button,.hibo-btn,.ant-btn')]
          .filter(visible)
          .some((el) => norm(el.innerText || el.textContent) === '知道了')
          || [...document.querySelectorAll('.hibo-modal-wrap,.ant-modal-wrap,[role="dialog"]')]
            .filter(visible)
            .some((dlg) => {
              const t = dlg.innerText || '';
              return t.includes('系统检测到您较长时间未操作页面') || t.includes('提示音');
            });
      })),
      timeoutMs: 2000,
      intervalMs: 100,
      errorMessage: 'IDLE_DIALOG_STILL_VISIBLE',
    }).catch(() => {});
  }

  const promoResult = await page.evaluate(() => {
    if (!(document.body?.innerText || '').includes('报名开通')) return 'none';
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const modal = [...document.querySelectorAll('.hibo-modal-wrap,.ant-modal-wrap,.zt-dialog-wrapper,.zt-dialog,[role="dialog"]')]
      .filter(visible)
      .find((el) => (el.innerText || '').includes('报名开通'));
    const closeBtn = modal?.querySelector('.hibo-modal-close,.ant-modal-close,[aria-label="Close"],[aria-label="close"],[class*="close"]');
    if (closeBtn && visible(closeBtn)) {
      closeBtn.click();
      return 'dom_closed';
    }
    return 'fallback_click';
  });
  if (promoResult === 'dom_closed') {
    await sleep(400);
  } else if (promoResult === 'fallback_click') {
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(300);
  }
}

async function modalHasExportRecords(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    return [...document.querySelectorAll('.hibo-modal-wrap,.ant-modal-wrap,.zt-dialog-wrapper,.zt-dialog,[role="dialog"]')]
      .filter(visible)
      .some((el) => {
        const text = el.innerText || '';
        if (el.classList.contains('hibo-export-record-dialog')) return true;
        const hasTitle = /(导入导出记录|导出记录)/.test(text);
        const hasRecordSignals = /(创建时间|操作日期|任务名称|导出状态|下载|暂无数据)/.test(text)
          || Boolean(el.querySelector('table,.hibo-table,.ant-table'));
        return hasTitle && hasRecordSignals;
      });
  });
}

export async function closeExportRecords(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await modalHasExportRecords(page))) return;
    const closed = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
    const modal = [...document.querySelectorAll('.hibo-modal-wrap,.ant-modal-wrap,.zt-dialog-wrapper,.zt-dialog,[role="dialog"]')]
      .filter(visible)
      .find((el) => {
        const text = el.innerText || '';
        if (el.classList.contains('hibo-export-record-dialog')) return true;
        const hasTitle = /(导入导出记录|导出记录)/.test(text);
        const hasRecordSignals = /(创建时间|操作日期|任务名称|导出状态|下载|暂无数据)/.test(text)
          || Boolean(el.querySelector('table,.hibo-table,.ant-table'));
        return hasTitle && hasRecordSignals;
      });
      const closeBtn = modal?.querySelector('.hibo-modal-close,.ant-modal-close,[aria-label="Close"],[aria-label="close"]');
      if (!closeBtn || !visible(closeBtn)) return false;
      closeBtn.click();
      return true;
    });
    if (!closed) break;
    await sleep(400);
  }
  if (await modalHasExportRecords(page)) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await sleep(3000);
  }
}

export function pickOrgCandidate({ currentText = '', options = [], brand = '小仓', staticHeaderOrg = '', expectedOrg = '' }) {
  if (expectedOrg) {
    if (currentText === expectedOrg) return { matched: expectedOrg, alreadySelected: true };
    const exact = options.find((opt) => opt.text === expectedOrg);
    if (exact) return { matched: exact.text, option: exact, alreadySelected: false };
    throw new Error(`BUSINESS_UNIT_NOT_FOUND: 未找到业务单元「${expectedOrg}」，当前选项：${options.map((o) => o.text).join(' / ') || '无'}`);
  }

  if (staticHeaderOrg) {
    if (currentText === staticHeaderOrg) return { matched: staticHeaderOrg, alreadySelected: true };
    const exact = options.find((opt) => opt.text === staticHeaderOrg);
    if (exact) return { matched: exact.text, option: exact, alreadySelected: false };
    throw new Error(`BUSINESS_UNIT_NOT_FOUND: 期望静态业务单元「${staticHeaderOrg}」，当前显示「${currentText || '无'}」`);
  }

  if (brand === '小仓') {
    const target = '小仓生活';
    if (currentText === target) return { matched: target, alreadySelected: true };
    const exact = options.find((opt) => opt.text === target);
    if (exact) return { matched: exact.text, option: exact, alreadySelected: false };
    throw new Error(`BUSINESS_UNIT_NOT_FOUND: 未找到小仓业务单元「${target}」，当前选项：${options.map((o) => o.text).join(' / ') || '无'}`);
  }

  if (brand === '乐心宜') {
    const lxyOptions = options.filter((opt) => opt.text.includes('乐心宜'));
    if (!lxyOptions.length) {
      if (currentText.includes('乐心宜') && options.length === 0) {
        return { matched: currentText, alreadySelected: true };
      }
      throw new Error(`BUSINESS_UNIT_NOT_FOUND: 未找到包含「乐心宜」的业务单元，当前选项：${options.map((o) => o.text).join(' / ') || '无'}`);
    }
    const nonStore = lxyOptions.filter((o) => !o.text.includes('仓店'));
    const chosen = nonStore.find((o) => o.text === '小仓生活乐心宜' || o.text === '乐心宜')
      || (nonStore.length === 1 ? nonStore[0] : null)
      || (lxyOptions.length === 1 ? lxyOptions[0] : null);
    if (!chosen) {
      throw new Error(`BUSINESS_UNIT_AMBIGUOUS: 存在多个「乐心宜」业务单元候选 (${lxyOptions.map((o) => o.text).join(' / ')})，请用户明确指定`);
    }
    return { matched: chosen.text, option: chosen, alreadySelected: currentText === chosen.text };
  }

  const cleanBrand = String(brand || '').trim();
  if (cleanBrand) {
    if (currentText === cleanBrand) return { matched: cleanBrand, alreadySelected: true };
    const exact = options.find((opt) => opt.text === cleanBrand);
    if (exact) return { matched: exact.text, option: exact, alreadySelected: false };
    const partial = options.filter((opt) => opt.text.includes(cleanBrand));
    const nonStore = partial.filter((opt) => !opt.text.includes('仓店'));
    if (nonStore.length === 1) return { matched: nonStore[0].text, option: nonStore[0], alreadySelected: currentText === nonStore[0].text };
    if (partial.length === 1) return { matched: partial[0].text, option: partial[0], alreadySelected: currentText === partial[0].text };
    if (partial.length > 1) {
      throw new Error(`BUSINESS_UNIT_AMBIGUOUS: 存在多个「${cleanBrand}」业务单元候选 (${partial.map((o) => o.text).join(' / ')})，请用户明确指定`);
    }
    throw new Error(`BUSINESS_UNIT_NOT_FOUND: 未找到包含「${cleanBrand}」的业务单元，当前选项：${options.map((o) => o.text).join(' / ') || '无'}`);
  }

  throw new Error(`BRAND_INVALID: 不支持的中台「${brand}」`);
}

async function readSwitchOrgState(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const selector = document.querySelector('.switch-org .hibo-select-selector,.switch-org .ant-select-selector');
    const selected = document.querySelector('.switch-org .hibo-select-selection-item,.switch-org .ant-select-selection-item');
    if (selector && visible(selector)) {
      const text = String(selected?.getAttribute('title') || selected?.textContent || '').trim();
      const r = selector.getBoundingClientRect();
      return { text, interactive: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }
    const staticHeader = [...document.querySelectorAll('.switch-org-title-ellipsis,.switch-org-title,.lf-header span')]
      .filter(visible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          text: String(el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim(),
          left: r.left,
          top: r.top,
          width: r.width,
        };
      })
      .find((x) => x.top < 70 && x.left >= 90 && x.left < 360 && x.width >= 60 && x.text);
    if (staticHeader) {
      return { text: staticHeader.text, interactive: false, x: null, y: null };
    }
    return null;
  });
}

async function readVisibleOrgOptions(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const dropdowns = [...document.querySelectorAll('.hibo-select-dropdown,.ant-select-dropdown')]
      .filter((d) => !d.classList.contains('hibo-select-dropdown-hidden')
        && !d.classList.contains('ant-select-dropdown-hidden')
        && !d.classList.contains('hibo-slide-up-leave')
        && visible(d));
    const items = dropdowns.flatMap((d) => [...d.querySelectorAll('[role="option"],.hibo-select-item-option,.ant-select-item-option')]);
    return items
      .filter(visible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        const text = String(el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim();
        return {
          text,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
        };
      })
      .filter((x) => x.text);
  });
}

async function openOrgDropdownAndReadOptions(page, current) {
  for (let tryOpen = 0; tryOpen < 2; tryOpen += 1) {
    if (tryOpen === 0) {
      await page.evaluate(() => {
        const sel = document.querySelector('.switch-org .hibo-select-selector,.switch-org .ant-select-selector');
        sel?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      });
    } else {
      await page.mouse.click(current.x, current.y, { label: '展开业务单元下拉框' });
    }
    const options = await waitForCondition({
      probe: async () => {
        const list = await readVisibleOrgOptions(page);
        return list.length ? list : null;
      },
      timeoutMs: 3000,
      intervalMs: 120,
      errorMessage: 'ORG_DROPDOWN_EMPTY',
    }).catch(() => null);
    if (options?.length) return options;
  }
  return [];
}

export async function ensureBusinessUnit(page, optionsOrOrg = '小仓生活') {
  const opts = typeof optionsOrOrg === 'string'
    ? { expectedOrg: optionsOrOrg }
    : (optionsOrOrg || {});
  const { brand = '小仓', staticHeaderOrg = '', expectedOrg = '' } = opts;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await dismissObstructions(page);
    const current = await readSwitchOrgState(page);
    if (!current) throw new Error('BUSINESS_UNIT_SELECTOR_MISSING: 未找到业务单元切换控件');

    if (staticHeaderOrg) {
      if (current.text === staticHeaderOrg) return current.text;
      if (!current.interactive) {
        throw new Error(`BUSINESS_UNIT_MISMATCH: 期望静态业务单元「${staticHeaderOrg}」，当前显示「${current.text}」`);
      }
    }

    if ((expectedOrg && current.text === expectedOrg)
      || (!expectedOrg && brand === '小仓' && !staticHeaderOrg && current.text === '小仓生活')
      || (!expectedOrg && brand === '乐心宜' && !staticHeaderOrg && (current.text === '小仓生活乐心宜' || current.text === '乐心宜'))) {
      return current.text;
    }

    if (!current.interactive) {
      throw new Error(`BUSINESS_UNIT_STATIC_MISMATCH: 当前页面业务单元控件不可切换，当前显示「${current.text}」`);
    }

    const visibleOptions = await openOrgDropdownAndReadOptions(page, current);
    const decision = pickOrgCandidate({
      currentText: current.text,
      options: visibleOptions,
      brand,
      staticHeaderOrg,
      expectedOrg,
    });

    if (decision.alreadySelected) {
      await page.keyboard.press('Escape').catch(() => {});
      return decision.matched;
    }

    const domClicked = await page.evaluate((targetText) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const opt = [...document.querySelectorAll('.hibo-select-dropdown:not(.hibo-select-dropdown-hidden) [role="option"], .hibo-select-dropdown:not(.hibo-select-dropdown-hidden) .hibo-select-item-option, .ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')]
        .filter(visible)
        .find((el) => String(el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim() === targetText);
      if (!opt) return false;
      opt.click();
      return true;
    }, decision.matched);
    if (!domClicked) {
      await page.mouse.click(decision.option.x, decision.option.y, { label: `切换业务单元到${decision.matched}` });
    }
    const switched = await waitForCondition({
      probe: async () => {
        const after = await readSwitchOrgState(page);
        return after?.text === decision.matched ? after.text : null;
      },
      timeoutMs: 10000,
      intervalMs: 250,
      errorMessage: 'ORG_SWITCH_TIMEOUT',
    }).catch(() => null);
    if (switched) {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      return switched;
    }
  }
  throw new Error(`BUSINESS_UNIT_MISMATCH: 未能切换业务单元（中台：${brand}）`);
}

async function clickVisibleButtonByText(page, text, beforeClick = () => {}) {
  const find = (targetText) => {
    const norm = (val) => String(val || '').replace(/\s+/g, '');
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    return [...document.querySelectorAll('button,.hibo-btn,.ant-btn,[role="button"]')]
      .filter(visible)
      .some((el) => norm(el.innerText || el.textContent) === norm(targetText));
  };
  await dismissObstructions(page);
  try {
    await page.waitForFunction(find, text, { timeout: 15000 });
  } catch {
    await dismissObstructions(page);
    await page.waitForFunction(find, text, { timeout: 8000 });
  }
  beforeClick();
  const clicked = await page.evaluate((targetText) => {
    const norm = (val) => String(val || '').replace(/\s+/g, '');
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const btn = [...document.querySelectorAll('button,.hibo-btn,.ant-btn,[role="button"]')]
      .filter(visible)
      .find((el) => norm(el.innerText || el.textContent) === norm(targetText));
    if (!btn) return false;
    btn.click();
    return true;
  }, text);
  if (!clicked) throw new Error(`BUTTON_DISAPPEARED: ${text}`);
}

async function openDropdownMenuItem(page, triggerText, itemText) {
  const tryOpen = async (mode = 'hover') => {
    const dom = createDomLocator(page);
    const trigger = dom.locator(
      'button.hibo-dropdown-trigger:visible,button.ant-dropdown-trigger:visible,.hibo-dropdown-trigger:visible,.ant-dropdown-trigger:visible,button:visible,.hibo-btn:visible,.ant-btn:visible,[role="button"]:visible',
    ).filter({ hasText: exactTextPattern(triggerText) }).first();
    await trigger.waitFor({ timeout: 8000 });
    if (mode === 'click') {
      await trigger.activate();
    } else {
      await trigger.openDropdown();
    }
    const controlledItem = trigger.dropdownPopup().locator('[role="menuitem"]:visible,li.hibo-dropdown-menu-item:visible,li.ant-dropdown-menu-item:visible')
      .filter({ hasText: exactTextPattern(itemText) });
    try {
      await controlledItem.waitFor({ timeout: 3000 });
      if ((await controlledItem.count()) === 1) return controlledItem;
    } catch {
      // Fallback to any single visible menu item matching itemText in active dropdowns
    }
    const fallbackItem = dom.locator(
      '.hibo-dropdown:not(.hibo-dropdown-hidden) [role="menuitem"]:visible,.ant-dropdown:not(.ant-dropdown-hidden) [role="menuitem"]:visible,.hibo-dropdown:not(.hibo-dropdown-hidden) li:visible,.ant-dropdown:not(.ant-dropdown-hidden) li:visible',
    ).filter({ hasText: exactTextPattern(itemText) });
    await fallbackItem.waitFor({ timeout: 3500 });
    if ((await fallbackItem.count()) !== 1) throw new Error(`MENU_ITEM_NOT_UNIQUE: ${triggerText} -> ${itemText}`);
    return fallbackItem;
  };
  await dismissObstructions(page);
  for (const mode of ['hover', 'click', 'hover']) {
    try {
      return await tryOpen(mode);
    } catch {
      await dismissObstructions(page);
    }
  }
  return tryOpen('click');
}

function normalizeRoute(route) {
  const raw = String(route || '').trim();
  if (!raw) return '';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function matchesRouteHash(actualHash, expectedRoute) {
  const norm = normalizeRoute(expectedRoute);
  if (!norm) return false;
  return actualHash === `#${norm}` || actualHash.startsWith(`#${norm}?`);
}

async function ensureReportTab(page, tabText) {
  if (!tabText) return;
  const dom = createDomLocator(page);
  const tab = dom.locator('[role="tab"]:visible').filter({ hasText: exactTextPattern(tabText) });
  await tab.waitFor({ timeout: 10000 });
  if ((await tab.count()) !== 1) throw new Error(`REPORT_TAB_NOT_UNIQUE: ${tabText}`);
  if ((await tab.getAttribute('aria-selected')) !== 'true') {
    await tab.activate();
  }
  await dom.locator('[role="tab"][aria-selected="true"]:visible')
    .filter({ hasText: exactTextPattern(tabText) })
    .waitFor({ timeout: 5000 });
}

export function detectHiboPageError(bodyText = '') {
  const text = String(bodyText || '');
  if (text.includes('抱歉，你访问的页面不存在') || text.includes('您要找的页面没有找到')) {
    return { code: 'REPORT_PAGE_NOT_FOUND', message: '目标海博路由不存在（404 页面）' };
  }
  if (text.includes('暂无权限') || text.includes('无权限访问') || text.includes('您没有权限')) {
    return { code: 'REPORT_NO_PERMISSION', message: '当前账号无权访问该海博页面' };
  }
  return null;
}

export async function prepareReportPage(page, report, { brand = '小仓', expectedOrg = '' } = {}) {
  const targetRoute = normalizeRoute(report?.route);
  const openRoute = async (route) => {
    const norm = normalizeRoute(route);
    await navigateKeepingViewport(page, `${HIBO_BASE_URL}#${norm}`);
    await sleep(2500);
    await closeExportRecords(page);
    await dismissObstructions(page);
  };

  let brandUnit = '';
  const staticHeaderOrg = report?.staticHeaderOrg || '';
  if (staticHeaderOrg) {
    await openRoute('/home');
    await readHiboIdentity(page);
    brandUnit = await ensureBusinessUnit(page, { brand, expectedOrg });
    await openRoute(targetRoute);
    const identity = await readHiboIdentity(page);
    const actualOrg = await ensureBusinessUnit(page, { brand, staticHeaderOrg, expectedOrg: staticHeaderOrg });
    const actualHash = new URL(await page.url()).hash;
    if (!matchesRouteHash(actualHash, targetRoute)) {
      throw new Error(`REPORT_ROUTE_NOT_READY: 期望 ${targetRoute}，实际 ${actualHash}`);
    }
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const pageErr = detectHiboPageError(bodyText);
    if (pageErr) {
      throw new Error(`${pageErr.code}: ${pageErr.message} (${targetRoute})`);
    }
    await ensureReportTab(page, report.tabText);
    return { ...identity, brand, brandBusinessUnit: brandUnit, businessUnit: actualOrg };
  }

  await openRoute(targetRoute);
  let identity = await readHiboIdentity(page);
  const explicitExpected = expectedOrg || report.businessUnit || '';
  const currentState = await readSwitchOrgState(page);
  let actualOrg = '';
  if (!currentState?.interactive) {
    await openRoute('/home');
    await readHiboIdentity(page);
    brandUnit = await ensureBusinessUnit(page, { brand, expectedOrg: explicitExpected });
    await openRoute(targetRoute);
    identity = await readHiboIdentity(page);
    const afterState = await readSwitchOrgState(page);
    if (!afterState) throw new Error('BUSINESS_UNIT_SELECTOR_MISSING: 未找到业务单元切换控件');
    if (!afterState.interactive) {
      if (explicitExpected && afterState.text !== explicitExpected) {
        throw new Error(`BUSINESS_UNIT_STATIC_MISMATCH: 期望静态业务单元「${explicitExpected}」，当前显示「${afterState.text}」`);
      }
      actualOrg = afterState.text;
    } else {
      actualOrg = await ensureBusinessUnit(page, { brand, expectedOrg: explicitExpected });
    }
  } else {
    actualOrg = await ensureBusinessUnit(page, { brand, expectedOrg: explicitExpected });
  }
  if (!matchesRouteHash(new URL(await page.url()).hash, targetRoute)) {
    await openRoute(targetRoute);
    if (!brandUnit) {
      await ensureBusinessUnit(page, { brand, expectedOrg: actualOrg });
    }
  }
  const actualHash = new URL(await page.url()).hash;
  if (!matchesRouteHash(actualHash, targetRoute)) {
    throw new Error(`REPORT_ROUTE_NOT_READY: 期望 ${targetRoute}，实际 ${actualHash}`);
  }
  const bodyText = await page.evaluate(() => document.body?.innerText || '');
  const pageErr = detectHiboPageError(bodyText);
  if (pageErr) {
    throw new Error(`${pageErr.code}: ${pageErr.message} (${targetRoute})`);
  }
  await ensureReportTab(page, report.tabText);
  return {
    ...identity,
    brand,
    ...(brandUnit ? { brandBusinessUnit: brandUnit, staticHeaderOrg: actualOrg } : {}),
    businessUnit: actualOrg,
  };
}

function formItemByLabel(page, labelText) {
  const dom = createDomLocator(page);
  return dom.locator('.hibo-form-item:visible,.ant-form-item:visible')
    .filter({ has: dom.getByText(labelText) })
    .first();
}

async function openStoreSelector(page, item) {
  const inputSelector = [
    'input.hibo-select-selection-search-input',
    'input.ant-select-selection-search-input',
    'input[placeholder*="搜索"]',
    'input[placeholder*="门店"]',
    'input[type="search"]',
    'input[type="text"]',
  ].join(',');
  const input = item.locator(inputSelector).first();
  const selector = item.locator('.hibo-select-selector,.ant-select-selector,.hibo-cascader-picker,.ant-cascader-picker').first();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await dismissObstructions(page);
    if ((await input.count()) > 0 && (await input.getAttribute('aria-expanded')) === 'true') return input;
    try {
      if ((await selector.count()) > 0) {
        await selector.click({ timeout: 3000 });
      } else if ((await input.count()) > 0) {
        await input.click({ timeout: 3000 });
      }
      await waitForCondition({
        probe: async () => {
          if ((await input.count()) > 0 && (await input.getAttribute('aria-expanded')) === 'true') return true;
          return page.evaluate(() => {
            const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
            return [...document.querySelectorAll('.hibo-select-dropdown,.hibo-cascader-dropdown,.ant-select-dropdown,.ant-cascader-dropdown')]
              .some((d) => !d.classList.contains('hibo-select-dropdown-hidden')
                && !d.classList.contains('hibo-cascader-dropdown-hidden')
                && !d.classList.contains('ant-select-dropdown-hidden')
                && visible(d));
          });
        },
        timeoutMs: 1500,
        intervalMs: 50,
        errorMessage: 'STORE_DROPDOWN_TIMEOUT',
      });
      return input;
    } catch {
      // retry after dismissing obstructions
    }
  }
  throw new Error('STORE_DROPDOWN_NOT_OPENED: 门店下拉框未能展开');
}

export async function listAvailableStores(
  page,
  storeLabel = '门店',
  { probes = ['店', '仓', '市', '超'], walkCascader = true } = {},
) {
  const item = formItemByLabel(page, storeLabel);
  await item.waitFor({ timeout: 10000 });
  const isCascader = (await item.locator('.hibo-cascader,.ant-cascader').count()) > 0;
  const input = await openStoreSelector(page, item);

  const readVisibleOptions = () => page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const popups = [...document.querySelectorAll('.hibo-select-dropdown,.hibo-cascader-dropdown,.ant-select-dropdown,.ant-cascader-dropdown')]
      .filter((d) => !d.classList.contains('hibo-select-dropdown-hidden')
        && !d.classList.contains('hibo-cascader-dropdown-hidden')
        && !d.classList.contains('ant-select-dropdown-hidden')
        && !d.classList.contains('hibo-slide-up-leave')
        && visible(d));
    const nodes = popups.flatMap((d) => [
      ...d.querySelectorAll('.hibo-cascader-menu-item,.ant-cascader-menu-item,[role="option"],.hibo-select-item-option,.ant-select-item-option'),
    ]);
    return [...new Set(
      nodes
        .filter(visible)
        .filter((el) => {
          if (el.matches('.hibo-cascader-menu-item-expand,.ant-cascader-menu-item-expand')) return false;
          if (el.querySelector('.hibo-cascader-menu-item-expand-icon,.ant-cascader-menu-item-expand-icon')) return false;
          if (el.getAttribute('aria-expanded') === 'false') return false;
          return true;
        })
        .map((el) => String(el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter((text) => text && !text.includes('暂无数据')),
    )];
  });

  const collected = new Set();
  const collectVisibleWithScroll = async (skipFirstCascaderMenu = false) => {
    for (let step = 0; step < 80; step += 1) {
      for (const name of await readVisibleOptions()) {
        collected.add(name);
      }
      const moved = await page.evaluate((skipFirst) => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
        };
        const popups = [...document.querySelectorAll('.hibo-select-dropdown,.hibo-cascader-dropdown,.ant-select-dropdown,.ant-cascader-dropdown')]
          .filter((d) => !d.classList.contains('hibo-select-dropdown-hidden')
            && !d.classList.contains('hibo-cascader-dropdown-hidden')
            && !d.classList.contains('ant-select-dropdown-hidden')
            && !d.classList.contains('hibo-slide-up-leave')
            && visible(d));
        let anyMoved = false;
        for (const popup of popups) {
          const virtualHolders = [...popup.querySelectorAll('.rc-virtual-list-holder')].filter(visible);
          const cascaderMenus = [...popup.querySelectorAll('.hibo-cascader-menu,.ant-cascader-menu')].filter(visible);
          const containers = virtualHolders.length
            ? virtualHolders
            : (skipFirst && cascaderMenus.length > 1 ? cascaderMenus.slice(1) : cascaderMenus);
          for (const box of containers) {
            if (box.scrollHeight <= box.clientHeight + 2) continue;
            const prev = box.scrollTop;
            const delta = Math.max(120, Math.floor(box.clientHeight * 0.75));
            box.scrollTop = Math.min(box.scrollHeight, prev + delta);
            if (box.scrollTop > prev) anyMoved = true;
          }
        }
        return anyMoved;
      }, skipFirstCascaderMenu);
      if (!moved) break;
      await sleep(80);
    }
    await page.evaluate((skipFirst) => {
      const popups = [...document.querySelectorAll('.hibo-select-dropdown,.hibo-cascader-dropdown,.ant-select-dropdown,.ant-cascader-dropdown')];
      for (const popup of popups) {
        const virtualHolders = [...popup.querySelectorAll('.rc-virtual-list-holder')];
        const cascaderMenus = [...popup.querySelectorAll('.hibo-cascader-menu,.ant-cascader-menu')];
        const containers = virtualHolders.length
          ? virtualHolders
          : (skipFirst && cascaderMenus.length > 1 ? cascaderMenus.slice(1) : cascaderMenus);
        for (const box of containers) {
          box.scrollTop = 0;
        }
      }
    }, skipFirstCascaderMenu).catch(() => {});
  };

  await sleep(450);
  if (!isCascader) {
    await collectVisibleWithScroll(false);
  } else if (walkCascader) {
    const groups = new Set();
    for (let step = 0; step < 20; step += 1) {
      const batch = await page.evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
        };
        const popup = [...document.querySelectorAll('.hibo-cascader-dropdown,.ant-cascader-dropdown')]
          .find((d) => !d.classList.contains('hibo-cascader-dropdown-hidden')
            && !d.classList.contains('ant-cascader-dropdown-hidden')
            && visible(d));
        if (!popup) return { names: [], moved: false };
        const firstMenu = popup.querySelector('.hibo-cascader-menu,.ant-cascader-menu');
        if (!firstMenu || !visible(firstMenu)) return { names: [], moved: false };
        const names = [...firstMenu.querySelectorAll('.hibo-cascader-menu-item-expand,.ant-cascader-menu-item-expand')]
          .filter(visible)
          .map((el) => String(el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        let moved = false;
        if (firstMenu.scrollHeight > firstMenu.clientHeight + 2) {
          const prev = firstMenu.scrollTop;
          firstMenu.scrollTop = Math.min(firstMenu.scrollHeight, prev + Math.max(100, Math.floor(firstMenu.clientHeight * 0.75)));
          moved = firstMenu.scrollTop > prev;
        }
        return { names, moved };
      });
      for (const n of batch.names) groups.add(n);
      if (!batch.moved || groups.size >= 40) break;
      await sleep(70);
    }
    for (const groupName of [...groups].slice(0, 40)) {
      const clicked = await page.evaluate((targetGroup) => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
        };
        const popup = [...document.querySelectorAll('.hibo-cascader-dropdown,.ant-cascader-dropdown')]
          .find((d) => !d.classList.contains('hibo-cascader-dropdown-hidden')
            && !d.classList.contains('ant-cascader-dropdown-hidden')
            && visible(d));
        const firstMenu = popup?.querySelector('.hibo-cascader-menu,.ant-cascader-menu');
        if (!firstMenu) return false;
        const item = [...firstMenu.querySelectorAll('.hibo-cascader-menu-item-expand,.ant-cascader-menu-item-expand')]
          .find((el) => String(el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim() === targetGroup);
        if (!item) return false;
        item.scrollIntoView({ block: 'nearest' });
        const content = item.querySelector('.hibo-cascader-menu-item-content,.ant-cascader-menu-item-content') || item;
        content.click();
        return true;
      }, groupName);
      if (clicked) {
        await sleep(120);
        await collectVisibleWithScroll(true);
      }
    }
    await collectVisibleWithScroll(false);
  }

  for (const probe of probes) {
    await openStoreSelector(page, item);
    await input.fill(probe);
    await sleep(400);
    await collectVisibleWithScroll(false);
  }

  if (collected.size === 0) {
    await openStoreSelector(page, item);
    await input.fill('小');
    await sleep(400);
    await collectVisibleWithScroll(false);
  }

  await input.fill('').catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await input.blur().catch(() => {});
  return [...collected];
}

async function findWritableSearchInputInOpenDropdown(page) {
  const marker = crypto.randomUUID();
  const found = await page.evaluate((m) => {
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
    const dropdowns = [...document.querySelectorAll('.hibo-select-dropdown,.hibo-cascader-dropdown,.ant-select-dropdown,.ant-cascader-dropdown,[role="listbox"]')]
      .filter((d) => !d.classList.contains('hibo-select-dropdown-hidden')
        && !d.classList.contains('hibo-cascader-dropdown-hidden')
        && !d.classList.contains('ant-select-dropdown-hidden')
        && visible(d));
    const input = dropdowns
      .flatMap((d) => [...d.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([disabled]):not([readonly])')])
      .find(visible);
    if (!input) return false;
    input.setAttribute('data-xc-ego-search', m);
    return true;
  }, marker);
  if (!found) return null;
  return {
    selector: `[data-xc-ego-search="${marker}"]`,
    clearAttr: () => page.evaluate((m) => {
      document.querySelector(`[data-xc-ego-search="${m}"]`)?.removeAttribute('data-xc-ego-search');
    }, marker).catch(() => {}),
  };
}

async function resolveStoreOption(page, item, storeQuery, brand = '') {
  const input = await openStoreSelector(page, item);
  let usedInput = false;
  const dropdownInput = await findWritableSearchInputInOpenDropdown(page);
  try {
    if (dropdownInput) {
      await page.fill(dropdownInput.selector, storeQuery);
      usedInput = true;
    } else if ((await input.count()) > 0) {
      const canType = await input.evaluateAll((els) => els.some((el) => !el.disabled && !el.readOnly));
      if (canType) {
        await input.fill(storeQuery);
        usedInput = true;
      }
    }
  } finally {
    if (dropdownInput) await dropdownInput.clearAttr();
  }
  await sleep(usedInput ? 450 : 200);

  const candidates = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const popups = [...document.querySelectorAll('.hibo-select-dropdown,.hibo-cascader-dropdown,.ant-select-dropdown,.ant-cascader-dropdown,[role="listbox"]')]
      .filter((d) => !d.classList.contains('hibo-select-dropdown-hidden')
        && !d.classList.contains('hibo-cascader-dropdown-hidden')
        && !d.classList.contains('ant-select-dropdown-hidden')
        && visible(d));
    const roots = popups.length ? popups : [document];
    const nodes = roots.flatMap((root) => [...root.querySelectorAll(
      '.hibo-cascader-menu-item,.ant-cascader-menu-item,[role="option"],.hibo-select-item-option,.ant-select-item-option',
    )]);
    const seen = new Set();
    const list = [];
    for (const el of nodes) {
      if (!visible(el)) continue;
      if (el.matches('.hibo-cascader-menu-item-expand,.ant-cascader-menu-item-expand')) continue;
      if (el.querySelector('.hibo-cascader-menu-item-expand-icon,.ant-cascader-menu-item-expand-icon')) continue;
      const title = String(el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!title || title.includes('暂无数据') || seen.has(title)) continue;
      seen.add(title);
      list.push({
        title,
        checked: el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true',
      });
    }
    return list;
  });

  const exact = candidates.filter((c) => c.title === storeQuery);
  const matched = exact.length === 1
    ? exact
    : candidates.filter((c) => c.title.includes(storeQuery));

  if (matched.length === 0) {
    throw new Error(
      `STORE_NOT_FOUND: 未在当前中台（${brand || '当前业务单元'}）找到匹配门店「${storeQuery}」；请核对该门店是否属于另一中台（小仓 / 乐心宜）或确认门店名称`,
    );
  }
  if (matched.length > 1) {
    throw new Error(`STORE_AMBIGUOUS: 「${storeQuery}」匹配到多个门店 (${matched.map((m) => m.title).join(' / ')})，请给出更精确的门店名`);
  }

  const targetTitle = matched[0].title;
  const dom = createDomLocator(page);
  const quotedTitle = JSON.stringify(targetTitle);
  const byAttr = dom.locator(
    `.hibo-cascader-menu-item[title=${quotedTitle}]:visible,.ant-cascader-menu-item[title=${quotedTitle}]:visible,[role="option"][title=${quotedTitle}]:visible,.hibo-select-item-option[title=${quotedTitle}]:visible,.ant-select-item-option[title=${quotedTitle}]:visible`,
  );
  if ((await byAttr.count()) === 1) {
    return { option: byAttr, fullName: targetTitle };
  }
  const byText = dom.locator(
    '.hibo-cascader-menu-item:visible,.ant-cascader-menu-item:visible,[role="option"]:visible,.hibo-select-item-option:visible,.ant-select-item-option:visible',
  ).filter({ hasText: exactTextPattern(targetTitle) });
  await byText.waitFor({ timeout: 5000 });
  if ((await byText.count()) !== 1) {
    throw new Error(`STORE_OPTION_NOT_UNIQUE: ${targetTitle}`);
  }
  return { option: byText, fullName: targetTitle };
}

async function tryClickFormResetButton(page, timeoutMs = 1500) {
  await dismissObstructions(page);
  return waitForCondition({
    probe: async () => page.evaluate(() => {
      const norm = (val) => String(val || '').replace(/\s+/g, '');
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const btn = [...document.querySelectorAll('button,.hibo-btn,.ant-btn,[role="button"]')]
        .filter(visible)
        .filter((el) => !el.closest('[role="dialog"],.hibo-modal,.ant-modal'))
        .find((el) => norm(el.innerText || el.textContent) === '重置');
      if (!btn) return false;
      btn.click();
      return true;
    }),
    timeoutMs,
    intervalMs: 100,
    errorMessage: 'RESET_BUTTON_ABSENT',
  }).catch(() => false);
}

export async function selectStoresAndVerify(page, storeLabel, requestedStores, { brand = '', resetForm = true } = {}) {
  if (!Array.isArray(requestedStores) || !requestedStores.length) {
    throw new Error('STORE_LIST_EMPTY: 门店清单为空，禁止以留空代表全部门店');
  }

  if (resetForm !== false) {
    await tryClickFormResetButton(page);
  }
  const item = formItemByLabel(page, storeLabel);
  await waitForCondition({
    probe: async () => {
      if (!(await item.count())) return false;
      const count = await item.locator('.hibo-select-selection-item[title],.ant-select-selection-item[title]')
        .evaluateAll((els) => els.filter((el) => {
          const t = String(el.getAttribute('title') || '');
          return t && !/^\+\s*\d+/.test(t);
        }).length);
      if (count === 0) return true;
      const remove = item.locator('.hibo-select-selection-item-remove,.ant-select-selection-item-remove');
      if (await remove.count()) {
        await remove.first().activate().catch(() => {});
      }
      return false;
    },
    timeoutMs: 5000,
    intervalMs: 120,
    errorMessage: `${storeLabel}重置后仍残留已选标签`,
  });

  const resolvedNames = [];
  for (const storeQuery of requestedStores) {
    const { option, fullName } = await resolveStoreOption(page, item, storeQuery, brand);
    const isChecked = (await option.getAttribute('aria-checked')) === 'true'
      || (await option.getAttribute('aria-selected')) === 'true';
    if (!isChecked) {
      await option.activate();
      await waitForCondition({
        probe: async () => (await option.getAttribute('aria-checked')) === 'true'
          || (await option.getAttribute('aria-selected')) === 'true',
        timeoutMs: 5000,
        intervalMs: 100,
        errorMessage: `STORE_CHECK_TIMEOUT: 门店点击后未保持选中 (${fullName})`,
      });
    }
    resolvedNames.push(fullName);
  }

  await page.keyboard.press('Escape').catch(() => {});
  const searchInput = item.locator('input.hibo-select-selection-search-input,input.ant-select-selection-search-input').first();
  if ((await searchInput.count()) > 0) {
    await searchInput.blur().catch(() => {});
  }

  const selectedSnapshot = await item.locator('.hibo-select-selection-item,.ant-select-selection-item')
    .evaluateAll((els) => els
      .filter((el) => !el.closest('.hibo-select-selection-overflow-item-rest,.ant-select-selection-overflow-item-rest'))
      .map((el) => String(el.getAttribute('title') || el.textContent || '').trim())
      .filter((text) => text && !/^\+\s*\d+/.test(text)));

  const hasCollapsedOverflow = await item.locator('.hibo-select-selection-overflow-item-rest,.ant-select-selection-overflow-item-rest').count();
  const missingOnTagReadback = hasCollapsedOverflow
    ? []
    : resolvedNames.filter((name) => !selectedSnapshot.some((tag) => tag === name || tag.includes(name)));

  for (const fullName of missingOnTagReadback) {
    const { option } = await resolveStoreOption(page, item, fullName, brand);
    const isChecked = (await option.getAttribute('aria-checked')) === 'true'
      || (await option.getAttribute('aria-selected')) === 'true';
    if (!isChecked) {
      await option.activate();
      await waitForCondition({
        probe: async () => (await option.getAttribute('aria-checked')) === 'true'
          || (await option.getAttribute('aria-selected')) === 'true',
        timeoutMs: 5000,
        intervalMs: 100,
        errorMessage: `STORE_REPAIR_FAILED: 门店回读复核未选中 (${fullName})`,
      });
    }
  }

  if (missingOnTagReadback.length && (await searchInput.count()) > 0) {
    await searchInput.blur().catch(() => {});
  }
  return resolvedNames;
}

export async function selectChannelAndVerify(page, channelLabel, channelValue) {
  const requestedChannels = (Array.isArray(channelValue) ? channelValue : [channelValue])
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  if (!requestedChannels.length) throw new Error('CHANNEL_EMPTY: 必须指定渠道');

  const dom = createDomLocator(page);
  const item = dom.locator('.hibo-form-item:visible,.ant-form-item:visible').filter({ has: dom.getByText(channelLabel) });
  if ((await item.count()) !== 1) throw new Error(`CHANNEL_CONTROL_MISSING: ${channelLabel}`);

  const selected = item.locator('.hibo-select-selection-item,.ant-select-selection-item');
  const readSelected = () => selected.evaluateAll((els) => els
    .filter((el) => !el.closest('.hibo-select-selection-overflow-item-rest,.ant-select-selection-overflow-item-rest'))
    .map((el) => (el.getAttribute('title') || el.textContent || '').trim())
    .filter((text) => text && !/^\+\s*\d+/.test(text)));

  const isExact = (vals) => vals.length === requestedChannels.length
    && requestedChannels.every((target) => vals.includes(target));

  if (!isExact(await readSelected())) {
    const remove = item.locator('.hibo-select-selection-item-remove,.ant-select-selection-item-remove');
    for (let guard = 10; guard > 0 && (await remove.count()); guard -= 1) {
      await remove.first().activate();
    }
    await item.locator('.hibo-select-selector,.ant-select-selector').click();
    const listId = await item.locator('input[aria-controls]').getAttribute('aria-controls');
    const dropdown = listId
      ? dom.locator('.hibo-select-dropdown:visible,.ant-select-dropdown:visible')
        .filter({ has: dom.locator(`[id=${JSON.stringify(listId)}]`) })
      : dom.locator('.hibo-select-dropdown:visible,.ant-select-dropdown:visible').last();

    const searchInput = item.locator('input.hibo-select-selection-search-input,input.ant-select-selection-search-input').first();
    const canTypeInChannel = (await searchInput.count()) > 0
      && await searchInput.evaluateAll((els) => els.some((el) => !el.disabled && !el.readOnly));

    for (const ch of requestedChannels) {
      if (canTypeInChannel) {
        await searchInput.fill(ch);
        await sleep(250);
      }
      const option = dropdown.locator('.hibo-select-item-option:visible,.ant-select-item-option:visible,[role="option"]:visible')
        .filter({ hasText: exactTextPattern(ch) });
      await option.waitFor({ timeout: 5000 });
      if ((await option.count()) !== 1) throw new Error(`CHANNEL_OPTION_NOT_UNIQUE: ${ch}`);
      await option.activate();
    }
    await waitForCondition({
      probe: async () => isExact(await readSelected()),
      timeoutMs: 5000,
      intervalMs: 100,
      errorMessage: `CHANNEL_VERIFY_FAILED: ${channelLabel} 期望选中「${requestedChannels.join('、')}」`,
    });
  }
  await page.keyboard.press('Escape').catch(() => {});
  const chInput = item.locator('input').first();
  if ((await chInput.count()) > 0) {
    await chInput.blur().catch(() => {});
  }
  const finalVals = await readSelected();
  if (!isExact(finalVals)) throw new Error(`CHANNEL_MISMATCH: 实际为 ${finalVals.join('、')}`);
  return Array.isArray(channelValue) ? finalVals : finalVals[0];
}

function findRangePickerLocator(page, label = '') {
  const dom = createDomLocator(page);
  if (label) {
    return dom.locator('.hibo-form-item:visible,.ant-form-item:visible')
      .filter({ has: dom.getByText(label) })
      .first()
      .locator('.hibo-picker-range:visible,.ant-picker-range:visible')
      .first();
  }
  return dom.locator('.hibo-picker-range:visible,.ant-picker-range:visible');
}

export async function verifyDateRangeInputs(page, { startDate = '', endDate = '', label = '' } = {}) {
  const picker = findRangePickerLocator(page, label);
  await picker.waitFor({ timeout: 8000 });
  if (!label && (await picker.count()) !== 1) {
    throw new Error('DATE_PICKER_NOT_UNIQUE: 页面存在多个日期选择器，请指定 label');
  }
  const values = await picker.locator('input').evaluateAll((els) => els.map((el) => String(el.value || '').trim()));
  const startValue = values[0] || '';
  const endValue = values[1] || '';
  if (startDate && !startValue.startsWith(startDate)) {
    throw new Error(`DATE_RANGE_MISMATCH: 开始日期期望 ${startDate}，实际为「${startValue}」`);
  }
  if (endDate && !endValue.startsWith(endDate)) {
    throw new Error(`DATE_RANGE_MISMATCH: 结束日期期望 ${endDate}，实际为「${endValue}」`);
  }
  return { startValue, endValue };
}

async function pickDateInOpenDropdown(page, targetIso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(targetIso);
  if (!match) throw new Error(`DATE_FORMAT_INVALID: 期望 YYYY-MM-DD，收到「${targetIso}」`);
  const targetYear = Number(match[1]);
  const targetMonth = Number(match[2]);

  for (let step = 0; step < 36; step += 1) {
    const res = await page.evaluate((iso) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const dropdown = [...document.querySelectorAll('.hibo-picker-dropdown,.ant-picker-dropdown')]
        .find((d) => !d.classList.contains('hibo-picker-dropdown-hidden')
          && !d.classList.contains('ant-picker-dropdown-hidden')
          && visible(d));
      if (!dropdown) return { status: 'no_dropdown' };
      const cell = [...dropdown.querySelectorAll(`td.hibo-picker-cell-in-view[title="${iso}"],td.ant-picker-cell-in-view[title="${iso}"]`)]
        .find((td) => visible(td)
          && !td.classList.contains('hibo-picker-cell-disabled')
          && !td.classList.contains('ant-picker-cell-disabled'));
      if (cell) {
        const inner = cell.querySelector('.hibo-picker-cell-inner,.ant-picker-cell-inner') || cell;
        inner.click();
        return { status: 'clicked' };
      }
      const headerView = dropdown.querySelector('.hibo-picker-header-view,.ant-picker-header-view');
      const headerText = String(headerView?.innerText || headerView?.textContent || '').replace(/\s+/g, ' ').trim();
      return { status: 'need_nav', headerText };
    }, targetIso);

    if (res.status === 'clicked') return true;
    if (res.status === 'no_dropdown') throw new Error('DATE_DROPDOWN_CLOSED_UNEXPECTEDLY');

    let curYear = null;
    let curMonth = null;
    const cnMatch = /(\d{4})\s*年\s*(\d{1,2})\s*月?/.exec(res.headerText);
    const isoHeaderMatch = /(\d{4})[-/](\d{1,2})/.exec(res.headerText);
    if (cnMatch) {
      curYear = Number(cnMatch[1]);
      curMonth = Number(cnMatch[2]);
    } else if (isoHeaderMatch) {
      curYear = Number(isoHeaderMatch[1]);
      curMonth = Number(isoHeaderMatch[2]);
    } else {
      const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      const enMatch = /([A-Za-z]{3,})\s+(\d{4})/.exec(res.headerText);
      if (enMatch) {
        const idx = months.findIndex((m) => enMatch[1].toLowerCase().startsWith(m));
        if (idx >= 0) {
          curMonth = idx + 1;
          curYear = Number(enMatch[2]);
        }
      }
    }
    if (!curYear || !curMonth) {
      throw new Error(`DATE_HEADER_UNREADABLE: 无法解析日历表头「${res.headerText}」`);
    }
    const diff = (targetYear - curYear) * 12 + (targetMonth - curMonth);
    const navAction = diff <= -12
      ? 'super-prev'
      : diff < 0
        ? 'prev'
        : diff >= 12
          ? 'super-next'
          : 'next';
    const navClicked = await page.evaluate((action) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const dropdown = [...document.querySelectorAll('.hibo-picker-dropdown,.ant-picker-dropdown')]
        .find((d) => !d.classList.contains('hibo-picker-dropdown-hidden')
          && !d.classList.contains('ant-picker-dropdown-hidden')
          && visible(d));
      if (!dropdown) return false;
      const btn = [...dropdown.querySelectorAll(`.hibo-picker-header-${action}-btn,.ant-picker-header-${action}-btn`)].find(visible);
      if (!btn) return false;
      btn.click();
      return true;
    }, navAction);
    if (!navClicked) throw new Error(`DATE_NAV_BUTTON_MISSING: ${navAction}`);
    await sleep(150);
  }
  throw new Error(`DATE_CELL_NOT_FOUND: 未在日历面板找到日期 ${targetIso}`);
}

async function clickOpenDateOkButton(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const dropdown = [...document.querySelectorAll('.hibo-picker-dropdown,.ant-picker-dropdown')]
      .find((d) => !d.classList.contains('hibo-picker-dropdown-hidden')
        && !d.classList.contains('ant-picker-dropdown-hidden')
        && visible(d));
    if (!dropdown) return false;
    const btn = [...dropdown.querySelectorAll('.hibo-picker-ok button,.ant-picker-ok button,.hibo-picker-footer button,.ant-picker-footer button')]
      .filter(visible)
      .find((b) => !b.disabled && /^确\s*定$/.test((b.innerText || b.textContent || '').trim()));
    if (!btn) return false;
    btn.click();
    return true;
  });
}

export async function selectDateRangeAndVerify(
  page,
  { startDate = '', endDate = '', quickLabel = '', label = '', timeoutMs = 20000 } = {},
) {
  const effectiveTimeout = Math.max(Number(timeoutMs) || 20000, 15000);
  await dismissObstructions(page);

  if (quickLabel) {
    const clicked = await page.evaluate((targetText) => {
      const norm = (v) => String(v || '').replace(/\s+/g, '');
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const el = [...document.querySelectorAll('button,.hibo-btn,.ant-btn,.hibo-tag,.ant-tag,label,span,a')]
        .filter(visible)
        .filter((node) => !node.closest('[role="dialog"],.hibo-modal,.ant-modal'))
        .find((node) => norm(node.innerText || node.textContent) === norm(targetText));
      if (!el) return false;
      el.click();
      return true;
    }, quickLabel);
    if (!clicked) throw new Error(`DATE_QUICK_BUTTON_NOT_FOUND: 未找到快捷日期「${quickLabel}」`);
    await sleep(400);
    const verified = await verifyDateRangeInputs(page, { label });
    if (!verified.startValue || !verified.endValue) {
      throw new Error(`DATE_QUICK_EMPTY: 点击「${quickLabel}」后日期输入框为空`);
    }
    return { quickLabel, ...verified };
  }

  if (!startDate || !endDate) {
    throw new Error('DATE_RANGE_REQUIRED: 必须提供 quickLabel 或 startDate + endDate');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error(`DATE_FORMAT_INVALID: 期望 YYYY-MM-DD，收到 ${startDate} ~ ${endDate}`);
  }
  if (startDate > endDate) {
    throw new Error(`DATE_RANGE_INVALID: 开始日期 ${startDate} 晚于结束日期 ${endDate}`);
  }

  const picker = findRangePickerLocator(page, label);
  await picker.waitFor({ timeout: 10000 });
  if (!label && (await picker.count()) !== 1) {
    throw new Error('DATE_PICKER_NOT_UNIQUE: 页面存在多个日期选择器，请指定 label');
  }
  const startInput = picker.locator('input').first();
  const endInput = picker.locator('input').last();
  const inputsWritable = await picker.locator('input').evaluateAll(
    (els) => els.length >= 2 && els.every((el) => !el.disabled && !el.readOnly),
  ).catch(() => false);
  if (inputsWritable) {
    try {
      await startInput.click({ timeout: 5000 });
      await startInput.fill(startDate);
      await startInput.press('Enter').catch(() => {});
      await sleep(120);
      await endInput.click({ timeout: 5000 });
      await endInput.fill(endDate);
      await endInput.press('Enter').catch(() => {});
      await sleep(150);
      await clickOpenDateOkButton(page).catch(() => false);
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(200);
      return await verifyDateRangeInputs(page, { startDate, endDate, label });
    } catch {
      // Direct typing did not stick; fall back to calendar panel selection
    }
  }

  await startInput.click({ timeout: 5000 });

  await waitForCondition({
    probe: async () => page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const dropdown = [...document.querySelectorAll('.hibo-picker-dropdown,.ant-picker-dropdown')]
        .find((d) => !d.classList.contains('hibo-picker-dropdown-hidden')
          && !d.classList.contains('ant-picker-dropdown-hidden')
          && visible(d));
      return Boolean(dropdown && [...dropdown.querySelectorAll('td[title]')].some(visible));
    }),
    timeoutMs: effectiveTimeout,
    intervalMs: 120,
    errorMessage: `DATE_DROPDOWN_TIMEOUT: 日期选择器未在 ${effectiveTimeout}ms 内展开`,
  });

  await pickDateInOpenDropdown(page, startDate);
  const hasTimePanel = await page.evaluate(() => {
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const dropdown = [...document.querySelectorAll('.hibo-picker-dropdown,.ant-picker-dropdown')]
      .find((d) => !d.classList.contains('hibo-picker-dropdown-hidden')
        && !d.classList.contains('ant-picker-dropdown-hidden')
        && visible(d));
    return Boolean(dropdown?.querySelector('.hibo-picker-time-panel,.ant-picker-time-panel'));
  });
  if (hasTimePanel) {
    await clickOpenDateOkButton(page);
  }
  await sleep(200);

  await pickDateInOpenDropdown(page, endDate);
  await sleep(150);
  await clickOpenDateOkButton(page);

  await waitForCondition({
    probe: async () => !(await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      return [...document.querySelectorAll('.hibo-picker-dropdown,.ant-picker-dropdown')]
        .some((d) => !d.classList.contains('hibo-picker-dropdown-hidden')
          && !d.classList.contains('ant-picker-dropdown-hidden')
          && visible(d));
    })),
    timeoutMs: 8000,
    intervalMs: 100,
    errorMessage: 'DATE_DROPDOWN_CLOSE_TIMEOUT: 日期选择器未关闭，可能遮挡查询按钮',
  });

  return verifyDateRangeInputs(page, { startDate, endDate, label });
}

export async function queryTableAndReadCount(page, timeoutMs = 60000) {
  const dom = createDomLocator(page);
  const queryBtn = dom.locator('button:visible,.hibo-btn:visible,.ant-btn:visible')
    .filter({ hasText: /^\s*查\s*询\s*$/ });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const key = `xc_ego_query_${crypto.randomUUID()}`;
    const deadline = Date.now() + timeoutMs;
    try {
      await waitForCondition({
        probe: async () => page.evaluate((k) => {
          const visible = (el) => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
          const tableRoots = [...document.querySelectorAll('.hibo-table-wrapper,.ant-table-wrapper')]
            .filter((el) => visible(el) && !el.closest('[role="dialog"],.hibo-modal,.ant-modal'));
          const pagTotals = [...document.querySelectorAll('.hibo-pagination-total-text,.ant-pagination-total-text')]
            .filter((el) => visible(el) && !el.closest('[role="dialog"],.hibo-modal,.ant-modal'));
          let root;
          let scopeRoot;
          let loadingRoot;
          if (tableRoots.length === 1) {
            root = tableRoots[0];
            scopeRoot = root.closest('.hibo-module-card,.ant-card,.resource-list.table-online-goods-page,.resource-list.table-store-goods-page,.active-list-page>.bg-common,.order-manage-table-page') || root;
            loadingRoot = root.parentElement?.closest('.hibo-spin-nested-loading,.ant-spin-nested-loading') || root;
          } else if (pagTotals.length === 1) {
            scopeRoot = pagTotals[0].closest('.order-manage-table-page,.hibo-module-card,.ant-card,[class*="table-page"],[class*="list-page"]')
              || pagTotals[0].closest('.hibo-cache-route')
              || pagTotals[0].parentElement?.parentElement;
            if (!scopeRoot) throw new Error('QUERY_TABLE_SCOPE_UNVERIFIED');
            root = scopeRoot;
            loadingRoot = scopeRoot.querySelector('.hibo-spin-nested-loading,.ant-spin-nested-loading')
              || scopeRoot.closest('.hibo-spin-nested-loading,.ant-spin-nested-loading')
              || scopeRoot;
          } else {
            scopeRoot = document.querySelector('.hibo-cache-route,.ant-layout-content,main') || document.body;
            root = tableRoots[0] || scopeRoot;
            loadingRoot = scopeRoot.querySelector('.hibo-spin-nested-loading,.ant-spin-nested-loading') || scopeRoot;
          }

          const busy = () => root.getAttribute('aria-busy') === 'true'
            || loadingRoot.getAttribute('aria-busy') === 'true'
            || [...loadingRoot.querySelectorAll('.hibo-spin-spinning,.ant-spin-spinning,[aria-busy="true"]')].some(visible);
          if (busy()) return false;
          const initialTotalEl = [...scopeRoot.querySelectorAll('.hibo-pagination-total-text,.ant-pagination-total-text')].find(visible);
          const initialTotalText = initialTotalEl ? (initialTotalEl.innerText || '').trim() : '';
          const state = {
            root,
            scopeRoot,
            loadingRoot,
            initialTotalText,
            startedAt: Date.now(),
            sawLoading: false,
            lastMutation: Date.now(),
            busy,
            visible,
          };
          state.observer = new MutationObserver(() => {
            state.sawLoading ||= busy();
            state.lastMutation = Date.now();
          });
          state.observer.observe(scopeRoot.contains(loadingRoot) ? scopeRoot : loadingRoot, {
            subtree: true, childList: true, attributes: true, characterData: true,
          });
          globalThis[k] = state;
          return true;
        }, key),
        timeoutMs: 15000,
        intervalMs: 60,
        errorMessage: 'QUERY_PREVIOUS_LOAD_UNFINISHED',
      });

      await queryBtn.activate();

      while (Date.now() < deadline) {
        const result = await page.evaluate((k) => {
          const cur = globalThis[k];
          if (!cur?.root?.isConnected) throw new Error('QUERY_TABLE_REPLACED');
          if (cur.busy() || Date.now() - cur.lastMutation < 150) return null;
          if ((document.body?.innerText || '').includes('当前网络环境较差')) return { networkError: true };
          const totals = [...cur.scopeRoot.querySelectorAll('.hibo-pagination-total-text,.ant-pagination-total-text')]
            .filter(cur.visible);
          const currentTotalText = totals.length === 1 ? (totals[0].innerText || '').trim() : '';
          const settledByTimeOrChange = (cur.initialTotalText && currentTotalText !== cur.initialTotalText)
            || (Date.now() - cur.startedAt >= 2500);
          if (!cur.sawLoading && !settledByTimeOrChange) return null;
          if (totals.length === 1) {
            const matches = [...currentTotalText.matchAll(/共\s*([\d,]+)\s*条/g)];
            if (matches.length === 1) {
              const rowCount = Number(matches[0][1].replace(/,/g, ''));
              return { rowCount, empty: rowCount === 0, countSource: 'pagination', networkError: false };
            }
          }
          const visibleRows = [...cur.scopeRoot.querySelectorAll('.hibo-table-tbody tr:not(.hibo-table-measure-row),.ant-table-tbody tr:not(.ant-table-measure-row)')]
            .filter((tr) => cur.visible(tr) && !tr.classList.contains('hibo-table-placeholder') && !tr.classList.contains('ant-table-placeholder'));
          if (visibleRows.length > 0) {
            return { rowCount: visibleRows.length, empty: false, countSource: 'visible_rows', networkError: false };
          }
          const hasEmptyPlaceholder = Boolean(cur.scopeRoot.querySelector('.hibo-empty,.ant-empty,.hibo-table-placeholder,.ant-table-placeholder'));
          if (hasEmptyPlaceholder) {
            return { rowCount: 0, empty: true, countSource: 'empty_placeholder', networkError: false };
          }
          return { rowCount: null, empty: false, countSource: 'unavailable', networkError: false };
        }, key);

        if (result?.networkError) {
          if (attempt === 1) {
            await sleep(1500);
            break;
          }
          throw new Error('QUERY_NETWORK_ERROR: 海博提示当前网络环境较差');
        }
        if (result) return result;
        await sleep(60);
      }
      if (Date.now() >= deadline) throw new Error('QUERY_TIMEOUT: 查询未在超时前完成');
    } finally {
      await page.evaluate((k) => {
        globalThis[k]?.observer?.disconnect();
        delete globalThis[k];
      }, key).catch(() => {});
    }
  }
  throw new Error('QUERY_FAILED: 查询重试后仍未成功');
}

async function acceptExportDialogs(page) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await modalHasExportRecords(page)) return;
    await dismissObstructions(page);
    if (await modalHasExportRecords(page)) return;
    const customTip = await page.evaluate(() => {
      const norm = (val) => String(val || '').replace(/\s+/g, '');
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const modal = [...document.querySelectorAll('.field-customExport-tipDialog,.hibo-modal-wrap,.ant-modal-wrap')]
        .filter(visible)
        .find((el) => (el.innerText || '').includes('不设置，继续导出'));
      if (!modal) return false;
      const btn = [...modal.querySelectorAll('button,.hibo-btn,.ant-btn,a,span')]
        .filter(visible)
        .find((el) => norm(el.innerText || el.textContent) === '不设置，继续导出');
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (customTip) {
      await sleep(700);
      continue;
    }

    const confirmed = await page.evaluate(() => {
      const norm = (val) => String(val || '').replace(/\s+/g, '');
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const modals = [...document.querySelectorAll('.hibo-modal-wrap,.ant-modal-wrap,.zt-dialog-wrapper,.zt-dialog,.hibo-modal-root,.ant-modal-root,[role="dialog"]')]
        .filter(visible);
      const modal = modals.find((el) => {
        const t = el.innerText || '';
        return t.includes('导出') || t.includes('是否进入');
      });
      const root = modal || ((document.body?.innerText || '').includes('导出操作进行中') ? document : null);
      if (!root) return false;
      const btn = [...root.querySelectorAll('button,.hibo-btn,.ant-btn')]
        .filter(visible)
        .find((el) => ['确定', '确认'].includes(norm(el.innerText || el.textContent)));
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (confirmed) {
      await sleep(700);
      if (await modalHasExportRecords(page)) return;
    } else {
      await sleep(400);
    }
  }
}

async function openExportRecords(page, report) {
  if (await modalHasExportRecords(page)) return;
  const waitRecords = () => waitForCondition({
    probe: () => modalHasExportRecords(page),
    timeoutMs: 6000,
    errorMessage: '导出记录弹层未打开',
  });
  if (report.recordMenuText && report.recordButtons?.length) {
    const item = await openDropdownMenuItem(page, report.recordButtons[0], report.recordMenuText);
    await item.activate();
    await waitRecords();
    return;
  }
  const labels = report.recordButtons?.length ? report.recordButtons : ['导出记录', '导入导出记录'];
  for (const label of labels) {
    try {
      await clickVisibleButtonByText(page, label);
      return await waitRecords();
    } catch {
      // If it is a dropdown trigger like 「导入导出记录」, try its menu item 「导出记录」
      try {
        const item = await openDropdownMenuItem(page, label, '导出记录');
        await item.activate();
        return await waitRecords();
      } catch {
        // try next label
      }
    }
  }
  throw new Error('OPEN_EXPORT_RECORDS_FAILED: 未能打开导出记录');
}

async function refreshExportRecords(page) {
  const refreshed = await page.evaluate(() => {
    const norm = (val) => String(val || '').replace(/\s+/g, '');
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const modal = [...document.querySelectorAll('.hibo-modal-wrap,.ant-modal-wrap,.zt-dialog-wrapper,.zt-dialog,[role="dialog"]')]
      .filter(visible)
      .find((el) => {
        const text = el.innerText || '';
        if (el.classList.contains('hibo-export-record-dialog')) return true;
        const hasTitle = /(导入导出记录|导出记录)/.test(text);
        const hasRecordSignals = /(创建时间|操作日期|任务名称|导出状态|下载|暂无数据)/.test(text)
          || Boolean(el.querySelector('table,.hibo-table,.ant-table'));
        return hasTitle && hasRecordSignals;
      });
    if (!modal) return false;
    const btn = [...modal.querySelectorAll('button,.hibo-btn,.ant-btn')]
      .filter(visible)
      .find((el) => norm(el.innerText || el.textContent) === '查询');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!refreshed) return false;
  await sleep(700);
  return true;
}

export function buildExportRecordSignature(row) {
  const text = String(row?.text || '').replace(/\s+/g, ' ').trim();
  return `${Number(row?.created || 0)}::${text}`;
}

export function filterMatchingExportRows(
  rows,
  {
    hints = [],
    startedAt = 0,
    operators = [],
    excludedSignatures = [],
    clockSkewMs = 15000,
  } = {},
) {
  const cleanHints = Array.isArray(hints) ? hints.filter(Boolean) : [];
  const cleanOps = Array.isArray(operators) ? operators.filter(Boolean) : [];
  const excludedSet = new Set(Array.isArray(excludedSignatures) ? excludedSignatures.filter(Boolean) : []);
  const timeValid = (Array.isArray(rows) ? rows : [])
    .filter((item) => item?.text && !excludedSet.has(buildExportRecordSignature(item)))
    .filter((item) => !startedAt || (item.created && item.created >= startedAt - clockSkewMs));

  const owned = cleanOps.length
    ? timeValid.filter((item) => cleanOps.some((op) => item.text.includes(op)))
    : timeValid;
  const basePool = owned.length ? owned : (cleanOps.length ? [] : timeValid);
  if (!basePool.length) return null;

  const hintMatched = cleanHints.length
    ? basePool.filter((item) => cleanHints.some((h) => item.text.includes(h)))
    : [];
  const usingHintFallback = cleanHints.length > 0 && hintMatched.length === 0;
  const pool = (hintMatched.length ? hintMatched : basePool)
    .slice()
    .sort((a, b) => b.created - a.created);

  const newestTime = pool[0].created;
  const tied = pool.filter((m) => m.created === newestTime);
  if (tied.length > 1) {
    throw new Error(`EXPORT_RECORD_AMBIGUOUS: 存在多条创建时间相同的候选导出记录：${tied.map((t) => t.text).join(' | ')}`);
  }
  return usingHintFallback ? { ...pool[0], hintFallback: true } : pool[0];
}

async function loadRecentDeliveredSignatures(recentExportsPath = DEFAULT_RECENT_EXPORTS_PATH, nowMs = Date.now()) {
  try {
    const raw = await fs.readFile(recentExportsPath, 'utf8');
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) return [];
    return items
      .filter((entry) => entry?.sig && Number(entry.deliveredAtMs) >= nowMs - 30 * 60 * 1000)
      .map((entry) => entry.sig);
  } catch {
    return [];
  }
}

async function recordDeliveredSignature(row, recentExportsPath = DEFAULT_RECENT_EXPORTS_PATH, nowMs = Date.now()) {
  const sig = buildExportRecordSignature(row);
  if (!sig || sig.startsWith('0::')) return;
  try {
    let items = [];
    try {
      const raw = await fs.readFile(recentExportsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      items = [];
    }
    const cutoff = nowMs - 30 * 60 * 1000;
    const next = [
      ...items.filter((entry) => entry?.sig && entry.sig !== sig && Number(entry.deliveredAtMs) >= cutoff),
      { sig, deliveredAtMs: nowMs },
    ].slice(-30);
    await fs.mkdir(path.dirname(recentExportsPath), { recursive: true });
    const tmp = `${recentExportsPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, recentExportsPath);
  } catch {
    // Best-effort tracking only; never fail export delivery on history write errors.
  }
}

async function findMatchingExportRow(page, { hints, submittedAt, operatorNames, excludedSignatures = [] }) {
  const snapshot = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const parseCreatedAt = (text) => {
      const m = String(text).match(/创建时间[:：]\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/)
        || String(text).match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
      if (!m) return 0;
      const normalized = m[2] ? `${m[1]}T${m[2]}+08:00` : `${m[1].replace(' ', 'T')}+08:00`;
      const ms = new Date(normalized).getTime();
      return Number.isNaN(ms) ? 0 : ms;
    };
    const modal = [...document.querySelectorAll('.hibo-modal-wrap,.ant-modal-wrap,.zt-dialog-wrapper,.zt-dialog,[role="dialog"]')]
      .filter(visible)
      .find((el) => {
        const text = el.innerText || '';
        if (el.classList.contains('hibo-export-record-dialog')) return true;
        const hasTitle = /(导入导出记录|导出记录)/.test(text);
        const hasRecordSignals = /(创建时间|操作日期|任务名称|导出状态|下载|暂无数据)/.test(text)
          || Boolean(el.querySelector('table,.hibo-table,.ant-table'));
        return hasTitle && hasRecordSignals;
      });
    if (!modal) return { hasModal: false, rows: [] };

    const rows = [...modal.querySelectorAll('.hibo-table-tbody tr,.ant-table-tbody tr,table tr')]
      .filter(visible)
      .map((row, rowIndex) => {
        const text = String(row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim();
        const icon = row.querySelector('.hibo-export-record-download-icon,[class*="download-icon"],[class*="downloadIcon"],.anticon-download,a');
        return {
          rowIndex,
          text: text.slice(0, 260),
          created: parseCreatedAt(text),
          completed: text.includes('完成'),
          failed: text.includes('失败') || text.includes('已中断'),
          hasDownloadIcon: Boolean(icon && visible(icon)),
        };
      });
    return { hasModal: true, rows };
  });

  const matched = filterMatchingExportRows(snapshot.rows, {
    hints,
    startedAt: submittedAt,
    operators: operatorNames,
    excludedSignatures,
  });
  return { hasModal: snapshot.hasModal, totalRows: snapshot.rows.length, matched };
}

async function waitForBrowserDownloadComplete(statusPage, filePath, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const row = await statusPage.evaluate((expectedPath) => {
      const rows = document.querySelector('downloads-manager')?.shadowRoot?.querySelectorAll('downloads-item') || [];
      const norm = (v) => String(v || '').replaceAll('\\', '/').toLowerCase();
      const hit = [...rows].map((r) => r.data).filter((item) => norm(item?.filePath) === norm(expectedPath));
      if (hit.length !== 1) return null;
      const { state, lastReasonText, isDangerous, isInsecure, fileExternallyRemoved } = hit[0];
      return { state, reason: lastReasonText, isDangerous, isInsecure, fileExternallyRemoved };
    }, filePath);
    if (row) {
      if (row.state === 2 && !row.isDangerous && !row.isInsecure && !row.fileExternallyRemoved && !row.reason) {
        return;
      }
      if (row.reason || row.isDangerous || row.isInsecure || row.fileExternallyRemoved || ![0, 1].includes(row.state)) {
        throw new Error(`DOWNLOAD_SECURITY_BLOCKED: ${path.basename(filePath)} ${JSON.stringify(row)}`);
      }
    }
    await sleep(200);
  } while (Date.now() < deadline);
  throw new Error(`DOWNLOAD_STATE_TIMEOUT: 未在 chrome://downloads/ 确认完成 (${path.basename(filePath)})`);
}

async function saveCompletedDownload(task, page, matchedRow, destinationPath) {
  const activateDownload = async () => {
    const clicked = await page.evaluate(({ targetText, rowIndex }) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const modal = [...document.querySelectorAll('.hibo-modal-wrap,.ant-modal-wrap,.zt-dialog-wrapper,.zt-dialog,[role="dialog"]')]
        .filter(visible)
        .find((el) => {
          const text = el.innerText || '';
          if (el.classList.contains('hibo-export-record-dialog')) return true;
          const hasTitle = /(导入导出记录|导出记录)/.test(text);
          const hasRecordSignals = /(创建时间|操作日期|任务名称|导出状态|下载|暂无数据)/.test(text)
            || Boolean(el.querySelector('table,.hibo-table,.ant-table'));
          return hasTitle && hasRecordSignals;
        });
      if (!modal) return false;
      const rows = [...modal.querySelectorAll('.hibo-table-tbody tr,.ant-table-tbody tr,table tr')].filter(visible);
      const exactMatches = rows.filter(
        (r) => String(r.innerText || r.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 260) === targetText,
      );
      const targetRow = exactMatches.length === 1 ? exactMatches[0] : rows[rowIndex];
      if (!targetRow) return false;
      const icon = targetRow.querySelector('.hibo-export-record-download-icon,[class*="download-icon"],[class*="downloadIcon"],.anticon-download,a');
      if (!icon || !visible(icon)) return false;
      (icon.closest('a,button') || icon).click();
      return true;
    }, { targetText: matchedRow.text, rowIndex: matchedRow.rowIndex });
    if (!clicked) throw new Error('DOWNLOAD_ICON_NOT_UNIQUE: 未能定位匹配记录行的下载图标');
  };

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    activateDownload(),
  ]);

  const tempPath = await download.path();
  if (!tempPath || !path.isAbsolute(tempPath)) {
    throw new Error('DOWNLOAD_TEMP_PATH_MISSING: Ego 未返回下载临时路径');
  }

  const size = await page.evaluate(() => ({ width: innerWidth || 1524, height: innerHeight || 750 }));
  const statusPage = await task.newPage();
  try {
    await statusPage.cdp('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 0, mobile: false });
    await statusPage.goto('chrome://downloads/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await waitForBrowserDownloadComplete(statusPage, tempPath);
  } finally {
    await statusPage.close().catch(() => {});
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const partialPath = `${destinationPath}.${process.pid}.part`;
  try {
    await download.saveAs(partialPath);
    await fs.rename(partialPath, destinationPath);
  } finally {
    await fs.rm(partialPath, { force: true }).catch(() => {});
  }
  await download.delete().catch(() => {});
}

async function pollAndDownload(page, task, {
  reportKey,
  report,
  operatorNames,
  submittedAt,
  recoveryPath,
  destinationPath,
  excludedSignatures = [],
  recentExportsPath = DEFAULT_RECENT_EXPORTS_PATH,
  timeoutMinutes = 20,
}) {
  const timeoutMs = Number(timeoutMinutes) * 60000;
  const started = Date.now();
  let lastRefresh = 0;
  let consecutiveReopenFailures = 0;

  while (Date.now() - started < timeoutMs) {
    await dismissObstructions(page);
    if (!(await modalHasExportRecords(page))) {
      try {
        await openExportRecords(page, report);
        consecutiveReopenFailures = 0;
      } catch (err) {
        consecutiveReopenFailures += 1;
        if (consecutiveReopenFailures >= 3) {
          throw new Error(`EXPORT_RECORDS_REOPEN_STUCK: 连续 ${consecutiveReopenFailures} 次打开导出记录失败 (${err.message})，请检查页面后凭 _recovery.json 继续`);
        }
        await sleep(2000);
        continue;
      }
    } else {
      consecutiveReopenFailures = 0;
    }

    let lookup = await findMatchingExportRow(page, {
      hints: report.recordHints,
      submittedAt,
      operatorNames,
      excludedSignatures,
    });
    if (lookup.hasModal && (lookup.totalRows === 0 || Date.now() - lastRefresh >= 10000)) {
      if (await refreshExportRecords(page)) {
        lastRefresh = Date.now();
        lookup = await findMatchingExportRow(page, {
          hints: report.recordHints,
          submittedAt,
          operatorNames,
          excludedSignatures,
        });
      }
    }
    const row = lookup.matched;
    if (row) {
      if (row.failed) throw new Error(`HIBO_EXPORT_FAILED: ${row.text}`);
      if (row.completed && row.hasDownloadIcon) {
        await saveCompletedDownload(task, page, row, destinationPath);
        const xlsxInfo = await verifyXlsxFile(destinationPath);
        await recordDeliveredSignature(row, recentExportsPath);
        if (recoveryPath) {
          const prev = JSON.parse(await fs.readFile(recoveryPath, 'utf8'));
          await fs.writeFile(recoveryPath, JSON.stringify({
            ...prev,
            status: 'delivered',
            deliveredFile: destinationPath,
            deliveredAt: new Date().toISOString(),
          }, null, 2), 'utf8');
        }
        await closeExportRecords(page).catch(() => {});
        return {
          reportKey,
          file: destinationPath,
          size: xlsxInfo.size,
          entryCount: xlsxInfo.entryCount,
          recordText: row.text,
        };
      }
    }
    await sleep(3000);
  }
  throw new Error(`EXPORT_POLL_TIMEOUT: ${reportKey} 导出等待超时，请勿重新点击导出，使用 resume 凭证继续领取 (${recoveryPath})`);
}

export async function submitExportAndRecover(page, task, options) {
  const {
    reportKey = 'hibo-report',
    report,
    brand = '小仓',
    brandBusinessUnit = '',
    businessUnit = '',
    operatorNames,
    recoveryPath,
    destinationPath,
    recentExportsPath = DEFAULT_RECENT_EXPORTS_PATH,
    timeoutMinutes,
  } = options || {};
  if (!report?.route) {
    throw new Error('EXPORT_REPORT_ROUTE_REQUIRED: 提交导出前必须提供 report.route');
  }
  if (!recoveryPath) {
    throw new Error('RECOVERY_PATH_REQUIRED: 提交导出前必须提供 recoveryPath 以防重导');
  }
  if (!destinationPath) {
    throw new Error('DESTINATION_PATH_REQUIRED: 提交导出前必须提供 destinationPath');
  }
  const normalizedOperators = Array.isArray(operatorNames) ? operatorNames.filter(Boolean) : [];
  if (!normalizedOperators.length) {
    throw new Error('OPERATOR_NAMES_REQUIRED: 提交导出前必须提供当前登录操作人姓名（operatorNames）');
  }
  const normalizedHints = Array.isArray(report.recordHints) ? report.recordHints.filter(Boolean) : [];
  const resolvedStaticHeaderOrg = report.staticHeaderOrg || (brandBusinessUnit ? businessUnit : '');
  const normalizedReport = {
    ...report,
    recordHints: normalizedHints,
  };

  await closeExportRecords(page);
  await dismissObstructions(page);

  const excludedSignatures = await loadRecentDeliveredSignatures(recentExportsPath);
  const submittedAt = Date.now();
  const recoveryState = {
    reportKey,
    brand,
    route: normalizedReport.route,
    staticHeaderOrg: resolvedStaticHeaderOrg,
    brandBusinessUnit,
    businessUnit,
    tabText: normalizedReport.tabText || null,
    recordButtons: normalizedReport.recordButtons,
    recordMenuText: normalizedReport.recordMenuText || null,
    recordHints: normalizedHints,
    operatorNames: normalizedOperators,
    excludedSignatures,
    submittedAt,
    submittedAtIso: new Date(submittedAt).toISOString(),
    destinationPath,
    status: 'submitting',
  };
  await fs.mkdir(path.dirname(recoveryPath), { recursive: true });
  await fs.writeFile(recoveryPath, JSON.stringify(recoveryState, null, 2), 'utf8');

  if (normalizedReport.menuText) {
    const item = await openDropdownMenuItem(page, '导出', normalizedReport.menuText);
    await item.activate();
  } else {
    await clickVisibleButtonByText(page, '导出');
  }

  await fs.writeFile(recoveryPath, JSON.stringify({ ...recoveryState, status: 'submitted' }, null, 2), 'utf8');
  await acceptExportDialogs(page);
  await dismissObstructions(page);
  await openExportRecords(page, normalizedReport);
  await sleep(1000);

  return pollAndDownload(page, task, {
    reportKey,
    report: normalizedReport,
    operatorNames: normalizedOperators,
    submittedAt,
    recoveryPath,
    destinationPath,
    excludedSignatures,
    recentExportsPath,
    timeoutMinutes,
  });
}

export async function resumeFromRecovery(page, task, recoveryPath, timeoutMinutes = 20, { recentExportsPath = DEFAULT_RECENT_EXPORTS_PATH } = {}) {
  const recovery = JSON.parse(await fs.readFile(recoveryPath, 'utf8'));
  if (recovery.status === 'delivered' && recovery.deliveredFile) {
    const check = await verifyXlsxFile(recovery.deliveredFile);
    return { reportKey: recovery.reportKey, brand: recovery.brand, file: recovery.deliveredFile, ...check, alreadyDelivered: true };
  }
  const identity = await prepareReportPage(page, recovery, {
    brand: recovery.brand || '小仓',
    expectedOrg: recovery.staticHeaderOrg
      ? (recovery.brandBusinessUnit || '')
      : (recovery.businessUnit || ''),
  });
  await openExportRecords(page, recovery);
  return pollAndDownload(page, task, {
    reportKey: recovery.reportKey,
    report: recovery,
    operatorNames: recovery.operatorNames?.length ? recovery.operatorNames : (identity.operatorNames || identity.names),
    submittedAt: recovery.submittedAt,
    recoveryPath,
    destinationPath: recovery.destinationPath,
    excludedSignatures: recovery.excludedSignatures || [],
    recentExportsPath,
    timeoutMinutes,
  });
}
