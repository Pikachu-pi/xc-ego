import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..');
export const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), 'Desktop', 'xc-ego产出');
export const DEFAULT_PREFS_PATH = path.join(os.homedir(), '.xc-ego', 'preferences.json');

export function getRecommendedOutputRoots({ homedir = os.homedir(), workspaceDir = '' } = {}) {
  const list = [
    {
      key: 'desktop',
      label: '桌面（推荐）',
      path: path.join(homedir, 'Desktop', 'xc-ego产出'),
      recommended: true,
    },
    {
      key: 'downloads',
      label: '下载文件夹',
      path: path.join(homedir, 'Downloads', 'xc-ego产出'),
      recommended: false,
    },
  ];
  const trimmedWs = String(workspaceDir || '').trim();
  if (trimmedWs) {
    list.push({
      key: 'workspace',
      label: '当前工作区目录',
      path: path.join(path.resolve(trimmedWs), 'xc-ego产出'),
      recommended: false,
    });
  }
  return list;
}

const ABSOLUTE_DATE_FIELD_NAMES = new Set(['date', 'startDate', 'endDate', 'businessDate', 'dateRange']);
const RELATIVE_DATE_WORDS = new Set(['今天', '昨天', '前天', '近7天', '近30天', '本周', '本月', 'today', 'yesterday']);
const ISO_DATE_RE = /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/;
const CN_YEAR_MONTH_RE = /\d{4}年\d{1,2}月/;
const CN_MONTH_DAY_RE = /\d{1,2}月\d{1,2}[日号]/;
const COMPACT_DATE_RE = /\b20\d{6}\b/;
const SLASH_DASH_RANGE_RE = /\b\d{1,2}[-/]\d{1,2}\s*[-~～至到]\s*\d{1,2}[-/]\d{1,2}\b/;
const ISO_YEAR_MONTH_RE = /^\d{4}[-/]\d{1,2}$/;

export function normalizeBrand(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text === '小仓' || text === '小仓生活') return '小仓';
  if (text === '乐心宜' || text === '小仓生活乐心宜') return '乐心宜';
  return text;
}

export function defaultPreferences() {
  return {
    version: 1,
    defaultBrand: null,
    profiles: {
      default: null,
      hibo: null,
      meituan: {},
    },
    outputRoot: null,
    storeGroups: {},
    tableDefaults: {},
  };
}

export function isAbsoluteDateValue(field, value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (RELATIVE_DATE_WORDS.has(trimmed)) return false;
    if (
      ISO_DATE_RE.test(trimmed)
      || CN_YEAR_MONTH_RE.test(trimmed)
      || CN_MONTH_DAY_RE.test(trimmed)
      || COMPACT_DATE_RE.test(trimmed)
      || SLASH_DASH_RANGE_RE.test(trimmed)
    ) {
      return true;
    }
    if (ABSOLUTE_DATE_FIELD_NAMES.has(field) && (/\d{1,2}[-/]\d{1,2}/.test(trimmed) || ISO_YEAR_MONTH_RE.test(trimmed))) {
      return true;
    }
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => isAbsoluteDateValue(field, item));
  }
  if (typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => isAbsoluteDateValue(k, v));
  }
  return false;
}

function isPresentValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export async function atomicWriteJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

export async function loadPreferences(prefsPath = DEFAULT_PREFS_PATH) {
  try {
    const raw = await fs.readFile(prefsPath, 'utf8');
    const parsed = JSON.parse(raw);
    const base = defaultPreferences();
    const rawProfiles = parsed.profiles || {};
    const meituanProfiles = typeof rawProfiles.meituan === 'string'
      ? rawProfiles.meituan
      : { ...(rawProfiles.meituan || {}) };
    return {
      ...base,
      ...parsed,
      profiles: {
        ...base.profiles,
        ...rawProfiles,
        meituan: meituanProfiles,
      },
      storeGroups: { ...base.storeGroups, ...(parsed.storeGroups || {}) },
      tableDefaults: { ...base.tableDefaults, ...(parsed.tableDefaults || {}) },
    };
  } catch (error) {
    if (error.code === 'ENOENT') return defaultPreferences();
    throw error;
  }
}

export function resolveProfileName(prefs, { target = 'hibo', brand } = {}) {
  const defaultProfile = prefs?.profiles?.default ? String(prefs.profiles.default).trim() : null;
  if (target === 'meituan') {
    const normalized = normalizeBrand(brand);
    const mt = prefs?.profiles?.meituan;
    if (typeof mt === 'string' && mt.trim()) return mt.trim();
    if (normalized && mt && typeof mt === 'object' && mt[normalized]) {
      return String(mt[normalized]).trim() || null;
    }
    return defaultProfile;
  }
  const hiboProfile = prefs?.profiles?.hibo ? String(prefs.profiles.hibo).trim() : null;
  return hiboProfile || defaultProfile || null;
}

const FIELD_KEY_ALIASES = new Map([
  ['brand', 'brand'],
  ['中台', 'brand'],
  ['品牌', 'brand'],
  ['stores', 'stores'],
  ['store', 'stores'],
  ['storeName', 'stores'],
  ['storeNames', 'stores'],
  ['门店', 'stores'],
  ['门店名称', 'stores'],
  ['仓店', 'stores'],
  ['channel', 'channel'],
  ['channelName', 'channel'],
  ['渠道', 'channel'],
  ['渠道名称', 'channel'],
  ['date', 'date'],
  ['dateRange', 'date'],
  ['日期', 'date'],
  ['日期范围', 'date'],
  ['profileName', 'profileName'],
  ['资料', 'profileName'],
  ['资料名', 'profileName'],
  ['outputRoot', 'outputRoot'],
  ['输出目录', 'outputRoot'],
  ['保存目录', 'outputRoot'],
]);

export function normalizeFieldKey(field) {
  const key = String(field || '').trim();
  return FIELD_KEY_ALIASES.get(key) || key;
}

function normalizeFieldObject(obj = {}) {
  const normalized = {};
  const canonicalKeys = new Set(['brand', 'stores', 'channel', 'date', 'profileName', 'outputRoot']);
  for (const [rawKey, val] of Object.entries(obj || {})) {
    const key = normalizeFieldKey(rawKey);
    if (!key) continue;
    if (canonicalKeys.has(rawKey)) {
      normalized[key] = val;
    } else if (!(key in normalized) || !isPresentValue(normalized[key])) {
      normalized[key] = val;
    }
  }
  return normalized;
}

export function resolveParameters(prefs, { table, target, provided = {}, requiredFields = [] }) {
  const effectiveTarget = target || (table && table.startsWith('meituan') ? 'meituan' : 'hibo');
  const normProvided = normalizeFieldObject(provided);
  const tableDefaults = normalizeFieldObject((table && prefs.tableDefaults?.[table]) || {});
  const normRequiredFields = [...new Set(requiredFields.map((f) => normalizeFieldKey(f)).filter(Boolean))];
  const resolved = {};
  const sources = {};
  const missing = [];

  if (isPresentValue(normProvided.brand)) {
    resolved.brand = normalizeBrand(normProvided.brand);
    sources.brand = 'provided';
  } else if (isPresentValue(tableDefaults.brand)) {
    resolved.brand = normalizeBrand(tableDefaults.brand);
    sources.brand = 'tableDefault';
  } else if (prefs.defaultBrand) {
    resolved.brand = normalizeBrand(prefs.defaultBrand);
    sources.brand = 'defaultBrand';
  } else if (normRequiredFields.includes('brand')) {
    missing.push('brand');
  }

  const allFields = new Set([
    ...normRequiredFields,
    ...Object.keys(tableDefaults),
    ...Object.keys(normProvided),
  ]);
  allFields.delete('brand');

  for (const field of allFields) {
    if (isPresentValue(normProvided[field])) {
      resolved[field] = normProvided[field];
      sources[field] = 'provided';
      continue;
    }
    if (isPresentValue(tableDefaults[field])) {
      resolved[field] = tableDefaults[field];
      sources[field] = 'tableDefault';
      continue;
    }
    if (field === 'stores' && Array.isArray(prefs.storeGroups?.['默认门店']) && prefs.storeGroups['默认门店'].length) {
      resolved[field] = [...prefs.storeGroups['默认门店']];
      sources[field] = 'globalStoreGroup';
      continue;
    }
    if (field === 'profileName') {
      const profileName = resolveProfileName(prefs, { target: effectiveTarget, brand: resolved.brand });
      if (profileName) {
        resolved[field] = profileName;
        sources[field] = effectiveTarget === 'meituan' ? 'meituanBrandProfile' : 'hiboProfile';
      } else {
        resolved[field] = null;
        sources[field] = 'egoliteDefault';
      }
      continue;
    }
    if (field === 'outputRoot') {
      if (prefs.outputRoot) {
        resolved[field] = prefs.outputRoot;
        sources[field] = 'userOutputRoot';
      } else if (normRequiredFields.includes('outputRoot')) {
        missing.push('outputRoot');
      }
      continue;
    }
    if (normRequiredFields.includes(field)) {
      missing.push(field);
    }
  }

  return {
    resolved,
    missing,
    sources,
    ...(missing.includes('outputRoot')
      ? { recommendedOutputRoots: getRecommendedOutputRoots({ workspaceDir: provided?.workspaceDir }) }
      : {}),
  };
}

export async function setDefault({
  prefsPath = DEFAULT_PREFS_PATH,
  scope = 'table',
  table,
  field,
  value,
}) {
  if (!field) throw new Error('PREFS_FIELD_REQUIRED');
  const normField = scope === 'global' ? field : normalizeFieldKey(field);
  if (isAbsoluteDateValue(normField, value)) {
    throw new Error(`PREFS_ABSOLUTE_DATE_REJECTED: cannot store absolute date for ${normField}`);
  }

  const normalizedValue = normField === 'brand' || normField === 'defaultBrand' ? normalizeBrand(value) : value;
  const prefs = await loadPreferences(prefsPath);
  if (scope === 'global') {
    if (field === 'outputRoot') {
      prefs.outputRoot = normalizedValue || null;
    } else if (field === 'defaultBrand') {
      prefs.defaultBrand = normalizedValue;
    } else if (field === 'profile.default') {
      prefs.profiles.default = normalizedValue || null;
    } else if (field === 'profile.hibo') {
      prefs.profiles.hibo = normalizedValue || null;
    } else if (field === 'profile.meituan') {
      prefs.profiles.meituan = normalizedValue || {};
    } else if (field.startsWith('profile.meituan.')) {
      const brandKey = normalizeBrand(field.slice('profile.meituan.'.length));
      if (!brandKey) throw new Error('PREFS_MEITUAN_BRAND_REQUIRED');
      if (typeof prefs.profiles.meituan !== 'object' || prefs.profiles.meituan === null) {
        prefs.profiles.meituan = {};
      }
      if (normalizedValue) {
        prefs.profiles.meituan[brandKey] = normalizedValue;
      } else {
        delete prefs.profiles.meituan[brandKey];
      }
    } else if (field === 'storeGroup.default') {
      prefs.storeGroups['默认门店'] = normalizedValue;
    } else {
      throw new Error(`PREFS_UNKNOWN_GLOBAL_FIELD: ${field}`);
    }
  } else {
    if (!table) throw new Error('PREFS_TABLE_REQUIRED');
    prefs.tableDefaults[table] = prefs.tableDefaults[table] || {};
    prefs.tableDefaults[table][normField] = normalizedValue;
  }

  await atomicWriteJson(prefsPath, prefs);
  return { ok: true, prefsPath, scope, table: table || null, field: normField, value: normalizedValue };
}

export async function clearDefault({
  prefsPath = DEFAULT_PREFS_PATH,
  scope = 'table',
  table,
  field,
}) {
  const prefs = await loadPreferences(prefsPath);
  if (scope === 'global') {
    if (field === 'outputRoot') prefs.outputRoot = null;
    else if (field === 'defaultBrand') prefs.defaultBrand = null;
    else if (field === 'profile.default') prefs.profiles.default = null;
    else if (field === 'profile.hibo') prefs.profiles.hibo = null;
    else if (field === 'profile.meituan') prefs.profiles.meituan = {};
    else if (field.startsWith('profile.meituan.')) {
      const brandKey = normalizeBrand(field.slice('profile.meituan.'.length));
      if (brandKey && prefs.profiles.meituan && typeof prefs.profiles.meituan === 'object') {
        delete prefs.profiles.meituan[brandKey];
      }
    } else if (field === 'storeGroup.default') delete prefs.storeGroups['默认门店'];
    else throw new Error(`PREFS_UNKNOWN_GLOBAL_FIELD: ${field}`);
  } else if (table && prefs.tableDefaults?.[table]) {
    if (field) delete prefs.tableDefaults[table][normalizeFieldKey(field)];
    else delete prefs.tableDefaults[table];
  }
  await atomicWriteJson(prefsPath, prefs);
  return { ok: true, prefsPath };
}

export function formatLocalTimestamp(now = new Date()) {
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const yyyy = shanghai.getUTCFullYear();
  const mm = String(shanghai.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shanghai.getUTCDate()).padStart(2, '0');
  const hh = String(shanghai.getUTCHours()).padStart(2, '0');
  const mi = String(shanghai.getUTCMinutes()).padStart(2, '0');
  return {
    dateStr: `${yyyy}-${mm}-${dd}`,
    stamp: `${yyyy}${mm}${dd}-${hh}${mi}`,
  };
}

export function sanitizeFilePart(text, fallback = '任务') {
  const cleaned = String(text || '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

export async function createTaskOutputDir({
  outputRoot,
  brand,
  taskName = '海博美团任务',
  now = new Date(),
} = {}) {
  const root = outputRoot ? path.resolve(outputRoot) : DEFAULT_OUTPUT_DIR;
  const { stamp, dateStr } = formatLocalTimestamp(now);
  const safeTask = sanitizeFilePart(taskName);
  const normalizedBrand = normalizeBrand(brand);
  const safeBrand = normalizedBrand ? sanitizeFilePart(normalizedBrand) : '';
  const suffix = safeBrand && !safeTask.startsWith(safeBrand)
    ? `${safeBrand}_${safeTask}`
    : safeTask;
  const folderName = `${stamp}_${suffix}`;
  const dir = path.join(root, folderName);
  await fs.mkdir(dir, { recursive: true });
  return { dir, dateStr, stamp };
}

export async function nextUniqueFilePath(directory, desiredFilename) {
  const parsed = path.parse(desiredFilename);
  let candidate = path.join(directory, desiredFilename);
  let index = 2;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(directory, `${parsed.name}_${index}${parsed.ext}`);
      index += 1;
    } catch (error) {
      if (error.code === 'ENOENT') return candidate;
      throw error;
    }
  }
}

export async function run(input) {
  const req = typeof input === 'string'
    ? JSON.parse(await fs.readFile(input, 'utf8'))
    : (input || {});
  const prefsPath = req.prefsPath || DEFAULT_PREFS_PATH;
  let result;
  switch (req.action) {
    case 'get':
      result = { ok: true, prefsPath, prefs: await loadPreferences(prefsPath) };
      break;
    case 'resolve': {
      const prefs = await loadPreferences(prefsPath);
      result = { ok: true, prefsPath, ...resolveParameters(prefs, req) };
      break;
    }
    case 'set-default':
      result = await setDefault({
        prefsPath,
        scope: req.scope || 'table',
        table: req.table,
        field: req.field,
        value: req.value,
      });
      break;
    case 'clear-default':
      result = await clearDefault({
        prefsPath,
        scope: req.scope || 'table',
        table: req.table,
        field: req.field,
      });
      break;
    case 'recommend-output-roots': {
      const prefs = await loadPreferences(prefsPath);
      result = {
        ok: true,
        prefsPath,
        configuredOutputRoot: prefs.outputRoot || null,
        recommended: getRecommendedOutputRoots({ workspaceDir: req.workspaceDir }),
      };
      break;
    }
    case 'build-output-dir': {
      const prefs = await loadPreferences(prefsPath);
      const outputRoot = req.outputRoot || prefs.outputRoot || DEFAULT_OUTPUT_DIR;
      result = {
        ok: true,
        ...(await createTaskOutputDir({ outputRoot, brand: req.brand, taskName: req.taskName })),
      };
      break;
    }
    default:
      throw new Error(`PREFS_UNKNOWN_ACTION: ${req.action}`);
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  const selfPath = path.resolve(fileURLToPath(import.meta.url));
  const entryPath = path.resolve(process.argv[1]);
  return process.platform === 'win32'
    ? selfPath.toLowerCase() === entryPath.toLowerCase()
    : selfPath === entryPath;
}

if (isDirectExecution()) {
  const idx = process.argv.indexOf('--request');
  const reqPath = idx >= 0 ? process.argv[idx + 1] : null;
  if (!reqPath) {
    console.error('Usage: node prefs.mjs --request <path-to-request.json>');
    process.exitCode = 1;
  } else {
    await run(reqPath);
  }
}
