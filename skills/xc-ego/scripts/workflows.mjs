import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_ROOT, atomicWriteJson, isAbsoluteDateValue } from './prefs.mjs';

export const DEFAULT_WORKFLOWS_DIR = path.join(os.homedir(), '.xc-ego', 'workflows');

const FORBIDDEN_RUNTIME_KEYS = new Set([
  'brand',
  'stores',
  'store',
  'storeName',
  'storeNames',
  'channel',
  'channelName',
  'date',
  'dateRange',
  'startDate',
  'endDate',
  'price',
  'minOrder',
  'minPrice',
  'deliveryFee',
  'targetValue',
  'values',
  'wmPoiId',
  '门店',
  '门店名称',
  '中台',
  '渠道',
  '日期',
  '起送价',
  '配送费',
  '价格',
]);

const PLATFORM_ALIASES = new Map([
  ['hibo', 'hibo'],
  ['海博', 'hibo'],
  ['海博中台', 'hibo'],
  ['meituan', 'meituan'],
  ['美团', 'meituan'],
  ['美团商家后台', 'meituan'],
  ['美团闪购', 'meituan'],
  ['美团外卖', 'meituan'],
  ['mixed', 'mixed'],
  ['混合', 'mixed'],
  ['海博+美团', 'mixed'],
  ['海博中台+美团商家后台', 'mixed'],
]);

export function normalizePlatform(value, { allowMixed = true } = {}) {
  if (value === undefined || value === null) return null;
  const key = String(value).trim().toLowerCase();
  const normalized = PLATFORM_ALIASES.get(key);
  if (!normalized || (!allowMixed && normalized === 'mixed')) {
    const allowed = allowMixed ? 'hibo、meituan 或 mixed' : 'hibo 或 meituan';
    throw new Error(`WORKFLOW_INVALID_PLATFORM: 不支持的平台「${value}」，仅支持 ${allowed}`);
  }
  return normalized;
}

export function formatPlatformLabel(platform) {
  const key = String(platform || '').trim().toLowerCase();
  if (key === 'hibo' || key === '海博' || key === '海博中台') return '海博中台';
  if (key === 'meituan' || key === '美团' || key === '美团商家后台') return '美团商家后台';
  if (key === 'mixed' || key === '混合' || key === '海博+美团' || key === '海博中台+美团商家后台') {
    return '海博中台 + 美团商家后台';
  }
  return String(platform || '').trim() || '未知平台';
}

export function sanitizeWorkflowId(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error('WORKFLOW_INVALID_ID: 流程 ID 不能为空且不能包含非法路径字符');
  }
  return cleaned;
}

function isNonEmptyValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function assertNoHardcodedRuntimeData(node, trail = 'pathSpec') {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    if (isAbsoluteDateValue(trail.split('.').at(-1) || '', node)) {
      throw new Error(`WORKFLOW_ABSOLUTE_DATE_REJECTED: 固定路径不可包含绝对日期（${trail}）`);
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertNoHardcodedRuntimeData(item, `${trail}[${index}]`));
    return;
  }
  if (typeof node === 'object') {
    for (const [key, val] of Object.entries(node)) {
      if (FORBIDDEN_RUNTIME_KEYS.has(key) && isNonEmptyValue(val)) {
        throw new Error(
          `WORKFLOW_HARDCODED_PARAM_REJECTED: 业务参数「${key}」不得写死在 ${trail} 中，请保留在 requiredParams 每次由用户说明`,
        );
      }
      if (isAbsoluteDateValue(key, val)) {
        throw new Error(`WORKFLOW_ABSOLUTE_DATE_REJECTED: 固定路径不可包含绝对日期（${trail}.${key}）`);
      }
      assertNoHardcodedRuntimeData(val, `${trail}.${key}`);
    }
  }
}

function isSameOrSubPath(targetPath, baseDir) {
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const t = norm(path.resolve(targetPath));
  const b = norm(path.resolve(baseDir));
  return t === b || t.startsWith(`${b}${path.sep}`);
}

function validateLocalScript(localScript, workflowsDir = DEFAULT_WORKFLOWS_DIR) {
  if (localScript === undefined || localScript === null || String(localScript).trim() === '') {
    return null;
  }
  const raw = String(localScript).trim();
  if (raw.includes('..')) {
    throw new Error('WORKFLOW_INVALID_LOCAL_SCRIPT: localScript 路径不可包含 ..');
  }
  const expanded = (raw.startsWith('~/') || raw.startsWith('~\\'))
    ? path.resolve(os.homedir(), raw.slice(2))
    : path.resolve(raw);
  const allowedBase = path.resolve(workflowsDir, 'scripts');
  if (isSameOrSubPath(expanded, SKILL_ROOT)) {
    throw new Error('WORKFLOW_INVALID_LOCAL_SCRIPT: 个人固化脚本不得写入公共 Skill 目录');
  }
  const normExpanded = process.platform === 'win32' ? expanded.toLowerCase() : expanded;
  const normAllowed = process.platform === 'win32' ? allowedBase.toLowerCase() : allowedBase;
  if (raw.endsWith('/') || raw.endsWith('\\') || !normExpanded.startsWith(`${normAllowed}${path.sep}`)) {
    throw new Error('WORKFLOW_INVALID_LOCAL_SCRIPT: localScript 必须位于 ~/.xc-ego/workflows/scripts/ 下');
  }
  return raw;
}

function normalizeQueryText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[\s，,。；;：:！？!?「」『』（）()【】[\]、·"'`~]+/g, '');
}

function cleanParamList(list) {
  return Array.isArray(list)
    ? [...new Set(list.map((item) => String(item).trim()).filter(Boolean))]
    : [];
}

function buildDefaultExampleCall(workflow) {
  const paramsHint = (workflow.requiredParams || []).slice(0, 3).join('、');
  return paramsHint ? `${workflow.name}（附${paramsHint}）` : workflow.name;
}

export function formatOfferReply({ platform, pathSummary, requiredParams = [], items } = {}) {
  if (Array.isArray(items) && items.length === 1) {
    const [only] = items;
    return formatOfferReply({
      platform: only?.platform ?? platform,
      pathSummary: only?.pathSummary ?? pathSummary,
      requiredParams: Array.isArray(only?.requiredParams) && only.requiredParams.length
        ? only.requiredParams
        : requiredParams,
    });
  }
  if (Array.isArray(items) && items.length >= 2) {
    const normalizedItems = items.map((item, idx) => {
      const name = String(item?.name || '').trim();
      const itemSummary = String(item?.pathSummary || '').trim();
      if (!name || !itemSummary) {
        throw new Error(`WORKFLOW_OFFER_ITEM_INVALID: 第 ${idx + 1} 项缺少 name 或 pathSummary`);
      }
      return {
        name,
        platform: normalizePlatform(item.platform, { allowMixed: false }),
        pathSummary: itemSummary,
        alreadySaved: Boolean(item.alreadySaved),
        requiredParams: cleanParamList(item.requiredParams),
      };
    });
    const mergedParams = cleanParamList([
      ...(Array.isArray(requiredParams) ? requiredParams : []),
      ...normalizedItems.flatMap((it) => it.requiredParams),
    ]);
    const paramsText = mergedParams.length ? mergedParams.join('、') : '中台、门店名称、渠道、日期等本次参数';
    const itemLines = normalizedItems.map(
      (it, idx) => `    1.1.${idx + 1} ${it.name}（${formatPlatformLabel(it.platform)} · ${it.pathSummary}）${it.alreadySaved ? '（已有单项）' : ''}`,
    );
    return [
      `1 本次对话共完成 ${normalizedItems.length} 项操作，尚未立为整体固定流程。`,
      '1.1 包含项目：',
      ...itemLines,
      `1.2 每次须指定：${paramsText}（参数不写死，随当次任务给定）`,
      '2 请选择固化方式（不回复则保持单次执行）：',
      `2.1 回复「固化整体」：将上述 ${normalizedItems.length} 项合并立为一条串联固定流程。`,
      '2.2 回复「固化单项」并指明序号或名称（如「只固化 1」）：仅将指定表或操作立为独立固定流程。',
      '2.3 回复「都要」：同时固化整体串联流程与各单项独立流程。',
    ].join('\n');
  }

  const normalizedPlatform = normalizePlatform(platform, { allowMixed: true });
  if (!normalizedPlatform) {
    throw new Error('WORKFLOW_INVALID_PLATFORM: format-offer 需要提供 platform（hibo、meituan 或 mixed）');
  }
  const label = formatPlatformLabel(normalizedPlatform);
  const summary = String(pathSummary || '').trim();
  if (!summary) {
    throw new Error('WORKFLOW_PATH_SUMMARY_REQUIRED: format-offer 需要提供 pathSummary');
  }
  const cleanedParams = cleanParamList(requiredParams);
  const paramsText = cleanedParams.length ? cleanedParams.join('、') : '中台、门店名称、渠道、日期等本次参数';
  return [
    '1 此操作已完成，尚未立为固定流程。',
    `1.1 固定路径：${label} · ${summary}`,
    `1.2 每次须指定：${paramsText}（参数不写死，随当次任务给定）`,
    '2 是否将此路径固化为本机固定流程？回复「固化」即可落盘，不回复则保持单次执行。',
  ].join('\n');
}

export function formatConfirmationReply(workflow) {
  const paramsText = (workflow.requiredParams || []).join('、');
  const example = workflow.exampleCall || buildDefaultExampleCall(workflow);
  if (workflow.kind === 'composite') {
    const count = Array.isArray(workflow.subTasks) ? workflow.subTasks.length : 0;
    return [
      `1 流程已定：「${workflow.name}」已固化为本机整体固定流程（共 ${count} 项，串行执行）。`,
      `1.1 固定部分：${workflow.pathSummary} 与标准执行核验步骤。`,
      `1.2 变动部分：${paramsText}，不作写死，每次调用按需说明。`,
      `2 下次调用：直接说出此整体流程名或目标组合并附本次参数（如「${example}」），将自动匹配并按序执行全部项目。`,
      '2.1 边界：意图与参数齐备即直接执行完成；仅在缺参、存在歧义或遇登录验证时停下询问。',
    ].join('\n');
  }
  const label = formatPlatformLabel(workflow.platform);
  return [
    `1 流程已定：「${workflow.name}」已固化为本机固定流程。`,
    `1.1 固定部分：${label}路径「${workflow.pathSummary}」与标准执行核验步骤。`,
    `1.2 变动部分：${paramsText}，不作写死，每次调用按需说明。`,
    `2 下次调用：直接说出要下载的表格或要完成的操作并附本次参数（如「${example}」），将自动匹配并调用此流程。`,
    '2.1 边界：意图与参数齐备即直接执行完成；仅在缺参、存在歧义或遇登录验证时停下询问。',
  ].join('\n');
}

export function formatBatchConfirmationReply(workflows) {
  if (!Array.isArray(workflows) || workflows.length === 0) {
    throw new Error('WORKFLOW_BATCH_REQUIRED: 至少需要 1 条流程');
  }
  if (workflows.length === 1) {
    return formatConfirmationReply(workflows[0]);
  }
  const lines = workflows.map((wf, idx) => {
    if (wf.kind === 'composite') {
      const names = (wf.subTasks || []).map((t) => t.name).join('、');
      return `    1.1.${idx + 1} 【整体】「${wf.name}」（含 ${(wf.subTasks || []).length} 项：${names}）`;
    }
    return `    1.1.${idx + 1} 【单项】「${wf.name}」（${formatPlatformLabel(wf.platform)} · ${wf.pathSummary}）`;
  });
  const mergedParams = cleanParamList(workflows.flatMap((wf) => wf.requiredParams || []));
  const composite = workflows.find((wf) => wf.kind === 'composite');
  const single = workflows.find((wf) => wf.kind !== 'composite');
  const exampleParts = composite && single
    ? [composite.exampleCall || buildDefaultExampleCall(composite), single.exampleCall || buildDefaultExampleCall(single)]
    : workflows.slice(0, 2).map((wf) => wf.exampleCall || buildDefaultExampleCall(wf));
  const examplesText = exampleParts.filter(Boolean).map((ex) => `「${ex}」`).join('或');
  let nextCallLine;
  if (composite && single) {
    nextCallLine = `2 下次调用：说整体流程名即按序执行全套，说单项表名或操作名即单独执行该项并附本次参数（如${examplesText}）。`;
  } else if (single) {
    nextCallLine = `2 下次调用：直接说出对应表名或操作名并附本次参数（如${examplesText}），将自动匹配并单独执行该项。`;
  } else {
    nextCallLine = `2 下次调用：直接说出对应整体流程名并附本次参数（如${examplesText}），将自动匹配并按序执行全部项目。`;
  }
  return [
    `1 流程已定：本次共固化 ${workflows.length} 条本机固定流程。`,
    '1.1 已固化清单：',
    ...lines,
    `1.2 变动部分：${mergedParams.join('、')}，均不作写死，每次调用按需说明。`,
    nextCallLine,
    '2.1 边界：意图与参数齐备即直接执行完成；仅在缺参、存在歧义或遇登录验证时停下询问。',
  ].join('\n');
}

function validateSubTasks(rawSubTasks) {
  if (!Array.isArray(rawSubTasks) || rawSubTasks.length < 2) {
    throw new Error('WORKFLOW_SUBTASKS_REQUIRED: 整体流程 composite 须包含至少 2 项 subTasks');
  }
  return rawSubTasks.map((sub, idx) => {
    const prefix = `subTasks[${idx}]`;
    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) {
      throw new Error(`WORKFLOW_SUBTASK_INVALID: ${prefix} 必须为对象`);
    }
    const name = String(sub.name || '').trim();
    if (!name) throw new Error(`WORKFLOW_SUBTASK_INVALID: ${prefix} 缺少 name`);
    const platform = normalizePlatform(sub.platform, { allowMixed: false });
    const pathSummary = String(sub.pathSummary || '').trim();
    if (!pathSummary) throw new Error(`WORKFLOW_SUBTASK_INVALID: ${prefix} 缺少 pathSummary`);
    if (!sub.pathSpec || typeof sub.pathSpec !== 'object' || Array.isArray(sub.pathSpec) || !Object.keys(sub.pathSpec).length) {
      throw new Error(`WORKFLOW_SUBTASK_INVALID: ${prefix} 缺少 pathSpec`);
    }
    const requiredParams = cleanParamList(sub.requiredParams);
    if (!requiredParams.length) {
      throw new Error(`WORKFLOW_SUBTASK_INVALID: ${prefix} 缺少 requiredParams`);
    }
    const steps = Array.isArray(sub.steps)
      ? sub.steps.map((s) => String(s).trim()).filter(Boolean)
      : [];
    assertNoHardcodedRuntimeData(pathSummary, `${prefix}.pathSummary`);
    assertNoHardcodedRuntimeData(sub.pathSpec, `${prefix}.pathSpec`);
    assertNoHardcodedRuntimeData(steps, `${prefix}.steps`);
    return {
      ...(sub.workflowId ? { workflowId: sanitizeWorkflowId(sub.workflowId) } : {}),
      name,
      platform,
      isWriteOperation: Boolean(sub.isWriteOperation),
      pathSummary,
      pathSpec: sub.pathSpec,
      steps,
      requiredParams,
    };
  });
}

async function prepareWorkflowRecord({ workflowsDir, input, now }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('WORKFLOW_PAYLOAD_REQUIRED: save 需要提供 workflow 对象');
  }
  const name = String(input.name || '').trim();
  if (!name) throw new Error('WORKFLOW_NAME_REQUIRED: 缺少流程名称 name');

  const kind = input.kind
    ? String(input.kind).trim()
    : (Array.isArray(input.subTasks) && input.subTasks.length >= 2 ? 'composite' : 'single');
  if (kind !== 'single' && kind !== 'composite') {
    throw new Error(`WORKFLOW_INVALID_KIND: 不支持的流程类型「${kind}」，仅支持 single 或 composite`);
  }

  const id = sanitizeWorkflowId(input.id || name);
  const localScript = validateLocalScript(input.localScript, workflowsDir);
  const rawAliases = Array.isArray(input.aliases) ? input.aliases : [];
  const aliases = [...new Set([name, ...rawAliases.map((a) => String(a).trim()).filter(Boolean)])];
  const steps = Array.isArray(input.steps)
    ? input.steps.map((s) => String(s).trim()).filter(Boolean)
    : [];
  assertNoHardcodedRuntimeData(steps, 'steps');

  const filePath = path.join(workflowsDir, `${id}.json`);
  let existingCreatedAt = null;
  try {
    const existing = JSON.parse(await fs.readFile(filePath, 'utf8'));
    existingCreatedAt = existing.createdAt || null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const timestamp = now.toISOString();

  if (kind === 'composite') {
    const subTasks = validateSubTasks(input.subTasks);
    const platforms = new Set(subTasks.map((t) => t.platform));
    const derivedPlatform = platforms.size === 1 ? [...platforms][0] : 'mixed';
    const platform = input.platform ? normalizePlatform(input.platform, { allowMixed: true }) : derivedPlatform;
    const pathSummary = String(input.pathSummary || '').trim()
      || subTasks.map((t, i) => `${i + 1}.${t.name}（${formatPlatformLabel(t.platform)} · ${t.pathSummary}）`).join('；');
    assertNoHardcodedRuntimeData(pathSummary, 'pathSummary');
    const requiredParams = cleanParamList([
      ...(Array.isArray(input.requiredParams) ? input.requiredParams : []),
      ...subTasks.flatMap((t) => t.requiredParams),
    ]);
    const isWriteOperation = Boolean(input.isWriteOperation) || subTasks.some((t) => t.isWriteOperation);
    const record = {
      version: 1,
      kind: 'composite',
      id,
      name,
      platform,
      isWriteOperation,
      aliases,
      pathSummary,
      subTasks,
      steps,
      requiredParams,
      exampleCall: String(input.exampleCall || '').trim() || buildDefaultExampleCall({ name, requiredParams }),
      ...(localScript ? { localScript } : {}),
      createdAt: existingCreatedAt || timestamp,
      updatedAt: timestamp,
    };
    return { filePath, record };
  }

  const platform = normalizePlatform(input.platform, { allowMixed: false });
  const pathSummary = String(input.pathSummary || '').trim();
  if (!pathSummary) throw new Error('WORKFLOW_PATH_SUMMARY_REQUIRED: 缺少固定路径摘要 pathSummary');
  if (!input.pathSpec || typeof input.pathSpec !== 'object' || Array.isArray(input.pathSpec) || !Object.keys(input.pathSpec).length) {
    throw new Error('WORKFLOW_PATH_SPEC_REQUIRED: 缺少固定路径结构 pathSpec');
  }
  const requiredParams = cleanParamList(input.requiredParams);
  if (!requiredParams.length) {
    throw new Error('WORKFLOW_REQUIRED_PARAMS_EMPTY: requiredParams 须列出每次由用户说明的变动参数');
  }
  assertNoHardcodedRuntimeData(pathSummary, 'pathSummary');
  assertNoHardcodedRuntimeData(input.pathSpec, 'pathSpec');

  const record = {
    version: 1,
    kind: 'single',
    id,
    name,
    platform,
    isWriteOperation: Boolean(input.isWriteOperation),
    aliases,
    pathSummary,
    pathSpec: input.pathSpec,
    steps,
    requiredParams,
    exampleCall: String(input.exampleCall || '').trim() || buildDefaultExampleCall({ name, requiredParams }),
    ...(localScript ? { localScript } : {}),
    createdAt: existingCreatedAt || timestamp,
    updatedAt: timestamp,
  };
  return { filePath, record };
}

export async function listWorkflowsWithWarnings(workflowsDir = DEFAULT_WORKFLOWS_DIR) {
  let entries;
  try {
    entries = await fs.readdir(workflowsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { workflows: [], warnings: [] };
    throw error;
  }
  const workflows = [];
  const warnings = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const fullPath = path.join(workflowsDir, entry.name);
    const raw = await fs.readFile(fullPath, 'utf8');
    try {
      workflows.push(JSON.parse(raw));
    } catch (error) {
      warnings.push({ file: entry.name, error: error.message });
    }
  }
  workflows.sort((a, b) => String(a.id || '').localeCompare(String(b.id || ''), 'zh-Hans-CN'));
  return { workflows, warnings };
}

export async function listWorkflows(workflowsDir = DEFAULT_WORKFLOWS_DIR) {
  const { workflows } = await listWorkflowsWithWarnings(workflowsDir);
  return workflows;
}

export async function saveWorkflow({ workflowsDir = DEFAULT_WORKFLOWS_DIR, workflow: input, now = new Date() }) {
  const { filePath, record } = await prepareWorkflowRecord({ workflowsDir, input, now });
  await atomicWriteJson(filePath, record);
  return {
    ok: true,
    workflowsDir,
    filePath,
    workflow: record,
    confirmationReply: formatConfirmationReply(record),
  };
}

export async function saveBatchWorkflows({ workflowsDir = DEFAULT_WORKFLOWS_DIR, workflows = [], now = new Date() }) {
  if (!Array.isArray(workflows) || workflows.length === 0) {
    throw new Error('WORKFLOW_BATCH_REQUIRED: save-batch 需要非空的 workflows 数组');
  }
  // Validate every entry before writing any file so invalid batches fail atomically.
  const prepared = [];
  const seenIds = new Set();
  for (const input of workflows) {
    const item = await prepareWorkflowRecord({ workflowsDir, input, now });
    if (seenIds.has(item.record.id)) {
      throw new Error(`WORKFLOW_DUPLICATE_ID_IN_BATCH: 批量固化包含重复流程 ID「${item.record.id}」`);
    }
    seenIds.add(item.record.id);
    prepared.push(item);
  }
  const saved = [];
  for (const { filePath, record } of prepared) {
    await atomicWriteJson(filePath, record);
    saved.push({ filePath, workflow: record });
  }
  return {
    ok: true,
    workflowsDir,
    count: saved.length,
    saved,
    confirmationReply: formatBatchConfirmationReply(saved.map((item) => item.workflow)),
  };
}

export function inferQueryOperationIntent(rawQuery) {
  const text = String(rawQuery || '').trim();
  const hasWrite = /改成|改为|修改|调成|调为|调整|设为|设置为|下调|上调|涨到|降到|报名|取消活动|退出活动|上下架|上架|下架/.test(text);
  const hasRead = /查询|查一下|查下|查看|看看.*多少|导出|下载/.test(text);
  if (hasWrite && !hasRead) return 'write';
  if (hasRead && !hasWrite) return 'read';
  return 'neutral';
}

function matchesQueryIntent(workflow, intent) {
  if (intent === 'neutral' || workflow.kind === 'composite') return true;
  if (intent === 'write') return Boolean(workflow.isWriteOperation);
  return !workflow.isWriteOperation;
}

export async function matchWorkflows({ workflowsDir = DEFAULT_WORKFLOWS_DIR, query, platform }) {
  const rawQuery = String(query || '').trim();
  if (!rawQuery) {
    throw new Error('WORKFLOW_QUERY_REQUIRED: match 需要提供 query');
  }
  const normalizedQuery = normalizeQueryText(rawQuery);
  const intent = inferQueryOperationIntent(rawQuery);
  const platformFilter = platform ? normalizePlatform(platform, { allowMixed: true }) : null;
  const { workflows: allWorkflows, warnings } = await listWorkflowsWithWarnings(workflowsDir);
  const warningsMeta = warnings.length ? { warnings } : {};
  const workflows = allWorkflows.filter(
    (wf) => !platformFilter || wf.platform === platformFilter || wf.platform === 'mixed',
  );

  const exactHits = [];
  const partialHits = [];
  const keysByWorkflow = new Map();

  for (const wf of workflows) {
    const keys = [...new Set([wf.id, wf.name, ...(wf.aliases || [])])]
      .map((item) => normalizeQueryText(item))
      .filter(Boolean);
    keysByWorkflow.set(wf, keys);
    if (keys.some((k) => k === normalizedQuery)) {
      exactHits.push({ workflow: wf, score: normalizedQuery.length });
      continue;
    }
    if (!matchesQueryIntent(wf, intent)) continue;
    let bestKey = '';
    for (const k of keys) {
      if (k.length >= 2 && normalizedQuery.includes(k) && k.length > bestKey.length) {
        bestKey = k;
      }
    }
    if (bestKey) {
      partialHits.push({
        workflow: wf,
        score: bestKey.length,
        matchedKey: bestKey,
        startIndex: normalizedQuery.indexOf(bestKey),
      });
    }
  }

  if (exactHits.length === 1) {
    return {
      ok: true,
      workflowsDir,
      status: 'exact',
      matched: exactHits[0].workflow,
      candidates: [exactHits[0].workflow],
      ...warningsMeta,
    };
  }
  if (exactHits.length > 1) {
    return {
      ok: true,
      workflowsDir,
      status: 'ambiguous',
      matched: null,
      candidates: exactHits.map((h) => h.workflow),
      ...warningsMeta,
    };
  }

  if (partialHits.length) {
    partialHits.sort((a, b) => (b.score - a.score) || (a.startIndex - b.startIndex));
    const topScore = partialHits[0].score;
    const topHits = partialHits.filter((h) => h.score === topScore);
    const topComposites = topHits.filter((h) => h.workflow.kind === 'composite');
    if (topComposites.length === 1) {
      return {
        ok: true,
        workflowsDir,
        status: 'matched',
        matched: topComposites[0].workflow,
        candidates: partialHits.map((h) => h.workflow),
        ...warningsMeta,
      };
    }

    const nonOverlapping = [];
    const occupied = [];
    for (const hit of partialHits) {
      const start = hit.startIndex;
      const end = start + hit.matchedKey.length;
      const overlaps = occupied.some(([s, e]) => start < e && end > s);
      if (!overlaps) {
        const sameSpanTies = partialHits.filter((h) => h.startIndex === start && h.score === hit.score);
        if (sameSpanTies.length > 1) {
          const compTies = sameSpanTies.filter((h) => h.workflow.kind === 'composite');
          if (compTies.length === 1) {
            nonOverlapping.push(compTies[0]);
            occupied.push([start, end]);
            continue;
          }
          return {
            ok: true,
            workflowsDir,
            status: 'ambiguous',
            matched: null,
            candidates: sameSpanTies.map((h) => h.workflow),
            ...warningsMeta,
          };
        }
        nonOverlapping.push(hit);
        occupied.push([start, end]);
      }
    }
    if (nonOverlapping.length >= 2) {
      nonOverlapping.sort((a, b) => a.startIndex - b.startIndex);
      return {
        ok: true,
        workflowsDir,
        status: 'multi',
        matched: null,
        matchedList: nonOverlapping.map((h) => h.workflow),
        candidates: partialHits.map((h) => h.workflow),
        ...warningsMeta,
      };
    }

    const topCandidates = topHits.map((h) => h.workflow);
    if (topCandidates.length === 1) {
      return {
        ok: true,
        workflowsDir,
        status: 'matched',
        matched: topCandidates[0],
        candidates: partialHits.map((h) => h.workflow),
        ...warningsMeta,
      };
    }
    return {
      ok: true,
      workflowsDir,
      status: 'ambiguous',
      matched: null,
      candidates: topCandidates,
      ...warningsMeta,
    };
  }

  if (normalizedQuery.length >= 2) {
    const reverseHits = workflows.filter(
      (wf) => matchesQueryIntent(wf, intent) && (keysByWorkflow.get(wf) || []).some((k) => k.includes(normalizedQuery)),
    );
    if (reverseHits.length === 1) {
      return {
        ok: true,
        workflowsDir,
        status: 'matched',
        matched: reverseHits[0],
        candidates: reverseHits,
        ...warningsMeta,
      };
    }
    if (reverseHits.length > 1) {
      return {
        ok: true,
        workflowsDir,
        status: 'ambiguous',
        matched: null,
        candidates: reverseHits,
        ...warningsMeta,
      };
    }
  }

  return { ok: true, workflowsDir, status: 'none', matched: null, candidates: [], ...warningsMeta };
}

export async function deleteWorkflow({ workflowsDir = DEFAULT_WORKFLOWS_DIR, id, name }) {
  let targetId = id ? sanitizeWorkflowId(id) : null;
  if (!targetId && name) {
    const all = await listWorkflows(workflowsDir);
    const found = all.find((wf) => wf.name === String(name).trim());
    targetId = found ? found.id : sanitizeWorkflowId(name);
  }
  if (!targetId) {
    throw new Error('WORKFLOW_ID_OR_NAME_REQUIRED: delete 需要提供 id 或 name');
  }
  const filePath = path.join(workflowsDir, `${targetId}.json`);
  try {
    await fs.unlink(filePath);
    return { ok: true, workflowsDir, deleted: true, id: targetId, filePath };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ok: true, workflowsDir, deleted: false, id: targetId, filePath };
    }
    throw error;
  }
}

export async function run(input) {
  const req = typeof input === 'string'
    ? JSON.parse(await fs.readFile(input, 'utf8'))
    : (input || {});
  const workflowsDir = req.workflowsDir || DEFAULT_WORKFLOWS_DIR;
  let result;
  switch (req.action) {
    case 'list': {
      const { workflows, warnings } = await listWorkflowsWithWarnings(workflowsDir);
      result = {
        ok: true,
        workflowsDir,
        count: workflows.length,
        workflows,
        ...(warnings.length ? { warnings } : {}),
      };
      break;
    }
    case 'match':
      result = await matchWorkflows({ workflowsDir, query: req.query, platform: req.platform });
      break;
    case 'save':
      result = await saveWorkflow({ workflowsDir, workflow: req.workflow });
      break;
    case 'save-batch':
      result = await saveBatchWorkflows({ workflowsDir, workflows: req.workflows });
      break;
    case 'delete':
      result = await deleteWorkflow({ workflowsDir, id: req.id, name: req.name });
      break;
    case 'format-offer':
      result = {
        ok: true,
        offerReply: formatOfferReply({
          platform: req.platform,
          pathSummary: req.pathSummary,
          requiredParams: req.requiredParams,
          items: req.items,
        }),
      };
      break;
    default:
      throw new Error(`WORKFLOW_UNKNOWN_ACTION: ${req.action}`);
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
    console.error('Usage: node workflows.mjs --request <path-to-request.json>');
    process.exitCode = 1;
  } else {
    await run(reqPath);
  }
}
