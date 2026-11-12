// Browser half of the ZenTao AI workbench.
// Plain JavaScript (no JSX): React comes from the module table.

window.__ModuleLoader__.load({
  id: '@local/dsh-zentao',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const PLUGIN_VERSION = 'v0.0.1';
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
      const fallback = { leftOpen: true, rightOpen: true, leftW: 300, rightW: 420 };
      const viewport = typeof window !== 'undefined' ? window.innerWidth || 1280 : 1280;
      // Leave at least a usable middle column in the current viewport.
      const budget = Math.max(560, viewport - 360);
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
    const SHOW_CLOSED_KEY = 'dsh-zentao-show-closed-v1';
    const COL_WIDTHS_KEY = 'dsh-zentao-col-widths-v1';
    const COL_ORDER_KEY = 'dsh-zentao-col-order-v1';
    const COLUMN_KEYS = ['id', 'title', 'module', 'priority', 'assignee', 'status'];

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

    function loadColWidths() {
      try {
        const raw = JSON.parse(localStorage.getItem(COL_WIDTHS_KEY) || 'null');
        if (!raw || typeof raw !== 'object') return null;
        const base = ['id', 'title', 'module', 'priority', 'assignee', 'status'];
        const extra = ['storyState'];
        const out = {};
        for (const key of base.concat(extra)) {
          const value = Number(raw[key]);
          if (Number.isFinite(value) && value > 0) {
            out[key] = clamp(value, COL_WIDTH_LIMITS.min, COL_WIDTH_LIMITS.max);
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

    /** null = the user never chose; the host config default applies. */
    function readShowClosed() {
      try {
        const raw = localStorage.getItem(SHOW_CLOSED_KEY);
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
      // Path data from tdesign-icons-react@0.6.12: 24px grid, 2px stroke,
      // square caps — the geometry TDesign uses for its own toolbar icons.
      const name = props.name;
      const size = props.size || 16;
      const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'square', strokeLinejoin: 'miter' };
      const paths = {
        'chevron-left': ['M14.5 17.5L9 12L14.5 6.5'],
        'chevron-right': ['M9.5 17.5L15 12L9.5 6.5'],
        'chevron-down': ['M17.5 9.5L12 15L6.5 9.5'],
        plus: ['M12 5L12 19M19 12L5 12'],
        reset: ['M5.75 7H14C17.3137 7 20 9.68629 20 13C20 16.3137 17.3137 19 14 19L6.5 19M8 10.5L4.5 7L8 3.5'],
        refresh: [
          'M21.448 13C20.9483 17.7767 16.909 21.5 12 21.5C8.18227 21.5 4.89052 19.248 3.38065 16M2.5 20.5V15.5H5.5M2.55176 11C3.05145 6.22334 7.09079 2.5 11.9998 2.5C15.8175 2.5 19.1092 4.75197 20.6191 8M21.4998 3.5V8.5H18.4998',
        ],
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
        attach: ['M20.5062 12.3131L12.728 20.0913C10.3848 22.4344 6.58586 22.4344 4.24271 20.0913C1.89957 17.7481 1.89956 13.9491 4.24271 11.606L12.0209 3.82782C13.583 2.26573 16.1156 2.26573 17.6777 3.82782C19.2398 5.38992 19.2398 7.92258 17.6777 9.48468L9.89957 17.2628C9.11852 18.0439 7.85219 18.0439 7.07114 17.2628C6.29009 16.4818 6.29009 15.2155 7.07114 14.4344L14.1422 7.36336'],
        edit: ['M14.1048 6.00427L4.78744 15.3216L3.99805 20.0001L8.67652 19.2107L17.9939 9.89336L14.1048 6.00427ZM14.1048 6.00427L17.1615 2.94727L21.0506 6.83635L17.9939 9.89336'],
        folder: ['M2 3.5H9L11 6H22V20H2V3.5Z'],
        'folder-open': ['M2 20V3.5H8.5L10.5 6H22V9', 'M2 20L5 9H22L18.5 20H2Z'],
        mic: ['M12 18V21M7 21H17M6.5 14H9M6.5 7H9M6.5 10.5H9M15 14H17.5M15 7H17.5M15 10.5H17.5M6 7V13C6 13.3425 6.03443 13.6769 6.10002 14C6.56329 16.2822 8.58104 18 11 18C11.781 18 12.219 18 13 18C15.419 18 17.4367 16.2822 17.9 14C17.9656 13.6769 18 13.3425 18 13V7C18 4.23858 15.7614 2 13 2H11C8.23858 2 6 4.23858 6 7Z'],
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

    function statusTone(status) {
      const map = {
        doing: 'primary', active: 'primary', planned: 'primary', projected: 'primary',
        developing: 'primary', developed: 'primary',
        testing: 'warning', suspended: 'warning', postponed: 'warning',
        tested: 'success', verified: 'success', released: 'success',
        fixed: 'success', resolved: 'success',
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
      const [tab, setTab] = useState('story');
      const [me, setMe] = useState({ account: '', realname: '' });
      const [onlyMine, setOnlyMine] = useState(() => {
        try {
          return localStorage.getItem('dsh-zentao-only-mine-v1') === '1';
        } catch (error) {
          return false;
        }
      });
      const [items, setItems] = useState({ story: [], bug: [] });
      const [sort, setSort] = useState({ key: '', dir: 'asc' });
      const [showClosed, setShowClosed] = useState(() => {
        const stored = readShowClosed();
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
      const docInputRef = useRef(null);
      const [editingConvId, setEditingConvId] = useState('');
      const [editingTitle, setEditingTitle] = useState('');
      const copiedTimerRef = useRef(null);
      const [assignToastOn, setAssignToastOn] = useState(assignToastEnabled);
      const assignNotifiedRef = useRef(0);
      const [iterationOptions, setIterationOptions] = useState(null);
      const [iterationLoading, setIterationLoading] = useState(false);
      const [modelState, setModelState] = useState(null);
      const [recording, setRecording] = useState(false);
      const [transcribing, setTranscribing] = useState(false);
      const [voiceStarting, setVoiceStarting] = useState(false);
      const recorderRef = useRef(null);
      const voiceStartingRef = useRef(false);
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
            const middleMin = 300;
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
        window.addEventListener('resize', fit);
        return () => window.removeEventListener('resize', fit);
      }, []);

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

      // Assignment events carry the ZenTao detail URL. Keep a deterministic
      // fallback for older saved notifications that predate the URL field.
      const assignmentUrl = (event) => {
        const saved = String((event && event.url) || '').trim();
        if (/^https?:\/\//i.test(saved)) return saved;
        if (saved) return baseUrl + (saved.startsWith('/') ? saved : '/' + saved);
        const id = Number(event && event.itemId) || 0;
        if (!id) return '';
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
                          (event.kind === 'story' ? '需求' : 'BUG') +
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
                            title: '标记已读',
                            'aria-label': '标记已读',
                            onClick: () => markAssignmentsRead([event.id]),
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
          if (data.baseUrl) setBaseUrl(data.baseUrl);
          setTreeError('');
          if (readShowClosed() === null && data.config && typeof data.config.showClosed === 'boolean') {
            setShowClosed(data.config.showClosed);
          }
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
          setExecs((prev) => Object.assign({}, prev, { [projectId]: data.executions || [] }));
        } catch (error) {
          setExecs((prev) => Object.assign({}, prev, { [projectId]: [] }));
        }
      }, []);

      const loadItems = useCallback(async (executionId, fresh = false) => {
        if (!executionId) {
          setItems({ story: [], bug: [] });
          return;
        }
        setLoading(true);
        setListError('');
        const suffix = '&executionId=' + executionId + (fresh ? '&fresh=1' : '');
        try {
          const [stories, bugs] = await Promise.all([
            api('/zentao/api/items?type=story' + suffix),
            api('/zentao/api/items?type=bug' + suffix),
          ]);
          setItems({ story: stories.items || [], bug: bugs.items || [] });
        } catch (error) {
          setListError(error.message);
        } finally {
          setLoading(false);
        }
      }, []);

      const refreshAll = useCallback(async () => {
        setTreeBusy(true);
        try {
          await loadTree(true);
          const ids = Object.keys(execs);
          await Promise.all(ids.map((pid) => loadExecs(Number(pid), true)));
          if (selection.executionId) await loadItems(selection.executionId, true);
        } finally {
          setTreeBusy(false);
        }
      }, [execs, selection.executionId, loadTree, loadExecs, loadItems]);

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

      const toggleShowClosed = () => {
        const next = !showClosed;
        setShowClosed(next);
        try {
          localStorage.setItem(SHOW_CLOSED_KEY, next ? '1' : '0');
        } catch (error) {
          /* storage unavailable */
        }
        if (!next) {
          const project = projects.find((p) => p.id === selection.projectId);
          const execution = (execs[selection.projectId] || []).find((e) => e.id === selection.executionId);
          const hidden =
            (project && project.status === 'closed') || (execution && execution.status === 'closed');
          if (selection.executionId && hidden) {
            setSelection({ projectId: 0, projectName: '', executionId: 0, executionName: '' });
            setItems({ story: [], bug: [] });
          }
        }
      };

      const toggleProject = (project) => {
        const open = !!openProjects[project.id];
        setOpenProjects((prev) => Object.assign({}, prev, { [project.id]: !open }));
        if (!open && !execs[project.id]) loadExecs(project.id);
      };

      const selectExecution = (project, execution) => {
        setSelection({
          projectId: project.id,
          projectName: project.name,
          executionId: execution.id,
          executionName: execution.name,
        });
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
          if (!trimmed && !action) return;
          const userText = trimmed || actionLabel(action);
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
              { id: uid('msg'), role: 'user', text: userText, cards: [], at: Date.now() },
              { id: assistantId, role: 'assistant', text: '', cards: [], at: Date.now() },
            ]),
          );
          setInput('');
          setBusy(true);
          setStatusText('');
          const pendingEdit = pendingEditRef.current;
          pendingEditRef.current = null;
          const payload = {
            conversationId: convId.current,
            text: trimmed,
            action: action && action.type === 'quick' && action.value === 'doc' ? { type: 'quick', value: 'doc' } : action || null,
            edit: pendingEdit,
            contexts,
            selection: Object.assign({}, selection, { contexts }),
            ...(action && action.type === 'quick' && action.value === 'doc'
              ? { docItems: Array.isArray(action.docItems) ? action.docItems : [], docName: String(action.docName || '') }
              : {}),
          };
          let createdSomething = false;
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
          }
        },
        [contexts, selection, messages, loadTree, loadExecs, loadItems],
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
            // Keep at least 240px for the middle column; never overflow the pane.
            const limit = Math.max(side === 'left' ? 200 : 260, width - other - 240);
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
        const snapshot = {};
        headers.forEach((th) => {
          const key = th.getAttribute('data-col');
          const def = SORT_COLUMNS.find((column) => column.key === key);
          const width = Math.round(th.getBoundingClientRect().width);
          if (def && width > 0) snapshot[def.key] = width;
        });
        const startWidth = snapshot[column.key] || COL_WIDTH_LIMITS.min;
        const startX = event.clientX;
        let latest = snapshot;
        setColWidths(snapshot);
        const move = (ev) => {
          const next = clamp(Math.round(startWidth + (ev.clientX - startX)), COL_WIDTH_LIMITS.min, COL_WIDTH_LIMITS.max);
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
      const visibleStories = onlyMine ? items.story.filter(isMine) : items.story;
      const visibleBugs = onlyMine ? items.bug.filter(isMine) : items.bug;
      const list = tab === 'bug' ? visibleBugs : visibleStories;

      // Sortable columns mirror the table headers; values are what the user sees.
      const SORT_COLUMNS = [
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

      // Column order is user-controlled (drag the header), defaulting to the
      // declaration order; every cell renders through these per-key renderers.
      const columnOrder = colOrder && colOrder.length === COLUMN_KEYS.length ? colOrder : COLUMN_KEYS;
      const orderedColumns = columnOrder
        .map((key) => SORT_COLUMNS.find((column) => column.key === key))
        .filter(Boolean);
      const storyStateColumn = SORT_COLUMNS.find((column) => column.key === 'storyState');
      const visibleColumns =
        tab === 'story'
          ? (() => {
              const index = orderedColumns.findIndex((column) => column.key === 'status');
              if (index < 0) return orderedColumns.concat([storyStateColumn]);
              return orderedColumns.slice(0, index).concat([storyStateColumn], orderedColumns.slice(index));
            })()
          : orderedColumns;

      const statusLabel = (item) =>
        (item.type === 'story' ? item.stage || item.statusText : item.resolution || item.statusText) || '—';
      const renderCell = (item, key) => {
        if (key === 'id') return h('td', { key, className: 'zt-mono' }, item.id);
        if (key === 'title') {
          return h(
            'td',
            { key, className: 'zt-title-cell' },
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
          return h(
            'td',
            { key, className: 'zt-col-priority' },
            item.priority
              ? h('span', { className: 'zt-tag zt-tag-' + priorityTone(item.priority) }, 'P' + item.priority)
              : '—',
          );
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
          setRecording(true);
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
        recorderRef.current = null;
        setRecording(false);
        setTranscribing(true);
        try {
          if (rec.processor) rec.processor.disconnect();
          if (rec.source) rec.source.disconnect();
          rec.stream.getTracks().forEach((track) => track.stop());
          const rate = rec.audioCtx.sampleRate;
          await rec.audioCtx.close();
          const merged = mergeFloat32(rec.chunks);
          if (!merged.length) throw new Error('没有录到声音');
          const wav = encodeWavPcm16(resampleLinear(merged, rate, 16000), 16000);
          const data = await api('/zentao/api/transcribe', {
            method: 'POST',
            headers: Object.assign({}, HEADERS, { 'content-type': 'application/json' }),
            body: JSON.stringify({ audioBase64: bytesToBase64(wav) }),
          });
          if (!data.ok) throw new Error(data.error || '识别失败');
          const text = String(data.text || '').trim();
          if (text) setInput((prev) => (prev ? prev.replace(/\s+$/, '') + ' ' : '') + text);
          else setActionError('没有识别出内容，请重试');
        } catch (error) {
          setActionError('语音识别失败：' + error.message);
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
          if (editor.field === 'status' || editor.field === 'storyStatus') {
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
        const column = SORT_COLUMNS.find((c) => c.key === sort.key);
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
      const showProject = (project) => showClosed || project.status !== 'closed';
      const showExecution = (execution) => showClosed || execution.status !== 'closed';
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
              cellEditor.field === 'module'
                ? '修改模块'
                : cellEditor.field === 'status' || cellEditor.field === 'storyStatus'
                  ? cellEditor.item.type === 'bug' ? '修改方案' : '修改状态'
                  : '指派给',
            ),
            cellEditor.loading
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
          },
          className:
            'zt-root' +
            (isMac ? ' zt-mac' : '') +
            (lightsPad > 0 ? ' zt-under-lights' : '') +
            (layout.leftOpen ? '' : ' zt-left-closed'),
          ref: rootRef,
        },
        h('style', { key: 'zt-style' }, CSS),
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
                      h('span', { key: 'label', className: 'zt-tree-filter-label' }, '显示已关闭'),
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
                            className: 'zt-switch' + (showClosed ? ' zt-switch-on' : ''),
                            type: 'button',
                            role: 'switch',
                            'aria-checked': showClosed ? 'true' : 'false',
                            'aria-label': '显示已关闭的项目与迭代',
                            title: showClosed ? '隐藏已关闭的项目/迭代' : '显示已关闭的项目/迭代',
                            onClick: toggleShowClosed,
                          },
                          h('span', { className: 'zt-switch-handle', 'aria-hidden': true }),
                        ),
                      ),
                    ],
              ),
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
                !treeError && projects.length === 0 ? h('div', { className: 'zt-empty' }, '暂无可见项目') : null,
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
                      },
                      h(
                        'span',
                        { className: 'zt-tree-icon' + (open ? ' zt-tree-icon-open' : '') },
                        h(
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
                              },
                              h('span', { className: 'zt-name', title: exec.name }, exec.name),
                              h('span', { className: 'zt-status' }, h(StatusDot, { status: exec.status }), exec.statusText || ''),
                            ),
                          ),
                        ),
                      ),
                  );
                }),
              ),
              h('div', { className: 'zt-plugin-version', title: '禅道 AI 工作台版本' }, PLUGIN_VERSION),
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
          { className: 'zt-main' },
          h(
            'div',
            { className: 'zt-main-head' },
            h(
              'div',
              { className: 'zt-tabs' },
              h(
                'button',
                { className: 'zt-tab' + (tab === 'story' ? ' zt-tab-active' : ''), onClick: () => setTab('story') },
                '研发需求',
                h('span', { className: 'zt-count' }, visibleStories.length),
              ),
              h(
                'button',
                { className: 'zt-tab' + (tab === 'bug' ? ' zt-tab-active' : ''), onClick: () => setTab('bug') },
                'BUG',
                h('span', { className: 'zt-count' }, visibleBugs.length),
              ),
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
                  title: onlyMine ? '暂无指派给我的' + (tab === 'bug' ? 'BUG' : '研发需求') : tab === 'bug' ? '暂无BUG' : '暂无研发需求',
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
                          width:
                            'max(100%, ' +
                            visibleColumns.reduce(
                              (sum, column) =>
                                sum + (column.virtual ? colWidths[column.key] || 72 : colWidths[column.key] || 80),
                              0,
                            ) +
                            'px)',
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
                      className: 'zt-icon-btn zt-bell-btn',
                      title: '指派提醒',
                      'aria-label': '指派提醒',
                      onClick: () => setAssignMenuOpen((v) => !v),
                    },
                    h(GlyphIcon, { name: 'bell', size: 16 }),
                    assignEvents.unread
                      ? h(
                          'span',
                          { className: 'zt-btn-badge' },
                          assignEvents.unread > 99 ? '99+' : String(assignEvents.unread),
                        )
                      : null,
                  ),
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
              assignMenuOpen ? renderAssignMenu() : null,
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
        assignToast
          ? h(
              'div',
              { className: 'zt-assign-toast' },
              h(
                'div',
                { className: 'zt-assign-toast-head' },
                h('span', null, '指派提醒' + (assignEvents.unread ? ' · ' + assignEvents.unread : '')),
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
                assignEvents.events.slice(0, 3).map((event) =>
                  h(
                    'div',
                    { key: event.id, className: 'zt-assign-toast-row' },
                    h('span', { className: 'zt-assign-kind' }, event.kind === 'story' ? '需求' : 'BUG'),
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
.zt-left{background:var(--dsw-specific-sidebar-fill,var(--td-bg-color-secondarycontainer))}
.zt-main{flex:1 1 0;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;background:#fff;container-type:inline-size}
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
.zt-plugin-version{flex:0 0 auto;padding:7px 16px 9px;border-top:1px solid var(--td-component-stroke);font-size:11px;line-height:16px;color:var(--td-text-color-placeholder);user-select:none}
.zt-tree-head{display:flex;align-items:center;gap:8px;flex:0 0 auto;height:28px;padding:0 16px;color:var(--td-text-color-placeholder);font-size:12px;line-height:20px}
.zt-tree-head-btn{display:inline-flex;align-items:center;gap:4px;min-width:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}
.zt-tree-head-btn:hover{color:var(--td-text-color-primary)}
.zt-tree-head-active{color:var(--td-text-color-secondary)}
.zt-tree-head-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-tree-head-arrow{display:inline-flex;color:var(--zt-icon-brand)}
.zt-tree-head-status{margin-left:auto;min-width:62px;justify-content:flex-end}
.zt-tree-row{display:flex;align-items:center;gap:8px;height:34px;padding:0 8px;border-radius:6px;cursor:pointer;user-select:none;min-width:0;overflow:hidden;transition:background-color .12s linear}
.zt-tree-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.zt-tree-project{font-weight:500}
.zt-tree-project .zt-name{color:var(--td-text-color-primary)}
.zt-tree-icon{display:inline-flex;align-items:center;justify-content:center;flex:0 0 18px;width:18px;height:18px;color:var(--zt-icon)}
.zt-tree-icon-open{color:var(--zt-icon-brand)}
.zt-tree-icon-folder{display:inline-flex;align-items:center;justify-content:center}
.zt-tree-icon-caret{display:none;align-items:center;justify-content:center;color:var(--zt-icon)}
.zt-tree-project:hover .zt-tree-icon-folder{display:none}
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
.zt-tabs{display:flex;align-items:stretch;gap:0;flex:0 0 auto;min-width:0;align-self:stretch;-webkit-app-region:no-drag}
.zt-tab{position:relative;display:inline-flex;align-items:center;gap:6px;height:48px;padding:0 16px;border:0;background:transparent;color:var(--td-text-color-secondary);cursor:pointer;font:var(--td-font-body-medium);white-space:nowrap;transition:background-color .2s linear}
.zt-tab:hover{background:var(--td-bg-color-container-hover)}
.zt-tab:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--td-brand-color-focus)}
.zt-tab-active{color:var(--td-brand-color);text-shadow:0 0 .3px currentcolor}
.zt-tab-active:after{content:'';position:absolute;left:12px;right:12px;bottom:0;height:3px;border-radius:var(--td-radius-small) var(--td-radius-small) 0 0;background:var(--td-brand-color)}
.zt-count{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:var(--zt-radius);background:var(--td-bg-color-secondarycontainer);color:var(--td-text-color-secondary);font:var(--td-font-body-small);font-size:12px;line-height:18px}
.zt-tab-active .zt-count{background:var(--td-brand-color-light);color:var(--td-brand-color)}
.zt-main-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0;flex:0 1 auto;padding:8px 0;margin-left:auto;-webkit-app-region:no-drag}
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
.zt-table td{height:44px;padding:0 8px;border-bottom:1px solid var(--td-component-border);color:var(--td-text-color-primary);vertical-align:middle;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-table tbody tr{cursor:grab;transition:background-color .2s linear}
.zt-table tbody tr:hover{background:var(--td-bg-color-container-hover)}
.zt-mono{font-family:var(--td-font-family-code);font-size:12px;color:var(--td-text-color-placeholder)}
.zt-title-cell a{color:var(--td-text-color-primary);text-decoration:none}
.zt-title-cell a:hover{color:var(--td-text-color-brand);text-decoration:underline}
.zt-cell-action{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:2px 6px;margin:-2px -6px;border:0;background:transparent;border-radius:var(--zt-radius);cursor:pointer;font:inherit;color:inherit;text-align:left;overflow:hidden}
.zt-cell-action:hover{background:var(--td-bg-color-container-hover)}
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
.zt-model-chip{display:inline-flex;align-items:center;gap:4px;height:26px;max-width:150px;min-width:0;padding:0 10px;border:0;border-radius:13px;background:var(--td-bg-color-container-hover);color:var(--td-text-color-secondary);font-size:12px;line-height:18px;cursor:pointer;transition:background-color .12s,color .12s;flex:0 1 auto}
.zt-model-chip:hover{color:var(--td-text-color-primary)}
.zt-model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zt-hint{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption,var(--td-text-color-placeholder))}
.zt-menu-backdrop{position:fixed;inset:0;z-index:39}
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
.zt-panel-badge{position:absolute;top:-4px;right:-5px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--td-error-color);color:#fff;font-size:9px;line-height:14px;text-align:center;font-weight:500;z-index:2}
.zt-bell-btn{position:relative}
.zt-btn-badge{position:absolute;top:1px;right:1px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--td-error-color);color:#fff;font-size:9px;line-height:14px;text-align:center;font-weight:500}
.zt-assign-menu{position:absolute;top:52px;right:8px;z-index:40;width:340px;max-width:calc(100% - 16px);max-height:min(440px,74vh);display:flex;flex-direction:column;background:var(--td-bg-color-container);border:1px solid var(--td-component-stroke);border-radius:10px;box-shadow:var(--td-shadow-3,0 6px 24px rgba(0,0,0,.12));overflow:hidden;-webkit-app-region:no-drag}
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
.zt-assign-toast{position:absolute;right:16px;top:56px;z-index:45;width:300px;max-width:calc(100% - 32px);display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:10px;background:var(--td-bg-color-container);border:1px solid var(--td-component-stroke);box-shadow:var(--td-shadow-3,0 6px 24px rgba(0,0,0,.12));-webkit-app-region:no-drag}
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
        unread
          ? h('span', { className: 'zt-panel-badge' }, unread > 99 ? '99+' : String(unread))
          : null,
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
