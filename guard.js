/**
 * guard.js — 项目开发模式「Lead 完全不动手」的硬拦截（Host 半端，profile 级）
 * ============================================================================
 * 为什么单独一行（不在 preset 里）：
 *   preset 子插件注册的 agent 作用域影子工具在实测中没有遮住 preset 层的工作类工具
 *   （2026-10-18 真实会话：Lead 仍成功调用了 read）。Cordis 明确支持用
 *   `agent.ctx.tools.guard()` 注册「只作用于该 Agent」的同步拒绝 —— 这是有文档保证的
 *   强制点，因此把 enforcement 放到 profile 级 Host 插件里，按「当前 preset + 会话身份」
 *   识别「项目开发模式 Lead」，再挂 guard。
 *
 * 行为：
 *   - 所有 project-dev 成员：restrict 掉全局存在的 subagent/subagent_fork/subagent_codex/
 *     workflow/ralph（只用 agent-team，不与子智能体混用）。
 *   - 仅 Lead：guard 拦截一切不在允许清单内的工具调用，返回拒绝原因。
 *   - 其他 preset / teammate / 未知会话：不做任何限制。
 *
 * 语义依据（2026-10-18 review 结论，均已核对 dsh-tools 源码）：
 *   1) `tools.guard(fn)` 注册在调用 context 的 scope 层（`ToolLayer.guards`）；
 *      `guardReason(exec)` 先查 global 层、再沿 `exec.agent` 的 scope 链逐层查，
 *      所以挂在 `agent.ctx` 上的 guard 只对该 Agent 的调用生效，且是单调拒绝
 *      （后续 plugin 不能把它改回 allow）。guard 在 `tools/pre-execute` 之后、
 *      执行之前同步运行：返回字符串 = 拒绝，返回 undefined = 放行。
 *   2) `tools.restrict(filter)` 只对**继承的 global 工具**做 allow/deny 掩码；
 *      preset 作用域注册的工具仍然可见。因此 deny 名单必须先按
 *      `ctx.tools.get(name)`（全局视图）过滤；它只用于「隐藏全局子智能体工具」，
 *      对 preset 内工作类工具的拦截由 guard 负责。
 *   3) `agent/created` 是 serial 事件，在 Agent 发布（session enter/announce）之后、
 *      第一轮请求之前被 await；在这里同步注册 guard 不会漏掉第一轮。
 *      插件晚于 Agent 创建时，用 `ctx.get('agents').list()` 补装。
 *   4) `SessionHeader.agentPreset` 只记录**创建时**的 preset；会话在第一轮前可以切换
 *      preset（切换记在 session 事件 `agent-preset/selected` 里）。所以身份判定以
 *      `agentPresets.composedPreset(agent.ctx)` 为主、header 为兜底，并额外监听
 *      `agent-preset/selected` 补装，避免「先建标准会话、第一轮前切到 project-dev」
 *      绕过硬拦截。
 * ============================================================================
 */

/** Cordis 插件名（与行 id 一致即可）。 */
export const name = 'project-dev-guard'

/** 依赖：工具注册表 + 会话表。 */
export const inject = ['tools', 'sessions']

/** 模式 id（与 preset config.id 一致）。 */
export const PRESET_ID = 'project-dev'

/** 子智能体/工作流类工具名（存在才 restrict，未知名字会抛错）。 */
export const DELEGATION_DENY = ['subagent', 'subagent_fork', 'subagent_codex', 'workflow', 'ralph']

/**
 * Lead 允许保留的工具（精确名，16 个；PROTOCOL §4.5）。
 * agent-team 九件套 + 交互/目标/计划工具 + `present`（允许把同事做好的文件交付给用户）。
 * 其余一切工具（read、write、pwsh、web_search、web_fetch、job_* 开头、terminal_* 开头、mcp 工具等）
 * 都会被 guard 拒绝。
 */
export const LEAD_ALLOW = [
  'ask_user_question',
  'todo_write',
  'create_goal',
  'get_goal',
  'update_goal',
  'exit_plan_mode',
  'present',
  'spawn_teammate',
  'send_message',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
]

/** Lead 允许保留的工具前缀（看板读写）。 */
export const LEAD_ALLOW_PREFIXES = ['project_board_']

/** 拒绝原因（模型会原样看到，必须可行动）。 */
export const DENY_REASON =
  '项目开发模式下 Lead 不得动手：不读代码、不跑命令、不查网页、不写文件。'
  + '请用 send_message / 看板（project_board_*）把这项工作派给同事，或向用户确认需求。'

/** 日志（拿不到 logger 也不崩）。 */
function makeLog(ctx) {
  const logger = (() => {
    try {
      return ctx.logger ?? (typeof ctx.get === 'function' ? ctx.get('logger') : undefined)
    } catch {
      return undefined
    }
  })()
  const emit = (level, text) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](`[dsh-project-dev] ${text}`)
      else if (typeof console !== 'undefined' && console[level === 'error' ? 'error' : 'log']) {
        console[level === 'error' ? 'error' : 'log'](`[dsh-project-dev] ${text}`)
      }
    } catch {
      /* 日志失败不影响功能 */
    }
  }
  return { info: (t) => emit('info', t), warn: (t) => emit('warn', t), error: (t) => emit('error', t) }
}

/** 判断某个 Lead 工具调用是否放行（逐字对齐 PROTOCOL §4.5 的允许清单）。 */
export function isAllowed(name) {
  if (typeof name !== 'string' || name === '') return false
  if (LEAD_ALLOW.includes(name)) return true
  for (const prefix of LEAD_ALLOW_PREFIXES) if (name.startsWith(prefix)) return true
  return false
}

/** 读取某个 Agent 的 session header（优先 live session，其次 agent.session）。 */
function headerOf(ctx, agent) {
  try {
    const session = ctx.sessions.get(agent.id)
    if (session?.header) return session.header
  } catch {
    /* 忽略，退 agent.session */
  }
  return agent?.session?.header ?? null
}

/**
 * 读取一个 Agent 当前生效的 preset id。
 *
 * 主路径是 `agentPresets.composedPreset(agent.ctx)`（preset 注册表投影：session 在第一轮
 * 前可以切换 preset，此时 SessionHeader.agentPreset 只记录创建时的 preset，不反映切换）；
 * header 作为兜底。两者都拿不到返回 undefined。
 * @param {object} ctx profile 级上下文
 * @param {object} agent Agent
 * @returns {string|undefined}
 */
export function presetOf(ctx, agent) {
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
    if (registry && typeof registry.composedPreset === 'function') {
      const composed = registry.composedPreset(agent.ctx)
      if (typeof composed === 'string' && composed !== '') return composed
    }
  } catch {
    /* 拿不到就退 header */
  }
  const header = headerOf(ctx, agent)
  const fromHeader = header && typeof header.agentPreset === 'string' ? header.agentPreset : undefined
  return typeof fromHeader === 'string' && fromHeader !== '' ? fromHeader : undefined
}

/**
 * 为一个 Agent 安装守卫策略；注册挂在 agent.ctx 上（agent 销毁自动清理）。
 * @param {object} ctx profile 级 Cordis 上下文
 * @param {object} agent 新建 Agent
 * @param {Map<string, Function>} installed 已安装表（避免重复）
 * @param {{info:Function,warn:Function}} log
 * @returns {boolean} 是否新安装
 */
export function installForAgent(ctx, agent, installed, log) {
  if (!agent || typeof agent.id !== 'string' || agent.id === '') return false
  if (installed.has(agent.id)) return false
  if (presetOf(ctx, agent) !== PRESET_ID) return false
  const header = headerOf(ctx, agent)
  const isLead = !header?.parentSession && (header?.delegationDepth ?? 0) === 0
  if (!agent.ctx || typeof agent.ctx.effect !== 'function') return false

  let dispose
  try {
    dispose = agent.ctx.effect(() => {
      const disposers = []

      // 1) 所有项目开发模式成员：隐藏子智能体/工作流/Ralph（只用 agent-team）。
      try {
        const deny = DELEGATION_DENY.filter((n) => {
          try {
            return ctx.tools.get(n) !== undefined
          } catch {
            return false
          }
        })
        if (deny.length > 0) {
          disposers.push(agent.ctx.tools.restrict({ deny }))
          log.info(`restrict 子智能体类工具：${deny.join(', ')}（agent=${agent.id}）`)
        }
      } catch (error) {
        log.warn(`restrict 子智能体类工具失败（跳过）：${error?.message ?? error}`)
      }

      // 2) 仅 Lead：guard 拦截一切非允许工具（单调拒绝，是「完全不动手」的强制点）。
      if (isLead) {
        try {
          disposers.push(
            agent.ctx.tools.guard((execution) => {
              const toolName = execution && typeof execution.name === 'string' ? execution.name : ''
              if (isAllowed(toolName)) return undefined
              return DENY_REASON
            }),
          )
          log.info(`Lead 守护已安装：agent=${agent.id}（非允许工具一律拒绝）`)
        } catch (error) {
          log.warn(`安装 Lead guard 失败（退化为提示词纪律）：${error?.message ?? error}`)
        }
      }

      return () => {
        for (const disposeOne of disposers.reverse()) {
          try {
            if (typeof disposeOne === 'function') disposeOne()
          } catch {
            /* 清理失败无所谓 */
          }
        }
      }
    }, `project-dev-guard: policy for ${agent.id}`)
  } catch (error) {
    log.warn(`安装 agent 策略失败（跳过 ${agent.id}）：${error?.message ?? error}`)
    return false
  }
  installed.set(agent.id, dispose)
  log.info(`安装模式策略：agent=${agent.id}，isLead=${isLead}`)
  return true
}

/**
 * 供 `agent-preset/selected`（第一轮前切换 preset）与 live 补装复用：
 * 从 sessionId 找到 live Agent，再 installForAgent。
 */
function installBySessionId(ctx, sessionId, installed, log) {
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (!agents || typeof agents.get !== 'function') return
    const agent = agents.get(String(sessionId))
    if (agent) installForAgent(ctx, agent, installed, log)
  } catch (error) {
    log.warn(`按 session 补装策略失败（跳过）：${error?.message ?? error}`)
  }
}

/**
 * @param {object} ctx profile 级 Cordis 上下文
 */
export function apply(ctx) {
  const log = makeLog(ctx)
  /** @type {Map<string, Function>} agentId → 策略清理器 */
  const installed = new Map()

  // 双所有者：插件卸载时把仍挂在 agent.ctx 上的策略一起清掉（agent 销毁也会清）。
  try {
    ctx.effect(() => () => {
      for (const dispose of installed.values()) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          /* ignore */
        }
      }
      installed.clear()
    }, 'project-dev-guard: dispose all')
  } catch (error) {
    log.warn(`注册插件级清理器失败（可忽略）：${error?.message ?? error}`)
  }

  // agent/created 是 serial 事件：在第一轮请求之前被 await，guard 不会漏第一轮。
  try {
    ctx.on('agent/created', ({ agent }) => {
      try {
        installForAgent(ctx, agent, installed, log)
      } catch (error) {
        log.warn(`agent/created 处理失败（跳过）：${error?.message ?? error}`)
      }
    })
  } catch (error) {
    log.warn(`注册 agent/created 监听失败：${error?.message ?? error}`)
  }

  // Agent 销毁：清掉已安装表（agent.ctx 的 effect 会自动移除 restrict/guard 本身）。
  try {
    ctx.on('agent/disposed', ({ agent }) => {
      if (!agent || typeof agent.id !== 'string') return
      installed.delete(agent.id)
    })
  } catch (error) {
    log.warn(`注册 agent/disposed 监听失败（可忽略）：${error?.message ?? error}`)
  }

  // 兜底：会话在第一轮前切换 preset 时（header.agentPreset 仍是创建值），换绑后补装。
  // 事件由 agent-presets 注册表在根上发出；名字/语义变化也不影响 agent/created 主路径。
  try {
    ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
      if (agentPreset !== PRESET_ID) return
      installBySessionId(ctx, sessionId, installed, log)
    })
  } catch (error) {
    log.warn(`注册 agent-preset/selected 监听失败（可忽略）：${error?.message ?? error}`)
  }

  // 已经 live 的 Agent（插件 HMR 安装晚于 Agent 创建时）补装。
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    const list = agents && typeof agents.list === 'function' ? agents.list() : []
    for (const agent of Array.isArray(list) ? list : []) installForAgent(ctx, agent, installed, log)
  } catch (error) {
    log.warn(`补装 live Agent 策略失败（跳过）：${error?.message ?? error}`)
  }

  log.info('守卫插件已加载（project-dev Lead 硬拦截 + 子智能体工具 restrict）')
}

export default { name, inject, apply }
