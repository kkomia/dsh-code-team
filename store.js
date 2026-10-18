/**
 * store.js — 「开发进度看板」纯存储模块（Host 与测试共用）
 * ============================================================================
 * 设计约束（见 work/PROTOCOL.md §2）：
 *   1. 本文件是**纯模块**：只 import node 内置模块，不 import 任何 dsh 宿主包，
 *      因此可以被 `node --test test/store.test.mjs` 直接加载、单独测试。
 *   2. 看板数据是 JSON 友好对象；所有导出函数都是「输入 board → 输出新 board」
 *      的纯函数（不原地改输入），时间戳可显式传入，方便断言。
 *   3. 持久化由 `createStore({ dir })` 负责：`$DSH_HOME/project-dev/boards/<boardId>.json`，
 *      写入用「临时文件 + rename」原子替换；同一进程内按 boardId 用 promise 队列串行化，
 *      避免并发工具调用把文件写坏。
 *   4. 字段契约逐字对齐 PROTOCOL §2.1；audit 输出逐字对齐 PROTOCOL §2.4。
 * ============================================================================
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** 看板文件版本（BUNDLE 常量同名）。 */
export const BOARD_VERSION = 1
/** PROTOCOL §0 的常量名。 */
export const BOARD_FILE_VERSION = 1
/** boardId 前缀。 */
export const BOARD_ID_PREFIX = 'pb-'

/** 修改点类别（逐字对齐 PROTOCOL §2.1）。 */
export const CATEGORIES = ['UI', '功能', '缺陷', '性能', '文案', '架构', '其他']
/** 修改点优先级。 */
export const PRIORITIES = ['P0', 'P1', 'P2']
/** 修改点状态机允许的全部状态。 */
export const ITEM_STATUSES = [
  'pending',
  'dispatched',
  'running',
  'testing',
  'tested',
  'accepting',
  'accepted',
  'rejected',
  'blocked',
  'obsolete',
]
/** 分派环节。 */
export const STAGES = ['research', 'design', 'frontend', 'backend', 'test', 'acceptance']
/** 环节 → 默认职位。 */
export const STAGE_ROLES = {
  research: '调研员',
  design: '设计师',
  frontend: '前端工程师',
  backend: '后端工程师',
  test: '测试员',
  acceptance: '验收员',
}
/** 返工结果。 */
export const ATTEMPT_OUTCOMES = ['fixed', 'unfixed', 'partial']
/** update 动作全集（PROTOCOL §2.2）。 */
export const ACTIONS = [
  'dispatch',
  'start',
  'test',
  'accept',
  'reject',
  'fail',
  'attempt',
  'block',
  'obsolete',
  'reopen',
  'redefine',
  'unmerge',
]
/** 成员状态。 */
export const TEAM_MEMBER_STATUSES = ['active', 'retired']
/** 对标差距状态。 */
export const COMPARISON_STATUSES = ['open', 'closed']

const DAY_MS = 24 * 60 * 60 * 1000
/** 参考方案对标过期阈值（PROTOCOL §2.4：14 天）。 */
export const REFERENCE_STALE_MS = 14 * DAY_MS
/** 执行中条目 stale 阈值。 */
export const RUNNING_STALE_MS = DAY_MS

/* ------------------------------------------------------------------ */
/* 错误与基础工具                                                      */
/* ------------------------------------------------------------------ */

/**
 * 构造带稳定错误码的看板错误。工具层会把它转成 isError，code 方便诊断。
 * @param {string} code 稳定错误码（如 BOARD_ITEM_NOT_FOUND）。
 * @param {string} [message] 可读消息。
 * @param {object} [extra] 附加到 error 对象上的字段。
 * @returns {Error}
 */
export function boardError(code, message, extra) {
  const error = new Error(message || code)
  error.name = 'BoardError'
  error.code = code
  if (extra && typeof extra === 'object') Object.assign(error, extra)
  return error
}

/** @returns {boolean} 是否为普通对象。 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 取字符串（非字符串给 fallback）。 */
function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/** 取非负有限数字，否则 fallback。 */
function finiteNumber(value, fallback = 0) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

/** 取正整数，否则 fallback。 */
function positiveInt(value, fallback = 1) {
  const number = finiteNumber(value, fallback)
  const int = Math.trunc(number)
  return int >= 1 ? int : fallback
}

/** 时间戳归一：非法/缺失时用 fallback（默认当前时间）。 */
function timestamp(value, fallback = Date.now()) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < 0) return Math.trunc(fallback)
  return Math.trunc(number)
}

/** 白名单取值，否则 fallback。 */
function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

/** 序号 → PB-001。 */
function itemIdOf(number) {
  return `${BOARD_ID_PREFIX === 'pb-' ? 'PB' : 'PB'}-${String(number).padStart(3, '0')}`
}

/** 深拷贝一张看板（JSON 数据，无循环引用）。 */
function cloneBoard(board) {
  return JSON.parse(JSON.stringify(board))
}

/** 在备注后追加一行。 */
function appendNote(note, line) {
  const head = text(note).trim()
  const tail = text(line).trim()
  if (!tail) return head
  return head ? `${head}\n${tail}` : tail
}

/** 从分派环节反查成员职位。 */
function roleForMember(item, member) {
  const key = text(member).trim()
  if (!key) return ''
  const stages = Array.isArray(item?.dispatch?.stages) ? item.dispatch.stages : []
  for (let index = stages.length - 1; index >= 0; index -= 1) {
    if (stages[index].member === key) return text(stages[index].role)
  }
  return ''
}

/** 把某个分派环节标记为 running（不存在的环节忽略）。 */
function markStageRunning(item, member, at) {
  const key = text(member).trim()
  if (!key) return
  const stages = Array.isArray(item.dispatch.stages) ? item.dispatch.stages : []
  for (let index = stages.length - 1; index >= 0; index -= 1) {
    if (stages[index].member !== key) continue
    stages[index].status = 'running'
    stages[index].at = at
    return
  }
}

/** 把某个分派环节标记为 done。 */
function markStageDone(item, stage, member, at) {
  const stages = Array.isArray(item.dispatch.stages) ? item.dispatch.stages : []
  for (let index = stages.length - 1; index >= 0; index -= 1) {
    const row = stages[index]
    if (row.stage !== stage) continue
    if (member && row.member && row.member !== member) continue
    row.status = 'done'
    row.at = at
    return
  }
}

/* ------------------------------------------------------------------ */
/* 字段归一（normalize）                                               */
/* ------------------------------------------------------------------ */

/**
 * 兼容缺字段/旧版本：把任意输入归一到当前的 Board 结构。
 * 传入非对象时返回 null（调用方据此判断文件损坏/不存在）。
 * @param {unknown} raw
 * @returns {object|null}
 */
export function normalizeBoard(raw) {
  if (!isRecord(raw)) return null
  const workspacePath = text(raw.workspacePath)
  const boardId = text(raw.boardId).trim() || boardIdFor(workspacePath)
  const items = []
  const rawItems = Array.isArray(raw.items) ? raw.items : []
  for (let index = 0; index < rawItems.length; index += 1) {
    const item = normalizeItem(rawItems[index], index)
    if (item) items.push(item)
  }
  const maxNumber = items.reduce((max, item) => Math.max(max, item.number), 0)
  const team = []
  const rawTeam = Array.isArray(raw.team) ? raw.team : []
  for (const row of rawTeam) {
    const member = normalizeTeamMember(row)
    if (member) team.push(member)
  }
  return {
    version: BOARD_VERSION,
    boardId,
    projectName: text(raw.projectName).trim() || basename(workspacePath || '') || '未命名项目',
    workspacePath,
    createdAt: timestamp(raw.createdAt, 0),
    updatedAt: timestamp(raw.updatedAt, 0),
    nextItemNumber: Math.max(positiveInt(raw.nextItemNumber, 1), maxNumber + 1),
    reference: normalizeReference(raw.reference),
    team,
    items,
  }
}

/** 归一一个团队名册行（TeamMember）。 */
function normalizeTeamMember(raw) {
  if (!isRecord(raw)) return null
  const member = text(raw.member).trim()
  const role = text(raw.role).trim()
  if (!member && !role) return null
  const since = timestamp(raw.since, 0)
  return {
    role: role || '成员',
    member: member || role,
    duties: text(raw.duties),
    status: pick(raw.status, TEAM_MEMBER_STATUSES, 'active'),
    since,
    updatedAt: timestamp(raw.updatedAt, since),
  }
}

/** 归一参考方案（Reference），空对象返回 null。 */
function normalizeReference(raw) {
  if (!isRecord(raw)) return null
  const comparison = []
  const rows = Array.isArray(raw.comparison) ? raw.comparison : []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const dimension = text(row.dimension).trim()
    if (!dimension) continue
    comparison.push({
      dimension,
      reference: text(row.reference),
      ours: text(row.ours),
      gap: text(row.gap),
      status: pick(row.status, COMPARISON_STATUSES, 'open'),
    })
  }
  return {
    name: text(raw.name),
    source: text(raw.source),
    pinnedVersion: text(raw.pinnedVersion),
    lastComparedAt: timestamp(raw.lastComparedAt, 0),
    comparison,
  }
}

/** 归一一个分派环节（Stage）。 */
function normalizeStage(raw) {
  if (!isRecord(raw)) return null
  return {
    stage: pick(raw.stage, STAGES, 'research'),
    role: text(raw.role),
    member: text(raw.member),
    status: pick(raw.status, ['dispatched', 'running', 'done'], 'dispatched'),
    at: timestamp(raw.at, 0),
    note: text(raw.note),
  }
}

/** 归一一次返工记录（Attempt）。 */
function normalizeAttempt(raw, index) {
  if (!isRecord(raw)) return null
  return {
    round: positiveInt(raw.round, index + 1),
    member: text(raw.member),
    role: text(raw.role),
    symptom: text(raw.symptom),
    cause: text(raw.cause),
    fix: text(raw.fix),
    outcome: pick(raw.outcome, ATTEMPT_OUTCOMES, 'unfixed'),
    evidence: text(raw.evidence),
    at: timestamp(raw.at, 0),
  }
}

/** 归一一个修改点（Item）。 */
function normalizeItem(raw, index) {
  if (!isRecord(raw)) return null
  const number = positiveInt(raw.number, index + 1)
  const dispatch = isRecord(raw.dispatch) ? raw.dispatch : {}
  const stages = []
  for (const row of Array.isArray(dispatch.stages) ? dispatch.stages : []) {
    const stage = normalizeStage(row)
    if (stage) stages.push(stage)
  }
  const attempts = []
  for (const row of Array.isArray(raw.attempts) ? raw.attempts : []) {
    const attempt = normalizeAttempt(row, attempts.length)
    if (attempt) attempts.push(attempt)
  }
  const execution = isRecord(raw.execution) ? raw.execution : {}
  const test = isRecord(raw.test) ? raw.test : {}
  const acceptance = isRecord(raw.acceptance) ? raw.acceptance : {}
  const createdAt = timestamp(raw.createdAt, 0)
  return {
    id: text(raw.id).trim() || itemIdOf(number),
    number,
    title: text(raw.title),
    userQuote: text(raw.userQuote),
    detail: text(raw.detail),
    category: pick(raw.category, CATEGORIES, '其他'),
    priority: pick(raw.priority, PRIORITIES, 'P2'),
    status: pick(raw.status, ITEM_STATUSES, 'pending'),
    createdAt,
    updatedAt: timestamp(raw.updatedAt, createdAt),
    dispatch: {
      done: dispatch.done === true,
      at: timestamp(dispatch.at, 0),
      stages,
    },
    execution: {
      status: pick(execution.status, ['idle', 'running', 'done'], 'idle'),
      owner: text(execution.owner),
      startedAt: timestamp(execution.startedAt, 0),
      updatedAt: timestamp(execution.updatedAt, 0),
    },
    test: {
      status: pick(test.status, ['pending', 'running', 'passed', 'failed'], 'pending'),
      member: text(test.member),
      evidence: text(test.evidence),
      at: timestamp(test.at, 0),
    },
    acceptance: {
      status: pick(acceptance.status, ['pending', 'passed', 'rejected'], 'pending'),
      member: text(acceptance.member),
      evidence: text(acceptance.evidence),
      at: timestamp(acceptance.at, 0),
    },
    attempts,
    mergedFrom: Array.isArray(raw.mergedFrom) ? raw.mergedFrom.filter((id) => typeof id === 'string') : [],
    mergedInto: typeof raw.mergedInto === 'string' && raw.mergedInto ? raw.mergedInto : null,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === 'string') : [],
    note: text(raw.note),
  }
}

/* ------------------------------------------------------------------ */
/* 空看板与 boardId                                                   */
/* ------------------------------------------------------------------ */

/**
 * 工作区路径 → 稳定 boardId：`pb-` + sha1(归一化路径).slice(0,8)。
 * 归一化：反斜杠转正斜杠、去尾部斜杠、转小写（Windows 路径大小写不敏感），
 * 因此同一工作区在不同写法（C:\a 与 c:/a/）下指向同一张看板。
 * @param {string} workspacePath
 * @returns {string} `pb-xxxxxxxx`
 */
export function boardIdFor(workspacePath) {
  const raw = text(workspacePath)
  let normalized = raw.replace(/\\/g, '/')
  normalized = normalized.replace(/\/+$/, '')
  normalized = normalized.toLowerCase()
  if (!normalized) normalized = '(unknown)'
  const hash = createHash('sha1').update(normalized, 'utf8').digest('hex')
  return `${BOARD_ID_PREFIX}${hash.slice(0, 8)}`
}

/**
 * 创建一张空看板。
 * @param {{ projectName?: string, workspacePath?: string, boardId?: string }} [input]
 * @returns {object} Board
 */
export function emptyBoard(input = {}) {
  const workspacePath = text(input.workspacePath)
  const now = Date.now()
  return {
    version: BOARD_VERSION,
    boardId: text(input.boardId).trim() || boardIdFor(workspacePath),
    projectName: text(input.projectName).trim() || basename(workspacePath || '') || '未命名项目',
    workspacePath,
    createdAt: now,
    updatedAt: now,
    nextItemNumber: 1,
    reference: null,
    team: [],
    items: [],
  }
}

/* ------------------------------------------------------------------ */
/* 统计与审计规则                                                      */
/* ------------------------------------------------------------------ */

/** 返工（未修复）次数。 */
function reworkCount(item) {
  const attempts = Array.isArray(item?.attempts) ? item.attempts : []
  return attempts.filter((attempt) => attempt.outcome !== 'fixed').length
}

/** 未派单：pending 且 dispatch.done=false。 */
function isUndispatched(item) {
  return item.status === 'pending' && item.dispatch?.done !== true
}

/** 未测试：已执行/已测试但无 passed test（dispatched/running/testing/rejected）。 */
function isUntested(item) {
  if (!['dispatched', 'running', 'testing', 'rejected'].includes(item.status)) return false
  return item.test?.status !== 'passed'
}

/** 未验收：测试已通过但没有 passed acceptance。 */
function isUnaccepted(item) {
  if (item.status === 'obsolete') return false
  if (item.test?.status !== 'passed') return false
  return item.acceptance?.status !== 'passed'
}

/** 待确认：note/detail 含「待确认」，或 pending 且没有用户原话。 */
function isPendingConfirm(item) {
  if (text(item.note).includes('待确认') || text(item.detail).includes('待确认')) return true
  return item.status === 'pending' && text(item.userQuote).trim() === ''
}

/**
 * 看板统计。`byStatus` 含全部状态（缺省 0）；顶层同时给出常用计数，
 * 兼容 PROTOCOL §2（statsOf）与 §7 断言（stats.dispatched / stats.accepted）。
 * @param {object} board
 * @param {number} [now]
 * @returns {object} stats
 */
export function statsOf(board, now = Date.now()) {
  const items = Array.isArray(board?.items) ? board.items : []
  const byStatus = {}
  for (const status of ITEM_STATUSES) byStatus[status] = 0
  for (const item of items) {
    if (Object.hasOwn(byStatus, item.status)) byStatus[item.status] += 1
  }
  const stats = {
    total: items.length,
    byStatus,
    pending: byStatus.pending,
    dispatched: byStatus.dispatched,
    running: byStatus.running,
    testing: byStatus.testing,
    tested: byStatus.tested,
    accepting: byStatus.accepting,
    accepted: byStatus.accepted,
    rejected: byStatus.rejected,
    blocked: byStatus.blocked,
    obsolete: byStatus.obsolete,
    undispatched: 0,
    untested: 0,
    unaccepted: 0,
    rework: 0,
    pendingConfirm: 0,
  }
  for (const item of items) {
    if (isUndispatched(item)) stats.undispatched += 1
    if (isUntested(item)) stats.untested += 1
    if (isUnaccepted(item)) stats.unaccepted += 1
    if (reworkCount(item) >= 2) stats.rework += 1
    if (isPendingConfirm(item)) stats.pendingConfirm += 1
  }
  return stats
}

/**
 * 完整性审计（逐字对齐 PROTOCOL §2.4）。
 * @param {object} board
 * @param {number} [now]
 * @returns {{ audit: object, stats: object }}
 */
export function audit(board, now = Date.now()) {
  const at = timestamp(now, Date.now())
  const items = Array.isArray(board?.items) ? board.items : []
  const undispatched = []
  const untested = []
  const unaccepted = []
  const pendingConfirm = []
  const rework = []
  const staleRunning = []
  let mergedCount = 0
  for (const item of items) {
    if (isUndispatched(item)) undispatched.push(item.id)
    if (isUntested(item)) untested.push(item.id)
    if (isUnaccepted(item)) unaccepted.push(item.id)
    if (isPendingConfirm(item)) pendingConfirm.push(item.id)
    if (reworkCount(item) >= 2) rework.push(item.id)
    if (item.mergedInto) mergedCount += 1
    const execution = item.execution
    if (
      execution?.status === 'running' &&
      typeof execution.updatedAt === 'number' &&
      execution.updatedAt > 0 &&
      at - execution.updatedAt > RUNNING_STALE_MS
    ) {
      staleRunning.push(item.id)
    }
  }
  const reference = board?.reference ?? null
  const referenceStale =
    reference === null ||
    !(typeof reference.lastComparedAt === 'number') ||
    reference.lastComparedAt <= 0 ||
    at - reference.lastComparedAt > REFERENCE_STALE_MS
  return {
    audit: {
      undispatched,
      untested,
      unaccepted,
      pendingConfirm,
      rework,
      staleRunning,
      referenceStale,
      mergedCount,
    },
    stats: statsOf(board, at),
  }
}

/* ------------------------------------------------------------------ */
/* 修改点：新增 / 更新 / 合并 / 参考方案                                */
/* ------------------------------------------------------------------ */

/**
 * 校验新增修改点的必填输入。
 * @param {object} input
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateItemInput(input) {
  if (!isRecord(input)) return { ok: false, error: '修改点参数必须是对象' }
  if (!text(input.title).trim()) return { ok: false, error: 'title 必填：一句话说明修改点' }
  if (!text(input.userQuote).trim()) {
    return { ok: false, error: 'userQuote 必填：必须逐字记录用户原话（不能用自己的总结代替）' }
  }
  if (input.category !== undefined && input.category !== null && !CATEGORIES.includes(input.category)) {
    return { ok: false, error: `category 必须是 ${CATEGORIES.join(' / ')}` }
  }
  if (input.priority !== undefined && input.priority !== null && !PRIORITIES.includes(input.priority)) {
    return { ok: false, error: `priority 必须是 ${PRIORITIES.join(' / ')}` }
  }
  if (input.mergeInto !== undefined && input.mergeInto !== null && typeof input.mergeInto !== 'string') {
    return { ok: false, error: 'mergeInto 必须是看板条目 id（如 PB-003）' }
  }
  return { ok: true }
}

/** 在 items 中找 id 的下标；找不到 -1。 */
function findItemIndex(items, itemId) {
  const id = text(itemId).trim()
  if (!id || !Array.isArray(items)) return -1
  return items.findIndex((item) => item.id === id)
}

/** 构造一次返工记录（round = 当前条目的第 N 次）。 */
function makeAttempt(item, payload, at) {
  const member = text(payload.member).trim()
  return {
    round: item.attempts.length + 1,
    member,
    role: text(payload.role).trim() || roleForMember(item, member),
    symptom: text(payload.symptom),
    cause: text(payload.cause),
    fix: text(payload.fix),
    outcome: pick(payload.outcome, ATTEMPT_OUTCOMES, 'unfixed'),
    evidence: text(payload.evidence),
    at,
  }
}

/**
 * 新增一个用户修改点；若给出 mergeInto，则作为该条目的新一轮返工记录，
 * 不新建条目（DESIGN §3.3 / PROTOCOL §2.2）。
 * @param {object} board
 * @param {object} input
 * @param {number} [now]
 * @returns {{ board: object, item: object }}
 */
export function addItem(board, input, now = Date.now()) {
  const working = cloneBoard(board)
  const check = validateItemInput(input)
  if (!check.ok) throw boardError('BOARD_INVALID_INPUT', check.error)
  const at = timestamp(now, Date.now())
  const mergeInto = text(input.mergeInto).trim()
  if (mergeInto) {
    let targetIndex = findItemIndex(working.items, mergeInto)
    if (targetIndex < 0) throw boardError('BOARD_ITEM_NOT_FOUND', `看板条目 ${mergeInto} 不存在`)
    let target = working.items[targetIndex]
    // 目标本身已被合并：顺着 mergedInto 找到最终条目，避免出现链式合并。
    while (target.mergedInto) {
      targetIndex = findItemIndex(working.items, target.mergedInto)
      if (targetIndex < 0) throw boardError('BOARD_INVALID_TRANSITION', `条目 ${target.id} 的合并目标不存在`)
      target = working.items[targetIndex]
    }
    if (target.status === 'obsolete') {
      throw boardError('BOARD_INVALID_TRANSITION', `条目 ${target.id} 已作废，不能继续记录返工；请先 reopen`)
    }
    if (text(input.userQuote).trim()) {
      const stamp = new Date(at).toISOString()
      target.userQuote = target.userQuote
        ? `${target.userQuote}\n\n【返工补充 ${stamp}】${text(input.userQuote)}`
        : text(input.userQuote)
    }
    const attempt = makeAttempt(target, {
      member: input.member,
      role: input.role,
      symptom: text(input.symptom) || text(input.title),
      cause: input.cause,
      fix: text(input.fix) || text(input.detail),
      evidence: input.evidence,
      outcome: 'unfixed',
    }, at)
    target.attempts.push(attempt)
    target.note = appendNote(target.note, `返工第 ${attempt.round} 次：${text(input.title).trim()}`)
    target.status = 'running'
    target.updatedAt = at
    target.execution = { ...target.execution, updatedAt: at }
    working.updatedAt = at
    return { board: working, item: target }
  }
  const number = positiveInt(working.nextItemNumber, 1)
  const item = {
    id: itemIdOf(number),
    number,
    title: text(input.title).trim(),
    userQuote: text(input.userQuote),
    detail: text(input.detail),
    category: pick(input.category, CATEGORIES, '其他'),
    priority: pick(input.priority, PRIORITIES, 'P2'),
    status: 'pending',
    createdAt: at,
    updatedAt: at,
    dispatch: { done: false, at: 0, stages: [] },
    execution: { status: 'idle', owner: '', startedAt: 0, updatedAt: at },
    test: { status: 'pending', member: '', evidence: '', at: 0 },
    acceptance: { status: 'pending', member: '', evidence: '', at: 0 },
    attempts: [],
    mergedFrom: [],
    mergedInto: null,
    tags: Array.isArray(input.tags) ? input.tags.filter((tag) => typeof tag === 'string') : [],
    note: text(input.note),
  }
  working.items.push(item)
  working.nextItemNumber = number + 1
  working.updatedAt = at
  return { board: working, item }
}

/**
 * 更新一个修改点（action 驱动，动作语义逐字对齐 PROTOCOL §2.2）。
 * @param {object} board
 * @param {object} input
 * @param {number} [now]
 * @returns {{ board: object, item: object|null, member?: object }}
 */
export function updateItem(board, input, now = Date.now()) {
  if (!isRecord(input)) throw boardError('BOARD_INVALID_INPUT', 'update 参数必须是对象')
  const action = text(input.action).trim()
  if (!ACTIONS.includes(action)) {
    throw boardError('BOARD_INVALID_ACTION', `未知 action「${action || '(空)'}」；可用：${ACTIONS.join(' / ')}`)
  }
  const at = timestamp(now, Date.now())
  const working = cloneBoard(board)
  // redesign：只改团队名册，item 本身不变（itemId 可为任意条目，也可省略）。
  if (action === 'redefine') return redefineMember(working, input, at)
  const itemId = text(input.itemId).trim()
  if (!itemId) throw boardError('BOARD_INVALID_INPUT', 'itemId 必填（redefine 除外）')
  const index = findItemIndex(working.items, itemId)
  if (index < 0) throw boardError('BOARD_ITEM_NOT_FOUND', `看板条目 ${itemId} 不存在`)
  const item = working.items[index]
  // unmerge 作用在「已被合并」的条目标签上，允许其缺席普通状态机校验。
  if (action === 'unmerge') {
    if (!item.mergedInto) {
      throw boardError('BOARD_INVALID_TRANSITION', `条目 ${item.id} 没有被合并，无需 unmerge`)
    }
    const targetIndex = findItemIndex(working.items, item.mergedInto)
    if (targetIndex >= 0) {
      const target = working.items[targetIndex]
      target.mergedFrom = target.mergedFrom.filter((id) => id !== item.id)
      target.updatedAt = at
    }
    item.mergedInto = null
    item.status = 'pending'
    item.note = appendNote(item.note, text(input.note) || `unmerge 恢复为独立条目`)
    item.updatedAt = at
    working.updatedAt = at
    return { board: working, item }
  }
  // blocked/obsolete 之外都允许；作废条目必须先 reopen（非法转移）。
  if (item.status === 'obsolete' && action !== 'reopen' && action !== 'obsolete') {
    throw boardError('BOARD_INVALID_TRANSITION', `条目 ${item.id} 已作废（obsolete）；请先 reopen 再操作`)
  }
  switch (action) {
    case 'dispatch': {
      const stage = text(input.stage).trim()
      if (!STAGES.includes(stage)) {
        throw boardError('BOARD_INVALID_INPUT', `dispatch 需要 stage（${STAGES.join(' / ')}）`)
      }
      const member = text(input.member).trim()
      if (!member) throw boardError('BOARD_INVALID_INPUT', 'dispatch 需要 member（派给了谁）')
      const role = text(input.role).trim() || STAGE_ROLES[stage] || ''
      const row = item.dispatch.stages.find((candidate) => candidate.stage === stage)
      const nextRow = {
        stage,
        role,
        member,
        status: 'dispatched',
        at,
        note: text(input.note),
      }
      if (row) Object.assign(row, nextRow)
      else item.dispatch.stages.push(nextRow)
      item.dispatch.done = true
      item.dispatch.at = at
      // PROTOCOL：只把 pending（以及退回态）推进到 dispatched；execution 保持原状（未开工时即 idle）。
      if (['pending', 'rejected', 'blocked'].includes(item.status)) item.status = 'dispatched'
      break
    }
    case 'start': {
      const member = text(input.member).trim() || text(input.owner).trim()
      if (member) item.execution.owner = member
      item.execution.status = 'running'
      if (!item.execution.startedAt) item.execution.startedAt = at
      item.execution.updatedAt = at
      item.status = 'running'
      markStageRunning(item, member || item.execution.owner, at)
      break
    }
    case 'test': {
      const member = text(input.member).trim()
      if (!member) throw boardError('BOARD_INVALID_INPUT', 'test 需要 member（谁测的）')
      const requested = text(input.status).trim()
      const testStatus = requested === 'failed' || requested === 'running' ? requested : 'passed'
      item.test = { status: testStatus, member, evidence: text(input.evidence), at }
      if (testStatus === 'passed') {
        item.status = 'tested'
        markStageDone(item, 'test', member, at)
      } else if (testStatus === 'failed') {
        item.status = 'running'
        const attempt = makeAttempt(item, {
          member,
          role: input.role,
          symptom: text(input.evidence) || text(input.note) || '测试未通过',
          cause: input.cause,
          fix: input.fix,
          evidence: text(input.evidence),
          outcome: 'unfixed',
        }, at)
        item.attempts.push(attempt)
        item.note = appendNote(item.note, `测试未通过：${attempt.symptom}`)
      } else {
        item.status = 'testing'
      }
      break
    }
    case 'accept': {
      const member = text(input.member).trim()
      if (!member) throw boardError('BOARD_INVALID_INPUT', 'accept 需要 member（谁验收的）')
      item.acceptance = { status: 'passed', member, evidence: text(input.evidence), at }
      item.status = 'accepted'
      markStageDone(item, 'acceptance', member, at)
      break
    }
    case 'reject': {
      const member = text(input.member).trim()
      if (!member) throw boardError('BOARD_INVALID_INPUT', 'reject 需要 member（谁验收的）')
      item.acceptance = { status: 'rejected', member, evidence: text(input.evidence), at }
      item.status = 'rejected'
      const attempt = makeAttempt(item, {
        member,
        role: input.role,
        symptom: text(input.evidence) || text(input.note) || '验收被拒绝',
        cause: input.cause,
        fix: input.fix,
        evidence: text(input.evidence),
        outcome: 'unfixed',
      }, at)
      item.attempts.push(attempt)
      item.note = appendNote(item.note, `验收拒绝：${attempt.symptom}`)
      break
    }
    case 'fail': {
      const member = text(input.member).trim()
      const symptom = text(input.symptom).trim()
      if (!member || !symptom) {
        throw boardError('BOARD_INVALID_INPUT', 'fail 需要 member 与 symptom（现象/返工原因）')
      }
      const attempt = makeAttempt(item, {
        member,
        role: input.role,
        symptom,
        cause: input.cause,
        fix: input.fix,
        evidence: input.evidence,
        outcome: 'unfixed',
      }, at)
      item.attempts.push(attempt)
      item.status = 'running'
      if (member) item.execution.owner = member
      item.execution.status = 'running'
      item.execution.updatedAt = at
      break
    }
    case 'attempt': {
      const member = text(input.member).trim()
      const symptom = text(input.symptom).trim()
      if (!member || !symptom) {
        throw boardError('BOARD_INVALID_INPUT', 'attempt 需要 member 与 symptom（本次返工的现象）')
      }
      const attempt = makeAttempt(item, {
        member,
        role: input.role,
        symptom,
        cause: input.cause,
        fix: input.fix,
        evidence: input.evidence,
        outcome: input.outcome,
      }, at)
      item.attempts.push(attempt)
      item.execution = { ...item.execution, updatedAt: at }
      break
    }
    case 'block': {
      const note = text(input.note).trim()
      if (!note) throw boardError('BOARD_INVALID_INPUT', 'block 需要 note（卡在哪）')
      item.status = 'blocked'
      item.note = appendNote(item.note, note)
      break
    }
    case 'obsolete': {
      item.status = 'obsolete'
      const note = text(input.note).trim()
      if (note) item.note = appendNote(item.note, note)
      break
    }
    case 'reopen': {
      item.status = 'running'
      item.test = { status: 'pending', member: '', evidence: '', at: 0 }
      item.acceptance = { status: 'pending', member: '', evidence: '', at: 0 }
      item.execution = { ...item.execution, status: 'idle', updatedAt: at }
      item.note = appendNote(item.note, text(input.note) || 'reopen：重新进入执行')
      break
    }
    default:
      throw boardError('BOARD_INVALID_ACTION', `未实现的 action「${action}」`)
  }
  item.updatedAt = at
  working.updatedAt = at
  return { board: working, item }
}

/** redefine：更新 board.team[] 中某个成员的定义（改职复用，不辞退）。 */
function redefineMember(working, input, at) {
  const memberKey = text(input.member).trim()
  if (!memberKey) throw boardError('BOARD_INVALID_INPUT', 'redefine 需要 member（要改职的成员）')
  const role = text(input.role).trim()
  if (!role) throw boardError('BOARD_INVALID_INPUT', 'redefine 需要 role（新的中文职位）')
  const row = findTeamMember(working.team, memberKey)
  if (!row) {
    throw boardError(
      'BOARD_MEMBER_NOT_FOUND',
      `团队名册里没有成员「${memberKey}」；当前成员：${working.team.map((entry) => entry.member).join('、') || '(空)'}`,
    )
  }
  row.role = role
  if (input.duties !== undefined) row.duties = text(input.duties)
  row.status = 'active'
  row.updatedAt = at
  const itemId = text(input.itemId).trim()
  const item = itemId ? working.items[findItemIndex(working.items, itemId)] ?? null : null
  working.updatedAt = at
  return { board: working, item, member: row }
}

/** 成员匹配：先精确匹配，再按「包含」唯一匹配（如「Ada」→「调研员 · Ada」）。 */
function findTeamMember(team, key) {
  if (!Array.isArray(team)) return null
  const wanted = text(key).trim()
  if (!wanted) return null
  const exact = team.find((entry) => entry.member === wanted || entry.role === wanted)
  if (exact) return exact
  const lower = wanted.toLowerCase()
  const loose = team.filter(
    (entry) =>
      entry.member.toLowerCase().includes(lower) || entry.role.toLowerCase().includes(lower),
  )
  return loose.length === 1 ? loose[0] : null
}

/**
 * 合并重复/关联条目到目标条目：来源 mergedInto=target.id 且 status='obsolete'，
 * 目标 mergedFrom 记录来源 id、attempts 追加来源的返工记录（重新编号 round）。
 * 禁止链式合并（来源已被合并则抛错）。
 * @param {object} board
 * @param {{ sourceIds: string[], targetId: string, note?: string }} input
 * @param {number} [now]
 * @returns {{ board: object, target: object }}
 */
export function mergeItems(board, input, now = Date.now()) {
  if (!isRecord(input)) throw boardError('BOARD_INVALID_INPUT', 'merge 参数必须是对象')
  const at = timestamp(now, Date.now())
  const targetId = text(input.targetId).trim()
  if (!targetId) throw boardError('BOARD_INVALID_INPUT', 'merge 需要 targetId（并入的目标条目）')
  const sourceIds = (Array.isArray(input.sourceIds) ? input.sourceIds : [])
    .map((id) => text(id).trim())
    .filter(Boolean)
  if (sourceIds.length === 0) throw boardError('BOARD_INVALID_INPUT', 'merge 需要 sourceIds（要并入的条目）')
  const working = cloneBoard(board)
  const targetIndex = findItemIndex(working.items, targetId)
  if (targetIndex < 0) throw boardError('BOARD_ITEM_NOT_FOUND', `目标条目 ${targetId} 不存在`)
  const target = working.items[targetIndex]
  if (target.mergedInto) {
    throw boardError('BOARD_INVALID_TRANSITION', `目标条目 ${targetId} 已被合并到 ${target.mergedInto}，禁止链式合并`)
  }
  if (target.status === 'obsolete') {
    throw boardError('BOARD_INVALID_TRANSITION', `目标条目 ${targetId} 已作废，不能作为合并目标`)
  }
  const sources = []
  for (const sourceId of sourceIds) {
    if (sourceId === targetId) throw boardError('BOARD_INVALID_TRANSITION', '不能把条目合并到它自己')
    const sourceIndex = findItemIndex(working.items, sourceId)
    if (sourceIndex < 0) throw boardError('BOARD_ITEM_NOT_FOUND', `来源条目 ${sourceId} 不存在`)
    const source = working.items[sourceIndex]
    if (source.mergedInto) {
      throw boardError('BOARD_INVALID_TRANSITION', `来源条目 ${sourceId} 已被合并到 ${source.mergedInto}，禁止链式合并`)
    }
    if (source.status === 'obsolete') {
      throw boardError('BOARD_INVALID_TRANSITION', `来源条目 ${sourceId} 已作废，不能合并`)
    }
    sources.push(source)
  }
  for (const source of sources) {
    for (const attempt of source.attempts) {
      target.attempts.push({ ...attempt, round: target.attempts.length + 1 })
    }
    if (!target.mergedFrom.includes(source.id)) target.mergedFrom.push(source.id)
    source.mergedInto = target.id
    source.status = 'obsolete'
    source.updatedAt = at
    source.note = appendNote(source.note, `已合并到 ${target.id}`)
  }
  const note = text(input.note).trim()
  target.note = appendNote(target.note, `合并自 ${sources.map((source) => source.id).join('、')}${note ? `：${note}` : ''}`)
  target.updatedAt = at
  working.updatedAt = at
  return { board: working, target }
}

/**
 * 设置/更新「参考方案」与对标差距表。name/source/pinnedVersion 只增改不覆盖空值；
 * comparison 按 dimension 合并（同维度覆盖，新维度追加）；有 comparison 时刷新 lastComparedAt。
 * @param {object} board
 * @param {object} patch
 * @param {number} [now]
 * @returns {{ board: object, reference: object }}
 */
export function setReference(board, patchInput, now = Date.now()) {
  if (!isRecord(patchInput)) throw boardError('BOARD_INVALID_INPUT', 'reference 参数必须是对象')
  const at = timestamp(now, Date.now())
  const working = cloneBoard(board)
  const current = working.reference ?? {
    name: '',
    source: '',
    pinnedVersion: '',
    lastComparedAt: 0,
    comparison: [],
  }
  const reference = {
    name: text(patchInput.name).trim() || current.name,
    source: text(patchInput.source).trim() || current.source,
    pinnedVersion: text(patchInput.pinnedVersion).trim() || current.pinnedVersion,
    lastComparedAt: current.lastComparedAt,
    comparison: Array.isArray(current.comparison) ? [...current.comparison] : [],
  }
  let compared = false
  if (Array.isArray(patchInput.comparison)) {
    for (const row of patchInput.comparison) {
      if (!isRecord(row)) continue
      const dimension = text(row.dimension).trim()
      if (!dimension) continue
      const entry = {
        dimension,
        reference: text(row.reference),
        ours: text(row.ours),
        gap: text(row.gap),
        status: pick(row.status, COMPARISON_STATUSES, 'open'),
      }
      const index = reference.comparison.findIndex((candidate) => candidate.dimension === dimension)
      if (index >= 0) reference.comparison[index] = entry
      else reference.comparison.push(entry)
    }
    compared = true
  }
  const comparedAt = Number(patchInput.lastComparedAt)
  if (Number.isFinite(comparedAt) && comparedAt > 0) {
    reference.lastComparedAt = Math.trunc(comparedAt)
  } else if (compared) {
    reference.lastComparedAt = at
  }
  working.reference = reference
  working.updatedAt = at
  return { board: working, reference }
}

/* ------------------------------------------------------------------ */
/* 查询：摘要 / 列表                                                   */
/* ------------------------------------------------------------------ */

/**
 * 修改点摘要（工具返回与列表共用；紧凑，避免大段回显）。
 * 字段含 id/number/title/status/dispatchDone/stages/execution/test/acceptance/rework。
 * @param {object} item
 * @returns {object}
 */
export function summarizeItem(item) {
  const execution = isRecord(item?.execution) ? item.execution : {}
  const test = isRecord(item?.test) ? item.test : {}
  const acceptance = isRecord(item?.acceptance) ? item.acceptance : {}
  const dispatch = isRecord(item?.dispatch) ? item.dispatch : {}
  return {
    id: text(item?.id),
    number: positiveInt(item?.number, 0),
    title: text(item?.title),
    category: text(item?.category),
    priority: text(item?.priority),
    status: text(item?.status),
    updatedAt: finiteNumber(item?.updatedAt, 0),
    dispatchDone: dispatch.done === true,
    stages: (Array.isArray(dispatch.stages) ? dispatch.stages : []).map((stage) => ({
      stage: text(stage.stage),
      role: text(stage.role),
      member: text(stage.member),
      status: text(stage.status),
      at: finiteNumber(stage.at, 0),
    })),
    execution: {
      status: text(execution.status),
      owner: text(execution.owner),
    },
    test: {
      status: text(test.status),
      member: text(test.member),
      evidence: text(test.evidence),
    },
    acceptance: {
      status: text(acceptance.status),
      member: text(acceptance.member),
      evidence: text(acceptance.evidence),
    },
    attempts: Array.isArray(item?.attempts) ? item.attempts.length : 0,
    rework: reworkCount(item),
    mergedFrom: Array.isArray(item?.mergedFrom) ? [...item.mergedFrom] : [],
    mergedInto: typeof item?.mergedInto === 'string' ? item.mergedInto : null,
    note: text(item?.note),
  }
}

/**
 * 看板摘要（open 工具返回）。
 * @param {object} board
 * @param {number} [now]
 * @returns {object}
 */
export function summarizeBoard(board, now = Date.now()) {
  const items = Array.isArray(board?.items) ? board.items : []
  return {
    boardId: text(board?.boardId),
    projectName: text(board?.projectName),
    workspacePath: text(board?.workspacePath),
    createdAt: finiteNumber(board?.createdAt, 0),
    updatedAt: finiteNumber(board?.updatedAt, 0),
    reference: board?.reference ?? null,
    team: Array.isArray(board?.team) ? board.team.map((member) => ({ ...member })) : [],
    stats: statsOf(board, now),
    items: items.map(summarizeItem),
  }
}

/** 状态过滤器：支持 'pending' / 'pending,running' / 'pending running' / 数组。 */
function normalizeStatusFilter(value) {
  if (Array.isArray(value)) return value.map((entry) => text(entry).trim()).filter(Boolean)
  const raw = text(value)
  if (!raw.trim()) return []
  return raw
    .split(/[,，;；\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => ITEM_STATUSES.includes(entry))
}

/** 关键词匹配：id/标题/原话/理解/备注/标签/成员。 */
function matchesQuery(item, query) {
  const haystack = [
    text(item.id),
    text(item.title),
    text(item.userQuote),
    text(item.detail),
    text(item.note),
    ...(Array.isArray(item.tags) ? item.tags : []),
    ...(Array.isArray(item.dispatch?.stages) ? item.dispatch.stages.map((stage) => `${stage.role} ${stage.member}`) : []),
  ]
    .join('\n')
    .toLowerCase()
  return haystack.includes(query)
}

/**
 * 精简列出修改点（供 Lead 与工程进度对照员审计）。
 * @param {object} board
 * @param {{ status?: string|string[], category?: string, query?: string, limit?: number }} [filter]
 * @param {number} [now]
 * @returns {{ items: object[], stats: object }}
 */
export function listItems(board, filter = {}, now = Date.now()) {
  const options = isRecord(filter) ? filter : {}
  const statusFilter = normalizeStatusFilter(options.status)
  const category = text(options.category).trim()
  const query = text(options.query).trim().toLowerCase()
  const limit = Math.min(500, positiveInt(options.limit, 200))
  let items = Array.isArray(board?.items) ? board.items.slice() : []
  if (statusFilter.length > 0) items = items.filter((item) => statusFilter.includes(item.status))
  if (category) items = items.filter((item) => item.category === category)
  if (query) items = items.filter((item) => matchesQuery(item, query))
  items.sort((left, right) => left.number - right.number)
  return {
    items: items.slice(0, limit).map(summarizeItem),
    stats: statsOf(board, now),
  }
}

/* ------------------------------------------------------------------ */
/* 文件存储：原子写 + 进程内串行队列                                    */
/* ------------------------------------------------------------------ */

/** 清洗 boardId，避免路径穿越。 */
function sanitizeBoardId(boardId) {
  const raw = text(boardId).trim()
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '').slice(0, 120)
  if (!cleaned) throw boardError('BOARD_INVALID_BOARD_ID', `非法 boardId：${JSON.stringify(raw)}`)
  return cleaned
}

/** Windows 上 rename 可能短暂被占用（EPERM/EBUSY），小步重试。 */
async function renameWithRetry(from, to, attempts = 5) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      lastError = error
      const code = error?.code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error
      await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)))
    }
  }
  throw lastError
}

/**
 * 创建文件存储。
 * - `dir`：boards 目录（`$DSH_HOME/project-dev/boards`）。
 * - `clock`：注入时钟（测试用）。
 * 同一 boardId 的读-改-写通过 promise 队列串行化。
 * @param {{ dir: string, clock?: () => number }} options
 * @returns {object} store
 */
export function createStore(options = {}) {
  const dir = text(options.dir).trim()
  if (!dir) throw new Error('createStore: dir 必填（boards 目录）')
  const clock = typeof options.clock === 'function' ? options.clock : Date.now
  const now = () => {
    const value = Number(clock())
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now()
  }
  /** @type {Map<string, Promise<unknown>>} */
  const queues = new Map()
  let tmpCounter = 0

  const fileOf = (boardId) => join(dir, `${sanitizeBoardId(boardId)}.json`)

  /** 在某个 boardId 的串行队列里执行 fn；队列不因单次失败而中断。 */
  function withQueue(boardId, fn) {
    const previous = queues.get(boardId) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    queues.set(boardId, tail)
    tail.then(() => {
      if (queues.get(boardId) === tail) queues.delete(boardId)
    })
    return run
  }

  /** 原子写整张看板。 */
  async function saveFile(boardId, board) {
    const target = fileOf(boardId)
    await mkdir(dir, { recursive: true })
    tmpCounter += 1
    const tmp = `${target}.${process.pid}.${tmpCounter}.tmp`
    const payload = `${JSON.stringify(board, null, 2)}\n`
    await writeFile(tmp, payload, 'utf8')
    await renameWithRetry(tmp, target)
    return target
  }

  /**
   * 读取一张看板；文件不存在返回 null；JSON 损坏抛 BOARD_CORRUPT。
   * @param {string} boardId
   * @returns {Promise<object|null>}
   */
  async function load(boardId) {
    const file = fileOf(boardId)
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw boardError('BOARD_IO_ERROR', `读取看板失败：${file}：${error?.message ?? error}`)
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw boardError('BOARD_CORRUPT', `看板文件不是合法 JSON：${file}：${error?.message ?? error}`)
    }
    const board = normalizeBoard(parsed)
    if (!board) throw boardError('BOARD_CORRUPT', `看板文件结构无效：${file}`)
    board.boardId = text(board.boardId) || text(boardId)
    return board
  }

  /**
   * 打开/创建看板。同 boardId 串行；`transform(board, at, created)` 可在落盘前
   * 补充团队名册/参考方案等（返回新 board 或就地修改均可）。
   * @param {{ boardId: string, workspacePath?: string, projectName?: string,
   *           transform?: (board: object, at: number, created: boolean) => object|void }} input
   * @returns {Promise<{ board: object, created: boolean }>}
   */
  async function open(input = {}) {
    const boardId = sanitizeBoardId(text(input.boardId) || boardIdFor(text(input.workspacePath)))
    return withQueue(boardId, async () => {
      const at = now()
      const existing = await load(boardId)
      const created = existing === null
      let board = existing ?? emptyBoard({
        boardId,
        workspacePath: text(input.workspacePath),
        projectName: text(input.projectName),
      })
      const projectName = text(input.projectName).trim()
      if (projectName) board.projectName = projectName
      if (!board.workspacePath && text(input.workspacePath)) board.workspacePath = text(input.workspacePath)
      if (typeof input.transform === 'function') {
        const transformed = input.transform(board, at, created)
        if (transformed && isRecord(transformed)) board = transformed
      }
      const normalized = normalizeBoard(board) ?? board
      normalized.boardId = boardId
      normalized.updatedAt = at
      await saveFile(boardId, normalized)
      return { board: normalized, created }
    })
  }

  /**
   * 对已有看板做一次读-改-写（不存在则抛 BOARD_NOT_FOUND）。
   * @param {string} boardId
   * @param {(board: object, at: number) => { board: object, value?: unknown }} apply
   * @returns {Promise<{ board: object, value: unknown }>}
   */
  async function mutate(boardId, apply) {
    const id = sanitizeBoardId(boardId)
    return withQueue(id, async () => {
      const at = now()
      const loaded = await load(id)
      if (loaded === null) {
        throw boardError('BOARD_NOT_FOUND', '当前工作区还没有开发看板：先调用 project_board_open')
      }
      const result = apply(loaded, at)
      if (!isRecord(result) || !isRecord(result.board)) {
        throw boardError('BOARD_INVALID_INPUT', 'store.mutate 的回调必须返回 { board }')
      }
      const normalized = normalizeBoard(result.board) ?? loaded
      normalized.boardId = id
      normalized.updatedAt = at
      await saveFile(id, normalized)
      return { board: normalized, value: result.value }
    })
  }

  /**
   * 覆盖保存一张看板（一般用 open/mutate；保留给测试与诊断）。
   * @param {object} board
   * @returns {Promise<{ board: object }>}
   */
  async function save(board) {
    const normalized = normalizeBoard(board)
    if (!normalized) throw boardError('BOARD_INVALID_INPUT', 'save 需要合法的看板对象')
    const boardId = sanitizeBoardId(normalized.boardId)
    return withQueue(boardId, async () => {
      normalized.updatedAt = now()
      await saveFile(boardId, normalized)
      return { board: normalized }
    })
  }

  return {
    dir,
    now,
    fileOf,
    load,
    open,
    mutate,
    save,
  }
}

/** 工具摘要用到的默认导出集合（方便 board-tools 一次引入）。 */
export default {
  BOARD_VERSION,
  BOARD_FILE_VERSION,
  BOARD_ID_PREFIX,
  CATEGORIES,
  PRIORITIES,
  ITEM_STATUSES,
  STAGES,
  STAGE_ROLES,
  ATTEMPT_OUTCOMES,
  ACTIONS,
  boardError,
  boardIdFor,
  emptyBoard,
  normalizeBoard,
  validateItemInput,
  addItem,
  updateItem,
  mergeItems,
  setReference,
  listItems,
  statsOf,
  audit,
  summarizeItem,
  summarizeBoard,
  createStore,
}
