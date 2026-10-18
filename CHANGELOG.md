# Changelog

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
