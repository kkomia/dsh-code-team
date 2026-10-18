# dsh-code-team (English)

> A **Project Development Mode** agent preset plus an in-chat **development progress board** plugin for DeepSeek Harness.

The main conversation (Lead) only understands requirements, records every user modification point, delegates by role to an agent team, and verifies evidence — it never touches code or files itself. A floating board in the chat tracks each modification point through dispatch (with per-stage members), execution, testing and acceptance; repeated failed fixes are merged into the same item, and a pinned reference implementation is continuously benchmarked.

- Bundle/package: `dsh-project-dev`
- Requires: DeepSeek Harness `>= 0.2.1-rc.2` (experimental Agent Teams), Node `>= 22`
- License: MIT

![Board](docs/shots/04b-board-item-fixed-zoom.png)

## Install

```bash
# install straight from the GitHub repo (recommended)
dsh plugin --profile desktop add github:kkomia/dsh-code-team
# or clone and link a local directory
git clone https://github.com/kkomia/dsh-code-team.git
dsh plugin --profile desktop add link:<repo abs path>
```

Restart DeepSeek Harness once (host plugins/preset declarations reload on restart). Then open **Settings → Agent presets → Custom → 项目开发模式 (Project Development Mode)** and set it as the default, or pick it from the mode chip on a new session.

## What you get

- **Project Development Mode** (`preset-project-dev`, id `project-dev`): lead-only orchestration, role-based agent team (research, planning, design, progress tracking, testing, acceptance + optional frontend/backend/exploration/review), research & continuous benchmarking against one pinned reference, strict "use agent-team only" (no subagents/workflow/ralph).
- **Role-prefixed teammate names**: member names are `role-nickname` kebab-case (e.g. `researcher-ada`, `frontend-cyrus`) so the team panel shows each member's role at a glance; the Chinese role text stays in the description and board roster.
- **Development progress board**: floating card in chat (docked top-left below the team bar), pill summary, filters, item details with quotes/dispatch/execution/test/acceptance/attempts/audit.
- **7 board tools** `project_board_open/add/update/merge/reference/list/audit`, persisted per workspace under `$DSH_HOME/project-dev/boards/`.
- **Lead hard guard** (`guard.js`): a profile-level per-agent `tools.guard()` denies every non-allowlisted tool call for the mode's Lead.

## Docs

- [Design spec](docs/DESIGN.md)
- [Field contract](docs/PROTOCOL.md)
- [Prompt text](docs/MODE-TEXT.md)

## Test

```bash
node --test test/
```

## License

[MIT](LICENSE) © 2026 kkomia
