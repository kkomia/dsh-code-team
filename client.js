/**
 * dsh-project-dev · Client half —— 聊天内「开发进度看板」悬浮卡
 * ============================================================================
 * 契约见 work/PROTOCOL.md §6、DESIGN.md §3.5：
 *   - 自注册脚本（非 ESM）：window.__ModuleLoader__.load({ id, factory(require) })
 *   - 只 require('react')，不 require 任何宿主 Client 包
 *   - 挂 conversation.input.dock（session 作用域），从 props.sessionId 取会话 id；
 *     已用宿主 `dsh-cordis-client-runner` 的 slot 契约核对：0.2.1-rc.2 的
 *     ui-conversation 确实声明该 slot（kind:list / scope:session，standardProps 含
 *     sessionId）；「满宽、位于 composer 卡上方」，故收起态胶囊条直接排在该 dock 行里。
 *   - GET /api/project-board/snapshot?sessionId=... （只读，same-origin，2s 轮询）
 *   - board 为 null 时不渲染（不占空间）；收起态 = 胶囊条；展开态 = 固定悬浮卡
 *   - 视觉按 work/research/aesthetic-spec.md 落地（dsh-claude-style 语言）：
 *     颜色/字体/圆角/动效数值见该文档 §2/§3/§4/§5/§6；本文件底部 CSS 的 --pb-* 变量
 *     一律以宿主 --dsw-alias-* / --dsw-font-* token 为默认值，字面色只做兜底。
 *   - 文案走 Client locale 命名空间 'project-board'（zh 主 / en 备），locale 不可用时
 *     中文内联兜底；locale.register 两种签名（{zh,en} 与 (ns,'zh',dict)）都兼容。
 *
 * 稳定性约束（重要）：
 *   - 组件抛错会让整个 slot entry 崩溃，故本文件所有 fetch / JSON 解析 / locale /
 *     localStorage 调用都 try/catch 兜底，外层再包一个 ErrorBoundary 作为最后防线。
 *   - 组件卸载 / 页面隐藏时停止轮询；定时器、监听器、transform 都在卸载时清理。
 *   - 不写宿主 DOM，样式用单个 <style>（data-plugin-css 标记）在 apply 的 effect 里
 *     注入与移除；组件只操作自己的节点。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-project-dev',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /* ------------------------------------------------------------------ */
    /* 0. 常量                                                              */
    /* ------------------------------------------------------------------ */

    const NS = 'project-board';
    const SNAPSHOT_PATH = '/api/project-board/snapshot';
    const POLL_MS = 2000;
    const MAX_BACKOFF_MS = 10000;
    const CARD_WIDTH = 420;
    const EDGE_MARGIN = 8;
    /** 默认位置：对话区左上角、「智能体团队」条下方（用户 PB-007 要求；PB-008 胶囊也用同一初始位置）。 */
    const DEFAULT_TOP = 96;
    /** 旧版本默认在右上角；v2 让旧 localStorage 位置作废；v3 胶囊参与拖动记忆；v4 让开发期拖动测试的坐标作废、回到新默认。 */
    const POS_KEY = 'project-board.pos.v4';
    const OPEN_KEY = 'project-board.open';
    const REWORK_ALERT = 2;
    const REF_STALE_MS = 14 * 24 * 60 * 60 * 1000;
    const CARD_Z = 1000;
    const KEYBOARD_MOVE_STEP = 8;

    const FILTERS = [
      { id: 'all', key: 'filter.all' },
      { id: 'pending', key: 'filter.pending' },
      { id: 'running', key: 'filter.running' },
      { id: 'testing', key: 'filter.testing' },
      { id: 'accepting', key: 'filter.accepting' },
      { id: 'accepted', key: 'filter.accepted' },
      { id: 'rework', key: 'filter.rework' },
    ];

    /* ------------------------------------------------------------------ */
    /* 1. locale 字典（zh 主 / en 备；key 必须一一对应）                      */
    /* ------------------------------------------------------------------ */

    const zh = {
      'pill.label': '开发看板',
      'pill.expand': '展开开发进度看板',
      'pill.waiting': '等待 Lead 入板',
      'pill.errorRetry': '连接失败，重试中…',
      'pill.total': '共 {n} 项',
      'pill.running': '进行中 {n}',
      'pill.accepting': '待验收 {n}',
      'card.untitled': '未命名项目',
      'card.collapse': '收起看板',
      'card.updated': '更新于 {time}',
      'card.comparedAt': '对标于 {time}',
      'card.referenceStale': '对标过期',
      'card.compareOpen': '差距 {n}',
      'stats.total': '总数',
      'stats.running': '进行中',
      'stats.accepting': '待验收',
      'stats.rework': '返工≥2',
      'progress.label': '验收进度',
      'progress.value': '{a}/{t}',
      'filter.all': '全部',
      'filter.pending': '待派单',
      'filter.running': '执行中',
      'filter.testing': '待测试',
      'filter.accepting': '待验收',
      'filter.accepted': '已验收',
      'filter.rework': '返工',
      'list.empty': '没有符合条件的修改点',
      'status.pending': '待派单',
      'status.dispatched': '已派单',
      'status.running': '执行中',
      'status.testing': '测试中',
      'status.tested': '待验收',
      'status.accepting': '验收中',
      'status.accepted': '已验收',
      'status.rejected': '验收未过',
      'status.blocked': '阻塞',
      'status.obsolete': '已作废',
      'row.quote': '用户原话',
      'row.detail': '理解与验收标准',
      'row.dispatch': '分派环节',
      'row.dispatchEmpty': '尚未派单',
      'row.execution': '执行',
      'row.test': '测试证据',
      'row.acceptance': '验收证据',
      'row.attempts': '返工时间线',
      'row.mergedFrom': '合并来源',
      'row.tags': '标签',
      'row.note': '备注',
      'row.evidence': '证据',
      'row.symptom': '现象',
      'row.cause': '根因',
      'row.fix': '修复',
      'row.round': '第 {n} 轮',
      'row.noEvidence': '暂无证据',
      'row.createdAt': '创建于 {time}',
      'row.updatedAt': '更新于 {time}',
      'row.stageRole': '职位',
      'stage.research': '调研',
      'stage.design': '设计',
      'stage.frontend': '前端',
      'stage.backend': '后端',
      'stage.test': '测试',
      'stage.acceptance': '验收',
      'stageStatus.dispatched': '已派单',
      'stageStatus.running': '进行中',
      'stageStatus.done': '已完成',
      'execution.idle': '未开始',
      'execution.running': '执行中',
      'execution.done': '已完成',
      'test.pending': '待测试',
      'test.running': '测试中',
      'test.passed': '测试通过',
      'test.failed': '测试未过',
      'acceptance.pending': '待验收',
      'acceptance.passed': '验收通过',
      'acceptance.rejected': '验收未过',
      'outcome.fixed': '已修复',
      'outcome.unfixed': '未修复',
      'outcome.partial': '部分修复',
      'badge.test': '测',
      'badge.accept': '验',
      'badge.rework': '返工 ×{n}',
      'audit.title': '审计摘要',
      'audit.undispatched': '未派单 {n}',
      'audit.untested': '未测试 {n}',
      'audit.unaccepted': '未验收 {n}',
      'audit.rework': '返工≥2 {n}',
      'audit.pendingConfirm': '待确认 {n}',
      'audit.referenceStale': '对标过期',
      'audit.ok': '台账完整',
      'audit.merged': '已并入 {n} 项',
      'tooltip.drag': '拖动移动看板',
      'tooltip.stale': '快照获取失败，正在自动重试',
      'time.justNow': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
      'time.days': '{n} 天前',
      'time.none': '—',
    };

    const en = {
      'pill.label': 'Dev board',
      'pill.expand': 'Expand development board',
      'pill.waiting': 'Waiting for Lead',
      'pill.errorRetry': 'Reconnecting…',
      'pill.total': '{n} items',
      'pill.running': '{n} active',
      'pill.accepting': '{n} to accept',
      'card.untitled': 'Untitled project',
      'card.collapse': 'Collapse board',
      'card.updated': 'updated {time}',
      'card.comparedAt': 'aligned {time}',
      'card.referenceStale': 'alignment stale',
      'card.compareOpen': '{n} gaps',
      'stats.total': 'Total',
      'stats.running': 'Active',
      'stats.accepting': 'To accept',
      'stats.rework': 'Rework≥2',
      'progress.label': 'Acceptance',
      'progress.value': '{a}/{t}',
      'filter.all': 'All',
      'filter.pending': 'To dispatch',
      'filter.running': 'Active',
      'filter.testing': 'Testing',
      'filter.accepting': 'To accept',
      'filter.accepted': 'Accepted',
      'filter.rework': 'Rework',
      'list.empty': 'No matching items',
      'status.pending': 'Pending',
      'status.dispatched': 'Dispatched',
      'status.running': 'Running',
      'status.testing': 'Testing',
      'status.tested': 'To accept',
      'status.accepting': 'Accepting',
      'status.accepted': 'Accepted',
      'status.rejected': 'Rejected',
      'status.blocked': 'Blocked',
      'status.obsolete': 'Obsolete',
      'row.quote': 'User quote',
      'row.detail': 'Understanding & acceptance',
      'row.dispatch': 'Dispatch stages',
      'row.dispatchEmpty': 'Not dispatched yet',
      'row.execution': 'Execution',
      'row.test': 'Test evidence',
      'row.acceptance': 'Acceptance evidence',
      'row.attempts': 'Rework timeline',
      'row.mergedFrom': 'Merged from',
      'row.tags': 'Tags',
      'row.note': 'Note',
      'row.evidence': 'Evidence',
      'row.symptom': 'Symptom',
      'row.cause': 'Cause',
      'row.fix': 'Fix',
      'row.round': 'Round {n}',
      'row.noEvidence': 'No evidence yet',
      'row.createdAt': 'created {time}',
      'row.updatedAt': 'updated {time}',
      'row.stageRole': 'Role',
      'stage.research': 'Research',
      'stage.design': 'Design',
      'stage.frontend': 'Frontend',
      'stage.backend': 'Backend',
      'stage.test': 'Test',
      'stage.acceptance': 'Acceptance',
      'stageStatus.dispatched': 'Dispatched',
      'stageStatus.running': 'Running',
      'stageStatus.done': 'Done',
      'execution.idle': 'Idle',
      'execution.running': 'Running',
      'execution.done': 'Done',
      'test.pending': 'Pending',
      'test.running': 'Running',
      'test.passed': 'Passed',
      'test.failed': 'Failed',
      'acceptance.pending': 'Pending',
      'acceptance.passed': 'Passed',
      'acceptance.rejected': 'Rejected',
      'outcome.fixed': 'Fixed',
      'outcome.unfixed': 'Unfixed',
      'outcome.partial': 'Partial',
      'badge.test': 'test',
      'badge.accept': 'accept',
      'badge.rework': 'rework ×{n}',
      'audit.title': 'Audit summary',
      'audit.undispatched': 'Undispatched {n}',
      'audit.untested': 'Untested {n}',
      'audit.unaccepted': 'Unaccepted {n}',
      'audit.rework': 'Rework≥2 {n}',
      'audit.pendingConfirm': 'To confirm {n}',
      'audit.referenceStale': 'Alignment stale',
      'audit.ok': 'Ledger complete',
      'audit.merged': '{n} merged',
      'tooltip.drag': 'Drag to move the board',
      'tooltip.stale': 'Snapshot failed, retrying automatically',
      'time.justNow': 'just now',
      'time.minutes': '{n}m ago',
      'time.hours': '{n}h ago',
      'time.days': '{n}d ago',
      'time.none': '—',
    };

    const runtime = {
      locale: null,
      /* 兜底翻译：locale 服务不可用 / 绑定失败时直接用中文内联字典 */
      t: (key, params) => fallbackT(key, params),
    };

    function applyTemplate(template, params) {
      if (!params) return String(template);
      return String(template).replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      ));
    }

    function fallbackT(key, params) {
      const template = Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : null;
      if (template === null) return String(key);
      return applyTemplate(template, params);
    }

    /** 任何 locale 调用都不允许抛到组件里：失败就回退中文内联字典。 */
    function safeT(key, params) {
      try {
        const value = runtime.t(key, params);
        if (typeof value === 'string' && value !== '' && value !== key) return value;
      } catch (error) {
        /* locale 服务异常 → 走兜底 */
      }
      return fallbackT(key, params);
    }

    function languageTag() {
      try {
        const locale = runtime.locale;
        const snapshot = locale && typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null;
        if (snapshot && typeof snapshot.active === 'string' && snapshot.active.indexOf('en') === 0) return 'en-US';
      } catch (error) {
        /* ignore */
      }
      return 'zh-CN';
    }

    function useLocaleRevision() {
      const [, force] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => {
        const locale = runtime.locale;
        if (!locale || typeof locale.subscribe !== 'function') return undefined;
        let alive = true;
        let unsubscribe = null;
        try {
          unsubscribe = locale.subscribe(() => { if (alive) force(); });
        } catch (error) {
          unsubscribe = null;
        }
        return () => {
          alive = false;
          if (typeof unsubscribe === 'function') {
            try { unsubscribe(); } catch (error) { /* ignore */ }
          }
        };
      }, []);
      return null;
    }

    /* ------------------------------------------------------------------ */
    /* 2. 纯工具函数（全部防御式，坏数据也不抛）                             */
    /* ------------------------------------------------------------------ */

    const asArray = (value) => (Array.isArray(value) ? value : []);
    const asString = (value) => {
      if (typeof value === 'string') return value;
      if (value === null || value === undefined) return '';
      try { return String(value); } catch (error) { return ''; }
    };
    const asNumber = (value) => (
      typeof value === 'number' && isFinite(value) ? value : null
    );
    /**
     * 时间戳：0 / 负数 / 非数字都视为「未设置」。看板里未发生的环节常写 0，
     * 直接交给 Date 会渲染成 1970/01/01，所以所有时间字段都必须先过这里。
     */
    const asTimestamp = (value) => (
      typeof value === 'number' && isFinite(value) && value > 0 ? value : null
    );
    const hasOwn = (object, key) => (
      object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key)
    );

    function formatDate(value) {
      try {
        return new Date(value).toLocaleDateString(languageTag(), { year: 'numeric', month: '2-digit', day: '2-digit' });
      } catch (error) {
        try { return new Date(value).toISOString().slice(0, 10); } catch (ignored) { return '—'; }
      }
    }

    function formatRelative(timestamp) {
      const value = asTimestamp(timestamp);
      if (value === null) return safeT('time.none');
      const diff = Date.now() - value;
      if (!isFinite(diff) || diff < 0) return safeT('time.justNow');
      const minute = 60 * 1000;
      const hour = 60 * minute;
      const day = 24 * hour;
      if (diff < minute) return safeT('time.justNow');
      if (diff < hour) return safeT('time.minutes', { n: Math.floor(diff / minute) });
      if (diff < day) return safeT('time.hours', { n: Math.floor(diff / hour) });
      if (diff < 30 * day) return safeT('time.days', { n: Math.floor(diff / day) });
      return formatDate(value);
    }

    /** 精确到分钟的钟点（执行开始时间这类「今天几点」信息用它，避免「3 分钟前」抖动）。 */
    function formatClock(timestamp) {
      const value = asTimestamp(timestamp);
      if (value === null) return '';
      try {
        return new Date(value).toLocaleTimeString(languageTag(), { hour12: false, hour: '2-digit', minute: '2-digit' });
      } catch (error) {
        try { return new Date(value).toISOString().slice(11, 16); } catch (ignored) { return ''; }
      }
    }

    function statusLabel(status) {
      const key = 'status.' + status;
      const label = safeT(key);
      return label === key ? asString(status) : label;
    }

    function stageLabel(stage) {
      const key = 'stage.' + stage;
      const label = safeT(key);
      return label === key ? asString(stage) : label;
    }

    function stageStatusLabel(status) {
      const key = 'stageStatus.' + status;
      const label = safeT(key);
      return label === key ? asString(status) : label;
    }

    function executionLabel(status) {
      const key = 'execution.' + status;
      const label = safeT(key);
      return label === key ? asString(status) : label;
    }

    function evidenceLabel(kind, status) {
      const key = kind + '.' + status;
      const label = safeT(key);
      return label === key ? asString(status) : label;
    }

    /* §3.3 状态色映射：tone 直接对应 CSS 里的 --pb-* 语义色 */
    const STATUS_TONES = {
      pending: 'pending',
      dispatched: 'dispatched',
      running: 'running',
      testing: 'testing',
      tested: 'tested',
      accepting: 'accepting',
      accepted: 'accepted',
      rejected: 'rejected',
      blocked: 'blocked',
      obsolete: 'obsolete',
    };

    /* 胶囊里的「进行中」= 已派单/执行中/测试中 */
    const IN_FLIGHT_STATUSES = { dispatched: true, running: true, testing: true };
    /* §5.2-③ 呼吸只给「正在发生」的三个状态，其余静态，避免整卡跳动 */
    const LIVE_STATUSES = { running: true, testing: true, accepting: true };

    function statusTone(status) {
      return STATUS_TONES[status] || 'idle';
    }

    function reworkOf(item) {
      const attempts = asArray(item && item.attempts);
      const rounds = attempts.length;
      let nonFixed = 0;
      let open = false;
      for (const attempt of attempts) {
        const outcome = asString(attempt && attempt.outcome);
        if (outcome !== 'fixed') nonFixed += 1;
      }
      if (rounds > 0) {
        open = asString(attempts[rounds - 1] && attempts[rounds - 1].outcome) !== 'fixed';
      }
      return { rounds, nonFixed, open };
    }

    function membersOf(item) {
      const out = [];
      const seen = Object.create(null);
      const push = (member, role) => {
        const name = asString(member);
        if (name === '' || seen[name]) return;
        seen[name] = true;
        out.push({ member: name, role: asString(role) });
      };
      try {
        const dispatch = item && item.dispatch;
        for (const stage of asArray(dispatch && dispatch.stages)) {
          push(stage && stage.member, stage && stage.role);
        }
        const execution = item && item.execution;
        if (execution) push(execution.owner, ''); // 看板里的 member 字符串自带「职位 · 昵称」，不自造职位
        const test = item && item.test;
        if (test) push(test.member, '');
        const acceptance = item && item.acceptance;
        if (acceptance) push(acceptance.member, '');
      } catch (error) {
        /* 坏数据 → 返回已收集部分 */
      }
      return out;
    }

    function countFilters(items) {
      const counts = Object.create(null);
      for (const filter of FILTERS) counts[filter.id] = 0;
      for (const item of items) {
        if (asString(item && item.status) === 'obsolete') continue;
        for (const filter of FILTERS) {
          if (matchesFilter(item, filter.id)) counts[filter.id] += 1;
        }
      }
      return counts;
    }

    function matchesFilter(item, filterId) {
      const status = asString(item && item.status);
      if (status === 'obsolete') return false; // 作废/已并入的条目只在合并来源里出现
      switch (filterId) {
        case 'pending': return status === 'pending';
        case 'running': return status === 'dispatched' || status === 'running';
        case 'testing': return status === 'testing';
        case 'accepting': return status === 'tested' || status === 'accepting';
        case 'accepted': return status === 'accepted';
        case 'rework': return reworkOf(item).rounds > 0;
        case 'all':
        default: return true;
      }
    }

    function computeStats(items) {
      const stats = {
        total: 0, pending: 0, dispatched: 0, running: 0, testing: 0,
        tested: 0, accepting: 0, accepted: 0, rejected: 0, blocked: 0,
        obsolete: 0, executing: 0, inFlight: 0, awaitingAccept: 0, reworkAny: 0, reworkOpen: 0,
      };
      for (const item of items) {
        const status = asString(item && item.status);
        if (status === 'obsolete') { stats.obsolete += 1; continue; }
        stats.total += 1;
        if (hasOwn(stats, status)) stats[status] += 1;
        if (status === 'dispatched' || status === 'running') stats.executing += 1;
        if (IN_FLIGHT_STATUSES[status]) stats.inFlight += 1;
        if (status === 'tested' || status === 'accepting') stats.awaitingAccept += 1;
        const rework = reworkOf(item);
        if (rework.rounds > 0) stats.reworkAny += 1;
        if (rework.nonFixed >= REWORK_ALERT) stats.reworkOpen += 1;
      }
      return stats;
    }

    function computeAudit(board, items) {
      const audit = {
        undispatched: [],
        untested: [],
        unaccepted: [],
        rework: [],
        pendingConfirm: [],
        referenceStale: true,
        mergedCount: 0,
      };
      for (const item of items) {
        const status = asString(item && item.status);
        if (status === 'obsolete') continue;
        const dispatchDone = !!(item && item.dispatch && item.dispatch.done === true);
        const testStatus = asString(item && item.test && item.test.status);
        const acceptanceStatus = asString(item && item.acceptance && item.acceptance.status);
        const quote = asString(item && item.userQuote);
        const note = asString(item && item.note) + '\n' + asString(item && item.detail);

        if (status === 'pending' && !dispatchDone) audit.undispatched.push(item);
        if (['dispatched', 'running', 'testing', 'rejected'].indexOf(status) !== -1 && testStatus !== 'passed') {
          audit.untested.push(item);
        }
        if (testStatus === 'passed' && acceptanceStatus !== 'passed') audit.unaccepted.push(item);
        if (reworkOf(item).nonFixed >= REWORK_ALERT) audit.rework.push(item);
        if (note.indexOf('待确认') !== -1 || (status === 'pending' && quote === '')) audit.pendingConfirm.push(item);
      }
      const reference = board && board.reference;
      const lastComparedAt = asTimestamp(reference && reference.lastComparedAt);
      audit.referenceStale = !reference || lastComparedAt === null || (Date.now() - lastComparedAt) > REF_STALE_MS;
      for (const item of items) {
        if (asString(item && item.status) === 'obsolete' && asString(item && item.mergedInto) !== '') {
          audit.mergedCount += 1;
        }
      }
      return audit;
    }

    function sortItems(items) {
      return items.slice().sort((left, right) => {
        const leftNumber = asNumber(left && left.number);
        const rightNumber = asNumber(right && right.number);
        if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
          return rightNumber - leftNumber; // 最新修改点在上：用户更关心「刚提的那条」
        }
        return asString(left && left.id).localeCompare(asString(right && right.id));
      });
    }

    function itemTitle(item) {
      const title = asString(item && item.title).trim();
      if (title !== '') return title;
      const quote = asString(item && item.userQuote).trim();
      return quote === '' ? asString(item && item.id) : quote.slice(0, 60);
    }

    function itemKey(item, index) {
      const id = asString(item && item.id);
      return id === '' ? 'pb-item-' + index : id;
    }

    function truncate(text, max) {
      const value = asString(text);
      if (value.length <= max) return value;
      return value.slice(0, max) + '…';
    }

    /* ------------------------------------------------------------------ */
    /* 3. localStorage（位置 / 展开态记忆；不可用时静默退化）                  */
    /* ------------------------------------------------------------------ */

    function readStoredJSON(key) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return null;
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (error) {
        return null;
      }
    }

    function writeStoredJSON(key, value) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return;
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch (error) {
        /* 隐私模式/配额满 → 不记忆，不影响使用 */
      }
    }

    function readStoredPos() {
      const parsed = readStoredJSON(POS_KEY);
      if (!parsed || typeof parsed !== 'object') return null;
      const left = asNumber(parsed.left);
      const top = asNumber(parsed.top);
      if (left === null || top === null) return null;
      return { left, top };
    }

    function writeStoredPos(position) {
      if (!position) return;
      writeStoredJSON(POS_KEY, { left: Math.round(position.left), top: Math.round(position.top) });
    }

    function readStoredOpen() {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return false;
        return window.localStorage.getItem(OPEN_KEY) === 'true';
      } catch (error) {
        return false;
      }
    }

    function writeStoredOpen(open) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return;
        window.localStorage.setItem(OPEN_KEY, open ? 'true' : 'false');
      } catch (error) {
        /* ignore */
      }
    }

    function viewportSize() {
      try {
        if (typeof window === 'undefined') return { width: 1280, height: 800 };
        return { width: window.innerWidth || 1280, height: window.innerHeight || 800 };
      } catch (error) {
        return { width: 1280, height: 800 };
      }
    }

    function clampPosition(left, top, width, height) {
      const viewport = viewportSize();
      const w = Math.max(0, asNumber(width) || 0);
      const ht = Math.max(0, asNumber(height) || 0);
      const maxLeft = Math.max(EDGE_MARGIN, viewport.width - w - EDGE_MARGIN);
      const maxTop = Math.max(EDGE_MARGIN, viewport.height - ht - EDGE_MARGIN);
      return {
        left: Math.min(Math.max(EDGE_MARGIN, Math.round(left)), Math.round(maxLeft)),
        top: Math.min(Math.max(EDGE_MARGIN, Math.round(top)), Math.round(maxTop)),
      };
    }

    /**
     * 默认位置：对话区（本组件所在列）左上角 + 「智能体团队」条下方。
     * 通过一个零宽锚点测量本组件所在对话列的左边界；拿不到时按视口比例兜底。
     * @param {object|null} anchor 锚点 DOM（可选）
     */
    function defaultPosition(anchor) {
      const viewport = viewportSize();
      const width = Math.min(CARD_WIDTH, Math.max(240, viewport.width - EDGE_MARGIN * 2));
      let left = Math.round(viewport.width * 0.16);
      try {
        if (anchor && typeof anchor.getBoundingClientRect === 'function') {
          const rect = anchor.getBoundingClientRect();
          if (rect && Number.isFinite(rect.left) && rect.left > 0) left = Math.round(rect.left) + EDGE_MARGIN;
        }
      } catch (error) {
        /* 测量失败用兜底值 */
      }
      return clampPosition(left, DEFAULT_TOP, width, 0);
    }

    function resolveSessionId(props) {
      try {
        if (props && typeof props.sessionId === 'string' && props.sessionId !== '') return props.sessionId;
        const session = props && props.session;
        if (session && typeof session.id === 'string' && session.id !== '') return session.id;
        if (session && typeof session.sessionId === 'string' && session.sessionId !== '') return session.sessionId;
      } catch (error) {
        /* ignore */
      }
      return null;
    }

    /**
     * 当前会话是否跑在「项目开发模式」上。
     * 只用于「看板还没数据时是否显示一个等待中的胶囊」；拿不到就按否处理。
     * @param {object} props slot props（含 useSessions 选择器 hook）
     * @param {string|null} sessionId
     * @returns {boolean}
     */
    function useIsProjectDevSession(props, sessionId) {
      try {
        const useSessions = props && props.useSessions;
        if (typeof useSessions !== 'function' || typeof sessionId !== 'string' || sessionId === '') return false;
        const preset = useSessions((state) => {
          try {
            const row = state && state.byId ? state.byId[sessionId] : undefined;
            const values = row && row.projectionValues ? row.projectionValues : undefined;
            return values ? values.agentPreset : undefined;
          } catch (error) {
            return undefined;
          }
        });
        return preset === 'project-dev';
      } catch (error) {
        return false;
      }
    }

    /* ------------------------------------------------------------------ */
    /* 4. 样式（全部 class 带 pb- 前缀；颜色优先宿主 --dsw-alias-* token）     */
    /* ------------------------------------------------------------------ */

    const CSS = `
.pb-root{
  display:contents;
  /* —— surfaces（§7.2）—— */
  --pb-bg:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay,#ffffff));
  --pb-bg-solid:var(--dsw-alias-bg-overlay,#ffffff);
  --pb-surface:var(--dsw-alias-bg-layer-1,#fcfcfb);
  --pb-surface-2:var(--dsw-alias-bg-layer-2,#fbfbf9);
  --pb-border:var(--dsw-alias-border-l1,#e8e6dc);
  --pb-border-hover:var(--dsw-alias-border-l2,#dedcd2);
  --pb-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08));
  /* —— ink —— */
  --pb-text:var(--dsw-alias-label-primary,#141413);
  --pb-text-secondary:var(--dsw-alias-label-secondary,#6e6a60);
  --pb-text-tertiary:var(--dsw-alias-label-tertiary,#8f8a7e);
  --pb-text-caption:var(--dsw-alias-label-caption,#a6a094);
  /* —— accent（§3.4：只给进度条/当前 chip/参考点/焦点环）—— */
  --pb-accent:var(--dsw-alias-brand-primary,#d97757);
  --pb-accent-hover:var(--dsw-alias-button-primary-hover,#c6613f);
  --pb-accent-soft:color-mix(in srgb,var(--pb-accent) 18%,transparent);
  --pb-accent-ink:var(--dsw-alias-label-primary,#141413);
  --pb-track:var(--dsw-alias-border-l2,#dedcd2);
  /* —— status（§3.3）—— */
  --pb-pending:var(--dsw-alias-label-tertiary,#8f8a7e);
  --pb-dispatched:#8b7ad0;
  --pb-running:#8b7ad0;
  --pb-testing:var(--dsw-alias-state-warn-primary,#a4621d);
  --pb-tested:#3d7550;
  --pb-accepting:var(--dsw-alias-state-success-primary,#3d7550);
  --pb-accepted:var(--dsw-alias-state-success-primary,#3d7550);
  --pb-rejected:var(--dsw-alias-state-error-primary,#c6613f);
  --pb-blocked:var(--dsw-alias-state-warn-primary,#a4621d);
  --pb-obsolete:var(--dsw-alias-label-caption,#a6a094);
  --pb-warning:var(--dsw-alias-state-warn-primary,#a4621d);
  --pb-danger:var(--dsw-alias-state-error-primary,#c6613f);
  --pb-success:var(--dsw-alias-state-success-primary,#3d7550);
  --pb-rework:var(--dsw-alias-state-error-primary,#c6613f);
  /* —— type（§2.1）—— */
  --pb-font-sans:var(--dsw-font-family,"Anthropic Sans Web Text","Claude Style Inter","Noto Sans SC","Source Han Sans SC",-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);
  --pb-font-serif:"Anthropic Serif Web Text","Claude Style Noto Serif","Noto Serif SC",Georgia,"Times New Roman","Songti SC",serif;
  --pb-font-mono:var(--dsw-font-mono,"Anthropic Mono Web","JetBrains Mono",ui-monospace,"SF Mono",Consolas,Menlo,monospace);
  /* —— shape —— */
  --pb-radius-card:14px;
  --pb-radius-block:10px;
  --pb-radius-chip:8px;
  --pb-radius-pill:999px;
  --pb-shadow-card:var(--dsw-shadow-lv2,0 4px 18px rgba(20,20,19,.10),0 1px 3px rgba(20,20,19,.05));
  --pb-shadow-hover:var(--dsw-shadow-lv3,0 12px 32px rgba(20,20,19,.16));
  /* —— motion（§5）—— */
  --pb-motion-enter:160ms;
  --pb-motion-exit:120ms;
  --pb-motion-expand:180ms;
  --pb-motion-feedback:120ms;
  --pb-ease-settle:cubic-bezier(.22,1,.36,1);
  --pb-ease-glide:cubic-bezier(.22,.61,.36,1);
  --pb-z:${CARD_Z};
}
/* 暗色只覆盖 claude hex 兜底；token 存在时以 token 为准（§7.2 注） */
[data-ds-dark-theme] .pb-root{
  --pb-dispatched:#9d8ce0;
  --pb-running:#9d8ce0;
  --pb-testing:var(--dsw-alias-state-warn-primary,#e2a45f);
  --pb-tested:#8cbf96;
  --pb-accepting:var(--dsw-alias-state-success-primary,#8cbf96);
  --pb-accepted:var(--dsw-alias-state-success-primary,#8cbf96);
  --pb-rejected:var(--dsw-alias-state-error-primary,#e08a6d);
  --pb-blocked:var(--dsw-alias-state-warn-primary,#e2a45f);
  --pb-obsolete:var(--dsw-alias-label-caption,#6b6a65);
  --pb-accent-hover:var(--dsw-alias-button-primary-hover,#e08a6d);
  --pb-rework:var(--dsw-alias-state-error-primary,#e08a6d);
  --pb-warning:var(--dsw-alias-state-warn-primary,#e2a45f);
  --pb-danger:var(--dsw-alias-state-error-primary,#e08a6d);
  --pb-success:var(--dsw-alias-state-success-primary,#8cbf96);
}
.pb-root,.pb-root *,.pb-root *::before,.pb-root *::after{box-sizing:border-box;}
/* 零宽锚点：测量本组件所在对话列左边界（默认位置用），不占空间不响应事件 */
.pb-anchor{display:block;width:0;height:0;overflow:hidden;pointer-events:none;vertical-align:top;}
.pb-mono{font-family:var(--pb-font-mono);font-variant-numeric:tabular-nums;letter-spacing:.01em;}
.pb-muted{color:var(--pb-text-tertiary);font-size:11px;line-height:15px;}
/* ================= 收起态：胶囊条（34px，§6.3） ================= */
/* 胶囊固定在视口坐标系里，位置与展开卡共用同一份 pos；可拖动、可记忆（用户 PB-008）。 */
.pb-dock{display:contents;}
.pb-pill{
  position:fixed;z-index:var(--pb-z);
  display:inline-flex;align-items:center;gap:7px;max-width:calc(100vw - 16px);height:34px;padding:0 12px;
  border-radius:var(--pb-radius-pill);border:1px solid var(--pb-border);background:var(--pb-surface);
  color:var(--pb-text);font-family:var(--pb-font-sans);font-size:12px;line-height:16px;font-weight:500;
  cursor:grab;touch-action:none;user-select:none;
  transition:background-color var(--pb-motion-feedback) ease,border-color var(--pb-motion-feedback) ease,color var(--pb-motion-feedback) ease;
  animation:pb-card-in var(--pb-motion-enter) var(--pb-ease-settle) both;
}
.pb-pill:active{cursor:grabbing;}
.pb-pill:hover{background:var(--pb-hover);border-color:var(--pb-border-hover);}
.pb-pill-hint{cursor:grab;}
.pb-pill-hint:hover{background:var(--pb-surface);border-color:var(--pb-border);}
.pb-pill:focus-visible{outline:2px solid var(--pb-accent);outline-offset:2px;}
.pb-pill-dot{position:relative;flex:none;width:7px;height:7px;border-radius:50%;background:var(--pb-accent);}
.pb-pill-dot[data-live=true]{animation:pb-dot-breathe 2400ms ease-in-out infinite;}
.pb-pill-label{font-weight:600;white-space:nowrap;}
.pb-pill-sep{flex:none;color:var(--pb-text-caption);font-weight:400;}
.pb-pill-stat{color:var(--pb-text-secondary);white-space:nowrap;font-variant-numeric:tabular-nums;}
.pb-pill-chevron{flex:none;display:inline-flex;color:var(--pb-text-tertiary);margin-left:1px;}

/* ================= 展开态：420px 悬浮卡（§6.1） ================= */
.pb-card{
  position:fixed;z-index:var(--pb-z);display:flex;flex-direction:column;
  width:${CARD_WIDTH}px;max-width:calc(100vw - 24px);max-height:72vh;
  background:var(--pb-bg);border:1px solid var(--pb-border);border-radius:var(--pb-radius-card);
  box-shadow:var(--pb-shadow-card);color:var(--pb-text);font-family:var(--pb-font-sans);
  font-size:12px;line-height:17px;letter-spacing:.01em;overflow:hidden;
  backdrop-filter:var(--dsw-menu-backdrop-filter,blur(16px) saturate(1.4));
  animation:pb-card-in var(--pb-motion-enter) var(--pb-ease-settle) both;
}
@supports not (backdrop-filter:blur(1px)){
  .pb-card{background:var(--pb-bg-solid);}
}
.pb-card[data-pb-dragging]{transition:none;user-select:none;cursor:grabbing;box-shadow:var(--pb-shadow-hover);}

/* header 40px 可拖拽（§6.2） */
.pb-card-head{
  flex:none;display:flex;align-items:center;gap:8px;min-height:40px;padding:7px 12px 7px 10px;
  border-bottom:1px solid var(--pb-border);cursor:grab;user-select:none;touch-action:none;
}
.pb-card-head:active{cursor:grabbing;}
.pb-card-head:focus-visible{outline:2px solid var(--pb-accent);outline-offset:-2px;}
.pb-grip{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:20px;color:var(--pb-text-caption);}
.pb-head-main{flex:1 1 auto;min-width:0;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}
.pb-project{
  flex:0 1 auto;min-width:0;margin:0;font-family:var(--pb-font-serif);font-size:15px;line-height:20px;
  font-weight:600;letter-spacing:0;color:var(--pb-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.pb-stale-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--pb-warning);animation:pb-dot-breathe 2400ms ease-in-out infinite;}
.pb-head-meta{
  display:inline-flex;align-items:baseline;gap:6px;min-width:0;flex:0 1 auto;
  font-size:11px;line-height:15px;color:var(--pb-text-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.pb-icon-btn{
  flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;
  border:0;border-radius:6px;background:transparent;color:var(--pb-text-tertiary);cursor:pointer;
  transition:background-color var(--pb-motion-feedback) ease,color var(--pb-motion-feedback) ease;
}
.pb-icon-btn:hover{background:var(--pb-hover);color:var(--pb-text);}
.pb-icon-btn:focus-visible{outline:2px solid var(--pb-accent);outline-offset:2px;}

/* 参考方案条 32px：只在 reference 非空时出现（§6.2） */
.pb-reference{
  flex:none;display:flex;align-items:center;gap:6px;min-height:32px;padding:6px 14px;
  border-bottom:1px solid var(--pb-border);font-size:11px;line-height:15px;color:var(--pb-text-secondary);
}
.pb-ref-glyph{flex:none;color:var(--pb-accent);font-size:11px;line-height:1;}
.pb-ref-name{font-weight:600;color:var(--pb-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px;}
.pb-ref-version{flex:none;font-family:var(--pb-font-mono);font-size:11px;color:var(--pb-text-tertiary);}
.pb-ref-sep{flex:none;color:var(--pb-text-caption);}
.pb-ref-state{flex:none;color:var(--pb-text-tertiary);white-space:nowrap;}
.pb-reference[data-pb-stale] .pb-ref-state{color:var(--pb-warning);}
.pb-ref-gap{flex:none;margin-left:auto;color:var(--pb-text-tertiary);white-space:nowrap;}

/* 统计条 + 4px 进度条（§6.2） */
.pb-stats{flex:none;display:grid;grid-template-columns:repeat(4,1fr);gap:4px 10px;padding:8px 14px 9px;border-bottom:1px solid var(--pb-border);}
.pb-stat{display:flex;flex-direction:column;gap:0;min-width:0;}
.pb-stat-num{font-family:var(--pb-font-serif);font-size:20px;line-height:24px;font-weight:600;color:var(--pb-text);font-variant-numeric:tabular-nums;}
.pb-stat-label{font-size:11px;line-height:14px;color:var(--pb-text-tertiary);letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pb-progress{grid-column:1/-1;display:flex;flex-direction:column;gap:2px;margin-top:0;}
.pb-progress-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:10.5px;line-height:14px;}
.pb-progress-label{color:var(--pb-text-tertiary);}
.pb-progress-value{font-family:var(--pb-font-mono);color:var(--pb-text-secondary);font-variant-numeric:tabular-nums;}
.pb-progress-track{position:relative;height:4px;border-radius:var(--pb-radius-pill);background:var(--pb-track);overflow:hidden;}
.pb-progress-fill{
  position:absolute;left:0;top:0;bottom:0;border-radius:inherit;overflow:hidden;
  background:linear-gradient(90deg,var(--pb-accent),var(--pb-accent-hover));
  transition:width 240ms var(--pb-ease-glide);
}
.pb-progress-sheen{
  position:absolute;inset:0;transform:translateX(-100%);
  background:linear-gradient(100deg,transparent 20%,color-mix(in srgb,#faf9f5 55%,transparent) 50%,transparent 80%);
  animation:pb-shimmer 1500ms linear infinite;
}

/* 筛选 chips（28px，§6.2/§5.2-⑥） */
.pb-chips{flex:none;display:flex;flex-wrap:wrap;gap:6px;padding:8px 14px;border-bottom:1px solid var(--pb-border);}
.pb-chip{
  display:inline-flex;align-items:center;gap:5px;height:28px;padding:3px 9px;
  border-radius:var(--pb-radius-pill);border:1px solid var(--pb-border);background:var(--pb-surface-2);
  color:var(--pb-text-secondary);font-family:var(--pb-font-sans);font-size:11px;line-height:15px;font-weight:500;
  cursor:pointer;transition:background-color 120ms ease,color 120ms ease,border-color 120ms ease;
}
.pb-chip:hover{background:var(--pb-hover);color:var(--pb-text);}
.pb-chip[data-active=true]{color:var(--pb-accent-ink);background:var(--pb-accent-soft);border-color:var(--pb-accent);}
.pb-chip:focus-visible{outline:2px solid var(--pb-accent);outline-offset:2px;}
.pb-chip-count{font-family:var(--pb-font-mono);font-size:10px;line-height:14px;color:var(--pb-text-tertiary);}
.pb-chip[data-active=true] .pb-chip-count{color:var(--pb-accent-ink);}

/* ================= 条目列表（独立滚动；行 min-height 44px） ================= */
.pb-list{
  flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:4px 6px;
  scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:var(--pb-border) transparent;
}
.pb-list::-webkit-scrollbar{width:8px;}
.pb-list::-webkit-scrollbar-thumb{background:var(--pb-border-hover);border-radius:999px;}
.pb-list::-webkit-scrollbar-track{background:transparent;}
.pb-list-empty{padding:22px 14px;text-align:center;color:var(--pb-text-tertiary);font-size:12px;line-height:17px;}
.pb-item{
  border-radius:var(--pb-radius-block);border:1px solid transparent;border-left-width:2px;
  transition:transform var(--pb-motion-feedback) ease,border-color var(--pb-motion-feedback) ease,
    background-color var(--pb-motion-feedback) ease,box-shadow var(--pb-motion-feedback) ease;
}
.pb-item:hover{background:var(--pb-hover);border-color:var(--pb-border-hover);transform:translateY(-1px);box-shadow:var(--dsw-shadow-lv1,0 1px 2px rgba(20,20,19,.06));}
.pb-item[data-status=rejected]{border-left-color:var(--pb-rejected);}
.pb-item[data-open]{background:var(--pb-surface);border-color:var(--pb-border-hover);}
.pb-row{
  display:flex;align-items:flex-start;gap:8px;width:100%;min-height:44px;margin:0;padding:8px 10px;
  border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:var(--pb-radius-block);
}
.pb-row:focus-visible{outline:2px solid var(--pb-accent);outline-offset:-2px;}
.pb-row>.pb-dot{margin-top:4px;}
.pb-row-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;}
.pb-row-top{display:flex;align-items:baseline;gap:6px;min-width:0;}
.pb-id{flex:none;font-family:var(--pb-font-mono);font-size:11px;line-height:15px;font-weight:500;color:var(--pb-text-tertiary);}
.pb-row-title{
  flex:1 1 auto;min-width:0;font-size:13px;line-height:18px;font-weight:500;color:var(--pb-text);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
}
.pb-prio{
  flex:none;font-family:var(--pb-font-mono);font-size:10.5px;line-height:14px;font-weight:600;
  padding:1px 6px;border-radius:var(--pb-radius-pill);border:1px solid var(--pb-border-hover);
  color:var(--pb-text-secondary);background:var(--pb-surface-2);
}
.pb-row-meta{display:flex;align-items:center;gap:6px;min-width:0;font-size:11px;line-height:15px;color:var(--pb-text-secondary);overflow:hidden;white-space:nowrap;}
.pb-row-status{flex:none;color:var(--pb-text-secondary);}
.pb-dot-sep{flex:none;color:var(--pb-text-caption);}
.pb-members{display:inline-flex;align-items:center;gap:4px;min-width:0;overflow:hidden;}
.pb-member{
  display:inline-block;max-width:128px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  padding:1px 6px;border-radius:var(--pb-radius-pill);border:1px solid var(--pb-border);
  background:var(--pb-surface-2);color:var(--pb-text-secondary);font-size:10.5px;line-height:16px;
}
.pb-member-more{color:var(--pb-text-tertiary);background:transparent;border-color:transparent;padding:1px 2px;}
.pb-badges{flex:none;display:flex;align-items:center;gap:4px;padding-top:2px;}
.pb-badge{
  display:inline-flex;align-items:center;gap:3px;height:18px;padding:1px 6px;border-radius:var(--pb-radius-pill);
  font-family:var(--pb-font-sans);font-size:10.5px;line-height:14px;font-weight:600;white-space:nowrap;
  border:1px solid var(--pb-border-hover);color:var(--pb-text-secondary);background:var(--pb-surface-2);
}
.pb-badge[data-tone=ok]{color:var(--pb-accepted);border-color:var(--pb-accepted);}
.pb-badge[data-tone=warn]{color:var(--pb-warning);border-color:var(--pb-warning);}
.pb-badge[data-tone=bad]{color:color-mix(in srgb,var(--pb-rejected) 78%,var(--pb-text));border-color:var(--pb-rejected);}
.pb-badge[data-tone=rework]{color:color-mix(in srgb,var(--pb-rework) 78%,var(--pb-text));border-color:var(--pb-rework);background:color-mix(in srgb,var(--pb-rework) 14%,transparent);}
.pb-row-caret{flex:none;display:inline-flex;color:var(--pb-text-tertiary);}

/* 状态点（7px；呼吸只给 running/testing/accepting） */
.pb-dot{position:relative;flex:none;display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--pb-pending);}
.pb-dot[data-tone=pending]{background:var(--pb-pending);}
.pb-dot[data-tone=dispatched]{background:var(--pb-dispatched);}
.pb-dot[data-tone=running]{background:var(--pb-running);}
.pb-dot[data-tone=testing]{background:var(--pb-testing);}
.pb-dot[data-tone=tested]{background:var(--pb-tested);}
.pb-dot[data-tone=accepting]{background:var(--pb-accepting);}
.pb-dot[data-tone=accepted]{background:var(--pb-accepted);}
.pb-dot[data-tone=rejected]{background:var(--pb-rejected);}
.pb-dot[data-tone=blocked]{background:transparent;border:1.5px solid var(--pb-blocked);}
.pb-dot[data-tone=obsolete]{background:var(--pb-obsolete);}
.pb-dot[data-live=true]{animation:pb-dot-breathe 2400ms ease-in-out infinite;}

/* ================= 条目展开：180ms 高度过渡（§5.2-⑤） ================= */
.pb-detail-wrap{display:grid;grid-template-rows:0fr;transition:grid-template-rows var(--pb-motion-expand) ease-out;}
.pb-item[data-open] .pb-detail-wrap{grid-template-rows:1fr;}
.pb-detail-inner{min-height:0;overflow:hidden;}
.pb-detail{
  display:flex;flex-direction:column;gap:12px;margin:0 6px 8px;padding:10px 4px 2px;
  border-top:1px solid var(--pb-border);opacity:0;
  transition:opacity 150ms ease-out;
}
.pb-item[data-open] .pb-detail{opacity:1;}
.pb-section{display:flex;flex-direction:column;gap:5px;min-width:0;}
.pb-section-h{
  font-size:11px;line-height:14px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
  color:var(--pb-text-tertiary);
}
.pb-quote{
  margin:0;padding:8px 10px;border-left:2px solid var(--pb-accent);background:var(--pb-surface);
  border-radius:0 var(--pb-radius-chip) var(--pb-radius-chip) 0;color:var(--pb-text);
  font-size:12px;line-height:17px;letter-spacing:.01em;white-space:pre-wrap;word-break:break-word;
}
.pb-text{font-size:12px;line-height:17px;color:var(--pb-text-secondary);letter-spacing:.01em;white-space:pre-wrap;word-break:break-word;}
.pb-kv{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;line-height:15px;color:var(--pb-text-secondary);}
.pb-kv-key{color:var(--pb-text-tertiary);}
.pb-timeline{display:flex;flex-direction:column;gap:6px;}
.pb-stage{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:var(--pb-radius-block);background:var(--pb-surface);border:1px solid var(--pb-border);}
.pb-stage-h{display:flex;align-items:center;gap:6px;font-size:12px;line-height:17px;color:var(--pb-text-secondary);min-width:0;}
.pb-stage-name{font-weight:600;color:var(--pb-text);flex:none;}
.pb-stage-member{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pb-stage-meta{display:flex;flex-wrap:wrap;gap:2px 10px;font-size:11px;line-height:15px;color:var(--pb-text-tertiary);}
.pb-evidence{display:flex;flex-direction:column;gap:5px;padding:7px 9px;border-radius:var(--pb-radius-chip);background:var(--pb-surface-2);border:1px solid var(--pb-border);}
.pb-evidence-h{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:11px;line-height:15px;color:var(--pb-text-tertiary);}
.pb-evidence-text{
  font-family:var(--pb-font-mono);font-size:11px;line-height:16px;color:var(--pb-text-secondary);
  white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto;
  background:var(--pb-surface);border-radius:6px;padding:6px 8px;
}
.pb-attempts{display:flex;flex-direction:column;gap:6px;}
.pb-attempt{padding:7px 9px;border-radius:var(--pb-radius-block);background:var(--pb-surface);border:1px solid var(--pb-border);}
.pb-attempt[data-tone=ok]{border-left:2px solid var(--pb-accepted);}
.pb-attempt[data-tone=warn]{border-left:2px solid var(--pb-warning);}
.pb-attempt[data-tone=bad]{border-left:2px solid var(--pb-rejected);}
.pb-attempt-h{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:11px;line-height:15px;color:var(--pb-text-tertiary);}
.pb-attempt-round{font-family:var(--pb-font-mono);font-size:11px;color:var(--pb-text-secondary);}
.pb-attempt-fields{display:flex;flex-direction:column;gap:2px;margin-top:4px;font-size:12px;line-height:17px;color:var(--pb-text-secondary);}
.pb-merged,.pb-tags{display:flex;flex-wrap:wrap;gap:5px;}
.pb-chiplet{
  font-family:var(--pb-font-mono);font-size:11px;line-height:16px;padding:1px 6px;
  border-radius:var(--pb-radius-pill);background:var(--pb-surface-2);border:1px solid var(--pb-border);
  color:var(--pb-text-secondary);white-space:nowrap;
}
.pb-detail-foot{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:10.5px;line-height:14px;color:var(--pb-text-caption);}

/* ================= footer 审计条（§6.2） ================= */
.pb-footer{flex:none;display:flex;flex-direction:column;gap:3px;padding:7px 14px 8px;border-top:1px solid var(--pb-border);background:var(--pb-surface-2);}
.pb-audit{display:flex;flex-wrap:wrap;gap:2px 10px;font-size:11px;line-height:15px;color:var(--pb-text-secondary);}
.pb-audit-item[data-tone=warn]{color:var(--pb-warning);}
.pb-audit-item[data-tone=ok]{color:var(--pb-text-tertiary);}
.pb-footer-meta{display:flex;flex-wrap:wrap;gap:2px 10px;font-size:10.5px;line-height:14px;color:var(--pb-text-caption);}

/* ================= 动效（§5.2 七个效果） ================= */
@keyframes pb-card-in{
  from{opacity:0;transform:translateY(8px) scale(.98);}
  to{opacity:1;transform:translateY(0) scale(1);}
}
@keyframes pb-dot-breathe{
  0%,100%{opacity:1;transform:scale(1);}
  50%{opacity:.45;transform:scale(.82);}
}
@keyframes pb-shimmer{to{transform:translateX(100%);}}

@media (max-width:480px){
  .pb-card{right:12px;width:calc(100vw - 24px);max-height:78vh;}
  .pb-project{font-size:14px;}
}
@media (prefers-reduced-motion:reduce){
  /* 只关动效：颜色/描边/状态点的静态色、进度条宽度（inline style）全部保留 */
  .pb-root *,.pb-root *::before,.pb-root *::after{animation:none !important;transition-duration:.01ms !important;}
  .pb-item:hover{transform:none;}
}
`;

    function installStyles(ctx) {
      if (typeof document === 'undefined' || !document.createElement) return;
      try {
        ctx.effect(() => {
          let style = null;
          try {
            style = document.createElement('style');
            style.setAttribute('data-plugin-css', 'dsh-project-dev');
            style.textContent = CSS;
            if (document.head && document.head.appendChild) document.head.appendChild(style);
          } catch (error) {
            style = null;
          }
          return () => {
            try {
              if (style && style.parentNode) style.parentNode.removeChild(style);
            } catch (error) {
              /* 已被移除 */
            }
          };
        }, 'dsh-project-dev: client styles');
      } catch (error) {
        /* 无法注册 effect 时不注入样式，避免卸载残留 */
      }
    }

    function bindLocale(ctx) {
      let locale = null;
      try {
        locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : (ctx && ctx.locale);
      } catch (error) {
        locale = null;
      }
      if (!locale || typeof locale.register !== 'function') return;
      runtime.locale = locale;
      try {
        ctx.effect(() => {
          let dispose = null;
          try {
            // 新契约：register(namespace, { zh, en }) → disposer
            dispose = locale.register(NS, { zh, en });
          } catch (error) {
            // 旧契约：register(namespace, language, dict) → disposer
            dispose = null;
            try {
              const disposeZh = locale.register(NS, 'zh', zh);
              const disposeEn = locale.register(NS, 'en', en);
              dispose = () => {
                try { if (typeof disposeEn === 'function') disposeEn(); } catch (ignored) { /* ignore */ }
                try { if (typeof disposeZh === 'function') disposeZh(); } catch (ignored) { /* ignore */ }
              };
            } catch (error2) {
              dispose = null;
            }
          }
          return () => {
            try { if (typeof dispose === 'function') dispose(); } catch (error) { /* ignore */ }
          };
        }, 'dsh-project-dev: locale dictionaries');
      } catch (error) {
        /* ignore */
      }
      try {
        const bound = locale.bind(NS);
        if (typeof bound === 'function') runtime.t = bound;
      } catch (error) {
        /* 保留中文兜底 */
      }
    }

    /* ------------------------------------------------------------------ */
    /* 5. 数据轮询（2s；页面隐藏/卸载停止；失败指数退避到 10s）               */
    /* ------------------------------------------------------------------ */

    function useBoardSnapshot(sessionId) {
      const [snapshot, setSnapshot] = React.useState({
        status: 'idle', board: null, session: null, serverTime: 0, error: null, updatedAt: 0,
      });

      React.useEffect(() => {
        const idleState = {
          status: 'idle', board: null, session: null, serverTime: 0, error: null, updatedAt: 0,
        };
        if (typeof sessionId !== 'string' || sessionId === '') {
          setSnapshot((previous) => (previous.status === 'idle' ? previous : idleState));
          return undefined;
        }

        let alive = true;
        let timer = null;
        let controller = null;
        let failureCount = 0;
        let lastText = null;

        const clearTimer = () => {
          if (timer !== null) {
            try { clearTimeout(timer); } catch (error) { /* ignore */ }
            timer = null;
          }
        };

        const backoffDelay = (attempt) => Math.min(
          MAX_BACKOFF_MS,
          POLL_MS * Math.pow(2, Math.max(0, attempt - 1)),
        );

        const schedule = (delay) => {
          clearTimer();
          if (!alive) return;
          try {
            timer = setTimeout(run, delay);
          } catch (error) {
            timer = null;
          }
        };

        const visible = () => {
          try {
            return typeof document === 'undefined' || document.visibilityState !== 'hidden';
          } catch (error) {
            return true;
          }
        };

        const fail = (reason) => {
          if (!alive) return;
          failureCount += 1;
          setSnapshot((previous) => ({
            status: previous.board ? 'stale' : 'error',
            board: previous.board || null,
            session: previous.session || null,
            serverTime: previous.serverTime || 0,
            error: reason,
            updatedAt: previous.updatedAt || 0,
          }));
          schedule(backoffDelay(failureCount));
        };

        async function run() {
          if (!alive) return;
          if (!visible()) {
            // 页面隐藏：不轮询，等 visibilitychange 恢复
            timer = null;
            return;
          }
          clearTimer();
          let localController = null;
          try {
            localController = typeof AbortController === 'function' ? new AbortController() : null;
          } catch (error) {
            localController = null;
          }
          controller = localController;
          try {
            const url = SNAPSHOT_PATH + '?sessionId=' + encodeURIComponent(sessionId);
            const options = { credentials: 'same-origin', headers: { accept: 'application/json' } };
            if (localController) options.signal = localController.signal;
            const response = await fetch(url, options);
            if (!alive) return;
            let text = '';
            try { text = await response.text(); } catch (error) { text = ''; }
            if (!alive) return;
            let payload = null;
            if (text !== '') {
              try { payload = JSON.parse(text); } catch (error) { payload = null; }
            }
            if (!response || response.ok !== true || !payload || payload.ok !== true) {
              const reason = payload && payload.error
                ? String(payload.error)
                : 'http-' + (response && response.status !== undefined ? response.status : 'error');
              fail(reason);
              return;
            }
            failureCount = 0;
            const board = payload.board && typeof payload.board === 'object' ? payload.board : null;
            const session = payload.session && typeof payload.session === 'object' ? payload.session : null;
            const serverTime = asNumber(payload.serverTime);
            if (text !== lastText) {
              lastText = text;
              setSnapshot({
                status: 'ready',
                board,
                session,
                serverTime: serverTime || 0,
                error: null,
                updatedAt: Date.now(),
              });
            }
            schedule(POLL_MS);
          } catch (error) {
            if (!alive) return;
            if (error && (error.name === 'AbortError' || error.code === 20)) return;
            fail(error && error.message ? truncate(String(error.message), 80) : 'network');
          } finally {
            if (controller === localController) controller = null;
          }
        }

        const onVisibilityChange = () => {
          try {
            if (!alive) return;
            if (document.visibilityState === 'hidden') {
              clearTimer();
            } else {
              clearTimer();
              run();
            }
          } catch (error) {
            /* ignore */
          }
        };

        try {
          if (typeof document !== 'undefined' && document.addEventListener) {
            document.addEventListener('visibilitychange', onVisibilityChange);
          }
        } catch (error) {
          /* ignore */
        }
        run();

        return () => {
          alive = false;
          clearTimer();
          try { if (controller) controller.abort(); } catch (error) { /* ignore */ }
          controller = null;
          try {
            if (typeof document !== 'undefined' && document.removeEventListener) {
              document.removeEventListener('visibilitychange', onVisibilityChange);
            }
          } catch (error) {
            /* ignore */
          }
        };
      }, [sessionId]);

      return snapshot;
    }

    /* ------------------------------------------------------------------ */
    /* 6. 原子组件                                                          */
    /* ------------------------------------------------------------------ */

    function ChevronIcon(props) {
      const direction = props && props.direction;
      const path = direction === 'up'
        ? 'M3.5 10.5 8 6l4.5 4.5'
        : direction === 'right'
          ? 'M6 3.5 10.5 8 6 12.5'
          : 'M3.5 5.5 8 10l4.5-4.5';
      return h('svg', {
        viewBox: '0 0 16 16',
        width: (props && props.size) || 14,
        height: (props && props.size) || 14,
        'aria-hidden': true,
        focusable: 'false',
        className: (props && props.className) || 'pb-icon',
      }, h('path', {
        d: path,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }));
    }

    function GripIcon() {
      const dots = [];
      for (let row = 0; row < 3; row += 1) {
        for (let column = 0; column < 2; column += 1) {
          dots.push(h('circle', {
            key: 'g' + row + '-' + column,
            cx: 3 + column * 4,
            cy: 4 + row * 4,
            r: 1.1,
            fill: 'currentColor',
          }));
        }
      }
      return h('svg', {
        viewBox: '0 0 10 16',
        width: 10,
        height: 16,
        'aria-hidden': true,
        focusable: 'false',
      }, dots);
    }

    function StatusDot(props) {
      const status = asString(props && props.status);
      const tone = statusTone(status);
      const live = LIVE_STATUSES[status] === true;
      return h('span', {
        className: 'pb-dot',
        'data-tone': tone,
        'data-live': live ? 'true' : undefined,
        'aria-hidden': true,
      });
    }

    function Badge(props) {
      const tone = props && props.tone;
      return h('span', {
        className: 'pb-badge',
        'data-tone': tone || undefined,
        title: props && props.title ? String(props.title) : undefined,
      }, props && props.children);
    }

    function MemberChips(props) {
      const members = asArray(props && props.members);
      if (members.length === 0) return null;
      const limit = typeof (props && props.limit) === 'number' ? props.limit : 2;
      const shown = members.slice(0, limit);
      const rest = members.length - shown.length;
      return h('span', { className: 'pb-members' },
        shown.map((member, index) => h('span', {
          key: 'member-' + index,
          className: 'pb-member',
          title: member.role ? member.role : undefined,
        }, member.member)),
        rest > 0 ? h('span', { className: 'pb-member pb-member-more' }, '+' + rest) : null);
    }

    function EvidenceBlock(props) {
      const kind = props && props.kind === 'acceptance' ? 'acceptance' : 'test';
      const data = props && props.data;
      const status = asString(data && data.status) || 'pending';
      const member = asString(data && data.member);
      const evidence = asString(data && data.evidence);
      const at = asTimestamp(data && data.at);
      const tone = status === 'passed' ? 'accepted' : status === 'failed' || status === 'rejected' ? 'rejected' : 'running';
      return h('div', { className: 'pb-evidence' },
        h('div', { className: 'pb-evidence-h' },
          h('span', { className: 'pb-dot', 'data-tone': tone, 'aria-hidden': true }),
          h('span', null, evidenceLabel(kind, status)),
          evidence === '' ? h('span', { className: 'pb-muted' }, '· ' + safeT('row.noEvidence')) : null,
          member ? h('span', { className: 'pb-mono', title: safeT('row.stageRole') }, member) : null,
          at !== null ? h('span', null, formatRelative(at)) : null),
        evidence !== ''
          ? h('div', { className: 'pb-evidence-text' }, evidence)
          : null);
    }

    function DetailSection(props) {
      return h('section', { className: 'pb-section' },
        h('div', { className: 'pb-section-h' }, props && props.title),
        props && props.children);
    }

    function StageRow(props) {
      const stage = props && props.stage;
      const name = asString(stage && stage.stage);
      const status = asString(stage && stage.status) || 'dispatched';
      const role = asString(stage && stage.role);
      const member = asString(stage && stage.member);
      const note = asString(stage && stage.note);
      const at = asTimestamp(stage && stage.at);
      const tone = status === 'done' ? 'accepted' : status === 'running' ? 'running' : 'pending';
      return h('div', { className: 'pb-stage' },
        h('div', { className: 'pb-stage-h' },
          h('span', { className: 'pb-dot', 'data-tone': tone, 'aria-hidden': true }),
          h('span', { className: 'pb-stage-name' }, stageLabel(name)),
          member !== '' ? h('span', { className: 'pb-stage-member' }, member) : null,
          h('span', { className: 'pb-mono', style: { color: 'var(--pb-text-tertiary)' } }, stageStatusLabel(status))),
        h('div', { className: 'pb-stage-meta' },
          role !== '' ? h('span', null, safeT('row.stageRole') + ' · ' + role) : null,
          at !== null ? h('span', null, formatRelative(at)) : null,
          note !== '' ? h('span', null, note) : null));
    }

    function AttemptRow(props) {
      const attempt = props && props.attempt;
      const index = asNumber(props && props.index) || 0;
      const round = asNumber(attempt && attempt.round);
      const outcome = asString(attempt && attempt.outcome) || 'unfixed';
      const member = asString(attempt && attempt.member);
      const role = asString(attempt && attempt.role);
      const at = asTimestamp(attempt && attempt.at);
      const tone = outcome === 'fixed' ? 'ok' : outcome === 'partial' ? 'warn' : 'bad';
      const fields = [
        ['row.symptom', asString(attempt && attempt.symptom)],
        ['row.cause', asString(attempt && attempt.cause)],
        ['row.fix', asString(attempt && attempt.fix)],
        ['row.evidence', asString(attempt && attempt.evidence)],
      ];
      return h('div', { className: 'pb-attempt', 'data-tone': tone },
        h('div', { className: 'pb-attempt-h' },
          h('span', { className: 'pb-attempt-round pb-mono' }, safeT('row.round', { n: round === null ? index + 1 : round })),
          h(Badge, { tone: tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'bad' }, safeT('outcome.' + outcome)),
          (member !== '' || role !== '') ? h('span', null, (role !== '' ? role + ' · ' : '') + member) : null,
          at !== null ? h('span', null, formatRelative(at)) : null),
        h('div', { className: 'pb-attempt-fields' },
          fields.map((pair) => (
            pair[1] !== ''
              ? h('div', { key: pair[0] }, h('span', { className: 'pb-kv-key' }, safeT(pair[0]) + '：'), pair[1])
              : null
          ))));
    }

    function ItemDetail(props) {
      const item = props && props.item;
      const quote = asString(item && item.userQuote);
      const detail = asString(item && item.detail);
      const note = asString(item && item.note);
      const stages = asArray(item && item.dispatch && item.dispatch.stages);
      const attempts = asArray(item && item.attempts);
      const mergedFrom = asArray(item && item.mergedFrom).map(asString).filter((id) => id !== '');
      const tags = asArray(item && item.tags).map(asString).filter((tag) => tag !== '');
      const execution = item && item.execution;
      const executionStatus = asString(execution && execution.status) || 'idle';
      const executionOwner = asString(execution && execution.owner);
      const executionStartedAt = asTimestamp(execution && execution.startedAt);
      const createdAt = asTimestamp(item && item.createdAt);
      const updatedAt = asTimestamp(item && item.updatedAt);
      // 「执行」一行合并展示：未派单（idle/无负责人/无开始时间）时整行省略
      const hasExecution = executionStatus !== 'idle' || executionOwner !== '' || executionStartedAt !== null;
      const executionMeta = [executionLabel(executionStatus)];
      if (executionOwner !== '') executionMeta.push(executionOwner);
      if (executionStartedAt !== null) {
        const startedClock = formatClock(executionStartedAt);
        if (startedClock !== '') executionMeta.push(startedClock);
      }

      return h('div', { className: 'pb-detail' },
        quote !== ''
          ? h(DetailSection, { title: safeT('row.quote') },
            h('blockquote', { className: 'pb-quote' }, quote))
          : null,
        detail !== ''
          ? h(DetailSection, { title: safeT('row.detail') },
            h('div', { className: 'pb-text' }, detail))
          : null,
        h(DetailSection, { title: safeT('row.dispatch') },
          stages.length > 0
            ? h('div', { className: 'pb-timeline' },
              stages.map((stage, index) => h(StageRow, { key: 'stage-' + index, stage })))
            : h('div', { className: 'pb-muted' }, safeT('row.dispatchEmpty'))),
        hasExecution
          ? h(DetailSection, { title: safeT('row.execution') },
            h('div', { className: 'pb-kv' },
              h('span', { className: 'pb-kv-key' }, safeT('row.execution') + '：'),
              h('span', null, executionMeta.join(' · '))))
          : null,
        h(DetailSection, { title: safeT('row.test') },
          h(EvidenceBlock, { kind: 'test', data: item && item.test })),
        h(DetailSection, { title: safeT('row.acceptance') },
          h(EvidenceBlock, { kind: 'acceptance', data: item && item.acceptance })),
        attempts.length > 0
          ? h(DetailSection, { title: safeT('row.attempts') },
            h('div', { className: 'pb-attempts' },
              attempts.map((attempt, index) => h(AttemptRow, { key: 'attempt-' + index, attempt, index }))))
          : null,
        mergedFrom.length > 0
          ? h(DetailSection, { title: safeT('row.mergedFrom') },
            h('div', { className: 'pb-merged' },
              mergedFrom.map((id) => h('span', { className: 'pb-chiplet', key: 'merged-' + id }, id))))
          : null,
        tags.length > 0
          ? h(DetailSection, { title: safeT('row.tags') },
            h('div', { className: 'pb-tags' },
              tags.map((tag) => h('span', { className: 'pb-chiplet', key: 'tag-' + tag }, tag))))
          : null,
        note !== ''
          ? h(DetailSection, { title: safeT('row.note') },
            h('div', { className: 'pb-text' }, note))
          : null,
        h('div', { className: 'pb-detail-foot' },
          createdAt !== null ? h('span', null, safeT('row.createdAt', { time: formatRelative(createdAt) })) : null,
          updatedAt !== null ? h('span', null, safeT('row.updatedAt', { time: formatRelative(updatedAt) })) : null));
    }

    function RowBadges(props) {
      const item = props && props.item;
      const testData = item && item.test;
      const testStatus = asString(testData && testData.status);
      const acceptanceData = item && item.acceptance;
      const acceptanceStatus = asString(acceptanceData && acceptanceData.status);
      const rework = reworkOf(item);
      const blocked = asString(item && item.status) === 'blocked';
      const nodes = [];
      const evidenceTitle = (data) => {
        const member = asString(data && data.member);
        const evidence = asString(data && data.evidence);
        return truncate([member, evidence].filter((part) => part !== '').join(' · '), 120);
      };
      if (testStatus === 'passed') {
        nodes.push(h(Badge, { key: 'test', tone: 'ok', title: evidenceTitle(testData) }, '✓' + safeT('badge.test')));
      } else if (testStatus === 'failed') {
        nodes.push(h(Badge, { key: 'test', tone: 'bad', title: evidenceTitle(testData) }, '✗' + safeT('badge.test')));
      } else if (testStatus === 'running') {
        nodes.push(h(Badge, { key: 'test', tone: 'warn', title: evidenceTitle(testData) }, '·' + safeT('badge.test')));
      }
      if (acceptanceStatus === 'passed') {
        nodes.push(h(Badge, { key: 'accept', tone: 'ok', title: evidenceTitle(acceptanceData) }, '✓' + safeT('badge.accept')));
      } else if (acceptanceStatus === 'rejected') {
        nodes.push(h(Badge, { key: 'accept', tone: 'bad', title: evidenceTitle(acceptanceData) }, '✗' + safeT('badge.accept')));
      }
      if (rework.rounds > 0) {
        nodes.push(h(Badge, {
          key: 'rework',
          tone: 'rework',
          title: safeT('badge.rework', { n: rework.rounds }),
        }, safeT('badge.rework', { n: rework.rounds })));
      }
      if (blocked) {
        nodes.push(h(Badge, { key: 'blocked', tone: 'bad' }, safeT('status.blocked')));
      }
      nodes.push(h(ChevronIcon, {
        key: 'caret',
        direction: props && props.open ? 'up' : 'down',
        className: 'pb-row-caret',
      }));
      return h('span', { className: 'pb-badges' }, nodes);
    }

    function ItemRow(props) {
      const item = props && props.item;
      const open = props && props.open === true;
      const onToggle = props && props.onToggle;
      const status = asString(item && item.status);
      const id = asString(item && item.id);
      const number = asNumber(item && item.number);
      const priority = asString(item && item.priority);
      const category = asString(item && item.category);
      const members = membersOf(item);
      const displayId = id !== '' ? id : (number !== null ? 'PB-' + number : '');
      const statusText = statusLabel(status);

      return h('div', {
        className: 'pb-item',
        'data-status': status,
        'data-open': open ? 'true' : undefined,
      },
      h('button', {
        type: 'button',
        className: 'pb-row',
        onClick: () => { if (typeof onToggle === 'function') onToggle(open ? null : id); },
        'aria-expanded': open,
        title: itemTitle(item),
      },
      h(StatusDot, { status }),
      h('span', { className: 'pb-row-main' },
        h('span', { className: 'pb-row-top' },
          displayId !== '' ? h('span', { className: 'pb-id pb-mono' }, displayId) : null,
          h('span', { className: 'pb-row-title' }, itemTitle(item)),
          priority !== '' ? h('span', { className: 'pb-prio' }, priority) : null),
        h('span', { className: 'pb-row-meta' },
          h('span', { className: 'pb-row-status' }, statusText),
          category !== '' ? h('span', { className: 'pb-dot-sep', 'aria-hidden': true }, '·') : null,
          category !== '' ? h('span', { className: 'pb-row-category' }, category) : null,
          members.length > 0 ? h('span', { className: 'pb-dot-sep', 'aria-hidden': true }, '·') : null,
          h(MemberChips, { members }))),
      h(RowBadges, { item, open })),
      h('div', { className: 'pb-detail-wrap' },
        h('div', { className: 'pb-detail-inner' },
          h(ItemDetail, { item }))));
    }

    function ItemList(props) {
      const items = asArray(props && props.items);
      const openId = props && props.openId;
      const onToggle = props && props.onToggle;
      if (items.length === 0) {
        return h('div', { className: 'pb-list-empty' }, safeT('list.empty'));
      }
      return h('div', { className: 'pb-list' },
        items.map((item, index) => h(ItemRow, {
          key: itemKey(item, index),
          item,
          open: asString(item && item.id) === asString(openId),
          onToggle,
        })));
    }

    /* 参考方案条（32px，只在 board.reference 非空时出现；§6.2） */
    function ReferenceBar(props) {
      const reference = props && props.reference;
      if (!reference || typeof reference !== 'object') return null;
      const name = asString(reference.name) || '—';
      const version = asString(reference.pinnedVersion);
      const lastComparedAt = asTimestamp(reference.lastComparedAt);
      const stale = lastComparedAt === null || (Date.now() - lastComparedAt) > REF_STALE_MS;
      const openCount = asArray(reference.comparison).filter((row) => asString(row && row.status) !== 'closed').length;
      const source = asString(reference.source);
      const titleParts = [];
      if (source !== '') titleParts.push(source);
      return h('div', {
        className: 'pb-reference',
        'data-pb-stale': stale ? 'true' : undefined,
        title: titleParts.join(' · '),
      },
      h('span', { className: 'pb-ref-glyph', 'aria-hidden': true }, '◈'),
      h('span', { className: 'pb-ref-name' }, name),
      version !== '' ? h('span', { className: 'pb-ref-version' }, '@' + version) : null,
      h('span', { className: 'pb-ref-sep', 'aria-hidden': true }, '·'),
      h('span', { className: 'pb-ref-state' }, stale
        ? safeT('card.referenceStale')
        : safeT('card.comparedAt', { time: formatRelative(lastComparedAt) })),
      openCount > 0 ? h('span', { className: 'pb-ref-gap' }, safeT('card.compareOpen', { n: openCount })) : null);
    }

    function StatsStrip(props) {
      const stats = props && props.stats;
      const total = asNumber(stats && stats.total) || 0;
      const accepted = asNumber(stats && stats.accepted) || 0;
      const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((accepted / total) * 100))) : 0;
      const cells = [
        { key: 'stats.total', value: total },
        { key: 'stats.running', value: asNumber(stats && stats.executing) || 0 },
        { key: 'stats.accepting', value: asNumber(stats && stats.awaitingAccept) || 0 },
        { key: 'stats.rework', value: asNumber(stats && stats.reworkOpen) || 0 },
      ];
      return h('div', { className: 'pb-stats' },
        cells.map((cell) => h('div', {
          key: cell.key,
          className: 'pb-stat',
        },
        h('span', { className: 'pb-stat-num' }, String(cell.value)),
        h('span', { className: 'pb-stat-label' }, safeT(cell.key)))),
        h('div', { className: 'pb-progress' },
          h('div', { className: 'pb-progress-head' },
            h('span', { className: 'pb-progress-label' }, safeT('progress.label')),
            h('span', { className: 'pb-progress-value pb-mono' }, safeT('progress.value', { a: accepted, t: total }))),
          h('div', {
            className: 'pb-progress-track',
            role: 'progressbar',
            'aria-valuemin': 0,
            'aria-valuemax': total,
            'aria-valuenow': accepted,
            'aria-label': safeT('progress.label'),
          },
          h('div', { className: 'pb-progress-fill', style: { width: percent + '%' } },
            h('span', { className: 'pb-progress-sheen', 'aria-hidden': true })))));
    }

    function FilterChips(props) {
      const activeId = asString(props && props.filterId) || 'all';
      const counts = (props && props.counts) || {};
      const onFilter = props && props.onFilter;
      return h('div', { className: 'pb-chips', role: 'group' },
        FILTERS.map((filter) => h('button', {
          key: filter.id,
          type: 'button',
          className: 'pb-chip',
          'data-active': activeId === filter.id ? 'true' : undefined,
          'aria-pressed': activeId === filter.id,
          onClick: () => { if (typeof onFilter === 'function') onFilter(filter.id); },
        },
        h('span', { className: 'pb-chip-label' }, safeT(filter.key)),
        h('span', { className: 'pb-chip-count pb-mono' }, String(asNumber(counts[filter.id]) || 0)))));
    }

    function AuditFooter(props) {
      const stats = props && props.stats;
      const audit = props && props.audit;
      const rows = [
        ['audit.undispatched', asArray(audit && audit.undispatched).length],
        ['audit.untested', asArray(audit && audit.untested).length],
        ['audit.unaccepted', asArray(audit && audit.unaccepted).length],
        ['audit.rework', asArray(audit && audit.rework).length],
        ['audit.pendingConfirm', asArray(audit && audit.pendingConfirm).length],
      ];
      const attention = rows.some((row) => row[1] > 0) || !!(audit && audit.referenceStale);
      const mergedCount = asNumber(audit && audit.mergedCount) || 0;
      return h('div', { className: 'pb-footer' },
        h('div', { className: 'pb-audit', role: 'note', 'aria-label': safeT('audit.title') },
          rows.map((row) => h('span', {
            key: row[0],
            className: 'pb-audit-item',
            'data-tone': row[1] > 0 ? 'warn' : 'ok',
          }, safeT(row[0], { n: row[1] }))),
          audit && audit.referenceStale
            ? h('span', { className: 'pb-audit-item', 'data-tone': 'warn' }, safeT('audit.referenceStale'))
            : null,
          !attention ? h('span', { className: 'pb-audit-item', 'data-tone': 'ok' }, safeT('audit.ok')) : null),
        h('div', { className: 'pb-footer-meta' },
          mergedCount > 0 ? h('span', null, safeT('audit.merged', { n: mergedCount })) : null,
          h('span', null, safeT('progress.value', { a: asNumber(stats && stats.accepted) || 0, t: asNumber(stats && stats.total) || 0 }))));
    }

    function CollapsedPill(props) {
      const stats = props && props.stats;
      const stale = !!(props && props.stale);
      const pos = (props && props.pos) || { left: 0, top: 0 };
      const drag = (props && props.drag) || {};
      const pillRef = props && props.pillRef;
      const inFlight = asNumber(stats && stats.inFlight) || 0;
      return h('div', { className: 'pb-dock' },
        h('button', {
          ref: pillRef,
          type: 'button',
          className: 'pb-pill',
          'data-pb-draggable': 'pill',
          'data-pb-stale': stale ? 'true' : undefined,
          style: { left: (asNumber(pos.left) || 0) + 'px', top: (asNumber(pos.top) || 0) + 'px' },
          onClick: drag.onClick,
          onPointerDown: drag.onPointerDown,
          onPointerMove: drag.onPointerMove,
          onPointerUp: drag.onPointerUp,
          onPointerCancel: drag.onPointerCancel,
          onKeyDown: drag.onKeyDown,
          'aria-expanded': false,
          'aria-label': safeT('pill.expand'),
          title: stale ? safeT('tooltip.stale') : safeT('pill.expand'),
        },
        h('span', { className: 'pb-grip', 'aria-hidden': true }, h(GripIcon)),
        h('span', { className: 'pb-pill-dot', 'aria-hidden': true }),
        h('span', { className: 'pb-pill-label' }, safeT('pill.label')),
        h('span', { className: 'pb-pill-sep', 'aria-hidden': true }, '·'),
        h('span', { className: 'pb-pill-stat' }, safeT('pill.total', { n: asNumber(stats && stats.total) || 0 })),
        h('span', { className: 'pb-pill-sep', 'aria-hidden': true }, '·'),
        h('span', { className: 'pb-pill-stat' }, safeT('pill.running', { n: inFlight })),
        h('span', { className: 'pb-pill-sep', 'aria-hidden': true }, '·'),
        h('span', { className: 'pb-pill-stat' }, safeT('pill.accepting', { n: asNumber(stats && stats.awaitingAccept) || 0 })),
        h('span', { className: 'pb-pill-chevron', 'aria-hidden': true }, h(ChevronIcon, { direction: 'right', size: 12 }))));
    }

    function CardHeader(props) {
      const board = props && props.board;
      const stale = !!(props && props.stale);
      const boardId = asString(board && board.boardId);
      const updatedAt = asTimestamp(board && board.updatedAt);
      const projectName = asString(board && board.projectName).trim() || safeT('card.untitled');
      const drag = (props && props.drag) || {};
      return h('div', {
        className: 'pb-card-head',
        tabIndex: 0,
        title: safeT('tooltip.drag'),
        onKeyDown: drag.onKeyDown,
        onPointerDown: drag.onPointerDown,
        onPointerMove: drag.onPointerMove,
        onPointerUp: drag.onPointerUp,
        onPointerCancel: drag.onPointerCancel,
      },
      h('span', { className: 'pb-grip', 'aria-hidden': true }, h(GripIcon)),
      h('div', { className: 'pb-head-main' },
        h('h3', { className: 'pb-project', title: projectName }, projectName),
        stale ? h('span', { className: 'pb-stale-dot', title: safeT('tooltip.stale'), 'aria-hidden': true }) : null,
        h('span', { className: 'pb-head-meta' },
          boardId !== '' ? h('span', { className: 'pb-mono', title: 'boardId: ' + boardId }, boardId) : null,
          boardId !== '' && updatedAt !== null ? h('span', { 'aria-hidden': true }, '·') : null,
          updatedAt !== null ? h('span', null, safeT('card.updated', { time: formatRelative(updatedAt) })) : null)),
      h('button', {
        type: 'button',
        className: 'pb-icon-btn',
        'data-pb-nodrag': '',
        onClick: props && props.onCollapse,
        title: safeT('card.collapse'),
        'aria-label': safeT('card.collapse'),
      }, h(ChevronIcon, { direction: 'up', size: 15 })));
    }

    function BoardCard(props) {
      const board = props && props.board;
      const stats = props && props.stats;
      const audit = props && props.audit;
      const filtered = asArray(props && props.filtered);
      const counts = props && props.counts;
      const openId = props && props.openId;
      const pos = (props && props.pos) || { left: 0, top: 0 };
      const cardRef = props && props.cardRef;
      const dragging = !!(props && props.dragging);
      const projectName = asString(board && board.projectName).trim() || safeT('card.untitled');
      const ariaLabel = projectName + ' · ' + safeT('pill.label');
      return h('div', {
        ref: cardRef,
        className: 'pb-card',
        role: 'dialog',
        'aria-label': ariaLabel,
        'data-pb-dragging': dragging ? 'true' : undefined,
        style: { left: (asNumber(pos.left) || 0) + 'px', top: (asNumber(pos.top) || 0) + 'px' },
      },
      h(CardHeader, {
        board,
        stale: !!(props && props.stale),
        onCollapse: props && props.onCollapse,
        drag: props && props.drag,
      }),
      h(ReferenceBar, { reference: board && board.reference }),
      h(StatsStrip, { stats }),
      h(FilterChips, { filterId: props && props.filterId, counts, onFilter: props && props.onFilter }),
      h(ItemList, { items: filtered, openId, onToggle: props && props.onToggleItem }),
      h(AuditFooter, { stats, audit }));
    }

    /* ------------------------------------------------------------------ */
    /* 7. ErrorBoundary：组件意外抛错时兜住，避免整个 slot entry 崩溃         */
    /* ------------------------------------------------------------------ */

    class ProjectBoardBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        try {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[dsh-project-dev] project board slot recovered from an error:', error);
          }
        } catch (ignored) {
          /* ignore */
        }
      }

      componentDidUpdate(previousProps) {
        if (this.state.failed && (!previousProps || previousProps.sessionId !== this.props.sessionId)) {
          this.setState({ failed: false });
        }
      }

      render() {
        if (this.state.failed) return null;
        return this.props && this.props.children ? this.props.children : null;
      }
    }

    /* ------------------------------------------------------------------ */
    /* 8. 主组件：dock 胶囊 ↔ 悬浮卡                                          */
    /* ------------------------------------------------------------------ */

    function ProjectBoardDock(props) {
      useLocaleRevision();
      const sessionId = resolveSessionId(props);
      const snapshot = useBoardSnapshot(sessionId);
      const board = snapshot && snapshot.board && typeof snapshot.board === 'object' ? snapshot.board : null;
      const stale = !!snapshot && snapshot.status === 'stale';
      /** 项目开发模式会话但看板还没数据/加载失败时，显示等待胶囊而不是整块消失。 */
      const isProjectDevSession = useIsProjectDevSession(props, sessionId);

      const items = React.useMemo(() => {
        try {
          return sortItems(asArray(board && board.items));
        } catch (error) {
          return [];
        }
      }, [board]);
      const stats = React.useMemo(() => {
        try { return computeStats(items); } catch (error) { return computeStats([]); }
      }, [items]);
      const audit = React.useMemo(() => {
        try { return computeAudit(board, items); } catch (error) { return computeAudit(null, items); }
      }, [board, items]);
      const counts = React.useMemo(() => {
        try { return countFilters(items); } catch (error) { return countFilters([]); }
      }, [items]);

      const [filterId, setFilterId] = React.useState('all');
      const [openId, setOpenId] = React.useState(null);
      const [expanded, setExpanded] = React.useState(() => readStoredOpen());
      const [pos, setPos] = React.useState(() => readStoredPos());
      const [dragging, setDragging] = React.useState(false);
      /** 零宽锚点：测量本组件所在对话列左边界，供默认位置使用（PB-007）。 */
      const anchorRef = React.useRef(null);

      const cardRef = React.useRef(null);
      /** 收起态胶囊的 DOM（PB-008：胶囊也可拖动/记忆位置）。 */
      const pillRef = React.useRef(null);
      /** 拖动结束浏览器会补一次 click，用它吃掉，避免「拖一下就展开」。 */
      const suppressPillClickRef = React.useRef(false);
      const dragRef = React.useRef(null);

      const filtered = React.useMemo(() => {
        try {
          return items.filter((item) => matchesFilter(item, filterId));
        } catch (error) {
          return [];
        }
      }, [items, filterId]);

      // 切会话：清掉本地交互态（数据由轮询 hook 自己重置）
      React.useEffect(() => {
        setFilterId('all');
        setOpenId(null);
        dragRef.current = null;
        setDragging(false);
      }, [sessionId]);

      // 展开状态记忆
      React.useEffect(() => {
        writeStoredOpen(expanded);
      }, [expanded]);

      // 展开时把卡片夹回视口内（尺寸来自真实测量，避免小屏/换显示器后飘出屏幕）
      React.useLayoutEffect(() => {
        if (!expanded) return;
        try {
          const card = cardRef.current;
          if (!card || typeof card.getBoundingClientRect !== 'function') return;
          const rect = card.getBoundingClientRect();
          const base = pos || defaultPosition(anchorRef.current);
          const next = clampPosition(base.left, base.top, rect.width, rect.height);
          if (!pos || next.left !== Math.round(pos.left) || next.top !== Math.round(pos.top)) {
            setPos(next);
          }
        } catch (error) {
          /* ignore */
        }
      }, [expanded]);

      // 窗口尺寸变化 / 初次挂载：把当前形态（胶囊或卡片）夹回视口内
      React.useEffect(() => {
        const onResize = () => {
          try {
            const movable = expanded ? cardRef.current : pillRef.current;
            if (!movable || typeof movable.getBoundingClientRect !== 'function') return;
            const rect = movable.getBoundingClientRect();
            const base = pos || defaultPosition(anchorRef.current);
            const next = clampPosition(base.left, base.top, rect.width, rect.height);
            if (!pos || next.left !== Math.round(pos.left) || next.top !== Math.round(pos.top)) {
              setPos(next);
            }
          } catch (error) {
            /* ignore */
          }
        };
        try {
          window.addEventListener('resize', onResize);
          onResize();
        } catch (error) {
          return undefined;
        }
        return () => {
          try { window.removeEventListener('resize', onResize); } catch (error) { /* ignore */ }
        };
      }, [expanded, pos]);

      // Esc 收起
      React.useEffect(() => {
        if (!expanded) return undefined;
        const onKeyDown = (event) => {
          try {
            if (event && event.key === 'Escape') setExpanded(false);
          } catch (error) {
            /* ignore */
          }
        };
        try {
          window.addEventListener('keydown', onKeyDown);
        } catch (error) {
          return undefined;
        }
        return () => {
          try { window.removeEventListener('keydown', onKeyDown); } catch (error) { /* ignore */ }
        };
      }, [expanded]);

      const handleDragStart = (event) => {
        try {
          if (!event || (event.pointerType === 'mouse' && event.button !== 0)) return;
          const target = event.target;
          if (target && typeof target.closest === 'function' && target.closest('[data-pb-nodrag]')) return;
          const movable = expanded ? cardRef.current : pillRef.current;
          if (!movable || typeof movable.getBoundingClientRect !== 'function') return;
          const rect = movable.getBoundingClientRect();
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            element: movable,
            moved: false,
            last: { left: rect.left, top: rect.top },
          };
          setDragging(true);
          if (event.currentTarget && typeof event.currentTarget.setPointerCapture === 'function') {
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
          }
          if (typeof event.preventDefault === 'function') event.preventDefault();
        } catch (error) {
          /* ignore */
        }
      };

      const handleDragMove = (event) => {
        const drag = dragRef.current;
        if (!drag || !event || drag.pointerId !== event.pointerId) return;
        try {
          const movable = drag.element;
          if (!movable) return;
          const dx = event.clientX - drag.startX;
          const dy = event.clientY - drag.startY;
          if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
          drag.moved = true;
          const next = clampPosition(drag.left + dx, drag.top + dy, drag.width, drag.height);
          drag.last = next;
          movable.style.left = next.left + 'px';
          movable.style.top = next.top + 'px';
        } catch (error) {
          /* ignore */
        }
      };

      const handleDragEnd = (event) => {
        const drag = dragRef.current;
        if (!drag) return;
        dragRef.current = null;
        setDragging(false);
        try {
          if (drag.moved && drag.last) {
            setPos(drag.last);
            writeStoredPos(drag.last);
          }
        } catch (error) {
          /* ignore */
        }
        try {
          if (event && event.currentTarget && typeof event.currentTarget.releasePointerCapture === 'function') {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        } catch (error) {
          /* ignore */
        }
      };

      /** 胶囊拖动结束：拖过（移动≥3px）就只记位置，没拖动则视为点击 → 展开。 */
      const handlePillPointerUp = (event) => {
        const drag = dragRef.current;
        const moved = !!(drag && drag.moved);
        if (moved) suppressPillClickRef.current = true;
        handleDragEnd(event);
      };

      /** 胶囊点击：拖动刚结束时浏览器还会补一次 click，这里吃掉它，避免「拖一下就展开」。 */
      const handlePillClick = () => {
        try {
          if (suppressPillClickRef.current) {
            suppressPillClickRef.current = false;
            return;
          }
          if (!expanded) setExpanded(true);
        } catch (error) {
          /* ignore */
        }
      };

      /* §6.4 键盘替代：header 聚焦后 Alt + 方向键每次移动 8px */
      const handleHeaderKeyDown = (event) => {
        try {
          if (!event || event.altKey !== true) return;
          const deltas = {
            ArrowLeft: [-KEYBOARD_MOVE_STEP, 0],
            ArrowRight: [KEYBOARD_MOVE_STEP, 0],
            ArrowUp: [0, -KEYBOARD_MOVE_STEP],
            ArrowDown: [0, KEYBOARD_MOVE_STEP],
          };
          const delta = deltas[event.key];
          if (!delta) return;
          const movable = expanded ? cardRef.current : pillRef.current;
          if (!movable || typeof movable.getBoundingClientRect !== 'function') return;
          const rect = movable.getBoundingClientRect();
          const base = pos || { left: rect.left, top: rect.top };
          const next = clampPosition(base.left + delta[0], base.top + delta[1], rect.width, rect.height);
          setPos(next);
          writeStoredPos(next);
          if (typeof event.preventDefault === 'function') event.preventDefault();
        } catch (error) {
          /* ignore */
        }
      };

      const effectivePos = pos || defaultPosition(anchorRef.current);
      const floatingStyle = {
        left: (asNumber(effectivePos.left) || 0) + 'px',
        top: (asNumber(effectivePos.top) || 0) + 'px',
      };
      /** 胶囊拖动：共用同一套 handleDrag*，抬起时区分「拖」与「点」。 */
      const pillDrag = {
        onPointerDown: handleDragStart,
        onPointerMove: handleDragMove,
        onPointerUp: handlePillPointerUp,
        onPointerCancel: handlePillPointerUp,
        onKeyDown: handleHeaderKeyDown,
        onClick: handlePillClick,
      };
      const cardDrag = {
        onPointerDown: handleDragStart,
        onPointerMove: handleDragMove,
        onPointerUp: handleDragEnd,
        onPointerCancel: handleDragEnd,
        onKeyDown: handleHeaderKeyDown,
      };

      if (sessionId === null) return null;
      if (!board) {
        // 非项目开发模式会话：没有看板就完全不占空间（原行为）。
        if (!isProjectDevSession) return null;
        const hintText = snapshot && snapshot.status === 'error' ? safeT('pill.errorRetry') : safeT('pill.waiting');
        return h('div', { className: 'pb-dock', 'data-pb-plugin': 'dsh-project-dev' },
          h('div', {
            ref: pillRef,
            className: 'pb-pill pb-pill-hint',
            role: 'status',
            'aria-live': 'polite',
            title: hintText,
            style: floatingStyle,
            onPointerDown: pillDrag.onPointerDown,
            onPointerMove: pillDrag.onPointerMove,
            onPointerUp: pillDrag.onPointerUp,
            onPointerCancel: pillDrag.onPointerCancel,
          },
            h('span', { className: 'pb-pill-dot', 'data-pb-tone': 'idle' }),
            h('span', { className: 'pb-pill-label' }, safeT('pill.label')),
            h('span', { className: 'pb-pill-sep' }),
            h('span', { className: 'pb-pill-stat' }, hintText)));
      }

      return h('div', { className: 'pb-root', 'data-pb-plugin': 'dsh-project-dev' },
        h('span', { ref: anchorRef, className: 'pb-anchor', 'aria-hidden': 'true' }),
        expanded
          ? h(BoardCard, {
            board,
            stats,
            audit,
            filtered,
            counts,
            filterId,
            openId,
            pos: effectivePos,
            cardRef,
            dragging,
            stale,
            drag: cardDrag,
            onFilter: setFilterId,
            onToggleItem: setOpenId,
            onCollapse: () => setExpanded(false),
          })
          : h(CollapsedPill, {
            stats,
            stale,
            pos: effectivePos,
            pillRef,
            drag: pillDrag,
          }));
    }

    function ProjectBoardSlot(props) {
      try {
        return h(ProjectBoardBoundary, null, h(ProjectBoardDock, props));
      } catch (error) {
        return null;
      }
    }

    /* ------------------------------------------------------------------ */
    /* 9. 注册                                                              */
    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      installStyles(ctx);
      bindLocale(ctx);
      if (!ctx) return;
      let slots = null;
      try {
        slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : null);
      } catch (error) {
        slots = null;
      }
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return;
      try {
        slots.inject('conversation.input.dock', () => {
          try {
            return slots.register({
              name: 'conversation.input.dock',
              id: 'project-board',
              order: 30,
            }, ProjectBoardSlot);
          } catch (error) {
            try {
              if (typeof console !== 'undefined' && console.warn) {
                console.warn('[dsh-project-dev] conversation.input.dock registration failed:', error);
              }
            } catch (ignored) {
              /* ignore */
            }
            return () => {};
          }
        });
      } catch (error) {
        try {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[dsh-project-dev] conversation.input.dock injection failed:', error);
          }
        } catch (ignored) {
          /* ignore */
        }
      }
    }

    return {
      inject: ['slots'],
      apply,
    };
  },
});
