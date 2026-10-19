/**
 * index.js — dsh-project-dev 的 Host 半端
 * ============================================================================
 * 职责（对齐 work/PROTOCOL.md §1 / §5 与 work/DESIGN.md §3.1/§3.4）：
 *   1. 提供 Host 服务 `projectBoard`（board-tools.js 通过它读写看板）：
 *        openBoard / snapshot / addItem / updateItem / pruneItems / mergeItems / setReference /
 *        listItems / audit。
 *   2. 注册只读 HTTP 快照路由 `GET /api/project-board/snapshot?sessionId=`，
 *      供聊天内悬浮看板（client.js）轮询。
 *   3. 看板按「会话工作区路径」归并：boardId = pb- + sha1(workspacePath)[0:8]；
 *      存储 `$DSH_HOME/project-dev/boards/<boardId>.json`（原子写 + 进程内串行队列，
 *      见 store.js 的 createStore）。
 *
 * 设计约束：
 *   - 不 import 任何宿主私有包，只用 node 内置模块 + ctx 注入的服务。
 *   - 路由 handler 永不 reject，永远返回 JSON（404/405/400/500 都有兜底）。
 *   - sessionId 必须对应 live session（= Agent.id），否则工具层收到 isError；
 *     路由层转成 400 {ok:false,error:'session-not-live'}。
 * ============================================================================
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  addItem as addItemToBoard,
  audit as auditBoard,
  boardError,
  boardIdFor,
  createStore,
  listItems as listItemsOfBoard,
  mergeItems as mergeItemsOfBoard,
  pruneItems as pruneItemsOfBoard,
  setReference as setReferenceOfBoard,
  statsOf,
  updateItem as updateItemOfBoard,
} from './store.js'

/** Cordis 插件名（与 package name 一致）。 */
export const name = 'dsh-project-dev'

/**
 * 需要的 Host 服务：会话表（快照路由依赖 webServer，但它是可选服务——
 * headless/tui 等无浏览器面的部署里插件仍应提供 projectBoard 服务与工具）。
 */
export const inject = ['sessions']

/** PROTOCOL §0 常量。 */
export const BUNDLE_NAME = 'dsh-project-dev'
export const ROUTE_PREFIX = '/api/project-board'
export const SNAPSHOT_PATH = '/api/project-board/snapshot'
export const STORE_DIR_NAME = 'project-dev'

/** 未编码时的兜底 JSON。 */
const ENCODING_FALLBACK = '{"ok":false,"error":"response could not be encoded"}'

/* ------------------------------------------------------------------ */
/* 路径与工具                                                          */
/* ------------------------------------------------------------------ */

/**
 * `$DSH_HOME`：优先用宿主注入的 `dshHomePath` 服务（注意：在 profile 里它是**函数**，
 * `dshHomePath(...segments) => join(resolveDshHome(), ...segments)`，不是字符串），
 * 取不到再退 `$DSH_HOME` 环境变量、最后退 `~/.dsh`。
 * @param {object} [ctx] Cordis 上下文（可省略）
 */
export function dshHome(ctx) {
  try {
    const homePath = ctx && typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined
    if (typeof homePath === 'function') {
      const resolved = homePath()
      if (typeof resolved === 'string' && resolved.trim() !== '') return resolved
    } else if (typeof homePath === 'string' && homePath.trim() !== '') {
      return homePath
    }
  } catch {
    /* 拿不到就用下面的兜底 */
  }
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 看板 boards 目录：`$DSH_HOME/project-dev/boards`。 */
export function boardsDir(ctx) {
  return join(dshHome(ctx), STORE_DIR_NAME, 'boards')
}

/** 把任意异常渲染成一行可读文本。 */
function errorText(error) {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  try {
    const value = String(error)
    return value === '[object Object]' ? 'Unexpected error' : value
  } catch {
    return 'Unexpected error'
  }
}

/** 日志（没有 logger 也不崩）。 */
function makeLogger(ctx) {
  return (message) => {
    try {
      ctx.logger?.warn?.(`[dsh-project-dev] ${message}`)
    } catch {
      /* 日志失败无所谓 */
    }
  }
}

/** 安全 JSON 序列化 + 写响应（team-console 同款兜底）。 */
function writeJson(res, statusCode, body) {
  if (!res || typeof res.writeHead !== 'function' || typeof res.end !== 'function') return false
  let payload
  try {
    payload = JSON.stringify(body ?? null)
  } catch {
    payload = ENCODING_FALLBACK
  }
  if (typeof payload !== 'string') payload = ENCODING_FALLBACK
  try {
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(payload)
    return true
  } catch {
    try {
      res.end()
    } catch {
      /* 连接已经没了 */
    }
    return false
  }
}

/** 解析请求 URL；失败返回 null。 */
function parseUrl(req) {
  try {
    const raw = req && typeof req.url === 'string' ? req.url : '/'
    return new URL(raw, 'http://127.0.0.1')
  } catch {
    return null
  }
}

/**
 * 复用宿主 connection 服务的 Host/Origin 围栏与浏览器会话准入（若该服务存在）。
 * 与 dsh-agent-team-console 的 admission 写法一致：没有 connection 服务时放行。
 * @returns {number|null} 401 / 403 / null
 */
export function admissionRejection(ctx, req) {
  let connection
  try {
    connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  } catch {
    connection = undefined
  }
  if (!connection || typeof connection.requestRejection !== 'function') return null
  try {
    const rejection = connection.requestRejection(req)
    return rejection === 401 || rejection === 403 ? rejection : null
  } catch {
    return 401
  }
}

/* ------------------------------------------------------------------ */
/* 团队名册同步（来自 Host 的 agentTeams 服务，读取失败一律降级为空）      */
/* ------------------------------------------------------------------ */

/** agentTeams 服务是否可用。 */
function agentTeamsOf(ctx) {
  try {
    const teams = typeof ctx.get === 'function' ? ctx.get('agentTeams') : undefined
    return teams && typeof teams.listMembers === 'function' ? teams : undefined
  } catch {
    return undefined
  }
}

/** agents 服务是否可用。 */
function agentsOf(ctx) {
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    return agents && typeof agents.get === 'function' ? agents : undefined
  } catch {
    return undefined
  }
}

/**
 * 把一个 agent-team 成员行转成看板 team[] 行。
 * 成员显示 = description 里「中文职位 · 英文昵称」的首段；读不到时退回 name。
 */
function rosterRow(member) {
  if (!member || typeof member !== 'object') return null
  const name = typeof member.name === 'string' ? member.name.trim() : ''
  const description = typeof member.description === 'string' ? member.description.trim() : ''
  const head = description.split(/[｜|]/)[0].trim()
  const match = /^(.+?)\s*·\s*(\S.+)$/.exec(head)
  const isLead = member.role === 'lead'
  if (match) {
    const role = match[1].trim()
    return {
      role,
      member: `${role} · ${match[2].trim()}`,
      duties: description || role,
      key: name || role,
    }
  }
  const role = isLead ? '总指挥' : '成员'
  return {
    role,
    member: isLead ? 'Lead' : name || '成员',
    duties: description || role,
    key: name || (isLead ? 'lead' : ''),
  }
}

/** 读取当前 Lead 会话的团队名册（任何一步失败都降级为空数组）。 */
function liveRoster(ctx, sessionId) {
  const teams = agentTeamsOf(ctx)
  const agents = agentsOf(ctx)
  if (!teams || !agents) return []
  try {
    const agent = agents.get(sessionId)
    if (!agent) return []
    const members = teams.listMembers(agent)
    if (!Array.isArray(members)) return []
    return members.map(rosterRow).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 把实时名册并入看板 team[]：
 *   - 新成员追加（status=active）；
 *   - 已存在的成员保留看板里的 role/duties（看板是权威，redefine 改过职不能被覆盖）；
 *   - 实时名册里没有的旧成员保留原样（不自动辞退）。
 */
function mergeTeamRows(existing, liveRows, now) {
  const rows = Array.isArray(existing) ? existing.map((row) => ({ ...row })) : []
  const byMember = new Map(rows.map((row) => [row.member, row]))
  const byKey = new Map()
  for (const row of rows) {
    const tail = row.member.split('·').pop().trim().toLowerCase()
    if (tail && !byKey.has(tail)) byKey.set(tail, row)
  }
  const result = []
  const used = new Set()
  for (const live of liveRows) {
    const matched = byMember.get(live.member) ?? (live.key ? byKey.get(live.key.toLowerCase()) : undefined)
    if (matched) {
      used.add(matched.member)
      result.push(matched)
      continue
    }
    result.push({
      role: live.role,
      member: live.member,
      duties: live.duties,
      status: 'active',
      since: now,
      updatedAt: now,
    })
  }
  for (const row of rows) {
    if (!used.has(row.member)) result.push(row)
  }
  return result
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                           */
/* ------------------------------------------------------------------ */

/**
 * @param {object} ctx Cordis Host 上下文
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const log = makeLogger(ctx)
  const store = createStore({ dir: boardsDir(ctx) })

  /** workingDirectory.defaultDirectory（可选服务，缺失回退进程 cwd）。 */
  const defaultDirectory = () => {
    try {
      const wd = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
      if (wd && typeof wd.defaultDirectory === 'string' && wd.defaultDirectory) return wd.defaultDirectory
    } catch {
      /* 忽略 */
    }
    return process.cwd()
  }

  /**
   * 解析调用会话：session 必须 live；工作区取 header.cwd（缺失用默认工作目录）。
   * @param {string} sessionId
   */
  const resolveSession = (sessionId) => {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : String(sessionId ?? '').trim()
    if (!sid) throw boardError('BOARD_SESSION_REQUIRED', 'sessionId 不能为空')
    let session
    try {
      session = ctx.sessions.get(sid)
    } catch {
      session = undefined
    }
    if (!session) throw boardError('BOARD_SESSION_NOT_LIVE', `会话 ${sid} 不在线（session-not-live）`)
    const header = session.header && typeof session.header === 'object' ? session.header : {}
    const cwd =
      typeof header.cwd === 'string' && header.cwd.trim() !== '' ? header.cwd : defaultDirectory()
    let preset = typeof header.agentPreset === 'string' && header.agentPreset !== '' ? header.agentPreset : null
    if (preset === null) {
      // 兜底：从 agent-presets 服务读该 Agent 绑定的 preset（header 没写时）。
      try {
        const agentPresets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
        const agent = agentsOf(ctx)?.get(sid)
        const composed = agentPresets?.composedPreset?.(agent?.ctx)
        if (typeof composed === 'string' && composed !== '') preset = composed
      } catch {
        preset = null
      }
    }
    return { sessionId: sid, cwd, preset, header }
  }

  /** 会话 → 看板 id。 */
  const boardIdOfSession = (sessionId) => boardIdFor(resolveSession(sessionId).cwd)

  /** 只读打开看板（不存在返回 null）。 */
  const loadBoard = (sessionId) => store.load(boardIdOfSession(sessionId))

  /** 读-改-写（不存在抛 BOARD_NOT_FOUND）。 */
  const mutateBoard = (sessionId, applyFn) => store.mutate(boardIdOfSession(sessionId), applyFn)

  /* ---------------- projectBoard 服务（board-tools.js 的唯一入口） ---------------- */
  const service = {
    /**
     * 打开/创建当前工作区看板，并同步团队名册 + 参考方案。
     * @returns {Promise<{ board: object, created: boolean }>}
     */
    async openBoard(input = {}) {
      const info = resolveSession(input.sessionId)
      const boardId = boardIdFor(info.cwd)
      const now = Date.now()
      const live = liveRoster(ctx, info.sessionId)
      const result = await store.open({
        boardId,
        workspacePath: info.cwd,
        projectName: typeof input.projectName === 'string' ? input.projectName : '',
        transform: (board) => {
          const next = board
          if (live.length > 0) next.team = mergeTeamRows(next.team, live, now)
          if (input.reference && typeof input.reference === 'object') {
            const applied = setReferenceOfBoard(next, input.reference, now)
            next.reference = applied.board.reference
            next.updatedAt = applied.board.updatedAt
          }
          return next
        },
      })
      return { board: result.board, created: result.created }
    },

    /**
     * 只读快照：`{ board|null, session: { id, preset, cwd } }`。
     * 会话不在线时抛 BOARD_SESSION_NOT_LIVE（路由转 400）。
     */
    async snapshot(input = {}) {
      const info = resolveSession(input.sessionId)
      const board = await store.load(boardIdFor(info.cwd))
      return {
        board,
        session: { id: info.sessionId, preset: info.preset, cwd: info.cwd },
      }
    },

    /** 新增修改点（或 mergeInto 记返工）。 */
    async addItem(input = {}) {
      const sessionId = input.sessionId
      const payload = { ...input }
      delete payload.sessionId
      const result = await mutateBoard(sessionId, (board, at) => {
        const next = addItemToBoard(board, payload, at)
        return { board: next.board, value: next.item }
      })
      return { item: result.value, board: result.board }
    },

    /** 推进状态 / 记录分派、执行、测试、验收、返工、改职。 */
    async updateItem(input = {}) {
      const sessionId = input.sessionId
      const payload = { ...input }
      delete payload.sessionId
      const result = await mutateBoard(sessionId, (board, at) => {
        const next = updateItemOfBoard(board, payload, at)
        return { board: next.board, value: { item: next.item ?? null, member: next.member ?? null } }
      })
      return { item: result.value.item, member: result.value.member, board: result.board }
    },

    /** 批量清理条目（update 工具的 prune action：按 ids / statuses / categories / 整板）。 */
    async pruneItems(input = {}) {
      const sessionId = input.sessionId
      const payload = { ...input }
      delete payload.sessionId
      const result = await mutateBoard(sessionId, (board, at) => {
        const next = pruneItemsOfBoard(board, payload, at)
        return {
          board: next.board,
          value: {
            mode: next.mode,
            scope: next.scope,
            dryRun: next.dryRun,
            matched: next.matched,
            matchedIds: next.matchedIds,
            changed: next.changed,
            changedIds: next.changedIds,
            removedIds: next.removedIds,
            skippedIds: next.skippedIds,
            notFoundIds: next.notFoundIds,
            stats: next.stats,
          },
        }
      })
      return { ...result.value, board: result.board }
    },

    /** 合并重复/关联条目。 */
    async mergeItems(input = {}) {
      const sessionId = input.sessionId
      const payload = { ...input }
      delete payload.sessionId
      const result = await mutateBoard(sessionId, (board, at) => {
        const next = mergeItemsOfBoard(board, payload, at)
        return { board: next.board, value: { targetId: next.target.id } }
      })
      return { board: result.board, targetId: result.value.targetId }
    },

    /** 设置/更新参考方案与对标差距表。 */
    async setReference(input = {}) {
      const sessionId = input.sessionId
      const payload = { ...input }
      delete payload.sessionId
      const result = await mutateBoard(sessionId, (board, at) => {
        const next = setReferenceOfBoard(board, payload, at)
        return { board: next.board, value: next.reference }
      })
      return { board: result.board, reference: result.value }
    },

    /** 精简列出条目（看板不存在时返回空列表，不抛错）。 */
    async listItems(input = {}) {
      const board = await loadBoard(input.sessionId)
      const filter = {
        status: input.status,
        category: input.category,
        query: input.query,
        limit: input.limit,
      }
      return listItemsOfBoard(board ?? { items: [] }, filter)
    },

    /** 完整性审计（看板不存在时返回空审计，不抛错）。 */
    async audit(input = {}) {
      const board = await loadBoard(input.sessionId)
      const result = auditBoard(board ?? { items: [] })
      return { audit: result.audit, stats: result.stats }
    },
  }

  // 注册 service（Cordis：ctx.provide + 依赖它的子插件/工具会自动就绪）。
  try {
    ctx.provide('projectBoard', service)
  } catch (error) {
    log(`注册 projectBoard 服务失败：${errorText(error)}`)
    return
  }

  /* ---------------- 只读快照路由 ---------------- */
  const handler = async (req, res) => {
    try {
      const rejection = admissionRejection(ctx, req)
      if (rejection !== null) {
        writeJson(res, rejection, {
          ok: false,
          error: rejection === 401 ? 'unauthorized' : 'forbidden',
        })
        return
      }
      const method = req && typeof req.method === 'string' ? req.method.toUpperCase() : ''
      const url = parseUrl(req)
      const pathname = url ? url.pathname : ''
      if (pathname !== SNAPSHOT_PATH) {
        writeJson(res, 404, { ok: false, error: `unknown ${method || 'request'} ${pathname || '/'}` })
        return
      }
      if (method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (!sessionId) {
        writeJson(res, 400, { ok: false, error: 'missing-session-id' })
        return
      }
      try {
        const snapshot = await service.snapshot({ sessionId })
        writeJson(res, 200, {
          ok: true,
          board: snapshot.board ?? null,
          session: snapshot.session ?? null,
          serverTime: Date.now(),
        })
      } catch (error) {
        const code = error && typeof error === 'object' ? error.code : undefined
        const notLive = code === 'BOARD_SESSION_NOT_LIVE' || code === 'BOARD_SESSION_REQUIRED'
        writeJson(res, notLive ? 400 : 500, {
          ok: false,
          error: notLive ? 'session-not-live' : errorText(error),
        })
      }
    } catch (error) {
      // 最后一道兜底：handler 永不 reject。
      try {
        writeJson(res, 500, { ok: false, error: errorText(error) })
      } catch {
        /* 连接已经没了 */
      }
    }
  }

  // 快照路由只在有浏览器面的部署里注册；headless/tui 无 webServer 时优雅跳过。
  // ⚠️ 用 ctx.inject 等待可选服务就绪：apply 执行时 webServer 可能尚未提供，
  //    直接 ctx.get('webServer') 会拿到 undefined 导致路由漏注册（2026-10-18 实机踩坑：
  //    重启后 client 轮询 /api/project-board/snapshot 全 404，看板不显示）。
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (webCtx) => {
        try {
          webCtx.effect(
            () =>
              webCtx.webServer.register({
                kind: 'prefix',
                path: ROUTE_PREFIX,
                handler,
              }),
            'dsh-project-dev: /api/project-board 路由',
          )
        } catch (error) {
          log(`注册快照路由失败：${errorText(error)}`)
        }
      })
    } else {
      // 兜底：老版本 Cordis 没有 inject 时退回即时读取（可能拿不到服务）。
      const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
      if (webServer && typeof webServer.register === 'function') {
        ctx.effect(
          () =>
            webServer.register({
              kind: 'prefix',
              path: ROUTE_PREFIX,
              handler,
            }),
          'dsh-project-dev: /api/project-board 路由',
        )
      } else {
        log('webServer 不可用：跳过快照路由（本部署无浏览器面）')
      }
    }
  } catch (error) {
    log(`注册快照路由失败：${errorText(error)}`)
  }

  // 供测试/诊断读取的只读统计（不挂工具面）。
  log(`ready；boards=${boardsDir(ctx)}；statsOf 可用=${typeof statsOf === 'function'}`)
}

export default { name, inject, apply }
