/**
 * test/guard.test.mjs — guard.js 静态自检（node --test 直接运行，不依赖 dsh 宿主）
 * ============================================================================
 * 覆盖：
 *   1. isAllowed()：16 个允许精确名 + project_board_ 前缀放行，其余（含空名/非字符串）拒绝。
 *   2. installForAgent()：project-dev Lead / teammate / 其他 preset 三种分流；
 *      restrict 只传「全局确实存在」的子智能体工具名；重复安装幂等；effect 抛错不崩。
 *   3. guard 回调：允许工具返回 undefined，非允许工具返回 DENY_REASON。
 *   4. presetOf()：composedPreset（第一轮前切 preset）优先，header 兜底。
 *   5. apply()：agent/created 安装、agent/disposed 清理后可重装、live Agent 补装、
 *      agent-preset/selected 补装。
 * 运行：cd work/plugin && node --test test/
 * ============================================================================
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  DENY_REASON,
  DELEGATION_DENY,
  installForAgent,
  isAllowed,
  LEAD_ALLOW,
  LEAD_ALLOW_PREFIXES,
  presetOf,
  PRESET_ID,
} from '../guard.js'

/** 静默日志。 */
const silentLog = { info() {}, warn() {}, error() {} }

/**
 * 构造假 profile ctx。
 * @param {object} [options]
 * @param {Map<string, object>} [options.sessions] sessionId → { header }
 * @param {Set<string>} [options.globalTools] 全局工具名（tools.get 能查到的）
 * @param {object} [options.agentPresets] { composedPreset(agentCtx) }
 * @param {object} [options.agents] { list(), get(id) }
 */
function makeCtx(options = {}) {
  const sessions = options.sessions ?? new Map()
  const globalTools = options.globalTools ?? new Set()
  const listeners = new Map()
  const state = { sessions, globalTools, listeners }
  state.ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'agents') return options.agents
      if (name === 'agentPresets') return options.agentPresets
      if (name === 'logger') return undefined
      return undefined
    },
    sessions: {
      get(id) {
        return sessions.get(String(id))
      },
    },
    tools: {
      get(name) {
        return globalTools.has(name) ? { name } : undefined
      },
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  return state
}

/** 构造假 Agent + 调用记录。 */
function makeAgent(id, preset, options = {}) {
  const calls = options.calls ?? { restricts: [], guards: [], effects: [] }
  const agent = {
    id,
    session: { header: { agentPreset: preset } },
    ctx: {
      effect(fn) {
        const dispose = fn()
        calls.effects.push(dispose)
        return dispose
      },
      tools: {
        restrict(filter) {
          calls.restricts.push({ id, filter })
          return () => {}
        },
        guard(fn) {
          calls.guards.push({ id, fn })
          return () => {}
        },
      },
    },
  }
  return { agent, calls }
}

/** 会话 header 构造。 */
function sessionOf(header) {
  return { header }
}

/* ------------------------------------------------------------------ */
/* 1. isAllowed：允许清单                                            */
/* ------------------------------------------------------------------ */
test('isAllowed：16 个允许精确名 + project_board_ 前缀放行', () => {
  assert.equal(LEAD_ALLOW.length, 16, 'PROTOCOL §4.5 允许清单是 16 个精确名')
  assert.ok(LEAD_ALLOW.includes('present'), 'present 允许 Lead 交付文件')
  assert.ok(LEAD_ALLOW.includes('spawn_teammate'))
  assert.ok(LEAD_ALLOW.includes('send_message'))
  assert.ok(LEAD_ALLOW.includes('list_agents'))
  assert.ok(LEAD_ALLOW.includes('wait_agent'))
  assert.ok(LEAD_ALLOW.includes('interrupt_agent'))
  assert.ok(LEAD_ALLOW.includes('team_task_create'))
  assert.ok(LEAD_ALLOW.includes('team_task_list'))
  assert.ok(LEAD_ALLOW.includes('team_task_get'))
  assert.ok(LEAD_ALLOW.includes('team_task_update'))
  assert.ok(LEAD_ALLOW.includes('ask_user_question'))
  assert.ok(LEAD_ALLOW.includes('todo_write'))
  assert.ok(LEAD_ALLOW.includes('create_goal'))
  assert.ok(LEAD_ALLOW.includes('get_goal'))
  assert.ok(LEAD_ALLOW.includes('update_goal'))
  assert.ok(LEAD_ALLOW.includes('exit_plan_mode'))
  assert.deepEqual(LEAD_ALLOW_PREFIXES, ['project_board_'])

  for (const name of LEAD_ALLOW) assert.equal(isAllowed(name), true, '应放行：' + name)
  for (const name of ['project_board_open', 'project_board_add', 'project_board_update', 'project_board_audit']) {
    assert.equal(isAllowed(name), true, 'project_board_ 前缀应放行：' + name)
  }
})

test('isAllowed：工作类/子智能体/MCP 工具与非法输入一律拒绝', () => {
  const denied = [
    'read', 'write', 'edit', 'glob', 'grep', 'read_image', 'pwsh', 'bash',
    'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
    'web_search', 'web_fetch', 'job_list', 'job_output', 'job_kill', 'skill', 'create_worktree',
    'load_workspace_dependencies', 'working_directory', 'mcp__kimi_cu__click',
    'subagent', 'subagent_fork', 'subagent_codex', 'workflow', 'ralph',
    'project_board', // 缺下划线，不是合法前缀
    '', null, undefined, 42, {}, [],
  ]
  for (const name of denied) assert.equal(isAllowed(name), false, '应拒绝：' + String(name))
})

/* ------------------------------------------------------------------ */
/* 2. installForAgent：三种分流 + guard/restrict 行为                 */
/* ------------------------------------------------------------------ */
function routingFixture() {
  const sessions = new Map([
    ['sess-lead', sessionOf({ cwd: 'F:\\kyclaw', agentPreset: 'project-dev' })],
    ['sess-mate', sessionOf({ cwd: 'F:\\kyclaw', agentPreset: 'project-dev', parentSession: 'sess-lead', delegationDepth: 1 })],
    ['sess-other', sessionOf({ cwd: 'F:\\kyclaw', agentPreset: 'standard' })],
  ])
  const globalTools = new Set(['subagent', 'subagent_codex', 'workflow', 'ralph'])
  const calls = { restricts: [], guards: [], effects: [] }
  const lead = makeAgent('sess-lead', 'project-dev', { calls })
  const mate = makeAgent('sess-mate', 'project-dev', { calls })
  const other = makeAgent('sess-other', 'standard', { calls })
  const state = makeCtx({ sessions, globalTools })
  const installed = new Map()
  return { state, sessions, globalTools, calls, lead, mate, other, installed }
}

test('installForAgent：project-dev Lead 同时安装 restrict 与 guard', () => {
  const f = routingFixture()
  const ok = installForAgent(f.state.ctx, f.lead.agent, f.installed, silentLog)
  assert.equal(ok, true)
  assert.equal(f.installed.has('sess-lead'), true)
  assert.equal(f.calls.restricts.length, 1, 'Lead 也要 restrict 子智能体工具')
  assert.deepEqual(
    f.calls.restricts[0].filter,
    { deny: ['subagent', 'subagent_codex', 'workflow', 'ralph'] },
    'deny 只含全局确实存在的名字（按 DELEGATION_DENY 顺序）',
  )
  assert.equal(f.calls.guards.length, 1, 'Lead 必须安装 guard')
  assert.equal(f.calls.guards[0].id, 'sess-lead')
})

test('installForAgent：teammate 只 restrict、不装 Lead guard', () => {
  const f = routingFixture()
  const ok = installForAgent(f.state.ctx, f.mate.agent, f.installed, silentLog)
  assert.equal(ok, true)
  assert.equal(f.calls.restricts.length, 1, 'teammate 也要 restrict 子智能体工具')
  assert.equal(f.calls.guards.length, 0, 'teammate 不得被 Lead guard 拦截（它要干活）')
})

test('installForAgent：其他 preset / 非法 Agent 不处理', () => {
  const f = routingFixture()
  const ok = installForAgent(f.state.ctx, f.other.agent, f.installed, silentLog)
  assert.equal(ok, false)
  assert.equal(f.calls.restricts.length, 0)
  assert.equal(f.calls.guards.length, 0)
  assert.equal(installForAgent(f.state.ctx, null, f.installed, silentLog), false)
  assert.equal(installForAgent(f.state.ctx, { id: '' }, f.installed, silentLog), false)
  assert.equal(installForAgent(f.state.ctx, { id: 'x', ctx: null }, f.installed, silentLog), false)
})

test('installForAgent：重复安装幂等（同一 Agent 只装一次）', () => {
  const f = routingFixture()
  assert.equal(installForAgent(f.state.ctx, f.lead.agent, f.installed, silentLog), true)
  assert.equal(installForAgent(f.state.ctx, f.lead.agent, f.installed, silentLog), false)
  assert.equal(f.calls.restricts.length, 1)
  assert.equal(f.calls.guards.length, 1)
})

test('installForAgent：没有全局子智能体工具时不调用 restrict', () => {
  const sessions = new Map([['sess-lead', sessionOf({ agentPreset: 'project-dev' })]])
  const calls = { restricts: [], guards: [], effects: [] }
  const { agent } = makeAgent('sess-lead', 'project-dev', { calls })
  const state = makeCtx({ sessions, globalTools: new Set() })
  assert.equal(installForAgent(state.ctx, agent, new Map(), silentLog), true)
  assert.equal(calls.restricts.length, 0, 'deny 为空时不注册 restrict（restrict 空 filter 会抛）')
  assert.equal(calls.guards.length, 1)
})

test('guard 回调：允许工具放行、非允许工具返回 DENY_REASON', () => {
  const f = routingFixture()
  installForAgent(f.state.ctx, f.lead.agent, f.installed, silentLog)
  const guard = f.calls.guards[0].fn
  for (const name of ['spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
    'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
    'ask_user_question', 'todo_write', 'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode', 'present',
    'project_board_open', 'project_board_add', 'project_board_update', 'project_board_merge',
    'project_board_reference', 'project_board_list', 'project_board_audit']) {
    assert.equal(guard({ name }), undefined, '允许工具应放行：' + name)
  }
  for (const name of ['read', 'write', 'pwsh', 'web_search', 'job_list', 'terminal_open', 'skill', 'read_image', 'mcp__kimi_cu__click']) {
    assert.equal(guard({ name }), DENY_REASON, '非允许工具必须返回 DENY_REASON：' + name)
  }
  assert.equal(guard({}), DENY_REASON, '缺 name 的调用按拒绝处理（fail-closed）')
  assert.equal(guard(null), DENY_REASON, '异常 execution 按拒绝处理（fail-closed）')
  assert.match(DENY_REASON, /Lead 不得动手/)
  assert.match(DENY_REASON, /派给同事/)
})

/* ------------------------------------------------------------------ */
/* 3. presetOf：composedPreset 优先、header 兜底                      */
/* ------------------------------------------------------------------ */
test('presetOf：composedPreset（第一轮前切 preset）优先于 header', () => {
  const sessions = new Map([['sess-switch', sessionOf({ agentPreset: 'standard' })]])
  const calls = { restricts: [], guards: [], effects: [] }
  const { agent } = makeAgent('sess-switch', 'standard', { calls })
  const agentPresets = { composedPreset: (agentCtx) => (agentCtx === agent.ctx ? 'project-dev' : undefined) }
  const state = makeCtx({ sessions, agentPresets })
  assert.equal(presetOf(state.ctx, agent), 'project-dev', '切换后的 preset 以 composedPreset 为准')
  // 虽然是「标准会话创建」，但当前生效 preset 是 project-dev → 必须安装 Lead 拦截。
  assert.equal(installForAgent(state.ctx, agent, new Map(), silentLog), true)
  assert.equal(calls.guards.length, 1)
})

test('presetOf：composedPreset 拿不到时退回 header；sessions.get 抛错时退 agent.session', () => {
  const sessions = new Map([['sess-a', sessionOf({ agentPreset: 'project-dev' })]])
  const calls = { restricts: [], guards: [], effects: [] }
  const { agent } = makeAgent('sess-a', 'project-dev', { calls })
  const state = makeCtx({ sessions })
  assert.equal(presetOf(state.ctx, agent), 'project-dev')

  const broken = {
    ...agent,
    ctx: agent.ctx,
    session: { header: { agentPreset: 'project-dev' } },
  }
  const brokenCtx = makeCtx({})
  brokenCtx.ctx.sessions = {
    get() {
      throw new Error('boom')
    },
  }
  assert.equal(presetOf(brokenCtx.ctx, broken), 'project-dev', 'sessions 抛错时用 agent.session.header 兜底')
})

test('presetOf：两个来源都没有时返回 undefined（不误判为 project-dev）', () => {
  const calls = { restricts: [], guards: [], effects: [] }
  const { agent } = makeAgent('sess-none', undefined, { calls })
  const state = makeCtx({})
  assert.equal(presetOf(state.ctx, agent), undefined)
  assert.equal(installForAgent(state.ctx, agent, new Map(), silentLog), false)
})

/* ------------------------------------------------------------------ */
/* 4. apply：事件接线、live 补装、dispose 后可重装                      */
/* ------------------------------------------------------------------ */
test('apply：注册 agent/created、agent/disposed、agent-preset/selected 监听并补装 live Agent', () => {
  const sessions = new Map([
    ['live-lead', sessionOf({ agentPreset: 'project-dev' })],
    ['live-mate', sessionOf({ agentPreset: 'project-dev', parentSession: 'live-lead', delegationDepth: 1 })],
  ])
  const calls = { restricts: [], guards: [], effects: [] }
  const liveLead = makeAgent('live-lead', 'project-dev', { calls })
  const liveMate = makeAgent('live-mate', 'project-dev', { calls })
  const byId = new Map([
    ['live-lead', liveLead.agent],
    ['live-mate', liveMate.agent],
  ])
  const agents = {
    list: () => [liveLead.agent, liveMate.agent],
    get: (id) => byId.get(String(id)),
  }
  const state = makeCtx({ sessions, agents, globalTools: new Set(['subagent_codex', 'ralph']) })
  apply(state.ctx)

  assert.ok((state.listeners.get('agent/created') ?? []).length >= 1, '应监听 agent/created')
  assert.ok((state.listeners.get('agent/disposed') ?? []).length >= 1, '应监听 agent/disposed')
  assert.ok((state.listeners.get('agent-preset/selected') ?? []).length >= 1, '应监听 agent-preset/selected')
  // live 补装：Lead 装 guard、teammate 只 restrict。
  assert.equal(calls.guards.length, 1)
  assert.equal(calls.restricts.length, 2)
})

test('apply：agent/created 安装；agent/disposed 清理后可重装', () => {
  const sessions = new Map([['sess-x', sessionOf({ agentPreset: 'project-dev' })]])
  const calls = { restricts: [], guards: [], effects: [] }
  const state = makeCtx({ sessions })
  apply(state.ctx)
  const onCreated = state.listeners.get('agent/created')[0]
  const onDisposed = state.listeners.get('agent/disposed')[0]

  const first = makeAgent('sess-x', 'project-dev', { calls })
  onCreated({ agent: first.agent })
  assert.equal(calls.guards.length, 1)
  assert.equal(calls.guards[0].id, 'sess-x')

  // 同一 id 再次 created：幂等，不重复装。
  onCreated({ agent: first.agent })
  assert.equal(calls.guards.length, 1)

  // disposed 清表后再 created 同 id → 重新安装。
  onDisposed({ agent: first.agent })
  const second = makeAgent('sess-x', 'project-dev', { calls })
  onCreated({ agent: second.agent })
  assert.equal(calls.guards.length, 2, 'agent 销毁后清理，重建同名 Agent 应重新安装 guard')
})

test('apply：agent-preset/selected 对 project-dev 补装、对其他 preset 不动', () => {
  const sessions = new Map([
    ['sess-new', sessionOf({ agentPreset: 'standard' })],
  ])
  const calls = { restricts: [], guards: [], effects: [] }
  const { agent } = makeAgent('sess-new', 'standard', { calls })
  const agentPresets = { composedPreset: (agentCtx) => (agentCtx === agent.ctx ? 'project-dev' : undefined) }
  const agents = { list: () => [], get: (id) => (String(id) === 'sess-new' ? agent : undefined) }
  const state = makeCtx({ sessions, agents, agentPresets })
  apply(state.ctx)
  const onSelected = state.listeners.get('agent-preset/selected')[0]

  onSelected('sess-new', 'standard')
  assert.equal(calls.guards.length, 0, '切到其他 preset 不安装')

  onSelected('sess-new', 'project-dev')
  assert.equal(calls.guards.length, 1, '第一轮前切到 project-dev 要补装 Lead guard')
  assert.equal(calls.guards[0].id, 'sess-new')
})

test('installForAgent：agent.ctx.effect 抛错时只记日志、返回 false，不崩溃', () => {
  const sessions = new Map([['sess-bad', sessionOf({ agentPreset: 'project-dev' })]])
  const warnings = []
  const log = { info() {}, warn(text) { warnings.push(text) }, error() {} }
  const agent = {
    id: 'sess-bad',
    session: { header: { agentPreset: 'project-dev' } },
    ctx: {
      effect() {
        throw new Error('effect boom')
      },
      tools: {},
    },
  }
  const state = makeCtx({ sessions })
  assert.equal(installForAgent(state.ctx, agent, new Map(), log), false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /安装 agent 策略失败/)
})

test('DELEGATION_DENY 覆盖 PROTOCOL 规定的五个子智能体/工作流工具名', () => {
  assert.deepEqual(DELEGATION_DENY, ['subagent', 'subagent_fork', 'subagent_codex', 'workflow', 'ralph'])
  assert.equal(PRESET_ID, 'project-dev')
  assert.notEqual(DENY_REASON, '')
})
