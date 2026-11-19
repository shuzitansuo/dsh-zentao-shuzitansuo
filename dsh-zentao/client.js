// Browser half of the ZenTao AI workbench.
// Plain JavaScript (no JSX): React comes from the module table.

window.__ModuleLoader__.load({
  id: '@local/dsh-zentao',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const { useState, useEffect, useRef, useCallback } = React;

    const PLUGIN_VERSION = 'v0.2.0';
    const HEADERS = { 'x-zentao-client': '1' };
    const LAYOUT_KEY = 'dsh-zentao-layout-v1';
    const CONTEXT_LABEL = { project: '项目', execution: '迭代', story: '需求', bug: 'BUG' };

    let seq = 0;
    const uid = (p) => (p || 'id') + '-' + Date.now().toString(36) + '-' + seq++;

    async function api(path, options) {
      const res = await fetch(path, Object.assign({ headers: HEADERS }, options));
      let data;
      try {
        data = await res.json();
      } catch (error) {
        throw new Error('接口返回异常（HTTP ' + res.status + '）');
      }
      if (!data.ok) throw new Error(data.error || '请求失败');
      return data;
    }

    // Shared "assigned to me" notification state. The sidebar entry and the
    // workbench read the same store; one 20s poll feeds both.
    const ASSIGN_TOAST_KEY = 'dsh-zentao-assign-toast-v1';
    const assignmentStore = { unread: 0, events: [], updatedAt: 0, disabled: false, loaded: false, listeners: new Set() };
    let assignmentTimer = null;

    function assignToastEnabled() {
      try {
        return localStorage.getItem(ASSIGN_TOAST_KEY) !== 'off';
      } catch (error) {
        return true;
      }
    }

    function setAssignToastEnabled(enabled) {
      try {
        localStorage.setItem(ASSIGN_TOAST_KEY, enabled ? 'on' : 'off');
      } catch (error) {
        /* ignore */
      }
    }

    function applyAssignmentSnapshot(data) {
      if (!data) return;
      assignmentStore.unread = Number(data.unread) || 0;
      assignmentStore.events = Array.isArray(data.events) ? data.events : [];
      assignmentStore.updatedAt = Number(data.updatedAt) || 0;
      assignmentStore.disabled = data.disabled === true;
      assignmentStore.loaded = true;
      for (const listener of assignmentStore.listeners) listener();
    }

    function subscribeAssignments(listener) {
      assignmentStore.listeners.add(listener);
      listener();
      return () => assignmentStore.listeners.delete(listener);
    }

    async function refreshAssignments() {
      try {
        const data = await api('/zentao/api/assignments');
        applyAssignmentSnapshot(data);
      } catch (error) {
        /* host without the endpoint yet: stay silent */
      }
    }

    function startAssignmentPolling() {
      if (assignmentTimer) return;
      refreshAssignments();
      assignmentTimer = setInterval(refreshAssignments, 20000);
    }

    async function markAssignmentsRead(ids) {
      try {
        const data = await api('/zentao/api/assignments/read', {
          method: 'POST',
          headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
          body: JSON.stringify(ids === null ? { all: true } : { ids }),
        });
        applyAssignmentSnapshot(data);
      } catch (error) {
        /* ignore: the poll will resync */
      }
    }

    async function dismissAssignments(ids) {
      const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
      if (!wanted.size) return;
      // Optimistic dismiss so the × always gives immediate feedback.
      assignmentStore.events = assignmentStore.events.filter((event) => !wanted.has(String(event.id)));
      assignmentStore.unread = assignmentStore.events.filter((event) => !event.read).length;
      for (const listener of assignmentStore.listeners) listener();
      try {
        const data = await api('/zentao/api/assignments/delete', {
          method: 'POST',
          headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
          body: JSON.stringify({ ids: Array.from(wanted) }),
        });
        applyAssignmentSnapshot(data);
      } catch (error) {
        // Older host without the delete endpoint: keep the local dismissal
        // until the next successful refresh.
        refreshAssignments();
      }
    }

    function clamp(n, min, max) {
      return Math.min(max, Math.max(min, n));
    }

    function loadTreeSort() {
      try {
        const raw = JSON.parse(localStorage.getItem('dsh-zentao-tree-sort-v1') || 'null');
        if (raw && (raw.key === 'name' || raw.key === 'status') && (raw.dir === 1 || raw.dir === -1)) return raw;
      } catch (error) {
        /* storage may be unavailable */
      }
      return { key: null, dir: 1 };
    }

    // ZenTao project status ordering used by the tree header: not started first,
    // then in progress, suspended, closed.
    function projectStatusRank(status) {
      switch (status) {
        case 'wait':
          return 0;
        case 'doing':
          return 1;
        case 'suspended':
        case 'delayed':
          return 2;
        case 'closed':
          return 3;
        default:
          return 1;
      }
    }

    function loadLayout() {
      const fallback = { leftOpen: true, rightOpen: true, leftW: 350, rightW: 420 };
      const viewport = typeof window !== 'undefined' ? window.innerWidth || 1280 : 1280;
      // Leave at least a usable dashboard/calendar column in the current viewport.
      const MIN_MIDDLE = 680;
      const budget = Math.max(560, viewport - MIN_MIDDLE);
      try {
        const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
        if (!saved) {
          return {
            leftOpen: true,
            rightOpen: true,
            leftW: Math.min(fallback.leftW, Math.max(200, budget - 380)),
            rightW: Math.min(fallback.rightW, Math.max(280, budget - 300)),
          };
        }
        let leftW = clamp(Number(saved.leftW) || fallback.leftW, 200, 560);
        let rightW = clamp(Number(saved.rightW) || fallback.rightW, 280, 640);
        if (leftW + rightW > budget) {
          const over = leftW + rightW - budget;
          rightW = Math.max(260, rightW - over);
          if (leftW + rightW > budget) leftW = Math.max(200, leftW - (leftW + rightW - budget));
        }
        return {
          leftOpen: saved.leftOpen !== false,
          rightOpen: saved.rightOpen !== false,
          leftW,
          rightW,
        };
      } catch (error) {
        return fallback;
      }
    }

    const CHAT_KEY = 'dsh-zentao-chat-v1';
    const SHOW_ACTIVE_KEY = 'dsh-zentao-show-active-v1';
    const COL_WIDTHS_KEY = 'dsh-zentao-col-widths-v1';
    const COL_ORDER_KEY = 'dsh-zentao-col-order-v1';
    const COLUMN_KEYS = ['id', 'title', 'module', 'priority', 'assignee', 'status'];
    const PINNED_KEY = 'dsh-zentao-pinned-v1';

    function loadPinned() {
      try {
        const raw = JSON.parse(localStorage.getItem(PINNED_KEY) || '[]');
        if (!Array.isArray(raw)) return [];
        return raw.filter((item) => item && item.executionId && item.executionName);
      } catch (error) {
        return [];
      }
    }

    function savePinned(items) {
      try {
        localStorage.setItem(PINNED_KEY, JSON.stringify(items));
      } catch (error) {
        /* storage unavailable */
      }
    }


    // 农历 / 二十四节气（1900–2100 通用农历数据表 + 标准节气算法）
    const LUNAR_INFO = [
      0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
      0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
      0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
      0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
      0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
      0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5d0, 0x14573, 0x052d0, 0x0a9a8, 0x0e950, 0x06aa0,
      0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
      0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b5a0, 0x195a6,
      0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
      0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0,
      0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
      0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
      0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
      0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
      0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
      0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
      0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
      0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
      0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
      0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,
      0x0d520,
    ];
    const lunarLeapMonth = (year) => LUNAR_INFO[year - 1900] & 0xf;
    const lunarLeapDays = (year) => (lunarLeapMonth(year) ? ((LUNAR_INFO[year - 1900] & 0x10000) ? 30 : 29) : 0);
    const lunarMonthDays = (year, month) => ((LUNAR_INFO[year - 1900] & (0x10000 >> month)) ? 30 : 29);
    const lunarYearDays = (year) => {
      let sum = 348;
      for (let bit = 0x8000; bit > 0x8; bit >>= 1) sum += LUNAR_INFO[year - 1900] & bit ? 1 : 0;
      return sum + lunarLeapDays(year);
    };
    const solarToLunar = (date) => {
      let offset = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(1900, 0, 31)) / 86400000);
      let year = 1900;
      let temp = 0;
      for (; year < 2101 && offset > 0; year += 1) {
        temp = lunarYearDays(year);
        offset -= temp;
      }
      if (offset < 0) {
        offset += temp;
        year -= 1;
      }
      const leap = lunarLeapMonth(year);
      let isLeap = false;
      let month = 1;
      for (; month < 13 && offset > 0; month += 1) {
        if (leap > 0 && month === leap + 1 && !isLeap) {
          month -= 1;
          isLeap = true;
          temp = lunarLeapDays(year);
        } else {
          temp = lunarMonthDays(year, month);
        }
        if (isLeap && month === leap + 1) isLeap = false;
        offset -= temp;
      }
      if (offset === 0 && leap > 0 && month === leap + 1) {
        if (isLeap) {
          isLeap = false;
        } else {
          isLeap = true;
          month -= 1;
        }
      }
      if (offset < 0) {
        offset += temp;
        month -= 1;
      }
      return { year, month, day: offset + 1, isLeap };
    };
    const SOLAR_TERMS = [
      '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至',
      '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至',
    ];
    const SOLAR_TERM_INFO = [
      0, 21208, 42467, 63836, 85337, 107014, 128867, 150921, 173149, 195551, 218072, 240693,
      263343, 285989, 308563, 331033, 353350, 375494, 397447, 419210, 440795, 462224, 483532, 504758,
    ];
    const solarTermOf = (date) => {
      const month = date.getMonth();
      for (const index of [month * 2, month * 2 + 1]) {
        const ms =
          31556925974.7 * (date.getFullYear() - 1900) +
          SOLAR_TERM_INFO[index] * 60000 +
          Date.UTC(1900, 0, 6, 2, 5);
        if (new Date(ms).getUTCDate() === date.getDate()) return SOLAR_TERMS[index];
      }
      return '';
    };
    const LUNAR_MONTH_NAMES = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
    const LUNAR_DAY_NAMES = (() => {
      const digits = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
      const names = [];
      for (let day = 1; day <= 30; day += 1) {
        if (day === 10) names.push('初十');
        else if (day === 20) names.push('二十');
        else if (day === 30) names.push('三十');
        else if (day < 10) names.push('初' + digits[day - 1]);
        else if (day < 20) names.push('十' + digits[day - 11]);
        else names.push('廿' + digits[day - 21]);
      }
      return names;
    })();
    const LUNAR_FESTIVALS = {
      '1-1': '春节',
      '1-15': '元宵节',
      '2-2': '龙抬头',
      '5-5': '端午节',
      '7-7': '七夕',
      '7-15': '中元节',
      '8-15': '中秋节',
      '9-9': '重阳节',
      '12-8': '腊八节',
      '12-23': '小年',
    };
    const lunarLabelOf = (date) => {
      const lunar = solarToLunar(date);
      if (!lunar.isLeap) {
        const festival = LUNAR_FESTIVALS[lunar.month + '-' + lunar.day];
        if (festival) return { text: festival, type: 'festival' };
      }
      // 除夕：农历腊月最后一天（次日为正月初一）
      const next = new Date(date);
      next.setDate(date.getDate() + 1);
      const nextLunar = solarToLunar(next);
      if (nextLunar.month === 1 && nextLunar.day === 1) return { text: '除夕', type: 'festival' };
      const term = solarTermOf(date);
      if (term) return { text: term, type: 'term' };
      if (lunar.day === 1) {
        return { text: (lunar.isLeap ? '闰' : '') + LUNAR_MONTH_NAMES[lunar.month - 1] + '月', type: 'lunar' };
      }
      return { text: LUNAR_DAY_NAMES[lunar.day - 1], type: 'lunar' };
    };

    // 中国法定节假日调休标记：休 = 放假，班 = 补班（2025-2026 国务院办公厅安排）
    const CN_DAY_TAGS = (() => {
      const tags = {};
      const keyOf = (date) =>
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const range = (start, end, tag) => {
        const cursor = new Date(start + 'T00:00:00');
        const stop = new Date(end + 'T00:00:00');
        while (cursor <= stop) {
          tags[keyOf(cursor)] = tag;
          cursor.setDate(cursor.getDate() + 1);
        }
      };
      const day = (date, tag) => {
        tags[date] = tag;
      };
      // 2025
      day('2025-01-01', '休');
      range('2025-01-28', '2025-02-04', '休');
      day('2025-01-26', '班');
      day('2025-02-08', '班');
      range('2025-04-04', '2025-04-06', '休');
      range('2025-05-01', '2025-05-05', '休');
      day('2025-04-27', '班');
      range('2025-05-31', '2025-06-02', '休');
      range('2025-10-01', '2025-10-08', '休');
      day('2025-09-28', '班');
      day('2025-10-11', '班');
      // 2026
      range('2026-01-01', '2026-01-03', '休');
      day('2026-01-04', '班');
      range('2026-02-15', '2026-02-23', '休');
      day('2026-02-14', '班');
      day('2026-02-28', '班');
      range('2026-04-04', '2026-04-06', '休');
      range('2026-05-01', '2026-05-05', '休');
      day('2026-05-09', '班');
      range('2026-06-19', '2026-06-21', '休');
      range('2026-09-25', '2026-09-27', '休');
      range('2026-10-01', '2026-10-07', '休');
      day('2026-09-20', '班');
      day('2026-10-10', '班');
      // 2027（国办发明电〔2026〕10号）
      range('2027-01-01', '2027-01-03', '休');
      range('2027-02-05', '2027-02-13', '休');
      day('2027-01-31', '班');
      day('2027-02-14', '班');
      range('2027-04-03', '2027-04-05', '休');
      range('2027-05-01', '2027-05-05', '休');
      day('2027-05-08', '班');
      day('2027-06-09', '休');
      day('2027-09-15', '休');
      range('2027-10-01', '2027-10-07', '休');
      day('2027-09-26', '班');
      day('2027-10-09', '班');
      return tags;
    })();

    function loadColOrder() {
      try {
        const raw = JSON.parse(localStorage.getItem(COL_ORDER_KEY) || 'null');
        if (!Array.isArray(raw) || raw.length !== COLUMN_KEYS.length) return null;
        const unique = Array.from(new Set(raw));
        if (unique.length !== COLUMN_KEYS.length) return null;
        if (!COLUMN_KEYS.every((key) => unique.indexOf(key) >= 0)) return null;
        return unique;
      } catch (error) {
        return null;
      }
    }

    function saveColOrder(order) {
      try {
        if (order) localStorage.setItem(COL_ORDER_KEY, JSON.stringify(order));
        else localStorage.removeItem(COL_ORDER_KEY);
      } catch (error) {
        /* storage unavailable */
      }
    }
    const COL_WIDTH_LIMITS = { min: 40, max: 520 };
    const COLUMN_MIN_WIDTHS = {
      'zt-col-id': 54,
      'zt-col-priority': 56,
      'zt-col-assignee': 86,
      'zt-col-state': 86,
      'zt-col-storystate': 86,
      'zt-col-deadline': 96,
      'zt-col-date': 96,
      'zt-col-owner': 96,
    };

    function loadColWidths() {
      try {
        const raw = JSON.parse(localStorage.getItem(COL_WIDTHS_KEY) || 'null');
        if (!raw || typeof raw !== 'object') return null;
        const base = ['id', 'title', 'module', 'priority', 'assignee', 'status'];
        const extra = ['storyState', 'deadline', 'owner', 'begin', 'end', 'testtaskName', 'date'];
        const minByKey = { id: 54, priority: 56, assignee: 86, status: 86, storyState: 86, deadline: 96, owner: 96, begin: 96, end: 96, date: 96 };
        const out = {};
        for (const key of base.concat(extra)) {
          const value = Number(raw[key]);
          if (Number.isFinite(value) && value > 0) {
            out[key] = clamp(value, minByKey[key] || COL_WIDTH_LIMITS.min, COL_WIDTH_LIMITS.max);
          }
        }
        // Hidden columns are absent from snapshots; the rest still persist.
        return out.id && out.title ? out : null;
      } catch (error) {
        return null;
      }
    }

    function saveColWidths(widths) {
      try {
        if (widths) localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(widths));
        else localStorage.removeItem(COL_WIDTHS_KEY);
      } catch (error) {
        /* storage unavailable */
      }
    }

    /** null = the user never chose; the default (only active) applies. */
    function readShowActiveOnly() {
      try {
        const raw = localStorage.getItem(SHOW_ACTIVE_KEY);
        if (raw === '0') return false;
        if (raw === '1') return true;
      } catch (error) {
        /* storage unavailable */
      }
      return null;
    }
    const INPUT_H_KEY = 'dsh-zentao-input-height-v1';
    const DEFAULT_INPUT_H = 96;

    function newConversation() {
      const id = 'conv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
      return { id, title: '新会话', titleEdited: false, createdAt: Date.now(), updatedAt: Date.now(), archived: false, messages: [] };
    }

    function loadChatStore() {
      try {
        const raw = JSON.parse(localStorage.getItem(CHAT_KEY) || 'null');
        if (!raw || !Array.isArray(raw.items) || raw.items.length === 0) return null;
        const items = raw.items
          .filter((c) => c && c.id && Array.isArray(c.messages))
          .map((c) => ({
            id: String(c.id),
            title: String(c.title || '新会话'),
            createdAt: Number(c.createdAt) || Date.now(),
            updatedAt: Number(c.updatedAt) || Date.now(),
            archived: c.archived === true,
            titleEdited: c.titleEdited === true,
            messages: c.messages
              .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
              .map((m, index) => ({
                id: String(m.id || 'restored-' + index),
                role: m.role,
                at: Number(m.at) || 0,
                text: String(m.text || ''),
                cards: Array.isArray(m.cards) ? m.cards : [],
              })),
          }));
        if (!items.length) return null;
        return { version: 1, activeId: String(raw.activeId || ''), items };
      } catch (error) {
        return null;
      }
    }

    function saveChatStore(items, activeId) {
      try {
        const capped = items.slice(0, 20).map((c) => Object.assign({}, c, { messages: c.messages.slice(-200) }));
        localStorage.setItem(CHAT_KEY, JSON.stringify({ version: 1, activeId, items: capped }));
      } catch (error) {
        /* storage full: keep working in memory */
      }
    }

    function makeChatBoot() {
      const stored = loadChatStore();
      const items = stored ? stored.items : [newConversation()];
      const activeId = stored && items.some((c) => c.id === stored.activeId) ? stored.activeId : items[0].id;
      const active = items.find((c) => c.id === activeId) || items[0];
      return { items, activeId, messages: Array.isArray(active.messages) ? active.messages : [] };
    }

    function conversationTitle(messages) {
      const first = (messages || []).find((m) => m.role === 'user' && m.text);
      const text = first ? String(first.text).replace(/\s+/g, ' ').trim() : '';
      if (!text) return '';
      return text.length > 22 ? text.slice(0, 22) + '…' : text;
    }

    function formatChatTime(ts) {
      const date = new Date(Number(ts) || Date.now());
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      if (date.toDateString() === now.toDateString()) return pad(date.getHours()) + ':' + pad(date.getMinutes());
      return date.getMonth() + 1 + '/' + date.getDate();
    }

    function detectChatIntent(text) {
      if (!text) return false;
      if (/(创建|新增|添加|新建).{0,6}(迭代|执行|sprint)|(迭代|执行).{0,6}(创建|新增|添加|新建)/i.test(text)) return true;
      if (/(状态|阶段|方案)/.test(text) && /(改|变|设|调|换|关|停|开|挂|激)/.test(text)) return true;
      if (/(迭代|执行|项目).*(开始|启动|关闭|关掉|挂起|暂停|激活|恢复|结束|完成|归档)|(开始|启动|关闭|关掉|挂起|暂停|激活|恢复|归档).{0,4}(迭代|执行|项目)/.test(text)) return true;
      if (/用例|测试用例/.test(text)) return true;
      if (/(状态|阶段|方案).*(改为|变更|修改|设置)|(改为|变更).*(状态|阶段|方案)/.test(text)) return false;
      if (/bug|缺陷|问题单/i.test(text) && /(录入|新建|创建|提|报)/.test(text)) return true;
      if (/(录入|新建|创建|添加|提).*(需求|story)/i.test(text) || /(需求|story).*(录入|新建|创建)/i.test(text)) return true;
      return false;
    }

    function Icon(props) {
      // TDesign "chart-bar" icon, sized by the sidebar entry.
      const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'square' };
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: props.size || 20, height: props.size || 20, 'aria-hidden': true, style: { display: 'block' } },
        h('path', Object.assign({ key: 'bars', d: 'M7 10H11V21H7V10Z M15 6H19V21H15V6Z' }, s)),
        h('path', Object.assign({ key: 'axis', d: 'M21 21H3V3' }, s)),
      );
    }

    function GlyphIcon(props) {
      // 24px grid line icons with round caps, matching the shell's icon family.
      const name = props.name;
      const size = props.size || 16;
      const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
      const paths = {
        'chevron-left': ['m15 18-6-6 6-6'],
        'chevron-right': ['m9 18 6-6-6-6'],
        'chevron-down': ['m6 9 6 6 6-6'],
        'chevron-up': ['m18 15-6-6-6 6'],
        plus: ['M12 5L12 19M19 12L5 12'],
        reset: ['M5.75 7H14C17.3137 7 20 9.68629 20 13C20 16.3137 17.3137 19 14 19L6.5 19M8 10.5L4.5 7L8 3.5'],
        refresh: ['M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8', 'M21 3v5h-5'],
        close: ['M16.9503 7.05029L12.0005 12M12.0005 12L7.05078 16.9498M12.0005 12L16.9503 16.9498M12.0005 12L7.05078 7.05029'],
        trash: ['M21 5H3M5 5H19L18.5 22H5.5L5 5ZM8.5 2H15.5V5H8.5V2Z', 'M12 9V18'],
        'arrow-up': ['M17.5 10.5L12 5L6.5 10.5M12 6.25V19.25'],
        'arrow-down': ['M17.5 13.5L12 19L6.5 13.5M12 17.75V4.75'],
        file: ['M14 2V8H20M14 2H15L20 7V8M14 2H4V22H20V8'],
        bug: ['M7 13H4M7 13V16C7 18.7614 9.23858 21 12 21C14.7614 21 17 18.7614 17 16V13M7 13V9H17V13M20 13H17M12 9V20M6.55 16.45L4 19V21M17.45 16.45L20 19V21M6.65 9.65L4 7V5M17.35 9.65L20 7V5M8 6C8 3.79086 9.79086 2 12 2C14.2091 2 16 3.79086 16 6H8Z'],
        'view-list': ['M3 5H21M3 12H21M3 19H21'],
        history: ['M2.552 13C3.0517 17.7767 7.09104 21.5 12 21.5C17.2467 21.5 21.5 17.2467 21.5 12C21.5 6.7533 17.2467 2.5 12 2.5C10.3719 2.5 8.8394 2.90957 7.5 3.63131C5.69871 4.60193 4.24661 6.13714 3.38065 8M12 7V12L14.5 14.5M2.5 3.5V8.5H7.5'],
        archive: ['M20 6.5L4 6.5M18 3L6 3M22 10V21L2 21L2 10L22 10Z'],
        bell: ['M5 8V13L3 16V19H21V16L19 13V8C19 4.13401 15.866 1 12 1C8.13401 1 5 4.13401 5 8Z', 'M8.5 19H15.5C15.5 20.933 13.933 22.5 12 22.5C10.067 22.5 8.5 20.933 8.5 19Z'],
        'new-chat': ['M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 14.6624 3.04042 17.0817 4.73686 18.8737L3 22H12Z', 'M12 8.5V15.5M8.5 12H15.5'],
        copy: ['M5 8.5H14.5C15.3 8.5 16 9.2 16 10V19C16 19.8 15.3 20.5 14.5 20.5H5C4.2 20.5 3.5 19.8 3.5 19V10C3.5 9.2 4.2 8.5 5 8.5Z', 'M9.5 4.5H18.5C19.3 4.5 20 5.2 20 6V15.5'],
        attach: ['m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48'],
        edit: ['M14.1048 6.00427L4.78744 15.3216L3.99805 20.0001L8.67652 19.2107L17.9939 9.89336L14.1048 6.00427ZM14.1048 6.00427L17.1615 2.94727L21.0506 6.83635L17.9939 9.89336'],
        bookmark: ['M6.5 3H17.5V21L12 16.5L6.5 21V3Z'],
        'fold-vertical': ['M7 3L12 8L17 3', 'M7 21L12 16L17 21'],
        'unfold-vertical': ['M7 9L12 4L17 9', 'M7 15L12 20L17 15'],
        folder: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'],
        'folder-open': ['m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2'],
        mic: ['M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3'],
        clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M12 6v6l4 2'],
        settings: [
          'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
          'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
        ],
        search: [
          'M15.8033 15.8033C12.8744 18.7322 8.12563 18.7322 5.1967 15.8033C2.26777 12.8744 2.26777 8.12563 5.1967 5.1967C8.12563 2.26777 12.8744 2.26777 15.8033 5.1967C18.7322 8.12563 18.7322 12.8744 15.8033 15.8033Z',
          'M15.8027 15.8037L21.106 21.107',
        ],
      };
      const children = (paths[name] || []).map((d, index) => h('path', Object.assign({ key: 'p' + index, d }, s)));
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } }, children);
    }

    function StatusDot(props) {
      const map = { doing: 'success', wait: 'idle', suspended: 'warn', closed: 'idle', active: 'success', resolved: 'success' };
      return h('span', { className: 'zt-dot zt-dot-' + (map[props.status] || 'idle') });
    }

    // TDesign Empty geometry: centred icon, secondary-colour title, placeholder caption.
    function EmptyState(props) {
      return h(
        'div',
        { className: 'zt-empty-state' },
        h('div', { className: 'zt-empty-image' }, h(GlyphIcon, { name: props.icon || 'file', size: 32 })),
        h('div', { className: 'zt-empty-title' }, props.title),
        props.description ? h('div', { className: 'zt-empty-description' }, props.description) : null,
      );
    }

    // TDesign tag tones for the list columns.
    function priorityTone(priority) {
      const n = Number(priority);
      if (n === 1) return 'error';
      if (n === 2) return 'warning';
      return 'default';
    }

    function shortListDate(value) {
      const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!match) return value || '';
      return match[1] === String(new Date().getFullYear()) ? match[2] + '-' + match[3] : value;
    }

    function statusTone(status) {
      const map = {
        doing: 'primary', active: 'primary', planned: 'primary', projected: 'primary',
        developing: 'primary', developed: 'primary',
        testing: 'warning', suspended: 'warning', postponed: 'warning',
        tested: 'success', verified: 'success', released: 'success',
        fixed: 'success', resolved: 'success', done: 'success',
      };
      return map[status] || 'default';
    }

    // ── Markdown renderer for assistant replies ────────────────────────────────
    // Zero-dependency, subset-of-GFM renderer: headings, bold/italic/strike,
    // inline code, fenced code, links/images, blockquotes, ul/ol (2 levels),
    // simple pipe tables, hr and paragraphs. Raw HTML is shown as text.
    function mdInline(text) {
      const source = String(text === undefined || text === null ? '' : text);
      const re = /(`[^`\n]+`)|(!?\[[^\]]*\]\([^)\s]+\))|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)/g;
      const out = [];
      let last = 0;
      let match;
      let key = 0;
      while ((match = re.exec(source))) {
        if (match.index > last) out.push(source.slice(last, match.index));
        const token = match[0];
        if (token.charAt(0) === '`') {
          out.push(h('code', { key: 'c' + key++, className: 'zt-md-code' }, token.slice(1, -1)));
        } else if (token.charAt(0) === '!' || token.charAt(0) === '[') {
          const image = token.charAt(0) === '!';
          const link = token.match(/^(!?)\[([^\]]*)\]\(([^)\s]+)\)$/);
          if (!link) {
            out.push(token);
          } else {
            const label = link[2];
            const href = link[3];
            const safe = /^(https?:|mailto:|#|\/)/i.test(href) ? href : '';
            if (!safe) {
              out.push(token);
            } else if (image) {
              out.push(h('img', { key: 'i' + key++, className: 'zt-md-image', src: safe, alt: label }));
            } else {
              out.push(
                h('a', { key: 'a' + key++, className: 'zt-md-link', href: safe, target: '_blank', rel: 'noreferrer noopener' }, mdInline(label)),
              );
            }
          }
        } else if (token.startsWith('**') || token.startsWith('__')) {
          out.push(h('strong', { key: 'b' + key++ }, mdInline(token.slice(2, -2))));
        } else if (token.startsWith('~~')) {
          out.push(h('del', { key: 'd' + key++ }, mdInline(token.slice(2, -2))));
        } else if (token.startsWith('*') || token.startsWith('_')) {
          out.push(h('em', { key: 'e' + key++ }, mdInline(token.slice(1, -1))));
        } else {
          out.push(token);
        }
        last = match.index + token.length;
      }
      if (last < source.length) out.push(source.slice(last));
      return out;
    }

    function mdTable(lines) {
      const cells = (line) =>
        line
          .replace(/^\s*\|/, '')
          .replace(/\|\s*$/, '')
          .split('|')
          .map((cell) => cell.trim());
      const aligns = cells(lines[1]).map((cell) => {
        if (/^:-+:$/.test(cell)) return 'center';
        if (/^-+:$/.test(cell)) return 'right';
        return 'left';
      });
      const head = cells(lines[0]);
      const body = lines.slice(2).map((line) => cells(line));
      return h(
        'div',
        { key: 'tbl' + lines[0].length + head.join(''), className: 'zt-md-table-wrap' },
        h(
          'table',
          { className: 'zt-md-table' },
          h('thead', null, h('tr', null, head.map((cell, index) => h('th', { key: index, style: { textAlign: aligns[index] || 'left' } }, mdInline(cell))))),
          h(
            'tbody',
            null,
            body.map((row, rowIndex) =>
              h(
                'tr',
                { key: rowIndex },
                row.map((cell, index) => h('td', { key: index, style: { textAlign: aligns[index] || 'left' } }, mdInline(cell))),
              ),
            ),
          ),
        ),
      );
    }

    function renderMarkdown(text) {
      const source = String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n');
      const lines = source.split('\n');
      const blocks = [];
      let i = 0;
      let key = 0;
      const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
      const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line) || /^\s*\|?\s*:?-{2,}:?\s*\|?\s*$/.test(line);

      while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
          i += 1;
          continue;
        }
        const fence = line.match(/^\s*```\s*([A-Za-z0-9_+-]*)\s*$/);
        if (fence) {
          const code = [];
          i += 1;
          while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
            code.push(lines[i]);
            i += 1;
          }
          i += 1;
          blocks.push(h('pre', { key: 'pre' + key++, className: 'zt-md-pre' }, h('code', null, code.join('\n'))));
          continue;
        }
        const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
        if (heading) {
          const level = Math.min(6, heading[1].length);
          blocks.push(h('h' + level, { key: 'h' + key++, className: 'zt-md-h zt-md-h' + level }, mdInline(heading[2])));
          i += 1;
          continue;
        }
        if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          blocks.push(h('hr', { key: 'hr' + key++, className: 'zt-md-hr' }));
          i += 1;
          continue;
        }
        if (/^\s{0,3}>\s?/.test(line)) {
          const quoted = [];
          while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
            quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
            i += 1;
          }
          blocks.push(h('blockquote', { key: 'q' + key++, className: 'zt-md-quote' }, renderMarkdown(quoted.join('\n'))));
          continue;
        }
        if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
          const tableLines = [line, lines[i + 1]];
          i += 2;
          while (i < lines.length && isTableRow(lines[i])) {
            tableLines.push(lines[i]);
            i += 1;
          }
          blocks.push(mdTable(tableLines));
          continue;
        }
        const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
        const ordered = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
        if (bullet || ordered) {
          const items = [];
          const pattern = ordered ? /^(\s*)\d+[.)]\s+(.*)$/ : /^(\s*)[-*+]\s+(.*)$/;
          while (i < lines.length) {
            const current = lines[i];
            const match = current.match(pattern);
            if (match) {
              items.push({ depth: Math.min(2, Math.floor(match[1].replace(/\t/g, '  ').length / 2)), text: match[2] });
              i += 1;
              continue;
            }
            if (!current.trim()) break;
            if (items.length && /^\s{2,}\S/.test(current)) {
              items[items.length - 1].text += ' ' + current.trim();
              i += 1;
              continue;
            }
            break;
          }
          const listTag = ordered ? 'ol' : 'ul';
          blocks.push(
            h(
              listTag,
              { key: 'list' + key++, className: 'zt-md-list' },
              items.map((item, index) =>
                h(
                  'li',
                  { key: index, className: 'zt-md-li', style: item.depth ? { marginLeft: item.depth * 16 + 'px' } : undefined },
                  mdInline(item.text),
                ),
              ),
            ),
          );
          continue;
        }
        const paragraph = [];
        while (i < lines.length) {
          const current = lines[i];
          if (!current.trim()) break;
          if (paragraph.length && (/^\s{0,3}(#{1,6})\s+/.test(current) || /^\s*```/.test(current) || /^(\s*)[-*+]\s+/.test(current) || /^(\s*)\d+[.)]\s+/.test(current) || /^\s{0,3}>/.test(current))) break;
          paragraph.push(current);
          i += 1;
        }
        blocks.push(h('p', { key: 'p' + key++, className: 'zt-md-p' }, paragraph.flatMap((part, index) => (index ? [h('br', { key: 'br' + index }), ...mdInline(part)] : mdInline(part)))));
      }
      return blocks;
    }

    // ── WAV recording helpers (16 kHz mono PCM16, what DSH speech expects) ──
    function mergeFloat32(chunks) {
      let total = 0;
      for (const chunk of chunks) total += chunk.length;
      const out = new Float32Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    }

    function resampleLinear(samples, fromRate, toRate) {
      if (fromRate === toRate || !samples.length) return samples;
      const ratio = fromRate / toRate;
      const length = Math.max(1, Math.round(samples.length / ratio));
      const out = new Float32Array(length);
      for (let i = 0; i < length; i += 1) {
        const pos = i * ratio;
        const index = Math.floor(pos);
        const frac = pos - index;
        const a = samples[index] || 0;
        const b = samples[index + 1] || a;
        out[i] = a + (b - a) * frac;
      }
      return out;
    }

    function encodeWavPcm16(samples, sampleRate) {
      const bytesPerSample = 2;
      const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
      const view = new DataView(buffer);
      const writeString = (offset, text) => {
        for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
      };
      writeString(0, 'RIFF');
      view.setUint32(4, 36 + samples.length * bytesPerSample, true);
      writeString(8, 'WAVE');
      writeString(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * bytesPerSample, true);
      view.setUint16(32, bytesPerSample, true);
      view.setUint16(34, 16, true);
      writeString(36, 'data');
      view.setUint32(40, samples.length * bytesPerSample, true);
      let offset = 44;
      for (let i = 0; i < samples.length; i += 1) {
        const clamped = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
        offset += 2;
      }
      return new Uint8Array(buffer);
    }

    function bytesToBase64(bytes) {
      let binary = '';
      const step = 0x8000;
      for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
      }
      return btoa(binary);
    }

    function Workbench(props) {
      const layoutSvc = props.layout;
      const isMac = (() => {
        try {
          return /Mac/i.test((navigator.platform || '') + ' ' + (navigator.userAgent || ''));
        } catch (error) {
          return false;
        }
      })();
      const [layout, setLayout] = useState(loadLayout);
      const [projects, setProjects] = useState([]);
      const [baseUrl, setBaseUrl] = useState('');
      const [treeError, setTreeError] = useState('');
      const [treeBusy, setTreeBusy] = useState(false);
      const [filter, setFilter] = useState('');
      const [openProjects, setOpenProjects] = useState({});
      const [execs, setExecs] = useState({});
      const [selection, setSelection] = useState({ projectId: 0, projectName: '', executionId: 0, executionName: '' });
      const [tab, setTab] = useState('task');
      const [me, setMe] = useState({ account: '', realname: '' });
      const [onlyMine, setOnlyMine] = useState(() => {
        try {
          return localStorage.getItem('dsh-zentao-only-mine-v1') === '1';
        } catch (error) {
          return false;
        }
      });
      const [items, setItems] = useState({ story: [], bug: [], task: [], testtask: [], report: [] });
      // 每次打开软件默认进入仪表盘；会话内可切到列表。
      const [view, setView] = useState('dashboard');
      const [teamTasks, setTeamTasks] = useState({ loading: false, error: '', tasks: [], members: [], loaded: false });
      const [teamFilters, setTeamFilters] = useState({ member: '', status: '', start: '', end: '', q: '' });
      const [teamSort, setTeamSort] = useState({ key: 'deadline', dir: 1 });
      const [teamPage, setTeamPage] = useState(1);
      const [teamPageSize, setTeamPageSize] = useState(20);
      const [teamExporting, setTeamExporting] = useState(false);
      const [teamTab, setTeamTab] = useState('open');
      const [closedFilters, setClosedFilters] = useState({ member: '', start: '', end: '', q: '' });
      const [closedSort, setClosedSort] = useState({ key: 'resolvedDate', dir: 1 });
      const [closedPage, setClosedPage] = useState(1);
      const [closedPageSize, setClosedPageSize] = useState(20);
      const closedStartPickerRef = useRef(null);
      const closedEndPickerRef = useRef(null);
      const [closedColWidths, setClosedColWidths] = useState(() => {
        try {
          const saved = JSON.parse(localStorage.getItem('dsh-zentao-team-closed-col-widths-v1') || '{}');
          if (!saved || typeof saved !== 'object') return {};
          const clean = {};
          for (const [key, value] of Object.entries(saved)) {
            if (typeof value === 'number' && value > 0 && value < 1) clean[key] = value;
          }
          return clean;
        } catch (error) {
          return {};
        }
      });
      const teamStartPickerRef = useRef(null);
      const teamEndPickerRef = useRef(null);
      const dashboardBusyRef = useRef(false);
      const dashboardSeqRef = useRef(0);
      const dashboardFreshAtRef = useRef(0);
      const teamBusyRef = useRef(false);
      const teamSeqRef = useRef(0);
      const teamFreshAtRef = useRef(0);
      const [teamColWidths, setTeamColWidths] = useState(() => {
        try {
          const saved = JSON.parse(localStorage.getItem('dsh-zentao-team-col-widths-v1') || '{}');
          if (!saved || typeof saved !== 'object') return {};
          const clean = {};
          for (const [key, value] of Object.entries(saved)) {
            if (typeof value === 'number' && value > 0 && value < 1) clean[key] = value;
          }
          return clean;
        } catch (error) {
          return {};
        }
      });
      const [pinned, setPinned] = useState(loadPinned);
      const [dashboard, setDashboard] = useState(() => {
        try {
          const cached = JSON.parse(localStorage.getItem('dsh-zentao-dashboard-v1') || 'null');
          if (cached && cached.weekStart) return { loading: false, error: '', data: cached };
        } catch (error) {
          /* ignore a broken cache */
        }
        return { loading: false, error: '', data: null };
      });
      const [calendarMonth, setCalendarMonth] = useState(() => {
        const now = new Date();
        return { year: now.getFullYear(), month: now.getMonth() + 1 };
      });
      const [calendarMode, setCalendarMode] = useState('week');
      const [showDoneTasks, setShowDoneTasks] = useState(() => {
        try {
          return localStorage.getItem('dsh-zentao-calendar-done-v1') !== '0';
        } catch (error) {
          return true;
        }
      });

      useEffect(() => {
        try {
          localStorage.setItem('dsh-zentao-calendar-done-v1', showDoneTasks ? '1' : '0');
        } catch (error) {
          /* ignore */
        }
      }, [showDoneTasks]);
      const [selectedDate, setSelectedDate] = useState(() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      });
      const [weekAnchor, setWeekAnchor] = useState(() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      });
      const [myTasks, setMyTasks] = useState({ loading: false, error: '', tasks: [] });
      const [taskModal, setTaskModal] = useState(null);
      const [completingTasks, setCompletingTasks] = useState([]);
      const dragTaskRef = useRef(null);
      const modalDialogRef = useRef(null);
      const [sort, setSort] = useState({ key: '', dir: 'asc' });
      const [showActiveOnly, setShowActiveOnly] = useState(() => {
        const stored = readShowActiveOnly();
        return stored === null ? true : stored;
      });
      const [colWidths, setColWidths] = useState(loadColWidths);
      const [colOrder, setColOrder] = useState(loadColOrder);
      const [lightsPad, setLightsPad] = useState(0);
      const [cellEditor, setCellEditor] = useState(null);
      const [statusMenu, setStatusMenu] = useState(null);
      const [actionError, setActionError] = useState('');
      const [chatMode, setChatMode] = useState(null);
      const [searchOpen, setSearchOpen] = useState(false);
      const searchInputRef = useRef(null);
      const [treeSort, setTreeSort] = useState(loadTreeSort);
      const [composerMenu, setComposerMenu] = useState(null);
      const [historyOpen, setHistoryOpen] = useState(false);
      const [showArchived, setShowArchived] = useState(false);
      const [assignMenuOpen, setAssignMenuOpen] = useState(false);
      const [assignEvents, setAssignEvents] = useState({ unread: 0, events: [], updatedAt: 0, disabled: false });
      const [assignToast, setAssignToast] = useState(null);
      const [copiedMsgId, setCopiedMsgId] = useState('');
      const [docBusy, setDocBusy] = useState(false);
      const [pendingImages, setPendingImages] = useState([]);
      const [updateState, setUpdateState] = useState({ checking: false, text: '', tone: '', available: '' });
      const [modelInfo, setModelInfo] = useState({ models: [], current: '' });
      const [listMenu, setListMenu] = useState(null);
      const [itemModal, setItemModal] = useState(null);
      const [treeMenu, setTreeMenu] = useState(null);
      const [iterationModal, setIterationModal] = useState(null);
      const iterationDialogRef = useRef(null);
      const [projectEmojis, setProjectEmojis] = useState(() => {
        try {
          const saved = JSON.parse(localStorage.getItem('dsh-zentao-project-emoji-v1') || '{}');
          return saved && typeof saved === 'object' ? saved : {};
        } catch (error) {
          return {};
        }
      });
      const [emojiModal, setEmojiModal] = useState(null);
      const emojiDialogRef = useRef(null);
      const storyImageInputRef = useRef(null);
      const itemDialogRef = useRef(null);
      const [settingsOpen, setSettingsOpen] = useState(false);
      const [settingsLoading, setSettingsLoading] = useState(false);
      const [settingsSaving, setSettingsSaving] = useState(false);
      const [settingsError, setSettingsError] = useState('');
      const [settingsForm, setSettingsForm] = useState({
        baseUrl: '',
        account: '',
        password: '',
        deepseekApiKey: '',
        deepseekBaseUrl: 'https://api.deepseek.com',
        deepseekModel: 'deepseek-chat',
        hasPassword: false,
        hasDeepseekKey: false,
      });
      const settingsDialogRef = useRef(null);
      const docInputRef = useRef(null);
      const importUpdateInputRef = useRef(null);
      const [editingConvId, setEditingConvId] = useState('');
      const [editingTitle, setEditingTitle] = useState('');
      const copiedTimerRef = useRef(null);
      const [assignToastOn, setAssignToastOn] = useState(assignToastEnabled);
      const assignNotifiedRef = useRef(null);
      const [iterationOptions, setIterationOptions] = useState(null);
      const [iterationLoading, setIterationLoading] = useState(false);
      const [modelState, setModelState] = useState(null);
      const [recording, setRecording] = useState(false);
      const [transcribing, setTranscribing] = useState(false);
      const [voiceStarting, setVoiceStarting] = useState(false);
      const recorderRef = useRef(null);
      const voiceStartingRef = useRef(false);
      const voiceBaseRef = useRef('');
      const voiceSessionRef = useRef(0);
      const voicePartialTimerRef = useRef(null);
      const voicePartialBusyRef = useRef(false);
      const [draggingCol, setDraggingCol] = useState('');
      const [dropHint, setDropHint] = useState({ key: '', side: '' });
      const [loading, setLoading] = useState(false);
      const [listError, setListError] = useState('');
      const [contexts, setContexts] = useState([]);
      const [boot] = useState(makeChatBoot);
      const [conversations, setConversations] = useState(boot.items);
      const [activeId, setActiveId] = useState(boot.activeId);
      const [messages, setMessages] = useState(boot.messages);
      const [input, setInput] = useState('');
      const [busy, setBusy] = useState(false);
      const [statusText, setStatusText] = useState('');
      const [dropActive, setDropActive] = useState(false);
      const [inputH, setInputH] = useState(() => {
        try {
          const saved = Number(localStorage.getItem(INPUT_H_KEY));
          return Number.isFinite(saved) && saved >= 72 && saved <= 420 ? saved : DEFAULT_INPUT_H;
        } catch (error) {
          return DEFAULT_INPUT_H;
        }
      });
      const convId = useRef(boot.activeId);
      const scrollRef = useRef(null);
      const busyRef = useRef(false);
      const rootRef = useRef(null);
      const flowStartRef = useRef(null);
      const flowActiveRef = useRef(false);
      const pendingEditRef = useRef(null);

      useEffect(() => {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
      }, [layout]);

      useEffect(() => {
        try {
          localStorage.setItem(INPUT_H_KEY, String(inputH));
        } catch (error) {
          /* ignore */
        }
      }, [inputH]);

      // Fold the active conversation's messages back into the conversation list
      // so switching, reloading and the history dropdown all see the same data.
      useEffect(() => {
        setConversations((prev) => {
          const index = prev.findIndex((c) => c.id === convId.current);
          if (index < 0) return prev;
          const current = prev[index];
          // A manually renamed conversation keeps its title; otherwise follow
          // the first user message.
          const title = current.titleEdited ? current.title : conversationTitle(messages) || '新会话';
          if (current.messages === messages && current.title === title) return prev;
          const next = prev.slice();
          next[index] = Object.assign({}, current, { messages, title, updatedAt: Date.now() });
          return next;
        });
      }, [messages]);

      // Debounced persistence: token streaming must not write localStorage per chunk.
      useEffect(() => {
        const timer = setTimeout(() => saveChatStore(conversations, activeId), 500);
        return () => clearTimeout(timer);
      }, [conversations, activeId]);

      // Keep the three columns inside the available width: the side panes never
      // squeeze the conversation off-screen, and a narrow window shrinks them.
      useEffect(() => {
        const fit = () => {
          const el = rootRef.current;
          const width = (el && el.clientWidth) || window.innerWidth || 1200;
          setLayout((prev) => {
            const avail = Math.max(480, width - 24);
            const railLeft = prev.leftOpen ? 0 : 40;
            const railRight = prev.rightOpen ? 0 : 40;
            const middleMin = 560;
            let leftW = prev.leftOpen ? clamp(prev.leftW, 200, 560) : prev.leftW;
            let rightW = prev.rightOpen ? clamp(prev.rightW, 260, 640) : prev.rightW;
            const budget = avail - railLeft - railRight - middleMin;
            if (prev.leftOpen && prev.rightOpen && leftW + rightW > budget) {
              const over = leftW + rightW - budget;
              const shrinkRight = Math.min(over, Math.max(0, rightW - 260));
              rightW -= shrinkRight;
              const rest = over - shrinkRight;
              if (rest > 0) leftW = Math.max(200, leftW - rest);
            } else if (prev.leftOpen && !prev.rightOpen && leftW > budget) {
              leftW = Math.max(200, budget);
            } else if (!prev.leftOpen && prev.rightOpen && rightW > budget) {
              rightW = Math.max(260, budget);
            }
            if (leftW === prev.leftW && rightW === prev.rightW) return prev;
            return Object.assign({}, prev, { leftW, rightW });
          });
        };
        fit();
        const raf = requestAnimationFrame(fit);
        window.addEventListener('resize', fit);
        return () => {
          cancelAnimationFrame(raf);
          window.removeEventListener('resize', fit);
        };
      }, [chatMode]);

      useEffect(() => {
        busyRef.current = busy;
      }, [busy]);

      useEffect(() => {
        try {
          localStorage.setItem('dsh-zentao-tree-sort-v1', JSON.stringify(treeSort));
        } catch (error) {
          /* storage may be unavailable */
        }
      }, [treeSort]);

      useEffect(() => {
        startAssignmentPolling();
        return subscribeAssignments(() => {
          const next = {
            unread: assignmentStore.unread,
            events: assignmentStore.events,
            updatedAt: assignmentStore.updatedAt,
            disabled: assignmentStore.disabled,
          };
          setAssignEvents(next);
          // Ignore the empty pre-fetch store; the first real snapshot sets the baseline.
          if (!assignmentStore.loaded) return;
          if (assignNotifiedRef.current === null) {
            assignNotifiedRef.current = next.unread;
            return;
          }
          if (
            next.unread > assignNotifiedRef.current &&
            assignToastEnabled() &&
            next.events.length &&
            next.events[0].read !== true
          ) {
            setAssignToast(next.events[0]);
          }
          assignNotifiedRef.current = next.unread;
        });
      }, []);

      const readImageFile = (file) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = String(reader.result || '');
            const comma = result.indexOf(',');
            resolve({
              name: file.name || '粘贴的图片',
              mimeType: file.type || 'image/png',
              data: comma >= 0 ? result.slice(comma + 1) : result,
              preview: result,
            });
          };
          reader.onerror = () => reject(new Error('读取图片失败'));
          reader.readAsDataURL(file);
        });

      const handleImagePaste = async (event) => {
        const items = event.clipboardData && event.clipboardData.items ? Array.from(event.clipboardData.items) : [];
        const files = items
          .filter((item) => item.kind === 'file' && item.type && item.type.indexOf('image/') === 0)
          .map((item) => item.getAsFile())
          .filter(Boolean)
          .slice(0, 4);
        if (!files.length) return;
        event.preventDefault();
        const limit = 4 - pendingImages.length;
        if (limit <= 0) {
          setActionError('最多一次粘贴 4 张图片');
          return;
        }
        const accepted = [];
        for (const file of files.slice(0, limit)) {
          if (file.size > 3 * 1024 * 1024) {
            setActionError('单张图片不能超过 3MB');
            continue;
          }
          try {
            accepted.push(await readImageFile(file));
          } catch (error) {
            setActionError(error.message);
          }
        }
        if (accepted.length) setPendingImages((prev) => prev.concat(accepted).slice(0, 4));
      };

      const removePendingImage = (index) => {
        setPendingImages((prev) => prev.filter((_, i) => i !== index));
      };

      const onDocumentSelected = async (event) => {
        const file = event.target.files && event.target.files[0];
        event.target.value = '';
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) {
          setActionError('文件太大（上限 8MB）');
          return;
        }
        setDocBusy(true);
        try {
          const buffer = await file.arrayBuffer();
          const data = await api('/zentao/api/doc/parse', {
            method: 'POST',
            headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
            body: JSON.stringify({ name: file.name, base64: bytesToBase64(new Uint8Array(buffer)) }),
          });
          if (!data.ok) throw new Error(data.error || '解析失败');
          send('', { type: 'quick', value: 'doc', docItems: data.items || [], docName: data.name || file.name });
        } catch (error) {
          setActionError('读取文档失败：' + error.message);
        } finally {
          setDocBusy(false);
        }
      };

      const copyMessageText = async (text, id) => {
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
          } else {
            const area = document.createElement('textarea');
            area.value = text;
            area.setAttribute('readonly', 'readonly');
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            area.remove();
          }
          setCopiedMsgId(id);
          if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
          copiedTimerRef.current = setTimeout(() => setCopiedMsgId(''), 1600);
        } catch (error) {
          setActionError('复制失败：' + error.message);
        }
      };

      const describeAssignment = (event) => {
        if (!event) return '';
        if (event.change === 'assigned') return '新指派给你';
        if (event.change === 'status') return '状态变为 ' + (event.statusText || '已更新');
        return '已移出我的列表';
      };

      const assignmentKindLabel = (event) =>
        event && event.kind === 'task' ? '任务' : event && event.kind === 'story' ? '需求' : 'BUG';

      // Assignment events carry the ZenTao detail URL. Keep a deterministic
      // fallback for older saved notifications that predate the URL field.
      const assignmentUrl = (event) => {
        const saved = String((event && event.url) || '').trim();
        if (/^https?:\/\//i.test(saved)) return saved;
        if (saved) return baseUrl + (saved.startsWith('/') ? saved : '/' + saved);
        const id = Number(event && event.itemId) || 0;
        if (!id) return '';
        if (event.kind === 'task') return baseUrl + `/task-view-${id}.html`;
        return baseUrl + (event.kind === 'story' ? `/story-view-${id}.html` : `/bug-view-${id}.html`);
      };

      const openAssignment = (event) => {
        markAssignmentsRead([event.id]);
        setAssignToast(null);
        setAssignMenuOpen(false);
      };

      const renderAssignMenu = () => {
        const list = assignEvents.events.slice(0, 40);
        return [
          h('div', { key: 'backdrop', className: 'zt-menu-backdrop', onClick: () => setAssignMenuOpen(false) }),
          h(
            'div',
            { key: 'menu', className: 'zt-assign-menu' },
            h(
              'div',
              { className: 'zt-assign-head' },
              h('span', null, '指派提醒' + (assignEvents.unread ? ' · ' + assignEvents.unread : '')),
              assignEvents.unread
                ? h('button', { className: 'zt-assign-text-btn', type: 'button', onClick: () => markAssignmentsRead(null) }, '全部已读')
                : null,
            ),
            h(
              'div',
              { className: 'zt-assign-list' },
              list.length
                ? list.map((event) =>
                    h(
                      'div',
                      { key: event.id, className: 'zt-assign-item' + (event.read ? ' zt-assign-item-read' : '') },
                      event.read ? null : h('span', { className: 'zt-assign-unread-dot' }),
                      h(
                        'a',
                        {
                          className: 'zt-assign-item-main',
                          href: assignmentUrl(event) || undefined,
                          target: '_blank',
                          rel: 'noreferrer noopener',
                          title: '在浏览器中打开禅道详情',
                          onClick: () => openAssignment(event),
                        },
                        h('span', { className: 'zt-assign-item-title' }, event.title || '（无标题）'),
                        h(
                          'span',
                          { className: 'zt-assign-item-meta' },
                          assignmentKindLabel(event) +
                            ' #' +
                            event.itemId +
                            ' · ' +
                            describeAssignment(event) +
                            (event.product ? ' · ' + event.product : ''),
                        ),
                      ),
                      h(
                        'div',
                        { className: 'zt-assign-actions' },
                        h(
                          'button',
                          {
                            className: 'zt-icon-btn',
                            type: 'button',
                            title: '删除提醒',
                            'aria-label': '删除提醒',
                            onClick: () => dismissAssignments([event.id]),
                          },
                          h(GlyphIcon, { name: 'close', size: 16 }),
                        ),
                      ),
                    ),
                  )
                : h('div', { className: 'zt-assign-empty' }, '暂无指派提醒'),
            ),
            h(
              'div',
              { className: 'zt-assign-footer' },
              h('span', null, '新指派 / 状态变化'),
              h(
                'button',
                {
                  className: 'zt-switch' + (assignToastOn ? ' zt-switch-on' : ''),
                  type: 'button',
                  role: 'switch',
                  'aria-checked': assignToastOn ? 'true' : 'false',
                  title: assignToastOn ? '关闭弹窗提示' : '开启弹窗提示',
                  onClick: () => {
                    const next = !assignToastOn;
                    setAssignToastOn(next);
                    setAssignToastEnabled(next);
                  },
                },
                h('span', { className: 'zt-switch-handle', 'aria-hidden': true }),
              ),
            ),
          ),
        ];
      };

      const toggleTreeSort = (key) => {
        setTreeSort((prev) => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
      };

      useEffect(() => {
        if (searchOpen && searchInputRef.current) searchInputRef.current.focus();
      }, [searchOpen]);

      const closeSearch = () => {
        setSearchOpen(false);
        setFilter('');
      };

      const toggleOnlyMine = () => {
        setOnlyMine((prev) => {
          const next = !prev;
          try {
            localStorage.setItem('dsh-zentao-only-mine-v1', next ? '1' : '0');
          } catch (error) {
            /* storage unavailable */
          }
          return next;
        });
      };

      // When the DSH sidebar is collapsed the panel starts under the macOS
      // traffic lights; reserve that space in whichever header lands on the left.
      useEffect(() => {
        const el = rootRef.current;
        if (!el) return undefined;
        const update = () => {
          const rect = el.getBoundingClientRect();
          setLightsPad(isMac ? Math.max(0, 76 - rect.left) : 0);
        };
        update();
        let observer = null;
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(update);
          observer.observe(el);
        }
        window.addEventListener('resize', update);
        return () => {
          if (observer) observer.disconnect();
          window.removeEventListener('resize', update);
        };
      }, [isMac]);

      const loadTree = useCallback(async (fresh = false) => {
        try {
          const data = await api('/zentao/api/tree' + (fresh ? '?fresh=1' : ''));
          const list = data.projects || [];
          setProjects(list);
          // Keep pinned labels in sync when a project is renamed.
          if (list.length) {
            const names = new Map(list.map((project) => [project.id, project.name]));
            setPinned((prev) => {
              let changed = false;
              const next = prev.map((item) => {
                const name = names.get(item.projectId);
                if (name && name !== item.projectName) {
                  changed = true;
                  return Object.assign({}, item, { projectName: name });
                }
                return item;
              });
              if (changed) savePinned(next);
              return changed ? next : prev;
            });
          }
          if (data.baseUrl) setBaseUrl(data.baseUrl);
          setTreeError('');
          const preferred = list.find((p) => p.name && p.name.indexOf('DSH') >= 0) || list[0];
          if (preferred) {
            setOpenProjects((prev) => (Object.keys(prev).length ? prev : { [preferred.id]: true }));
            setExecs((prev) => {
              if (prev[preferred.id]) return prev;
              api('/zentao/api/executions?projectId=' + preferred.id + (fresh ? '&fresh=1' : ''))
                .then((res) => setExecs((state) => Object.assign({}, state, { [preferred.id]: res.executions || [] })))
                .catch(() => setExecs((state) => Object.assign({}, state, { [preferred.id]: [] })));
              return prev;
            });
          }
        } catch (error) {
          setTreeError(error.message);
        }
      }, []);

      useEffect(() => {
        loadTree();
      }, [loadTree]);

      // 'native' hides the plugin's own chat column; the DeepSeek conversation
      // drives ZenTao through tools instead. Old hosts without /config keep the
      // previous three-pane behaviour.
      useEffect(() => {
        let alive = true;
        api('/zentao/api/config')
          .then((data) => {
            if (!alive) return;
            setChatMode(data && data.chatMode === 'custom' ? 'custom' : 'native');
            setMe({
              account: String((data && data.account) || ''),
              realname: String((data && data.realname) || ''),
            });
          })
          .catch(() => {
            if (alive) setChatMode('custom');
          });
        return () => {
          alive = false;
        };
      }, []);

      const loadExecs = useCallback(async (projectId, fresh = false) => {
        setExecs((prev) => Object.assign({}, prev, { [projectId]: prev[projectId] || [] }));
        try {
          const data = await api('/zentao/api/executions?projectId=' + projectId + (fresh ? '&fresh=1' : ''));
          const executions = data.executions || [];
          setExecs((prev) => Object.assign({}, prev, { [projectId]: executions }));
          // Pinned iterations keep only a snapshot; refresh it after renames.
          if (executions.length) {
            const names = new Map(executions.map((execution) => [execution.id, execution.name]));
            setPinned((prev) => {
              let changed = false;
              const next = prev.map((item) => {
                if (item.projectId !== projectId) return item;
                const name = names.get(item.executionId);
                if (name && name !== item.executionName) {
                  changed = true;
                  return Object.assign({}, item, { executionName: name });
                }
                return item;
              });
              if (changed) savePinned(next);
              return changed ? next : prev;
            });
          }
        } catch (error) {
          setExecs((prev) => Object.assign({}, prev, { [projectId]: [] }));
        }
      }, []);

      const loadItems = useCallback(async (executionId, fresh = false) => {
        if (!executionId) {
          setItems({ story: [], bug: [], task: [], testtask: [], report: [] });
          return;
        }
        setLoading(true);
        setListError('');
        const suffix = '&executionId=' + executionId + (fresh ? '&fresh=1' : '');
        try {
          const types = ['story', 'bug', 'task', 'testtask', 'report'];
          const res = await Promise.all(types.map((type) => api('/zentao/api/items?type=' + type + suffix)));
          const next = { story: [], bug: [], task: [], testtask: [], report: [] };
          types.forEach((type, index) => {
            next[type] = (res[index] && res[index].items) || [];
          });
          setItems(next);
        } catch (error) {
          setListError(error.message);
        } finally {
          setLoading(false);
        }
      }, []);

      const loadDashboard = useCallback(async (fresh = false) => {
        if (dashboardBusyRef.current) return;
        if (fresh && Date.now() - dashboardFreshAtRef.current < 3000) return;
        if (fresh) dashboardFreshAtRef.current = Date.now();
        const seq = ++dashboardSeqRef.current;
        dashboardBusyRef.current = true;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        setDashboard((prev) => Object.assign({}, prev, { loading: true, error: '' }));
        try {
          const res = await api('/zentao/api/dashboard' + (fresh ? '?fresh=1' : '') + (fresh ? '' : '?t=' + Date.now()), {
            signal: controller.signal,
          });
          if (seq !== dashboardSeqRef.current) return;
          if (!res || !res.ok) throw new Error((res && res.error) || '读取仪表盘失败');
          setDashboard({ loading: false, error: '', data: res.dashboard });
          try {
            localStorage.setItem('dsh-zentao-dashboard-v1', JSON.stringify(res.dashboard));
          } catch (error) {
            /* ignore quota errors */
          }
        } catch (error) {
          if (seq === dashboardSeqRef.current) {
            const message = error && error.name === 'AbortError' ? '刷新超时，请检查禅道连接' : error.message;
            setDashboard((prev) => Object.assign({}, prev, { loading: false, error: message }));
          }
        } finally {
          clearTimeout(timer);
          if (seq === dashboardSeqRef.current) dashboardBusyRef.current = false;
        }
      }, []);

      const loadMyTasks = useCallback(async (fresh = false) => {
        setMyTasks((prev) => Object.assign({}, prev, { loading: true, error: '' }));
        try {
          // 时间戳同时绕过浏览器 HTTP 缓存；fresh=1 让宿主跳过 60 秒缓存
          const res = await api('/zentao/api/my-tasks?fresh=' + (fresh ? '1' : '0') + '&t=' + Date.now());
          if (!res || !res.ok) throw new Error((res && res.error) || '读取我的任务失败');
          setMyTasks({ loading: false, error: '', tasks: res.tasks || [] });
        } catch (error) {
          setMyTasks((prev) => Object.assign({}, prev, { loading: false, error: error.message }));
        }
      }, []);

      useEffect(() => {
        if (view === 'dashboard' && !dashboard.data && !dashboard.loading) {
          loadDashboard(false);
          loadMyTasks(false);
        }
      }, [view, dashboard.data, dashboard.loading, loadDashboard, loadMyTasks]);

      useEffect(() => {
        if (chatMode !== 'custom') return undefined;
        let alive = true;
        api('/zentao/api/models')
          .then((res) => {
            if (!alive || !res || !res.ok) return;
            setModelInfo({ models: Array.isArray(res.models) ? res.models : [], current: res.current || '' });
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, [chatMode]);

      useEffect(() => {
        if (chatMode !== 'custom') return undefined;
        let alive = true;
        api('/zentao/api/update/check')
          .then((res) => {
            if (!alive || !res || !res.ok || !res.update) return;
            if (res.update.hasUpdate) {
              setUpdateState({
                checking: false,
                text: '发现新版本 v' + res.update.latest + '，可点击「检查更新」升级',
                tone: 'info',
                available: res.update.latest,
              });
            }
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, [chatMode]);

      const onImportUpdateSelected = (event) => {
        const file = event.target.files && event.target.files[0];
        event.target.value = '';
        if (!file) return;
        if (!/\.zip$/i.test(file.name || '')) {
          setUpdateState({ checking: false, text: '请选择 .zip 格式的更新包', tone: 'error', available: '' });
          return;
        }
        if (file.size > 30 * 1024 * 1024) {
          setUpdateState({ checking: false, text: '更新包不能超过 30MB', tone: 'error', available: '' });
          return;
        }
        setUpdateState({ checking: true, text: '正在导入 ' + file.name + '…', tone: '', available: '' });
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const result = String(reader.result || '');
            const comma = result.indexOf(',');
            const data = comma >= 0 ? result.slice(comma + 1) : result;
            const res = await api('/zentao/api/update/import', {
              method: 'POST',
              headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
              body: JSON.stringify({ name: file.name, data }),
            });
            if (!res || !res.ok) throw new Error((res && res.error) || '导入更新包失败');
            setUpdateState({
              checking: false,
              text: '已更新到 v' + (res.version || '') + '，请重启 DeepSeek Harness 生效',
              tone: 'ok',
              available: '',
            });
          } catch (error) {
            setUpdateState({ checking: false, text: error.message, tone: 'error', available: '' });
          }
        };
        reader.onerror = () => setUpdateState({ checking: false, text: '读取更新包失败', tone: 'error', available: '' });
        reader.readAsDataURL(file);
      };

      const refreshModels = async () => {
        try {
          const res = await api('/zentao/api/models');
          if (res && res.ok) {
            setModelInfo({ models: Array.isArray(res.models) ? res.models : [], current: res.current || '' });
          }
        } catch (error) {
          /* selector is optional */
        }
      };

      const setChatModel = async (value) => {
        const previous = modelInfo.current;
        if (!value || value === previous) return;
        setModelInfo((prev) => Object.assign({}, prev, { current: value }));
        try {
          const res = await api('/zentao/api/settings', {
            method: 'POST',
            headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
            body: JSON.stringify({ deepseekModel: value }),
          });
          if (!res || !res.ok) throw new Error((res && res.error) || '切换模型失败');
        } catch (error) {
          setModelInfo((prev) => Object.assign({}, prev, { current: previous }));
          setActionError(error.message);
        }
      };

      const openSettings = async () => {
        setSettingsOpen(true);
        setSettingsError('');
        setSettingsLoading(true);
        try {
          const [res, models] = await Promise.all([api('/zentao/api/settings'), api('/zentao/api/models').catch(() => null)]);
          if (!res || !res.ok) throw new Error((res && res.error) || '读取设置失败');
          const data = res.settings || {};
          setSettingsForm({
            baseUrl: data.baseUrl || '',
            account: data.account || '',
            password: '',
            deepseekApiKey: '',
            deepseekBaseUrl: data.deepseekBaseUrl || 'https://api.deepseek.com',
            deepseekModel: data.deepseekModel || 'deepseek-chat',
            hasPassword: Boolean(data.hasPassword),
            hasDeepseekKey: Boolean(data.hasDeepseekKey),
          });
          if (models && models.ok) {
            setModelInfo({ models: Array.isArray(models.models) ? models.models : [], current: models.current || data.deepseekModel || '' });
          }
        } catch (error) {
          setSettingsError(error.message);
        } finally {
          setSettingsLoading(false);
        }
      };

      const saveSettingsForm = async () => {
        if (settingsSaving) return;
        setSettingsError('');
        if (!String(settingsForm.baseUrl || '').trim()) {
          setSettingsError('请填写禅道地址');
          return;
        }
        setSettingsSaving(true);
        try {
          const payload = {
            baseUrl: String(settingsForm.baseUrl || '').trim(),
            account: String(settingsForm.account || '').trim(),
            deepseekBaseUrl: String(settingsForm.deepseekBaseUrl || '').trim(),
            deepseekModel: String(settingsForm.deepseekModel || '').trim(),
          };
          if (settingsForm.password) payload.password = settingsForm.password;
          if (settingsForm.deepseekApiKey) payload.deepseekApiKey = settingsForm.deepseekApiKey;
          const res = await api('/zentao/api/settings', {
            method: 'POST',
            headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
            body: JSON.stringify(payload),
          });
          if (!res || !res.ok) throw new Error((res && res.error) || '保存设置失败');
          setSettingsOpen(false);
          await refreshModels();
          loadTree();
          if (selection.projectId) loadExecs(selection.projectId);
          if (selection.executionId) loadItems(selection.executionId);
          loadDashboard(true);
          loadMyTasks(true);
        } catch (error) {
          setSettingsError(error.message);
        } finally {
          setSettingsSaving(false);
        }
      };

      useEffect(() => {
        const dialog = settingsDialogRef.current;
        if (!dialog) return;
        if (settingsOpen && !dialog.open) {
          try {
            dialog.showModal();
          } catch (error) {
            /* already open */
          }
        }
        if (!settingsOpen && dialog.open) dialog.close();
      }, [settingsOpen]);

      const checkForUpdates = async () => {
        if (updateState.checking) return;
        setUpdateState({ checking: true, text: '正在检查更新…', tone: '', available: '' });
        try {
          const res = await api('/zentao/api/update/check');
          if (!res || !res.ok) throw new Error((res && res.error) || '检查更新失败');
          const info = res.update || {};
          if (!info.hasUpdate) {
            setUpdateState({ checking: false, text: '当前已是最新版本 v' + (info.current || ''), tone: 'ok', available: '' });
            return;
          }
          setUpdateState({ checking: false, text: '发现新版本 v' + info.latest + '，正在自动更新…', tone: 'info', available: info.latest });
          const applied = await api('/zentao/api/update/apply', {
            method: 'POST',
            headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
            body: '{}',
          });
          if (!applied || !applied.ok) throw new Error((applied && applied.error) || '自动更新失败');
          if (applied.upToDate) {
            setUpdateState({ checking: false, text: '当前已是最新版本', tone: 'ok', available: '' });
            return;
          }
          setUpdateState({
            checking: false,
            text: '已更新到 v' + (applied.version || info.latest) + '，请重启 DeepSeek Harness 生效',
            tone: 'ok',
            available: '',
          });
        } catch (error) {
          setUpdateState({ checking: false, text: error.message, tone: 'error', available: '' });
        }
      };

      useEffect(() => {
        if (!taskModal) return undefined;
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
          document.body.style.overflow = previous;
        };
      }, [taskModal]);

      useEffect(() => {
        const dialog = modalDialogRef.current;
        if (!dialog) return;
        if (taskModal && !dialog.open) {
          try {
            dialog.showModal();
          } catch (error) {
            /* already open */
          }
        }
        if (!taskModal && dialog.open) dialog.close();
      }, [taskModal]);

      const completeTask = async (task) => {
        if (!task || task.done || completingTasks.includes(task.id)) return;
        // 先请求禅道，成功返回后再更新界面（失败保持未完成）
        setCompletingTasks((prev) => prev.concat([task.id]));
        try {
          const res = await api('/zentao/api/task-status', {
            method: 'POST',
            headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
            body: JSON.stringify({ id: task.id, statusKey: 'done' }),
          });
          if (!res || !res.ok) throw new Error((res && res.error) || '完成任务失败');
          setMyTasks((prev) =>
            Object.assign({}, prev, {
              tasks: prev.tasks.map((item) =>
                item.id === task.id ? Object.assign({}, item, { done: true, status: 'done', statusText: '已完成' }) : item,
              ),
            }),
          );
          loadMyTasks(true);
          loadDashboard(true);
          if (selection.executionId) loadItems(selection.executionId, true);
        } catch (error) {
          setActionError(error.message);
          loadMyTasks(true);
        } finally {
          setCompletingTasks((prev) => prev.filter((id) => id !== task.id));
        }
      };

      const moveTaskDeadline = async (task, date) => {
        if (!task || !date || task.deadline === date) return;
        setMyTasks((prev) => Object.assign({}, prev, {
          tasks: prev.tasks.map((item) => (item.id === task.id ? Object.assign({}, item, { deadline: date }) : item)),
        }));
        try {
          const res = await api('/zentao/api/task-deadline', {
            method: 'POST',
            headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
            body: JSON.stringify({ id: task.id, deadline: date }),
          });
          if (!res || !res.ok) throw new Error((res && res.error) || '修改截止日期失败');
          loadMyTasks(true);
          loadDashboard(true);
        } catch (error) {
          setActionError(error.message);
          loadMyTasks(true);
        }
      };

      const uploadStoryImage = (file) => {
        if (!file || !/^image\//i.test(file.type || '')) {
          setItemModal((prev) => (prev ? Object.assign({}, prev, { error: '请选择图片文件' }) : prev));
          return;
        }
        if (file.size > 10 * 1024 * 1024) {
          setItemModal((prev) => (prev ? Object.assign({}, prev, { error: '图片不能超过 10MB' }) : prev));
          return;
        }
        setItemModal((prev) => (prev ? Object.assign({}, prev, { uploadingImage: true, error: '' }) : prev));
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const raw = String(reader.result || '');
            const comma = raw.indexOf(',');
            const data = comma >= 0 ? raw.slice(comma + 1) : raw;
            const res = await api('/zentao/api/story-image', {
              method: 'POST',
              headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
              body: JSON.stringify({ data, mimeType: file.type, name: file.name }),
            });
            if (!res || !res.ok) throw new Error((res && res.error) || '上传图片失败');
            const alt = String(file.name || 'image').replace(/"/g, '&quot;');
            setItemModal((prev) =>
              prev
                ? Object.assign({}, prev, {
                    uploadingImage: false,
                    description: (prev.description || '') + '<p><img src="' + res.url + '" alt="' + alt + '"></p>',
                  })
                : prev,
            );
          } catch (error) {
            setItemModal((prev) => (prev ? Object.assign({}, prev, { uploadingImage: false, error: error.message }) : prev));
          }
        };
        reader.onerror = () =>
          setItemModal((prev) => (prev ? Object.assign({}, prev, { uploadingImage: false, error: '读取图片失败' }) : prev));
        reader.readAsDataURL(file);
      };

      const openItemModal = async (kind) => {
        const executionId = Number(selection.executionId) || 0;
        if (!executionId) return;
        setItemModal({
          kind,
          title: '',
          description: '',
          acceptance: '',
          priority: '3',
          assignedTo: '',
          users: [],
          loading: true,
          submitting: false,
          uploadingImage: false,
          error: '',
          executionId,
          executionName: selection.executionName || '',
          projectId: Number(selection.projectId) || 0,
          productId: 0,
        });
        try {
          const iterations = await api('/zentao/api/iterations');
          if (!iterations || !iterations.ok) throw new Error((iterations && iterations.error) || '读取迭代信息失败');
          const execution = (iterations.iterations || []).find((item) => Number(item.id) === executionId);
          if (!execution) throw new Error('当前迭代不在可写列表中');
          let productId = Number(execution.productId) || 0;
          if (!productId) {
            const product = await api('/zentao/api/execution-product?id=' + executionId).catch(() => null);
            productId = Number(product && product.ok && product.productId) || 0;
          }
          if (!productId) throw new Error('无法确定当前迭代所属产品');
          setItemModal((prev) =>
            prev
              ? Object.assign({}, prev, {
                  productId,
                  executionName: execution.name || prev.executionName,
                  projectId: Number(execution.projectId) || prev.projectId,
                })
              : prev,
          );
          const users = await api('/zentao/api/iteration-users?executionId=' + executionId).catch(() => null);
          setItemModal((prev) =>
            prev
              ? Object.assign({}, prev, {
                  users: users && users.ok ? users.users || [] : [],
                  loading: false,
                })
              : prev,
          );
        } catch (error) {
          setItemModal((prev) => (prev ? Object.assign({}, prev, { loading: false, error: error.message }) : prev));
        }
      };

      const submitItemModal = async () => {
        if (!itemModal || itemModal.submitting) return;
        const title = String(itemModal.title || '').trim();
        if (!title) {
          setItemModal((prev) => (prev ? Object.assign({}, prev, { error: '请填写标题' }) : prev));
          return;
        }
        if (!itemModal.productId) {
          setItemModal((prev) => (prev ? Object.assign({}, prev, { error: '无法确定所属产品，请确认迭代信息' }) : prev));
          return;
        }
        setItemModal((prev) => (prev ? Object.assign({}, prev, { submitting: true, error: '' }) : prev));
        try {
          const res = await api('/zentao/api/create', {
            method: 'POST',
            headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
            body: JSON.stringify({
              kind: itemModal.kind,
              productId: itemModal.productId,
              projectId: itemModal.projectId,
              executionId: itemModal.executionId,
              title,
              description: itemModal.description || '',
              acceptance: itemModal.acceptance || '',
              steps: itemModal.description || '',
              priority: Number(itemModal.priority) || 3,
              assignedTo: itemModal.assignedTo || '',
            }),
          });
          if (!res || !res.ok) throw new Error((res && res.error) || '创建失败');
          setItemModal(null);
          if (selection.executionId) loadItems(selection.executionId);
          loadDashboard(true);
        } catch (error) {
          setItemModal((prev) => (prev ? Object.assign({}, prev, { submitting: false, error: error.message }) : prev));
        }
      };

      const openIterationModal = (project) => {
        const now = new Date();
        const iso = (date) =>
          date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
        const end = new Date(now);
        end.setDate(now.getDate() + 13);
        setTreeMenu(null);
        setIterationModal({
          projectId: project.id,
          projectName: project.name,
          name: '',
          code: '',
          begin: iso(now),
          end: iso(end),
          status: 'wait',
          submitting: false,
          error: '',
        });
      };

      const submitIterationModal = async () => {
        if (!iterationModal || iterationModal.submitting) return;
        const name = String(iterationModal.name || '').trim();
        if (!name) {
          setIterationModal((prev) => (prev ? Object.assign({}, prev, { error: '请填写迭代名称' }) : prev));
          return;
        }
        if (!iterationModal.begin || !iterationModal.end || iterationModal.end < iterationModal.begin) {
          setIterationModal((prev) => (prev ? Object.assign({}, prev, { error: '结束日期需晚于开始日期' }) : prev));
          return;
        }
        setIterationModal((prev) => (prev ? Object.assign({}, prev, { submitting: true, error: '' }) : prev));
        try {
          const res = await api('/zentao/api/execution-create', {
            method: 'POST',
            headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
            body: JSON.stringify({
              projectId: iterationModal.projectId,
              name,
              code: String(iterationModal.code || '').trim(),
              begin: iterationModal.begin,
              end: iterationModal.end,
              status: iterationModal.status,
            }),
          });
          if (!res || !res.ok) throw new Error((res && res.error) || '创建迭代失败');
          const projectId = iterationModal.projectId;
          setIterationModal(null);
          setOpenProjects((prev) => Object.assign({}, prev, { [projectId]: true }));
          loadTree();
          loadExecs(projectId);
          loadDashboard(true);
        } catch (error) {
          setIterationModal((prev) => (prev ? Object.assign({}, prev, { submitting: false, error: error.message }) : prev));
        }
      };

      const treeStatusItems = () =>
        ['doing', 'suspended', 'closed'].map((key) =>
          h(
            'button',
            {
              key,
              type: 'button',
              className: 'zt-context-item' + (treeMenu && treeMenu.status === key ? ' zt-context-item-current' : ''),
              role: 'menuitem',
              disabled: Boolean(treeMenu && treeMenu.status === key),
              onClick: () => changeTreeStatus(key),
            },
            h('span', { className: 'zt-status-dot zt-status-dot-' + key }),
            h('span', null, key === 'doing' ? '进行中' : key === 'suspended' ? '已挂起' : '已关闭'),
            treeMenu && treeMenu.status === key ? h('span', { className: 'zt-context-check' }, '当前') : null,
          ),
        );

      const changeTreeStatus = async (key) => {
        if (!treeMenu) return;
        const target = treeMenu;
        setTreeMenu(null);
        try {
          const res = await api('/zentao/api/status', {
            method: 'POST',
            headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
            body: JSON.stringify({
              targetType: target.type,
              id: target.id,
              statusKey: key,
              current: target.status,
            }),
          });
          if (!res || !res.ok) throw new Error((res && res.error) || '修改状态失败');
          loadTree();
          if (target.type === 'execution') {
            if (selection.projectId) loadExecs(selection.projectId);
            if (selection.executionId === target.id) loadItems(target.id);
          }
        } catch (error) {
          setActionError(error.message);
        }
      };

      useEffect(() => {
        try {
          localStorage.setItem('dsh-zentao-project-emoji-v1', JSON.stringify(projectEmojis));
        } catch (error) {
          /* ignore quota errors */
        }
      }, [projectEmojis]);

      useEffect(() => {
        const dialog = emojiDialogRef.current;
        if (!dialog) return;
        if (emojiModal && !dialog.open) {
          try {
            dialog.showModal();
          } catch (error) {
            /* already open */
          }
        }
        if (!emojiModal && dialog.open) dialog.close();
      }, [emojiModal]);

      useEffect(() => {
        const dialog = iterationDialogRef.current;
        if (!dialog) return;
        if (iterationModal && !dialog.open) {
          try {
            dialog.showModal();
          } catch (error) {
            /* already open */
          }
        }
        if (!iterationModal && dialog.open) dialog.close();
      }, [iterationModal]);

      useEffect(() => {
        const dialog = itemDialogRef.current;
        if (!dialog) return;
        if (itemModal && !dialog.open) {
          try {
            dialog.showModal();
          } catch (error) {
            /* already open */
          }
        }
        if (!itemModal && dialog.open) dialog.close();
      }, [itemModal]);

      const openTaskModal = async (date, presetExecutionId) => {
        const fallbackDate = (() => {
          const now = new Date();
          return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        })();
        setTaskModal({
          date: date || fallbackDate,
          title: '',
          description: '',
          deadline: date || fallbackDate,
          priority: '3',
          executionId: presetExecutionId ? String(presetExecutionId) : '',
          projectId: 0,
          assignedTo: me.account || '',
          iterationOpen: false,
          iterationQuery: '',
          assigneeOpen: false,
          storyOpen: false,
          storyQuery: '',
          storyId: '',
          stories: [],
          loadingStories: false,
          users: [],
          iterations: [],
          loading: true,
          loadingUsers: false,
          submitting: false,
          error: '',
        });
        try {
          const res = await api('/zentao/api/iterations');
          if (!res || !res.ok) throw new Error((res && res.error) || '读取迭代列表失败');
          const iterations = res.iterations || [];
          const preset = presetExecutionId
            ? iterations.find((item) => Number(item.id) === Number(presetExecutionId))
            : null;
          setTaskModal((prev) =>
            prev
              ? Object.assign({}, prev, {
                  iterations,
                  loading: false,
                  executionId: preset ? String(preset.id) : prev.executionId,
                  projectId: preset ? preset.projectId : prev.projectId,
                })
              : prev,
          );
          if (preset) {
            // Prefill the current iteration exactly like picking it manually.
            loadTaskModalUsers(preset.id);
            loadTaskModalStories(preset.id);
          }
        } catch (error) {
          setTaskModal((prev) => (prev ? Object.assign({}, prev, { loading: false, error: error.message }) : prev));
        }
      };

      const loadTaskModalUsers = async (executionId) => {
        if (!executionId) return;
        setTaskModal((prev) => (prev ? Object.assign({}, prev, { loadingUsers: true }) : prev));
        try {
          const res = await api('/zentao/api/iteration-users?executionId=' + executionId);
          if (!res || !res.ok) throw new Error((res && res.error) || '读取指派人失败');
          const users = res.users || [];
          setTaskModal((prev) =>
            prev
              ? Object.assign({}, prev, {
                  users,
                  loadingUsers: false,
                  assignedTo:
                    prev.assignedTo ||
                    (me.account && users.some((user) => user.value === me.account) ? me.account : ''),
                })
              : prev,
          );
        } catch (error) {
          setTaskModal((prev) => (prev ? Object.assign({}, prev, { loadingUsers: false, error: error.message }) : prev));
        }
      };

      const loadTaskModalStories = async (executionId) => {
        if (!executionId) return;
        setTaskModal((prev) => (prev ? Object.assign({}, prev, { loadingStories: true, stories: [] }) : prev));
        try {
          const res = await api('/zentao/api/items?type=story&executionId=' + executionId);
          if (!res || !res.ok) throw new Error((res && res.error) || '读取迭代需求失败');
          setTaskModal((prev) => (prev ? Object.assign({}, prev, { stories: res.items || [], loadingStories: false }) : prev));
        } catch (error) {
          setTaskModal((prev) => (prev ? Object.assign({}, prev, { loadingStories: false, error: error.message }) : prev));
        }
      };

      const submitTaskModal = async () => {
        if (!taskModal || taskModal.submitting) return;
        const title = String(taskModal.title || '').trim();
        if (!title) {
          setTaskModal((prev) => (prev ? Object.assign({}, prev, { error: '请填写任务标题' }) : prev));
          return;
        }
        const iteration = (taskModal.iterations || []).find((item) => item.id === Number(taskModal.executionId));
        if (!iteration) {
          setTaskModal((prev) => (prev ? Object.assign({}, prev, { error: '请选择迭代' }) : prev));
          return;
        }
        if (!taskModal.assignedTo) {
          setTaskModal((prev) => (prev ? Object.assign({}, prev, { error: '请选择指派人' }) : prev));
          return;
        }
        if (!taskModal.deadline) {
          setTaskModal((prev) => (prev ? Object.assign({}, prev, { error: '请选择截止日期' }) : prev));
          return;
        }
        setTaskModal((prev) => (prev ? Object.assign({}, prev, { submitting: true, error: '' }) : prev));
        try {
          const res = await api('/zentao/api/task-create', {
            method: 'POST',
            headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
            body: JSON.stringify({
              title,
              description: String(taskModal.description || '').trim(),
              assignedTo: taskModal.assignedTo,
              priority: Number(taskModal.priority) || 3,
              deadline: taskModal.deadline || taskModal.date,
              executionId: iteration.id,
              projectId: iteration.projectId,
              storyId: Number(taskModal.storyId) || 0,
            }),
          });
          if (!res || !res.ok) throw new Error((res && res.error) || '创建任务失败');
          setTaskModal(null);
          loadMyTasks(true);
          loadDashboard(true);
          if (selection.executionId === iteration.id) loadItems(selection.executionId, true);
        } catch (error) {
          setTaskModal((prev) => (prev ? Object.assign({}, prev, { submitting: false, error: error.message }) : prev));
        }
      };

      const loadTeamTasks = useCallback(async (fresh = false) => {
        if (teamBusyRef.current) return;
        if (fresh && Date.now() - teamFreshAtRef.current < 3000) return;
        if (fresh) teamFreshAtRef.current = Date.now();
        const seq = ++teamSeqRef.current;
        teamBusyRef.current = true;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        setTeamTasks((prev) => Object.assign({}, prev, { loading: true, error: '' }));
        try {
          const res = await api('/zentao/api/team-tasks' + (fresh ? '?fresh=1' : '') + (fresh ? '' : '?t=' + Date.now()), {
            signal: controller.signal,
          });
          if (seq !== teamSeqRef.current) return;
          if (!res || !res.ok) throw new Error((res && res.error) || '读取全员任务失败');
          setTeamTasks({ loading: false, error: '', tasks: res.tasks || [], members: res.members || [], loaded: true });
        } catch (error) {
          if (seq === teamSeqRef.current) {
            const message = error && error.name === 'AbortError' ? '加载超时，请检查禅道连接' : error.message;
            setTeamTasks((prev) => Object.assign({}, prev, { loading: false, error: message }));
          }
        } finally {
          clearTimeout(timer);
          if (seq === teamSeqRef.current) teamBusyRef.current = false;
        }
      }, []);

      useEffect(() => {
        if (view === 'team' && !teamTasks.loaded && !teamTasks.loading) loadTeamTasks(true);
      }, [view, teamTasks.loaded, teamTasks.loading, loadTeamTasks]);

      const switchView = (next) => {
        setView(next);
        if (next === 'dashboard') {
          loadDashboard(true);
          loadMyTasks(true);
        }
        if (next === 'team') loadTeamTasks(true);
      };

      const refreshAll = useCallback(async () => {
        setTreeBusy(true);
        try {
          await loadTree(true);
          // Include pinned projects even when the tree node is collapsed.
          const ids = [...new Set([...Object.keys(execs), ...pinned.map((item) => String(item.projectId))])];
          await Promise.all(ids.map((pid) => loadExecs(Number(pid), true)));
          if (selection.executionId) await loadItems(selection.executionId, true);
        } finally {
          setTreeBusy(false);
        }
      }, [execs, pinned, selection.executionId, loadTree, loadExecs, loadItems]);

      // Refresh the tree when the page becomes visible again (auto refresh).
      useEffect(() => {
        let last = 0;
        const onVisible = () => {
          if (document.visibilityState !== 'visible') return;
          if (Date.now() - last < 30000) return;
          last = Date.now();
          refreshAll();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
      }, [refreshAll]);

      // While filtering by iteration name, make sure every project's iterations
      // are loaded so matches are not missed.
      useEffect(() => {
        if (!filter.trim()) return;
        for (const p of projects) {
          if (!execs[p.id]) loadExecs(p.id);
        }
      }, [filter, projects, execs, loadExecs]);

      const toggleShowActiveOnly = () => {
        const next = !showActiveOnly;
        setShowActiveOnly(next);
        try {
          localStorage.setItem(SHOW_ACTIVE_KEY, next ? '1' : '0');
        } catch (error) {
          /* storage unavailable */
        }
        // Turning the filter on hides non-active items: drop a stale selection.
        if (next) {
          const project = projects.find((p) => p.id === selection.projectId);
          const execution = (execs[selection.projectId] || []).find((e) => e.id === selection.executionId);
          const hidden =
            (project && project.status !== 'doing') || (execution && execution.status !== 'doing');
          if (selection.executionId && hidden) {
            setSelection({ projectId: 0, projectName: '', executionId: 0, executionName: '' });
            setItems({ story: [], bug: [], task: [], testtask: [], report: [] });
          }
        }
      };

      const toggleAllProjects = () => {
        const ids = visibleProjects.map(({ project }) => project.id);
        if (!ids.length) return;
        const allOpen = ids.every((id) => !!openProjects[id]);
        if (allOpen) {
          setOpenProjects({});
          return;
        }
        const next = Object.assign({}, openProjects);
        ids.forEach((id) => {
          next[id] = true;
          if (!execs[id]) loadExecs(Number(id));
        });
        setOpenProjects(next);
      };

      const toggleProject = (project) => {
        const open = !!openProjects[project.id];
        setOpenProjects((prev) => Object.assign({}, prev, { [project.id]: !open }));
        if (!open && !execs[project.id]) loadExecs(project.id);
      };

      const togglePinned = (project, execution) => {
        setPinned((prev) => {
          const exists = prev.some((item) => item.executionId === execution.id);
          const next = exists
            ? prev.filter((item) => item.executionId !== execution.id)
            : prev.concat({
                projectId: project.id,
                projectName: project.name,
                executionId: execution.id,
                executionName: execution.name,
              });
          savePinned(next);
          return next;
        });
      };

      const unpinExecution = (executionId) => {
        setPinned((prev) => {
          const next = prev.filter((item) => item.executionId !== executionId);
          savePinned(next);
          return next;
        });
      };

      const selectExecution = (project, execution) => {
        setSelection({
          projectId: project.id,
          projectName: project.name,
          executionId: execution.id,
          executionName: execution.name,
        });
        // 在仪表盘页点击左侧迭代：直接切到该迭代的列表页
        setView('list');
        loadItems(execution.id);
      };

      const addContext = useCallback(async (obj) => {
        const key = obj.type + ':' + obj.id;
        if (contexts.some((c) => c.type + ':' + c.id === key)) return;
        let description = obj.description || '';
        if (!description && (obj.type === 'story' || obj.type === 'bug')) {
          try {
            const data = await api('/zentao/api/detail?type=' + obj.type + '&id=' + obj.id);
            description = (data.detail && data.detail.description) || '';
          } catch (error) {
            description = '';
          }
        }
        if (!description) {
          description = CONTEXT_LABEL[obj.type] + ' #' + obj.id + ' ' + obj.title;
        }
        setContexts((prev) => {
          if (prev.some((c) => c.type + ':' + c.id === key)) return prev;
          return prev.concat([
            {
              type: obj.type,
              id: obj.id,
              title: obj.title,
              description,
              projectId: Number(obj.projectId || 0) || undefined,
              projectName: obj.projectName || undefined,
            },
          ]);
        });
      }, [contexts]);

      const removeContext = (item) => {
        setContexts((prev) => prev.filter((c) => !(c.type === item.type && c.id === item.id)));
      };

      const startNewConversation = () => {
        pendingEditRef.current = null;
        const conv = newConversation();
        convId.current = conv.id;
        setConversations((prev) => {
          const next = [conv].concat(prev);
          saveChatStore(next, conv.id);
          return next;
        });
        setActiveId(conv.id);
        setMessages([]);
        setInput('');
        flowStartRef.current = null;
        flowActiveRef.current = false;
      };

      const switchConversation = (id) => {
        if (!id || id === convId.current) return;
        pendingEditRef.current = null;
        convId.current = id;
        setActiveId(id);
        saveChatStore(conversations, id);
        const target = conversations.find((c) => c.id === id);
        setMessages(target && Array.isArray(target.messages) ? target.messages : []);
        flowStartRef.current = null;
        flowActiveRef.current = false;
      };

      const startRenameConversation = (conversation) => {
        setEditingConvId(conversation.id);
        setEditingTitle(conversation.title || '');
      };

      const saveConversationTitle = (id, value) => {
        const title = String(value || '').trim();
        setEditingConvId('');
        if (!title) return;
        const next = conversations.map((c) =>
          c.id === id ? Object.assign({}, c, { title, titleEdited: true, updatedAt: Date.now() }) : c,
        );
        setConversations(next);
        saveChatStore(next, activeId);
      };

      const deleteConversation = (id) => {
        const remaining = conversations.filter((c) => c.id !== id);
        if (!remaining.length) {
          const conv = newConversation();
          convId.current = conv.id;
          setConversations([conv]);
          setActiveId(conv.id);
          setMessages([]);
          saveChatStore([conv], conv.id);
          return;
        }
        if (id === convId.current) {
          const pick = remaining.find((c) => !c.archived) || remaining[0];
          convId.current = pick.id;
          setActiveId(pick.id);
          setMessages(Array.isArray(pick.messages) ? pick.messages : []);
        }
        setConversations(remaining);
        saveChatStore(remaining, convId.current);
      };

      const toggleConversationArchived = (id) => {
        const next = conversations.map((c) => (c.id === id ? Object.assign({}, c, { archived: !c.archived }) : c));
        setConversations(next);
        saveChatStore(next, activeId);
      };

      const clearConversation = () => {
        pendingEditRef.current = null;
        const id = convId.current;
        setMessages([]);
        flowStartRef.current = null;
        flowActiveRef.current = false;
        // Drop the host-side wizard state for this conversation id.
        fetch('/zentao/api/chat', {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json' }, HEADERS),
          body: JSON.stringify({ conversationId: id, action: { type: 'reset' } }),
        }).catch(() => {});
      };

      const onDrop = async (event) => {
        event.preventDefault();
        setDropActive(false);
        const raw = event.dataTransfer.getData('application/x-zentao');
        if (!raw) return;
        try {
          await addContext(JSON.parse(raw));
        } catch (error) {
          /* ignore malformed drags */
        }
      };

      const onDragStart = (event, obj) => {
        event.dataTransfer.setData('application/x-zentao', JSON.stringify(obj));
        event.dataTransfer.effectAllowed = 'copy';
      };

      const handleCardEdit = (messageId, cardIndex, edit) => {
        if (!edit) return;
        pendingEditRef.current = edit;
        setMessages((prev) =>
          prev.map((message) => {
            if (message.id !== messageId) return message;
            const cards = message.cards.map((card, index) =>
              index === cardIndex
                ? Object.assign({}, card, { data: Object.assign({}, card.data, edit.values) })
                : card,
            );
            return Object.assign({}, message, { cards });
          }),
        );
      };

      const send = useCallback(
        async (text, action) => {
          if (busyRef.current) return;
          const trimmed = String(text || '').trim();
          const imagesToSend = pendingImages.map((image) => ({
            name: image.name,
            mimeType: image.mimeType,
            data: image.data,
          }));
          if (!trimmed && !action && !imagesToSend.length) return;
          const userText = trimmed || (imagesToSend.length ? '（图片）' : actionLabel(action));
          const assistantId = uid('msg');
          const quickFlow =
            action &&
            action.type === 'quick' &&
            (action.value === 'story' || action.value === 'bug' || action.value === 'testcase' || action.value === 'execution');
          if (quickFlow || (!action && !flowActiveRef.current && detectChatIntent(trimmed))) {
            flowStartRef.current = messages.length;
            flowActiveRef.current = true;
          }
          const pendingCancel =
            flowActiveRef.current &&
            ((action && action.type === 'choice' && action.value === 'cancel') || (!action && /^取消$/.test(trimmed)));
          setMessages((prev) =>
            prev.concat([
              {
                id: uid('msg'),
                role: 'user',
                text: userText,
                cards: [],
                images: imagesToSend.map((image) => ({ name: image.name })),
                at: Date.now(),
              },
              { id: assistantId, role: 'assistant', text: '', cards: [], at: Date.now() },
            ]),
          );
          setInput('');
          if (imagesToSend.length) setPendingImages([]);
          setBusy(true);
          setStatusText('');
          const pendingEdit = pendingEditRef.current;
          pendingEditRef.current = null;
          const payload = {
            conversationId: convId.current,
            text: trimmed,
            action: action && action.type === 'quick' && action.value === 'doc' ? { type: 'quick', value: 'doc' } : action || null,
            edit: pendingEdit,
            images: imagesToSend,
            contexts,
            selection: Object.assign({}, selection, { contexts }),
            ...(action && action.type === 'quick' && action.value === 'doc'
              ? { docItems: Array.isArray(action.docItems) ? action.docItems : [], docName: String(action.docName || '') }
              : {}),
          };
          let createdSomething = false;
          let taskCreated = false;
          let adopted = null;
          try {
            const res = await fetch('/zentao/api/chat', {
              method: 'POST',
              headers: Object.assign({ 'content-type': 'application/json' }, HEADERS),
              body: JSON.stringify(payload),
            });
            if (!res.ok || !res.body) throw new Error('会话接口不可用（HTTP ' + res.status + '）');
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            const handleEvent = (event) => {
              if (event.type === 'delta') {
                setMessages((prev) => prev.map((m) => (m.id === assistantId ? Object.assign({}, m, { text: m.text + event.text }) : m)));
                setStatusText('');
              } else if (event.type === 'card') {
                if (event.card && event.card.kind === 'result' && event.card.data && event.card.data.ok) createdSomething = true;
                if (event.card && event.card.kind === 'task-result') taskCreated = true;
                const createdExecution =
                  event.card && event.card.kind === 'result' && event.card.data ? event.card.data.executionCreated : null;
                if (createdExecution && createdExecution.projectId) {
                  // The new iteration becomes the active one; the post-stream refresh
                  // below reloads the tree and the item list from the host.
                  setOpenProjects((prev) => Object.assign({}, prev, { [createdExecution.projectId]: true }));
                  adopted = {
                    projectId: createdExecution.projectId,
                    projectName: createdExecution.projectName,
                    executionId: createdExecution.executionId,
                    executionName: createdExecution.executionName,
                  };
                  if (createdExecution.executionId) {
                    setSelection({
                      projectId: createdExecution.projectId,
                      projectName: createdExecution.projectName,
                      executionId: createdExecution.executionId,
                      executionName: createdExecution.executionName,
                    });
                  }
                }
                const statusChanged =
                  event.card && event.card.kind === 'result' && event.card.data ? event.card.data.statusChanged : null;
                if (statusChanged && (statusChanged.type === 'execution' || statusChanged.type === 'project')) {
                  const projectId = Number(
                    statusChanged.type === 'project' ? statusChanged.id : statusChanged.projectId || 0,
                  );
                  if (projectId) {
                    setOpenProjects((prev) => Object.assign({}, prev, { [projectId]: true }));
                    adopted = {
                      projectId,
                      projectName: '',
                      executionId: selection.executionId,
                      executionName: selection.executionName,
                    };
                  }
                }
                const createdTarget = event.card && event.card.kind === 'result' && event.card.data ? event.card.data.target : null;
                if (createdTarget && createdTarget.executionId) {
                  adopted = createdTarget;
                  setSelection({
                    projectId: createdTarget.projectId,
                    projectName: createdTarget.projectName,
                    executionId: createdTarget.executionId,
                    executionName: createdTarget.executionName,
                  });
                  setOpenProjects((prev) => Object.assign({}, prev, { [createdTarget.projectId]: true }));
                }
                setMessages((prev) => prev.map((m) => (m.id === assistantId ? Object.assign({}, m, { cards: m.cards.concat([event.card]) }) : m)));
              } else if (event.type === 'status') {
                setStatusText(event.text || '');
              } else if (event.type === 'error') {
                setMessages((prev) => prev.map((m) => (m.id === assistantId ? Object.assign({}, m, { text: m.text + '\n[错误] ' + event.message }) : m)));
              }
            };
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              buffer += decoder.decode(chunk.value, { stream: true });
              let idx = buffer.indexOf('\n\n');
              while (idx >= 0) {
                const block = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                const line = block.split('\n').find((l) => l.indexOf('data: ') === 0);
                if (line) {
                  try {
                    handleEvent(JSON.parse(line.slice(6)));
                  } catch (error) {
                    /* ignore malformed event */
                  }
                }
                idx = buffer.indexOf('\n\n');
              }
            }
          } catch (error) {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? Object.assign({}, m, { text: m.text + '\n[错误] ' + error.message }) : m)),
            );
          } finally {
            setBusy(false);
            setStatusText('');
            if (pendingCancel) {
              const start = flowStartRef.current;
              if (typeof start === 'number') {
                // Close the whole generated block: drop the flow's user inputs and
                // card messages, keeping only the final "cancelled" reply.
                setMessages((prev) => {
                  const last = prev[prev.length - 1];
                  const keep = last && last.role === 'assistant' ? last : null;
                  return prev.slice(0, Math.min(start, prev.length)).concat(keep ? [keep] : []);
                });
              }
              flowStartRef.current = null;
              flowActiveRef.current = false;
            }
            if (createdSomething) {
              flowStartRef.current = null;
              flowActiveRef.current = false;
              loadTree();
              const projectId = adopted ? adopted.projectId : selection.projectId;
              const executionId = adopted ? adopted.executionId : selection.executionId;
              if (projectId) loadExecs(projectId);
              if (executionId) loadItems(executionId);
            }
            if (taskCreated) {
              loadMyTasks(true);
              loadDashboard(true);
            }
          }
        },
        [contexts, selection, messages, pendingImages, loadTree, loadExecs, loadItems, loadMyTasks, loadDashboard],
      );

      useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }, [messages, statusText]);

      useEffect(() => {
        if (!cellEditor) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') setCellEditor(null);
        };
        const close = () => setCellEditor(null);
        window.addEventListener('keydown', onKey);
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        return () => {
          window.removeEventListener('keydown', onKey);
          window.removeEventListener('scroll', close, true);
          window.removeEventListener('resize', close);
        };
      }, [cellEditor]);

      useEffect(() => {
        if (!listMenu) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') {
            setListMenu(null);
            setTreeMenu(null);
          }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [listMenu]);

      useEffect(() => {
        if (!assignToast) return undefined;
        const timer = setTimeout(() => setAssignToast(null), 6000);
        return () => clearTimeout(timer);
      }, [assignToast]);

      useEffect(() => {
        if (!actionError) return undefined;
        const timer = setTimeout(() => setActionError(''), 5000);
        return () => clearTimeout(timer);
      }, [actionError]);

      const startDrag = (side, event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startW = side === 'left' ? layout.leftW : layout.rightW;
        const el = rootRef.current;
        const width = (el && el.clientWidth) || window.innerWidth || 1200;
        const move = (ev) => {
          const dx = ev.clientX - startX;
          const next = side === 'left' ? startW + dx : startW - dx;
          setLayout((prev) => {
            const other = side === 'left' ? (prev.rightOpen ? prev.rightW : 40) : prev.leftOpen ? prev.leftW : 40;
            // 中间列保底 560px：列表/仪表盘不会被拖拽挤没
            const splitters = 16; // 左右两条拖拽分隔条
            const limit = Math.max(side === 'left' ? 200 : 260, width - other - 560 - splitters);
            if (side === 'left') return Object.assign({}, prev, { leftW: clamp(next, 200, Math.min(560, limit)) });
            return Object.assign({}, prev, { rightW: clamp(next, 260, Math.min(640, limit)) });
          });
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      };

      // Column resize: the first drag snapshots every rendered width, then only
      // the dragged column changes; the result is stored per browser.
      const startColResize = (event, column) => {
        event.preventDefault();
        event.stopPropagation();
        const table = event.currentTarget.closest('table');
        const headers = table ? Array.from(table.querySelectorAll('thead th')) : [];
        const snapshot = Object.assign({}, colWidths || {});
        headers.forEach((th) => {
          const key = th.getAttribute('data-col');
          const def = ACTIVE_COLUMNS.find((item) => item.key === key);
          const width = Math.round(th.getBoundingClientRect().width);
          if (def && width > 0) snapshot[def.key] = width;
        });
        const startWidth = Math.round(event.currentTarget.parentElement.getBoundingClientRect().width) || snapshot[column.key] || COL_WIDTH_LIMITS.min;
        const minWidth = COLUMN_MIN_WIDTHS[column.className] || COL_WIDTH_LIMITS.min;
        const startX = event.clientX;
        let latest = snapshot;
        setColWidths(snapshot);
        const move = (ev) => {
          const next = clamp(Math.round(startWidth + (ev.clientX - startX)), minWidth, COL_WIDTH_LIMITS.max);
          latest = Object.assign({}, latest, { [column.key]: next });
          setColWidths(latest);
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          saveColWidths(latest);
        };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      };

      // Double-click any drag handle restores both the default widths and the
      // default column order.
      const resetColWidths = () => {
        setColWidths(null);
        saveColWidths(null);
        setColOrder(null);
        saveColOrder(null);
      };

      const startInputResize = (event) => {
        event.preventDefault();
        const startY = event.clientY;
        const startH = inputH;
        const paneHeight = (rootRef.current && rootRef.current.clientHeight) || 600;
        const maxH = Math.max(120, Math.min(420, paneHeight - 240));
        const move = (ev) => {
          const next = startH + (startY - ev.clientY);
          setInputH(clamp(next, 72, maxH));
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      };

      const mineLabels = [me.account, me.realname]
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean);
      const isMine = (item) => {
        const assignee = String((item && item.assignedTo) || '').trim().toLowerCase();
        return Boolean(assignee) && mineLabels.includes(assignee);
      };
      // 「只看我」只作用于有指派人的列表；测试单/测试报告没有指派人概念。
      const visibleList = (type) =>
        onlyMine && (type === 'story' || type === 'bug' || type === 'task') ? items[type].filter(isMine) : items[type];
      const visibleStories = visibleList('story');
      const visibleBugs = visibleList('bug');
      const visibleTask = visibleList('task');
      const visibleTesttask = visibleList('testtask');
      const visibleReport = visibleList('report');
      const list = visibleList(tab);

      // Sortable columns mirror the table headers; values are what the user sees.
      const CORE_COLUMNS = [
        { key: 'id', label: 'ID', className: 'zt-col-id', type: 'number', value: (i) => Number(i.id) || 0 },
        { key: 'title', label: '标题', className: 'zt-col-title', type: 'text', value: (i) => i.title || '' },
        { key: 'module', label: '模块', className: 'zt-col-module', type: 'text', value: (i) => i.moduleName || '' },
        { key: 'priority', label: '优先级', className: 'zt-col-priority', type: 'number', value: (i) => (i.priority ? Number(i.priority) : null) },
        { key: 'assignee', label: '指派人', className: 'zt-col-assignee', type: 'text', value: (i) => i.assignedTo || '' },
        {
          key: 'status',
          label: tab === 'bug' ? '方案' : '阶段',
          className: 'zt-col-state',
          type: 'text',
          value: (i) => (i.type === 'story' ? i.stage || i.statusText : i.resolution || i.statusText) || '',
        },
        // Story-only 状态 column (the actual ZenTao story status), rendered
        // before 阶段. Virtual: follows the 阶段 column and stays out of the
        // persisted column order/widths.
        {
          key: 'storyState',
          label: '状态',
          className: 'zt-col-storystate',
          type: 'text',
          virtual: true,
          value: (i) => i.statusText || '',
        },
      ];

      const TASK_COLUMNS = [
        { key: 'id', label: 'ID', className: 'zt-col-id', type: 'number', value: (i) => Number(i.id) || 0 },
        { key: 'title', label: '任务名称', className: 'zt-col-title', type: 'text', value: (i) => i.title || '' },
        { key: 'module', label: '所属模块', className: 'zt-col-module', type: 'text', value: (i) => i.moduleName || '' },
        { key: 'priority', label: '优先级', className: 'zt-col-priority', type: 'number', value: (i) => (i.priority ? Number(i.priority) : null) },
        { key: 'status', label: '状态', className: 'zt-col-state', type: 'text', value: (i) => i.statusText || '' },
        { key: 'assignee', label: '指派给', className: 'zt-col-assignee', type: 'text', value: (i) => i.assignedTo || '' },
        { key: 'deadline', label: '截止', className: 'zt-col-deadline', type: 'text', value: (i) => i.deadline || '' },
      ];

      const TESTTASK_COLUMNS = [
        { key: 'id', label: 'ID', className: 'zt-col-id', type: 'number', value: (i) => Number(i.id) || 0 },
        { key: 'title', label: '测试单名称', className: 'zt-col-title', type: 'text', value: (i) => i.title || '' },
        { key: 'status', label: '状态', className: 'zt-col-state', type: 'text', value: (i) => i.statusText || '' },
        { key: 'owner', label: '负责人', className: 'zt-col-owner', type: 'text', value: (i) => i.owner || '' },
        { key: 'begin', label: '开始', className: 'zt-col-date', type: 'text', value: (i) => i.begin || '' },
        { key: 'end', label: '结束', className: 'zt-col-date', type: 'text', value: (i) => i.end || '' },
      ];

      const REPORT_COLUMNS = [
        { key: 'id', label: 'ID', className: 'zt-col-id', type: 'number', value: (i) => Number(i.id) || 0 },
        { key: 'title', label: '测试报告名称', className: 'zt-col-title', type: 'text', value: (i) => i.title || '' },
        { key: 'testtaskName', label: '关联测试单', className: 'zt-col-testtask', type: 'text', value: (i) => i.testtaskName || '' },
        { key: 'date', label: '日期', className: 'zt-col-date', type: 'text', value: (i) => i.date || '' },
      ];

      const TAB_LABELS = { story: '研发需求', bug: 'BUG', task: '任务', testtask: '测试单', report: '测试报告' };
      const TEAM_COLUMNS = [
        { key: 'id', label: 'ID', width: 7, min: 56 },
        { key: 'title', label: '任务名称', width: 25, min: 170 },
        { key: 'assignee', label: '指派人', width: 11, min: 84 },
        { key: 'status', label: '状态', width: 10, min: 80 },
        { key: 'deadline', label: '截止完成时间', width: 15, min: 104 },
        { key: 'overdue', label: '是否延期', width: 10, min: 84 },
        { key: 'execution', label: '所属迭代', width: 22, min: 170 },
      ];
      const CLOSED_COLUMNS = [
        { key: 'id', label: '任务ID', width: 9, min: 66 },
        { key: 'title', label: '任务名称', width: 28, min: 180 },
        { key: 'resolver', label: '解决人', width: 13, min: 90 },
        { key: 'resolvedDate', label: '解决时间', width: 15, min: 104 },
        { key: 'status', label: '任务状态', width: 11, min: 90 },
        { key: 'execution', label: '所属迭代', width: 24, min: 170 },
      ];
      const TAB_COUNTS = {
        story: visibleStories.length,
        bug: visibleBugs.length,
        task: visibleTask.length,
        testtask: visibleTesttask.length,
        report: visibleReport.length,
      };
      const isCoreTab = tab === 'story' || tab === 'bug';
      const ACTIVE_COLUMNS =
        tab === 'task' ? TASK_COLUMNS : tab === 'testtask' ? TESTTASK_COLUMNS : tab === 'report' ? REPORT_COLUMNS : CORE_COLUMNS;

      // Column order/width is user-controlled for the story/bug tables only.
      const columnOrder = colOrder && colOrder.length === COLUMN_KEYS.length ? colOrder : COLUMN_KEYS;
      const orderedColumns = columnOrder
        .map((key) => CORE_COLUMNS.find((column) => column.key === key))
        .filter(Boolean);
      const storyStateColumn = CORE_COLUMNS.find((column) => column.key === 'storyState');
      const visibleColumns = !isCoreTab
        ? ACTIVE_COLUMNS
        : tab === 'story'
          ? (() => {
              const index = orderedColumns.findIndex((column) => column.key === 'status');
              if (index < 0) return orderedColumns.concat([storyStateColumn]);
              return orderedColumns.slice(0, index).concat([storyStateColumn], orderedColumns.slice(index));
            })()
          : orderedColumns;

      const statusLabel = (item) =>
        (item.type === 'story'
          ? item.stage || item.statusText
          : item.type === 'task' || item.type === 'testtask'
            ? item.statusText
            : item.resolution || item.statusText) || '—';
      const renderCell = (item, key) => {
        if (key === 'id') return h('td', { key, className: 'zt-mono' }, item.id);
        if (key === 'title') {
          const nowTitle = new Date();
          const todayTitle = `${nowTitle.getFullYear()}-${String(nowTitle.getMonth() + 1).padStart(2, '0')}-${String(nowTitle.getDate()).padStart(2, '0')}`;
          const overdueTitle =
            item.type === 'task' &&
            !item.done &&
            !['done', 'closed', 'cancel'].includes(item.status) &&
            /^\d{4}-\d{2}-\d{2}$/.test(String(item.deadline || '')) &&
            item.deadline < todayTitle;
          return h(
            'td',
            { key, className: 'zt-title-cell' + (overdueTitle ? ' zt-title-overdue' : '') },
            h(
              'a',
              {
                href: baseUrl + item.url,
                target: '_blank',
                rel: 'noreferrer noopener',
                title: '在新标签页打开禅道',
              },
              item.title,
            ),
          );
        }
        if (key === 'module') {
          if (item.type === 'task' || item.type === 'story') {
            return h(
              'td',
              { key, className: 'zt-col-module' },
              h(
                'button',
                {
                  className: 'zt-cell-action',
                  type: 'button',
                  title: '点击修改所属模块',
                  onClick: (event) => openCellEditor(item, 'module', event),
                },
                h('span', { className: 'zt-cell-text' }, item.moduleName || '未指定模块'),
              ),
            );
          }
          if (item.type !== 'bug') return h('td', { key, className: 'zt-col-module' }, item.moduleName || '—');
          return h(
            'td',
            { key, className: 'zt-col-module' },
            h(
              'button',
              {
                className: 'zt-cell-action',
                type: 'button',
                title: '点击修改模块',
                onClick: (event) => openCellEditor(item, 'module', event),
              },
              h('span', { className: 'zt-cell-text' }, item.moduleName || '未指定模块'),
            ),
          );
        }
        if (key === 'storyState') {
          return h(
            'td',
            { key, className: 'zt-col-storystate' },
            h(
              'button',
              {
                className: 'zt-cell-action',
                type: 'button',
                title: '点击修改状态',
                onClick: (event) => openCellEditor(item, 'storyStatus', event),
              },
              h('span', { className: 'zt-tag zt-tag-' + statusTone(item.status) }, item.statusText || '—'),
            ),
          );
        }
        if (key === 'priority') {
          const tag = item.priority
            ? h('span', { className: 'zt-tag zt-tag-' + priorityTone(item.priority) }, 'P' + item.priority)
            : '—';
          if (item.type === 'task') {
            return h(
              'td',
              { key, className: 'zt-col-priority' },
              h(
                'button',
                {
                  className: 'zt-cell-action',
                  type: 'button',
                  title: '点击修改优先级',
                  onClick: (event) => openCellEditor(item, 'priority', event),
                },
                tag,
              ),
            );
          }
          return h('td', { key, className: 'zt-col-priority' }, tag);
        }
        if (key === 'assignee') {
          return h(
            'td',
            { key, className: 'zt-col-assignee' },
            h(
              'button',
              {
                className: 'zt-cell-action',
                type: 'button',
                title: '点击重新指派',
                onClick: (event) => openCellEditor(item, 'assignee', event),
              },
              h('span', { className: 'zt-cell-text' + (isMine(item) ? ' zt-cell-me' : '') }, item.assignedTo || '未指派'),
            ),
          );
        }
        if (key === 'deadline') {
          const now = new Date();
          const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
          const overdue =
            item.type === 'task' &&
            !item.done &&
            !['done', 'closed', 'cancel'].includes(item.status) &&
            /^\d{4}-\d{2}-\d{2}$/.test(String(item.deadline || '')) &&
            item.deadline < todayKey;
          return h(
            'td',
            { key, className: 'zt-col-deadline' },
            h(
              'button',
              {
                className: 'zt-cell-action' + (overdue ? ' zt-overdue-date' : ''),
                type: 'button',
                title: overdue ? '已延期，点击修改截止日期' : '点击修改截止日期',
                onClick: (event) => openCellEditor(item, 'deadline', event),
              },
              h('span', { className: 'zt-cell-text' }, item.deadline ? shortListDate(item.deadline) : '—'),
            ),
          );
        }
        if (key === 'owner' || key === 'begin' || key === 'end' || key === 'testtaskName' || key === 'date') {
          const text =
            key === 'owner'
              ? item.owner || '—'
              : key === 'testtaskName'
                ? item.testtaskName || '—'
                : key === 'date'
                  ? item.date
                    ? shortListDate(item.date)
                    : '—'
                  : item[key]
                    ? shortListDate(item[key])
                    : '—';
          return h('td', { key }, h('span', { className: 'zt-cell-text' }, text));
        }
        if (item.type !== 'story' && item.type !== 'bug' && item.type !== 'task') {
          return h('td', { key }, h('span', { className: 'zt-tag zt-tag-' + statusTone(item.status) }, statusLabel(item)));
        }
        return h(
          'td',
          { key },
          h(
            'button',
            {
              className: 'zt-cell-action',
              type: 'button',
              title: '点击修改' + (item.type === 'bug' ? '方案' : '状态'),
              onClick: (event) => openCellEditor(item, 'status', event),
            },
            h('span', { className: 'zt-tag zt-tag-' + statusTone(item.status) }, statusLabel(item)),
          ),
        );
      };

      const QUICK_ACTIONS = [
        { key: 'story', label: '录入需求', icon: 'plus' },
        { key: 'bug', label: '录入 BUG', icon: 'plus' },
        { key: 'testcase', label: '生成测试用例', icon: null },
        { key: 'execution', label: '新增迭代', icon: 'plus' },
        { key: 'status', label: '修改状态', icon: null },
      ];

      const quickButtonNodes = (className) =>
        QUICK_ACTIONS.map((action) =>
          h(
            'button',
            {
              key: action.key,
              className: className,
              type: 'button',
              onClick: () =>
                action.key === 'execution' ? startExecutionFlow() : send('', { type: 'quick', value: action.key }),
            },
            action.icon ? h(GlyphIcon, { name: action.icon, size: 16 }) : null,
            action.label,
          ),
        );

      const renderComposerMenu = () => {
        if (!composerMenu) return null;
        const type = composerMenu.type;
        const query = String(composerMenu.query || '').trim().toLowerCase();
        const head =
          type === 'commands'
            ? query
              ? '功能：' + composerMenu.query
              : '更多功能'
            : type === 'at'
              ? query
                ? '迭代：@' + composerMenu.query
                : '选择迭代作为上下文'
              : '选择模型';
        let body = null;
        if (type === 'commands') {
          const list = QUICK_ACTIONS.filter((action) => !query || action.label.toLowerCase().includes(query));
          body = list.length
            ? list.map((action) =>
                h(
                  'button',
                  { key: action.key, className: 'zt-menu-item', type: 'button', onClick: () => runQuickFromMenu(action) },
                  action.icon ? h(GlyphIcon, { name: action.icon, size: 16 }) : h('span', { className: 'zt-menu-icon-placeholder' }),
                  h('span', { className: 'zt-menu-item-main' }, action.label),
                ),
              )
            : h('div', { className: 'zt-menu-empty' }, '没有匹配的功能');
        } else if (type === 'at') {
          const list = (iterationOptions || []).filter(
            (option) =>
              !query ||
              option.name.toLowerCase().includes(query) ||
              option.projectName.toLowerCase().includes(query),
          );
          body = iterationLoading && !iterationOptions
            ? h('div', { className: 'zt-menu-empty' }, '正在读取迭代列表…')
            : list.length
              ? list.slice(0, 60).map((option) =>
                  h(
                    'button',
                    {
                      key: option.projectId + ':' + option.id,
                      className: 'zt-menu-item',
                      type: 'button',
                      onClick: () => selectIterationForContext(option),
                    },
                    h('span', { className: 'zt-menu-item-main' }, option.name),
                    h('span', { className: 'zt-menu-item-meta' }, option.projectName + (option.statusText ? ' · ' + option.statusText : '')),
                  ),
                )
              : h('div', { className: 'zt-menu-empty' }, '没有匹配的迭代');
        } else if (type === 'models') {
          const state = modelState;
          body = !state
            ? h('div', { className: 'zt-menu-empty' }, '正在读取模型列表…')
            : state.groups && state.groups.length
              ? state.groups.map((group) =>
                  h(
                    'div',
                    { key: group.provider, className: 'zt-menu-group' },
                    h('div', { className: 'zt-menu-group-label' }, group.label || group.provider),
                    group.models.map((model) =>
                      h(
                        'button',
                        {
                          key: group.provider + ':' + model.id,
                          className:
                            'zt-menu-item' +
                            (state.current && state.current.provider === group.provider && state.current.model === model.id
                              ? ' zt-menu-item-active'
                              : ''),
                          type: 'button',
                          onClick: () => selectModel(group, model),
                        },
                        h('span', { className: 'zt-menu-item-main' }, model.name || model.id),
                      ),
                    ),
                  ),
                )
              : h('div', { className: 'zt-menu-empty' }, '没有可用的模型');
        }
        return [
          h('div', { key: 'backdrop', className: 'zt-menu-backdrop', onClick: closeComposerMenu }),
          h(
            'div',
            { key: 'menu', className: 'zt-composer-menu' + (type === 'models' ? ' zt-composer-menu-right' : '') },
            h('div', { className: 'zt-menu-head' }, head),
            h('div', { className: 'zt-menu-body' }, body),
          ),
        ];
      };

      const renderHistoryMenu = () => {
        const active = conversations.filter((c) => !c.archived);
        const archived = conversations.filter((c) => c.archived);
        const row = (c) =>
          h(
            'div',
            {
              key: c.id,
              className:
                'zt-history-item' +
                (c.id === activeId ? ' zt-history-item-active' : '') +
                (c.id === editingConvId ? ' zt-history-item-editing' : ''),
            },
            editingConvId === c.id
              ? h(
                  'div',
                  { className: 'zt-history-edit', key: 'edit' },
                  h('input', {
                    className: 'zt-history-input',
                    value: editingTitle,
                    autoFocus: true,
                    maxLength: 80,
                    'aria-label': '修改会话标题',
                    onChange: (e) => setEditingTitle(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        saveConversationTitle(c.id, editingTitle);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setEditingConvId('');
                      }
                    },
                    onBlur: () => {
                      if (editingConvId === c.id) saveConversationTitle(c.id, editingTitle);
                    },
                  }),
                )
              : h(
                  'button',
                  {
                    className: 'zt-history-main',
                    type: 'button',
                    title: c.title || '新会话',
                    onClick: () => {
                      switchConversation(c.id);
                      setHistoryOpen(false);
                    },
                  },
                  h('span', { className: 'zt-history-title' }, c.title || '新会话'),
                  h('span', { className: 'zt-history-time' }, formatChatTime(c.updatedAt)),
                ),
            editingConvId === c.id
              ? null
              : h(
                  'button',
                  {
                    className: 'zt-history-action',
                    type: 'button',
                    title: '重命名会话',
                    'aria-label': '重命名会话',
                    onClick: (e) => {
                      e.stopPropagation();
                      startRenameConversation(c);
                    },
                  },
                  h(GlyphIcon, { name: 'edit', size: 16 }),
                ),
            h(
              'button',
              {
                className: 'zt-history-action',
                type: 'button',
                title: c.archived ? '移出归档' : '归档会话',
                'aria-label': c.archived ? '移出归档' : '归档会话',
                onClick: (e) => {
                  e.stopPropagation();
                  toggleConversationArchived(c.id);
                },
              },
              h(GlyphIcon, { name: c.archived ? 'folder-open' : 'archive', size: 16 }),
            ),
            h(
              'button',
              {
                className: 'zt-history-action',
                type: 'button',
                title: '删除会话',
                'aria-label': '删除会话',
                onClick: (e) => {
                  e.stopPropagation();
                  deleteConversation(c.id);
                },
              },
              h(GlyphIcon, { name: 'trash', size: 16 }),
            ),
          );
        return [
          h('div', { key: 'backdrop', className: 'zt-menu-backdrop', onClick: () => setHistoryOpen(false) }),
          h(
            'div',
            { key: 'menu', className: 'zt-history-menu' },
            h('div', { className: 'zt-history-head' }, '历史会话'),
            h(
              'div',
              { className: 'zt-history-list' },
              active.length ? active.map(row) : h('div', { className: 'zt-history-empty' }, '暂无会话'),
              archived.length
                ? h(
                    'button',
                    {
                      className: 'zt-history-archived-toggle',
                      type: 'button',
                      onClick: () => setShowArchived((v) => !v),
                    },
                    h('span', null, '已归档会话 (' + archived.length + ')'),
                    h(GlyphIcon, { name: showArchived ? 'chevron-down' : 'chevron-right', size: 16 }),
                  )
                : null,
              showArchived ? archived.map(row) : null,
            ),
          ),
        ];
      };

      const startExecutionFlow = async () => {
        try {
          await api('/zentao/api/status-options');
        } catch (error) {
          setActionError('插件宿主端还是旧版本（缺少新增迭代相关接口），请重启 DeepSeek Harness 后再试。');
          return;
        }
        send('', { type: 'quick', value: 'execution' });
      };

      const stripTriggerToken = (value, marker) => {
        const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return value.replace(new RegExp('(^|\\s)' + escaped + '[^\\s' + escaped + ']*$'), '$1').replace(/\s+$/, '');
      };

      const closeComposerMenu = () => setComposerMenu(null);

      const runQuickFromMenu = (action) => {
        setComposerMenu(null);
        const stripped = stripTriggerToken(input, '/');
        if (stripped !== input) setInput(stripped);
        if (action.key === 'execution') startExecutionFlow();
        else send('', { type: 'quick', value: action.key });
      };

      const ensureIterations = async () => {
        if (iterationOptions || iterationLoading) return;
        setIterationLoading(true);
        try {
          const tree = await api('/zentao/api/tree');
          const list = (tree && tree.projects) || [];
          const groups = await Promise.all(
            list.map(async (project) => {
              try {
                const data = await api('/zentao/api/executions?projectId=' + project.id);
                return (data.executions || []).map((exec) => ({
                  projectId: Number(project.id),
                  projectName: project.name,
                  id: Number(exec.id),
                  name: exec.name,
                  status: exec.status,
                  statusText: exec.statusText || '',
                }));
              } catch (error) {
                return [];
              }
            }),
          );
          setIterationOptions(groups.flat());
        } catch (error) {
          setActionError('读取迭代列表失败：' + error.message);
        } finally {
          setIterationLoading(false);
        }
      };

      const selectIterationForContext = (option) => {
        setComposerMenu(null);
        const stripped = stripTriggerToken(input, '@');
        if (stripped !== input) setInput(stripped);
        addContext({
          type: 'execution',
          id: option.id,
          title: option.name,
          projectId: option.projectId,
          projectName: option.projectName,
        });
      };

      const analyzeComposerInput = (value) => {
        const slash = value.match(/(^|\s)\/([^\s/]*)$/);
        if (slash) {
          setComposerMenu({ type: 'commands', query: slash[2] });
          return;
        }
        const at = value.match(/(^|\s)@([^\s@]*)$/);
        if (at) {
          setComposerMenu({ type: 'at', query: at[2] });
          ensureIterations();
          return;
        }
        setComposerMenu((prev) => (prev && (prev.type === 'commands' || prev.type === 'at') ? null : prev));
      };

      const toggleCommandsMenu = () => {
        setComposerMenu((prev) => (prev && prev.type === 'commands' ? null : { type: 'commands', query: '' }));
      };

      const openModelMenu = async () => {
        setComposerMenu((prev) => (prev && prev.type === 'models' ? null : { type: 'models' }));
        if (modelState) return;
        try {
          const data = await api('/zentao/api/models');
          if (!data.ok) throw new Error(data.error || '读取模型失败');
          setModelState(data);
        } catch (error) {
          setComposerMenu(null);
          setActionError('模型选择不可用：' + error.message);
        }
      };

      const selectModel = async (group, model) => {
        try {
          const data = await api('/zentao/api/model', {
            method: 'POST',
            headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
            body: JSON.stringify({ provider: group.provider, model: model.id }),
          });
          if (!data.ok) throw new Error(data.error || '切换失败');
          setModelState((prev) =>
            Object.assign({}, prev || {}, {
              current: { provider: group.provider, model: model.id },
              currentName: model.name,
            }),
          );
          setComposerMenu(null);
        } catch (error) {
          setActionError('切换模型失败：' + error.message);
        }
      };

      const transcribeRecorder = async (rec, session) => {
        const merged = mergeFloat32(rec.chunks);
        if (!merged.length) return '';
        const wav = encodeWavPcm16(resampleLinear(merged, rec.audioCtx.sampleRate, 16000), 16000);
        const data = await api('/zentao/api/transcribe', {
          method: 'POST',
          headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
          body: JSON.stringify({ audioBase64: bytesToBase64(wav) }),
        });
        if (voiceSessionRef.current !== session) return '';
        if (!data.ok) throw new Error(data.error || '识别失败');
        return String(data.text || '').trim();
      };

      const startRecording = async () => {
        if (recording || transcribing || voiceStartingRef.current) return;
        voiceStartingRef.current = true;
        setVoiceStarting(true);
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const AudioCtor = window.AudioContext || window.webkitAudioContext;
          const audioCtx = new AudioCtor({ sampleRate: 16000 });
          const source = audioCtx.createMediaStreamSource(stream);
          const processor = audioCtx.createScriptProcessor(4096, 1, 1);
          const chunks = [];
          processor.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
          source.connect(processor);
          processor.connect(audioCtx.destination);
          recorderRef.current = { stream, audioCtx, source, processor, chunks };
          voiceBaseRef.current = input;
          voiceSessionRef.current += 1;
          const session = voiceSessionRef.current;
          setRecording(true);
          // 边说边识别：每 2.5 秒把已有录音送去识别，实时替换输入框里的转写，
          // 停下时再完整识别一次以拿到最终文本。
          voicePartialTimerRef.current = setInterval(async () => {
            const current = recorderRef.current;
            if (!current || voicePartialBusyRef.current || voiceSessionRef.current !== session) return;
            voicePartialBusyRef.current = true;
            try {
              const text = await transcribeRecorder(current, session);
              if (text && voiceSessionRef.current === session) {
                const base = voiceBaseRef.current.replace(/\s+$/, '');
                setInput((base ? base + ' ' : '') + text);
              }
            } catch (error) {
              /* keep recording; the final pass reports errors */
            } finally {
              voicePartialBusyRef.current = false;
            }
          }, 2500);
        } catch (error) {
          setActionError('无法访问麦克风：' + error.message);
        } finally {
          voiceStartingRef.current = false;
          setVoiceStarting(false);
        }
      };

      const stopRecording = async () => {
        const rec = recorderRef.current;
        if (!rec) return;
        if (voicePartialTimerRef.current) {
          clearInterval(voicePartialTimerRef.current);
          voicePartialTimerRef.current = null;
        }
        recorderRef.current = null;
        setRecording(false);
        setTranscribing(true);
        voiceSessionRef.current += 1;
        const session = voiceSessionRef.current;
        try {
          if (rec.processor) rec.processor.disconnect();
          if (rec.source) rec.source.disconnect();
          rec.stream.getTracks().forEach((track) => track.stop());
          await rec.audioCtx.close();
          const text = await transcribeRecorder(rec, session);
          if (text) {
            const base = String(voiceBaseRef.current || '').replace(/\s+$/, '');
            setInput((base ? base + ' ' : '') + text);
          } else {
            setActionError('没有识别出内容，请重试');
          }
        } catch (error) {
          if (error && error.name === 'AbortError') setActionError('语音识别超时，请重试');
          else setActionError('语音识别失败：' + error.message);
        } finally {
          setTranscribing(false);
        }
      };

      const cellCurrentText = (editor) => {
        if (!editor) return '';
        if (editor.field === 'assignee') {
          return String(editor.item.assignedTo || '').replace(/^[A-Za-z]:/, '').trim();
        }
        if (editor.field === 'module') return String(editor.item.moduleName || '未指定模块');
        if (editor.field === 'priority') return editor.item.priority ? 'P' + editor.item.priority : '';
        return editor.item.type === 'bug'
          ? editor.item.resolution || editor.item.statusText
          : editor.item.stage || editor.item.statusText;
      };

      const openCellEditor = (item, field, event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        setActionError('');
        setCellEditor({ item, field, x: rect.left, y: rect.bottom + 6, options: [], loading: true, busy: false });
        const fail = (message) => {
          setCellEditor(null);
          setActionError(message);
        };
        if (item.type === 'task' && field === 'priority') {
          setCellEditor({
            item,
            field,
            x: rect.left,
            y: rect.bottom + 6,
            options: [
              { value: '1', label: 'P1' },
              { value: '2', label: 'P2' },
              { value: '3', label: 'P3' },
            ],
            loading: false,
            busy: false,
          });
          return;
        }
        if ((item.type === 'task' || item.type === 'story') && field === 'module') {
          api('/zentao/api/' + (item.type === 'task' ? 'task' : 'story') + '-module-options?id=' + item.id)
            .then((data) => {
              if (!data || !data.ok) throw new Error((data && data.error) || '读取模块失败');
              const modules = data.modules || [];
              if (!modules.length) throw new Error('没有可用的模块');
              setCellEditor((prev) =>
                prev && prev.item === item && prev.field === field
                  ? Object.assign({}, prev, {
                      options: modules.map((module) => ({ value: module.value, label: module.label })),
                      loading: false,
                    })
                  : prev,
              );
            })
            .catch((error) => fail(error.message));
          return;
        }
        if (item.type === 'task' && field === 'status') {
          api('/zentao/api/task-status-options?id=' + item.id)
            .then((data) => {
              if (!data || !data.ok) throw new Error((data && data.error) || '读取任务状态失败');
              const options = data.options || [];
              if (!options.length) throw new Error('当前账号没有可执行的任务状态操作');
              setCellEditor((prev) =>
                prev && prev.item === item && prev.field === field
                  ? Object.assign({}, prev, {
                      options: options.map((option) => ({ value: option.key, label: option.label })),
                      loading: false,
                    })
                  : prev,
              );
            })
            .catch((error) => fail(error.message));
          return;
        }
        if (item.type === 'task' && field === 'assignee') {
          api('/zentao/api/task-assign-options?id=' + item.id)
            .then((data) => {
              if (!data || !data.ok) throw new Error((data && data.error) || '读取可指派成员失败');
              const users = data.users || [];
              if (!users.length) throw new Error('没有可指派的成员');
              setCellEditor((prev) =>
                prev && prev.item === item && prev.field === field
                  ? Object.assign({}, prev, {
                      options: users.map((user) => ({ value: user.value, label: user.label })),
                      loading: false,
                    })
                  : prev,
              );
            })
            .catch((error) => fail(error.message));
          return;
        }
        if (field === 'deadline' && item.type === 'task') {
          const today = new Date().toISOString().slice(0, 10);
          setCellEditor({
            item,
            field,
            x: rect.left,
            y: rect.bottom + 6,
            options: [],
            loading: false,
            busy: false,
            dateMode: true,
            dateValue: item.deadline && /^\d{4}-\d{2}-\d{2}$/.test(item.deadline) ? item.deadline : today,
          });
          return;
        }
        if (field === 'status') {
          const load = statusMenu ? Promise.resolve({ ok: true, options: statusMenu }) : api('/zentao/api/status-options');
          load
            .then((data) => {
              const all = (data && data.options) || {};
              if (!statusMenu) setStatusMenu(all);
              const list = (item.type === 'bug' ? all.bug : all.story) || [];
              setCellEditor((prev) =>
                prev && prev.item === item && prev.field === field
                  ? Object.assign({}, prev, {
                      options: list.map((option) => ({ value: option.key, label: option.label })),
                      loading: false,
                    })
                  : prev,
              );
            })
            .catch((error) => fail(error.message));
          return;
        }
        if (field === 'storyStatus') {
          api('/zentao/api/story-status-options?id=' + item.id)
            .then((data) => {
              const options = (data && data.options) || [];
              if (!options.length) throw new Error('当前账号没有可执行的状态操作');
              setCellEditor((prev) =>
                prev && prev.item === item && prev.field === field
                  ? Object.assign({}, prev, { options: options.map((option) => ({ value: option.key, label: option.label })), loading: false })
                  : prev,
              );
            })
            .catch((error) => fail(error.message));
          return;
        }
        if (field === 'module') {
          api('/zentao/api/bug-module-options?id=' + item.id)
            .then((data) => {
              const modules = (data && data.modules) || [];
              if (!modules.length) throw new Error('当前账号没有修改该 BUG 模块的权限');
              setCellEditor((prev) =>
                prev && prev.item === item && prev.field === field
                  ? Object.assign({}, prev, { options: modules.map((module) => ({ value: module.value, label: module.label })), loading: false })
                  : prev,
              );
            })
            .catch((error) => fail(error.message));
          return;
        }
        api('/zentao/api/assign-options?type=' + item.type + '&id=' + item.id)
          .then((data) => {
            setCellEditor((prev) =>
              prev && prev.item === item && prev.field === field
                ? Object.assign({}, prev, {
                    options: (data.users || []).map((user) => ({ value: user.value, label: user.label })),
                    loading: false,
                  })
                : prev,
            );
          })
          .catch((error) => fail(error.message));
      };

      const closeCellEditor = () => setCellEditor(null);

      const applyCellOption = async (option) => {
        const editor = cellEditor;
        if (!editor || editor.busy) return;
        setCellEditor(Object.assign({}, editor, { busy: true }));
        try {
          let result;
          if (editor.field === 'priority' && editor.item.type === 'task') {
            result = await api('/zentao/api/task-priority', {
              method: 'POST',
              headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
              body: JSON.stringify({ id: editor.item.id, priority: Number(option.value) }),
            });
            if (!result.ok) throw new Error(result.error || '优先级修改失败');
          } else if (editor.field === 'module' && (editor.item.type === 'task' || editor.item.type === 'story')) {
            result = await api('/zentao/api/' + (editor.item.type === 'task' ? 'task-module' : 'story-module'), {
              method: 'POST',
              headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
              body: JSON.stringify({ id: editor.item.id, moduleId: Number(option.value) }),
            });
            if (!result.ok) throw new Error(result.error || '模块修改失败');
          } else if (editor.field === 'status' && editor.item.type === 'task') {
            result = await api('/zentao/api/task-status', {
              method: 'POST',
              headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
              body: JSON.stringify({ id: editor.item.id, statusKey: option.value }),
            });
            if (!result.ok) throw new Error(result.error || '任务状态修改失败');
          } else if (editor.field === 'assignee' && editor.item.type === 'task') {
            result = await api('/zentao/api/task-assignee', {
              method: 'POST',
              headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
              body: JSON.stringify({ id: editor.item.id, assignedTo: option.value }),
            });
            if (!result.ok) throw new Error(result.error || '任务指派失败');
          } else if (editor.field === 'status' || editor.field === 'storyStatus') {
            result = await api('/zentao/api/status', {
              method: 'POST',
              headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
              body: JSON.stringify({ targetType: editor.field === 'storyStatus' ? 'storyStatus' : editor.item.type, id: editor.item.id, statusKey: option.value }),
            });
            if (!result.ok) throw new Error(result.error || '状态修改失败');
          } else if (editor.field === 'module') {
            result = await api('/zentao/api/bug-module', {
              method: 'POST',
              headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
              body: JSON.stringify({ id: editor.item.id, moduleId: option.value }),
            });
            if (!result.ok) throw new Error(result.error || '模块修改失败');
          } else {
            result = await api('/zentao/api/assignee', {
              method: 'POST',
              headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
              body: JSON.stringify({ type: editor.item.type, id: editor.item.id, assignedTo: option.value }),
            });
            if (!result.ok) throw new Error(result.error || '指派失败');
          }
          setCellEditor(null);
          if (selection.executionId) await loadItems(selection.executionId, true);
        } catch (error) {
          setCellEditor(null);
          setActionError(error.message);
        }
      };

      const submitTaskDeadline = async () => {
        const editor = cellEditor;
        if (!editor || editor.field !== 'deadline' || editor.busy) return;
        const value = String(editor.dateValue || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          setActionError('请选择截止日期');
          return;
        }
        setCellEditor(Object.assign({}, editor, { busy: true }));
        try {
          const result = await api('/zentao/api/task-deadline', {
            method: 'POST',
            headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
            body: JSON.stringify({ id: editor.item.id, deadline: value }),
          });
          if (!result.ok) throw new Error(result.error || '截止日期修改失败');
          setCellEditor(null);
          if (selection.executionId) await loadItems(selection.executionId, true);
        } catch (error) {
          setCellEditor(null);
          setActionError(error.message);
        }
      };

      const moveColumn = (fromKey, toKey, side) => {
        if (!fromKey || !toKey || fromKey === toKey) return;
        const order = orderedColumns.map((column) => column.key).filter((key) => key !== fromKey);
        let index = order.indexOf(toKey);
        if (index < 0) return;
        if (side === 'after') index += 1;
        order.splice(index, 0, fromKey);
        setColOrder(order);
        saveColOrder(order);
      };

      const toggleSort = (key) => {
        setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
      };

      // Empty cells always sink to the bottom, in both directions.
      const sortedList = (() => {
        if (!sort.key) return list;
        const column = ACTIVE_COLUMNS.find((c) => c.key === sort.key);
        if (!column) return list;
        const direction = sort.dir === 'desc' ? -1 : 1;
        const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
        return list.slice().sort((a, b) => {
          const va = column.value(a);
          const vb = column.value(b);
          const emptyA = va === null || va === '' || va === undefined;
          const emptyB = vb === null || vb === '' || vb === undefined;
          if (emptyA && emptyB) return 0;
          if (emptyA) return 1;
          if (emptyB) return -1;
          if (column.type === 'number') return (va - vb) * direction;
          return collator.compare(String(va), String(vb)) * direction;
        });
      })();

      // Client-side auto filter over the tree: project matches keep all their
      // iterations; iteration matches narrow the children list.
      const query = filter.trim().toLowerCase();
      const hit = (id, name) =>
        !query || String(name || '').toLowerCase().indexOf(query) >= 0 || String(id).indexOf(query) >= 0;
      // "显示进行中": only items whose status is doing; off shows everything.
      const showProject = (project) => !showActiveOnly || project.status === 'doing';
      const showExecution = (execution) => !showActiveOnly || execution.status === 'doing';
      const visibleProjects = projects
        .filter(showProject)
        .map((project) => {
          const projectHit = hit(project.id, project.name);
          const all = (execs[project.id] || []).filter(showExecution);
          const execHits = query ? all.filter((e) => hit(e.id, e.name)) : all;
          const show = !query || projectHit || execHits.length > 0;
          return { project, show, projectHit, execs: query && !projectHit ? execHits : all };
        })
        .filter((item) => item.show)
        .sort((a, b) => {
          if (!treeSort.key) return 0;
          const direction = treeSort.dir === 1 ? 1 : -1;
          if (treeSort.key === 'name') {
            const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
            return collator.compare(a.project.name, b.project.name) * direction;
          }
          if (treeSort.key === 'status') {
            const rankA = projectStatusRank(a.project.status);
            const rankB = projectStatusRank(b.project.status);
            if (rankA !== rankB) return (rankA - rankB) * direction;
            return a.project.name.localeCompare(b.project.name, 'zh-Hans-CN');
          }
          return 0;
        });

      const nativeMode = chatMode === 'native';
      if (chatMode === null) {
        return h(
          'div',
          { className: 'zt-root zt-boot' + (isMac ? ' zt-mac' : '') },
          h('div', { className: 'zt-boot-hint' }, '正在加载禅道工作台…'),
        );
      }

      const renderCalendar = () => {
        const isWeek = calendarMode === 'week';
        const pad = (value) => String(value).padStart(2, '0');
        const dateKeyOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
        const today = new Date();
        const todayKey = dateKeyOf(today);
        const byDate = new Map();
        const calendarTasks = showDoneTasks ? myTasks.tasks : myTasks.tasks.filter((task) => !task.done);
        for (const task of calendarTasks || []) {
          if (!task.deadline) continue;
          if (!byDate.has(task.deadline)) byDate.set(task.deadline, []);
          byDate.get(task.deadline).push(task);
        }
        const weekNames = ['一', '二', '三', '四', '五', '六', '日'];
        const buildCell = (date) => {
          const key = dateKeyOf(date);
          const weekend = date.getDay() === 0 || date.getDay() === 6;
          return h(
            'div',
            {
              key,
              className:
                'zt-cal-cell' +
                (weekend ? ' zt-cal-weekend' : '') +
                (key === todayKey ? ' zt-cal-today' : '') +
                (key === selectedDate ? ' zt-cal-selected' : ''),
              onClick: () => setSelectedDate(key),
              onDoubleClick: () => openTaskModal(key),
              onDragOver: (event) => event.preventDefault(),
              onDrop: (event) => {
                event.preventDefault();
                const task = dragTaskRef.current;
                dragTaskRef.current = null;
                if (task) moveTaskDeadline(task, key);
              },
            },
            (() => {
              const calLabel = lunarLabelOf(date);
              return h(
                'div',
                { className: 'zt-cal-day' },
                h(
                  'span',
                  { className: 'zt-cal-day-left' },
                  h('span', { className: 'zt-cal-day-num' }, date.getDate()),
                  CN_DAY_TAGS[key]
                    ? h(
                        'span',
                        {
                          className:
                            'zt-cal-holiday ' + (CN_DAY_TAGS[key] === '休' ? 'zt-cal-holiday-rest' : 'zt-cal-holiday-work'),
                        },
                        CN_DAY_TAGS[key],
                      )
                    : null,
                ),
                calLabel
                  ? h(
                      'span',
                      { className: 'zt-cal-lunar zt-cal-lunar-' + calLabel.type },
                      calLabel.text,
                    )
                  : null,
              );
            })(),
            h(
              'div',
              { className: 'zt-cal-tasks' + (isWeek ? '' : ' zt-cal-tasks-month') },
              (byDate.get(key) || [])
                .slice()
                .sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0))
                .slice(0, isWeek ? undefined : 3)
                .map((task) => {
                  const chipClass =
                    'zt-cal-task' +
                    (isWeek ? ' zt-cal-task-week' : ' zt-cal-task-month') +
                    (task.done ? ' zt-cal-task-done' : '');
                  const link = h(
                    'a',
                    {
                      className: 'zt-cal-task-link',
                      href: baseUrl + task.url,
                      target: '_blank',
                      rel: 'noreferrer noopener',
                      title: task.title,
                      draggable: false,
                      onClick: (event) => event.stopPropagation(),
                      onDoubleClick: (event) => event.stopPropagation(),
                    },
                    task.title,
                  );
                  if (isWeek) {
                    return h(
                      'div',
                      {
                        key: task.id,
                        className: chipClass,
                        draggable: !task.done,
                        onDragStart: task.done
                          ? undefined
                          : () => {
                              dragTaskRef.current = task;
                            },
                        onDragEnd: () => {
                          dragTaskRef.current = null;
                        },
                        onDoubleClick: (event) => event.stopPropagation(),
                      },
                      h('input', {
                        type: 'checkbox',
                        className: 'zt-cal-task-check',
                        checked: Boolean(task.done),
                        disabled: Boolean(task.done) || completingTasks.includes(task.id),
                        'aria-label': '标记完成：' + task.title,
                        onClick: (event) => event.stopPropagation(),
                        onChange: () => completeTask(task),
                      }),
                      link,
                    );
                  }
                  return h(
                    'a',
                    {
                      key: task.id,
                      className: chipClass,
                      href: baseUrl + task.url,
                      target: '_blank',
                      rel: 'noreferrer noopener',
                      title: task.title,
                      draggable: !task.done,
                      onDragStart: task.done
                        ? undefined
                        : () => {
                            dragTaskRef.current = task;
                          },
                      onDragEnd: () => {
                        dragTaskRef.current = null;
                      },
                      onDoubleClick: (event) => event.stopPropagation(),
                    },
                    task.title,
                  );
                }),
            ),
          );
        };
        let cells = [];
        let titleText = '';
        if (!isWeek) {
          const year = calendarMonth.year;
          const month = calendarMonth.month;
          const first = new Date(year, month - 1, 1);
          const startOffset = (first.getDay() + 6) % 7;
          const days = new Date(year, month, 0).getDate();
          for (let i = 0; i < startOffset; i += 1) {
            cells.push(h('div', { key: 'blank-' + i, className: 'zt-cal-cell zt-cal-blank' }));
          }
          for (let day = 1; day <= days; day += 1) {
            cells.push(buildCell(new Date(year, month - 1, day)));
          }
          while (cells.length < 42) cells.push(h('div', { key: 'tail-' + cells.length, className: 'zt-cal-cell zt-cal-blank' }));
          titleText = year + ' / ' + String(month).padStart(2, '0');
        } else {
          const anchor = weekAnchor ? new Date(weekAnchor + 'T00:00:00') : today;
          const monday = new Date(anchor);
          monday.setDate(anchor.getDate() - ((anchor.getDay() + 6) % 7));
          for (let i = 0; i < 7; i += 1) {
            const date = new Date(monday);
            date.setDate(monday.getDate() + i);
            cells.push(buildCell(date));
          }
          const sunday = new Date(monday);
          sunday.setDate(monday.getDate() + 6);
          titleText =
            monday.getFullYear() +
            ' / ' +
            String(monday.getMonth() + 1).padStart(2, '0') +
            ' / ' +
            String(monday.getDate()).padStart(2, '0') +
            ' - ' +
            (sunday.getFullYear() !== monday.getFullYear() ? sunday.getFullYear() + ' / ' : '') +
            String(sunday.getMonth() + 1).padStart(2, '0') +
            ' / ' +
            String(sunday.getDate()).padStart(2, '0');
        }
        const shift = (delta) => {
          if (isWeek) {
            const anchor = weekAnchor ? new Date(weekAnchor + 'T00:00:00') : new Date(today);
            anchor.setDate(anchor.getDate() + delta * 7);
            setWeekAnchor(dateKeyOf(anchor));
            setCalendarMonth({ year: anchor.getFullYear(), month: anchor.getMonth() + 1 });
          } else {
            setCalendarMonth((prev) => {
              const next = new Date(prev.year, prev.month - 1 + delta, 1);
              return { year: next.getFullYear(), month: next.getMonth() + 1 };
            });
          }
        };
        const goToday = () => {
          const now = new Date();
          setCalendarMonth({ year: now.getFullYear(), month: now.getMonth() + 1 });
          setSelectedDate(dateKeyOf(now));
          setWeekAnchor(dateKeyOf(now));
        };
        return h(
          'section',
          { className: 'zt-cal', 'aria-label': '任务日历' },
          h(
            'div',
            { className: 'zt-cal-head' },
            h(
              'div',
              { className: 'zt-cal-title-wrap' },
              h(
                'div',
                { className: 'zt-cal-title-line' },
                h('div', { className: 'zt-cal-title' }, '任务日历'),
                h(
                  'label',
                  { className: 'zt-cal-done-toggle', title: '在日历上显示/隐藏已完成任务' },
                  h('input', {
                    type: 'checkbox',
                    checked: showDoneTasks,
                    onChange: (event) => setShowDoneTasks(event.target.checked),
                  }),
                  h('span', null, '显示已完成'),
                ),
              ),
              h('div', { className: 'zt-cal-sub' }, '双击日期空白处新建任务，拖动任务可改截止日期'),
            ),
            h(
              'div',
              { className: 'zt-cal-actions' },
                h(
                  'div',
                  { className: 'zt-cal-mode', role: 'tablist', 'aria-label': '日历视图' },
                  h(
                    'button',
                    {
                      type: 'button',
                      role: 'tab',
                      className: 'zt-cal-mode-btn' + (isWeek ? ' zt-cal-mode-btn-active' : ''),
                      'aria-selected': isWeek ? 'true' : 'false',
                      onClick: () => {
                        setWeekAnchor(selectedDate || dateKeyOf(today));
                        setCalendarMode('week');
                      },
                    },
                    '周视图',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      role: 'tab',
                      className: 'zt-cal-mode-btn' + (!isWeek ? ' zt-cal-mode-btn-active' : ''),
                      'aria-selected': !isWeek ? 'true' : 'false',
                      onClick: () => setCalendarMode('month'),
                    },
                    '月视图',
                  ),
                ),
              h(
                'button',
                {
                  className: 'zt-icon-btn',
                  type: 'button',
                  title: isWeek ? '上一周' : '上个月',
                  'aria-label': isWeek ? '上一周' : '上个月',
                  onClick: () => shift(-1),
                },
                h(GlyphIcon, { name: 'chevron-left', size: 16 }),
              ),
              h('span', { className: 'zt-cal-month' }, titleText),
              h(
                'button',
                {
                  className: 'zt-icon-btn',
                  type: 'button',
                  title: isWeek ? '下一周' : '下个月',
                  'aria-label': isWeek ? '下一周' : '下个月',
                  onClick: () => shift(1),
                },
                h(GlyphIcon, { name: 'chevron-right', size: 16 }),
              ),
              h(
                'button',
                {
                  className: 'zt-icon-btn' + (myTasks.loading ? ' zt-spinning' : ''),
                  type: 'button',
                  title: myTasks.loading ? '刷新中…' : '刷新日历任务',
                  'aria-label': '刷新日历任务',
                  disabled: myTasks.loading,
                  onClick: () => loadMyTasks(true),
                },
                h(GlyphIcon, { name: 'refresh', size: 16 }),
              ),
              h('button', { className: 'zt-cal-today-btn', type: 'button', onClick: goToday }, '回到今天'),
            ),
          ),
          myTasks.error
            ? h('div', { className: 'zt-cal-error' }, '刷新任务失败：' + myTasks.error)
            : null,
          h(
            'div',
            { className: 'zt-cal-grid' + (isWeek ? ' zt-cal-grid-week' : '') },
            ['一', '二', '三', '四', '五', '六', '日'].map((label) =>
              h(
                'div',
                { key: label, className: 'zt-cal-week' + (label === '六' || label === '日' ? ' zt-cal-week-weekend' : '') },
                '周' + label,
              ),
            ),
            cells,
          ),
        );
      };

      const modelLabel = (id) =>
        String(id || '')
          .split(/[-_]/)
          .filter(Boolean)
          .map((part) => (part.toLowerCase() === 'deepseek' ? 'DeepSeek' : part.charAt(0).toUpperCase() + part.slice(1)))
          .join('-');

      const fieldLabel = (text, required) =>
        h(
          'span',
          { className: 'zt-field-label' },
          required ? h('span', { className: 'zt-field-required', 'aria-hidden': true }, '*') : null,
          h('span', { className: 'zt-field-label-text' }, text),
        );

      const renderTaskModal = () => {
        if (!taskModal) return null;
        const iterations = taskModal.iterations || [];
        const users = taskModal.users || [];
        const selectedIteration = iterations.find((item) => item.id === Number(taskModal.executionId));
        const selectedUser = users.find((user) => user.value === taskModal.assignedTo);
        const stories = taskModal.stories || [];
        const selectedStory = stories.find((item) => item.id === Number(taskModal.storyId));
        const storyQuery = String(taskModal.storyQuery || '').trim().toLowerCase();
        const filteredStories = stories.filter(
          (item) => !storyQuery || ('#' + item.id + ' ' + item.title).toLowerCase().includes(storyQuery),
        );
        const query = String(taskModal.iterationQuery || '').trim().toLowerCase();
        const matchIteration = (item) =>
          !query || ((item.projectName || '') + ' / ' + (item.name || '')).toLowerCase().includes(query);
        const doingIterations = iterations.filter((item) => item.status === 'doing' && matchIteration(item));
        const waitIterations = iterations.filter((item) => item.status === 'wait' && matchIteration(item));
        const closeDropdowns = () =>
          setTaskModal((prev) =>
            prev ? Object.assign({}, prev, { iterationOpen: false, assigneeOpen: false, storyOpen: false }) : prev,
          );
        const statusPill = (status) =>
          h(
            'span',
            { className: 'zt-option-status' },
            h('span', { className: 'zt-status-dot zt-status-dot-' + (status === 'doing' ? 'doing' : 'wait') }),
            h('span', { className: 'zt-option-status-text' }, status === 'doing' ? '进行中' : '未开始'),
          );
        const renderIterationGroup = (label, items) =>
          items.length
            ? [
                h('div', { key: 'group-' + label, className: 'zt-select-group' }, label),
                ...items.map((item) =>
                  h(
                    'button',
                    {
                      key: 'iter-' + item.id,
                      type: 'button',
                      className:
                        'zt-select-option' + (Number(taskModal.executionId) === item.id ? ' zt-select-option-active' : ''),
                      onClick: (event) => {
                        event.stopPropagation();
                        const executionId = item.id;
                        setTaskModal((prev) =>
                          prev
                            ? Object.assign({}, prev, {
                                executionId: String(executionId),
                                projectId: item.projectId,
                                assignedTo: '',
                                users: [],
                                storyId: '',
                                storyQuery: '',
                                stories: [],
                                storyOpen: false,
                                iterationOpen: false,
                                iterationQuery: '',
                                error: '',
                              })
                            : prev,
                        );
                        loadTaskModalUsers(executionId);
                        loadTaskModalStories(executionId);
                      },
                    },
                    h('span', { className: 'zt-select-option-label' }, (item.projectName ? item.projectName + ' / ' : '') + item.name),
                    statusPill(item.status),
                  ),
                ),
              ]
            : [];
        return h(
          'dialog',
          {
            className: 'zt-modal-dialog',
            ref: modalDialogRef,
            'aria-label': '新建任务',
            onCancel: (event) => {
              event.preventDefault();
              setTaskModal(null);
            },
          },
          h(
            'div',
            {
              className: 'zt-modal',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': '新建任务',
              onClick: (event) => event.stopPropagation(),
            },
            h(
              'div',
              { className: 'zt-modal-head' },
              h('span', { className: 'zt-modal-title' }, '新建任务'),
              h(
                'button',
                { className: 'zt-modal-close', type: 'button', title: '关闭', 'aria-label': '关闭', onClick: () => setTaskModal(null) },
                h(GlyphIcon, { name: 'close', size: 16 }),
              ),
            ),
            h(
              'div',
              { className: 'zt-modal-body', onClick: closeDropdowns },
              h(
                'label',
                { className: 'zt-field' },
                fieldLabel('任务标题', true),
                h('input', {
                  className: 'zt-input',
                  type: 'text',
                  value: taskModal.title,
                  placeholder: '请输入任务标题',
                  autoFocus: true,
                  onChange: (event) => setTaskModal((prev) => (prev ? Object.assign({}, prev, { title: event.target.value, error: '' }) : prev)),
                }),
              ),
              h(
                'div',
                {
                  className: 'zt-field',
                  onClick: (event) => event.stopPropagation(),
                },
                fieldLabel('迭代', true),
                h(
                  'div',
                  { className: 'zt-select-field' + (taskModal.iterationOpen ? ' zt-select-field-open' : '') },
                  h(
                    'button',
                    {
                      className: 'zt-select-trigger' + (taskModal.loading ? ' zt-select-trigger-disabled' : ''),
                      type: 'button',
                      disabled: taskModal.loading,
                      'aria-haspopup': 'listbox',
                      'aria-expanded': taskModal.iterationOpen ? 'true' : 'false',
                      onClick: () =>
                        setTaskModal((prev) =>
                          prev
                            ? Object.assign({}, prev, {
                                iterationOpen: !prev.iterationOpen,
                                iterationQuery: '',
                                assigneeOpen: false,
                              })
                            : prev,
                        ),
                    },
                    selectedIteration
                      ? h(
                          'span',
                          { className: 'zt-select-value' },
                          (selectedIteration.projectName ? selectedIteration.projectName + ' / ' : '') + selectedIteration.name,
                        )
                      : h('span', { className: 'zt-select-placeholder' }, taskModal.loading ? '正在读取迭代…' : '请选择迭代'),
                    h('span', { className: 'zt-select-arrow' }, h(GlyphIcon, { name: 'chevron-down', size: 16 })),
                  ),
                  taskModal.iterationOpen
                    ? h(
                        'div',
                        { className: 'zt-select-popup', role: 'listbox' },
                        h('div', { className: 'zt-select-search-wrap', onClick: (event) => event.stopPropagation() },
                          h('input', {
                            className: 'zt-select-search',
                            type: 'search',
                            placeholder: '输入关键词筛选迭代…',
                            value: taskModal.iterationQuery || '',
                            autoFocus: true,
                            onChange: (event) =>
                              setTaskModal((prev) => (prev ? Object.assign({}, prev, { iterationQuery: event.target.value }) : prev)),
                            onKeyDown: (event) => {
                              if (event.key === 'Escape') {
                                event.stopPropagation();
                                setTaskModal((prev) => (prev ? Object.assign({}, prev, { iterationOpen: false }) : prev));
                              }
                            },
                          }),
                        ),
                        doingIterations.length || waitIterations.length
                          ? [
                              ...renderIterationGroup('进行中', doingIterations),
                              ...renderIterationGroup('未开始', waitIterations),
                            ]
                          : h('div', { className: 'zt-select-empty' }, query ? '没有匹配的迭代' : '暂无可用迭代'),
                      )
                    : null,
                ),
              ),
              h(
                'div',
                { className: 'zt-field', onClick: (event) => event.stopPropagation() },
                fieldLabel('关联研发需求', false),
                h(
                  'div',
                  { className: 'zt-select-field' + (taskModal.storyOpen ? ' zt-select-field-open' : '') },
                  h(
                    'button',
                    {
                      className:
                        'zt-select-trigger' +
                        (!taskModal.executionId || taskModal.loadingStories ? ' zt-select-trigger-disabled' : ''),
                      type: 'button',
                      disabled: !taskModal.executionId || taskModal.loadingStories,
                      'aria-haspopup': 'listbox',
                      'aria-expanded': taskModal.storyOpen ? 'true' : 'false',
                      onClick: () =>
                        setTaskModal((prev) =>
                          prev
                            ? Object.assign({}, prev, {
                                storyOpen: !prev.storyOpen,
                                storyQuery: '',
                                iterationOpen: false,
                                assigneeOpen: false,
                              })
                            : prev,
                        ),
                    },
                    selectedStory
                      ? h(
                          'span',
                          { className: 'zt-select-value' },
                          '#' + selectedStory.id + ' ' + selectedStory.title,
                        )
                      : h(
                          'span',
                          { className: 'zt-select-placeholder' },
                          !taskModal.executionId
                            ? '请先选择迭代'
                            : taskModal.loadingStories
                              ? '正在读取需求…'
                              : '选填，可关联该迭代下的研发需求',
                        ),
                    h('span', { className: 'zt-select-arrow' }, h(GlyphIcon, { name: 'chevron-down', size: 16 })),
                  ),
                  taskModal.storyOpen
                    ? h(
                        'div',
                        { className: 'zt-select-popup', role: 'listbox' },
                        h(
                          'div',
                          { className: 'zt-select-search-wrap', onClick: (event) => event.stopPropagation() },
                          h('input', {
                            className: 'zt-select-search',
                            type: 'search',
                            placeholder: '输入关键词筛选研发需求…',
                            value: taskModal.storyQuery || '',
                            autoFocus: true,
                            onChange: (event) =>
                              setTaskModal((prev) => (prev ? Object.assign({}, prev, { storyQuery: event.target.value }) : prev)),
                          }),
                        ),
                        filteredStories.length
                          ? filteredStories.map((item) =>
                              h(
                                'button',
                                {
                                  key: 'story-' + item.id,
                                  type: 'button',
                                  className:
                                    'zt-select-option' + (Number(taskModal.storyId) === item.id ? ' zt-select-option-active' : ''),
                                  onClick: (event) => {
                                    event.stopPropagation();
                                    setTaskModal((prev) =>
                                      prev
                                        ? Object.assign({}, prev, {
                                            storyId: String(item.id),
                                            storyOpen: false,
                                            storyQuery: '',
                                          })
                                        : prev,
                                    );
                                  },
                                },
                                h('span', { className: 'zt-select-option-label' }, '#' + item.id + ' ' + item.title),
                              ),
                            )
                          : h(
                              'div',
                              { className: 'zt-select-empty' },
                              storyQuery ? '没有匹配的研发需求' : '该迭代下暂无研发需求',
                            ),
                      )
                    : null,
                ),
              ),
              h(
                'label',
                { className: 'zt-field' },
                fieldLabel('优先级', false),
                h(
                  'select',
                  {
                    className: 'zt-input',
                    value: taskModal.priority || '3',
                    onChange: (event) =>
                      setTaskModal((prev) => (prev ? Object.assign({}, prev, { priority: event.target.value }) : prev)),
                  },
                  h('option', { value: '1' }, 'P1'),
                  h('option', { value: '2' }, 'P2'),
                  h('option', { value: '3' }, 'P3'),
                ),
              ),
              h(
                'div',
                { className: 'zt-field', onClick: (event) => event.stopPropagation() },
                fieldLabel('指派给', true),
                h(
                  'div',
                  { className: 'zt-select-field' + (taskModal.assigneeOpen ? ' zt-select-field-open' : '') },
                  h(
                    'button',
                    {
                      className:
                        'zt-select-trigger' +
                        (!taskModal.executionId || taskModal.loadingUsers ? ' zt-select-trigger-disabled' : ''),
                      type: 'button',
                      disabled: !taskModal.executionId || taskModal.loadingUsers,
                      'aria-haspopup': 'listbox',
                      'aria-expanded': taskModal.assigneeOpen ? 'true' : 'false',
                      onClick: () =>
                        setTaskModal((prev) =>
                          prev
                            ? Object.assign({}, prev, { assigneeOpen: !prev.assigneeOpen, iterationOpen: false })
                            : prev,
                        ),
                    },
                    selectedUser
                      ? h('span', { className: 'zt-select-value' }, selectedUser.label)
                      : h(
                          'span',
                          { className: 'zt-select-placeholder' },
                          !taskModal.executionId ? '请先选择迭代' : taskModal.loadingUsers ? '正在读取成员…' : '请选择指派人',
                        ),
                    h('span', { className: 'zt-select-arrow' }, h(GlyphIcon, { name: 'chevron-down', size: 16 })),
                  ),
                  taskModal.assigneeOpen
                    ? h(
                        'div',
                        { className: 'zt-select-popup', role: 'listbox' },
                        users.length
                          ? users.map((user) =>
                              h(
                                'button',
                                {
                                  key: 'user-' + user.value,
                                  type: 'button',
                                  className:
                                    'zt-select-option' + (taskModal.assignedTo === user.value ? ' zt-select-option-active' : ''),
                                  onClick: (event) => {
                                    event.stopPropagation();
                                    setTaskModal((prev) => (prev ? Object.assign({}, prev, { assignedTo: user.value, assigneeOpen: false }) : prev));
                                  },
                                },
                                h('span', { className: 'zt-select-option-label' }, user.label),
                              ),
                            )
                          : h('div', { className: 'zt-select-empty' }, '暂无可指派成员'),
                      )
                    : null,
                ),
              ),
              h(
                'label',
                { className: 'zt-field' },
                fieldLabel('截止日期', true),
                h('input', {
                  className: 'zt-input',
                  type: 'date',
                  value: taskModal.deadline,
                  onChange: (event) => setTaskModal((prev) => (prev ? Object.assign({}, prev, { deadline: event.target.value }) : prev)),
                }),
              ),
              h(
                'label',
                { className: 'zt-field' },
                fieldLabel('任务描述', false),
                h('textarea', {
                  className: 'zt-textarea',
                  rows: 3,
                  value: taskModal.description || '',
                  placeholder: '选填，补充任务背景或验收点',
                  onChange: (event) =>
                    setTaskModal((prev) => (prev ? Object.assign({}, prev, { description: event.target.value }) : prev)),
                }),
              ),
              taskModal.error ? h('div', { className: 'zt-field-error' }, taskModal.error) : null,
            ),
            h(
              'div',
              { className: 'zt-modal-foot' },
              h('button', { className: 'zt-btn zt-btn-ghost', type: 'button', onClick: () => setTaskModal(null) }, '取消'),
              h(
                'button',
                { className: 'zt-btn zt-btn-primary', type: 'button', disabled: taskModal.submitting, onClick: submitTaskModal },
                taskModal.submitting ? '创建中…' : '确定',
              ),
            ),
          ),
        );
      };

      const renderDashboard = () => {
        const data = dashboard.data;
        const todayKey = (() => {
          const now = new Date();
          return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        })();
        const isOverdue = (item) =>
          Boolean(item && /^\d{4}-\d{2}-\d{2}$/.test(String(item.deadline || '')) && item.deadline < todayKey);
        const overdueCount = (key) => ((data && data.lists && data.lists[key]) || []).filter(isOverdue).length;
        const range = data ? data.weekStart + ' ~ ' + data.weekEnd : '';
        const cards = [
          { key: 'story', label: '研发需求' },
          { key: 'bug', label: 'BUG' },
          { key: 'task', label: '任务' },
        ];
        const lists = [
          { key: 'story', label: '本周待完成的研发需求' },
          { key: 'bug', label: '本周待完成的 BUG' },
          { key: 'task', label: '本周待完成的任务' },
        ];
        return h(
          'div',
          { className: 'zt-dash-inner' },
          h('div', { className: 'zt-dash-dragbar', 'aria-hidden': true }),
          h(
            'div',
            { className: 'zt-dash-top' },
            h(
              'div',
              { className: 'zt-dash-title-wrap' },
              h('div', { className: 'zt-dash-title' }, '我的仪表盘'),
              h(
                'div',
                { className: 'zt-dash-sub' },
                (range ? '本周 ' + range + ' · ' : '') + '只看指派给我的未完成事项',
              ),
            ),
            h(
              'button',
              {
                className: 'zt-icon-btn' + (dashboard.loading ? ' zt-spinning' : ''),
                type: 'button',
                title: '刷新仪表盘',
                'aria-label': '刷新仪表盘',
                disabled: dashboard.loading,
                onClick: () => {
                  loadDashboard(true);
                  loadMyTasks(true);
                },
              },
              h(GlyphIcon, { name: 'refresh', size: 16 }),
            ),
          ),
          dashboard.error ? h('div', { className: 'zt-dash-error' }, '加载失败：' + dashboard.error) : null,
          !data && dashboard.loading ? h('div', { className: 'zt-dash-loading' }, '正在统计本周待办…') : null,
          data
            ? h(
                'div',
                { className: 'zt-dash-cards' },
                cards.map((card) =>
                  h(
                    'div',
                    { key: card.key, className: 'zt-dash-card zt-dash-card-' + card.key },
                    h('div', { className: 'zt-dash-card-label' }, card.label),
                    overdueCount(card.key)
                      ? h('span', { className: 'zt-dash-overdue-badge' }, '延期 ' + overdueCount(card.key))
                      : null,
                    h('div', { className: 'zt-dash-card-count' }, String((data.totals && data.totals[card.key]) || 0)),
                    h('div', { className: 'zt-dash-card-meta' }, '本周待完成'),
                  ),
                ),
              )
            : null,
          data
            ? h(
                'div',
                { className: 'zt-dash-lists' },
                lists.map((section) => {
                  const rows = (data.lists && data.lists[section.key]) || [];
                  return h(
                    'div',
                    { key: section.key, className: 'zt-dash-list' },
                    h(
                      'div',
                      { className: 'zt-dash-list-head zt-dash-list-head-' + section.key },
                      h('span', { className: 'zt-dash-list-label' }, section.label),
                      h('span', { className: 'zt-dash-list-count' }, String(rows.length)),
                    ),
                    h(
                      'div',
                      { className: 'zt-dash-list-body' },
                      rows.length
                        ? rows.map((item) =>
                            h(
                              'a',
                              {
                                key: section.key + '-' + item.id,
                                className: 'zt-dash-row',
                                href: baseUrl + item.url,
                                target: '_blank',
                                rel: 'noreferrer noopener',
                                title: '在禅道打开',
                              },
                              h('span', { className: 'zt-dash-row-dot zt-dash-dot-' + section.key, 'aria-hidden': true }),
                              isOverdue(item) ? h('span', { className: 'zt-dash-row-overdue' }, '延期') : null,
                              h('span', { className: 'zt-dash-row-title' }, item.title),
                              h(
                                'span',
                                { className: 'zt-dash-row-date' },
                                (() => {
                                  const value = String(item.deadline || '');
                                  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
                                  if (!match) return value || '—';
                                  return match[1] === String(new Date().getFullYear()) ? match[2] + '-' + match[3] : value;
                                })(),
                              ),
                            ),
                          )
                        : h('div', { className: 'zt-dash-empty' }, '暂无'),
                    ),
                  );
                }),
              )
            : null,
          data ? renderCalendar() : null,
        );
      };

      const renderTabs = (items, active, onSelect) =>
        h(
          'div',
          { className: 'zt-tabs', role: 'tablist' },
          items.map((item) =>
            h(
              'button',
              {
                key: item.key,
                type: 'button',
                role: 'tab',
                'aria-selected': active === item.key ? 'true' : 'false',
                className: 'zt-tab' + (active === item.key ? ' zt-tab-active' : ''),
                onClick: () => onSelect(item.key),
              },
              item.label,
              item.count === undefined || item.count === null ? null : h('span', { className: 'zt-count' }, String(item.count)),
            ),
          ),
        );

      const buildPageItems = (page, pageCount) => {
        if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
        const wanted = new Set([1, pageCount, page - 1, page, page + 1]);
        if (page <= 3) [2, 3, 4].forEach((n) => wanted.add(n));
        if (page >= pageCount - 2) [pageCount - 1, pageCount - 2, pageCount - 3].forEach((n) => wanted.add(n));
        const sorted = [...wanted].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
        const items = [];
        let previous = 0;
        for (const value of sorted) {
          if (previous && value - previous > 1) items.push('...');
          items.push(value);
          previous = value;
        }
        return items;
      };

      const renderTeamPager = ({ total, page, pageCount, pageSize, setPage, setPageSize }) =>
        h(
          'div',
          { className: 'zt-team-pager' },
          h('span', { className: 'zt-team-total' }, '共 ' + total + ' 条数据'),
          h(
            'div',
            { className: 'zt-team-pager-right' },
            h(
              'select',
              {
                className: 'zt-team-input zt-team-page-size',
                value: String(pageSize),
                onChange: (event) => {
                  setPageSize(Number(event.target.value) || 20);
                  setPage(1);
                },
              },
              [10, 20, 50, 100, 200].map((size) => h('option', { key: size, value: String(size) }, size + ' 条/页')),
            ),
            h(
              'button',
              { className: 'zt-page-arrow', type: 'button', 'aria-label': '上一页', disabled: page <= 1, onClick: () => setPage(page - 1) },
              h(GlyphIcon, { name: 'chevron-left', size: 14 }),
            ),
            buildPageItems(page, pageCount).map((item, index) =>
              item === '...'
                ? h('span', { key: 'gap-' + index, className: 'zt-page-ellipsis' }, '…')
                : h(
                    'button',
                    {
                      key: item,
                      type: 'button',
                      className: 'zt-page-btn' + (item === page ? ' zt-page-btn-active' : ''),
                      onClick: () => setPage(item),
                    },
                    String(item),
                  ),
            ),
            h(
              'button',
              { className: 'zt-page-arrow', type: 'button', 'aria-label': '下一页', disabled: page >= pageCount, onClick: () => setPage(page + 1) },
              h(GlyphIcon, { name: 'chevron-right', size: 14 }),
            ),
          ),
        );

      const renderTeamRange = ({ start, end, startRef, endRef, onStart, onEnd, ariaStart, ariaEnd }) =>
        h(
          'div',
          { className: 'zt-team-range' },
          h('input', {
            className: 'zt-team-range-text',
            value: start || '',
            placeholder: '选择时间',
            readOnly: true,
            'aria-label': ariaStart,
            onClick: () => {
              try {
                startRef.current && startRef.current.showPicker();
              } catch (error) {
                startRef.current && startRef.current.focus();
              }
            },
          }),
          h('span', { className: 'zt-team-range-sep' }, '—'),
          h('input', {
            className: 'zt-team-range-text',
            value: end || '',
            placeholder: '选择时间',
            readOnly: true,
            'aria-label': ariaEnd,
            onClick: () => {
              try {
                endRef.current && endRef.current.showPicker();
              } catch (error) {
                endRef.current && endRef.current.focus();
              }
            },
          }),
          h('span', { className: 'zt-team-range-icon' }, h(GlyphIcon, { name: 'clock', size: 14 })),
          h('input', {
            ref: startRef,
            className: 'zt-team-picker',
            type: 'date',
            value: start || '',
            tabIndex: -1,
            'aria-hidden': 'true',
            onChange: (event) => onStart(event.target.value),
          }),
          h('input', {
            ref: endRef,
            className: 'zt-team-picker',
            type: 'date',
            value: end || '',
            tabIndex: -1,
            'aria-hidden': 'true',
            onChange: (event) => onEnd(event.target.value),
          }),
        );

      const renderTeamHeader = (activeTab, onExport, exporting) => {
        const allTasks = teamTasks.tasks || [];
        const openCount = allTasks.filter((item) => item.status !== 'closed').length;
        const closedCount = allTasks.filter((item) => item.status === 'closed').length;
        return h(
          'div',
          { className: 'zt-team-head' },
          h(
            'div',
            { className: 'zt-team-title-wrap' },
            renderTabs(
              [
                { key: 'open', label: '未关闭', count: openCount },
                { key: 'closed', label: '已关闭', count: closedCount },
              ],
              activeTab,
              (key) => {
                setTeamTab(key);
                if (key === 'open') setTeamPage(1);
                else setClosedPage(1);
              },
            ),
          ),
          h(
            'div',
            { className: 'zt-team-actions' },
            h(
              'button',
              {
                className: 'zt-icon-btn' + (teamTasks.loading ? ' zt-spinning' : ''),
                type: 'button',
                title: '刷新',
                disabled: teamTasks.loading,
                onClick: () => loadTeamTasks(true),
              },
              h(GlyphIcon, { name: 'refresh', size: 16 }),
            ),
            h(
              'button',
              { className: 'zt-btn zt-btn-primary zt-team-export', type: 'button', disabled: exporting, onClick: onExport },
              exporting ? '导出中…' : '导出 Excel',
            ),
          ),
        );
      };

      const renderTeamClosed = () => {
        const closedTasks = (teamTasks.tasks || []).filter((item) => item.status === 'closed');
        const q = String(closedFilters.q || '').trim().toLowerCase();
        const filtered = closedTasks.filter((item) => {
          if (closedFilters.member === '__unknown__') {
            if (item.resolverAccount) return false;
          } else if (closedFilters.member && item.resolverAccount !== closedFilters.member) {
            return false;
          }
          if (closedFilters.start && (!item.resolvedDate || item.resolvedDate < closedFilters.start)) return false;
          if (closedFilters.end && (!item.resolvedDate || item.resolvedDate > closedFilters.end)) return false;
          if (q && String(item.title || '').toLowerCase().indexOf(q) < 0) return false;
          return true;
        });
        const sortValue = (item, key) => {
          if (key === 'id') return Number(item.id) || 0;
          if (key === 'title') return item.title || '';
          if (key === 'resolver') return item.resolver || '';
          if (key === 'resolvedDate') return item.resolvedDate || '';
          if (key === 'status') return item.statusText || item.status || '';
          if (key === 'execution') return (item.projectName || '') + ' / ' + (item.executionName || '');
          return '';
        };
        const sorted = filtered.slice().sort((a, b) => {
          const av = sortValue(a, closedSort.key);
          const bv = sortValue(b, closedSort.key);
          const aEmpty = av === '' || av === null || av === undefined;
          const bEmpty = bv === '' || bv === null || bv === undefined;
          if (aEmpty && bEmpty) return 0;
          if (aEmpty) return 1;
          if (bEmpty) return -1;
          if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * closedSort.dir;
          return String(av).localeCompare(String(bv), 'zh-Hans-CN') * closedSort.dir;
        });
        const total = sorted.length;
        const pageCount = Math.max(1, Math.ceil(total / closedPageSize));
        const page = Math.min(Math.max(1, closedPage), pageCount);
        const rows = sorted.slice((page - 1) * closedPageSize, page * closedPageSize);
        const patchFilters = (patch) => {
          setClosedFilters((prev) => Object.assign({}, prev, patch));
          setClosedPage(1);
        };
        const toggleSort = (key) => {
          setClosedSort((prev) => ({ key, dir: prev.key === key ? -prev.dir : 1 }));
          setClosedPage(1);
        };
        const closedFractions = () =>
          CLOSED_COLUMNS.map((column) => {
            const value = closedColWidths[column.key];
            return typeof value === 'number' && value > 0 && value < 1 ? value : column.width / 100;
          });
        const startClosedColResize = (event, key) => {
          event.preventDefault();
          event.stopPropagation();
          const table = event.currentTarget.closest('table');
          const tableWidth = table ? table.getBoundingClientRect().width : 1000;
          const startX = event.clientX;
          const startFractions = closedFractions();
          const index = CLOSED_COLUMNS.findIndex((column) => column.key === key);
          if (index < 0) return;
          const move = (ev) => {
            const next = startFractions.slice();
            const min = Math.max(0.05, (CLOSED_COLUMNS[index].min || 56) / Math.max(1, tableWidth));
            const delta = (ev.clientX - startX) / Math.max(1, tableWidth);
            let target = Math.min(0.6, Math.max(min, startFractions[index] + delta));
            const neighbor = index + 1 < next.length ? index + 1 : index - 1;
            if (neighbor < 0) return;
            let rest = next[neighbor] - (target - startFractions[index]);
            if (rest < min) {
              target = startFractions[index] + (next[neighbor] - min);
              rest = min;
            }
            next[index] = target;
            next[neighbor] = rest;
            const result = {};
            CLOSED_COLUMNS.forEach((column, i) => {
              result[column.key] = next[i];
            });
            setClosedColWidths(result);
          };
          const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            setClosedColWidths((prev) => {
              try {
                localStorage.setItem('dsh-zentao-team-closed-col-widths-v1', JSON.stringify(prev));
              } catch (error) {
                /* ignore */
              }
              return prev;
            });
          };
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
        };
        const th = (key, label, className) =>
          h(
            'th',
            { key, className: 'zt-team-th' + (className ? ' ' + className : '') + (closedSort.key === key ? ' zt-th-sorted' : '') },
            h(
              'button',
              { type: 'button', className: 'zt-th-btn', onClick: () => toggleSort(key) },
              h('span', { className: 'zt-th-label' }, label),
              h('span', { className: 'zt-sort' }, closedSort.key === key ? (closedSort.dir === 1 ? '▲' : '▼') : '⇅'),
            ),
            h('span', { className: 'zt-col-resize', onMouseDown: (event) => startClosedColResize(event, key) }),
          );
        const isoDate = (date) =>
          date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
        const weekRange = (() => {
          const now = new Date();
          const monday = new Date(now);
          monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
          const sunday = new Date(monday);
          sunday.setDate(monday.getDate() + 6);
          return { start: isoDate(monday), end: isoDate(sunday) };
        })();
        const monthRange = (() => {
          const now = new Date();
          return { start: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), end: isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
        })();
        const isWeekActive = closedFilters.start === weekRange.start && closedFilters.end === weekRange.end;
        const isMonthActive = closedFilters.start === monthRange.start && closedFilters.end === monthRange.end;
        const resolverMap = new Map();
        for (const item of closedTasks) {
          const key = item.resolverAccount || '__unknown__';
          if (!resolverMap.has(key)) resolverMap.set(key, { key, label: item.resolver || '未记录解决人', count: 0 });
          resolverMap.get(key).count += 1;
        }
        const cards = [...resolverMap.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'));
        const exportRows = async () => {
          if (teamExporting) return;
          setTeamExporting(true);
          try {
            const payload = sorted.map((item) => ({
              id: item.id,
              title: item.title,
              resolver: item.resolver || '',
              resolvedDate: item.resolvedDate || '',
              status: item.statusText || item.status || '',
              execution: (item.projectName ? item.projectName + ' / ' : '') + (item.executionName || ''),
            }));
            const res = await fetch('/zentao/api/team-tasks/export', {
              method: 'POST',
              headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
              body: JSON.stringify({
                rows: payload,
                headers: ['任务ID', '任务名称', '解决人', '解决时间', '任务状态', '所属迭代'],
                fields: ['id', 'title', 'resolver', 'resolvedDate', 'status', 'execution'],
              }),
            });
            if (!res.ok) throw new Error('导出失败（HTTP ' + res.status + '）');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'team-closed-tasks-' + isoDate(new Date()) + '.xlsx';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
          } catch (error) {
            setActionError(error.message);
          } finally {
            setTeamExporting(false);
          }
        };
        return h(
          'div',
          { className: 'zt-team' },
          renderTeamHeader('closed', exportRows, teamExporting),
          h(
            'div',
            { className: 'zt-team-overview' },
            h(
              'div',
              { className: 'zt-team-overview-head' },
              h('span', { className: 'zt-team-overview-title' }, '已关闭任务总览'),
              h('span', { className: 'zt-team-overview-hint' }, '按解决时间 / 解决人筛选'),
            ),
            cards.length
              ? h(
                  'div',
                  { className: 'zt-team-cards' },
                  cards.map((entry) =>
                    h(
                      'div',
                      { key: entry.key, className: 'zt-team-card' },
                      h('div', { className: 'zt-team-card-name', title: entry.label }, entry.label),
                      h(
                        'button',
                        {
                          className: 'zt-team-card-metric',
                          type: 'button',
                          title: '筛选 ' + entry.label + ' 已关闭的任务',
                          onClick: () => patchFilters({ member: entry.key }),
                        },
                        h('span', { className: 'zt-team-card-value zt-team-card-value-done' }, String(entry.count)),
                        h('span', { className: 'zt-team-card-label' }, '已关闭'),
                      ),
                    ),
                  ),
                )
              : h('div', { className: 'zt-team-overview-empty' }, '当前时间范围内没有已关闭任务'),
          ),
          h(
            'div',
            { className: 'zt-team-filters' },
            h('span', { className: 'zt-team-filter-label' }, '解决时间'),
            renderTeamRange({
              start: closedFilters.start,
              end: closedFilters.end,
              startRef: closedStartPickerRef,
              endRef: closedEndPickerRef,
              onStart: (value) => patchFilters({ start: value }),
              onEnd: (value) => patchFilters({ end: value }),
              ariaStart: '解决时间开始',
              ariaEnd: '解决时间结束',
            }),
            h('button', { className: 'zt-chip-btn' + (isWeekActive ? ' zt-chip-btn-active' : ''), type: 'button', onClick: () => patchFilters({ start: weekRange.start, end: weekRange.end }) }, '本周'),
            h('button', { className: 'zt-chip-btn' + (isMonthActive ? ' zt-chip-btn-active' : ''), type: 'button', onClick: () => patchFilters({ start: monthRange.start, end: monthRange.end }) }, '本月'),
            h(
              'select',
              { className: 'zt-team-input zt-team-select', value: closedFilters.member, onChange: (event) => patchFilters({ member: event.target.value }) },
              h('option', { value: '' }, '全部解决人'),
              cards.map((entry) => h('option', { key: entry.key, value: entry.key }, entry.label)),
            ),
            h('input', {
              className: 'zt-team-input zt-team-search',
              placeholder: '搜索任务名称',
              value: closedFilters.q,
              onChange: (event) => patchFilters({ q: event.target.value }),
            }),
            h('button', { className: 'zt-chip-btn', type: 'button', onClick: () => patchFilters({ member: '', start: '', end: '', q: '' }) }, '清除筛选'),
          ),
          h(
            'div',
            { className: 'zt-team-body' },
            teamTasks.loading && !teamTasks.loaded
              ? h('div', { className: 'zt-team-loading' }, '正在汇总所有迭代任务…')
              : total === 0
                ? h('div', { className: 'zt-team-empty' }, '没有符合条件的已关闭任务')
                : h(
                    'table',
                    { className: 'zt-table zt-table-team' },
                    h(
                      'colgroup',
                      null,
                      CLOSED_COLUMNS.map((column) =>
                        h('col', {
                          key: column.key,
                          style: {
                            width:
                              (typeof closedColWidths[column.key] === 'number' && closedColWidths[column.key] > 0 && closedColWidths[column.key] < 1
                                ? closedColWidths[column.key] * 100
                                : column.width) + '%',
                          },
                        }),
                      ),
                    ),
                    h(
                      'thead',
                      null,
                      h(
                        'tr',
                        null,
                        th('id', '任务ID', 'zt-team-col-id'),
                        th('title', '任务名称', 'zt-team-col-title'),
                        th('resolver', '解决人'),
                        th('resolvedDate', '解决时间'),
                        th('status', '任务状态'),
                        th('execution', '所属迭代'),
                      ),
                    ),
                    h(
                      'tbody',
                      null,
                      rows.map((item) =>
                        h(
                          'tr',
                          { key: item.id },
                          h('td', { className: 'zt-team-col-id' }, String(item.id)),
                          h(
                            'td',
                            { className: 'zt-team-col-title' },
                            h('a', { href: baseUrl + item.url, target: '_blank', rel: 'noreferrer noopener' }, item.title || '（无标题）'),
                          ),
                          h('td', null, item.resolver || '—'),
                          h('td', null, item.resolvedDate ? shortListDate(item.resolvedDate) : '—'),
                          h('td', null, h('span', { className: 'zt-tag zt-tag-default' }, item.statusText || '已关闭')),
                          h('td', { className: 'zt-team-col-exec' }, (item.projectName ? item.projectName + ' / ' : '') + (item.executionName || '—')),
                        ),
                      ),
                    ),
                  ),
          ),
          renderTeamPager({ total, page, pageCount, pageSize: closedPageSize, setPage: setClosedPage, setPageSize: setClosedPageSize }),
        );
      };

      const renderTeamTasks = () => {
        if (teamTab === 'closed') return renderTeamClosed();
        const tasks = (teamTasks.tasks || []).filter((item) => item.status !== 'closed');
        const q = String(teamFilters.q || '').trim().toLowerCase();
        const todayKey = (() => {
          const now = new Date();
          return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        })();
        const overdueOf = (item) =>
          !item.done &&
          !['done', 'closed', 'cancel'].includes(item.status) &&
          /^\d{4}-\d{2}-\d{2}$/.test(String(item.deadline || '')) &&
          item.deadline < todayKey;
        const filtered = tasks.filter((item) => {
          if (teamFilters.member && item.assignedToAccount !== teamFilters.member) return false;
          if (teamFilters.status === '__todo__') {
            if (item.status !== 'wait' && item.status !== 'doing') return false;
          } else if (teamFilters.status === '__done__') {
            if (item.status !== 'done') return false;
          } else if (teamFilters.status && item.status !== teamFilters.status) {
            return false;
          }
          if (teamFilters.start && (!item.deadline || item.deadline < teamFilters.start)) return false;
          if (teamFilters.end && (!item.deadline || item.deadline > teamFilters.end)) return false;
          if (q && String(item.title || '').toLowerCase().indexOf(q) < 0) return false;
          return true;
        });
        const sortValue = (item, key) => {
          if (key === 'id') return Number(item.id) || 0;
          if (key === 'overdue') return overdueOf(item) ? 1 : 0;
          if (key === 'execution') return (item.projectName || '') + ' / ' + (item.executionName || '');
          if (key === 'deadline') return item.deadline || '';
          if (key === 'assignee') return item.assignedTo || '';
          if (key === 'status') return item.statusText || item.status || '';
          return item.title || '';
        };
        const sorted = filtered.slice().sort((a, b) => {
          const av = sortValue(a, teamSort.key);
          const bv = sortValue(b, teamSort.key);
          const aEmpty = av === '' || av === null || av === undefined;
          const bEmpty = bv === '' || bv === null || bv === undefined;
          if (aEmpty && bEmpty) return 0;
          if (aEmpty) return 1;
          if (bEmpty) return -1;
          if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * teamSort.dir;
          return String(av).localeCompare(String(bv), 'zh-Hans-CN') * teamSort.dir;
        });
        const total = sorted.length;
        const pageCount = Math.max(1, Math.ceil(total / teamPageSize));
        const page = Math.min(Math.max(1, teamPage), pageCount);
        const rows = sorted.slice((page - 1) * teamPageSize, page * teamPageSize);
        const patchFilters = (patch) => {
          setTeamFilters((prev) => Object.assign({}, prev, patch));
          setTeamPage(1);
        };
        const toggleSort = (key) => {
          setTeamSort((prev) => ({ key, dir: prev.key === key ? -prev.dir : 1 }));
          setTeamPage(1);
        };
        const teamFractions = () =>
          TEAM_COLUMNS.map((column) => {
            const value = teamColWidths[column.key];
            return typeof value === 'number' && value > 0 && value < 1 ? value : column.width / 100;
          });
        const startTeamColResize = (event, key) => {
          event.preventDefault();
          event.stopPropagation();
          const table = event.currentTarget.closest('table');
          const tableWidth = table ? table.getBoundingClientRect().width : 1000;
          const startX = event.clientX;
          const startFractions = teamFractions();
          const index = TEAM_COLUMNS.findIndex((column) => column.key === key);
          if (index < 0) return;
          const move = (ev) => {
            const delta = (ev.clientX - startX) / Math.max(1, tableWidth);
            const next = startFractions.slice();
            const min = Math.max(0.05, (TEAM_COLUMNS[index].min || 56) / Math.max(1, tableWidth));
            const max = 0.6;
            let target = Math.min(max, Math.max(min, startFractions[index] + delta));
            const neighbor = index + 1 < next.length ? index + 1 : index - 1;
            if (neighbor < 0) return;
            let rest = next[neighbor] - (target - startFractions[index]);
            if (rest < min) {
              target = startFractions[index] + (next[neighbor] - min);
              rest = min;
            }
            next[index] = target;
            next[neighbor] = rest;
            const result = {};
            TEAM_COLUMNS.forEach((column, i) => {
              result[column.key] = next[i];
            });
            setTeamColWidths(result);
          };
          const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            setTeamColWidths((prev) => {
              try {
                localStorage.setItem('dsh-zentao-team-col-widths-v1', JSON.stringify(prev));
              } catch (error) {
                /* ignore */
              }
              return prev;
            });
          };
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
        };
        const th = (key, label, className) =>
          h(
            'th',
            { key, className: 'zt-team-th' + (className ? ' ' + className : '') + (teamSort.key === key ? ' zt-th-sorted' : '') },
            h(
              'button',
              { type: 'button', className: 'zt-th-btn', onClick: () => toggleSort(key) },
              h('span', { className: 'zt-th-label' }, label),
              h('span', { className: 'zt-sort' }, teamSort.key === key ? (teamSort.dir === 1 ? '▲' : '▼') : '⇅'),
            ),
            h('span', { className: 'zt-col-resize', onMouseDown: (event) => startTeamColResize(event, key) }),
          );
        const isoDate = (date) =>
          date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
        const weekRange = (() => {
          const now = new Date();
          const monday = new Date(now);
          monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
          const sunday = new Date(monday);
          sunday.setDate(monday.getDate() + 6);
          return { start: isoDate(monday), end: isoDate(sunday) };
        })();
        const monthRange = (() => {
          const now = new Date();
          return { start: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), end: isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
        })();
        const isWeekActive = teamFilters.start === weekRange.start && teamFilters.end === weekRange.end;
        const isMonthActive = teamFilters.start === monthRange.start && teamFilters.end === monthRange.end;
        const setThisWeek = () => patchFilters({ start: weekRange.start, end: weekRange.end });
        const setThisMonth = () => patchFilters({ start: monthRange.start, end: monthRange.end });
        const exportRows = async () => {
          if (teamExporting) return;
          setTeamExporting(true);
          try {
            const payload = sorted.map((item) => ({
              id: item.id,
              title: item.title,
              assignee: item.assignedTo || '',
              status: item.statusText || item.status || '',
              deadline: item.deadline || '',
              overdue: overdueOf(item),
              execution: (item.projectName ? item.projectName + ' / ' : '') + (item.executionName || ''),
            }));
            const res = await fetch('/zentao/api/team-tasks/export', {
              method: 'POST',
              headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
              body: JSON.stringify({ rows: payload }),
            });
            if (!res.ok) throw new Error('导出失败（HTTP ' + res.status + '）');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'team-tasks-' + todayKey + '.xlsx';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
          } catch (error) {
            setActionError(error.message);
          } finally {
            setTeamExporting(false);
          }
        };
        const chartTasks = tasks.filter((item) => {
          if (teamFilters.member && item.assignedToAccount !== teamFilters.member) return false;
          if (teamFilters.start && (!item.deadline || item.deadline < teamFilters.start)) return false;
          if (teamFilters.end && (!item.deadline || item.deadline > teamFilters.end)) return false;
          return true;
        });
        const chartMembers = new Map();
        for (const item of chartTasks) {
          const key = item.assignedToAccount || item.assignedTo || '未指派';
          const label = item.assignedTo || item.assignedToAccount || '未指派';
          if (!chartMembers.has(key)) chartMembers.set(key, { key, label, todo: 0, finished: 0 });
          const entry = chartMembers.get(key);
          if (item.status === 'wait' || item.status === 'doing') entry.todo += 1;
          else if (item.status === 'done') entry.finished += 1;
        }
        const chartData = [...chartMembers.values()]
          .filter((entry) => entry.todo || entry.finished)
          .sort((a, b) => b.todo + b.finished - (a.todo + a.finished) || a.label.localeCompare(b.label, 'zh-Hans-CN'));
        return h(
          'div',
          { className: 'zt-team' },
          renderTeamHeader('open', exportRows, teamExporting),
          h(
            'div',
            { className: 'zt-team-overview' },
            h(
              'div',
              { className: 'zt-team-overview-head' },
              h('span', { className: 'zt-team-overview-title' }, '任务总览'),
              h('span', { className: 'zt-team-overview-hint' }, '按截止完成时间 / 成员筛选 · 不含已关闭任务'),
            ),
            chartData.length
              ? h(
                  'div',
                  { className: 'zt-team-cards' },
                  chartData.map((entry) =>
                    h(
                      'div',
                      { key: entry.key, className: 'zt-team-card' },
                      h('div', { className: 'zt-team-card-name', title: entry.label }, entry.label),
                      h(
                        'div',
                        { className: 'zt-team-card-metrics' },
                        h(
                          'button',
                          {
                            className: 'zt-team-card-metric',
                            type: 'button',
                            title: '筛选 ' + entry.label + ' 待完成的任务',
                            onClick: () => patchFilters({ member: entry.key, status: '__todo__' }),
                          },
                          h('span', { className: 'zt-team-card-value zt-team-card-value-todo' }, String(entry.todo)),
                          h('span', { className: 'zt-team-card-label' }, '待完成'),
                        ),
                        h(
                          'button',
                          {
                            className: 'zt-team-card-metric',
                            type: 'button',
                            title: '筛选 ' + entry.label + ' 已完成的任务',
                            onClick: () => patchFilters({ member: entry.key, status: '__done__' }),
                          },
                          h('span', { className: 'zt-team-card-value zt-team-card-value-done' }, String(entry.finished)),
                          h('span', { className: 'zt-team-card-label' }, '已完成'),
                        ),
                      ),
                    ),
                  ),
                )
              : h('div', { className: 'zt-team-overview-empty' }, '当前时间范围内没有任务'),
          ),
          h(
            'div',
            { className: 'zt-team-filters' },
            h('span', { className: 'zt-team-filter-label' }, '截止完成时间'),
            renderTeamRange({
              start: teamFilters.start,
              end: teamFilters.end,
              startRef: teamStartPickerRef,
              endRef: teamEndPickerRef,
              onStart: (value) => patchFilters({ start: value }),
              onEnd: (value) => patchFilters({ end: value }),
              ariaStart: '截止完成时间开始',
              ariaEnd: '截止完成时间结束',
            }),
            h('button', { className: 'zt-chip-btn' + (isWeekActive ? ' zt-chip-btn-active' : ''), type: 'button', onClick: setThisWeek }, '本周'),
            h('button', { className: 'zt-chip-btn' + (isMonthActive ? ' zt-chip-btn-active' : ''), type: 'button', onClick: setThisMonth }, '本月'),
            h(
              'select',
              { className: 'zt-team-input zt-team-select', value: teamFilters.member, onChange: (event) => patchFilters({ member: event.target.value }) },
              h('option', { value: '' }, '全部成员'),
              (teamTasks.members || []).map((member) =>
                h('option', { key: member.account || member.label, value: member.account || member.label }, member.label),
              ),
            ),
            h(
              'select',
              { className: 'zt-team-input zt-team-select', value: teamFilters.status, onChange: (event) => patchFilters({ status: event.target.value }) },
              h('option', { value: '' }, '全部状态'),
              h('option', { value: '__todo__' }, '待完成（未开始/进行中）'),
              h('option', { value: '__done__' }, '已完成'),
              ['wait', 'doing', 'done', 'pause', 'cancel'].map((key) =>
                h('option', { key, value: key }, { wait: '未开始', doing: '进行中', done: '已完成', pause: '已暂停', cancel: '已取消', closed: '已关闭' }[key]),
              ),
            ),
            h('input', {
              className: 'zt-team-input zt-team-search',
              placeholder: '搜索任务名称',
              value: teamFilters.q,
              onChange: (event) => patchFilters({ q: event.target.value }),
            }),
            h('button', { className: 'zt-chip-btn', type: 'button', onClick: () => patchFilters({ member: '', status: '', start: '', end: '', q: '' }) }, '清除筛选'),
          ),
          teamTasks.error ? h('div', { className: 'zt-team-error' }, teamTasks.error) : null,
          h(
            'div',
            { className: 'zt-team-body' },
            teamTasks.loading && !teamTasks.loaded
              ? h('div', { className: 'zt-team-loading' }, '正在汇总所有迭代任务…')
              : total === 0
                ? h('div', { className: 'zt-team-empty' }, '没有符合条件的任务')
                : h(
                    'table',
                    { className: 'zt-table zt-table-team' },
                    h(
                      'colgroup',
                      null,
                      TEAM_COLUMNS.map((column) =>
                        h('col', {
                          key: column.key,
                          style: {
                            width:
                              (typeof teamColWidths[column.key] === 'number' && teamColWidths[column.key] > 0 && teamColWidths[column.key] < 1
                                ? teamColWidths[column.key] * 100
                                : column.width) + '%',
                          },
                        }),
                      ),
                    ),
                    h(
                      'thead',
                      null,
                      h(
                        'tr',
                        null,
                        th('id', 'ID', 'zt-team-col-id'),
                        th('title', '任务名称', 'zt-team-col-title'),
                        th('assignee', '指派人'),
                        th('status', '状态'),
                        th('deadline', '截止完成时间'),
                        th('overdue', '是否延期'),
                        th('execution', '所属迭代'),
                      ),
                    ),
                    h(
                      'tbody',
                      null,
                      rows.map((item) => {
                        const overdue = overdueOf(item);
                        return h(
                          'tr',
                          { key: item.id, className: overdue ? 'zt-team-row-overdue' : '' },
                          h('td', { className: 'zt-team-col-id' }, String(item.id)),
                          h(
                            'td',
                            { className: 'zt-team-col-title' + (overdue ? ' zt-title-overdue' : '') },
                            h(
                              'a',
                              { href: baseUrl + item.url, target: '_blank', rel: 'noreferrer noopener', title: '在禅道打开任务' },
                              item.title || '（无标题）',
                            ),
                          ),
                          h('td', null, item.assignedTo || '—'),
                          h('td', null, h('span', { className: 'zt-tag zt-tag-' + statusTone(item.status) }, item.statusText || item.status || '—')),
                          h(
                            'td',
                            null,
                            item.deadline
                              ? h('span', { className: 'zt-team-date-value' + (overdue ? ' zt-team-date-overdue' : '') }, shortListDate(item.deadline))
                              : '—',
                          ),
                          h('td', null, overdue ? h('span', { className: 'zt-team-overdue-text' }, '延期') : '-'),
                          h('td', { className: 'zt-team-col-exec' }, (item.projectName ? item.projectName + ' / ' : '') + (item.executionName || '—')),
                        );
                      }),
                    ),
                  ),
          ),
          renderTeamPager({ total, page, pageCount, pageSize: teamPageSize, setPage: setTeamPage, setPageSize: setTeamPageSize }),
        );
      };

      const cellPopup = (() => {
        if (!cellEditor) return null;
        const width = 240;
        const viewportW = typeof window !== 'undefined' ? window.innerWidth || 1200 : 1200;
        const viewportH = typeof window !== 'undefined' ? window.innerHeight || 800 : 800;
        const left = clamp(cellEditor.x, 8, Math.max(8, viewportW - width - 8));
        const estimated = cellEditor.loading ? 120 : Math.min(360, 52 + cellEditor.options.length * 34);
        const top = clamp(cellEditor.y, 8, Math.max(8, viewportH - estimated - 8));
        const current = cellCurrentText(cellEditor);
        return h(
          'div',
          { className: 'zt-popup-layer', onClick: closeCellEditor },
          h(
            'div',
            {
              className: 'zt-popup',
              style: { left: left + 'px', top: top + 'px', width: width + 'px' },
              role: 'menu',
              onClick: (event) => event.stopPropagation(),
            },
            h(
              'div',
              { className: 'zt-popup-head' },
              cellEditor.field === 'priority'
                ? '修改优先级'
                : cellEditor.field === 'module'
                ? '修改模块'
                : cellEditor.field === 'deadline'
                  ? '修改截止日期'
                  : cellEditor.field === 'status' || cellEditor.field === 'storyStatus'
                    ? cellEditor.item.type === 'bug'
                      ? '修改方案'
                      : cellEditor.item.type === 'task'
                        ? '修改任务状态'
                        : '修改状态'
                    : '指派给',
            ),
            cellEditor.field === 'deadline'
              ? h(
                  'div',
                  { className: 'zt-popup-date' },
                  h('input', {
                    type: 'date',
                    className: 'zt-popup-date-input',
                    value: cellEditor.dateValue || '',
                    disabled: !!cellEditor.busy,
                    onChange: (e) =>
                      setCellEditor((prev) => (prev && prev.field === 'deadline' ? Object.assign({}, prev, { dateValue: e.target.value }) : prev)),
                  }),
                  h(
                    'div',
                    { className: 'zt-popup-date-actions' },
                    h(
                      'button',
                      {
                        className: 'zt-popup-date-btn zt-popup-date-primary',
                        type: 'button',
                        disabled: !!cellEditor.busy,
                        onClick: submitTaskDeadline,
                      },
                      '保存',
                    ),
                    h('button', { className: 'zt-popup-date-btn', type: 'button', onClick: closeCellEditor }, '取消'),
                  ),
                )
              : cellEditor.loading
              ? h('div', { className: 'zt-popup-loading' }, '加载中…')
              : h(
                  'div',
                  { className: 'zt-popup-list' },
                  cellEditor.options.map((option) => {
                    const active = option.label === current;
                    return h(
                      'button',
                      {
                        key: option.value,
                        type: 'button',
                        role: 'menuitemradio',
                        'aria-checked': active ? 'true' : 'false',
                        className: 'zt-popup-item' + (active ? ' zt-popup-item-active' : ''),
                        disabled: !!cellEditor.busy,
                        onClick: () => applyCellOption(option),
                      },
                      option.label,
                    );
                  }),
                ),
          ),
        );
      })();

      return h(
        'div',
        {
          style: {
            // lightsPad = how much of the panel's left edge is under the lights;
            // target content x ≈ 84px, and the collapsed rail eats 48px of that.
            '--zt-pane-head-pad': Math.max(16, 8 + lightsPad) + 'px',
            '--zt-main-head-pad': Math.max(16, lightsPad - 32) + 'px',
            '--zt-left-w': (layout.leftOpen ? layout.leftW : 0) + 'px',
          },
          className:
            'zt-root' +
            (isMac ? ' zt-mac' : '') +
            (lightsPad > 0 ? ' zt-under-lights' : '') +
            (layout.leftOpen ? '' : ' zt-left-closed'),
          ref: rootRef,
        },
        h('style', { key: 'zt-style' }, CSS),
        taskModal ? renderTaskModal() : null,
        emojiModal
          ? h(
              'dialog',
              {
                className: 'zt-modal-dialog',
                ref: emojiDialogRef,
                'aria-label': '自定义Emoji',
                onCancel: (event) => {
                  event.preventDefault();
                  setEmojiModal(null);
                },
              },
              h(
                'div',
                { className: 'zt-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '自定义Emoji' },
                h(
                  'div',
                  { className: 'zt-modal-head' },
                  h('span', { className: 'zt-modal-title' }, '自定义 Emoji'),
                  h(
                    'button',
                    { className: 'zt-modal-close', type: 'button', title: '关闭', 'aria-label': '关闭', onClick: () => setEmojiModal(null) },
                    h(GlyphIcon, { name: 'close', size: 16 }),
                  ),
                ),
                h(
                  'div',
                  { className: 'zt-modal-body' },
                  h('div', { className: 'zt-modal-hint' }, '项目：' + (emojiModal.projectName || '')),
                  h(
                    'label',
                    { className: 'zt-field' },
                    fieldLabel('Emoji', false),
                    h('input', {
                      className: 'zt-input',
                      value: emojiModal.value,
                      maxLength: 8,
                      placeholder: '输入或粘贴一个 Emoji，例如 🚀',
                      onChange: (event) => setEmojiModal((prev) => (prev ? Object.assign({}, prev, { value: event.target.value }) : prev)),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'zt-emoji-grid' },
                    [
                      '📁', '📂', '📦', '🗂️', '🚀', '🛠️', '⚙️', '🧰',
                      '🧪', '🔬', '📊', '📈', '📉', '💡', '🎯', '🔥',
                      '⭐', '✨', '🧩', '🐞', '🐛', '✅', '☑️', '📝',
                      '📋', '🗒️', '🎨', '🖌️', '🏷️', '🔖', '📌', '📍',
                      '🧭', '🗺️', '🏗️', '🏭', '💻', '🖥️', '📱', '☁️',
                      '🔒', '🔑', '🧠', '🤖', '🌐', '🛰️', '📡', '🧮',
                    ].map((emoji) =>
                      h(
                        'button',
                        {
                          key: emoji,
                          type: 'button',
                          className: 'zt-emoji-option' + (emojiModal.value === emoji ? ' zt-emoji-option-active' : ''),
                          onClick: () => setEmojiModal((prev) => (prev ? Object.assign({}, prev, { value: emoji }) : prev)),
                        },
                        emoji,
                      ),
                    ),
                  ),
                  h(
                    'button',
                    {
                      className: 'zt-link-btn',
                      type: 'button',
                      onClick: () => setEmojiModal((prev) => (prev ? Object.assign({}, prev, { value: '' }) : prev)),
                    },
                    '恢复默认图标',
                  ),
                ),
                h(
                  'div',
                  { className: 'zt-modal-foot' },
                  h('button', { className: 'zt-btn zt-btn-ghost', type: 'button', onClick: () => setEmojiModal(null) }, '取消'),
                  h(
                    'button',
                    {
                      className: 'zt-btn zt-btn-primary',
                      type: 'button',
                      onClick: () => {
                        const value = String(emojiModal.value || '').trim();
                        setProjectEmojis((prev) => {
                          const next = Object.assign({}, prev);
                          if (value) next[emojiModal.projectId] = value;
                          else delete next[emojiModal.projectId];
                          return next;
                        });
                        setEmojiModal(null);
                      },
                    },
                    '保存',
                  ),
                ),
              ),
            )
          : null,
        iterationModal
          ? h(
              'dialog',
              {
                className: 'zt-modal-dialog',
                ref: iterationDialogRef,
                'aria-label': '创建迭代',
                onCancel: (event) => {
                  event.preventDefault();
                  setIterationModal(null);
                },
              },
              h(
                'div',
                { className: 'zt-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '创建迭代' },
                h(
                  'div',
                  { className: 'zt-modal-head' },
                  h('span', { className: 'zt-modal-title' }, '创建迭代'),
                  h(
                    'button',
                    { className: 'zt-modal-close', type: 'button', title: '关闭', 'aria-label': '关闭', onClick: () => setIterationModal(null) },
                    h(GlyphIcon, { name: 'close', size: 16 }),
                  ),
                ),
                h(
                  'div',
                  { className: 'zt-modal-body' },
                  h('div', { className: 'zt-modal-hint' }, '项目：' + (iterationModal.projectName || '')),
                  h(
                    'label',
                    { className: 'zt-field' },
                    fieldLabel('迭代名称', true),
                    h('input', {
                      className: 'zt-input',
                      value: iterationModal.name,
                      placeholder: '例如 Sprint 25 迭代',
                      onChange: (event) =>
                        setIterationModal((prev) => (prev ? Object.assign({}, prev, { name: event.target.value, error: '' }) : prev)),
                    }),
                  ),
                  h(
                    'label',
                    { className: 'zt-field' },
                    fieldLabel('迭代代号', false),
                    h('input', {
                      className: 'zt-input',
                      value: iterationModal.code,
                      placeholder: '留空自动生成',
                      onChange: (event) =>
                        setIterationModal((prev) => (prev ? Object.assign({}, prev, { code: event.target.value }) : prev)),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'zt-modal-grid2' },
                    h(
                      'label',
                      { className: 'zt-field' },
                      fieldLabel('开始日期', true),
                      h('input', {
                        className: 'zt-input',
                        type: 'date',
                        value: iterationModal.begin,
                        onChange: (event) =>
                          setIterationModal((prev) => (prev ? Object.assign({}, prev, { begin: event.target.value, error: '' }) : prev)),
                      }),
                    ),
                    h(
                      'label',
                      { className: 'zt-field' },
                      fieldLabel('结束日期', true),
                      h('input', {
                        className: 'zt-input',
                        type: 'date',
                        value: iterationModal.end,
                        onChange: (event) =>
                          setIterationModal((prev) => (prev ? Object.assign({}, prev, { end: event.target.value, error: '' }) : prev)),
                      }),
                    ),
                  ),
                  h(
                    'label',
                    { className: 'zt-field' },
                    fieldLabel('状态', false),
                    h(
                      'select',
                      {
                        className: 'zt-input',
                        value: iterationModal.status,
                        onChange: (event) =>
                          setIterationModal((prev) => (prev ? Object.assign({}, prev, { status: event.target.value }) : prev)),
                      },
                      h('option', { value: 'wait' }, '未开始'),
                      h('option', { value: 'doing' }, '进行中'),
                    ),
                  ),
                  h('div', { className: 'zt-modal-hint' }, '团队成员：沿用项目现有成员'),
                  iterationModal.error ? h('div', { className: 'zt-field-error' }, iterationModal.error) : null,
                ),
                h(
                  'div',
                  { className: 'zt-modal-foot' },
                  h('button', { className: 'zt-btn zt-btn-ghost', type: 'button', onClick: () => setIterationModal(null) }, '取消'),
                  h(
                    'button',
                    { className: 'zt-btn zt-btn-primary', type: 'button', disabled: iterationModal.submitting, onClick: submitIterationModal },
                    iterationModal.submitting ? '创建中…' : '创建',
                  ),
                ),
              ),
            )
          : null,
        itemModal
          ? h(
              'dialog',
              {
                className: 'zt-modal-dialog',
                ref: itemDialogRef,
                'aria-label': itemModal.kind === 'story' ? '新建需求' : '新建 BUG',
                onCancel: (event) => {
                  event.preventDefault();
                  setItemModal(null);
                },
              },
              h(
                'div',
                { className: 'zt-modal', role: 'dialog', 'aria-modal': 'true' },
                h(
                  'div',
                  { className: 'zt-modal-head' },
                  h('span', { className: 'zt-modal-title' }, itemModal.kind === 'story' ? '新建需求' : '新建 BUG'),
                  h(
                    'button',
                    { className: 'zt-modal-close', type: 'button', title: '关闭', 'aria-label': '关闭', onClick: () => setItemModal(null) },
                    h(GlyphIcon, { name: 'close', size: 16 }),
                  ),
                ),
                h(
                  'div',
                  { className: 'zt-modal-body' },
                  h('div', { className: 'zt-modal-hint' }, '迭代：' + (itemModal.executionName || '当前迭代')),
                  h(
                    'label',
                    { className: 'zt-field' },
                    fieldLabel(itemModal.kind === 'story' ? '需求标题' : 'BUG 标题', true),
                    h('input', {
                      className: 'zt-input',
                      value: itemModal.title,
                      placeholder: itemModal.kind === 'story' ? '简要描述需求' : '简要描述问题',
                      onChange: (event) =>
                        setItemModal((prev) => (prev ? Object.assign({}, prev, { title: event.target.value, error: '' }) : prev)),
                    }),
                  ),
                  h(
                    'label',
                    { className: 'zt-field' },
                    fieldLabel('优先级', false),
                    h(
                      'select',
                      {
                        className: 'zt-input',
                        value: itemModal.priority,
                        onChange: (event) =>
                          setItemModal((prev) => (prev ? Object.assign({}, prev, { priority: event.target.value }) : prev)),
                      },
                      h('option', { value: '1' }, 'P1'),
                      h('option', { value: '2' }, 'P2'),
                      h('option', { value: '3' }, 'P3'),
                    ),
                  ),
                  h(
                    'label',
                    { className: 'zt-field' },
                    fieldLabel('指派给', false),
                    h(
                      'select',
                      {
                        className: 'zt-input',
                        value: itemModal.assignedTo,
                        disabled: itemModal.loading,
                        onChange: (event) =>
                          setItemModal((prev) => (prev ? Object.assign({}, prev, { assignedTo: event.target.value }) : prev)),
                      },
                      h('option', { value: '' }, itemModal.loading ? '读取成员…' : '未指派'),
                      (itemModal.users || []).map((user) => h('option', { key: user.value, value: user.value }, user.label)),
                    ),
                  ),
                  h(
                    'label',
                    { className: 'zt-field' },
                    fieldLabel(itemModal.kind === 'story' ? '需求描述' : '重现步骤', false),
                    h('textarea', {
                      className: 'zt-textarea',
                      rows: 4,
                      value: itemModal.description,
                      placeholder: itemModal.kind === 'story' ? '背景、目标、范围等（可直接粘贴图片）' : '操作步骤、实际结果等',
                      onPaste: (event) => {
                        if (itemModal.kind !== 'story' || itemModal.uploadingImage) return;
                        const item = Array.from(event.clipboardData.items || []).find(
                          (entry) => entry.kind === 'file' && entry.type.indexOf('image/') === 0,
                        );
                        const file = item && item.getAsFile();
                        if (!file) return;
                        event.preventDefault();
                        uploadStoryImage(file);
                      },
                      onChange: (event) =>
                        setItemModal((prev) => (prev ? Object.assign({}, prev, { description: event.target.value }) : prev)),
                    }),
                    itemModal.kind === 'story'
                      ? h(
                          'div',
                          { className: 'zt-field-extra' },
                          h(
                            'button',
                            {
                              className: 'zt-link-btn',
                              type: 'button',
                              disabled: itemModal.uploadingImage,
                              onClick: () => storyImageInputRef.current && storyImageInputRef.current.click(),
                            },
                            itemModal.uploadingImage ? '图片上传中…' : '上传图片',
                          ),
                          h('span', { className: 'zt-field-hint' }, '也可以直接粘贴截图'),
                          h('input', {
                            ref: storyImageInputRef,
                            type: 'file',
                            accept: 'image/*',
                            style: { display: 'none' },
                            onChange: (event) => {
                              const file = event.target.files && event.target.files[0];
                              event.target.value = '';
                              if (file) uploadStoryImage(file);
                            },
                          }),
                        )
                      : null,
                  ),
                  itemModal.kind === 'story'
                    ? h(
                        'label',
                        { className: 'zt-field' },
                        fieldLabel('验收标准', false),
                        h('textarea', {
                          className: 'zt-textarea',
                          rows: 3,
                          value: itemModal.acceptance,
                          placeholder: '怎样算完成',
                          onChange: (event) =>
                            setItemModal((prev) => (prev ? Object.assign({}, prev, { acceptance: event.target.value }) : prev)),
                        }),
                      )
                    : null,
                  itemModal.error ? h('div', { className: 'zt-field-error' }, itemModal.error) : null,
                ),
                h(
                  'div',
                  { className: 'zt-modal-foot' },
                  h('button', { className: 'zt-btn zt-btn-ghost', type: 'button', onClick: () => setItemModal(null) }, '取消'),
                  h(
                    'button',
                    { className: 'zt-btn zt-btn-primary', type: 'button', disabled: itemModal.submitting || itemModal.loading || itemModal.uploadingImage, onClick: submitItemModal },
                    itemModal.submitting ? '创建中…' : '确定',
                  ),
                ),
              ),
            )
          : null,
        listMenu
          ? [
              h('div', { key: 'menu-backdrop', className: 'zt-menu-backdrop', onClick: () => setListMenu(null) }),
              h(
                'div',
                { key: 'list-menu', className: 'zt-context-menu', style: { left: listMenu.x, top: listMenu.y }, role: 'menu' },
                h(
                  'button',
                  {
                    className: 'zt-context-item',
                    type: 'button',
                    role: 'menuitem',
                    onClick: () => {
                      const kind = listMenu.kind || 'task';
                      setListMenu(null);
                      if (kind === 'task') openTaskModal(undefined, selection.executionId);
                      else openItemModal(kind);
                    },
                  },
                  h(GlyphIcon, { name: 'plus', size: 14 }),
                  h(
                    'span',
                    null,
                    listMenu.kind === 'story' ? '新建需求' : listMenu.kind === 'bug' ? '新建 BUG' : '新建任务',
                  ),
                ),
              ),
            ]
          : null,
        settingsOpen
          ? h(
              'dialog',
              {
                className: 'zt-modal-dialog',
                ref: settingsDialogRef,
                'aria-label': '设置',
                onCancel: (event) => {
                  event.preventDefault();
                  setSettingsOpen(false);
                },
              },
              h(
                'div',
                { className: 'zt-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '设置' },
                h(
                  'div',
                  { className: 'zt-modal-head' },
                  h('span', { className: 'zt-modal-title' }, '设置'),
                  h(
                    'button',
                    { className: 'zt-modal-close', type: 'button', title: '关闭', 'aria-label': '关闭', onClick: () => setSettingsOpen(false) },
                    h(GlyphIcon, { name: 'close', size: 16 }),
                  ),
                ),
                h(
                  'div',
                  { className: 'zt-modal-body' },
                  settingsLoading
                    ? h('div', { className: 'zt-modal-hint' }, '正在读取设置…')
                    : [
                        h(
                          'div',
                          { key: 'zt-title', className: 'zt-modal-section' },
                          '禅道连接',
                        ),
                        h(
                          'label',
                          { key: 'baseUrl', className: 'zt-field' },
                          fieldLabel('禅道地址', true),
                          h('input', {
                            className: 'zt-input',
                            value: settingsForm.baseUrl,
                            placeholder: 'http://127.0.0.1:8080',
                            onChange: (event) =>
                              setSettingsForm((prev) => Object.assign({}, prev, { baseUrl: event.target.value })),
                          }),
                        ),
                        h(
                          'label',
                          { key: 'account', className: 'zt-field' },
                          fieldLabel('账号', true),
                          h('input', {
                            className: 'zt-input',
                            value: settingsForm.account,
                            onChange: (event) =>
                              setSettingsForm((prev) => Object.assign({}, prev, { account: event.target.value })),
                          }),
                        ),
                        h(
                          'label',
                          { key: 'password', className: 'zt-field' },
                          fieldLabel('密码', false),
                          h('input', {
                            className: 'zt-input',
                            type: 'password',
                            value: settingsForm.password,
                            placeholder: settingsForm.hasPassword ? '已保存，留空不修改' : '请输入禅道密码',
                            onChange: (event) =>
                              setSettingsForm((prev) => Object.assign({}, prev, { password: event.target.value })),
                          }),
                        ),
                        h('div', { key: 'ds-title', className: 'zt-modal-section' }, 'DeepSeek API'),
                        h(
                          'label',
                          { key: 'ds-key', className: 'zt-field' },
                          fieldLabel('API Key', false),
                          h('input', {
                            className: 'zt-input',
                            type: 'password',
                            value: settingsForm.deepseekApiKey,
                            placeholder: settingsForm.hasDeepseekKey ? '已保存，留空不修改' : '留空则使用 DSH 当前模型',
                            onChange: (event) =>
                              setSettingsForm((prev) => Object.assign({}, prev, { deepseekApiKey: event.target.value })),
                          }),
                        ),
                        h(
                          'label',
                          { key: 'ds-base', className: 'zt-field' },
                          fieldLabel('API 地址', false),
                          h('input', {
                            className: 'zt-input',
                            value: settingsForm.deepseekBaseUrl,
                            placeholder: 'https://api.deepseek.com',
                            onChange: (event) =>
                              setSettingsForm((prev) => Object.assign({}, prev, { deepseekBaseUrl: event.target.value })),
                          }),
                        ),
                        h(
                          'label',
                          { key: 'ds-model', className: 'zt-field' },
                          fieldLabel('默认模型', false),
                          h(
                            'select',
                            {
                              className: 'zt-input',
                              value: settingsForm.deepseekModel,
                              onChange: (event) =>
                                setSettingsForm((prev) => Object.assign({}, prev, { deepseekModel: event.target.value })),
                            },
                            [...new Set([settingsForm.deepseekModel, ...modelInfo.models].filter(Boolean))].map((model) =>
                              h('option', { key: model, value: model }, model),
                            ),
                          ),
                        ),
                        settingsError ? h('div', { key: 'err', className: 'zt-field-error' }, settingsError) : null,
                      ],
                ),
                h(
                  'div',
                  { className: 'zt-modal-foot' },
                  h('button', { className: 'zt-btn zt-btn-ghost', type: 'button', onClick: () => setSettingsOpen(false) }, '取消'),
                  h(
                    'button',
                    { className: 'zt-btn zt-btn-primary', type: 'button', disabled: settingsSaving || settingsLoading, onClick: saveSettingsForm },
                    settingsSaving ? '保存中…' : '保存',
                  ),
                ),
              ),
            )
          : null,
        layout.leftOpen
          ? h(
              'aside',
              { className: 'zt-pane zt-left', style: { width: layout.leftW } },
              h(
                'div',
                { className: 'zt-pane-head' },
                h(
                  'div',
                  { className: 'zt-head-actions' },
                  h(
                    'div',
                    { className: 'zt-view-switch', role: 'tablist', 'aria-label': '页面切换' },
                    h(
                      'button',
                      {
                        type: 'button',
                        role: 'tab',
                        'aria-selected': view === 'dashboard' ? 'true' : 'false',
                        className: 'zt-view-btn' + (view === 'dashboard' ? ' zt-view-btn-active' : ''),
                        onClick: () => switchView('dashboard'),
                      },
                      '仪表盘',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        role: 'tab',
                        'aria-selected': view === 'list' ? 'true' : 'false',
                        className: 'zt-view-btn' + (view === 'list' ? ' zt-view-btn-active' : ''),
                        onClick: () => switchView('list'),
                      },
                      '列表',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        role: 'tab',
                        'aria-selected': view === 'team' ? 'true' : 'false',
                        className: 'zt-view-btn' + (view === 'team' ? ' zt-view-btn-active' : ''),
                        onClick: () => switchView('team'),
                      },
                      '全员任务',
                    ),
                  ),
                  h(
                    'button',
                    {
                      className: 'zt-icon-btn' + (treeBusy ? ' zt-spinning' : ''),
                      title: treeBusy ? '刷新中…' : '刷新项目/迭代',
                      'aria-label': '刷新项目/迭代',
                      disabled: treeBusy,
                      onClick: refreshAll,
                    },
                    h(GlyphIcon, { name: 'refresh', size: 16 }),
                  ),
                  h(
                    'button',
                    {
                      className: 'zt-icon-btn',
                      title: '收起左栏',
                      'aria-label': '收起左栏',
                      onClick: () => setLayout((l) => Object.assign({}, l, { leftOpen: false })),
                    },
                    h(GlyphIcon, { name: 'chevron-left', size: 16 }),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'zt-tree-filter-row' },
                searchOpen
                  ? h(
                      'div',
                      { className: 'zt-tree-search' },
                      h('span', { className: 'zt-tree-search-icon' }, h(GlyphIcon, { name: 'search', size: 16 })),
                      h('input', {
                        ref: searchInputRef,
                        className: 'zt-tree-search-input',
                        type: 'search',
                        placeholder: '搜索项目 / 迭代…',
                        value: filter,
                        onChange: (e) => setFilter(e.target.value),
                        onKeyDown: (e) => {
                          if (e.key === 'Escape') closeSearch();
                        },
                        'aria-label': '搜索项目 / 迭代',
                      }),
                      h(
                        'button',
                        { className: 'zt-icon-btn', title: '关闭搜索', 'aria-label': '关闭搜索', onClick: closeSearch },
                        h(GlyphIcon, { name: 'close', size: 16 }),
                      ),
                    )
                  : [
                      h('span', { key: 'label', className: 'zt-tree-filter-label' }, '显示进行中'),
                      h(
                        'div',
                        { key: 'actions', className: 'zt-tree-filter-actions' },
                        h(
                          'button',
                          {
                            className: 'zt-icon-btn',
                            title: '搜索项目 / 迭代',
                            'aria-label': '搜索项目 / 迭代',
                            onClick: () => setSearchOpen(true),
                          },
                          h(GlyphIcon, { name: 'search', size: 16 }),
                        ),
                        h(
                          'button',
                          {
                            className: 'zt-switch' + (showActiveOnly ? ' zt-switch-on' : ''),
                            type: 'button',
                            role: 'switch',
                            'aria-checked': showActiveOnly ? 'true' : 'false',
                            'aria-label': '只显示进行中的项目和迭代',
                            title: showActiveOnly ? '显示全部项目/迭代' : '只显示进行中的项目/迭代',
                            onClick: toggleShowActiveOnly,
                          },
                          h('span', { className: 'zt-switch-handle', 'aria-hidden': true }),
                        ),
                      ),
                    ],
              ),
                !query && pinned.length
                  ? h(
                      'div',
                      { className: 'zt-pinned' },
                      h('div', { className: 'zt-pinned-head' }, '置顶'),
                      pinned.map((item) =>
                        h(
                          'div',
                          {
                            key: 'pin-' + item.executionId,
                            className:
                              'zt-tree-row zt-pinned-row' + (selection.executionId === item.executionId ? ' zt-active' : ''),
                            title: item.projectName ? item.projectName + ' / ' + item.executionName : item.executionName,
                            draggable: true,
                            onDragStart: (event) =>
                              onDragStart(event, {
                                type: 'execution',
                                id: item.executionId,
                                title: item.executionName,
                                projectId: item.projectId,
                                projectName: item.projectName,
                              }),
                            onClick: () =>
                              selectExecution(
                                { id: item.projectId, name: item.projectName },
                                { id: item.executionId, name: item.executionName },
                              ),
                          },
                          h('span', { className: 'zt-tree-icon zt-pinned-icon' }, h(GlyphIcon, { name: 'bookmark', size: 16 })),
                          h('span', { className: 'zt-name' }, item.executionName),
                          h(
                            'button',
                            {
                              className: 'zt-pinned-unpin',
                              type: 'button',
                              title: '取消置顶',
                              'aria-label': '取消置顶',
                              onClick: (event) => {
                                event.stopPropagation();
                                unpinExecution(item.executionId);
                              },
                            },
                            h(GlyphIcon, { name: 'close', size: 14 }),
                          ),
                        ),
                      ),
                    )
                  : null,
              h(
                'div',
                { className: 'zt-tree-head' },
                h(
                  'button',
                  {
                    className: 'zt-tree-head-btn' + (treeSort.key === 'name' ? ' zt-tree-head-active' : ''),
                    type: 'button',
                    title: treeSort.key === 'name' && treeSort.dir === -1 ? '按项目名称倒序' : '按项目名称正序',
                    onClick: () => toggleTreeSort('name'),
                  },
                  h('span', { className: 'zt-tree-head-label' }, '项目/迭代'),
                  treeSort.key === 'name'
                    ? h('span', { className: 'zt-tree-head-arrow' }, h(GlyphIcon, { name: treeSort.dir === 1 ? 'arrow-up' : 'arrow-down', size: 16 }))
                    : null,
                ),
                (() => {
                  const ids = visibleProjects.map(({ project }) => project.id);
                  const allOpen = ids.length > 0 && ids.every((id) => !!openProjects[id]);
                  return h(
                    'button',
                    {
                      className: 'zt-tree-head-btn zt-tree-head-toggle',
                      type: 'button',
                      title: allOpen ? '折叠全部项目' : '展开全部项目',
                      'aria-label': allOpen ? '折叠全部项目' : '展开全部项目',
                      disabled: Boolean(query),
                      onClick: toggleAllProjects,
                    },
                    h(GlyphIcon, { name: allOpen ? 'fold-vertical' : 'unfold-vertical', size: 16 }),
                  );
                })(),
                h(
                  'button',
                  {
                    className:
                      'zt-tree-head-btn zt-tree-head-status' + (treeSort.key === 'status' ? ' zt-tree-head-active' : ''),
                    type: 'button',
                    title: treeSort.key === 'status' && treeSort.dir === -1 ? '按项目状态倒序' : '按项目状态正序',
                    onClick: () => toggleTreeSort('status'),
                  },
                  h('span', { className: 'zt-tree-head-label' }, '状态'),
                  treeSort.key === 'status'
                    ? h('span', { className: 'zt-tree-head-arrow' }, h(GlyphIcon, { name: treeSort.dir === 1 ? 'arrow-up' : 'arrow-down', size: 16 }))
                    : null,
                ),
              ),
              h(
                'div',
                { className: 'zt-tree' },
                treeError ? h('div', { className: 'zt-empty' }, '加载失败：' + treeError) : null,
                !treeError && projects.length === 0
                  ? h('div', { className: 'zt-empty' }, showActiveOnly ? '暂无进行中的项目' : '暂无可见项目')
                  : null,
                !treeError && query && visibleProjects.length === 0
                  ? h('div', { className: 'zt-empty' }, '没有匹配的项目或迭代')
                  : null,
                !treeError && treeBusy ? h('div', { className: 'zt-tree-busy' }, '刷新中…') : null,
                visibleProjects.map(({ project, execs: execList }) => {
                  const open = query ? true : !!openProjects[project.id];
                  return h(
                    'div',
                    { key: 'p' + project.id, className: 'zt-tree-group' },
                    h(
                      'div',
                      {
                        className: 'zt-tree-row zt-tree-project' + (project.status === 'closed' ? ' zt-tree-closed' : ''),
                        draggable: true,
                        onDragStart: (e) => onDragStart(e, { type: 'project', id: project.id, title: project.name }),
                        onClick: () => toggleProject(project),
                        onContextMenu: (event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setTreeMenu({
                            type: 'project',
                            id: project.id,
                            name: project.name,
                            status: project.status,
                            x: Math.min(event.clientX, Math.max(8, window.innerWidth - 190)),
                            y: Math.min(event.clientY, Math.max(8, window.innerHeight - 170)),
                          });
                        },
                      },
                      h(
                        'span',
                        { className: 'zt-tree-icon' + (open ? ' zt-tree-icon-open' : '') },
                        projectEmojis[project.id]
                          ? h('span', { className: 'zt-tree-emoji', 'aria-hidden': true }, projectEmojis[project.id])
                          : h(
                              'span',
                              { className: 'zt-tree-icon-folder' },
                              h(GlyphIcon, { name: open ? 'folder-open' : 'folder', size: 16 }),
                            ),
                        h(
                          'span',
                          { className: 'zt-tree-icon-caret' },
                          h(GlyphIcon, { name: open ? 'chevron-down' : 'chevron-right', size: 16 }),
                        ),
                      ),
                      h('span', { className: 'zt-name', title: project.name }, project.name),
                      h('span', { className: 'zt-status' }, h(StatusDot, { status: project.status }), project.statusText || ''),
                    ),
                    h(
                      'div',
                      { className: 'zt-tree-children-wrap' + (open ? ' zt-tree-children-open' : '') },
                      h(
                        'div',
                        { className: 'zt-tree-children' },
                        execList.length === 0 && !query && execs[project.id]
                          ? h('div', { className: 'zt-empty zt-empty-sm' }, '暂无迭代')
                          : null,
                        execList.map((exec) =>
                            h(
                              'div',
                              {
                                key: 'e' + exec.id,
                                className:
                                  'zt-tree-row zt-tree-exec' +
                                  (selection.executionId === exec.id ? ' zt-active' : '') +
                                  (exec.status === 'closed' ? ' zt-tree-closed' : ''),
                                draggable: true,
                                onDragStart: (e) =>
                                  onDragStart(e, {
                                    type: 'execution',
                                    id: exec.id,
                                    title: exec.name,
                                    projectId: project.id,
                                    projectName: project.name,
                                  }),
                                onClick: () => selectExecution(project, exec),
                                onContextMenu: (event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  setTreeMenu({
                                    type: 'execution',
                                    id: exec.id,
                                    name: exec.name,
                                    status: exec.status,
                                    x: Math.min(event.clientX, Math.max(8, window.innerWidth - 190)),
                                    y: Math.min(event.clientY, Math.max(8, window.innerHeight - 170)),
                                  });
                                },
                              },
                              h('span', { className: 'zt-name', title: exec.name }, exec.name),
                              h(
                                'button',
                                {
                                  className:
                                    'zt-tree-pin' + (pinned.some((item) => item.executionId === exec.id) ? ' zt-tree-pin-active' : ''),
                                  type: 'button',
                                  title: pinned.some((item) => item.executionId === exec.id) ? '取消置顶' : '置顶该迭代',
                                  'aria-label': pinned.some((item) => item.executionId === exec.id) ? '取消置顶' : '置顶该迭代',
                                  onClick: (event) => {
                                    event.stopPropagation();
                                    togglePinned(project, exec);
                                  },
                                },
                                h(GlyphIcon, { name: 'bookmark', size: 14 }),
                              ),
                              h('span', { className: 'zt-status' }, h(StatusDot, { status: exec.status }), exec.statusText || ''),
                            ),
                          ),
                        ),
                      ),
                  );
                }),
              ),
              h(
                'div',
                { className: 'zt-left-foot' },
                h(
                  'div',
                  { className: 'zt-foot-left' },
                  h('span', { className: 'zt-plugin-version', title: '禅道 AI 工作台版本' }, PLUGIN_VERSION),
                  h(
                    'button',
                    {
                      className: 'zt-check-update' + (updateState.available ? ' zt-check-update-new' : ''),
                      type: 'button',
                      disabled: updateState.checking,
                      onClick: checkForUpdates,
                    },
                    updateState.checking ? '检查中…' : '检查更新',
                    updateState.available ? h('span', { className: 'zt-update-dot', 'aria-hidden': true }) : null,
                  ),
                ),
                h(
                  'div',
                  { className: 'zt-foot-right' },
                  h(
                    'button',
                    {
                      className: 'zt-icon-btn zt-settings-btn',
                      type: 'button',
                      title: '设置禅道账号与模型',
                      'aria-label': '设置',
                      onClick: openSettings,
                    },
                    h(GlyphIcon, { name: 'settings', size: 16 }),
                  ),
                  h(
                    'button',
                    {
                      className: 'zt-icon-btn zt-bell-btn',
                      type: 'button',
                      title: assignEvents.unread ? '指派提醒（' + assignEvents.unread + ' 条未读）' : '指派提醒',
                      'aria-label': '指派提醒',
                      onClick: () => setAssignMenuOpen((v) => !v),
                    },
                    h(GlyphIcon, { name: 'bell', size: 16 }),
                    assignEvents.unread ? h('span', { className: 'zt-bell-dot', 'aria-hidden': true }) : null,
                  ),
                ),
                updateState.text
                  ? h(
                      'div',
                      { className: 'zt-update-pop zt-update-pop-' + (updateState.tone || 'info') },
                      h('span', { className: 'zt-update-pop-text' }, updateState.text),
                      h(
                        'button',
                        {
                          className: 'zt-update-pop-close',
                          type: 'button',
                          title: '关闭',
                          'aria-label': '关闭',
                          onClick: () => setUpdateState((prev) => Object.assign({}, prev, { text: '', available: '' })),
                        },
                        h(GlyphIcon, { name: 'close', size: 12 }),
                      ),
                    )
                  : null,
                assignMenuOpen ? renderAssignMenu() : null,
              ),
            )
          : h(
              'div',
              { className: 'zt-rail zt-rail-left' },
              h(
                'button',
                {
                  className: 'zt-icon-btn',
                  title: '展开项目/迭代',
                  'aria-label': '展开项目/迭代',
                  onClick: () => setLayout((l) => Object.assign({}, l, { leftOpen: true })),
                },
                h(GlyphIcon, { name: 'chevron-right', size: 16 }),
              ),
            ),
        layout.leftOpen ? h('div', { className: 'zt-split', onMouseDown: (e) => startDrag('left', e) }) : null,
        h(
          'main',
          {
            className: 'zt-main' + (view === 'dashboard' ? ' zt-main-dashboard' : view === 'team' ? ' zt-main-team' : ''),
            onDoubleClick: (event) => {
              if (view !== 'list' || !['story', 'bug', 'task'].includes(tab) || !selection.executionId) return;
              if (event.target.closest('tr, button, a, input, select, textarea, .zt-main-head, .zt-modal-dialog')) return;
              event.preventDefault();
              if (tab === 'task') openTaskModal(undefined, selection.executionId);
              else openItemModal(tab);
            },
            onContextMenu: (event) => {
              if (view !== 'list' || !['story', 'bug', 'task'].includes(tab) || !selection.executionId) return;
              if (event.target.closest('tr, button, a, input, select, textarea, .zt-main-head, .zt-modal-dialog')) return;
              event.preventDefault();
              setListMenu({
                kind: tab,
                x: Math.min(event.clientX, Math.max(8, window.innerWidth - 190)),
                y: Math.min(event.clientY, Math.max(8, window.innerHeight - 60)),
              });
            },
          },
          view === 'dashboard' ? h('div', { className: 'zt-main-dragstrip', 'aria-hidden': true }) : null,
          view === 'dashboard' ? h('div', { className: 'zt-dashboard' }, renderDashboard()) : null,
          view === 'team' ? h('div', { className: 'zt-team-wrap' }, renderTeamTasks()) : null,
          h(
            'div',
            { className: 'zt-main-head' },
            renderTabs(
              ['task', 'story', 'bug', 'testtask', 'report'].map((key) => ({
                key,
                label: TAB_LABELS[key],
                count: TAB_COUNTS[key],
              })),
              tab,
              setTab,
            ),
            h(
              'div',
              { className: 'zt-main-actions' },
              h(
                'span',
                {
                  className: 'zt-current',
                  title: selection.executionId
                    ? (selection.projectName ? selection.projectName + ' / ' : '') + selection.executionName + '（#' + selection.executionId + '）'
                    : '未选择迭代',
                },
                selection.executionId ? selection.executionName + '（#' + selection.executionId + '）' : '未选择迭代',
              ),
              nativeMode && layoutSvc && typeof layoutSvc.selectPanel === 'function'
                ? h(
                    'button',
                    {
                      className: 'zt-chip-btn',
                      type: 'button',
                      title: '切到 DeepSeek 原生会话聊天',
                      onClick: () => layoutSvc.selectPanel('conversation'),
                    },
                    h(GlyphIcon, { name: 'chevron-right', size: 16 }),
                    '打开会话',
                  )
                : null,
              h(
                'div',
                {
                  className: 'zt-only-mine-switch',
                  title: onlyMine ? '关闭筛选：显示全部需求/BUG' : '只看指派给我的需求/BUG',
                  onClick: toggleOnlyMine,
                },
                h('span', { className: 'zt-only-mine-label' }, '只看我'),
                h(
                  'button',
                  {
                    className: 'zt-switch' + (onlyMine ? ' zt-switch-on' : ''),
                    type: 'button',
                    role: 'switch',
                    'aria-checked': onlyMine ? 'true' : 'false',
                    'aria-label': '只看我',
                    onClick: (e) => {
                      e.stopPropagation();
                      toggleOnlyMine();
                    },
                  },
                  h('span', { className: 'zt-switch-handle', 'aria-hidden': true }),
                ),
              ),
              h(
                'button',
                {
                  className: 'zt-icon-btn' + (loading ? ' zt-spinning' : ''),
                  title: loading ? '刷新中…' : selection.executionId ? '刷新需求 / BUG（跳过缓存）' : '请先在左侧选择一个迭代',
                  'aria-label': '刷新需求 / BUG',
                  disabled: !selection.executionId || loading,
                  onClick: () => loadItems(selection.executionId, true),
                },
                h(GlyphIcon, { name: 'refresh', size: 16 }),
              ),
            ),
          ),
          h(
            'div',
            { className: 'zt-table-wrap' },
            listError ? h('div', { className: 'zt-empty' }, '加载失败：' + listError) : null,
            !listError && !selection.executionId
              ? h(EmptyState, { icon: 'view-list', title: '暂未选择迭代' })
              : null,
            !listError && selection.executionId && !loading && list.length === 0
              ? h(EmptyState, {
                  icon: tab === 'bug' ? 'bug' : 'file',
                  title: onlyMine ? '暂无指派给我的' + TAB_LABELS[tab] : '暂无' + TAB_LABELS[tab],
                })
              : null,
            list.length
              ? h(
                  'table',
                  {
                    className: 'zt-table zt-table-' + tab + (colWidths ? ' zt-cols-fixed' : ''),
                    style: colWidths
                      ? {
                          // Resized columns keep their px widths, but the table
                          // still fills the pane: extra space is distributed
                          // instead of leaving a blank area on the right.
                          width: '100%',
                        }
                      : undefined,
                  },
                  colWidths
                    ? h(
                        'colgroup',
                        null,
                        visibleColumns.map((column) =>
                          h('col', {
                            key: column.key,
                            style: { width: (column.virtual ? colWidths[column.key] || 72 : colWidths[column.key] || 80) + 'px' },
                          }),
                        ),
                      )
                    : null,
                  h(
                    'thead',
                    null,
                    h(
                      'tr',
                      null,
                      visibleColumns.map((column) => {
                        const active = sort.key === column.key;
                        if (!isCoreTab) {
                          return h(
                            'th',
                            {
                              key: column.key,
                              'data-col': column.key,
                              className: column.className + (active ? ' zt-th-sorted zt-th-sorted-' + sort.dir : ''),
                              'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
                              title: '点击按「' + column.label + '」排序，拖动右边缘调整列宽',
                            },
                            h(
                              'button',
                              { className: 'zt-th-btn', type: 'button', onClick: () => toggleSort(column.key) },
                              h('span', { className: 'zt-th-label' }, column.label),
                              active
                                ? h(
                                    'span',
                                    { className: 'zt-sort', 'aria-hidden': true },
                                    h(GlyphIcon, { name: sort.dir === 'asc' ? 'arrow-up' : 'arrow-down', size: 16 }),
                                  )
                                : null,
                            ),
                            h('span', {
                              className: 'zt-col-resize',
                              title: '拖动调整列宽，双击恢复默认列宽',
                              onMouseDown: (e) => startColResize(e, column),
                              onDoubleClick: resetColWidths,
                            }),
                          );
                        }
                        if (column.virtual) {
                          return h(
                            'th',
                            {
                              key: column.key,
                              'data-col': column.key,
                              className: column.className + (active ? ' zt-th-sorted zt-th-sorted-' + sort.dir : ''),
                              'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
                            },
                            h(
                              'button',
                              { className: 'zt-th-btn', type: 'button', onClick: () => toggleSort(column.key) },
                              h('span', { className: 'zt-th-label' }, column.label),
                              active
                                ? h(
                                    'span',
                                    { className: 'zt-sort', 'aria-hidden': true },
                                    h(GlyphIcon, { name: sort.dir === 'asc' ? 'arrow-up' : 'arrow-down', size: 16 }),
                                  )
                                : null,
                            ),
                            h('span', {
                              className: 'zt-col-resize',
                              title: '拖动调整列宽，双击恢复默认列宽与列顺序',
                              onMouseDown: (e) => startColResize(e, column),
                              onDoubleClick: resetColWidths,
                            }),
                          );
                        }
                        const hint =
                          dropHint.key === column.key
                            ? draggingCol && draggingCol !== column.key
                              ? ' zt-col-drop-' + dropHint.side
                              : ''
                            : '';
                        return h(
                          'th',
                          {
                            key: column.key,
                            'data-col': column.key,
                            className: column.className + (active ? ' zt-th-sorted zt-th-sorted-' + sort.dir : '') + hint + (draggingCol === column.key ? ' zt-col-dragging' : ''),
                            'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
                            draggable: true,
                            onDragStart: (e) => {
                              setDraggingCol(column.key);
                              setDropHint({ key: '', side: '' });
                              e.dataTransfer.effectAllowed = 'move';
                              try {
                                e.dataTransfer.setData('text/plain', column.key);
                              } catch (error) {
                                /* older engines */
                              }
                            },
                            onDragOver: (e) => {
                              if (!draggingCol || draggingCol === column.key) return;
                              e.preventDefault();
                              e.dataTransfer.dropEffect = 'move';
                              const rect = e.currentTarget.getBoundingClientRect();
                              const side = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
                              if (dropHint.key !== column.key || dropHint.side !== side) setDropHint({ key: column.key, side });
                            },
                            onDragLeave: (e) => {
                              if (e.currentTarget === e.target) setDropHint({ key: '', side: '' });
                            },
                            onDrop: (e) => {
                              e.preventDefault();
                              const from = draggingCol || e.dataTransfer.getData('text/plain');
                              moveColumn(from, column.key, dropHint.side || 'before');
                              setDraggingCol('');
                              setDropHint({ key: '', side: '' });
                            },
                            onDragEnd: () => {
                              setDraggingCol('');
                              setDropHint({ key: '', side: '' });
                            },
                            title: active
                              ? sort.dir === 'asc' ? '当前升序，点击改为降序；拖动可调整列顺序' : '当前降序，点击改为升序；拖动可调整列顺序'
                              : '点击按「' + column.label + '」排序；拖动可调整列顺序',
                          },
                          h(
                            'button',
                            { className: 'zt-th-btn', type: 'button', onClick: () => toggleSort(column.key) },
                            h('span', { className: 'zt-th-label' }, column.label),
                            active
                              ? h(
                                  'span',
                                  { className: 'zt-sort', 'aria-hidden': true },
                                  h(GlyphIcon, { name: sort.dir === 'asc' ? 'arrow-up' : 'arrow-down', size: 16 }),
                                )
                              : null,
                          ),
                          h('span', {
                            className: 'zt-col-resize',
                            title: '拖动调整列宽，双击恢复默认列宽与列顺序',
                            onMouseDown: (e) => startColResize(e, column),
                            onDoubleClick: resetColWidths,
                          }),
                        );
                      }),
                    ),
                  ),
                  h(
                    'tbody',
                    null,
                    sortedList.map((item) =>
                      h(
                        'tr',
                        {
                          key: item.type + item.id,
                          draggable: true,
                          onDragStart: (e) => onDragStart(e, { type: item.type, id: item.id, title: item.title }),
                        },
                        visibleColumns.map((column) => renderCell(item, column.key)),
                      ),
                    ),
                  ),
                )
              : null,
          ),
        ),
        nativeMode ? null : layout.rightOpen ? h('div', { className: 'zt-split', onMouseDown: (e) => startDrag('right', e) }) : null,
        nativeMode
          ? null
          : layout.rightOpen
          ? h(
              'aside',
              { className: 'zt-pane zt-right', style: { width: layout.rightW } },
              h(
                'div',
                { className: 'zt-pane-head' },
                h(
                  'span',
                  { className: 'zt-pane-title' },
                  (conversations.find((c) => c.id === activeId) || {}).title || 'DeepSeek 会话',
                ),
                h(
                  'div',
                  { className: 'zt-head-actions' },
                  h(
                    'button',
                    {
                      className: 'zt-icon-btn',
                      title: '历史会话',
                      'aria-label': '历史会话',
                      onClick: () => setHistoryOpen((v) => !v),
                    },
                    h(GlyphIcon, { name: 'history', size: 16 }),
                  ),
                  h('button', { className: 'zt-icon-btn', title: '新建会话', 'aria-label': '新建会话', onClick: startNewConversation }, h(GlyphIcon, { name: 'new-chat', size: 16 })),
                  h('button', { className: 'zt-icon-btn', title: '收起右栏', 'aria-label': '收起右栏', onClick: () => setLayout((l) => Object.assign({}, l, { rightOpen: false })) }, h(GlyphIcon, { name: 'chevron-right', size: 16 })),
                ),
              ),
              historyOpen ? renderHistoryMenu() : null,
              h(
                'div',
                { className: 'zt-chat', ref: scrollRef },
                messages.length === 0
                  ? h(
                      'div',
                      { className: 'zt-chat-empty' },
                      h('div', { className: 'zt-chat-empty-title' }, '把左侧对象拖进来，或直接描述需求'),
                      h('div', { className: 'zt-suggestions' }, quickButtonNodes('zt-suggest-btn')),
                    )
                  : messages.map((msg) =>
                      h(
                        'div',
                        { key: msg.id, className: 'zt-msg zt-msg-' + msg.role },
                        msg.text
                          ? h(
                              'div',
                              { className: 'zt-bubble' + (msg.role === 'assistant' ? ' zt-markdown' : '') },
                              msg.role === 'assistant' ? renderMarkdown(msg.text) : msg.text,
                            )
                          : msg.role === 'assistant' && msg.cards.length === 0 && !busy
                            ? null
                            : null,
                        msg.role === 'user' && msg.images && msg.images.length
                          ? h(
                              'div',
                              { className: 'zt-msg-image-names' },
                              msg.images.map((image, index) =>
                                h('span', { key: index, className: 'zt-msg-image-name' }, '🖼 ' + (image.name || '图片')),
                              ),
                            )
                          : null,
                        msg.role === 'user' && msg.text
                          ? h(
                              'div',
                              { className: 'zt-msg-meta' },
                              msg.at ? h('span', { className: 'zt-msg-time' }, formatChatTime(msg.at)) : null,
                              h(
                                'button',
                                {
                                  className: 'zt-icon-btn zt-msg-action' + (copiedMsgId === msg.id ? ' zt-msg-copied' : ''),
                                  type: 'button',
                                  title: copiedMsgId === msg.id ? '已复制' : '复制',
                                  'aria-label': copiedMsgId === msg.id ? '已复制' : '复制',
                                  onClick: () => copyMessageText(msg.text, msg.id),
                                },
                                h(GlyphIcon, { name: 'copy', size: 16 }),
                              ),
                            )
                          : null,
                        msg.cards.map((card, index) =>
                          h(Card, {
                            key: msg.id + '-c' + index,
                            card,
                            baseUrl,
                            onAction: (action) => send('', action),
                            onCardEdit: (edit) => handleCardEdit(msg.id, index, edit),
                          }),
                        ),
                      ),
                    ),
                statusText ? h('div', { className: 'zt-typing' }, statusText) : null,
                busy && !statusText ? h('div', { className: 'zt-typing' }, '正在思考…') : null,
              ),
              h(
                'div',
                { className: 'zt-composer' + (dropActive ? ' zt-drop-active' : '') },
                h('div', {
                  className: 'zt-resize',
                  title: '拖动调整输入框高度（双击恢复默认）',
                  onMouseDown: startInputResize,
                  onDoubleClick: () => setInputH(DEFAULT_INPUT_H),
                }),
                contexts.length
                  ? h(
                      'div',
                      { className: 'zt-chips' },
                      contexts.map((item) =>
                        h(
                          'span',
                          { key: item.type + item.id, className: 'zt-chip', title: item.title },
                          h('span', { className: 'zt-chip-type' }, CONTEXT_LABEL[item.type] || item.type),
                          h('span', { className: 'zt-chip-text' }, '#' + item.id),
                          h(
                            'button',
                            { className: 'zt-chip-x', title: '移除', onClick: () => removeContext(item) },
                            h(GlyphIcon, { name: 'close', size: 16 }),
                          ),
                        ),
                      ),
                    )
                  : null,
                pendingImages.length
                  ? h(
                      'div',
                      { className: 'zt-image-chips' },
                      pendingImages.map((image, index) =>
                        h(
                          'div',
                          { key: index, className: 'zt-image-chip', title: image.name },
                          h('img', { src: image.preview, alt: image.name }),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'zt-image-chip-x',
                              title: '移除图片',
                              'aria-label': '移除图片',
                              onClick: () => removePendingImage(index),
                            },
                            h(GlyphIcon, { name: 'close', size: 12 }),
                          ),
                        ),
                      ),
                    )
                  : null,
                renderComposerMenu(),
                h(
                  'div',
                  { className: 'zt-composer-card' },
                  h(
                    'textarea',
                    {
                      className: 'zt-input',
                    rows: 3,
                    style: { height: inputH + 'px', resize: 'none' },
                    placeholder: 'Enter 发送，Shift + Enter 换行。/ 选择功能，@ 选择迭代',
                    value: input,
                    readOnly: recording,
                    onChange: (e) => {
                      setInput(e.target.value);
                      analyzeComposerInput(e.target.value);
                    },
                    onDragOver: (e) => {
                      e.preventDefault();
                      setDropActive(true);
                    },
                    onDragLeave: () => setDropActive(false),
                    onDrop,
                    onPaste: handleImagePaste,
                    onKeyDown: (e) => {
                      if (e.key === 'Escape' && composerMenu) {
                        e.preventDefault();
                        setComposerMenu(null);
                        return;
                      }
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        send(input, null);
                      }
                    },
                  }),
                  h(
                    'div',
                    { className: 'zt-composer-row' },
                    h(
                      'div',
                      { className: 'zt-composer-tools' },
                      h(
                        'button',
                        {
                          className: 'zt-tool-btn',
                          type: 'button',
                          title: '更多功能（输入 / 也可以打开）',
                          'aria-label': '更多功能',
                          onClick: toggleCommandsMenu,
                        },
                        h(GlyphIcon, { name: 'plus', size: 16 }),
                      ),
                      h(
                        'button',
                        {
                          className: 'zt-tool-btn',
                          type: 'button',
                          title: docBusy ? '正在读取文档…' : '上传需求文档（.md / .txt / .docx）',
                          'aria-label': '上传需求文档',
                          disabled: docBusy,
                          onClick: () => docInputRef.current && docInputRef.current.click(),
                        },
                        docBusy ? h('span', { className: 'zt-spinner' }) : h(GlyphIcon, { name: 'attach', size: 16 }),
                      ),
                      h('input', {
                        ref: docInputRef,
                        type: 'file',
                        accept: '.md,.markdown,.txt,.docx',
                        style: { display: 'none' },
                        onChange: onDocumentSelected,
                      }),
                    ),
                    h(
                      'div',
                      { className: 'zt-composer-actions' },
                      modelInfo.models.length
                        ? h(
                            'span',
                            { className: 'zt-model-wrap' },
                            h(
                              'select',
                              {
                                className: 'zt-model-chip',
                                value: modelInfo.current || modelInfo.models[0],
                                title: '选择对话模型',
                                'aria-label': '选择对话模型',
                                onChange: (event) => setChatModel(event.target.value),
                              },
                              modelInfo.models.map((model) =>
                                h('option', { key: model, value: model }, modelLabel(model)),
                              ),
                            ),
                            h(GlyphIcon, { name: 'chevron-down', size: 12 }),
                          )
                        : null,
                      h(
                        'button',
                        {
                          className: 'zt-tool-btn zt-mic-btn' + (recording ? ' zt-tool-recording' : ''),
                          type: 'button',
                          disabled: busy || transcribing || voiceStarting,
                          title: recording ? '停止录音' : transcribing ? '正在识别…' : '语音输入',
                          'aria-label': recording ? '停止录音' : '语音输入',
                          onClick: recording ? stopRecording : startRecording,
                        },
                        transcribing || voiceStarting
                          ? h('span', { className: 'zt-spinner' })
                          : h(GlyphIcon, { name: 'mic', size: 17 }),
                      ),
                      h(
                        'button',
                        {
                          className: 'zt-send' + (busy ? ' zt-send-busy' : ''),
                          disabled: busy || (!input.trim() && !contexts.length),
                          title: busy ? '生成中…' : '发送',
                          'aria-label': busy ? '生成中' : '发送',
                          onClick: () => send(input, null),
                        },
                        busy ? h('span', { className: 'zt-spinner' }) : h(GlyphIcon, { name: 'arrow-up', size: 16 }),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : h(
              'div',
              { className: 'zt-rail zt-rail-right' },
              h(
                'button',
                {
                  className: 'zt-icon-btn',
                  title: '展开 DeepSeek 会话',
                  'aria-label': '展开 DeepSeek 会话',
                  onClick: () => setLayout((l) => Object.assign({}, l, { rightOpen: true })),
                },
                h(GlyphIcon, { name: 'chevron-left', size: 16 }),
              ),
            ),
        treeMenu
          ? [
              h('div', { key: 'tree-backdrop', className: 'zt-menu-backdrop', onClick: () => setTreeMenu(null) }),
              h(
                'div',
                { key: 'tree-menu', className: 'zt-context-menu', style: { left: treeMenu.x, top: treeMenu.y }, role: 'menu' },
                h('div', { className: 'zt-context-head' }, treeMenu.name),
                treeMenu.type === 'project'
                  ? [
                      h(
                        'button',
                        {
                          key: 'create-iteration',
                          type: 'button',
                          className: 'zt-context-item',
                          role: 'menuitem',
                          onClick: () => openIterationModal({ id: treeMenu.id, name: treeMenu.name }),
                        },
                        h(GlyphIcon, { name: 'plus', size: 14 }),
                        h('span', null, '创建迭代'),
                      ),
                      h(
                        'div',
                        { key: 'status-subwrap', className: 'zt-context-subwrap' },
                        h(
                          'button',
                          { type: 'button', className: 'zt-context-item', role: 'menuitem' },
                          h(GlyphIcon, { name: 'settings', size: 14 }),
                          h('span', null, '修改状态'),
                          h('span', { className: 'zt-context-caret' }, h(GlyphIcon, { name: 'chevron-right', size: 12 })),
                        ),
                        h('div', { className: 'zt-context-menu zt-context-sub', role: 'menu' }, treeStatusItems()),
                      ),
                      h(
                        'button',
                        {
                          key: 'custom-emoji',
                          type: 'button',
                          className: 'zt-context-item',
                          role: 'menuitem',
                          onClick: () => {
                            setTreeMenu(null);
                            setEmojiModal({
                              projectId: treeMenu.id,
                              projectName: treeMenu.name,
                              value: projectEmojis[treeMenu.id] || '',
                            });
                          },
                        },
                        h('span', { className: 'zt-context-emoji' }, projectEmojis[treeMenu.id] || '🙂'),
                        h('span', null, '自定义Emoji'),
                      ),
                    ]
                  : treeStatusItems(),
              ),
            ]
          : null,
        assignToast
          ? h(
              'div',
              { className: 'zt-assign-toast' },
              h(
                'div',
                { className: 'zt-assign-toast-head' },
                h('span', null, '新指派提醒'),
                h(
                  'button',
                  {
                    className: 'zt-icon-btn',
                    type: 'button',
                    title: '关闭提醒',
                    'aria-label': '关闭提醒',
                    onClick: () => setAssignToast(null),
                  },
                  h(GlyphIcon, { name: 'close', size: 16 }),
                ),
              ),
              h(
                'div',
                { className: 'zt-assign-toast-body' },
                [assignToast].filter(Boolean).map((event) =>
                  h(
                    'div',
                    { key: event.id, className: 'zt-assign-toast-row' },
                    h('span', { className: 'zt-assign-kind' }, assignmentKindLabel(event)),
                    h(
                      'a',
                      {
                        className: 'zt-assign-title',
                        href: assignmentUrl(event) || undefined,
                        target: '_blank',
                        rel: 'noreferrer noopener',
                        title: '在浏览器中打开禅道详情',
                        onClick: () => openAssignment(event),
                      },
                      event.title || '（无标题）',
                    ),
                    h('span', { className: 'zt-assign-meta' }, describeAssignment(event)),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'zt-assign-toast-actions' },
                h(
                  'button',
                  {
                    className: 'zt-chip-btn',
                    type: 'button',
                    onClick: () => {
                      setAssignMenuOpen(true);
                      setAssignToast(null);
                    },
                  },
                  '查看全部',
                ),
                h(
                  'button',
                  {
                    className: 'zt-chip-btn',
                    type: 'button',
                    onClick: () => {
                      markAssignmentsRead(null);
                      setAssignToast(null);
                    },
                  },
                  '全部已读',
                ),
              ),
            )
          : null,
        cellPopup,
        actionError ? h('div', { className: 'zt-toast' }, actionError) : null,
      );
    }

    function actionLabel(action) {
      if (!action) return '';
      if (action.type === 'quick') return '开始流程：' + ({ story: '录入需求', bug: '录入 BUG', testcase: '生成测试用例', execution: '新增迭代', status: '修改状态', doc: '批量录入需求' }[action.value] || action.value);
      if (action.type === 'choice') return action.label || '选择：' + action.value;
      if (action.type === 'confirm') return '确认推送';
      return '';
    }

    function AutoTextarea(props) {
      const ref = useRef(null);
      const resize = () => {
        const el = ref.current;
        if (!el) return;
        // rows would floor scrollHeight at a multi-line box; measure one row.
        el.rows = 1;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 360) + 'px';
      };
      useEffect(resize, [props.value]);
      return h(
        'textarea',
        Object.assign({}, props, {
          ref,
          onInput: (event) => {
            if (props.onInput) props.onInput(event);
            resize();
          },
        }),
      );
    }

    // Draft / polished result cards are editable: every field commits on blur and
    // the edit travels with the next chat action so the host can push it.
    function EditablePromptCard(props) {
      const card = props.card;
      const data = card.data || {};
      const isBug = data.type === 'bug';
      const polished = card.kind === 'polish';
      const [values, setValues] = useState(() => ({
        title: String(data.title || ''),
        description: String(data.description || ''),
        acceptance: String(data.acceptance || ''),
        steps: String(data.steps || ''),
        expected: String(data.expected || ''),
      }));
      const commit = () => {
        if (props.onEdit) props.onEdit({ target: polished ? 'polished' : 'draft', values: Object.assign({}, values) });
      };
      const bind = (key) => ({
        value: values[key],
        onChange: (e) => setValues((prev) => Object.assign({}, prev, { [key]: e.target.value })),
        onBlur: commit,
      });
      const textarea = (key, label, rows, placeholder) =>
        h(
          'label',
          { className: 'zt-edit-field' },
          label ? h('span', { className: 'zt-edit-label' }, label) : null,
          h(AutoTextarea, Object.assign({ className: 'zt-edit-textarea', rows: rows || 3, placeholder: placeholder || '' }, bind(key))),
        );
      return h(
        'div',
        { className: 'zt-card' + (polished ? ' zt-card-primary' : '') },
        h(
          'div',
          { className: 'zt-card-head' },
          h('span', { className: 'zt-card-tag' }, polished ? '润色结果' : isBug ? 'BUG 草稿' : '需求草稿'),
          h('span', { className: 'zt-edit-hint' }, '可直接编辑'),
        ),
        h(
          'label',
          { className: 'zt-edit-field' },
          h('span', { className: 'zt-edit-label' }, '标题'),
          h('input', Object.assign({ className: 'zt-edit-title', type: 'text', placeholder: '标题' }, bind('title'))),
        ),
        textarea('description', '描述', 4, '需求/BUG 描述'),
        !isBug ? textarea('acceptance', '验收标准', 3, '可留空') : null,
        isBug ? textarea('steps', '重现步骤', 3, '重现步骤') : null,
        isBug ? textarea('expected', '期望结果', 2, '期望结果') : null,
        polished
          ? h(
              'div',
              { className: 'zt-card-meta' },
              h('span', null, '优先级建议：P' + (data.priority || 3)),
              h('span', null, '模块建议：' + (data.module || '未指定')),
            )
          : null,
      );
    }

    function EditableTestCasesCard(props) {
      const data = props.card.data || {};
      const [cases, setCases] = useState(() =>
        (data.cases || []).map((item) => ({
          title: String(item.title || ''),
          precondition: String(item.precondition || ''),
          steps: Array.isArray(item.steps) && item.steps.length ? item.steps.map((step) => ({ step: String(step.step || ''), expect: String(step.expect || '') })) : [{ step: '', expect: '' }],
          priority: Number(item.priority) || 3,
          direction: item.direction === 'negative' ? 'negative' : 'positive',
        })),
      );
      const commit = () => props.onEdit && props.onEdit({ target: 'cases', values: { cases } });
      const updateCase = (index, key, value) => setCases((prev) => prev.map((item, i) => (i === index ? Object.assign({}, item, { [key]: value }) : item)));
      const updateStep = (caseIndex, stepIndex, key, value) =>
        setCases((prev) =>
          prev.map((item, i) =>
            i !== caseIndex
              ? item
              : Object.assign({}, item, { steps: item.steps.map((step, j) => (j === stepIndex ? Object.assign({}, step, { [key]: value }) : step)) }),
          ),
        );
      return h(
        'div',
        { className: 'zt-card' },
        h('div', { className: 'zt-card-head' }, h('span', { className: 'zt-card-tag' }, '测试用例'), h('span', { className: 'zt-edit-hint' }, '可直接编辑')),
        cases.map((item, i) =>
          h(
            'div',
            { key: i, className: 'zt-case' },
            h('label', { className: 'zt-edit-field' }, h('span', { className: 'zt-edit-label' }, `用例 ${i + 1}`), h('input', { className: 'zt-edit-title', value: item.title, onChange: (e) => updateCase(i, 'title', e.target.value), onBlur: commit })),
            h('label', { className: 'zt-edit-field' }, h('span', { className: 'zt-edit-label' }, '前置条件'), h(AutoTextarea, { className: 'zt-edit-textarea', rows: 2, value: item.precondition, onChange: (e) => updateCase(i, 'precondition', e.target.value), onBlur: commit })),
            item.steps.map((step, j) =>
              h('div', { key: j, className: 'zt-case-edit-step' },
                h('span', { className: 'zt-edit-label' }, `步骤 ${j + 1}`),
                h(AutoTextarea, { className: 'zt-edit-textarea', rows: 2, value: step.step, onChange: (e) => updateStep(i, j, 'step', e.target.value), onBlur: commit }),
                h(AutoTextarea, { className: 'zt-edit-textarea', rows: 2, placeholder: '预期结果', value: step.expect, onChange: (e) => updateStep(i, j, 'expect', e.target.value), onBlur: commit }),
              ),
            ),
            h('label', { className: 'zt-edit-field' }, h('span', { className: 'zt-edit-label' }, '优先级'), h('select', { className: 'zt-select', value: item.priority, onChange: (e) => updateCase(i, 'priority', Number(e.target.value)), onBlur: commit }, [1, 2, 3, 4].map((value) => h('option', { key: value, value }, 'P' + value)))),
          ),
        ),
      );
    }

    function Card(props) {
      const d = props.card.data || {};
      const onAction = props.onAction;
      const kind = props.card.kind;

      if (kind === 'draft' || kind === 'polish') {
        return h(EditablePromptCard, { card: props.card, onEdit: props.onCardEdit });
      }
      if (kind === 'choices') {
        return h(
          'div',
          { className: 'zt-choices' },
          (d.options || []).map((opt) =>
            h(
              'button',
              {
                key: opt.value,
                className: 'zt-choice' + (opt.tone === 'primary' ? ' zt-choice-primary' : ''),
                onClick: () => onAction({ type: 'choice', id: d.id, value: opt.value, label: opt.label }),
              },
              opt.label,
            ),
          ),
        );
      }
      if (kind === 'confirm') {
        return h(
          'div',
          { className: 'zt-card' },
          h('div', { className: 'zt-card-head' }, h('span', { className: 'zt-card-tag zt-card-tag-warn' }, '待写入字段')),
          h(ConfirmForm, { fields: d.fields || [], onSubmit: (values) => onAction({ type: 'confirm', values }) }),
        );
      }
      if (kind === 'testcases') {
        return h(EditableTestCasesCard, { card: props.card, onEdit: props.onCardEdit });
      }
      if (kind === 'result') {
        return h(
          'div',
          { className: 'zt-card zt-result' + (d.ok ? ' zt-result-ok' : ' zt-result-fail') },
          h('div', { className: 'zt-result-title' }, d.ok ? '✓ ' + (d.message || '操作成功') : '✕ ' + (d.message || '操作失败')),
          d.title
            ? h('div', { className: 'zt-result-sub' }, (d.kind === 'execution' ? '迭代' : d.kind === 'bug' ? 'BUG' : '需求') + '「' + d.title + '」')
            : null,
          d.url
            ? h(
                'a',
                { className: 'zt-result-link', href: props.baseUrl + d.url, target: '_blank', rel: 'noreferrer noopener' },
                '在禅道中打开',
              )
            : null,
        );
      }
      if (kind === 'doc-plan') {
        const items = Array.isArray(d.items) ? d.items : [];
        return h(
          'div',
          { className: 'zt-card' },
          h(
            'div',
            { className: 'zt-card-head' },
            h('span', { className: 'zt-card-tag' }, '文档批量录入'),
            h('span', { className: 'zt-card-title' }, (d.count || items.length) + ' 条需求'),
          ),
          h('div', { className: 'zt-card-sub' }, '来源：' + (d.name || '未命名文档') + (d.target ? ' · 写入「' + d.target.projectName + ' / ' + d.target.executionName + '」' : '')),
          h(
            'div',
            { className: 'zt-api-list' },
            items.slice(0, 8).map((item, index) =>
              h(
                'div',
                { key: index, className: 'zt-api-item' },
                h('span', { className: 'zt-api-id' }, String(index + 1) + '.'),
                h('span', { className: 'zt-api-name', title: item.title }, item.title || ''),
              ),
            ),
            items.length > 8 ? h('div', { className: 'zt-card-sub' }, '…还有 ' + (items.length - 8) + ' 条') : null,
          ),
        );
      }
      if (kind === 'doc-result') {
        const items = Array.isArray(d.items) ? d.items : [];
        return h(
          'div',
          { className: 'zt-card' },
          h(
            'div',
            { className: 'zt-card-head' },
            h('span', { className: 'zt-card-tag' }, '批量创建'),
            h('span', { className: 'zt-card-title' }, '成功 ' + (d.ok || 0) + ' / 共 ' + (d.count || items.length) + ' 条'),
          ),
          h(
            'div',
            { className: 'zt-api-list' },
            items.slice(0, 20).map((item, index) =>
              h(
                'div',
                { key: index, className: 'zt-api-item' },
                h('span', { className: 'zt-api-id' }, item.ok ? '✓' : '✕'),
                h('span', { className: 'zt-api-name', title: item.title }, item.title || ''),
                item.ok ? null : h('span', { className: 'zt-api-extra zt-doc-error' }, item.error || '失败'),
              ),
            ),
          ),
        );
      }
      if (kind === 'task-plan') {
        const tasks = Array.isArray(d.tasks) ? d.tasks : [];
        return h(
          'div',
          { className: 'zt-card' },
          h(
            'div',
            { className: 'zt-card-head' },
            h('span', { className: 'zt-card-tag' }, '任务计划'),
            h('span', { className: 'zt-card-title' }, tasks.length + ' 个任务'),
          ),
          h('div', { className: 'zt-card-sub' }, '写入迭代：' + (d.executionName || '未指定')),
          h(
            'div',
            { className: 'zt-api-list' },
            tasks.map((item, index) =>
              h(
                'div',
                { key: index, className: 'zt-api-item' },
                h('span', { className: 'zt-api-id' }, String(index + 1) + '.'),
                h('span', { className: 'zt-api-name', title: item.title }, item.title || ''),
                h(
                  'span',
                  { className: 'zt-api-extra' },
                  'P' + (item.priority || 3) + ' · ' + (item.assignedTo || '未指派') + ' · ' + (item.deadline || '无截止日期'),
                ),
              ),
            ),
          ),
        );
      }
      if (kind === 'task-result') {
        const items = Array.isArray(d.items) ? d.items : [];
        return h(
          'div',
          { className: 'zt-card' },
          h(
            'div',
            { className: 'zt-card-head' },
            h('span', { className: 'zt-card-tag' }, '任务创建'),
            h('span', { className: 'zt-card-title' }, '成功 ' + (d.okCount || 0) + ' / 共 ' + (d.total || items.length) + ' 条'),
          ),
          h('div', { className: 'zt-card-sub' }, '迭代：' + (d.executionName || '')),
          h(
            'div',
            { className: 'zt-api-list' },
            items.map((item, index) =>
              h(
                'div',
                { key: index, className: 'zt-api-item' },
                h('span', { className: 'zt-api-id' }, item.ok ? '✓' : '✕'),
                h('span', { className: 'zt-api-name', title: item.title }, item.title || ''),
                item.ok ? null : h('span', { className: 'zt-api-extra zt-doc-error' }, item.error || '失败'),
              ),
            ),
          ),
        );
      }
      if (kind === 'api-plan') {
        return h(
          'div',
          { className: 'zt-card' },
          h(
            'div',
            { className: 'zt-card-head' },
            h('span', { className: 'zt-card-tag' }, '接口计划'),
            h('span', { className: 'zt-card-title' }, d.summary || d.label || '查询'),
          ),
          h('div', { className: 'zt-api-meta' }, h('span', null, '方法'), h('code', null, d.method || 'GET')),
          h('div', { className: 'zt-api-meta' }, h('span', null, '接口'), h('code', { className: 'zt-api-code' }, d.path || '')),
          h('div', { className: 'zt-card-sub' }, '确认后才会执行查询，不会修改禅道数据。'),
        );
      }
      if (kind === 'api-result') {
        const items = Array.isArray(d.items) ? d.items : [];
        return h(
          'div',
          { className: 'zt-card' },
          h(
            'div',
            { className: 'zt-card-head' },
            h('span', { className: 'zt-card-tag' }, '查询结果'),
            h('span', { className: 'zt-card-title' }, (d.label || '结果') + ' · ' + (d.total || 0) + ' 条'),
          ),
          items.length
            ? h(
                'div',
                { className: 'zt-api-list' },
                items.map((item, index) =>
                  h(
                    'div',
                    { key: item.id || index, className: 'zt-api-item' },
                    h('span', { className: 'zt-api-id' }, '#' + (item.id === undefined ? '?' : item.id)),
                    h('span', { className: 'zt-api-name', title: item.label }, item.label || ''),
                    item.extra ? h('span', { className: 'zt-api-extra' }, item.extra) : null,
                  ),
                ),
              )
            : d.detail
              ? h('pre', { className: 'zt-api-detail' }, JSON.stringify(d.detail, null, 2).slice(0, 2000))
              : h('div', { className: 'zt-card-sub' }, '没有查到数据。'),
          h('div', { className: 'zt-api-path' }, d.path ? '/api.php/v1/' + d.path : ''),
        );
      }
      if (kind === 'status-plan') {
        return h(
          'div',
          { className: 'zt-card' },
          h('div', { className: 'zt-card-head' }, h('span', { className: 'zt-card-tag' }, '状态修改')),
          h('div', { className: 'zt-card-body' }, (CONTEXT_LABEL[d.target.type] || d.target.type) + '「' + d.target.name + '」：' + (d.from || '当前') + ' → ' + d.to),
        );
      }
      if (kind === 'status-options') {
        return h(
          'div',
          { className: 'zt-card' },
          h('div', { className: 'zt-card-head' }, h('span', { className: 'zt-card-tag zt-card-tag-warn' }, '状态不支持')),
          h('div', { className: 'zt-card-body' }, '对象「' + d.target.name + '」没有这个状态，请选择：'),
          h(
            'div',
            { className: 'zt-choices' },
            (d.options || []).map((opt) =>
              h('button', {
                key: opt.key,
                className: 'zt-choice',
                onClick: () => props.onAction({ type: 'choice', id: 'status', value: 'status:' + opt.key, label: opt.label }),
              }, opt.label),
            ),
          ),
        );
      }
      if (kind === 'story') {
        return h('div', { className: 'zt-card' }, h('div', { className: 'zt-card-body' }, '需求 #' + d.id + '「' + d.title + '」'));
      }
      return null;
    }

    function ConfirmForm(props) {
      const fields = props.fields;
      const initial = {};
      fields.forEach((f) => {
        initial[f.key] = f.value !== undefined && f.value !== null ? f.value : '';
      });
      const [values, setValues] = useState(initial);
      return h(
        'div',
        { className: 'zt-confirm' },
        fields.map((f) =>
          h(
            'div',
            { key: f.key, className: 'zt-field' },
            h('label', { className: 'zt-field-label' }, f.label),
            f.type === 'select'
              ? h(
                  'div',
                  { className: 'zt-select-wrap' },
                  h(
                    'select',
                    {
                      className: 'zt-select',
                      value: String(values[f.key]),
                      onChange: (e) => {
                        const raw = e.target.value;
                        const numeric = (f.options || []).every((o) => typeof o.value === 'number');
                        setValues((prev) => Object.assign({}, prev, { [f.key]: numeric ? Number(raw) : raw }));
                      },
                    },
                    (f.options || []).map((o) =>
                      h('option', { key: String(o.value), value: String(o.value) }, o.label),
                    ),
                  ),
                  h('span', { className: 'zt-select-caret' }, h(GlyphIcon, { name: 'chevron-down', size: 16 })),
                )
              : h('div', { className: 'zt-field-value' }, String(f.value === undefined || f.value === null ? '' : f.value)),
          ),
        ),
        h(
          'button',
          { className: 'zt-choice zt-choice-primary zt-confirm-btn', onClick: () => props.onSubmit(values) },
          '确认推送',
        ),
      );
    }

    const CSS = `/* ── TDesign token layer (scoped to the panel) ───────────────────────────────
   Values mirror tdesign-react@1.12.3 dist/tdesign.min.css (light:
   :root,:root[theme-mode=light]; dark: :root[theme-mode=dark]). Dark turns on
   with the DSH shell's own body[data-ds-dark-theme] attribute. */
.zt-root{
--td-brand-color:#0052d9;--td-brand-color-hover:#366ef4;--td-brand-color-focus:#d9e1ff;--td-brand-color-active:#003cab;--td-brand-color-disabled:#b5c7ff;--td-brand-color-light:#f2f3ff;--td-brand-color-light-hover:#d9e1ff;
--td-success-color:#2ba471;--td-success-color-hover:#56c08d;--td-success-color-focus:#c6f3d7;--td-success-color-disabled:#92dab2;--td-success-color-light:#e3f9e9;
--td-warning-color:#e37318;--td-warning-color-hover:#fa9550;--td-warning-color-focus:#ffd9c2;--td-warning-color-disabled:#ffb98c;--td-warning-color-light:#fff1e9;
--td-error-color:#d54941;--td-error-color-hover:#f6685d;--td-error-color-focus:#ffd8d2;--td-error-color-disabled:#ffb9b0;--td-error-color-light:#fff0ed;
--td-text-color-primary:rgba(0,0,0,.9);--td-text-color-secondary:rgba(0,0,0,.6);--td-text-color-placeholder:rgba(0,0,0,.4);--td-text-color-disabled:rgba(0,0,0,.26);--td-text-color-anti:#fff;--td-text-color-brand:#0052d9;
--td-bg-color-page:#eee;--td-bg-color-container:#fff;--td-bg-color-container-hover:#f3f3f3;--td-bg-color-container-active:#e8e8e8;
--td-bg-color-secondarycontainer:#f3f3f3;--td-bg-color-secondarycontainer-hover:#eee;
--td-bg-color-component:#e8e8e8;--td-bg-color-component-hover:#ddd;--td-bg-color-component-disabled:#eee;--td-bg-color-specialcomponent:#fff;
--td-border-level-1-color:#e8e8e8;--td-border-level-2-color:#ddd;--td-component-stroke:#e8e8e8;--td-component-border:#ddd;
--td-radius-small:2px;--td-radius-default:3px;--td-radius-medium:6px;--td-radius-large:9px;--td-radius-extraLarge:12px;
--td-shadow-1:0 1px 10px rgba(0,0,0,.05),0 4px 5px rgba(0,0,0,.08),0 2px 4px -1px rgba(0,0,0,.12);
--td-shadow-2:0 3px 14px 2px rgba(0,0,0,.05),0 8px 10px 1px rgba(0,0,0,.06),0 5px 5px -3px rgba(0,0,0,.1);
--td-font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;--td-font-family-code:ui-monospace,SFMono-Regular,Menlo,monospace;
--td-font-body-small:12px/20px var(--td-font-family);--td-font-body-medium:14px/22px var(--td-font-family);--td-font-title-small:600 14px/22px var(--td-font-family);--td-font-title-medium:600 16px/24px var(--td-font-family);--td-font-mark-small:600 12px/20px var(--td-font-family);
--td-comp-size-xs:24px;--td-comp-size-s:28px;--td-comp-size-m:32px;--td-comp-size-l:36px;--td-comp-size-xxl:48px;
--td-comp-paddingLR-s:8px;--td-comp-paddingLR-m:12px;--td-comp-paddingLR-l:16px;--td-comp-paddingTB-s:8px;--td-comp-paddingTB-m:12px;--td-comp-paddingTB-l:16px;
--td-comp-margin-xs:4px;--td-comp-margin-s:8px;--td-comp-margin-m:12px;--td-comp-margin-l:16px;--td-comp-margin-xl:20px;
--td-gray-color-1:#f3f3f3;--td-gray-color-2:#eee;--td-gray-color-3:#e8e8e8;--td-gray-color-8:#777;
--td-scrollbar-color:rgba(0,0,0,.1);--td-scrollbar-hover-color:rgba(0,0,0,.3);
}

body[data-ds-dark-theme] .zt-root .zt-main,body[data-ds-dark-theme] .zt-root .zt-table-wrap,body[data-ds-dark-theme] .zt-root .zt-table th{background:#242424}
body[data-ds-dark-theme] .zt-root{--zt-card-bg:#1e2a3b;--zt-card-border:#33445c;--zt-card-primary-bg:#253549;
--td-brand-color:#4582e6;--td-brand-color-hover:#2667d4;--td-brand-color-focus:#173463;--td-brand-color-active:#699ef5;--td-brand-color-disabled:#143975;--td-brand-color-light:#1b2f51;--td-brand-color-light-hover:#173463;
--td-success-color:#059465;--td-success-color-hover:#0d7a55;--td-success-color-focus:#1a4230;--td-success-color-disabled:#17533d;--td-success-color-light:#193a2a;
--td-warning-color:#cf6e2d;--td-warning-color-hover:#a75d2b;--td-warning-color-focus:#582f21;--td-warning-color-disabled:#733c23;--td-warning-color-light:#4f2a1d;
--td-error-color:#c64751;--td-error-color-hover:#a03f46;--td-error-color-focus:#5e2a2d;--td-error-color-disabled:#703439;--td-error-color-light:#472324;
--td-text-color-primary:rgba(255,255,255,.9);--td-text-color-secondary:rgba(255,255,255,.55);--td-text-color-placeholder:rgba(255,255,255,.35);--td-text-color-disabled:rgba(255,255,255,.22);--td-text-color-anti:#fff;--td-text-color-brand:#4582e6;
--td-bg-color-page:#181818;--td-bg-color-container:#242424;--td-bg-color-container-hover:#2c2c2c;--td-bg-color-container-active:#5e5e5e;
--td-bg-color-secondarycontainer:#2c2c2c;--td-bg-color-secondarycontainer-hover:#393939;
--td-bg-color-component:#393939;--td-bg-color-component-hover:#4b4b4b;--td-bg-color-component-disabled:#2c2c2c;--td-bg-color-specialcomponent:transparent;
--td-border-level-1-color:#393939;--td-border-level-2-color:#5e5e5e;--td-component-stroke:#393939;--td-component-border:#5e5e5e;
--td-gray-color-1:#f3f3f3;--td-gray-color-2:#eee;--td-gray-color-3:#e8e8e8;--td-gray-color-8:#777;
--td-scrollbar-color:hsla(0,0%,100%,.1);--td-scrollbar-hover-color:hsla(0,0%,100%,.3);
}

.zt-root{position:relative;display:flex;flex-wrap:nowrap;width:100%;max-width:100%;height:100%;min-height:0;background:var(--td-bg-color-container);color:var(--td-text-color-primary);font:var(--td-font-body-medium);overflow:hidden;--zt-radius:5px;--zt-icon:var(--dsw-alias-menu-icon,var(--dsw-alias-label-secondary,#666));--zt-icon-muted:var(--dsw-alias-label-tertiary,#999);--zt-icon-strong:var(--dsw-alias-label-primary,#1a1a1a);--zt-icon-brand:var(--dsw-alias-link,var(--dsw-static-deepseek-500,#4176e6));--zt-card-bg:#eff5ff;--zt-card-border:#dbe7fb;--zt-card-primary-bg:#e2edfe;--zt-card-primary-border:var(--td-brand-color)}
.zt-boot{align-items:center;justify-content:center}
.zt-boot-hint{font:var(--td-font-body-small);color:var(--td-text-color-placeholder)}
.zt-root *,.zt-root *:before,.zt-root *:after{box-sizing:border-box}
.zt-pane{display:flex;flex:0 0 auto;flex-direction:column;min-width:0;min-height:0;overflow:hidden;background:var(--td-bg-color-container)}
.zt-left{position:relative;background:var(--dsw-specific-sidebar-fill,var(--td-bg-color-secondarycontainer))}
.zt-main{position:relative;flex:1 1 0;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;background:var(--td-bg-color-container);container-type:inline-size}
.zt-main-dragstrip{position:absolute;left:0;right:0;top:0;height:14px;z-index:6;-webkit-app-region:drag}
.zt-split{flex:0 0 8px;width:8px;cursor:col-resize;background:transparent;position:relative;z-index:2}
.zt-split:after{content:'';position:absolute;left:50%;top:0;bottom:0;width:1px;margin-left:-0.5px;background:var(--td-component-stroke)}
.zt-split:hover:after,.zt-split:active:after{background:var(--td-brand-color);width:2px;margin-left:-1px}
.zt-rail{flex:0 0 40px;width:40px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:8px 4px 0;background:var(--td-bg-color-container);user-select:none}
.zt-rail-left{border-right:1px solid var(--td-component-stroke)}
.zt-rail-right{border-left:1px solid var(--td-component-stroke)}
/* macOS overlay title bar: keep the collapsed rail clear of the traffic lights. */
.zt-mac .zt-rail{padding-top:38px}
.zt-under-lights .zt-left .zt-pane-head{padding-left:var(--zt-pane-head-pad,16px)}
.zt-under-lights.zt-left-closed .zt-main-head{padding-left:var(--zt-main-head-pad,16px)}
.zt-pane-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 8px 0 16px;border-bottom:1px solid var(--td-component-stroke);height:48px;min-height:48px;min-width:0;-webkit-app-region:drag}
.zt-pane-title{font:var(--td-font-title-small);color:var(--td-text-color-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;transition:max-width .22s cubic-bezier(.4,0,.2,1),opacity .12s linear}
.zt-head-actions{display:flex;align-items:center;gap:4px;margin-left:auto;-webkit-app-region:no-drag}
.zt-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;flex:0 0 auto;border:0;background:transparent;color:var(--zt-icon);cursor:pointer;padding:0;border-radius:var(--zt-radius);transition:background-color .2s linear,color .2s linear}
.zt-icon-btn:hover:not(:disabled){background:var(--td-bg-color-container-hover);color:var(--td-text-color-primary)}
.zt-icon-btn:active:not(:disabled){background:var(--td-bg-color-container-active)}
.zt-icon-btn:focus-visible{outline:2px solid var(--td-brand-color-focus);outline-offset:0}
.zt-icon-btn:disabled{color:var(--td-text-color-disabled);cursor:not-allowed}
.zt-icon-btn.zt-spinning svg{animation:zt-spin .9s linear infinite}
@keyframes zt-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.zt-icon-btn.zt-spinning svg{animation:none}}
.zt-tree-filter-row{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--td-component-stroke);flex:0 0 auto}
.zt-tree-filter-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--td-font-body-small);color:var(--td-text-color-secondary)}
.zt-tree-filter-actions{display:flex;align-items:center;gap:4px;flex:0 0 auto}
.zt-tree-search{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;-webkit-app-region:no-drag}
.zt-tree-search-icon{display:flex;flex:0 0 auto;color:var(--zt-icon)}
.zt-tree-search-input{flex:1 1 auto;min-width:0;height:24px;border:0;background:transparent;color:var(--td-text-color-primary);font:var(--td-font-body-medium);outline:none;padding:0}
.zt-tree-search-input::placeholder{color:var(--td-text-color-placeholder)}
.zt-tree-search-input::-webkit-search-cancel-button,.zt-tree-search-input::-webkit-search-decoration{-webkit-appearance:none;appearance:none}
.zt-switch{position:relative;display:inline-flex;align-items:center;height:20px;min-width:32px;flex:0 0 auto;padding:0;border:0;border-radius:var(--td-radius-round,999px);background:var(--td-bg-color-component);cursor:pointer;transition:background-color .2s cubic-bezier(.38,0,.24,1)}
.zt-switch:hover{background:var(--td-bg-color-component-hover)}
.zt-switch-handle{position:absolute;left:4px;top:4px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:var(--td-shadow-1);transition:left .2s cubic-bezier(.38,0,.24,1)}
.zt-switch-on{background:var(--td-brand-color)}
.zt-switch-on:hover{background:var(--td-brand-color-hover)}
.zt-switch-on .zt-switch-handle{left:calc(100% - 16px)}
.zt-switch:active .zt-switch-handle{width:16px}
.zt-switch:focus-visible{outline:2px solid var(--td-brand-color-focus);outline-offset:2px}
.zt-tree{overflow:auto;flex:1;min-width:0;padding:8px;scrollbar-width:thin}
.zt-tree-busy{font-size:12px;line-height:20px;color:var(--td-text-color-secondary);padding:4px 8px}
.zt-tree{padding:6px 8px 10px}
.zt-left-foot{position:relative;flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 10px 6px;border-top:1px solid var(--td-component-stroke)}
.zt-foot-left,.zt-foot-right{display:flex;align-items:center;gap:8px;flex:0 0 auto;min-width:0}
.zt-plugin-version{flex:0 0 auto;min-width:0;padding:4px 0;font-size:11px;line-height:16px;color:var(--td-text-color-placeholder);user-select:none}
.zt-pinned{padding:0 0 6px;margin:0 0 6px;border-bottom:1px solid var(--td-component-stroke)}
.zt-pinned-head{display:flex;align-items:center;height:28px;padding:0 16px;color:var(--td-text-color-placeholder);font-size:12px;line-height:20px}
.zt-pinned-row{padding-left:16px}
.zt-pinned-icon{color:var(--td-brand-color)}
.zt-pinned-unpin{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;margin-right:2px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--td-text-color-placeholder);cursor:pointer;opacity:0;transition:opacity .15s,color .15s,background-color .15s}
.zt-pinned-row:hover .zt-pinned-unpin{opacity:1}
.zt-pinned-unpin:hover{background:var(--td-bg-color-container-hover);color:var(--td-text-color-primary)}
.zt-tree-pin{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin-left:2px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--td-text-color-placeholder);cursor:pointer;opacity:0;flex:0 0 auto;transition:opacity .15s,color .15s,background-color .15s}
.zt-tree-row:hover .zt-tree-pin{opacity:1}
.zt-tree-pin:hover{background:var(--td-bg-color-container-hover);color:var(--td-brand-color)}
.zt-tree-pin-active{opacity:1;color:var(--td-brand-color)}
.zt-tree-head{display:flex;align-items:center;gap:8px;flex:0 0 auto;height:28px;padding:0 16px;color:var(--td-text-color-placeholder);font-size:12px;line-height:20px}
.zt-tree-head-btn{display:inline-flex;align-items:center;gap:4px;min-width:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}
.zt-tree-head-btn:hover{color:var(--td-text-color-primary)}
.zt-tree-head-active{color:var(--td-text-color-secondary)}
.zt-tree-head-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-tree-head-arrow{display:inline-flex;color:var(--zt-icon-brand)}
.zt-tree-head-btn:first-child{margin-right:auto}
.zt-tree-head-toggle{flex:0 0 auto;padding:0 4px;color:var(--td-text-color-placeholder)}
.zt-tree-head-toggle:hover{color:var(--td-text-color-primary)}
.zt-tree-head-toggle:disabled{opacity:.45;cursor:default}
.zt-tree-head-status{margin-left:4px;min-width:62px;justify-content:flex-end}
.zt-tree-row{display:flex;align-items:center;gap:8px;height:34px;padding:0 8px;border-radius:6px;cursor:pointer;user-select:none;min-width:0;overflow:hidden;transition:background-color .12s linear}
.zt-tree-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.zt-tree-project{font-weight:500}
.zt-tree-project .zt-name{color:var(--td-text-color-primary)}
.zt-tree-icon{display:inline-flex;align-items:center;justify-content:center;flex:0 0 18px;width:18px;height:18px;color:var(--zt-icon)}
.zt-tree-icon-open{color:var(--zt-icon-brand)}
.zt-tree-icon-folder{display:inline-flex;align-items:center;justify-content:center}
.zt-tree-icon-caret{display:none;align-items:center;justify-content:center;color:var(--zt-icon)}
.zt-tree-project:hover .zt-tree-icon-folder{display:none}
.zt-tree-project:hover .zt-tree-emoji{display:none}
.zt-tree-emoji{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;font-size:15px;line-height:18px}
.zt-context-emoji{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;font-size:13px;line-height:14px}
.zt-emoji-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:6px}
.zt-emoji-option{height:32px;border:1px solid var(--td-component-stroke);border-radius:6px;background:var(--td-bg-color-container);font-size:17px;line-height:30px;cursor:pointer}
.zt-emoji-option:hover{border-color:var(--td-brand-color);background:var(--td-bg-color-container-hover)}
.zt-emoji-option-active{border-color:var(--td-brand-color);background:var(--td-brand-color-light)}
.zt-link-btn{align-self:flex-start;padding:0;border:0;background:transparent;color:var(--td-text-color-brand);font-size:12px;cursor:pointer}
.zt-link-btn:hover{text-decoration:underline}
.zt-link-btn:disabled{color:var(--td-text-color-placeholder);cursor:default;text-decoration:none}
.zt-field-extra{display:flex;align-items:center;gap:10px;margin-top:6px}
.zt-field-hint{font-size:11px;line-height:16px;color:var(--td-text-color-placeholder)}
.zt-tree-project:hover .zt-tree-icon-caret{display:inline-flex}
.zt-tree-children-wrap{display:grid;grid-template-rows:0fr;transition:grid-template-rows .22s cubic-bezier(.4,0,.2,1)}
.zt-tree-children-wrap.zt-tree-children-open{grid-template-rows:1fr}
.zt-tree-children{display:flex;flex-direction:column;gap:1px;margin:0;padding-left:26px;overflow:hidden;min-height:0;opacity:0;transition:opacity .18s ease}
.zt-tree-children-wrap.zt-tree-children-open .zt-tree-children{opacity:1}
.zt-tree-children .zt-empty{padding:4px 4px 4px 8px;text-align:left}
.zt-tree-exec{height:32px;font-weight:400}
.zt-tree-exec .zt-name{color:var(--td-text-color-secondary)}
.zt-tree-exec:hover .zt-name{color:var(--td-text-color-primary)}
.zt-tree-exec.zt-active{background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.1))}
.zt-tree-exec.zt-active .zt-name{color:var(--td-text-color-primary);font-weight:500}
.zt-tree-exec.zt-active .zt-status{color:var(--td-text-color-secondary)}
.zt-tree-closed .zt-name{color:var(--td-text-color-placeholder)}
.zt-tree-closed .zt-tree-icon{opacity:.75}
.zt-name{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--td-font-body-medium)}
.zt-status{flex:0 0 auto;display:flex;align-items:center;justify-content:flex-end;gap:6px;min-width:62px;font-size:12px;line-height:20px;color:var(--td-text-color-placeholder);white-space:nowrap}
.zt-dot{width:6px;height:6px;border-radius:50%;display:inline-block;flex:0 0 auto;background:var(--dsw-alias-state-idle-primary,var(--td-text-color-disabled))}
.zt-dot-success{background:var(--dsw-alias-state-success-primary,var(--td-success-color))}
.zt-dot-warn{background:var(--dsw-alias-state-warn-primary,var(--td-warning-color))}
.zt-dot-error{background:var(--dsw-alias-state-error-primary,var(--td-error-color))}
.zt-empty{padding:16px;color:var(--td-text-color-placeholder);text-align:center;font:var(--td-font-body-medium)}
.zt-empty-sm{padding:4px 8px;text-align:left;font:var(--td-font-body-small)}
.zt-main-head{display:flex;align-items:flex-end;justify-content:space-between;gap:8px;padding:0 16px;border-bottom:1px solid var(--td-component-stroke);min-height:48px;min-width:0;overflow:hidden;-webkit-app-region:drag}
.zt-tabs{display:flex;align-items:stretch;gap:0;flex:0 0 auto;min-width:0;align-self:stretch;-webkit-app-region:no-drag;overflow-x:auto;scrollbar-width:none}
.zt-tabs::-webkit-scrollbar{display:none}
.zt-tab{position:relative;display:inline-flex;align-items:center;gap:6px;height:48px;padding:0 16px;border:0;background:transparent;color:var(--td-text-color-secondary);cursor:pointer;font:var(--td-font-body-medium);white-space:nowrap;transition:background-color .2s linear}
.zt-tab:hover{background:var(--td-bg-color-container-hover)}
.zt-tab:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--td-brand-color-focus)}
.zt-tab-active{color:var(--td-brand-color);text-shadow:0 0 .3px currentcolor}
.zt-tab-active:after{content:'';position:absolute;left:12px;right:12px;bottom:0;height:3px;border-radius:var(--td-radius-small) var(--td-radius-small) 0 0;background:var(--td-brand-color)}
.zt-count{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:var(--zt-radius);background:var(--td-bg-color-secondarycontainer);color:var(--td-text-color-secondary);font:var(--td-font-body-small);font-size:12px;line-height:18px}
.zt-tab-active .zt-count{background:var(--td-brand-color-light);color:var(--td-brand-color)}
.zt-main-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0;flex:0 1 auto;padding:8px 0;margin-left:auto;-webkit-app-region:no-drag}
.zt-view-switch{display:inline-flex;align-items:center;flex:0 0 auto;gap:2px;padding:2px;border:1px solid var(--td-border-level-2-color);border-radius:var(--td-radius-round,999px);background:var(--td-bg-color-container);-webkit-app-region:no-drag}
.zt-view-btn{height:24px;padding:0 10px;border:0;border-radius:var(--td-radius-round,999px);background:transparent;color:var(--td-text-color-secondary);cursor:pointer;font-size:12px;line-height:24px;white-space:nowrap;transition:background-color .15s,color .15s}
.zt-view-btn:hover{color:var(--td-text-color-primary)}
.zt-view-btn-active{background:var(--td-brand-color-light);color:var(--td-text-color-brand);font-weight:500}
.zt-main-dashboard .zt-main-head,.zt-main-dashboard .zt-table-wrap{display:none}
.zt-main-team .zt-main-head,.zt-main-team .zt-table-wrap{display:none}
.zt-main-team{overflow:hidden}
.zt-team-wrap{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--td-bg-color-container);overflow:hidden}
.zt-team{flex:1;min-height:0;display:flex;flex-direction:column;padding:0;gap:0;min-width:0}
.zt-team-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:0 0 auto;padding:0 16px;border-bottom:1px solid var(--td-component-stroke)}
.zt-team-title-wrap{display:flex;align-items:stretch;min-width:0}
.zt-team-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}
.zt-team-export{height:30px;padding:0 14px;font-size:12px}
.zt-team-filters{display:flex;align-items:center;flex-wrap:wrap;gap:8px;flex:0 0 auto;margin:0;padding:10px 16px;border:0;border-bottom:1px solid var(--td-component-stroke);border-radius:0;background:transparent}
.zt-team-filter-label{font-size:12px;line-height:18px;color:var(--td-text-color-secondary);white-space:nowrap}
.zt-team-input{box-sizing:border-box;height:30px;min-height:30px;padding:0 8px;border:1px solid var(--td-component-stroke);border-radius:6px;background:var(--td-bg-color-container);color:var(--td-text-color-primary);font-size:12px;line-height:28px;outline:none}
.zt-team-input:focus{border-color:var(--td-brand-color)}
.zt-team-select{width:128px;flex:0 0 auto}
.zt-chip-btn.zt-chip-btn-active,.zt-chip-btn.zt-chip-btn-active:hover{background:var(--td-brand-color-light);border-color:var(--td-brand-color);color:var(--td-brand-color)}
.zt-team-range{display:flex;align-items:center;gap:6px;height:30px;min-width:250px;padding:0 8px;border:1px solid var(--td-component-stroke);border-radius:6px;background:var(--td-bg-color-container);box-sizing:border-box}
.zt-team-range:focus-within{border-color:var(--td-brand-color);box-shadow:0 0 0 2px var(--td-brand-color-focus)}
.zt-team-range-text{width:96px;min-width:0;padding:0;border:0;background:transparent;color:var(--td-text-color-primary);font-size:12px;line-height:28px;outline:none;cursor:pointer}
.zt-team-range-text::placeholder{color:var(--td-text-color-placeholder)}
.zt-team-range-sep{color:var(--td-text-color-placeholder)}
.zt-team-range-icon{display:inline-flex;align-items:center;color:var(--td-text-color-placeholder);margin-left:auto}
.zt-team-picker{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;border:0;padding:0}
.zt-team-search{flex:1 1 160px;min-width:120px;width:auto;padding:0 10px}
.zt-team-overview{flex:0 0 auto;margin:14px 16px 4px;padding:0;border:0;border-radius:0;background:transparent}
.zt-team-overview-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:8px}
.zt-team-overview-title{font-size:13px;font-weight:600;color:var(--td-text-color-primary)}
.zt-team-overview-hint{font-size:11px;color:var(--td-text-color-placeholder)}
.zt-team-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
@container (max-width: 620px){.zt-team-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container (max-width: 430px){.zt-team-cards{grid-template-columns:minmax(0,1fr)}}
.zt-team-card{position:relative;display:flex;flex-direction:column;gap:6px;min-width:0;min-height:112px;padding:14px 18px 12px 20px;border:1px solid var(--td-component-stroke);border-radius:16px;background:var(--td-bg-color-container);box-shadow:0 2px 8px rgba(0,0,0,.06);transition:box-shadow .2s,border-color .2s,transform .2s}
.zt-team-card::before{content:'';position:absolute;left:0;top:14px;bottom:14px;width:3px;border-radius:0 3px 3px 0;background:#2f7cf6}
.zt-team-card:hover{box-shadow:0 6px 16px rgba(0,0,0,.12);border-color:var(--td-border-level-2-color);transform:translateY(-1px)}
.zt-team-card-name{font-size:13px;line-height:18px;color:var(--td-text-color-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-team-card-metrics{display:flex;align-items:flex-end;gap:32px;margin-top:2px}
.zt-team-card-metric{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:0;border:0;background:transparent;font:inherit;text-align:left;cursor:pointer;border-radius:4px}
.zt-team-card-metric:hover .zt-team-card-value{text-decoration:underline}
.zt-team-card-value{font-size:26px;line-height:32px;font-weight:600;color:var(--td-text-color-primary)}
.zt-team-card-value-todo{color:#2f7cf6}
.zt-team-card-value-done{color:#2ba471}
.zt-team-card-label{font-size:12px;line-height:16px;color:var(--td-text-color-placeholder);white-space:nowrap}
.zt-team-overview-empty{padding:18px 0;text-align:center;color:var(--td-text-color-placeholder);font-size:12px}
.zt-team-error{margin:0;color:var(--td-error-color);font-size:12px}
.zt-team-body{flex:1;min-height:0;overflow:auto;border:0;border-radius:0;background:var(--td-bg-color-container)}
.zt-team-loading,.zt-team-empty{display:flex;align-items:center;justify-content:center;height:100%;min-height:160px;color:var(--td-text-color-placeholder);font-size:13px}
.zt-table.zt-table-team{table-layout:fixed;min-width:820px}
.zt-table-team .zt-team-col-title a{color:var(--td-text-color-primary);text-decoration:none}
.zt-table-team .zt-team-col-title a:hover{color:var(--td-text-color-brand);text-decoration:underline}
.zt-table-team tbody tr{cursor:default}
.zt-team-pager .zt-chip-btn{height:26px;padding:0 10px;font-size:12px}
.zt-team-pager .zt-chip-btn:disabled{opacity:.45;cursor:default;color:var(--td-text-color-placeholder);border-color:var(--td-component-stroke)}
.zt-team-row-overdue .zt-team-date-value{display:inline-block;padding:1px 6px;border-radius:4px}
.zt-team-date-overdue{background:#e34d59;color:#fff;font-weight:600}
.zt-team-overdue-text{color:#e34d59;font-weight:600}
.zt-team-pager{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:0 0 auto;padding:10px 16px 12px;border-top:1px solid var(--td-component-stroke);font-size:12px;color:var(--td-text-color-secondary)}
.zt-team-pager-right{display:flex;align-items:center;gap:6px;flex:0 0 auto}
.zt-team-page-size{width:112px;height:30px;min-height:30px;font-size:12px;padding:0 6px;flex:0 0 auto}
.zt-page-btn{min-width:30px;height:30px;padding:0 8px;border:1px solid var(--td-component-stroke);border-radius:6px;background:var(--td-bg-color-container);color:var(--td-text-color-primary);font-size:12px;line-height:28px;cursor:pointer}
.zt-page-btn:hover{border-color:var(--td-brand-color);color:var(--td-brand-color)}
.zt-page-btn-active,.zt-page-btn-active:hover{background:var(--td-brand-color);border-color:var(--td-brand-color);color:#fff}
.zt-page-arrow{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--td-text-color-secondary);cursor:pointer}
.zt-page-arrow:hover:not(:disabled){background:var(--td-bg-color-container-hover);color:var(--td-text-color-primary)}
.zt-page-arrow:disabled{opacity:.4;cursor:default}
.zt-page-ellipsis{min-width:18px;text-align:center;color:var(--td-text-color-placeholder)}
.zt-main-dashboard{overflow:hidden}
.zt-dashboard{flex:1;min-height:0;overflow:auto;padding:20px 20px 28px;background:var(--td-bg-color-container)}
.zt-dash-inner{max-width:1120px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.zt-dash-dragbar{height:12px;margin:-20px -20px -4px;-webkit-app-region:drag;flex:0 0 auto}
.zt-dash-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;-webkit-app-region:drag;padding:2px 0 4px;margin:0 -20px;padding-left:20px;padding-right:20px;cursor:default}
.zt-dash-top .zt-icon-btn{-webkit-app-region:no-drag}
.zt-dash-title{font-size:18px;font-weight:600;color:var(--td-text-color-primary)}
.zt-dash-sub{margin-top:4px;font-size:12px;color:var(--td-text-color-secondary)}
.zt-dash-error{margin-top:2px;padding:10px 14px;border:1px solid var(--td-error-color-3, #ffd3d0);border-radius:var(--td-radius-default,6px);background:var(--td-error-color-1, #fff0ef);color:var(--td-error-color);font-size:12px}
.zt-dash-loading{padding:28px 0;color:var(--td-text-color-secondary);font-size:13px}
.zt-dash-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.zt-dash-card{position:relative;border:1px solid var(--td-component-stroke);border-radius:16px;background:var(--td-bg-color-container);padding:16px 18px 16px 20px;display:flex;flex-direction:column;gap:8px;min-width:0;box-shadow:0 2px 8px rgba(0,0,0,.06);transition:box-shadow .2s,border-color .2s,transform .2s}
.zt-dash-card:hover{box-shadow:0 6px 16px rgba(0,0,0,.12);border-color:var(--td-border-level-2-color);transform:translateY(-1px)}
.zt-dash-card::before{content:'';position:absolute;left:0;top:16px;bottom:16px;width:3px;border-radius:0 3px 3px 0;background:var(--td-brand-color)}
.zt-dash-card-bug::before{background:var(--td-error-color)}
.zt-dash-card-task::before{background:var(--td-warning-color)}
.zt-dash-card-label{font-size:13px;color:var(--td-text-color-secondary)}
.zt-dash-card-count{font-size:30px;line-height:1;font-weight:600;color:var(--td-text-color-primary);font-variant-numeric:tabular-nums}
.zt-dash-card-meta{font-size:12px;color:var(--td-text-color-placeholder)}
.zt-dash-lists{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.zt-dash-list{border:1px solid var(--td-component-stroke);border-radius:16px;background:var(--td-bg-color-container);display:flex;flex-direction:column;min-width:0;height:260px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.zt-dash-list-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.18);font-size:13px;font-weight:600;color:#fff;flex:0 0 auto}
.zt-dash-list-head-story{background:#2f7cf6}
.zt-dash-list-head-bug{background:#e34d59}
.zt-dash-list-head-task{background:#ed7b2f}
.zt-dash-list-count{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:20px;padding:0 7px;border-radius:20px;background:rgba(255,255,255,.22);color:#fff;font-size:12px;font-weight:500;font-variant-numeric:tabular-nums}
.zt-dash-list-body{flex:1;min-height:0;overflow:auto;padding:4px 0;scrollbar-width:thin}
.zt-dash-row{display:flex;align-items:center;gap:10px;padding:9px 14px;text-decoration:none;color:var(--td-text-color-primary)}
.zt-dash-overdue-badge{position:absolute;top:14px;right:16px;padding:1px 8px;border-radius:10px;background:#e34d59;color:#fff;font-size:11px;line-height:18px;font-weight:500;z-index:1}
.zt-dash-row-overdue{flex:0 0 auto;color:#e34d59;font-size:12px;font-weight:600;line-height:18px}
.zt-dash-row-dot{flex:0 0 auto;width:5px;height:5px;border-radius:50%;background:var(--td-brand-color)}
.zt-dash-dot-story{background:#2f7cf6}
.zt-dash-dot-bug{background:#e34d59}
.zt-dash-dot-task{background:#ed7b2f}
.zt-dash-row:hover{background:var(--td-bg-color-container-hover)}
.zt-dash-row-title{flex:1;min-width:0;font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-dash-row-date{flex:0 0 auto;font-size:12px;color:var(--td-text-color-secondary);font-variant-numeric:tabular-nums}
.zt-dash-empty{padding:18px 14px;font-size:12px;color:var(--td-text-color-placeholder)}
@container (max-width: 720px){
.zt-dash-lists{grid-template-columns:1fr}
}
@container (max-width: 440px){
.zt-dash-cards{grid-template-columns:1fr}
}
.zt-cal{border:1px solid var(--td-component-stroke);border-radius:16px;background:var(--td-bg-color-container);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.zt-cal-head{display:flex;align-items:center;justify-content:flex-start;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.18);background:#2f7cf6;flex-wrap:wrap;color:#fff}
.zt-cal-head .zt-icon-btn{color:rgba(255,255,255,.9)}
.zt-cal-head .zt-icon-btn:hover{background:rgba(255,255,255,.16);color:#fff}
.zt-cal-title-line{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.zt-cal-title{font-size:14px;font-weight:600;color:#fff}
.zt-cal-sub{margin-top:3px;font-size:12px;color:rgba(255,255,255,.78)}
.zt-cal-mode-slot{display:flex;align-items:center;margin-left:20px;flex:0 0 auto}
.zt-cal-actions{display:flex;align-items:center;gap:4px;margin-left:auto;flex-wrap:nowrap;min-width:0}
.zt-cal-actions>*{flex:0 0 auto}
.zt-cal-mode{display:inline-flex;gap:2px;padding:2px;border:1px solid rgba(255,255,255,.45);border-radius:var(--td-radius-round,999px);background:rgba(255,255,255,.12)}
.zt-cal-mode-btn{height:24px;padding:0 10px;border:0;border-radius:var(--td-radius-round,999px);background:transparent;color:rgba(255,255,255,.9);cursor:pointer;font-size:12px;line-height:24px;white-space:nowrap;transition:background-color .15s,color .15s}
.zt-cal-mode-btn:hover{background:rgba(255,255,255,.18);color:#fff}
.zt-cal-mode-btn-active{background:#fff;color:#2f7cf6;font-weight:500}
.zt-cal-month{min-width:104px;padding:0 4px;text-align:center;font-size:13px;font-weight:500;color:#fff;font-variant-numeric:tabular-nums;white-space:nowrap}
.zt-cal-today-btn{height:28px;padding:0 10px;white-space:nowrap;border:1px solid rgba(255,255,255,.55);border-radius:var(--td-radius-round,999px);background:transparent;color:#fff;cursor:pointer;font-size:12px}
.zt-cal-today-btn:hover{background:rgba(255,255,255,.16);border-color:#fff;color:#fff}
.zt-cal-title-line{display:flex;align-items:center;gap:12px;min-width:0}
.zt-cal-done-toggle{display:inline-flex;align-items:center;gap:5px;color:rgba(255,255,255,.92);font-size:11px;line-height:16px;cursor:pointer;user-select:none;white-space:nowrap}
.zt-cal-done-toggle input{width:14px;height:14px;margin:0;accent-color:#fff;cursor:pointer}
.zt-cal-error{padding:8px 14px;background:rgba(0,0,0,.18);color:#fff;font-size:12px}
.zt-cal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border-top:0}
.zt-cal-week{padding:8px 10px;font-size:12px;font-weight:500;color:var(--td-text-color-placeholder);text-align:center;border-bottom:1px solid var(--td-component-stroke);border-right:1px solid var(--td-component-stroke)}
.zt-cal-week:nth-child(7){border-right:0}
.zt-cal-week-weekend{color:var(--td-text-color-placeholder);background:#fafafa}
body[data-ds-dark-theme] .zt-root .zt-cal-cell,
body[data-ds-dark-theme] .zt-root .zt-cal-week{background:var(--td-bg-color-container)}
body[data-ds-dark-theme] .zt-root .zt-cal-weekend,
body[data-ds-dark-theme] .zt-root .zt-cal-week-weekend{background:#202124}
body[data-ds-dark-theme] .zt-root .zt-cal-blank{background:#181818}
body[data-ds-dark-theme] .zt-root .zt-cal-cell:hover,
body[data-ds-dark-theme] .zt-root .zt-cal-weekend:hover{background:#2a3550}
body[data-ds-dark-theme] .zt-root .zt-cal-task{background:#253549;color:#a9c7ff}
body[data-ds-dark-theme] .zt-root .zt-cal-task:hover{background:#2d4262;border-color:var(--td-brand-color)}
body[data-ds-dark-theme] .zt-root .zt-cal-task-done{background:#2c2c2c;color:rgba(255,255,255,.42)}
body[data-ds-dark-theme] .zt-root .zt-cal-task-done .zt-cal-task-link{color:rgba(255,255,255,.42)}
body[data-ds-dark-theme] .zt-root .zt-cal-day-num{color:rgba(255,255,255,.78)}
body[data-ds-dark-theme] .zt-root .zt-cal-lunar{color:rgba(255,255,255,.44)}
body[data-ds-dark-theme] .zt-root .zt-cal-lunar-festival{color:#ff8a80}
body[data-ds-dark-theme] .zt-root .zt-cal-lunar-term{color:#6fdc9e}
body[data-ds-dark-theme] .zt-root .zt-cal-selected{box-shadow:inset 0 0 0 2px var(--td-brand-color)}
body[data-ds-dark-theme] .zt-root .zt-cal-today .zt-cal-day-num{background:var(--td-brand-color);color:#fff}
.zt-cal-cell{height:104px;min-height:0;padding:6px 8px;border-bottom:1px solid var(--td-component-stroke);border-right:1px solid var(--td-component-stroke);display:flex;flex-direction:column;gap:4px;min-width:0;background:var(--td-bg-color-container);transition:background-color .15s;overflow:hidden;box-sizing:border-box}
.zt-cal-cell:nth-child(7n){border-right:0}
.zt-cal-cell:hover{background:var(--td-brand-color-light,#f2f3ff)}
.zt-cal-weekend{background:#fafafa}
.zt-cal-weekend:hover{background:var(--td-brand-color-light,#f2f3ff)}
.zt-cal-blank{background:var(--td-bg-color-page)}
.zt-cal-blank:hover{background:var(--td-bg-color-page)}
.zt-cal-day{display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0}
.zt-cal-day-left{display:flex;align-items:center;gap:4px;min-width:0}
.zt-cal-lunar{font-size:11px;line-height:16px;color:var(--td-text-color-placeholder);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right}
.zt-cal-lunar-festival{color:#d54941}
.zt-cal-lunar-term{color:#2ba471}
.zt-cal-day-week{font-size:11px;color:var(--td-text-color-placeholder)}
.zt-cal-holiday{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 3px;border-radius:4px;color:#fff;font-size:10px;line-height:16px;font-weight:500;box-sizing:border-box}
.zt-cal-holiday-rest{background:#2f7cf6}
.zt-cal-holiday-work{background:#e34d59}
.zt-cal-grid-week .zt-cal-cell{height:624px;min-height:624px}
.zt-cal-day-num{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;border-radius:50%;font-size:12px;color:var(--td-text-color-secondary);font-variant-numeric:tabular-nums}
.zt-cal-today .zt-cal-day-num{background:var(--td-brand-color);color:#fff;font-weight:600}
.zt-cal-selected{box-shadow:inset 0 0 0 2px var(--td-brand-color-focus, rgba(0,82,217,.35))}
.zt-cal-tasks{display:flex;flex-direction:column;gap:8px;overflow:hidden;margin-top:2px}
.zt-cal-tasks-month{gap:4px;margin-top:1px}
.zt-cal-task-month{padding:2px 6px;line-height:14px;font-size:11px;max-height:20px;flex:0 0 auto}
.zt-cal-task{display:block;padding:4px 8px;border-radius:6px;background:var(--td-brand-color-light);color:var(--td-text-color-brand);font-size:12px;line-height:16px;text-decoration:none;cursor:grab;border:1px solid transparent;transition:background-color .15s,border-color .15s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.zt-cal-task-link{display:block;color:inherit;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-cal-task-week{display:flex;align-items:flex-start;gap:6px;white-space:normal;padding:4px 8px}
.zt-cal-task-week .zt-cal-task-link{flex:1;min-width:0;white-space:normal;word-break:break-all;max-height:32px;overflow:hidden}
.zt-cal-task-check{width:13px;height:13px;margin:2px 0 0;flex:0 0 auto;accent-color:var(--td-brand-color);cursor:pointer}
.zt-cal-task-done,.zt-cal-task-done:hover{background:var(--td-bg-color-container-hover);border-color:transparent;color:var(--td-text-color-placeholder);cursor:default;box-shadow:none}
.zt-cal-task-done .zt-cal-task-link{color:var(--td-text-color-placeholder)}
.zt-cal-task:hover{background:var(--td-brand-color-light, #e3f2fd);border-color:var(--td-brand-color);color:var(--td-text-color-brand)}
.zt-cal-task:active{cursor:grabbing}
.zt-modal-dialog{position:fixed;inset:0;width:100vw;height:100vh;max-width:100vw;max-height:100vh;margin:0;padding:24px;border:0;background:transparent;display:flex;align-items:center;justify-content:center;box-sizing:border-box;overflow:auto}
.zt-modal-dialog::backdrop{background:rgba(0,0,0,.4)}
.zt-modal{width:520px;max-width:100%;border-radius:8px;background:var(--td-bg-color-container);box-shadow:0 12px 40px rgba(0,0,0,.18);display:flex;flex-direction:column;max-height:calc(100vh - 48px);overflow:visible}
.zt-modal-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:20px 24px 0}
.zt-modal-title{font-size:16px;font-weight:600;color:var(--td-text-color-primary);line-height:24px}
.zt-modal-close{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--td-text-color-secondary);cursor:pointer}
.zt-modal-close:hover{background:var(--td-bg-color-container-hover);color:var(--td-text-color-primary)}
.zt-modal-body{padding:16px 24px 4px;display:flex;flex-direction:column;gap:16px;overflow:visible}
.zt-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:20px 24px 24px}
.zt-modal .zt-field{display:flex;flex-direction:column;align-items:stretch;gap:6px;text-align:left}
.zt-modal .zt-field-label{display:flex;align-items:center;gap:2px;font-size:13px;line-height:20px;color:var(--td-text-color-primary);white-space:nowrap}
.zt-modal .zt-field-required{color:var(--td-error-color,#d54941);font-weight:600;line-height:18px}
.zt-modal .zt-field-label-text{line-height:18px}
.zt-modal .zt-input,.zt-modal .zt-textarea{width:100%;box-sizing:border-box;min-height:0;border:1px solid var(--td-border-level-2-color,#dcdcdc);border-radius:6px;background:var(--td-bg-color-container);color:var(--td-text-color-primary);font:var(--td-font-body-medium);font-size:13px;transition:border-color .15s,box-shadow .15s}
.zt-modal .zt-input{height:32px;padding:0 10px;line-height:30px}
.zt-modal .zt-textarea{height:auto;min-height:76px;padding:8px 10px;line-height:20px;resize:vertical;font-family:inherit}
.zt-modal .zt-input:hover,.zt-modal .zt-textarea:hover{border-color:var(--td-brand-color)}
.zt-modal .zt-input:focus,.zt-modal .zt-textarea:focus{outline:none;border:1px solid var(--td-brand-color);box-shadow:0 0 0 2px var(--td-brand-color-focus,rgba(0,82,217,.2))}
.zt-modal .zt-input::placeholder,.zt-modal .zt-textarea::placeholder{color:var(--td-text-color-placeholder)}
.zt-select-field{position:relative}
.zt-select-trigger{width:100%;height:32px;padding:0 10px;box-sizing:border-box;display:flex;align-items:center;gap:8px;border:1px solid var(--td-border-level-2-color,#dcdcdc);border-radius:6px;background:var(--td-bg-color-container);cursor:pointer;font:var(--td-font-body-medium);font-size:13px;color:var(--td-text-color-primary);text-align:left;transition:border-color .15s,box-shadow .15s}
.zt-select-trigger:hover{border-color:var(--td-brand-color)}
.zt-select-field-open .zt-select-trigger{border-color:var(--td-brand-color);box-shadow:0 0 0 2px var(--td-brand-color-focus,rgba(0,82,217,.2))}
.zt-select-trigger-disabled{opacity:.6;cursor:default;background:var(--td-bg-color-container-hover)}
.zt-select-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-select-placeholder{flex:1;min-width:0;color:var(--td-text-color-placeholder);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-select-arrow{display:inline-flex;color:var(--td-text-color-placeholder);flex:0 0 auto;transition:transform .15s}
.zt-select-field-open .zt-select-arrow{transform:rotate(180deg)}
.zt-select-popup{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:20;max-height:240px;overflow:auto;padding:4px 0;border:1px solid var(--td-component-stroke);border-radius:8px;background:var(--td-bg-color-container);box-shadow:0 6px 24px rgba(0,0,0,.14);scrollbar-width:thin}
.zt-select-search-wrap{padding:6px;border-bottom:1px solid var(--td-component-stroke);position:sticky;top:0;background:var(--td-bg-color-container);z-index:1}
.zt-select-search{width:100%;height:28px;padding:0 8px;box-sizing:border-box;border:1px solid var(--td-border-level-2-color,#dcdcdc);border-radius:6px;background:var(--td-bg-color-container);color:var(--td-text-color-primary);font:var(--td-font-body-medium);font-size:12px;outline:none}
.zt-select-search:focus{border-color:var(--td-brand-color);box-shadow:0 0 0 2px var(--td-brand-color-focus,rgba(0,82,217,.2))}
.zt-select-search::placeholder{color:var(--td-text-color-placeholder)}
.zt-select-group{padding:6px 12px 4px;font-size:12px;color:var(--td-text-color-placeholder)}
.zt-select-option{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;border:0;background:transparent;cursor:pointer;font-size:13px;color:var(--td-text-color-primary);text-align:left}
.zt-select-option:hover{background:var(--td-bg-color-container-hover)}
.zt-select-option-active{background:var(--td-brand-color-light,#f2f3ff);color:var(--td-text-color-brand)}
.zt-select-option-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-select-empty{padding:10px 12px;font-size:12px;color:var(--td-text-color-placeholder)}
.zt-option-status{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;font-size:12px;color:var(--td-text-color-secondary)}
.zt-status-dot{width:6px;height:6px;border-radius:50%;display:inline-block}
.zt-status-dot-doing{background:#2ba471}
.zt-status-dot-wait{background:#b9b9b9}
.zt-modal .zt-field-error{padding:8px 10px;border-radius:6px;background:var(--td-error-color-1,#fff0ef);color:var(--td-error-color,#d54941);font-size:12px}
.zt-btn{height:32px;padding:0 18px;border-radius:6px;border:1px solid transparent;cursor:pointer;font-size:13px}
.zt-btn-ghost{border-color:var(--td-border-level-2-color,#dcdcdc);background:transparent;color:var(--td-text-color-secondary)}
.zt-btn-ghost:hover{color:var(--td-text-color-primary);border-color:var(--td-brand-color)}
.zt-btn-primary{background:var(--td-brand-color);color:#fff}
.zt-btn-primary:hover{background:var(--td-brand-color-hover)}
.zt-btn-primary:disabled{opacity:.6;cursor:default}
.zt-only-mine-switch{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;padding:2px 4px;border-radius:6px;cursor:pointer;user-select:none;-webkit-app-region:no-drag}
.zt-only-mine-switch:hover{background:var(--td-bg-color-container-hover)}
.zt-only-mine-label{font-size:12px;line-height:18px;color:var(--td-text-color-secondary);white-space:nowrap}
.zt-cell-me{color:var(--td-error-color);font-weight:500}
@container (max-width:430px){.zt-main-head .zt-current{display:none}}
.zt-current{flex:0 1 auto;min-width:120px;max-width:280px;font:var(--td-font-body-small);color:var(--td-text-color-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.zt-table-wrap{display:flex;flex-direction:column;flex:1 1 0;overflow:auto;min-height:0;min-width:0;background:#fff}
.zt-empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;margin:auto;padding:24px;text-align:center;font:var(--td-font-body-medium)}
.zt-empty-image{display:flex;align-items:center;justify-content:center;color:var(--zt-icon-muted)}
.zt-empty-title{margin-top:8px;font:var(--td-font-body-medium);color:var(--td-text-color-secondary)}
.zt-empty-description{margin-top:4px;font:var(--td-font-body-small);color:var(--td-text-color-placeholder)}
.zt-table{width:100%;min-width:0;border-collapse:separate;border-spacing:0;table-layout:fixed;font:var(--td-font-body-medium)}
.zt-table th{user-select:none}
.zt-table th.zt-col-dragging{opacity:.45}
.zt-table th.zt-col-drop-before:before,.zt-table th.zt-col-drop-after:before{content:'';position:absolute;top:0;bottom:0;width:2px;background:var(--td-brand-color);z-index:4;pointer-events:none}
.zt-table th.zt-col-drop-before:before{left:0}
.zt-table th.zt-col-drop-after:before{right:0}
.zt-col-resize{position:absolute;top:0;right:0;bottom:0;width:6px;z-index:3;cursor:col-resize;user-select:none;touch-action:none}
.zt-col-resize:after{content:'';position:absolute;right:2px;top:7px;bottom:7px;width:1px;border-radius:1px;background:transparent;transition:background-color .1s linear}
.zt-table th:hover .zt-col-resize:after{background:var(--td-border-level-2-color)}
.zt-table th .zt-col-resize:hover:after,.zt-table th .zt-col-resize.zt-resizing:after{background:var(--td-brand-color);width:2px}
.zt-table.zt-cols-fixed{min-width:100%}
.zt-th-btn{display:flex;align-items:center;gap:2px;min-width:0;max-width:100%;margin:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;font-weight:inherit;line-height:inherit;white-space:nowrap;text-align:left;cursor:pointer;border-radius:var(--zt-radius)}
.zt-th-btn:hover{color:var(--td-text-color-primary)}
.zt-th-btn:focus-visible{outline:2px solid var(--td-brand-color-focus);outline-offset:1px}
.zt-th-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-table th.zt-th-sorted{color:var(--td-text-color-brand)}
.zt-table th.zt-th-sorted .zt-th-btn:hover{color:var(--td-brand-color)}
.zt-sort{display:inline-flex;align-items:center;margin-left:4px;color:var(--zt-icon-brand)}
.zt-table th.zt-col-id{width:10%}.zt-table th.zt-col-title{width:30%}.zt-table th.zt-col-module{width:14%}.zt-table th.zt-col-priority{width:12%}.zt-table th.zt-col-assignee{width:12%}.zt-table th.zt-col-state{width:22%}
.zt-table.zt-table-story th.zt-col-id{width:8%}.zt-table.zt-table-story th.zt-col-title{width:26%}.zt-table.zt-table-story th.zt-col-module{width:12%}.zt-table.zt-table-story th.zt-col-priority{width:9%}.zt-table.zt-table-story th.zt-col-assignee{width:9%}.zt-table.zt-table-story th.zt-col-storystate{width:9%}.zt-table.zt-table-story th.zt-col-state{width:27%}
.zt-table th.zt-col-id,.zt-table td.zt-col-id{min-width:54px}
.zt-table th.zt-col-priority,.zt-table td.zt-col-priority{min-width:56px}
.zt-table th.zt-col-assignee,.zt-table td.zt-col-assignee{min-width:86px}
.zt-table th.zt-col-state,.zt-table td.zt-col-state{min-width:86px}
.zt-table th.zt-col-storystate,.zt-table td.zt-col-storystate{min-width:86px}
.zt-table th.zt-col-deadline,.zt-table td.zt-col-deadline{min-width:96px}
.zt-table th.zt-col-date,.zt-table td.zt-col-date{min-width:96px}
.zt-table th.zt-col-owner,.zt-table td.zt-col-owner{min-width:96px}
.zt-table.zt-table-task th.zt-col-id{width:8%}.zt-table.zt-table-task th.zt-col-title{width:26%}.zt-table.zt-table-task th.zt-col-module{width:13%}.zt-table.zt-table-task th.zt-col-priority{width:9%}.zt-table.zt-table-task th.zt-col-state{width:16%}.zt-table.zt-table-task th.zt-col-assignee{width:14%}.zt-table.zt-table-task th.zt-col-deadline{width:14%}
.zt-table.zt-table-testtask th.zt-col-id{width:9%}.zt-table.zt-table-testtask th.zt-col-title{width:32%}.zt-table.zt-table-testtask th.zt-col-state{width:12%}.zt-table.zt-table-testtask th.zt-col-owner{width:17%}.zt-table.zt-table-testtask th.zt-col-date{width:15%}
.zt-table.zt-table-report th.zt-col-id{width:9%}.zt-table.zt-table-report th.zt-col-title{width:45%}.zt-table.zt-table-report th.zt-col-testtask{width:30%}.zt-table.zt-table-report th.zt-col-date{width:16%}
@container (max-width: 560px){
.zt-table.zt-table-task th.zt-col-module,.zt-table.zt-table-task td.zt-col-module{display:none}
.zt-table.zt-table-task th.zt-col-priority,.zt-table.zt-table-task td.zt-col-priority{width:14%}
.zt-table.zt-table-testtask th.zt-col-date:nth-of-type(5),.zt-table.zt-table-testtask td.zt-col-date:nth-of-type(5),.zt-table.zt-table-testtask th.zt-col-date:nth-of-type(6),.zt-table.zt-table-testtask td.zt-col-date:nth-of-type(6){display:none}
.zt-table.zt-table-report th.zt-col-testtask,.zt-table.zt-table-report td.zt-col-testtask{display:none}
}
@container (max-width: 480px){
.zt-table.zt-table-task th.zt-col-priority,.zt-table.zt-table-task td.zt-col-priority{display:none}
.zt-table.zt-table-testtask th.zt-col-owner,.zt-table.zt-table-testtask td.zt-col-owner{display:none}
}
.zt-popup-date{display:flex;flex-direction:column;gap:10px;padding:12px}
.zt-popup-date-input{height:32px;padding:0 10px;border:1px solid var(--td-border-level-2-color);border-radius:var(--td-radius-default,6px);background:var(--td-bg-color-container);color:var(--td-text-color-primary);font:var(--td-font-body-medium);box-sizing:border-box;width:100%}
.zt-popup-date-actions{display:flex;justify-content:flex-end;gap:8px}
.zt-popup-date-btn{height:28px;padding:0 12px;border:1px solid var(--td-border-level-2-color);border-radius:var(--td-radius-round,999px);background:transparent;color:var(--td-text-color-secondary);cursor:pointer;font-size:12px}
.zt-popup-date-primary{border-color:var(--td-brand-color);background:var(--td-brand-color);color:#fff}
@container (max-width: 620px){
.zt-table.zt-table-story:not(.zt-cols-fixed) th.zt-col-module,.zt-table.zt-table-story:not(.zt-cols-fixed) td.zt-col-module{display:none}
.zt-table.zt-table-story th.zt-col-id{width:10%}.zt-table.zt-table-story th.zt-col-title{width:30%}.zt-table.zt-table-story th.zt-col-priority{width:12%}.zt-table.zt-table-story th.zt-col-assignee{width:14%}.zt-table.zt-table-story th.zt-col-storystate{width:12%}.zt-table.zt-table-story th.zt-col-state{width:22%}
}
@container (max-width: 480px){
.zt-table.zt-table-story:not(.zt-cols-fixed) th.zt-col-assignee,.zt-table.zt-table-story:not(.zt-cols-fixed) td.zt-col-assignee{display:none}
.zt-table.zt-table-story th.zt-col-id{width:12%}.zt-table.zt-table-story th.zt-col-title{width:36%}.zt-table.zt-table-story th.zt-col-priority{width:14%}.zt-table.zt-table-story th.zt-col-storystate{width:14%}.zt-table.zt-table-story th.zt-col-state{width:24%}
}
.zt-table-wrap{container-type:inline-size}
@container (max-width:440px){
.zt-table:not(.zt-cols-fixed) th.zt-col-id{width:15%}.zt-table:not(.zt-cols-fixed) th.zt-col-title{width:45%}.zt-table:not(.zt-cols-fixed) th.zt-col-priority{width:17%}.zt-table:not(.zt-cols-fixed) th.zt-col-state{width:23%}
.zt-table:not(.zt-cols-fixed) .zt-col-module,.zt-table:not(.zt-cols-fixed) .zt-col-assignee{display:none}
}
@container (max-width:340px){
.zt-table:not(.zt-cols-fixed) th.zt-col-id{width:18%}.zt-table:not(.zt-cols-fixed) th.zt-col-title{width:54%}.zt-table:not(.zt-cols-fixed) th.zt-col-state{width:28%}
.zt-table:not(.zt-cols-fixed) .zt-col-priority{display:none}
}
.zt-table th{position:sticky;top:0;z-index:1;height:40px;padding:0 8px;text-align:left;font-size:12px;line-height:20px;font-weight:500;color:var(--td-text-color-placeholder);background:#fff;border-bottom:1px solid var(--td-component-border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.zt-table td{height:44px;padding:0 8px;border-bottom:1px solid rgba(15,23,42,.06);color:var(--td-text-color-primary);vertical-align:middle;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
body[data-ds-dark-theme] .zt-root .zt-table td{border-bottom-color:rgba(255,255,255,.08)}
.zt-table tbody tr{cursor:grab;transition:background-color .2s linear}
.zt-table tbody tr:hover{background:var(--td-bg-color-container-hover)}
.zt-mono{font-family:var(--td-font-family-code);font-size:12px;color:var(--td-text-color-placeholder)}
.zt-title-cell a{color:var(--td-text-color-primary);text-decoration:none}
.zt-title-cell a:hover{color:var(--td-text-color-brand);text-decoration:underline}
.zt-cell-action{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:2px 6px;margin:-2px -6px;border:0;background:transparent;border-radius:var(--zt-radius);cursor:pointer;font:inherit;color:inherit;text-align:left;overflow:hidden}
.zt-cell-action:hover{background:var(--td-bg-color-container-hover)}
.zt-cell-action.zt-overdue-date{background:#e34d59;color:#fff;font-weight:600;padding:2px 8px;margin:0;border-radius:4px}
.zt-cell-action.zt-overdue-date:hover{background:#c93b47;color:#fff}
.zt-overdue-date .zt-cell-text{color:#fff}
.zt-cell-action:focus-visible{outline:2px solid var(--td-brand-color-focus);outline-offset:0}
.zt-cell-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-cell-caret{display:inline-flex;flex:0 0 auto;color:var(--zt-icon-muted);opacity:0;transition:opacity .1s linear}
.zt-cell-action:hover .zt-cell-caret,.zt-cell-action:focus-visible .zt-cell-caret{opacity:1}
.zt-popup-layer{position:fixed;inset:0;z-index:60}
.zt-popup{position:fixed;z-index:61;box-sizing:border-box;max-height:360px;overflow:auto;padding:4px;background:var(--td-bg-color-container);border:1px solid var(--td-component-border);border-radius:var(--td-radius-medium);box-shadow:var(--td-shadow-2);display:flex;flex-direction:column;gap:2px}
.zt-popup-head{padding:4px 8px 6px;font:var(--td-font-body-small);color:var(--td-text-color-secondary);border-bottom:1px solid var(--td-component-stroke);margin-bottom:2px}
.zt-popup-list{display:flex;flex-direction:column;gap:2px}
.zt-popup-item{display:flex;align-items:center;width:100%;box-sizing:border-box;padding:6px 8px;border:0;background:transparent;border-radius:var(--td-radius-default);cursor:pointer;font:var(--td-font-body-medium);color:var(--td-text-color-primary);text-align:left}
.zt-popup-item:hover:not(:disabled){background:var(--td-bg-color-container-hover)}
.zt-popup-item-active{background:var(--td-brand-color-light);color:var(--td-text-color-brand);font-weight:500}
.zt-popup-item:disabled{opacity:.5;cursor:progress}
.zt-popup-loading{padding:10px 8px;font:var(--td-font-body-small);color:var(--td-text-color-placeholder)}
.zt-toast{position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:70;max-width:min(520px,82vw);padding:8px 12px;border-radius:var(--td-radius-medium);background:var(--td-error-color-light);border:1px solid var(--td-error-color);color:var(--td-error-color);font:var(--td-font-body-small);box-shadow:var(--td-shadow-2)}
.zt-tag{display:inline-flex;align-items:center;height:24px;max-width:100%;box-sizing:border-box;padding:0 8px;border:1px solid transparent;border-radius:20px;font-weight:400;font-size:12px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.zt-tag-default{background:var(--td-bg-color-secondarycontainer);border-color:var(--td-component-border);color:var(--td-text-color-primary)}
.zt-tag-primary{background:var(--td-brand-color-light);color:var(--td-brand-color)}
.zt-tag-success{background:var(--td-success-color-light);color:var(--td-success-color)}
.zt-tag-warning{background:var(--td-warning-color-light);color:var(--td-warning-color)}
.zt-tag-error{background:var(--td-error-color-light);color:var(--td-error-color)}
.zt-chat{flex:1 1 0;overflow:auto;min-height:0;min-width:0;padding:16px;display:flex;flex-direction:column;gap:16px;background:var(--td-bg-color-container)}
.zt-chat-empty{margin:auto;text-align:center;color:var(--td-text-color-secondary);max-width:300px}
.zt-chat-empty-title{font:var(--td-font-title-small);color:var(--td-text-color-primary);margin-bottom:8px}
.zt-suggestions{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:16px;max-width:320px}
.zt-suggest-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 14px;border:1px solid var(--td-border-level-2-color);border-radius:10px;background:var(--td-bg-color-specialcomponent);color:var(--td-text-color-primary);cursor:pointer;font:var(--td-font-body-medium);transition:color .2s,border-color .2s,background-color .2s}
.zt-suggest-btn:hover{color:var(--td-brand-color-hover);border-color:var(--td-brand-color-hover);background:var(--td-bg-color-container-hover)}
.zt-suggest-btn:focus-visible{outline:2px solid var(--td-brand-color-focus);outline-offset:0}
.zt-msg{display:flex;flex-direction:column;gap:12px;max-width:100%;min-width:0}
.zt-msg-user{align-items:flex-end}
.zt-msg-user .zt-bubble{background:var(--dsw-specific-bubble,var(--td-brand-color-light));color:var(--td-text-color-primary);border-radius:20px;padding:12px 16px;max-width:85%;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.zt-msg-meta{display:flex;align-items:center;gap:10px;padding:0 6px;min-height:24px;font-size:12px;line-height:18px;color:var(--td-text-color-placeholder)}
.zt-msg-time{white-space:nowrap}
.zt-msg-action{width:24px;height:24px;color:var(--td-text-color-placeholder)}
.zt-msg-action:hover:not(:disabled){color:var(--td-text-color-primary)}
.zt-msg-copied,.zt-msg-copied:hover:not(:disabled){color:var(--td-success-color)}
.zt-msg-assistant .zt-bubble{color:var(--td-text-color-primary);white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.zt-msg-assistant .zt-bubble.zt-markdown{white-space:normal}
.zt-markdown>:first-child{margin-top:0}
.zt-markdown>:last-child{margin-bottom:0}
.zt-md-p{margin:0 0 8px;line-height:22px}
.zt-md-h{margin:12px 0 6px;line-height:1.4;font-weight:600;color:var(--td-text-color-primary)}
.zt-md-h1{font-size:18px}.zt-md-h2{font-size:16px}.zt-md-h3{font-size:15px}.zt-md-h4,.zt-md-h5,.zt-md-h6{font-size:14px}
.zt-md-list{margin:0 0 8px;padding-left:20px}
.zt-md-li{margin:2px 0;line-height:22px}
.zt-md-code{padding:1px 5px;border-radius:var(--td-radius-small);background:var(--td-bg-color-secondarycontainer);color:var(--td-text-color-primary);font-family:var(--td-font-family-code);font-size:12px}
.zt-md-pre{margin:0 0 8px;padding:10px 12px;border-radius:var(--td-radius-medium);background:var(--td-bg-color-secondarycontainer);border:1px solid var(--td-component-stroke);overflow:auto;max-height:360px}
.zt-md-pre code{font-family:var(--td-font-family-code);font-size:12px;line-height:20px;white-space:pre}
.zt-md-quote{margin:0 0 8px;padding:2px 0 2px 10px;border-left:3px solid var(--td-border-level-2-color);color:var(--td-text-color-secondary)}
.zt-md-hr{border:0;height:1px;background:var(--td-component-stroke);margin:10px 0}
.zt-md-link{color:var(--td-text-color-brand);text-decoration:none}
.zt-md-link:hover{text-decoration:underline}
.zt-md-image{max-width:100%;border-radius:var(--td-radius-medium);margin:4px 0}
.zt-md-table-wrap{margin:0 0 8px;overflow:auto;border:1px solid var(--td-component-border);border-radius:var(--td-radius-medium)}
.zt-md-table{width:100%;border-collapse:collapse;font:var(--td-font-body-small)}
.zt-md-table th,.zt-md-table td{padding:6px 10px;border-bottom:1px solid var(--td-component-stroke);text-align:left;vertical-align:top}
.zt-md-table th{background:var(--td-bg-color-secondarycontainer);font-weight:600;color:var(--td-text-color-secondary)}
.zt-md-table tr:last-child td{border-bottom:0}
.zt-typing{font:var(--td-font-body-small);color:var(--td-text-color-placeholder);padding:2px 4px}
.zt-card{border:1px solid var(--zt-card-border);background:var(--zt-card-bg);border-radius:15px;padding:16px;display:flex;flex-direction:column;gap:8px}
.zt-card-primary{border-color:var(--zt-card-primary-border);background:var(--zt-card-primary-bg)}
.zt-edit-hint{margin-left:auto;font:var(--td-font-body-small);color:var(--td-text-color-placeholder)}
.zt-edit-field{display:flex;flex-direction:column;gap:2px;min-width:0}
.zt-edit-label{font:var(--td-font-body-small);color:var(--td-text-color-secondary)}
.zt-edit-title{width:100%;box-sizing:border-box;margin:0;padding:4px 6px;border:1px solid transparent;border-radius:var(--zt-radius);background:transparent;color:var(--td-text-color-primary);font:var(--td-font-title-small);outline:none;transition:background-color .12s linear,border-color .12s linear,box-shadow .12s linear}
.zt-edit-textarea{display:block;width:100%;box-sizing:border-box;min-height:30px;height:auto;padding:4px 6px;border:1px solid transparent;border-radius:var(--zt-radius);background:transparent;color:var(--td-text-color-primary);font:var(--td-font-body-medium);line-height:22px;resize:none;overflow:hidden;outline:none;transition:background-color .12s linear,border-color .12s linear,box-shadow .12s linear}
.zt-edit-title::placeholder,.zt-edit-textarea::placeholder{color:var(--td-text-color-placeholder)}
.zt-edit-title:hover,.zt-edit-textarea:hover{background:var(--td-bg-color-container-hover)}
.zt-edit-title:focus,.zt-edit-textarea:focus{background:var(--td-bg-color-specialcomponent);border-color:var(--td-brand-color);box-shadow:0 0 0 2px var(--td-brand-color-focus)}
.zt-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.zt-card-tag{display:inline-flex;align-items:center;height:24px;padding:0 8px;border-radius:var(--zt-radius);background:var(--td-bg-color-container);color:var(--td-text-color-secondary);font-size:12px;line-height:20px}
.zt-card-tag-warn{background:var(--td-warning-color-light);color:var(--td-warning-color)}
.zt-api-meta{display:flex;align-items:center;gap:8px;font:var(--td-font-body-small);color:var(--td-text-color-secondary);min-width:0}
.zt-api-meta code{font-family:var(--td-font-family-code);font-size:12px;line-height:18px;padding:2px 6px;border-radius:4px;background:var(--td-bg-color-container);color:var(--td-text-color-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.zt-api-list{display:flex;flex-direction:column;gap:4px}
.zt-api-item{display:flex;align-items:center;gap:8px;min-width:0;font:var(--td-font-body-medium)}
.zt-api-id{flex:0 0 auto;font-family:var(--td-font-family-code);font-size:12px;color:var(--td-text-color-placeholder)}
.zt-api-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-api-extra{flex:0 0 auto;font-size:12px;color:var(--td-text-color-secondary)}
.zt-api-detail{margin:0;padding:8px 10px;border-radius:6px;background:var(--td-bg-color-container);font-family:var(--td-font-family-code);font-size:11px;line-height:17px;overflow:auto;max-height:220px}
.zt-api-path{margin-top:2px;font-family:var(--td-font-family-code);font-size:11px;color:var(--td-text-color-placeholder);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-doc-error{color:var(--td-error-color)}
.zt-card-title{font:var(--td-font-title-small);color:var(--td-text-color-primary)}
.zt-card-body{white-space:pre-wrap;word-break:break-word;color:var(--td-text-color-primary);font:var(--td-font-body-medium)}
.zt-card-sub{font:var(--td-font-body-small);color:var(--td-text-color-secondary);white-space:pre-wrap;word-break:break-word}
.zt-card-sub b{color:var(--td-text-color-primary);font-weight:600;display:block;margin-bottom:2px}
.zt-card-meta{display:flex;gap:16px;font:var(--td-font-body-small);color:var(--td-text-color-secondary);flex-wrap:wrap}
.zt-choices{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start;min-width:0}
.zt-choice{display:inline-flex;align-items:center;justify-content:flex-start;height:auto;min-height:var(--td-comp-size-m);max-width:100%;padding:5px 15px;border:1px solid var(--td-border-level-2-color);border-radius:20px;background:var(--td-bg-color-specialcomponent);color:var(--td-text-color-primary);cursor:pointer;font:var(--td-font-body-medium);line-height:22px;white-space:normal;text-align:left;word-break:break-word;overflow-wrap:anywhere;transition:color .2s,border-color .2s,background-color .2s}
.zt-choice:hover{border-color:var(--td-brand-color-hover);color:var(--td-brand-color-hover)}
.zt-choice-primary{background:var(--td-brand-color);border-color:var(--td-brand-color);color:var(--td-text-color-anti)}
.zt-choice-primary:hover{background:var(--td-brand-color-hover);border-color:var(--td-brand-color-hover);color:var(--td-text-color-anti)}
.zt-result{background:var(--td-success-color-light);border:1px solid var(--td-success-color);border-radius:var(--td-radius-medium);padding:12px 16px;display:flex;flex-direction:column;gap:8px}
.zt-result-fail{background:var(--td-error-color-light);border-color:var(--td-error-color)}
.zt-result-title{font:var(--td-font-title-small);color:var(--td-success-color)}
.zt-result-sub{font:var(--td-font-body-medium);color:var(--td-text-color-primary);word-break:break-word}
.zt-result-fail .zt-result-title{color:var(--td-error-color)}
.zt-result-link{color:var(--td-text-color-brand);font:var(--td-font-body-small);text-decoration:none}
.zt-result-link:hover{text-decoration:underline}
.zt-case{border-top:1px solid var(--td-component-stroke);padding-top:12px;display:flex;flex-direction:column;gap:4px}
.zt-case-edit-step{display:grid;grid-template-columns:64px minmax(0,1fr);gap:6px 8px;align-items:start;padding:4px 0}
.zt-case-edit-step .zt-edit-textarea{grid-column:2}
.zt-case-title{font:var(--td-font-title-small)}
.zt-case-dir{display:inline-flex;align-items:center;height:20px;margin-left:8px;padding:0 6px;border-radius:var(--zt-radius);background:var(--td-bg-color-secondarycontainer);color:var(--td-text-color-secondary);font-size:12px;line-height:18px;font-weight:400}
.zt-case-row{font:var(--td-font-body-small);color:var(--td-text-color-primary)}
.zt-case-expect{color:var(--td-text-color-secondary)}
.zt-muted{color:var(--td-text-color-secondary)}
.zt-confirm{display:flex;flex-direction:column;gap:12px}
.zt-field{display:flex;align-items:center;gap:12px}
.zt-field-label{width:64px;flex:0 0 auto;font:var(--td-font-body-small);color:var(--td-text-color-secondary)}
.zt-field-value{font:var(--td-font-body-small);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-select{flex:1;min-width:0;height:var(--td-comp-size-m);padding:0 28px 0 var(--td-comp-paddingLR-s);background:var(--td-bg-color-specialcomponent);color:var(--td-text-color-primary);border:1px solid var(--td-border-level-2-color);border-radius:var(--td-radius-default);font:var(--td-font-body-medium);cursor:pointer;appearance:none;-webkit-appearance:none;text-overflow:ellipsis}
.zt-select:hover{border-color:var(--td-brand-color)}
.zt-select:focus,.zt-select:focus-visible{outline:none;border-color:var(--td-brand-color);box-shadow:0 0 0 2px var(--td-brand-color-focus)}
.zt-confirm-btn{align-self:flex-end}
.zt-composer{position:relative;padding:8px 16px 16px;display:flex;flex-direction:column;gap:8px;background:var(--td-bg-color-container);min-width:0;flex:0 0 auto}
.zt-composer-card{position:relative;display:flex;flex-direction:column;width:100%;box-sizing:border-box;border-radius:var(--dsw-radius-panel,28px);background:var(--dsw-specific-input-major,var(--td-bg-color-container));--dsw-elevation-stroke-color:var(--dsw-alias-border-l2,#0000001a);box-shadow:var(--dsw-elevation-soft,0 0 0 .5px var(--dsw-alias-border-l2,#0000001a),0 4px 16px 0 #00000008,0 0 24px 0 #00000008);overflow:hidden;transition:box-shadow .15s ease}
.zt-composer.zt-drop-active .zt-composer-card{outline:2px dashed var(--td-brand-color);outline-offset:2px}
.zt-image-chips{display:flex;flex-wrap:wrap;gap:8px;padding:0 4px 8px}
.zt-image-chip{position:relative;width:56px;height:56px;border-radius:8px;overflow:hidden;border:1px solid var(--td-component-stroke);background:var(--td-bg-color-container-hover)}
.zt-image-chip img{width:100%;height:100%;object-fit:cover;display:block}
.zt-image-chip-x{position:absolute;top:2px;right:2px;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;cursor:pointer}
.zt-image-chip-x:hover{background:rgba(0,0,0,.75)}
.zt-msg-image-names{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;margin-top:6px}
.zt-msg-image-name{font-size:12px;line-height:18px;padding:2px 8px;border-radius:10px;background:var(--td-bg-color-container-hover);color:var(--td-text-color-secondary);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-chips{display:flex;gap:8px;flex-wrap:wrap}
.zt-chip{display:inline-flex;align-items:center;gap:4px;height:24px;max-width:220px;padding:0 4px 0 8px;background:var(--td-bg-color-secondarycontainer);border:1px solid var(--td-component-border);border-radius:var(--zt-radius);font:var(--td-font-body-small)}
.zt-chip-type{color:var(--td-brand-color);font-weight:600}
.zt-chip-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--td-text-color-secondary)}
.zt-chip-x{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:0 0 auto;border:0;background:transparent;color:var(--zt-icon-muted);cursor:pointer;padding:0;border-radius:var(--td-radius-small);transition:color .2s,background-color .2s}
.zt-chip-x:hover{color:var(--zt-icon-strong);background:var(--td-bg-color-component)}
.zt-quick{display:flex;gap:8px;flex-wrap:wrap}
.zt-chip-btn{display:inline-flex;align-items:center;justify-content:center;height:var(--td-comp-size-s);padding:0 11px;border:1px solid var(--td-border-level-2-color);border-radius:var(--zt-radius);background:var(--td-bg-color-specialcomponent);color:var(--td-text-color-primary);cursor:pointer;font:var(--td-font-body-small);gap:4px;transition:color .2s,border-color .2s}
.zt-chip-btn:hover{color:var(--td-brand-color-hover);border-color:var(--td-brand-color-hover)}
.zt-input{width:100%;box-sizing:border-box;min-height:36px;background:transparent;color:var(--dsw-alias-label-primary,var(--td-text-color-primary));border:0;border-radius:0;padding:12px 14px 4px;font:14px/24px var(--dsw-font-family,var(--td-font-family));caret-color:var(--dsw-alias-state-business-primary,var(--td-brand-color));outline:none;resize:none;overflow-y:auto}
.zt-input::placeholder{color:var(--dsw-alias-label-caption,var(--td-text-color-placeholder))}
.zt-input:hover{background:transparent}
.zt-input:focus,.zt-input:focus-visible{outline:none;border:0;box-shadow:none}
.zt-resize{display:flex;align-items:center;justify-content:center;height:10px;margin:-6px 0 -2px;cursor:ns-resize;user-select:none}
.zt-resize::before{content:'';width:38px;height:3px;border-radius:var(--td-radius-round);background:var(--td-border-level-2-color)}
.zt-resize:hover::before{background:var(--td-brand-color)}
.zt-composer-row{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0;padding:2px 8px 8px 10px}
.zt-composer-tools{display:flex;align-items:center;gap:2px;flex:0 0 auto;min-width:0}
.zt-tool-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--zt-icon);cursor:pointer;transition:background-color .12s,color .12s}
.zt-tool-btn:hover:not(:disabled){background:var(--td-bg-color-container-hover);color:var(--td-text-color-primary)}
.zt-tool-btn:disabled{opacity:.45;cursor:default}
.zt-tool-recording{color:var(--td-error-color)}
.zt-tool-recording svg{animation:zt-pulse 1.1s ease-in-out infinite}
@keyframes zt-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.zt-composer-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto;min-width:0}
.zt-model-wrap{position:relative;display:inline-flex;align-items:center;min-width:0;color:var(--td-text-color-secondary)}
.zt-model-wrap>svg{position:absolute;right:7px;pointer-events:none;opacity:.7}
.zt-model-chip{display:inline-flex;align-items:center;height:28px;max-width:150px;min-width:0;padding:0 24px 0 9px;border:0;border-radius:14px;background:transparent;color:var(--td-text-color-secondary);font-size:12px;line-height:18px;cursor:pointer;transition:background-color .12s,color .12s;appearance:none;-webkit-appearance:none;text-overflow:ellipsis}
.zt-model-chip:hover{background:var(--td-bg-color-container-hover);color:var(--td-text-color-primary)}
.zt-model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-hint{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption,var(--td-text-color-placeholder))}
.zt-menu-backdrop{position:fixed;inset:0;z-index:39}
.zt-context-menu{position:fixed;z-index:41;min-width:168px;padding:4px;border:1px solid var(--td-component-stroke);border-radius:8px;background:var(--td-bg-color-container);box-shadow:var(--td-shadow-3,0 6px 24px rgba(0,0,0,.12))}
.zt-context-item{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--td-text-color-primary);font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.zt-context-item:hover{background:var(--td-bg-color-container-hover)}
.zt-context-item svg{color:var(--td-text-color-secondary)}
.zt-context-head{padding:6px 10px 8px;margin-bottom:2px;border-bottom:1px solid var(--td-component-stroke);color:var(--td-text-color-placeholder);font-size:12px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-context-item-current{color:var(--td-text-color-placeholder);cursor:default}
.zt-context-check{margin-left:auto;font-size:11px;color:var(--td-text-color-placeholder)}
.zt-context-item .zt-status-dot{width:6px;height:6px;border-radius:50%;background:var(--td-success-color)}
.zt-context-item .zt-status-dot-suspended{background:var(--td-warning-color)}
.zt-context-item .zt-status-dot-closed{background:var(--td-text-color-placeholder)}
.zt-context-subwrap{position:relative}
.zt-context-sub{display:none;position:absolute;left:calc(100% + 4px);top:-4px;min-width:148px}
.zt-context-subwrap:hover .zt-context-sub{display:block}
.zt-context-subwrap>.zt-context-item{width:100%}
.zt-context-caret{display:inline-flex;align-items:center;margin-left:auto;color:var(--td-text-color-placeholder)}
.zt-modal-grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.zt-composer-menu{position:absolute;z-index:40;left:16px;bottom:calc(100% - 8px);width:min(320px,calc(100% - 32px));max-height:min(360px,60vh);display:flex;flex-direction:column;border-radius:10px;background:var(--td-bg-color-container);border:1px solid var(--td-component-stroke);box-shadow:var(--td-shadow-3,0 6px 24px rgba(0,0,0,.12));overflow:hidden}
.zt-composer-menu-right{left:auto;right:16px}
.zt-menu-head{padding:10px 12px 6px;font-size:12px;line-height:18px;color:var(--td-text-color-placeholder);flex:0 0 auto}
.zt-menu-body{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-height:0;overflow:auto;padding:0 4px 4px}
.zt-menu-item{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:var(--td-text-color-primary);font:var(--td-font-body-medium);text-align:left;cursor:pointer}
.zt-menu-item:hover{background:var(--td-bg-color-container-hover)}
.zt-menu-item-active{background:var(--td-brand-color-light);color:var(--td-text-color-brand)}
.zt-menu-item-main{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-menu-item-meta{flex:0 0 auto;max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--td-text-color-placeholder)}
.zt-menu-icon-placeholder{width:16px;height:16px;flex:0 0 16px}
.zt-menu-group{display:flex;flex-direction:column;gap:2px}
.zt-menu-group-label{padding:8px 8px 2px;font-size:12px;line-height:18px;color:var(--td-text-color-placeholder)}
.zt-menu-empty{padding:12px 10px;font-size:12px;color:var(--td-text-color-placeholder)}
@container (max-width: 520px){.zt-hint{display:none}}
.zt-send{flex:0 0 auto;display:grid;place-items:center;width:34px;height:34px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-button-info-fill,var(--td-brand-color));color:#fff;cursor:pointer;transition:background-color .1s}
.zt-send:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,var(--td-brand-color-hover))}
.zt-send:disabled{opacity:.4;cursor:default}
.zt-send.zt-send-busy:disabled{opacity:1;cursor:progress}
.zt-spinner{width:16px;height:16px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:zt-spin .8s linear infinite}
@media (prefers-reduced-motion:reduce){.zt-spinner{animation:none;border-right-color:currentColor;opacity:.6}}
.zt-select-wrap{position:relative;display:flex;align-items:center;flex:1 1 auto;min-width:0}
.zt-select-caret{position:absolute;right:8px;display:flex;color:var(--zt-icon);pointer-events:none}
.zt-right{position:relative}
.zt-panel-badge-dot{position:absolute;top:0;right:0;width:6px;height:6px;border-radius:50%;background:#e34d59;z-index:2}
.zt-version-line{display:inline-flex;align-items:center;gap:8px;min-width:0}
.zt-settings-btn{flex:0 0 auto}
.zt-model-select{height:26px;max-width:150px;min-width:90px;padding:0 22px 0 8px;border:1px solid var(--td-component-stroke);border-radius:6px;background:var(--td-bg-color-container);color:var(--td-text-color-primary);font-size:12px;line-height:24px;cursor:pointer;appearance:auto}
.zt-model-select:hover{border-color:var(--td-brand-color)}
.zt-model-select:focus{outline:none;border-color:var(--td-brand-color)}
.zt-modal-section{font-size:12px;font-weight:600;color:var(--td-text-color-secondary);padding-top:2px}
.zt-modal-hint{padding:8px 0;color:var(--td-text-color-secondary);font-size:13px}
.zt-check-update{position:relative;display:inline-flex;align-items:center;gap:4px;padding:0;border:0;background:transparent;color:var(--td-text-color-brand);font-size:11px;line-height:16px;cursor:pointer;white-space:nowrap}
.zt-check-update:hover{text-decoration:underline}
.zt-check-update:disabled{color:var(--td-text-color-placeholder);cursor:default;text-decoration:none}
.zt-check-update-new{font-weight:600}
.zt-update-dot{width:6px;height:6px;border-radius:50%;background:var(--td-error-color);display:inline-block}
.zt-update-pop{position:absolute;right:0;left:auto;bottom:calc(100% + 8px);z-index:45;width:calc(var(--zt-left-w, 300px) - 24px);max-width:calc(100vw - 24px);display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:10px;border:1px solid var(--td-component-stroke);background:var(--td-bg-color-container);box-shadow:var(--td-shadow-3,0 6px 24px rgba(0,0,0,.12));font-size:12px;line-height:18px;color:var(--td-text-color-secondary);box-sizing:border-box}
.zt-update-pop-info{border-color:var(--td-brand-color-focus)}
.zt-update-pop-ok{border-color:var(--td-success-color-focus)}
.zt-update-pop-error{border-color:var(--td-error-color-focus);color:var(--td-error-color)}
.zt-update-pop-text{flex:1;min-width:0;word-break:break-word}
.zt-update-pop-close{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer}
.zt-update-pop-close:hover{background:var(--td-bg-color-container-hover)}
.zt-bell-btn{position:relative;flex:0 0 auto}
.zt-bell-dot{position:absolute;top:3px;right:3px;width:7px;height:7px;border-radius:50%;background:var(--td-error-color);box-shadow:0 0 0 1.5px var(--td-bg-color-container)}
.zt-btn-badge{position:absolute;top:1px;right:1px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--td-error-color);color:#fff;font-size:9px;line-height:14px;text-align:center;font-weight:500}
.zt-assign-menu{position:absolute;right:0;left:auto;bottom:calc(100% + 8px);z-index:40;width:calc(var(--zt-left-w, 300px) - 24px);max-width:calc(100vw - 24px);max-height:min(440px,74vh);display:flex;flex-direction:column;background:var(--td-bg-color-container);border:1px solid var(--td-component-stroke);border-radius:10px;box-shadow:var(--td-shadow-3,0 6px 24px rgba(0,0,0,.12));overflow:hidden;-webkit-app-region:no-drag}
.zt-assign-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px 6px;flex:0 0 auto;font-size:12px;line-height:18px;color:var(--td-text-color-placeholder)}
.zt-assign-text-btn{border:0;background:transparent;color:var(--td-text-color-brand);font-size:12px;cursor:pointer;padding:0}
.zt-assign-list{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-height:0;overflow:auto;padding:0 4px 4px}
.zt-assign-item{display:flex;align-items:flex-start;gap:6px;padding:7px 6px;border-radius:6px;min-width:0}
.zt-assign-item:hover{background:var(--td-bg-color-container-hover)}
.zt-assign-item-read{opacity:.65}
.zt-assign-unread-dot{width:6px;height:6px;border-radius:50%;background:var(--td-error-color);flex:0 0 auto;margin-top:7px}
.zt-assign-item-main{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0;padding:0;border:0;background:transparent;color:var(--td-text-color-primary);text-align:left;cursor:pointer;font:inherit;text-decoration:none}
.zt-assign-item-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--td-font-body-medium)}
.zt-assign-item-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--td-text-color-placeholder)}
.zt-assign-actions{display:flex;align-items:center;gap:0;flex:0 0 auto}
.zt-assign-actions .zt-icon-btn{width:24px;height:24px}
.zt-assign-empty{padding:12px 8px;font-size:12px;color:var(--td-text-color-placeholder)}
.zt-assign-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-top:1px solid var(--td-component-stroke);flex:0 0 auto;font-size:12px;color:var(--td-text-color-secondary)}
.zt-assign-toast{position:absolute;right:16px;top:56px;z-index:45;width:300px;max-width:calc(100% - 32px);display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:10px;background:#fff7e6;border:1px solid #f0c36d;border-left:3px solid #ed7b2f;box-shadow:0 8px 28px rgba(0,0,0,.16);-webkit-app-region:no-drag}
body[data-ds-dark-theme] .zt-root .zt-assign-toast{background:#2e2718;border-color:#6b5420;border-left-color:#ed7b2f}
body[data-ds-dark-theme] .zt-root .zt-assign-toast-head{color:#f0d9a8}
.zt-assign-toast-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;line-height:18px;color:var(--td-text-color-secondary)}
.zt-assign-toast-body{display:flex;flex-direction:column;gap:4px}
.zt-assign-toast-row{display:flex;align-items:center;gap:6px;min-width:0;font:var(--td-font-body-medium)}
.zt-assign-kind{flex:0 0 auto;padding:0 4px;border-radius:3px;background:var(--td-bg-color-container-hover);font-size:11px;line-height:16px;color:var(--td-text-color-secondary)}
.zt-assign-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:inherit;text-decoration:none;cursor:pointer}
.zt-assign-title:hover,.zt-assign-item-main:hover .zt-assign-item-title{text-decoration:underline;color:var(--td-brand-color)}
.zt-assign-meta{flex:0 0 auto;font-size:11px;color:var(--td-text-color-placeholder)}
.zt-assign-toast-actions{display:flex;gap:8px;justify-content:flex-end}
.zt-history-menu{position:absolute;top:52px;right:8px;z-index:40;width:300px;max-width:calc(100% - 16px);max-height:min(420px,72vh);display:flex;flex-direction:column;background:var(--td-bg-color-container);border:1px solid var(--td-component-stroke);border-radius:10px;box-shadow:var(--td-shadow-3,0 6px 24px rgba(0,0,0,.12));overflow:hidden;-webkit-app-region:no-drag}
.zt-history-head{padding:10px 12px 6px;flex:0 0 auto;font-size:12px;line-height:18px;color:var(--td-text-color-placeholder)}
.zt-history-list{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-height:0;overflow:auto;padding:0 4px 6px}
.zt-history-item{display:flex;align-items:center;gap:2px;padding:1px 2px 1px 8px;border-radius:6px;min-width:0}
.zt-history-item:hover{background:var(--td-bg-color-container-hover)}
.zt-history-item-active{background:var(--dsw-alias-interactive-bg-active)}
.zt-history-main{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;padding:7px 0;border:0;background:transparent;color:var(--td-text-color-primary);font:var(--td-font-body-medium);text-align:left;cursor:pointer}
.zt-history-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-history-time{flex:0 0 auto;font-size:12px;color:var(--td-text-color-placeholder)}
.zt-history-action{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;flex:0 0 auto;border:0;border-radius:50%;background:transparent;color:var(--zt-icon-muted);cursor:pointer;opacity:0;transition:opacity .12s,color .12s}
.zt-history-item:hover .zt-history-action,.zt-history-item-active .zt-history-action{opacity:1}
.zt-history-action:hover{color:var(--zt-icon-strong);background:var(--td-bg-color-container-hover)}
.zt-history-archived-toggle{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;margin-top:4px;padding:8px;border:0;border-top:1px solid var(--td-component-stroke);background:transparent;color:var(--td-text-color-secondary);font-size:12px;line-height:18px;cursor:pointer}
.zt-history-archived-toggle:hover{color:var(--td-text-color-primary)}
.zt-history-empty{padding:10px 8px;font-size:12px;color:var(--td-text-color-placeholder)}
.zt-history-item-editing{background:var(--td-bg-color-container-hover)}
.zt-history-item-editing .zt-history-action{opacity:1}
.zt-history-edit{flex:1 1 auto;min-width:0;padding:4px 0}
.zt-history-input{width:100%;box-sizing:border-box;height:28px;padding:0 8px;border:1px solid var(--td-brand-color);border-radius:6px;background:var(--td-bg-color-container);color:var(--td-text-color-primary);font:var(--td-font-body-medium);outline:none}
.zt-tree::-webkit-scrollbar,.zt-table-wrap::-webkit-scrollbar,.zt-chat::-webkit-scrollbar,.zt-input::-webkit-scrollbar{width:6px;height:6px}
.zt-tree::-webkit-scrollbar-thumb,.zt-table-wrap::-webkit-scrollbar-thumb,.zt-chat::-webkit-scrollbar-thumb,.zt-input::-webkit-scrollbar-thumb{background:var(--td-scrollbar-color);border-radius:11px}
.zt-tree::-webkit-scrollbar-thumb:hover,.zt-table-wrap::-webkit-scrollbar-thumb:hover,.zt-chat::-webkit-scrollbar-thumb:hover,.zt-input::-webkit-scrollbar-thumb:hover{background:var(--td-scrollbar-hover-color)}
.zt-tree::-webkit-scrollbar-track,.zt-table-wrap::-webkit-scrollbar-track,.zt-chat::-webkit-scrollbar-track,.zt-input::-webkit-scrollbar-track{background:transparent}
`;

    function PanelButton(props) {
      // The sidebar owns the clickable button; this entry renders only the icon.
      const size = Number(props.size) || 18;
      const [unread, setUnread] = useState(assignmentStore.unread);
      useEffect(() => {
        startAssignmentPolling();
        return subscribeAssignments(() => setUnread(assignmentStore.unread));
      }, []);
      return h(
        'span',
        {
          className: 'zt-panel-icon' + (props.active ? ' zt-panel-icon-active' : ''),
          title: unread ? unread + ' 条禅道指派提醒' : '禅道 AI 工作台',
          'aria-hidden': true,
          style: {
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: size,
            height: size,
            color: 'currentColor',
          },
        },
        h(Icon, { size }),
        unread ? h('span', { className: 'zt-panel-badge-dot', 'aria-hidden': true }) : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const layout = () => ctx.get('layout');
        ctx.effect(() =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id: 'zentao', order: 4, label: '禅道 AI 工作台' }, (props) =>
              h(PanelButton, props),
            ),
          ),
        );
        ctx.effect(() =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: 'zentao' }, (props) =>
              h(Workbench, Object.assign({}, props, { layout: layout() })),
            ),
          ),
        );
      },
    };
  },
});
