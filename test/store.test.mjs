/**
 * test/store.test.mjs — store.js 单元测试（node --test 直接运行，不依赖 dsh 宿主）
 * ============================================================================
 * 覆盖 work/PROTOCOL.md §7 的断言 1–6（断言 7/8 需要安装后的宿主，由 Lead/QA 验收），
 * 以及 redefine（改职复用）与持久化/归一化等回归断言。
 * 运行：cd work/plugin && node --test test/store.test.mjs
 * ============================================================================
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addItem,
  audit,
  boardIdFor,
  createStore,
  emptyBoard,
  listItems,
  mergeItems,
  normalizeBoard,
  setReference,
  statsOf,
  updateItem,
  validateItemInput,
} from '../store.js'

/** 固定时钟：所有断言可复现。 */
const NOW = 1760000000000
const WORKSPACE = 'F:\\kyclaw'

/** 一张空看板。 */
function newBoard() {
  return emptyBoard({ workspacePath: WORKSPACE, projectName: 'kyclaw' })
}

/** add 一条并返回 { board, item }。 */
function add(board, title, userQuote, extra = {}, now = NOW) {
  return addItem(board, { title, userQuote, ...extra }, now)
}

/* ------------------------------------------------------------------ */
/* 断言 1：boardIdFor 稳定且 8 位                                       */
/* ------------------------------------------------------------------ */
test('断言1：boardIdFor 稳定、8 位十六进制、按工作区归一', () => {
  const id = boardIdFor('F:\\kyclaw')
  assert.equal(boardIdFor('F:\\kyclaw'), id, '同一路径必须得到同一个 boardId')
  assert.match(id, /^pb-[0-9a-f]{8}$/, 'boardId = pb- + sha1 前 8 位')
  assert.equal(boardIdFor('f:/kyclaw/'), id, '大小写/斜杠/尾斜杠归一后应相同')
  assert.notEqual(boardIdFor('F:\\other'), id, '不同工作区必须不同')
  assert.match(boardIdFor(''), /^pb-[0-9a-f]{8}$/, '空路径也要给出稳定 id')
})

/* ------------------------------------------------------------------ */
/* 断言 2：add 3 条、dispatch 1 条 → stats.dispatched=1，其余未派单      */
/* ------------------------------------------------------------------ */
test('断言2：add 3 条 + dispatch 1 条后 dispatched=1、其余在 audit.undispatched', () => {
  let board = newBoard()
  const first = add(board, '输入框高度改成一行', '输入框太高了，改成一行')
  board = first.board
  const second = add(board, '侧边栏加折叠', '侧边栏能不能折叠')
  board = second.board
  const third = add(board, '暗色主题对比度', '暗色下字看不清')
  board = third.board
  assert.equal(board.items.length, 3)
  assert.deepEqual(
    board.items.map((item) => item.id),
    ['PB-001', 'PB-002', 'PB-003'],
    '编号应从 PB-001 开始连续自增',
  )

  const dispatched = updateItem(
    board,
    { itemId: first.item.id, action: 'dispatch', stage: 'frontend', member: '前端工程师 · Cyrus' },
    NOW + 1,
  )
  board = dispatched.board
  const stats = statsOf(board)
  assert.equal(stats.dispatched, 1, 'stats.dispatched 必须有顶层计数')
  assert.equal(stats.byStatus.dispatched, 1, 'byStatus.dispatched 同步')
  assert.equal(dispatched.item.status, 'dispatched')
  assert.equal(dispatched.item.dispatch.done, true)
  assert.deepEqual(
    dispatched.item.dispatch.stages.map((stage) => [stage.stage, stage.role, stage.member]),
    [['frontend', '前端工程师', '前端工程师 · Cyrus']],
  )

  const { audit: report } = audit(board)
  assert.deepEqual(
    [...report.undispatched].sort(),
    [second.item.id, third.item.id].sort(),
    '其余 2 条必须在 audit.undispatched',
  )
})

/* ------------------------------------------------------------------ */
/* 断言 3：同一 item fail 两次 → audit.rework 含该 id、attempts=2        */
/* ------------------------------------------------------------------ */
test('断言3：同一 item fail 两次后 audit.rework 含该 id 且 attempts=2', () => {
  let board = newBoard()
  const added = add(board, '弹窗遮罩层点击穿透', '点遮罩会点到后面的按钮')
  board = added.board
  const id = added.item.id

  board = updateItem(board, { itemId: id, action: 'fail', member: '前端工程师 · Cyrus', symptom: '仍有穿透' }, NOW + 1).board
  board = updateItem(board, { itemId: id, action: 'fail', member: '前端工程师 · Cyrus', symptom: '还是穿透' }, NOW + 2).board

  const item = board.items.find((candidate) => candidate.id === id)
  assert.equal(item.attempts.length, 2, '两次 fail 必须累计 2 条 attempts')
  assert.deepEqual(
    item.attempts.map((attempt) => attempt.round),
    [1, 2],
  )
  assert.equal(item.status, 'running', 'fail 后状态回到 running')

  const { audit: report } = audit(board)
  assert.ok(report.rework.includes(id), '两次未修复的返工必须在 audit.rework')
  assert.equal(statsOf(board).rework, 1)
})

/* ------------------------------------------------------------------ */
/* 断言 4：mergeItems 后来源 mergedInto/obsolete，目标 attempts 增加      */
/* ------------------------------------------------------------------ */
test('断言4：mergeItems 后来源 id 在 target.mergedFrom、目标 attempts 增加、来源 obsolete', () => {
  let board = newBoard()
  const target = add(board, '字体统一', '字体不一致')
  board = target.board
  const source = add(board, '字体统一（重复）', '还是字体不一致')
  board = source.board
  board = updateItem(board, { itemId: source.item.id, action: 'fail', member: '设计师 · Lily', symptom: '仍未统一' }, NOW + 3).board
  const sourceAttemptsBefore = board.items.find((item) => item.id === source.item.id).attempts.length
  assert.equal(sourceAttemptsBefore, 1)

  const merged = mergeItems(board, {
    sourceIds: [source.item.id],
    targetId: target.item.id,
    note: '同一问题重复登记',
  })
  board = merged.board
  const mergedSource = board.items.find((item) => item.id === source.item.id)
  const mergedTarget = board.items.find((item) => item.id === target.item.id)
  assert.equal(mergedSource.mergedInto, target.item.id)
  assert.equal(mergedSource.status, 'obsolete')
  assert.ok(mergedTarget.mergedFrom.includes(source.item.id), 'target.mergedFrom 记录来源 id')
  assert.equal(mergedTarget.attempts.length, sourceAttemptsBefore, '目标 attempts 追加来源的返工记录')
  assert.equal(mergedTarget.attempts[0].round, 1, '合并进来的 attempts 重新编号 round')
  assert.match(mergedTarget.note, new RegExp(source.item.id), 'target.note 记录合并来源')
  assert.equal(audit(board).audit.mergedCount, 1)
  assert.equal(board.items.length, 2, '被合并条目保留在数组里（不删除）')

  // unmerge 可恢复为独立条目
  board = updateItem(board, { itemId: source.item.id, action: 'unmerge' }, NOW + 4).board
  const restored = board.items.find((item) => item.id === source.item.id)
  const targetAfterUnmerge = board.items.find((item) => item.id === target.item.id)
  assert.equal(restored.mergedInto, null)
  assert.equal(targetAfterUnmerge.mergedFrom.length, 0)
})

/* ------------------------------------------------------------------ */
/* 断言 5：test failed → status=running 且 attempts+1                   */
/* ------------------------------------------------------------------ */
test('断言5：updateItem(test, status=failed) → status=running 且 attempts+1', () => {
  let board = newBoard()
  const added = add(board, '滚动条位置', '滚动位置不对')
  board = added.board
  const id = added.item.id
  board = updateItem(board, { itemId: id, action: 'dispatch', stage: 'frontend', member: '前端工程师 · Cyrus' }, NOW + 1).board
  board = updateItem(board, { itemId: id, action: 'start', member: '前端工程师 · Cyrus' }, NOW + 2).board
  assert.equal(board.items[0].attempts.length, 0)

  board = updateItem(
    board,
    { itemId: id, action: 'test', member: '测试员 · Dora', status: 'failed', evidence: '滚动条仍不跟随' },
    NOW + 3,
  ).board
  const item = board.items[0]
  assert.equal(item.status, 'running', 'test failed 后回到 running')
  assert.equal(item.attempts.length, 1, 'test failed 自动追加一条 attempt')
  assert.equal(item.test.status, 'failed')
  assert.equal(item.test.member, '测试员 · Dora')
  assert.equal(item.attempts[0].outcome, 'unfixed')
})

/* ------------------------------------------------------------------ */
/* 断言 6：accept → status=accepted、stats.accepted=1                  */
/* ------------------------------------------------------------------ */
test('断言6：updateItem(accept) 后 status=accepted、stats.accepted=1', () => {
  let board = newBoard()
  const added = add(board, '快捷键提示', '加个快捷键提示')
  board = added.board
  const id = added.item.id
  board = updateItem(board, { itemId: id, action: 'dispatch', stage: 'frontend', member: '前端工程师 · Cyrus' }, NOW + 1).board
  board = updateItem(board, { itemId: id, action: 'start', member: '前端工程师 · Cyrus' }, NOW + 2).board
  board = updateItem(board, { itemId: id, action: 'test', member: '测试员 · Dora', status: 'passed', evidence: '测试通过 log.txt' }, NOW + 3).board
  assert.equal(board.items[0].status, 'tested')

  board = updateItem(
    board,
    { itemId: id, action: 'accept', member: '验收员 · Eve', evidence: '对照用户原话逐条核对通过' },
    NOW + 4,
  ).board
  const item = board.items[0]
  assert.equal(item.status, 'accepted')
  assert.equal(item.acceptance.status, 'passed')
  const stats = statsOf(board)
  assert.equal(stats.accepted, 1)
  assert.equal(stats.byStatus.accepted, 1)
})

/* ------------------------------------------------------------------ */
/* 断言 7（新增）：redefine 改职复用，item 本身不变                      */
/* ------------------------------------------------------------------ */
test('redefine：更新 team[] 的 role/duties/updatedAt、status=active，item 不变', () => {
  let board = newBoard()
  const added = add(board, '看板配色', '配色再暖一点')
  board = added.board
  const beforeItem = JSON.parse(JSON.stringify(board.items[0]))
  board = {
    ...board,
    team: [
      { role: '调研员', member: '调研员 · Ada', duties: '读参考实现', status: 'active', since: NOW, updatedAt: NOW },
      { role: '测试员', member: '测试员 · Dora', duties: '跑测试', status: 'active', since: NOW, updatedAt: NOW },
    ],
  }

  const result = updateItem(
    board,
    { itemId: added.item.id, action: 'redefine', member: '调研员 · Ada', role: '设计师', duties: '改做设计', note: '改职复用' },
    NOW + 10,
  )
  assert.equal(result.member.role, '设计师')
  assert.equal(result.member.duties, '改做设计')
  assert.equal(result.member.status, 'active')
  assert.equal(result.member.updatedAt, NOW + 10)
  assert.equal(result.board.team.length, 2, '改职不新增成员、不辞退')
  assert.deepEqual(result.board.items[0], beforeItem, 'item 本身不因 redefine 改变')

  // 用昵称也能定位成员
  const byNickname = updateItem(board, { action: 'redefine', member: 'Dora', role: '验收员' }, NOW + 11)
  assert.equal(byNickname.member.role, '验收员')
  assert.equal(byNickname.item, null)
})

/* ------------------------------------------------------------------ */
/* 其他回归：归并返工 / 输入校验 / 归一化 / 参考方案 / 存储               */
/* ------------------------------------------------------------------ */
test('add + mergeInto 把新问题记成同一 item 的下一轮返工，不新增条目', () => {
  let board = newBoard()
  const added = add(board, '输入框高度', '太高了')
  board = added.board
  const before = board.items.length
  const again = addItem(
    board,
    {
      title: '输入框高度（第二次提）',
      userQuote: '还是太高',
      mergeInto: added.item.id,
      member: '前端工程师 · Cyrus',
      symptom: '高度没改',
      cause: '样式被覆盖',
      evidence: '截图 2.png',
    },
    NOW + 5,
  )
  board = again.board
  assert.equal(board.items.length, before, 'mergeInto 不新增条目')
  assert.equal(board.nextItemNumber, 2, 'mergeInto 不消耗编号')
  assert.equal(again.item.attempts.length, 1)
  assert.equal(again.item.attempts[0].member, '前端工程师 · Cyrus')
  assert.equal(again.item.status, 'running')
  assert.match(again.item.userQuote, /还是太高/, '返工补充的 userQuote 逐字保留')
})

test('validateItemInput：title / userQuote 必填，category/priority 白名单', () => {
  assert.equal(validateItemInput({ title: '', userQuote: 'x' }).ok, false)
  assert.equal(validateItemInput({ title: 'x', userQuote: '   ' }).ok, false)
  assert.equal(validateItemInput({ title: 'x', userQuote: 'y', category: '乱写' }).ok, false)
  assert.equal(validateItemInput({ title: 'x', userQuote: 'y', priority: 'P9' }).ok, false)
  assert.equal(validateItemInput({ title: 'x', userQuote: 'y', category: 'UI', priority: 'P0' }).ok, true)
})

test('normalizeBoard：缺字段/旧数据归一后字段齐全，返回新对象', () => {
  const board = normalizeBoard({
    workspacePath: WORKSPACE,
    items: [{ title: '旧条目', userQuote: '旧原话' }],
    team: [{ role: '调研员', member: '调研员 · Ada' }],
  })
  assert.ok(board)
  assert.equal(board.version, 1)
  assert.match(board.boardId, /^pb-/)
  assert.equal(board.items.length, 1)
  assert.equal(board.items[0].id, 'PB-001')
  assert.equal(board.items[0].status, 'pending')
  assert.equal(board.items[0].dispatch.done, false)
  assert.equal(board.items[0].execution.status, 'idle')
  assert.equal(board.items[0].test.status, 'pending')
  assert.equal(board.items[0].acceptance.status, 'pending')
  assert.deepEqual(board.items[0].attempts, [])
  assert.equal(board.nextItemNumber, 2)
  assert.equal(board.team[0].status, 'active')
  assert.equal(typeof board.team[0].updatedAt, 'number')
  assert.equal(normalizeBoard(null), null)
})

test('setReference：固定参考方案、按维度合并差距表、刷新对标时间', () => {
  let board = newBoard()
  assert.equal(audit(board).audit.referenceStale, true, '没有参考方案时对标必过期')
  board = setReference(board, { name: 'dsh-claude-style', source: 'node_modules/dsh-claude-style', pinnedVersion: '0.16.1' }, NOW).board
  assert.equal(board.reference.name, 'dsh-claude-style')
  assert.equal(board.reference.lastComparedAt, 0, '只固定名称还不算对标')
  board = setReference(board, { comparison: [{ dimension: '字体', reference: 'Inter', ours: 'system', gap: '缺字体栈', status: 'open' }] }, NOW + 5).board
  assert.equal(board.reference.comparison.length, 1)
  assert.equal(board.reference.lastComparedAt, NOW + 5)
  board = setReference(
    board,
    { comparison: [{ dimension: '字体', reference: 'Inter', ours: 'Inter', gap: '已对齐', status: 'closed' }, { dimension: '圆角', reference: '12px', ours: '8px', gap: '偏小' }] },
    NOW + 6,
  ).board
  assert.equal(board.reference.comparison.length, 2, '同维度覆盖、新维度追加')
  assert.equal(board.reference.comparison[0].status, 'closed')
  assert.equal(board.reference.comparison[1].status, 'open', 'status 缺省 open')
  assert.equal(audit(board, NOW + 6).audit.referenceStale, false)
  assert.equal(audit(board, NOW + 6 + 15 * 24 * 60 * 60 * 1000).audit.referenceStale, true, '14 天后对标过期')
})

test('listItems：按状态/类别/关键词过滤，返回摘要与统计', () => {
  let board = newBoard()
  board = add(board, '输入框高度', '输入框太高了', { category: 'UI', priority: 'P0' }).board
  board = add(board, '接口 500 错误', '保存时报错', { category: '缺陷', priority: 'P1' }).board
  board = updateItem(board, { itemId: 'PB-002', action: 'dispatch', stage: 'backend', member: '后端工程师 · Bao' }, NOW + 1).board
  const ui = listItems(board, { category: 'UI' })
  assert.equal(ui.items.length, 1)
  assert.equal(ui.items[0].id, 'PB-001')
  const running = listItems(board, { status: 'running,dispatched' })
  assert.equal(running.items.length, 1)
  assert.equal(running.items[0].id, 'PB-002')
  const keyword = listItems(board, { query: '报错' })
  assert.equal(keyword.items.length, 1)
  const summary = keyword.items[0]
  assert.equal(summary.id, 'PB-002')
  assert.equal(summary.dispatchDone, true)
  assert.equal(summary.execution.status, 'idle')
  assert.equal(summary.test.status, 'pending')
  assert.equal(summary.acceptance.status, 'pending')
  assert.equal(summary.rework, 0)
  assert.equal(ui.stats.total, 2)
})

test('test failed 后可 fail/attempt 继续返工，reopen 清空测试/验收状态', () => {
  let board = newBoard()
  const added = add(board, '拖拽手柄', '手柄太小')
  board = added.board
  const id = added.item.id
  board = updateItem(board, { itemId: id, action: 'start', member: '设计师 · Lily' }, NOW + 1).board
  board = updateItem(board, { itemId: id, action: 'test', member: '测试员 · Dora', status: 'passed', evidence: 'ok' }, NOW + 2).board
  board = updateItem(board, { itemId: id, action: 'accept', member: '验收员 · Eve', evidence: '通过' }, NOW + 3).board
  assert.equal(board.items[0].status, 'accepted')

  board = updateItem(board, { itemId: id, action: 'reopen', note: '用户又说不行' }, NOW + 4).board
  const item = board.items[0]
  assert.equal(item.status, 'running')
  assert.equal(item.test.status, 'pending')
  assert.equal(item.acceptance.status, 'pending')
  assert.equal(item.execution.status, 'idle')
})

test('作废条目必须先 reopen（非法转移抛 BOARD_INVALID_TRANSITION）', () => {
  let board = newBoard()
  const added = add(board, '临时需求', '先不要了')
  board = added.board
  board = updateItem(board, { itemId: added.item.id, action: 'obsolete', note: '用户取消' }, NOW + 1).board
  assert.throws(
    () => updateItem(board, { itemId: added.item.id, action: 'start', member: '前端工程师 · Cyrus' }, NOW + 2),
    (error) => error.code === 'BOARD_INVALID_TRANSITION',
  )
  board = updateItem(board, { itemId: added.item.id, action: 'reopen' }, NOW + 3).board
  assert.equal(board.items[0].status, 'running')
})

test('不存在的 item 抛 BOARD_ITEM_NOT_FOUND', () => {
  const board = newBoard()
  assert.throws(
    () => updateItem(board, { itemId: 'PB-999', action: 'start' }, NOW),
    (error) => error.code === 'BOARD_ITEM_NOT_FOUND',
  )
  assert.throws(
    () => mergeItems(board, { sourceIds: ['PB-001'], targetId: 'PB-002' }, NOW),
    (error) => error.code === 'BOARD_ITEM_NOT_FOUND',
  )
})

test('createStore：open 创建、mutate 原子读改写、再次 open 不重复创建', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'project-dev-test-'))
  try {
    const store = createStore({ dir, clock: () => NOW })
    const created = await store.open({ boardId: 'pb-test0001', workspacePath: WORKSPACE, projectName: 'kyclaw' })
    assert.equal(created.created, true)
    assert.equal(created.board.projectName, 'kyclaw')

    const mutated = await store.mutate('pb-test0001', (board, at) => {
      const result = addItem(board, { title: '持久化条目', userQuote: '重启还在吗' }, at)
      return { board: result.board, value: result.item.id }
    })
    assert.equal(mutated.value, 'PB-001')

    const reloaded = await store.load('pb-test0001')
    assert.equal(reloaded.items.length, 1)
    assert.equal(reloaded.items[0].title, '持久化条目')

    const reopened = await store.open({ boardId: 'pb-test0001' })
    assert.equal(reopened.created, false, '已有文件不应重复创建')
    assert.equal(reopened.board.items.length, 1)

    await assert.rejects(
      () => store.mutate('pb-missing', (board) => ({ board })),
      (error) => error.code === 'BOARD_NOT_FOUND',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('并发写：同一 board 的 promise 队列串行化，不丢更新', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'project-dev-queue-'))
  try {
    const store = createStore({ dir, clock: () => NOW })
    await store.open({ boardId: 'pb-queue001', workspacePath: WORKSPACE })
    const writes = Array.from({ length: 8 }, (_, index) =>
      store.mutate('pb-queue001', (board, at) => {
        const result = addItem(board, { title: `并发 ${index}`, userQuote: `第 ${index} 条` }, at + index)
        return { board: result.board, value: result.item.id }
      }),
    )
    await Promise.all(writes)
    const board = await store.load('pb-queue001')
    assert.equal(board.items.length, 8, '串行队列必须保住每一次写入')
    assert.deepEqual(
      board.items.map((item) => item.number),
      [1, 2, 3, 4, 5, 6, 7, 8],
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
