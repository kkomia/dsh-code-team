# Changelog

## 0.1.3 — 2026-10-18

### Changed

- **收起态胶囊也可以拖动了**：胶囊与展开卡共用同一套 pointer 拖动（拖动阈值 3px，未拖动则视为点击展开），位置两者共享并记忆（localStorage key 升到 `project-board.pos.v3`，旧的 v2 坐标作废）。
- **胶囊初始位置**改为对话区左上角、「智能体团队」条下方（与展开卡默认位置一致）；「等待 Lead 入板 / 连接失败，重试中…」提示胶囊也固定在该位置且可拖动。
- 胶囊左侧增加拖动握把图标，悬停/拖动有 cursor 反馈。

## 0.1.2 — 2026-10-18

### Fixed

- **重启后看板不显示（Host 路由漏注册）**：`index.js` 在插件 `apply` 时直接 `ctx.get('webServer')` 读可选服务，重启后该服务可能尚未就绪，导致 `/api/project-board/snapshot` 路由根本没有注册；Client 每 2s 轮询全部 404（实机 Console 1,000+ 条 404），看板静默消失。改为 `ctx.inject(['webServer'], ...)` 等待服务就绪后再注册路由（无浏览器面的 headless/tui profile 仍优雅跳过）。
- **项目开发模式会话里看板无数据时现在有提示**：看板还没建/加载失败时，不再整块消失，而是显示一个「开发看板 · 等待 Lead 入板 / 连接失败，重试中…」胶囊；非项目开发模式会话保持不占空间。
- 版本 0.1.2。

## 0.1.1 — 2026-10-18

### Changed

- **teammate 命名规则改为「英文职位-英文昵称」**（如 `researcher-ada`、`frontend-cyrus`、`tester-dora`）：团队面板只显示 name，之前只有昵称无法看出工种；现在 name 自带固定职位前缀（researcher / planner / designer / progress / tester / acceptance / frontend / backend / explorer / reviewer）。
  - `description` 首段仍为「中文职位 · 英文昵称」+ 中文职责，看板 `team[]` 与成员 chip 用中文显示。
  - 改职（`redefine`）不改 name，当前职位以 description/看板为准。
- 同步更新 persona、团队职责 prompt、DESIGN/MODE-TEXT/README 与运行期提示词校验测试。

## 0.1.0 — 2026-10-18

首个公开版本：项目开发模式 + 开发进度看板。

### Added

- **项目开发模式**（`preset-project-dev`，id `project-dev`）
  - Lead 章程（双角色分流：Lead / teammate）：只理解、记台账、按工种派活、验收；完全不动手
  - 团队编制：调研/规划/设计/工程进度对照/测试/验收六席常设，前后端/探索/审核机动；一人最多两职；成员英文昵称 + 中文职位显示；闲置即刻 `redefine` 改职复用
  - 调研与持续对标：固定参考方案（名称/来源/版本）+ 对标差距表 + 14 天过期审计
  - 只用 agent-team：项目开发模式成员不可见 subagent / subagent_fork / subagent_codex / workflow / ralph
  - 移除了 delegation 组（无 tool-subagent / workflow / ralph）
- **开发进度看板插件**
  - Host 服务 `projectBoard` + 只读快照路由 `GET /api/project-board/snapshot?sessionId=`
  - 看板按工作区持久化（`pb-` + sha1 前 8 位），原子写 + 进程内串行队列
  - 7 个工具：`project_board_open / add / update / merge / reference / list / audit`
  - 状态机：pending → dispatched → running → testing → tested → accepting → accepted（失败回退 + attempts 返工归并）
  - 聊天内悬浮卡（`conversation.input.dock`）：胶囊态 + 对话区左上角悬浮卡（可拖拽/收起/位置记忆），参考方案条、统计、7 个筛选、条目详情、审计摘要
  - 视觉参考 dsh-claude-style：衬线标题/大数字、等宽编号、clay 强调色、入场/呼吸/微光/悬停动效、`prefers-reduced-motion` 支持
- **Lead 硬拦截**（`guard.js`，profile 级）
  - 按 `SessionHeader.agentPreset` / `composedPreset` 识别 Lead，用 `agent.ctx.tools.guard()` 拒绝允许清单外的工具调用
  - 所有项目开发模式成员 `agent.ctx.tools.restrict()` 屏蔽全局子智能体/工作流工具
  - `agent/disposed` 清理、`agent-preset/selected` 补装、live Agent 补装
- **测试**：33 条单元测试（store 17 + guard 16），仅依赖 Node 内置模块
- **文档**：`docs/DESIGN.md`、`docs/PROTOCOL.md`、`docs/MODE-TEXT.md`、GUI 截图

### Known limitations

- 运行时无删除 agent-team 成员 API，采用 redefine 改职复用
- 成员 name 仅支持小写英文 kebab-case
- Host 插件改动需重启 DSH 一次
