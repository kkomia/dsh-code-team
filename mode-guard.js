/**
 * mode-guard.js — 「项目开发模式」守则子插件（dsh-project-dev 的 preset 子插件）
 * ============================================================================
 * 职责（逐条对齐 work/PROTOCOL.md §4）：
 *   1. 注册两段系统提示词（正文逐字取自 work/MODE-TEXT.md）：
 *        - project-dev:roles  order 120 → TEAMMATE_DUTIES（团队职责）
 *        - project-dev:board  order 130 → BOARD_GUIDE（看板工作指南）
 *      Lead 章程本体（PERSONA_PREFIX）在 cordis.patch.yml 的 persona.prefix 里。
 *   2. `agent/created` 监听（本插件挂在 preset 作用域，天然只收到本项目开发模式
 *      Agent 的事件）：
 *        a. 所有项目开发模式成员：用 `agent.ctx.tools.restrict({ deny })` 隐藏全局存在的
 *           subagent / subagent_fork / subagent_codex / workflow / ralph。
 *        b. 仅 Lead（无 parentSession 且 delegationDepth === 0）：把「工作类工具」在
 *           `agent.ctx` 上注册同名占位 ToolDefinition 遮蔽掉（动态允许清单，见 §4.3），
 *           execute 直接 throw —— 用户拍板：Lead 完全不动手，一切派给同事。
 *     遮蔽注册失败只记日志、绝不崩溃：persona 纪律兜底。
 *   3. agent 作用域注册 = 遮蔽 preset/global 层同名工具（调研已确认：最近 scope 胜、
 *      不报错）；本文件用「先快照 visible，再逐个注册」的顺序，避免自己遮蔽自己。
 * ============================================================================
 */

/** Cordis 插件名。 */
export const name = 'project-dev-mode-guard'

/** 依赖的 Host 服务：工具面、系统提示词、会话表。 */
export const inject = ['tools', 'systemPrompt', 'sessions']

/** 本模式对应的 preset id。 */
export const PRESET_ID = 'project-dev'

/** 所有成员都要隐藏的全局子智能体/工作流工具（PROTOCOL §4.2）。 */
export const DELEGATION_DENY = ['subagent', 'subagent_fork', 'subagent_codex', 'workflow', 'ralph']

/**
 * Lead 的「允许工具」精确名单（PROTOCOL §4.3）：
 * 只有这些 + 前缀 `project_board_` 的工具不会被遮蔽。agent-team 九件套是全局工具，
 * 若不在清单里会被自己遮掉，务必保留。
 */
export const LEAD_ALLOW = [
  'ask_user_question',
  'todo_write',
  'create_goal',
  'get_goal',
  'update_goal',
  'exit_plan_mode',
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

/** Lead 允许的工具名前缀（看板工具全放行）。 */
export const LEAD_ALLOW_PREFIXES = ['project_board_']

/** 占位工具被调用时的报错文案（PROTOCOL §4.3 逐字）。 */
export const PLACEHOLDER_ERROR = '项目开发模式下 Lead 不得动手，请把这件事派发给同事'

/** 占位工具对模型展示的 description（PROTOCOL §4.3 逐字）。 */
export const PLACEHOLDER_DESCRIPTION = '⛔ 本模式禁用：Lead 不得动手。请用 send_message/看板把这项工作派给同事。'

/** 保留名：PTC 传输工具不允许被注册/遮蔽。 */
const RESERVED_TOOL_NAMES = new Set(['run_code'])

/* ------------------------------------------------------------------ */
/* 提示词正文（逐字来自 work/MODE-TEXT.md，禁止改写）                    */
/* ------------------------------------------------------------------ */

/** TEAMMATE_DUTIES —— 逐字取自 work/MODE-TEXT.md「TEAMMATE_DUTIES」段。 */
export const TEAMMATE_DUTIES = [
  '团队编制（上限 8 人，一人最多两职；闲置即改职复用，不扩编）：',
  '',
  '- 调研员：读参考实现源码/设计文档/截图/竞品，输出「对标差距表」（维度/参考做法/我们的现状/差距/结论）；回答可行性问题。产出写进看板 reference 与汇报。',
  '- 规划员：把用户修改点拆成工作流与依赖，排批次与里程碑，维护总体进度大纲；不写代码。',
  '- 设计师：UI/UX/动效/文案方案；必须给出参考依据与落地数值（字体/颜色/间距/动效时长）；先方案后实施。',
  '- 工程进度对照员：**看板第二写手**。逐条核对用户消息与看板条目，抓遗漏与「口头提过但没入板」的修改点；推进每个条目的 dispatch/execution/test/acceptance 状态；定期用 `project_board_audit` 出完整性报告（未派单/未测试/未验收/返工≥2/对标过期）；只做核对与记录，不写代码。',
  '- 测试员：写/跑测试，给可复现证据（命令、输出、截图、步骤），失败要写清复现条件；测试通过才允许进入验收。',
  '- 验收员：逐条对照用户原话与验收标准，核对证据后给出通过/拒绝；拒绝要写清差距。兼审核职责。',
  '- 前端工程师：Client/前端实现与样式、动效、交互；按设计师方案与参考实现落地。',
  '- 后端工程师：Host/服务端/接口/数据实现；保证测试可跑、错误可诊断。',
  '- 探索员（可与调研员合并）：技术预研与方案对比，给结论与风险。',
  '- 审核员（可与验收员合并）：代码审查、设计一致性审查，专挑「写死/重复实现/风格不统一」。',
  '',
  '所有成员：产出必须带证据；发现新问题先报 Lead；不擅自扩大范围；不使用子智能体。',
].join('\n')

/** BOARD_GUIDE —— 逐字取自 work/MODE-TEXT.md「BOARD_GUIDE」段。 */
export const BOARD_GUIDE = [
  '「开发进度看板」是本项目的唯一修改点台账，按工作区持久化，聊天内悬浮卡同步展示。规则：',
  '',
  '1. **入板时机**：用户每提出一个修改点/缺陷/优化/返工，在当轮入板，一条一个修改点。`userQuote` 逐字抄用户原话；`detail` 写理解与验收标准；不确定的写「待确认」。',
  '2. **状态机**：pending（待确认/待派）→ dispatched（已派单）→ running（执行中）→ testing（测试中）→ tested（已测试）→ accepting（待验收）→ accepted（已验收）。失败回退：testing→running、accepting→rejected→running，并记录 attempts。blocked/obsolete 用于阻塞/作废。',
  '3. **分派记录**：`dispatch.stages[]` 记录每个环节（research/design/frontend/backend/test/acceptance）由哪个职位、哪个成员执行；`execution` 记录当前执行人与状态。',
  '4. **返工归并**：同一问题多次未修复，用 `mergeInto` / `fail` / `attempt` 把第 N 次尝试记进同一个条目（attempts: symptom 现象、cause 根因、fix 修改、outcome 结果、evidence 证据），禁止新开条目掩盖。重复/关联条目用 `project_board_merge` 并入目标条目。',
  '5. **对标**：reference 记录参考方案的名称/来源/固定版本/对标差距表；超过 14 天未对标的要在 audit 中提醒。',
  '6. **审计**：`project_board_audit` 会列出未派单、未测试、未验收、返工≥2、待确认、对标过期。Lead 每次向用户汇报前、进度对照员每轮都要看审计结果。',
  '7. **写权限**：Lead 与工程进度对照员负责写看板；其他成员只读（project_board_list / project_board_audit）+ 消息汇报。',
  '8. **工具速查**：open 建档；add 新增（或 mergeInto 记返工）；update 推进状态/记录分派与返工/改职；merge 合并重复；reference 维护对标；list 查询；audit 完整性审计。',
].join('\n')

/* ------------------------------------------------------------------ */
/* 工具                                                               */
/* ------------------------------------------------------------------ */

/** 安全读日志（没有 logger 也不崩）。 */
function logWarn(ctx, message) {
  try {
    ctx.logger?.warn?.(`[dsh-project-dev/mode-guard] ${message}`)
  } catch {
    /* 日志失败无所谓 */
  }
}

/** 读取某个 agent 的 session header（agent id === session id）。 */
function headerOf(ctx, agentId) {
  try {
    return ctx.sessions.get(String(agentId))?.header ?? null
  } catch {
    return null
  }
}

/** 构造一个「禁止动手」占位 ToolDefinition（带合法的 output.render）。 */
export function makePlaceholderTool(toolName) {
  return {
    name: toolName,
    description: PLACEHOLDER_DESCRIPTION,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? { ok: false }) },
      ],
    },
    async execute() {
      throw new Error(PLACEHOLDER_ERROR)
    },
  }
}

/** 过滤出「全局工具面上确实存在」的 deny 名单（restrict 对未知名字会抛错）。 */
export function delegationDenyOf(ctx) {
  const deny = []
  for (const toolName of DELEGATION_DENY) {
    try {
      if (ctx.tools.get(toolName) !== undefined) deny.push(toolName)
    } catch {
      /* 查询失败就当不存在 */
    }
  }
  return deny
}

/**
 * 读取一个 Agent 当前「可见」的工具名快照。
 *
 * ⚠️ 实现要点（与 api-cheatsheet §10.1 的示意代码有一处必要修正）：
 * `tools.schemas(scope)` 的 scope 是显式参数；**省略 scope = 全局视图**（只含 global 层工具），
 * 不会返回 preset 层注册的 read/write/pwsh 等工具。要拿到「该 Agent 实际可见的工具面」，
 * 必须把 Agent（它本身就是 dsh-scope 的 scope key）作为 scope 传进去 —— PTC 模式内部也是
 * `registry.schemas(exec.agent)` 这样用的。这里做三级兜底，任何一级失败都不影响插件激活。
 * @param {object} agent 目标 Agent
 * @returns {string[]} 可见工具名（可能为空）
 */
export function visibleToolNames(agent) {
  const scoped = agent?.ctx
  if (!scoped || !scoped.tools) return []
  const tryRead = (fn) => {
    try {
      const schemas = fn()
      if (!Array.isArray(schemas)) return null
      return schemas.map((schema) => (typeof schema?.name === 'string' ? schema.name : '')).filter(Boolean)
    } catch {
      return null
    }
  }
  const attempts = [
    () => scoped.tools.schemas(agent),
    () => scoped.tools.schemas(scoped),
    () => scoped.tools.schemas(),
  ]
  for (const attempt of attempts) {
    const names = tryRead(attempt)
    if (names !== null) return names
  }
  return []
}

/**
 * 在 Lead 的 agent 作用域上注册「禁止动手」遮蔽工具：
 * 先快照该 Agent 的可见工具面，再按动态允许清单把其余工具逐个注册同名占位工具。
 * 每个注册独立 try/catch：失败只记日志（如保留名/同名重复注册），绝不导致插件崩溃。
 * @param {object} ctx mode-guard 插件上下文
 * @param {object} agent 刚创建的 Lead Agent
 * @param {Array<Function>} disposers 收集注册出来的 disposer
 * @param {(message: string) => void} warn 日志函数
 * @returns {{ shadowed: string[], failed: string[], skipped: string[], visible: number }}
 */
export function shadowLeadTools(ctx, agent, disposers, warn) {
  const scoped = agent.ctx
  const result = { shadowed: [], failed: [], skipped: [], visible: 0 }
  // 必须先快照可见工具面，再循环注册（注册后 schemas() 会包含占位工具自身）。
  const visibleNames = visibleToolNames(agent)
  result.visible = visibleNames.length
  if (visibleNames.length === 0) {
    warn('读取 Lead 可见工具面为空，跳过遮蔽（靠 persona 纪律兜底）')
    return result
  }
  const allow = new Set(LEAD_ALLOW)
  for (const toolName of visibleNames) {
    if (RESERVED_TOOL_NAMES.has(toolName)) {
      result.skipped.push(toolName)
      continue
    }
    if (allow.has(toolName)) continue
    if (LEAD_ALLOW_PREFIXES.some((prefix) => toolName.startsWith(prefix))) continue
    try {
      disposers.push(scoped.tools.register(makePlaceholderTool(toolName)))
      result.shadowed.push(toolName)
    } catch (error) {
      result.failed.push(toolName)
      warn(`遮蔽工具「${toolName}」失败（跳过，靠 persona 纪律兜底）：${error?.message ?? error}`)
    }
  }
  warn(
    `Lead 工具遮蔽完成：visible=${result.visible}，shadowed=${result.shadowed.length} 个 [${result.shadowed.join(', ')}]`
    + (result.failed.length > 0 ? `，failed=${result.failed.length} 个 [${result.failed.join(', ')}]` : ''),
  )
  return result
}

/**
 * 为一个 Agent 安装模式策略：
 *   1) 所有成员：restrict 掉全局存在的子智能体/工作流工具；
 *   2) 仅 Lead：动态遮蔽所有非允许工具（完全不动手）。
 * 注册挂在 `agent.ctx` 上（agent 销毁自动清理），同时把 disposer 登记到插件自身，
 * 插件卸载时也能清干净（practices.md 的双所有者要求）。
 * @param {object} ctx mode-guard 插件上下文
 * @param {object} agent 新建 Agent
 * @param {Map<string, Function>} installed agentId → 插件持有的清理器
 */
function installForAgent(ctx, agent, installed) {
  if (!agent || typeof agent.id !== 'string' || agent.id === '') return
  if (installed.has(agent.id)) return
  const header = headerOf(ctx, agent.id)
  // 本监听器注册在 preset 作用域：按 scope 链分发，只有本项目开发模式 revision 下的
  // Agent 会进来；header.agentPreset 是权威标记，缺失时（极老的子会话）仍按 scope 视为本模式。
  const preset = header && typeof header.agentPreset === 'string' ? header.agentPreset : undefined
  if (preset !== undefined && preset !== PRESET_ID) return
  const isLead = !header?.parentSession && (header?.delegationDepth ?? 0) === 0
  const warn = (message) => logWarn(ctx, message)
  warn(`安装模式策略：agent=${agent.id}，isLead=${isLead}，header.agentPreset=${preset ?? '(缺失)'}`)
  let dispose
  try {
    dispose = agent.ctx.effect(() => {
      const disposers = []
      // 1) 所有项目开发模式成员：隐藏全局子智能体/工作流工具。
      try {
        const deny = delegationDenyOf(ctx)
        if (deny.length > 0) disposers.push(agent.ctx.tools.restrict({ deny }))
      } catch (error) {
        warn(`restrict 子智能体工具失败（跳过）：${error?.message ?? error}`)
      }
      // 2) 仅 Lead：注册「禁止动手」遮蔽工具。
      if (isLead) {
        try {
          shadowLeadTools(ctx, agent, disposers, warn)
        } catch (error) {
          warn(`Lead 工具遮蔽整体失败（退化为 persona 纪律）：${error?.message ?? error}`)
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
    }, `project-dev: policy for ${agent.id}`)
  } catch (error) {
    warn(`安装 agent 策略失败（跳过 ${agent.id}）：${error?.message ?? error}`)
    return
  }
  installed.set(agent.id, dispose)
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                           */
/* ------------------------------------------------------------------ */

/**
 * @param {object} ctx preset 作用域上下文
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const warn = (message) => logWarn(ctx, message)

  // ── 1. 两段系统提示词（注册失败不拦插件激活，persona 里也有一份纪律兜底）──
  const sections = [
    { name: 'project-dev:roles', order: 120, text: TEAMMATE_DUTIES },
    { name: 'project-dev:board', order: 130, text: BOARD_GUIDE },
  ]
  for (const section of sections) {
    try {
      if (typeof ctx.systemPrompt?.section !== 'function') throw new Error('systemPrompt.section 不可用')
      ctx.systemPrompt.section(section)
    } catch (error) {
      warn(`注册提示词 section「${section.name}」失败（降级为 persona 纪律）：${error?.message ?? error}`)
    }
  }

  // ── 2. 每个项目开发模式 Agent 的 enforce 策略 ──
  /** @type {Map<string, Function>} agentId → 策略清理器 */
  const installed = new Map()

  // 本插件挂在 preset 作用域：事件按 scope 链分发，天然只覆盖本项目开发模式的 Agent。
  try {
    ctx.on('agent/created', ({ agent }) => {
      try {
        installForAgent(ctx, agent, installed)
      } catch (error) {
        warn(`agent/created 处理失败（跳过）：${error?.message ?? error}`)
      }
    })
  } catch (error) {
    warn(`注册 agent/created 监听失败：${error?.message ?? error}`)
  }

  try {
    ctx.on('agent/disposed', ({ agent }) => {
      const dispose = installed.get(agent?.id)
      if (!dispose) return
      installed.delete(agent.id)
      try {
        dispose()
      } catch (error) {
        warn(`清理 Agent 策略失败（跳过）：${error?.message ?? error}`)
      }
    })
  } catch (error) {
    warn(`注册 agent/disposed 监听失败：${error?.message ?? error}`)
  }

  // 双所有者：preset revision 卸载时，把仍挂在 agent.ctx 上的策略一起清掉。
  try {
    ctx.effect(() => () => {
      for (const dispose of installed.values()) {
        try {
          dispose()
        } catch {
          /* 清理失败无所谓 */
        }
      }
      installed.clear()
    }, 'project-dev: per-agent policies')
  } catch (error) {
    warn(`注册策略清理器失败：${error?.message ?? error}`)
  }

  // 插件热挂载（bundle 后安装）时，补齐已经存活的 Agent（防御；正常启动时没有）。
  try {
    const agents = ctx.get('agents')
    const list = typeof agents?.list === 'function' ? agents.list() : []
    for (const agent of Array.isArray(list) ? list : []) installForAgent(ctx, agent, installed)
  } catch (error) {
    warn(`扫描已存活 Agent 失败（可忽略）：${error?.message ?? error}`)
  }
}

export default { name, inject, apply, TEAMMATE_DUTIES, BOARD_GUIDE }
