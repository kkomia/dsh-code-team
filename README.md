# dsh-code-team

> DeepSeek Harness 的「**项目开发模式**」+「**开发进度看板**」插件。
>
> 模式：主对话（Lead）只做 *理解需求 → 记录修改点 → 按工种派活 → 验收汇报*，完全不动手；具体工作全部交给 agent-team。
> 插件：聊天内一张**悬浮开发看板**，把用户提出的每个修改点按「派单（含各环节成员）→ 执行 → 测试 → 验收」追踪；同一问题多次返工归并进同一条目；并持续维护对参考方案的对标。

- 插件包名：`dsh-project-dev`（同一个 bundle 同时携带 preset、Host 服务/路由、7 个看板工具、Lead 硬拦截与 Client 悬浮卡）
- 运行要求：DeepSeek Harness `>= 0.2.1-rc.2`（实验版 Agent Teams）、Node `>= 22`
- 许可：MIT

![悬浮看板](docs/shots/04b-board-item-fixed-zoom.png)

---

## 它解决什么问题

长时间的项目开发里，主对话容易犯四类错：**自己动手干活**、**漏掉用户后来提的修改点**、**同一问题反复返工却没有归并记录**、**没有持续对标的参考实现**。这个项目把它们变成机制：

1. **Lead 完全不动手**：`guard.js` 在 profile 级按 `SessionHeader.agentPreset` 识别项目开发模式 Lead，用 `agent.ctx.tools.guard()` 拒绝一切不在允许清单内的工具调用（读文件、跑命令、查网页、写文件全部拦截）；Lead 自己只用 agent-team + 看板 + ask/todo/goal/plan/present。
2. **修改点台账**：用户每个修改点在当轮写入看板（逐字保留 `userQuote`），状态机 `pending → dispatched → running → testing → tested → accepting → accepted`，失败回退并记录 attempts。
3. **按工种派活**：团队常设调研/规划/设计/工程进度对照/测试/验收六席，按需增设前端/后端/探索/审核；一人最多两职；**成员 name 用「英文职位-英文昵称」**（如 `researcher-ada`、`frontend-cyrus`，团队面板直接可辨工种），显示「中文职位 · 昵称」；闲置成员即时**改定义（redefine）**复用，不扩编不辞退。
4. **持续对标**：固定一份参考方案（本地源码/仓库/截图/竞品），每次大改前调研员读参考实现产出「对标差距表」，写回看板 `reference`，14 天未对标会在审计里提醒。
5. **只用 agent-team**：项目开发模式成员看不到 subagent / subagent_fork / subagent_codex / workflow / ralph。

## 安装

### 方式 A：用 Agent / 插件管理工具（推荐）

把本仓库克隆到本地任意目录，然后在 DSH 里让 Agent 执行：

```
plugin_manager install_bundle  target = <本仓库绝对路径>
```

或直接调用 `plugin_manager` 的工具动作（Web 端 Plugins 页的安装能力同源）。

### 方式 B：命令行

```bash
# 直接用 GitHub 仓库安装（推荐）
dsh plugin --profile desktop add github:kkomia/dsh-code-team
# 或先 clone 再装本地目录
git clone https://github.com/kkomia/dsh-code-team.git
dsh plugin --profile desktop add link:<本仓库绝对路径>
# 然后重启一次 DeepSeek Harness（Host 插件改动需要重启生效）
```

> `--profile desktop` 换成你实际使用的 Web profile 名称即可。若本包发布到 npm，也可以 `dsh plugin --profile desktop add dsh-project-dev`。

安装完成后：

1. **重启 DSH 一次**（Host 插件与 preset 声明需要重新加载）。
2. 打开 **设置（Ctrl+,）→ Agent 预设 → 自定义 → 项目开发模式**，点卡片「设为新任务默认」；或在新建会话页底部模式 chip 里选择「项目开发模式」。

> 之后如果只改 `client.js`：刷新页面即可；改 Host 文件（index/store/board-tools/mode-guard/guard/patch）需要重新安装并重启。

## 使用

1. 在「项目开发模式」会话里直接提需求/修改点。Lead 会先复述理解，有歧义用 `ask_user_question` 追问。
2. Lead 把每个修改点写进看板，然后按工种 `send_message` 派活并登记 `dispatch`（记录环节 + 成员）。
3. 项目开发模式会话里，**对话区左上角（「智能体团队」条下方）**出现收起态胶囊「开发看板 · 共 N 项 · 进行中 x · 待验收 y」；胶囊**可拖动**、位置记忆，点一下展开成悬浮卡（展开后也可拖标题栏、Esc 收起）：
   - 参考方案条（名称 + 固定版本 + 对标时间 / 差距数）
   - 统计与验收进度、7 个筛选
   - 条目列表与详情（用户原话、理解与验收标准、分派环节、执行、测试证据、验收证据、attempts 返工时间线、合并来源、审计摘要）
   - 看板尚未建立/加载中时，同一位置显示「开发看板 · 等待 Lead 入板」胶囊，同样可拖动；其他模式会话不占空间
4. 进度对照员定期用 `project_board_audit` 抓「未派单 / 未测试 / 未验收 / 返工≥2 / 待确认 / 对标过期」，Lead 汇报前也会看审计。

![模式会话](docs/shots/01-mode-session.png)

## 看板数据与工具

数据按**工作区路径**持久化：`$DSH_HOME/project-dev/boards/<boardId>.json`（`boardId = pb- + sha1(工作区路径)[:8]`；原子写 + 进程内串行队列）。UI 只读，写入只经 agent 工具。

| 工具 | 作用 |
|---|---|
| `project_board_open` | 打开/创建当前工作区看板，自动同步团队名册（`team[]`） |
| `project_board_add` | 新增一个用户修改点；带 `mergeInto` 时作为该条目的新一轮返工记录 |
| `project_board_update` | 推进状态：`dispatch / start / test / accept / reject / fail / attempt / block / obsolete / reopen / redefine / unmerge`；另含 `prune` 批量清理（按 `ids` / `statuses` / `categories`，或 `scope:"all"` 清空整板；`dryRun` 预览、`confirm` 保护） |
| `project_board_merge` | 把重复/关联条目并入目标条目（保留来源 id 于 `mergedFrom`，禁链式合并） |
| `project_board_reference` | 设置/更新参考方案与对标差距表 |
| `project_board_list` | 精简查询（状态/类别/关键词） |
| `project_board_audit` | 完整性审计（未派单/未测试/未验收/返工≥2/待确认/对标过期/stale running） |

**写权限**：Lead 与「工程进度对照员」负责写看板；其他成员用 list/audit 只读自查。

### 条目（item）字段

`id, number, title, userQuote, detail, category, priority, status, dispatch{stages[]}, execution, test{status,member,evidence}, acceptance{status,member,evidence}, attempts[], mergedFrom[], mergedInto, tags, note, createdAt, updatedAt`

同一问题多次未修复：用 `fail` / `attempt` / `mergeInto` 记进同一 `attempts[]`，禁止新开条目掩盖。

## 团队分工

| 职位 | 必要性 | 职责 |
|---|---|---|
| 调研员 | 常设 | 读参考实现源码/文档/截图，出对标差距表；可行性调研 |
| 规划员 | 常设 | 把修改点拆成工作流与依赖，排批次与里程碑 |
| 设计师 | 常设 | UI/UX/动效/文案方案，先方案后实施 |
| 工程进度对照员 | 常设 | 看板第二写手：核对用户消息与看板、抓遗漏、推进状态、出审计报告 |
| 测试员 | 常设 | 写/跑测试，给命令输出/截图/复现步骤等证据 |
| 验收员 | 常设 | 逐条对照用户原话验收，拒绝无证据的「已完成」；兼审核 |
| 前端 / 后端 / 探索 / 审核 | 机动 | 按需增设；一人最多两职 |

成员 name 受 `spawn_teammate` 限制只能是小写英文 kebab，因此**强制采用「英文职位-英文昵称」**（如 `researcher-ada`、`frontend-cyrus`、`tester-dora`；固定前缀：researcher/planner/designer/progress/tester/acceptance/frontend/backend/explorer/reviewer），这样团队面板（只显示 name）一眼能看出工种；中文职位写在 `description` 首段、看板 `team[]` 与成员 chip 中。`send_message` 的 `target` 必须用英文 name/target（`list_agents` 返回值），显示名只用于汇报。改职（redefine）不改 name，当前职位以 description/看板为准。

## 开发与测试

```bash
# 33 条单元测试（store 状态机/返工归并/持久化 + guard 硬拦截），只依赖 Node 内置模块
node --test test/
# 或
node --test test/store.test.mjs
node --test test/guard.test.mjs
```

本机验证用 `node >= 22.19`（`node --test test/` 走 `test/index.js` 聚合入口）。

### 已完成的真实验证

- **33 条单测全绿**：本机与 GitHub Actions CI 均通过。
- **真实 GUI**：项目开发模式会话可正常创建（SessionHeader `agentPreset=project-dev`）；7 个 `project_board_*` 工具全链路实测（open → add → dispatch → start → test/audit）；悬浮卡在真实会话中渲染、展开、条目详情与审计均正常。
- **Lead 硬拦截（重启后复测）**：新 project-dev 会话里 `read/write` 的工具定义被替换为「⛔ 本模式禁用」占位描述，Lead 即使用户明确要求"允许违反一次"也拒绝调用；`ralph/subagent_codex` 完全不可见。详见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

![重启后硬拦截复测](docs/shots/06-guard-after-restart.png)

目录：

```
index.js          Host 入口：projectBoard 服务 + 只读快照路由 /api/project-board/snapshot
guard.js          profile 级 Lead 硬拦截（agent.ctx.tools.guard）
store.js          纯函数看板存储/状态机/审计（可直接 node --test）
board-tools.js    preset 内 7 个 project_board_* 工具
mode-guard.js     preset 内提示词 sections + 子智能体工具 restrict + best-effort 影子工具
client.js         Client 悬浮看板（conversation.input.dock）
cordis.patch.yml  profile 补丁：project-board / project-dev-guard / preset-project-dev
docs/             DESIGN.md（设计规格）、PROTOCOL.md（字段契约）、MODE-TEXT.md（提示词正文）、VERIFICATION.md（重启后复测记录）
```

## 已知限制

- 运行时没有「删除 agent-team 成员」的 API：成员 name/名额记录永久保留，所以采用**即时修改成员定义（redefine 改职复用）**，不扩编、不辞退。
- `spawn_teammate` 的 name 只接受小写英文 kebab-case，因此强制用「英文职位-英文昵称」（如 `researcher-ada`）让团队面板可辨工种；中文职位放在 description 首段/看板中显示。改职（redefine）不改 name，当前职位以 description/看板为准。
- teammate 会继承 Lead 的 preset，因此工作类工具保留在 preset 里给同事用；Lead 的限制由 profile 级 `guard.js` 的 per-Agent guard 实现。
- 看板工具只挂在项目开发模式；其他模式看不到工具，但已存在看板的会话仍会显示悬浮卡（只读）。
- Client UI 只读；看板写入只经 agent 工具。
- Host 插件改动需要重启 DSH 一次；Client 改动刷新页面即可。
- 看板按「工作区路径」归并：同一目录视为同一项目（多项目请分目录）。
- 本模式使用默认 native 工具呈现；若改成 PTC 呈现，所有工具调用会走 `run_code` 并被 Lead 守护拒绝（设计上不兼容 PTC）。
- 部分环境的宿主 pointer 事件可能影响卡片拖动；默认位置已固定在对话区左上角，不需要拖动。

## 致谢

- 美术与交互参考：[dsh-claude-style](https://github.com/kkomia)（字体、主题色、动效节奏按本插件主题 token 适配）。
- 运行底座：DeepSeek Harness 的 Agent Teams（`@deepseek-ai/dsh-experimental-agent-team` 等）。

## License

[MIT](LICENSE) © 2026 kkomia
