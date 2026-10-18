# 开发进度看板 · 协议契约 v1（前后端按此实现，禁止擅自改字段）

所有文件在 `work/plugin/`。Host 与 Client 可并行开发；本文件是唯一契约。

## 0. 常量

```
BUNDLE_NAME = "dsh-project-dev"
ROUTE_PREFIX = "/api/project-board"
SNAPSHOT_PATH = "/api/project-board/snapshot"
STORE_DIR_NAME = "project-dev"          // under $DSH_HOME
BOARD_FILE_VERSION = 1
TOOL_PREFIX = "project_board_"
```

## 1. Host 入口 index.js

```js
export const name = 'dsh-project-dev'
export const inject = ['tools', 'webServer', 'sessions', 'agentTeams', 'systemPrompt']  // 按需缩减/optional
export function apply(ctx, config) { ... }   // 注册 service（ctx.provide('projectBoard', service)）+ 快照路由
```

- 服务名 `projectBoard`，方法（board-tools.js 调用，Client 不直接调用）：
  - `async openBoard({ sessionId, projectName?, reference? })` → `{ board, created }`
  - `async snapshot({ sessionId })` → `{ board|null }`
  - `async addItem({ sessionId, title, userQuote, detail?, category?, priority?, mergeInto?, member?, symptom?, cause?, evidence? })` → `{ item, board }`
  - `async updateItem({ sessionId, itemId, action, ...payload })` → `{ item, board }`
  - `async mergeItems({ sessionId, sourceIds, targetId, note? })` → `{ board }`
  - `async setReference({ sessionId, name?, source?, pinnedVersion?, comparison?, lastComparedAt? })` → `{ board }`
  - `async listItems({ sessionId, status?, category?, query?, limit? })` → `{ items, stats }`
  - `async audit({ sessionId })` → `{ audit, stats }`
- 所有方法 sessionId = Lead 的 session id（= Agent.id）。session 必须 live，否则抛错（工具层转为 isError）。
- boardId = `"pb-" + sha1(workspacePath).slice(0,8)`；workspacePath 取 `ctx.sessions.get(sessionId).header.cwd`（缺失则用 `ctx.workingDirectory.defaultDirectory`）。
- 存储：`$DSH_HOME/project-dev/boards/<boardId>.json`；写入用「临时文件 + rename」原子替换；读缓存按 mtime 失效（简单实现：每次读文件，小文件可接受）。`index.json` 可省略（目录枚举即可）。
- 并发：同一进程内用 promise 队列串行化写操作（简单 mutex），避免工具并发写坏文件。

## 2. 存储纯模块 store.js（可 node --test）

`store.js` 不依赖 ctx/fs 具体实现以外的宿主包：导出纯函数 + `createStore({ dir })`。
建议导出：

```js
export const BOARD_VERSION = 1
export function emptyBoard({ projectName, workspacePath, boardId }) -> board
export function normalizeBoard(raw) -> board          // 兼容缺字段/旧版本
export function addItem(board, input) -> { board, item }
export function updateItem(board, input) -> { board, item }

export function mergeItems(board, { sourceIds, targetId, note }) -> { board }
export function setReference(board, patch) -> { board }
export function listItems(board, filter) -> { items, stats }
export function audit(board) -> { audit, stats }
export function statsOf(board) -> { total, byStatus, running, testing, accepting, undispatched, untested, unaccepted, rework, pendingConfirm }
export function boardIdFor(workspacePath) -> string
export function validateItemInput(input) -> { ok, error? }
```

### 2.1 item 结构（必须逐字段）

```ts
interface Board {
  version: 1
  boardId: string
  projectName: string
  workspacePath: string
  createdAt: number; updatedAt: number
  nextItemNumber: number
  reference: Reference | null
  team: TeamMember[]
  items: Item[]
}
interface TeamMember { role: string; member: string; duties: string; status: 'active'|'retired'; since: number; updatedAt: number }
interface Reference {
  name: string; source: string; pinnedVersion: string; lastComparedAt: number
  comparison: { dimension: string; reference: string; ours: string; gap: string; status: 'open'|'closed' }[]
}
interface Item {
  id: string                 // "PB-001"
  number: number
  title: string
  userQuote: string
  detail: string
  category: 'UI'|'功能'|'缺陷'|'性能'|'文案'|'架构'|'其他'
  priority: 'P0'|'P1'|'P2'
  status: ItemStatus
  createdAt: number; updatedAt: number
  dispatch: { done: boolean; at: number; stages: Stage[] }
  execution: { status: 'idle'|'running'|'done'; owner: string; startedAt: number; updatedAt: number }
  test: { status: 'pending'|'running'|'passed'|'failed'; member: string; evidence: string; at: number }
  acceptance: { status: 'pending'|'passed'|'rejected'; member: string; evidence: string; at: number }
  attempts: Attempt[]
  mergedFrom: string[]
  mergedInto: string | null
  tags: string[]
  note: string
}
type ItemStatus = 'pending'|'dispatched'|'running'|'testing'|'tested'|'accepting'|'accepted'|'rejected'|'blocked'|'obsolete'
interface Stage { stage: 'research'|'design'|'frontend'|'backend'|'test'|'acceptance'; role: string; member: string; status: 'dispatched'|'running'|'done'; at: number; note: string }
interface Attempt { round: number; member: string; role: string; symptom: string; cause: string; fix: string; outcome: 'fixed'|'unfixed'|'partial'; evidence: string; at: number }
```

### 2.2 action 语义（updateItem）

| action | 必填 | 行为 |
|---|---|---|
| `dispatch` | `stage`, `member`, `role?` | `dispatch.done=true`；追加/更新 stage；`dispatch.at=now`；status: pending→dispatched；同时把 `execution.status` 保持 idle |
| `start` | `member?`, `owner?` | execution.status=running, owner=member/owner, startedAt=now；status→running |
| `test` | `member`, `status?`='passed'\|'failed', `evidence?` | test 写入；passed→tested；failed→running 且自动追加 attempt(round=当前+1, outcome='unfixed', symptom=evidence) |
| `accept` | `member`, `evidence?` | acceptance.status=passed；status→accepted |
| `reject` | `member`, `evidence?` | acceptance.status=rejected；status→rejected；自动追加 attempt(unfixed) |
| `fail` | `member`, `symptom`, `cause?`, `fix?`, `evidence?` | 追加 Attempt(outcome='unfixed')；status→running；保留 attempts |
| `attempt` | `member`, `symptom`, `cause?`, `fix?`, `evidence?`, `outcome?` | 仅追加 Attempt（同一问题的第 N 次返工） |
| `block` | `note` | status→blocked |
| `obsolete` | `note?` | status→obsolete |
| `reopen` | `note?` | status→running（清空 test/acceptance 的 passed 状态） |
| `redefine` | `member`, `role`, `duties?`, `note?` | 修改成员定义：team[] 中对应成员更新 role/duties/updatedAt，status 保持 active（长期闲置改职复用，不辞退） |
| `unmerge` | `itemId` 指向 merged item | 恢复 merged item 为独立条目（mergedInto=null，从 target.mergedFrom 移除） |

非法转移抛 `{ code:'BOARD_INVALID_TRANSITION' }`；item 不存在抛 `{ code:'BOARD_ITEM_NOT_FOUND' }`。

### 2.3 mergeItems

- 目标与来源必须存在且都不是 obsolete；来源 item 的 `mergedInto=target.id`，`status='obsolete'` 保留在数组；target.mergedFrom += 来源 id；target.attempts 追加来源 attempts（重新编号 round）并在 note 记录。禁止链式合并（来源若已 mergedInto 抛错）。

### 2.4 audit 输出

```ts
{
  audit: {
    undispatched: string[]   // pending 且 dispatch.done=false
    untested: string[]       // status ∈ tested 之前且非 obsolete/blocked? 规则：已执行/已测试但无 passed test 的（dispatched/running/testing/rejected）
    unaccepted: string[]     // tested 后无 passed acceptance
    pendingConfirm: string[] // note 或 detail 含 "待确认" 或 status=pending 且 userQuote 为空
    rework: string[]         // attempts.filter(outcome!=='fixed').length >= 2
    staleRunning: string[]   // execution.running 且 updatedAt 早于 now-24h
    referenceStale: boolean  // reference 为 null 或 lastComparedAt 超过 14 天
    mergedCount: number
  },
  stats: { total, byStatus, running, testing, accepting, accepted, rework }
}
```

## 3. 工具（board-tools.js，preset 子插件）

统一使用 `ctx.tools.register({ name, description, parameters, output:{schema, render}, execute })`。
- `parameters`：JSON Schema object；`output.schema`：JSON Schema；`output.render(args, value)` 返回 `[{type:'text', text: JSON.stringify(...)}]`（紧凑 JSON）。
- `execute(args, exec)`：`exec.agent` 给出调用者，`sessionId = String(exec.agent.id)`；调用 `ctx.projectBoard.<method>({ sessionId, ...args })`；错误抛出由框架转为 isError。
- 工具名与参数见 DESIGN.md §3.3。工具返回结构：
  - add/update → `{ ok:true, item: <摘要>, stats }`；摘要含 id/title/status/dispatchDone/execution/test/acceptance/rework 次数。
  - list → `{ ok:true, items:[摘要], stats }`
  - audit → `{ ok:true, audit, stats }`
  - open → `{ ok:true, board:{ boardId, projectName, reference, team, stats, items:[摘要] } }`
- description 用中文；每个工具说明「何时用」；`project_board_add` 提醒必须逐字记录用户原话 userQuote、一次只记一个修改点。

## 4. 模式守则（mode-guard.js，preset 子插件）

### 4.1 提示词（三块文案逐字取 work/MODE-TEXT.md）

- `ctx.systemPrompt.section({ name:'project-dev:roles', order: 120, text: TEAMMATE_DUTIES })`（中文「团队职责」段）
- `ctx.systemPrompt.section({ name:'project-dev:board', order: 130, text: BOARD_GUIDE })`
- Lead 章程正文放进 preset 的 persona `prefix`（`PERSONA_PREFIX`，双角色分流版）。
- order 取不与宿主冲突的有限数值；若注册抛错导致插件不激活，改为只保留 persona prefix 并在其中并入上述两段（以能激活为准，注释说明降级）。

### 4.2 身份判定（agent/created 监听）

```js
ctx.on('agent/created', ({ agent }) => {
  const header = ctx.sessions.get(agent.id)?.header
  if (header?.agentPreset !== 'project-dev') return
  const isLead = !header.parentSession && (header.delegationDepth ?? 0) === 0
  // 1) 所有项目开发模式成员：屏蔽全局子智能体/工作流/Ralph 工具
  //    deny = ['subagent','subagent_fork','subagent_codex','workflow','ralph'] 中
  //    确实存在于全局工具面（ctx.tools.get(name) !== undefined）的名字
  //    agent.ctx.effect(() => agent.ctx.tools.restrict({ deny }))
  // 2) 仅 Lead：注册「禁止动手」遮蔽工具（见 4.3）
})
```

### 4.3 Lead 遮蔽工具（完全不动手，用户确认；调研结论：agent 作用域同名注册 = 遮蔽 preset/global，不报错）

因为 teammate 会继承 Lead 的 preset，工作类工具必须留在 preset 里给同事用；Lead 的限制用**agent 作用域动态遮蔽**实现：

1. 在 `agent/created` 里，仅对 `isLead && header.agentPreset === 'project-dev'` 的 Agent：
   - 先取该 Agent 可见工具面快照：**用 `agent.ctx.tools.schemas(agent)`**（省略 scope 只返回 global 层，拿不到 preset 层，必须显式传 agent；PTC 内部同款用法 `registry.schemas(exec.agent)`）。若失败再退 `scoped.tools.schemas()` 与 `ctx.tools.schemas()` 两级兜底。
   - 允许清单（不遮蔽）：
     - 精确名：`ask_user_question`, `todo_write`, `create_goal`, `get_goal`, `update_goal`, `exit_plan_mode`, `spawn_teammate`, `send_message`, `list_agents`, `wait_agent`, `interrupt_agent`, `team_task_create`, `team_task_list`, `team_task_get`, `team_task_update`
     - 前缀：`project_board_`
   - 其余全部注册同名占位 ToolDefinition（execute 直接 throw：`项目开发模式下 Lead 不得动手，请把这件事派发给同事`）。
   - description 统一写：`⛔ 本模式禁用：Lead 不得动手。请用 send_message/看板把这项工作派给同事。`
   - 保留名 `run_code` 与不存在的名字跳过；每个注册 try/catch，失败只记日志，绝不崩溃。
2. 所有项目开发模式成员（含 Lead）：对全局存在的 `subagent/subagent_fork/subagent_codex/workflow/ralph` 用 `agent.ctx.tools.restrict({ deny })` 直接隐藏（restrict 只对 global 工具生效，故先按 `ctx.tools.get(name)` 过滤存在的名字）。
3. 遮蔽是否成功的实测结论写进交付说明；若动态遮蔽整体失败（注册抛错），退化为提示词纪律并在日志中说明。

实现注意：注册占位工具后再次 `schemas()` 会包含它们；必须先快照再循环注册。`deferLoading` 不要设。

### 4.5 profile 级硬拦截 `guard.js`（与 mode-guard 分开的一行）

`cordis.patch.yml` 额外插入一行 `project-dev-guard`（name `dsh-project-dev/guard`）：
- `inject = ['tools','sessions']`；`apply(ctx)` 监听 `agent/created`，对 `ctx.sessions.get(agent.id)?.header.agentPreset === 'project-dev'` 的 Agent：
  1. 所有成员：`agent.ctx.effect(() => agent.ctx.tools.restrict({ deny }))`，deny 为全局确实存在的 `subagent/subagent_fork/subagent_codex/workflow/ralph`。
  2. 仅 Lead（`!header.parentSession && (header.delegationDepth ?? 0) === 0`）：`agent.ctx.tools.guard((exec) => isAllowed(exec.name) ? undefined : DENY_REASON)`，允许清单 = 16 个精确名 + `project_board_` 前缀（见 guard.js `LEAD_ALLOW`；含 `present`：允许 Lead 把同事做好的文件交付给用户）。
- 插件安装晚于 Agent 创建时，用 `ctx.get('agents').list()` 对 live Agent 补装。
- 该行是「Lead 完全不动手」的**强制点**；preset 内 mode-guard 的同名影子工具仅作 best-effort 呈现层遮挡，不作为依赖。

### 4.6 已知风险

- teammate 继承 Lead 的 preset（实测），因此 `read/write/...` 工具必须保留在 preset 里给同事用；Lead 的限制靠 4.3 的 agent 作用域遮蔽 + persona 纪律，**不能**靠删除 preset 工具实现。
- agent 作用域注册与 preset 作用域同名工具是否「遮蔽」需实测；若实测为报错或无效，则跳过遮蔽并在交付说明中注明「Lead 禁止动手为提示词约束」。

## 5. 路由（index.js）

`ctx.effect(() => ctx.webServer.register({ kind:'prefix', path: ROUTE_PREFIX, handler }), 'dsh-project-dev: /api/project-board 路由')`

```js
async function handler(req, res) {
  // 1) method GET; pathname 精确等于 /api/project-board/snapshot
  // 2) sessionId = new URL(req.url, 'http://127.0.0.1').searchParams.get('sessionId')
  // 3) board = await ctx.projectBoard.snapshot({ sessionId })
  // 4) 200 { ok:true, board, serverTime }  / 400 {ok:false,error} / 500 {ok:false,error}
  // headers: content-type application/json; charset=utf-8, cache-control no-store
}
```

- 路由 handler 永不 reject；未知路径 404 JSON。
- 不写任何文件、不修改看板。

## 6. Client 半端 client.js

- 形态：`window.__ModuleLoader__.load({ id:'dsh-project-dev', factory(require){ ... } })`；`require('react')`。
- `inject: ['slots','locale']`（locale 可选）。
- `ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name:'conversation.input.dock', id:'project-board', order: 30 }, ProjectBoardDock))`
- Props：`sessionId`（string）、`useSession`、`useSessions`、`session`（SessionSnapshot，若有 agentPreset 字段可用）。**不要**依赖宿主未声明的 props。
- 数据：挂载后立即 `fetch('/api/project-board/snapshot?sessionId=' + encodeURIComponent(sessionId), { credentials:'same-origin' })`，之后每 2000ms 轮询（组件卸载/页面隐藏时停止）；失败静默重试（指数退避到 10s）。
- board 为 null → 渲染 null（不占空间）。
- 收起态：胶囊条（高度 ~34px，圆角，主题 token 背景+边框，hover 提亮）。点击展开。
- 展开态：`position: fixed` 卡片，默认 `top: 88px; right: 20px; width: 420px; max-height: 72vh`；header 可拖拽（pointerdown/move/up，clamp 在视口内，位置存 localStorage `project-board.pos`）；内部滚动条目区；右上收起/关闭（关闭只收起为胶囊）。
- 交互：筛选 chips（全部/待派单/执行中/待测试/待验收/已验收/返工）；条目点击展开详情；再点收起。
- 样式：先 `<style>` 元素注入（带 `pb-` 前缀 class），全部颜色走 `var(--dsw-alias-*)`，强调色用 CSS 变量 `--pb-accent` 等；字体栈见 aesthetic-spec；`prefers-reduced-motion` 下关闭动效。
- 文案通过 locale 服务注册命名空间 `project-board`，zh/en 字典；若 locale 不可用，用中文内联兜底。

## 7. 可验证断言（测试/验收用）

1. `boardIdFor('F:\\kyclaw')` 稳定且 8 位。
2. add 3 条、dispatch 1 条后 `stats.dispatched=1`、`audit.undispatched` 含其余 2 条。
3. 同一 item `fail` 两次后 `audit.rework` 含该 id，attempts.length=2。
4. `mergeItems` 后来源 id 在 target.mergedFrom，目标 attempts 增加，来源 status=obsolete。
5. `updateItem('test', status:'failed')` → status='running' 且 attempts+1。
6. `updateItem('accept')` 后 status='accepted'、stats.accepted=1。
7. 路由对不存在 session 返回 400/`ok:false`，对正常 session 返回 200 且 board 字段齐全。
8. 安装后 preset 行 active；Client slot occupant 出现 id=project-board。
