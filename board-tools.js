/**
 * board-tools.js — 7 个 `project_board_*` 工具（dsh-project-dev 的 preset 子插件）
 * ============================================================================
 * 契约（work/PROTOCOL.md §3）：
 *   - 统一 `ctx.tools.register({ name, description, parameters, output:{schema,render}, execute })`。
 *   - `parameters` / `output.schema` 都是裸 JSON Schema（object 根）。
 *   - `execute(args, exec)`：`sessionId = String(exec.agent.id)`，再调
 *     `ctx.projectBoard.<method>({ sessionId, ...args })`；错误直接抛出，由框架转 isError。
 *   - 返回紧凑 JSON（条目摘要 + 看板统计），避免大段回显。
 *
 * 这 7 个工具只挂在「项目开发模式」的 preset 里。teammate 会继承 Lead 的 preset，
 * 所以同事也能用 `project_board_list` / `project_board_audit` 只读自查；写类工具
 * 靠提示词纪律限制为 Lead 与工程进度对照员使用（Host 不硬校验身份）。
 * ============================================================================
 */
import {
  ACTIONS,
  CATEGORIES,
  PRIORITIES,
  STAGES,
  statsOf,
  summarizeBoard,
  summarizeItem,
} from './store.js'

/** Cordis 插件名。 */
export const name = 'project-dev-board-tools'

/**
 * 硬依赖只有工具注册表；`projectBoard` 服务用 `ctx.get` 惰性取：
 * 即使面板 Host 行被临时禁用，工具仍能注册（execute 时给出明确错误），
 * 不会让整个 preset 因缺服务而处于 pending / 不可用。
 */
export const inject = ['tools']

/** 统一输出声明（紧凑 JSON 文本）。 */
const textOutput = {
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    additionalProperties: true,
  },
  render: (_args, value) => [
    { type: 'text', text: JSON.stringify(value ?? null) },
  ],
}

/** 构造 object-root 参数 schema。 */
function obj(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

/** string 参数。 */
function str(description) {
  return { type: 'string', description }
}

/** 从 exec 里取调用者 sessionId（= Agent.id）。 */
function sessionIdOf(exec) {
  const id = exec?.agent?.id
  if (id === undefined || id === null || id === '') {
    throw new Error('project_board_* 工具需要调用者 Agent：exec.agent.id 缺失')
  }
  return String(id)
}

/** 把工具返回值里可能出现的 undefined 变成 null（宿主只吃无损 JSON）。 */
function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                           */
/* ------------------------------------------------------------------ */

/**
 * @param {object} ctx preset 作用域上下文
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  /** 惰性解析 Host 看板服务（缺失时给明确错误，工具层转 isError）。 */
  const boardService = () => {
    let service
    try {
      service = typeof ctx.get === 'function' ? ctx.get('projectBoard') : undefined
    } catch {
      service = undefined
    }
    if (!service) throw new Error('项目看板服务不可用：请确认 dsh-project-dev 面板行（project-board）已启用')
    return service
  }

  /** 注册一个工具；output 统一。 */
  const tool = (definition) => ctx.tools.register({ ...definition, output: textOutput })

  /** 把服务结果包成 { ok:true, ... } 并保证 JSON 安全。 */
  const ok = (payload) => jsonSafe({ ok: true, ...payload })

  /* ---------------- 1. project_board_open ---------------- */
  tool({
    name: 'project_board_open',
    description:
      '打开/创建当前工作区的开发进度看板，并自动从 agent-team 同步团队名册（Lead 与所有成员）。'
      + '\n何时用：每个项目开发会话开始先调用一次；团队编制变化（新招/改职）后再调用刷新名册。'
      + '看板按工作区持久化，同一工作区的新会话会读到同一张看板。',
    parameters: obj({
      projectName: str('项目名（可选；首次创建看板时使用，缺省取工作区目录名）'),
      reference: {
        type: 'object',
        description: '参考方案（可选）：名称 / 来源 / 固定版本',
        properties: {
          name: str('参考方案名称，如 dsh-claude-style'),
          source: str('来源：本地路径 / 仓库 URL / 截图或产品说明'),
          pinnedVersion: str('固定版本：版本号或 commit'),
        },
        additionalProperties: false,
      },
    }),
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const result = await boardService().openBoard({
        sessionId,
        projectName: args?.projectName,
        reference: args?.reference,
      })
      return ok({
        created: result.created === true,
        board: summarizeBoard(result.board),
      })
    },
  })

  /* ---------------- 2. project_board_add ---------------- */
  tool({
    name: 'project_board_add',
    description:
      '把用户提出的一个修改点写进看板（台账）。'
      + '\n⚠️ 必须逐字记录用户原话 userQuote，不能用自己的总结代替；一次只记一个修改点；不确定的标「待确认」。'
      + '\n何时用：用户每提出一个修改点/缺陷/优化/返工，在当轮就调用。'
      + '\n同一问题再次出现时传 mergeInto（原条目 id）：本次记录会作为该条目的新一轮返工（不新建条目）。',
    parameters: obj(
      {
        title: str('一句话说明这个修改点（中文）'),
        userQuote: str('用户原话，逐字记录，不要改写、不要总结'),
        detail: str('Lead 对需求的理解与验收标准'),
        category: { type: 'string', enum: CATEGORIES, description: '类别' },
        priority: { type: 'string', enum: PRIORITIES, description: '优先级' },
        mergeInto: str('可选：已有看板条目 id（如 PB-003）。给出时本次记录为该条目的新一轮返工，不新建条目'),
        member: str('返工时可选：被派去执行返工的成员，如「前端工程师 · Cyrus」'),
        symptom: str('返工时可选：返工现象/仍未修好的表现'),
        cause: str('返工时可选：根因'),
        evidence: str('返工时可选：证据（截图/复现步骤/命令输出）'),
      },
      ['title', 'userQuote'],
    ),
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const result = await boardService().addItem({
        sessionId,
        title: args?.title,
        userQuote: args?.userQuote,
        detail: args?.detail,
        category: args?.category,
        priority: args?.priority,
        mergeInto: args?.mergeInto,
        member: args?.member,
        symptom: args?.symptom,
        cause: args?.cause,
        evidence: args?.evidence,
      })
      return ok({
        item: summarizeItem(result.item),
        stats: statsOf(result.board),
      })
    },
  })

  /* ---------------- 3. project_board_update ---------------- */
  tool({
    name: 'project_board_update',
    description:
      '推进一个看板条目的状态并记录责任人与证据（action 驱动）。'
      + '\n何时用：'
      + 'dispatch=派活后记录环节与成员；start=成员开工；test=测试结果（passed/failed）；'
      + 'accept=验收通过；reject=验收拒绝；fail/attempt=记录返工（现象/根因/修改/证据）；'
      + 'block=阻塞；obsolete=作废；reopen=重新打开；redefine=修改成员定义（改职复用，不辞退）；'
      + 'unmerge=把被合并的条目恢复为独立条目。'
      + '\n同一问题的第 N 次返工用 fail/attempt 记进同一个条目，禁止新开条目掩盖。',
    parameters: obj(
      {
        itemId: str('看板条目 id（如 PB-007）；redefine 时可为任意条目或省略'),
        action: { type: 'string', enum: ACTIONS, description: '要执行的动作' },
        stage: { type: 'string', enum: STAGES, description: 'dispatch 必填：分派环节' },
        member: str('成员，如「前端工程师 · Cyrus」「调研员 · Ada」'),
        role: str('职位（可选；dispatch 缺省按环节推导，redefine 必填新职位）'),
        duties: str('redefine 可选：新的职责描述'),
        status: { type: 'string', enum: ['passed', 'failed'], description: 'test 动作：passed 或 failed（默认 passed）' },
        evidence: str('证据：命令输出 / 截图 / 复现步骤 / 核对结论'),
        note: str('备注（block 必填：卡在哪）'),
        symptom: str('fail / attempt 必填：现象或返工原因'),
        cause: str('根因（可选）'),
        fix: str('修改内容（可选）'),
        owner: str('start 可选：执行人（等同 member）'),
        outcome: { type: 'string', enum: ['fixed', 'unfixed', 'partial'], description: 'attempt 可选：本次返工结果' },
        attempt: {
          type: 'object',
          description: 'fail/attempt 可选：一次返工的完整记录（等价于 symptom/cause/fix/outcome/evidence 平铺字段）',
          properties: {
            symptom: str('现象/返工原因'),
            cause: str('根因'),
            fix: str('修改内容'),
            outcome: { type: 'string', enum: ['fixed', 'unfixed', 'partial'], description: '本次返工结果' },
            evidence: str('证据'),
          },
          additionalProperties: false,
        },
      },
      ['action'],
    ),
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      // DESIGN §3.3 把返工记录设计成 attempt 对象；PROTOCOL §2.2 用平铺字段。两种都接受。
      const attempt = args?.attempt && typeof args.attempt === 'object' ? args.attempt : {}
      const result = await boardService().updateItem({
        sessionId,
        itemId: args?.itemId,
        action: args?.action,
        stage: args?.stage,
        member: args?.member,
        role: args?.role,
        duties: args?.duties,
        status: args?.status,
        evidence: args?.evidence ?? attempt.evidence,
        note: args?.note,
        symptom: args?.symptom ?? attempt.symptom,
        cause: args?.cause ?? attempt.cause,
        fix: args?.fix ?? attempt.fix,
        owner: args?.owner,
        outcome: args?.outcome ?? attempt.outcome,
      })
      return ok({
        action: args?.action ?? null,
        item: result.item ? summarizeItem(result.item) : null,
        ...(result.member ? { member: result.member } : {}),
        stats: statsOf(result.board),
      })
    },
  })

  /* ---------------- 4. project_board_merge ---------------- */
  tool({
    name: 'project_board_merge',
    description:
      '把重复/关联的看板条目并入目标条目（来源保留 id 于 target.mergedFrom，来源状态置 obsolete，'
      + '来源的返工记录并入目标 attempts 并重新编号）。'
      + '\n何时用：发现同一问题的多个条目、或用户重复提了已记录的需求时。禁止链式合并（已合并的来源不能再合并）。',
    parameters: obj(
      {
        sourceIds: {
          type: 'array',
          items: { type: 'string' },
          description: '要并入的来源条目 id 列表，如 ["PB-003","PB-005"]',
        },
        targetId: str('并入的目标条目 id，如 PB-007'),
        note: str('可选：合并原因'),
      },
      ['sourceIds', 'targetId'],
    ),
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const result = await boardService().mergeItems({
        sessionId,
        sourceIds: args?.sourceIds,
        targetId: args?.targetId,
        note: args?.note,
      })
      return ok({
        targetId: result.targetId ?? args?.targetId ?? null,
        merged: Array.isArray(args?.sourceIds) ? args.sourceIds : [],
        stats: statsOf(result.board),
      })
    },
  })

  /* ---------------- 5. project_board_reference ---------------- */
  tool({
    name: 'project_board_reference',
    description:
      '设置/更新「参考方案」与对标差距表（持续对标机制）。'
      + '\n何时用：项目开始时固定参考方案（名称/来源/版本）；每次调研员出「对标差距表」后写回 comparison；'
      + '超过 14 天未对标 audit 会提醒。只允许照抄参考实现，不允许凭印象发明。',
    parameters: obj({
      name: str('参考方案名称，如 dsh-claude-style'),
      source: str('来源：本地路径 / 仓库 URL / 截图或产品说明'),
      pinnedVersion: str('固定版本：版本号或 commit'),
      comparison: {
        type: 'array',
        description: '对标差距表（按 dimension 合并：同维度覆盖，新维度追加）',
        items: {
          type: 'object',
          properties: {
            dimension: str('对标维度，如 字体 / 动效 / 配色'),
            reference: str('参考实现的做法'),
            ours: str('我们当前的做法'),
            gap: str('差距结论'),
            status: { type: 'string', enum: ['open', 'closed'], description: '差距状态' },
          },
          required: ['dimension'],
          additionalProperties: false,
        },
      },
      lastComparedAt: { type: 'number', description: '可选：对标时间戳（毫秒；缺省用当前时间）' },
    }),
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const result = await boardService().setReference({
        sessionId,
        name: args?.name,
        source: args?.source,
        pinnedVersion: args?.pinnedVersion,
        comparison: args?.comparison,
        lastComparedAt: args?.lastComparedAt,
      })
      return ok({
        reference: result.board?.reference ?? null,
        stats: statsOf(result.board),
      })
    },
  })

  /* ---------------- 6. project_board_list ---------------- */
  tool({
    name: 'project_board_list',
    description:
      '精简列出看板条目（支持状态/类别/关键词过滤），返回摘要 + 统计。'
      + '\n何时用：Lead 派活前查重、工程进度对照员核对遗漏、其他成员只读了解全局进度；'
      + '不要在需要逐条细节时反复调用（详情用 audit 或快照）。',
    parameters: obj({
      status: str('状态过滤，可逗号分隔：pending / dispatched / running / testing / tested / accepting / accepted / rejected / blocked / obsolete'),
      category: { type: 'string', enum: CATEGORIES, description: '类别过滤' },
      query: str('关键词（匹配编号/标题/用户原话/理解/备注）'),
      limit: { type: 'number', description: '最多返回几条（默认 200，上限 500）' },
    }),
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const result = await boardService().listItems({
        sessionId,
        status: args?.status,
        category: args?.category,
        query: args?.query,
        limit: args?.limit,
      })
      return ok({
        items: result.items,
        stats: result.stats,
      })
    },
  })

  /* ---------------- 7. project_board_audit ---------------- */
  tool({
    name: 'project_board_audit',
    description:
      '完整性审计：列出未派单 / 未测试 / 未验收 / 返工≥2 / 待确认 / 执行中过期 / 对标过期的条目与计数。'
      + '\n何时用：Lead 每次向用户汇报前必跑；工程进度对照员每轮核对遗漏；发现遗漏立刻补 add 或 update 推进。',
    parameters: obj({}),
    async execute(_args, exec) {
      const sessionId = sessionIdOf(exec)
      const result = await boardService().audit({ sessionId })
      return ok({
        audit: result.audit,
        stats: result.stats,
      })
    },
  })
}

export default { name, inject, apply }
