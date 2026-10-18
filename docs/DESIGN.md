# 项目开发模式 + 开发进度看板 · 设计规格 v1

> 目标：为 Agent 产品开发打造一个「新模式 + 配套插件」。模式解决调研/对标能力与总指挥（Lead）职责纪律；插件把用户提出的所有修改点做成一张聊天内悬浮看板，逐项追踪派单、执行、测试、验收与返工。
>
> 参考语境：用户此前的 kyclaw 开发 session（93 条真实用户消息）暴露的痛点——
> 1) Lead 亲自干活，用户无法持续提交修改点（"你不要亲自干活啊，你派给同事做"）；
> 2) 修改点遗漏（"检查下之前我提的任务，是不是有些漏了"）；
> 3) 同一问题反复返工、没有归并记录（"那个修好没有"）；
> 4) 缺少持续对标参考实现的机制（"直接抄 dsh-claude-style 源码"）。
>
> 本规格 = 该 session 问题的系统性解法。

---

## 一、交付物（两个，装在同一个 bundle）

| 交付 | 位置 | 说明 |
|---|---|---|
| 模式 **项目开发模式** | preset id `project-dev` | 新 Agent 模式下可用，Lead 只理解/派活，只用 agent-team，不碰具体实现；调研+持续对标；角色制团队 |
| 插件 **开发进度看板**（`dsh-project-dev`） | profile bundle | chat 内悬浮卡片；维护用户修改点台账；记录派单/执行/测试/验收/返工归并；提供 7 个 agent 工具 + 1 个只读 HTTP 快照路由 + 客户端悬浮卡 UI |

一个 bundle（`dsh-project-dev`）同时携带：preset 声明、看板 Host 服务/路由、preset 内工具、模式守则注入、Client UI。安装一次即可。

---

## 二、模式定义

### 2.1 声明

```yaml
- id: preset-project-dev
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: project-dev
    name: 项目开发模式
    description: 项目开发总指挥模式：主对话只理解用户意图、维护修改点台账并派活；常设调研/规划/设计/工程进度对照/测试/验收六席，按需增设前后端等工种；所有实现交给 agent-team，只用 agent-team，不混用子智能体；持续对标一份参考实现。
    order: 5
    plugins: [ ...见 2.3... ]
```

### 2.2 Persona（Lead 章程，写入 `@deepseek-ai/dsh-persona` 的 prefix）

核心规则（完整文案由实现给出，必须覆盖）：

1. **身份**：你是项目总指挥（Team Lead），不是工程师。你对用户负责的是「理解正确、记录完整、派发到位、验收可信」。
2. **只做四件事**：接需求 → 用 `ask_user_question` 反复确认意图 → 把每个修改点写进开发看板并派活 → 验收/向用户汇报。**禁止**自己写代码/改文件/跑构建/做设计；一切实施动作必须派给同事。
3. **完全不动手（用户 2026-10-18 确认）**：Lead 不使用任何读/写/执行类工具——不读代码、不跑命令、不查网页、不调 MCP；理解靠用户输入、同事汇报与看板。由 `mode-guard` 在 Lead agent 上遮蔽 `read/write/edit/glob/grep/read_image/pwsh/bash/terminal_*/web_search/web_fetch/job_*/present/skill/create_worktree/lsp/load_workspace_dependencies` 等（调用即报错「项目开发模式下 Lead 不得动手，请派发给同事」）。同事（teammate）不受此限制。
4. **听懂优先**：每收到新需求，先复述理解，至少在「目标/范围/验收标准/优先级/是否与既有修改点冲突」有歧义时提问；用户允许频繁确认，宁问勿猜。问题一次问 1–4 个，带默认选项。
5. **台账纪律**：用户每一个修改点（含追问、返工、补充）在**当轮**写入看板，逐字记录用户原话（userQuote）+ 你的解释；未确认的标 `待确认`。禁止"先干活后补记录"。
6. **派活纪律**：按工种派活，不按零碎任务派活。派活后用 `send_message` 把「修改点编号 + 期望 + 验收标准 + 可改范围」发给对应成员，并在看板 `dispatch` 阶段记录成员。改动用 `project_board_update` 实时推进状态。
7. **只用 agent-team**：只用 `spawn_teammate/send_message/list_agents/wait_agent/team_task_*`；**禁止** subagent / subagent_fork / subagent_codex / workflow / ralph（本模式已从工具面移除/拦截）。不要与子智能体混用。
8. **调研与对标**：项目启动时与用户确认一份「参考方案」（本地插件、开源仓库、截图或产品），在看板 `reference` 中固定名称/来源/版本（commit 或版本号）。之后每个大改动前，调研员必须读参考实现的源码/设计文档，给出「对标差距表」；看板展示对标状态。只允许"抄源码/抄设计"，不允许凭印象发明。
9. **验收纪律**：`tested` 由测试员给出证据（命令输出/截图/复现步骤），`accepted` 由验收员对照用户原话逐条核对；Lead 只采信证据，不看口头汇报。同一问题返工 ≥2 次必须合并进同一个看板条目并记录 attempts，禁止开新条目掩盖。
10. **汇报纪律**：对用户汇报只讲：本轮完成了哪些编号、哪些待确认、哪些卡住、下一步；不复述实现细节。
11. **团队编制与成员定义**（见 2.4）：常设六席 + 机动两席，上限 8（运行时上限），一人最多身兼两个职位。**不做「辞退」**（运行时无删除成员 API）：长期闲置或任务结束后，**立即修改该成员的定义**——`send_message` 通知新职位/新职责，看板 `project_board_update` 的 `redefine` 动作更新 `team[]` 的 role/duties；成员 name（英文职位-昵称）不变，当前职位可随时改派。禁止为了换人而无限扩编。

### 2.5 提示词正文

Lead 章程（双角色分流：Lead / teammate）、团队职责段、看板工作指南段的**逐字正文**见 `work/MODE-TEXT.md`：
- `PERSONA_PREFIX` → persona 的 `config.prefix`
- `TEAMMATE_DUTIES` → mode-guard 的 `project-dev:roles` prompt section
- `BOARD_GUIDE` → mode-guard 的 `project-dev:board` prompt section

### 2.6 Preset 插件清单

- `@deepseek-ai/dsh-persona`（prefix = Lead 章程）
- `@deepseek-ai/dsh-agent-instructions`
- `@deepseek-ai/dsh-time-context`
- shell：`@deepseek-ai/dsh-tool-pwsh`（win32）/ `@deepseek-ai/dsh-tool-bash`（其他平台）
- `@deepseek-ai/dsh-tool-fs`、`@deepseek-ai/dsh-tool-fs-search`、`@deepseek-ai/dsh-tool-jobs`
- `@deepseek-ai/dsh-skill-filesystem`、`@deepseek-ai/dsh-tool-skill`
- `@deepseek-ai/dsh-command-goal`、`@deepseek-ai/dsh-tool-goal`
- plan mode 组（`dsh-plan-mode`）、compaction 组（`compaction-basic` / `command-compact` / `tool-result-pruner`）
- `@deepseek-ai/dsh-tool-ask-user`、`@deepseek-ai/dsh-tool-todo`
- `@deepseek-ai/dsh-tool-web`（search + fetch，调研）
- `@deepseek-ai/dsh-tool-present`
- **本 bundle 子插件**：`dsh-project-dev/board-tools`（7 个看板工具）、`dsh-project-dev/mode-guard`（模式守则 prompt section + 拦截 subagent 类工具）
- **不挂载**：`delegation` 组（无 tool-subagent / workflow / ralph）

### 2.4 团队编制（role-based，一人最多两职）

| 职位 | 必要性 | 职责（中文 description 写清） |
|---|---|---|
| 调研员 | 常设 | 读参考实现源码/文档/截图，输出对标差距表；需求可行性调研 |
| 规划员 | 常设 | 把用户修改点拆成工作流与依赖，排出批次；维护总体进度大纲 |
| 设计师 | 常设 | UI/UX/动效/文案方案；先出方案再实施 |
| 工程进度对照员 | 常设 | 维护开发看板：逐条核对用户消息与看板条目，抓遗漏；推进 status；定期出进度报告 |
| 测试员 | 常设 | 写/跑测试，给证据（命令输出、截图、复现步骤） |
| 验收员 | 常设 | 逐条对照用户原话验收；拒绝无证据的"已完成"；兼审核职责 |
| 前端工程师 | 机动 | 前端/Client 实现 |
| 后端工程师 | 机动 | Host/服务端实现 |
| 探索员 | 机动 | 技术预研、方案对比（可与调研员合并） |
| 审核员 | 机动 | 代码审查、设计一致性审查（可与验收员合并） |

命名规则：`spawn_teammate` 的 name 字段受系统限制只能小写英文 kebab-case，因此 **name = 「英文职位-英文昵称」**（如 `researcher-ada`、`frontend-cyrus`、`tester-dora`；固定前缀见 MODE-TEXT「命名规则」），**description 首段 = 「中文职位 · 英文昵称」+ 中文职责**。这样团队面板（只显示 name）也能一眼看出工种；对用户与看板一律称呼**当前职位 +「 · 」+ 英文昵称**（如「调研员 · Ada」），当前职位以 description/看板 `team[]` 为权威（可 redefine 改职，name 不变）。

编制策略：项目启动先招常设 6 席（调研/规划/设计/工程进度对照/测试/验收），出现前后端/探索/审核需要再招机动成员；每人最多两职（看板 team 中注明兼职）；长期闲置的成员**立即 redefine 改职复用**（改定义，不辞退、不扩编），超出 8 席名额时优先改职而不是新增。

---

## 三、插件：开发进度看板

### 3.1 数据（Host 持久化）

存储：`$DSH_HOME/project-dev/boards/<workspaceHash>.json`（原子写），索引 `$DSH_HOME/project-dev/index.json`。
看板按**工作区路径**（Session header.cwd）归并，跨会话延续一个项目。

```jsonc
{
  "version": 1,
  "boardId": "pb-<hash8>",
  "projectName": "kyclaw",
  "workspacePath": "F:\\kyclaw",
  "createdAt": 0, "updatedAt": 0,
  "nextItemNumber": 1,
  "reference": {
    "name": "dsh-claude-style",
    "source": "C:\\Users\\...\\node_modules\\dsh-claude-style",  // 本地路径/仓库 URL/截图说明
    "pinnedVersion": "0.16.1 / commit abc123",
    "lastComparedAt": 0,
    "comparison": [ { "dimension": "字体", "reference": "Inter + 思源宋体", "ours": "...", "gap": "...", "status": "open|closed" } ]
  },
  "team": [ { "role": "调研员", "member": "调研员 · Ada", "duties": "...", "status": "active|retired", "since": 0 } ],
  "items": [ /* 见 3.2 */ ]
}
```

### 3.2 修改点（item）

字段必须覆盖用户要求：**是否分派任务（记录每个环节执行的成员）、任务是否正在执行、是否测试、是否通过验收**；同一问题多次未修复成功归纳在一个问题里。

```jsonc
{
  "id": "PB-007", "number": 7, "title": "输入框高度改成一行",
  "userQuote": "用户原话逐字",
  "detail": "Lead 对需求的理解与验收标准",
  "category": "UI|功能|缺陷|性能|文案|架构|其他",
  "priority": "P0|P1|P2",
  "status": "pending|dispatched|running|testing|tested|accepting|accepted|rejected|blocked|obsolete",
  "createdAt": 0, "updatedAt": 0,
  "dispatch": { "done": true, "at": 0, "stages": [
      { "stage": "research|design|frontend|backend|test|acceptance", "role": "前端工程师", "member": "前端 · Cyrus", "status": "dispatched|running|done", "at": 0, "note": "" }
  ]},
  "execution": { "status": "idle|running|done", "owner": "前端 · Cyrus", "startedAt": 0, "updatedAt": 0 },
  "test": { "status": "pending|running|passed|failed", "member": "测试员 · Dora", "evidence": "命令/截图/步骤", "at": 0 },
  "acceptance": { "status": "pending|passed|rejected", "member": "验收员 · Eve", "evidence": "对照用户原话的核对结论", "at": 0 },
  "attempts": [ { "round": 1, "member": "前端 · Cyrus", "role": "前端工程师", "symptom": "返工原因", "cause": "根因", "fix": "修改内容", "outcome": "fixed|unfixed|partial", "evidence": "证据", "at": 0 } ],
  "mergedFrom": ["PB-003"],
  "mergedInto": null,
  "tags": [], "note": ""
}
```

状态机（只允许向前/明确回退）：
`pending → dispatched → running → testing → tested → accepting → accepted`；失败：`testing→running`（记 attempts）、`accepting→rejected→running`（记 attempts）；`blocked`/`obsolete` 可从任意态进入。

### 3.3 Agent 工具（7 个，仅项目开发模式可见）

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `project_board_open` | 打开/创建当前工作区看板；自动登记团队名册（从 agentTeams 读取，可再补 role） | `projectName?`, `reference?` |
| `project_board_add` | 新增一个用户修改点（记录原话）；若 `mergeInto` 给出则作为该条目的新一轮返工记录 | `title`, `userQuote`, `detail?`, `category?`, `priority?`, `mergeInto?`, `member?`, `symptom?`, `cause?`, `evidence?` |
| `project_board_update` | 推进状态/分派环节/执行/测试/验收/返工/阻塞/改职/作废（action 驱动） | `itemId`, `action: dispatch\|start\|test\|accept\|reject\|fail\|attempt\|block\|obsolete\|reopen\|redefine\|unmerge`, `stage?`, `member?`, `role?`, `duties?`, `evidence?`, `note?`, `attempt?` |
| `project_board_merge` | 把重复/关联条目并入目标条目（保留原 id 于 mergedFrom） | `sourceIds[]`, `targetId`, `note?` |
| `project_board_reference` | 设置/更新「参考方案」与对标差距表（持续对标） | `name?`, `source?`, `pinnedVersion?`, `comparison?[]`, `lastComparedAt?` |
| `project_board_list` | 精简列出条目（支持 filter：状态/类别/关键词），供 Lead 与进度对照员审计 | `status?`, `category?`, `query?`, `limit?` |
| `project_board_audit` | 完整性审计：未派单/未测试/未验收/返工≥2/待确认/对标过期 的条目与计数 | — |

工具返回：紧凑 JSON（item 摘要 + 看板统计），避免大段回显。工具名统一 `project_board_*`；description 用中文写清用途与何时调用。

**看板互斥纪律**：只有 Lead 与「工程进度对照员」调用写类工具；其余成员用 `project_board_list` 只读+brief。由提示词约束，Host 不硬校验成员身份。

### 3.4 HTTP 快照路由（只读，供 Client 卡）

- `GET /api/project-board/snapshot?sessionId=<id>` → `{ ok:true, board:<board|null>, session:{id,preset,cwd}, serverTime }`
- 路由注册：`ctx.effect(() => ctx.webServer.register({ kind:'prefix', path:'/api/project-board', handler }))`
- session→board：`ctx.sessions.get(sessionId).header.cwd`；无 live session 返回 `{ok:false,error:'session-not-live'}`。
- 不提供写接口（UI 只读）；HTML 不拼接，只返回 JSON。

### 3.5 Client 悬浮卡（美术参考 dsh-claude-style）

- 挂载点：`ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name:'conversation.input.dock', id:'project-board', order: 30 }, Component))`（session 作用域，可取 `sessionId`）。
- 只有当该 session 工作区存在看板时渲染；否则不占空间。
- 收起态：一行胶囊条：`开发看板 · 共 N 项 · 进行中 x · 待验收 y` + 展开按钮。
- 展开态：悬浮卡片（`position: fixed`，右上，宽 ~420px，max-height 70vh），可拖拽（header 拖动 + 边界约束）、可收起、展开状态记忆在 `localStorage`。
- 卡片内容：项目名 / 参考方案徽标与对标时间 / 统计条 / 筛选 chips / 条目列表（状态色点、编号、标题、成员 chips、测试·验收徽记、返工次数角标）/ 展开条目详情（用户原话、分派环节与成员、执行、测试证据、验收证据、attempts 时间线、合并来源）/ 底部审计摘要。
- 视觉（对齐 dsh-claude-style，具体 token 见 `work/research/aesthetic-spec.md`）：
  - 字体：正文用宿主 UI 字体栈；编号/数字用等宽（`"JetBrains Mono", ui-monospace, ...`）；标题可用衬线点缀（Noto Serif 风格，仅在项目名/统计大数字上）。
  - 主题色：用宿主 `--dsw-alias-*` token 为底，叠加 claude 风格的暖墨色/奶油纸感强调色；状态色：待办=灰、执行中=蓝紫、测试=琥珀、验收=绿、返工=珊瑚红。
  - 动效：卡片入场 160ms ease-out 淡入上浮；状态点呼吸；进度条微光扫过；hover 抬升 1px + 边框提亮；条目展开 180ms 高度过渡。尊重 `prefers-reduced-motion`。
- 所有可见文案走 Client locale（zh 主、en 备）；卡片容器使用主题 token；无 DOM 侵入、无 iframe。

---

## 四、Bundle 结构（工作区 `work/plugin/`）

```
work/plugin/
  package.json          # name: dsh-project-dev; dsh.bundle.patch; dsh.client; exports 子路径
  cordis.patch.yml      # 插入 project-board 行 + project-dev-guard 行 + preset-project-dev 行
  index.js              # Host 半端入口（panel）：service + 快照路由（webServer 可选）
  guard.js              # profile 级 Host 插件：项目开发模式 Lead 的「完全不动手」硬拦截（agent.ctx.tools.guard）
  store.js              # 纯 JS 看板存储/状态机/审计（可被 node --test 直接测）
  board-tools.js        # preset 子插件：7 个工具
  mode-guard.js         # preset 子插件：2 个 prompt sections + 子智能体工具 restrict + 影子工具（best-effort）
  client.js             # Client 半端：悬浮卡
  locale/zh.json, en.json
  icon.svg
  test/store.test.mjs   # 单元测试（store 纯函数）
```

> **Lead 不动手的强制点**：不用「preset 子插件注册同名影子工具」作为唯一手段——2026-10-18 真实
> project-dev 会话实测影子工具没有遮住 preset 层工作类工具（Lead 成功调用了 read）。改为
> profile 级 Host 插件 `guard.js`：在 `agent/created` 里按 `SessionHeader.agentPreset === 'project-dev'`
> 且 `!parentSession && delegationDepth === 0` 识别 Lead，用 `agent.ctx.tools.guard()`（文档保证的
> per-Agent 同步拒绝点）拦截一切不在允许清单内的工具调用；同时对所有项目开发模式成员
> `restrict` 掉子智能体类全局工具。影子工具保留为 best-effort 的呈现层遮挡。

patch 关键行（示意）：

```yaml
# 注意：不覆盖 agent-team 行（沿用 profile 默认 maxMembers 8，靠改职复用而不是扩编）

- insert:
    - id: project-board
      name: dsh-project-dev
    - id: preset-project-dev
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: project-dev
        name: 项目开发模式
        description: ...
        order: 5
        plugins:
          - { id: persona, name: '@deepseek-ai/dsh-persona', config: { prefix: | ...Lead 章程... } }
          - { id: agent-instructions, name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } }
          - { id: time-context, name: '@deepseek-ai/dsh-time-context' }
          - { id: tool-pwsh, name: '@deepseek-ai/dsh-tool-pwsh', disabled: !!js process.platform !== 'win32' }
          - { id: tool-bash, name: '@deepseek-ai/dsh-tool-bash', disabled: !!js process.platform === 'win32' }
          - { id: tool-fs, name: '@deepseek-ai/dsh-tool-fs' }
          - { id: tool-fs-search, name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } }
          - { id: tool-jobs, name: '@deepseek-ai/dsh-tool-jobs' }
          - { id: skill-filesystem, name: '@deepseek-ai/dsh-skill-filesystem' }
          - { id: tool-skill, name: '@deepseek-ai/dsh-tool-skill' }
          - { id: command-goal, name: '@deepseek-ai/dsh-command-goal' }
          - { id: tool-goal, name: '@deepseek-ai/dsh-tool-goal' }
          - { id: planning, name: 'cordis:group', group: true, isolate: { planMode: true },
              config: [ { id: plan-mode, name: '@deepseek-ai/dsh-plan-mode', config: { section: '...' } } ] }
          - { id: compaction, name: 'cordis:group', group: true, isolate: { compaction: true, toolResultPruner: true }, config: [...] }
          - { id: tool-ask-user, name: '@deepseek-ai/dsh-tool-ask-user' }
          - { id: tool-todo, name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } }
          - { id: tool-web, name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } }
          - { id: present, name: '@deepseek-ai/dsh-tool-present' }
          - { id: board-tools, name: 'dsh-project-dev/board-tools' }
          - { id: mode-guard, name: 'dsh-project-dev/mode-guard' }
```

（YAML 实际写法可展开成多行；`dsh-project-dev/board-tools` 等子路径在 package.json `exports` 中声明。）

## 五、验收标准

1. 安装后 `plugin_manager list_plugins` 中 `preset-project-dev` 处于 active；新会话可选「项目开发模式」。
2. 该模式工具面：含 7 个 `project_board_*`、ask_user_question、web_search/web_fetch；**不含** `subagent` / `subagent_fork` / `subagent_codex` / `workflow` / `ralph`（被拦截）。
3. 工具行为：open→add→dispatch→start→test→accept→fail→attempt→merge→audit 全链路通过；同一问题两次返工归并在同一 item（attempts≥2，mergedFrom 正确）。
4. 持久化：同工作区新会话仍能读到同一看板；重启 Harness 后数据仍在。
5. 路由：`GET /api/project-board/snapshot?sessionId=...` 返回正确 JSON；无 session 时优雅失败。
6. UI：聊天内出现悬浮卡；条目字段完整展示；收起/展开/拖拽可用；深/浅色主题下可读；动效符合规格；无 console 崩溃（slot entry crashed 不允许）。
7. 文档：`work/DELIVERY.md` 写清安装/启用/使用/已知限制。

## 六、已知限制（必须写进交付说明）

- 运行时没有「删除 agent-team 成员」的 API；辞退只能是软辞退（interrupt + 不再派活 + 看板标记 retired）。成员名称与名额仍记录在案。**用户拍板改为「即时修改成员定义（redefine 改职复用）」**，不再扩建/辞退。
- `spawn_teammate` 的 name 只接受小写英文 kebab-case，故成员 name 用「英文职位-英文昵称」（如 `researcher-ada`），中文职位同时写在 description 首段与看板 `team[]` 中；团队面板只显示 name，所以 name 必须带工种前缀。
- 看板工具只挂在项目开发模式；标准模式看不到这些工具，但已存在看板的会话仍会看到悬浮卡（只读展示）。
- Client UI 为只读；看板写入只经 agent 工具。
- **宿主插件改动需要重启 DSH 一次才能生效**（本机 plugin_manager 对 linked bundle 的改动返回 `restart-required`）；Client 改动刷新页面即可。
