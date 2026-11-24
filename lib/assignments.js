// Background watcher for ZenTao's "assigned to me" lists.
//
// Polls the three "my" pages (bugs / stories / tasks), diffs them against a
// persisted snapshot and produces notification events for:
//   - a work item that newly appeared in one of my lists (new assignment)
//   - a work item whose status/resolution/stage changed since the last poll
//   - a work item that dropped out of my list (resolved / reassigned away)
//
// Only read requests are issued to ZenTao. State lives in
// `$DSH_HOME/zentao/assignments.json` so restarts keep their history.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const LIST_PATHS = [
  ['bug', '/my-bug.html'],
  ['story', '/my-story.html'],
];

let seq = 0;

function cellTexts(rowHtml) {
  const cells = [];
  for (const match of rowHtml.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)) {
    const cls = (match[1].match(/class="([^"]*)"/) || [])[1] || '';
    const text = match[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    cells.push({ cls, text });
  }
  return cells;
}

/**
 * Parse one "my work" HTML page into normalized items.
 * @param kind - 'bug' | 'story'
 * @param html - page HTML
 * @param baseUrl - ZenTao base url used for deep links
 * @returns normalized items with a signature used to detect changes
 */
export function parseMyWorkPage(kind, html, baseUrl) {
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbody) return [];
  const items = [];
  for (const row of tbody[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = cellTexts(row[1]);
    if (!cells.length) continue;
    const id = (cells[0] && cells[0].text.match(/^\d+$/) ? cells[0].text : '').replace(/^0+(?=\d)/, '');
    if (!id) continue;
    if (kind === 'bug') {
      // ID | 级别 | P | 确认 | Bug标题 | 所属产品 | 类型 | 创建 | 解决 | 方案 | 操作
      const item = {
        kind,
        id,
        title: cells[4] ? cells[4].text : '',
        product: cells[5] ? cells[5].text : '',
        openedBy: cells[7] ? cells[7].text : '',
        resolvedBy: cells[8] ? cells[8].text : '',
        resolution: cells[9] ? cells[9].text : '',
        url: `${baseUrl}/bug-view-${id}.html`,
      };
      item.statusText = item.resolution || (cells[3] && cells[3].text === '是' ? '已确认' : '未解决');
      item.signature = [item.statusText, item.resolvedBy, item.openedBy].join('|');
      items.push(item);
    } else {
      // ID | P | 标题 | 所属产品 | 模块 | 创建 | 预计 | 阶段 | 状态 | 操作
      const item = {
        kind,
        id,
        title: cells[2] ? cells[2].text : '',
        product: cells[3] ? cells[3].text : '',
        openedBy: cells[5] ? cells[5].text : '',
        stage: cells[7] ? cells[7].text : '',
        status: cells[8] ? cells[8].text : '',
        url: `${baseUrl}/story-view-${id}.html`,
      };
      item.statusText = [item.stage, item.status].filter(Boolean).join(' / ') || '—';
      item.signature = [item.stage, item.status].join('|');
      items.push(item);
    }
  }
  return items;
}

/**
 * Poll the "my" pages, diff against persisted state and cache events.
 * @param deps - watcher dependencies.
 * @param deps.client - ZenTaoClient used for the (read-only) page reads.
 * @param deps.baseUrl - ZenTao base url for deep links.
 * @param deps.stateDir - directory that stores the snapshot file.
 * @param deps.intervalMs - polling period; defaults to 60s.
 * @param deps.maxEvents - retained event history; defaults to 50.
 * @returns watcher with start/stop/poll/snapshot/markRead.
 */
export function createAssignmentWatcher(deps) {
  const { client } = deps;
  let baseUrl = String(deps.baseUrl || '');
  const intervalMs = Math.max(15000, Number(deps.intervalMs) || 60000);
  const stateDir = deps.stateDir || path.join(os.homedir(), '.dsh', 'zentao');
  const statePath = path.join(stateDir, 'assignments.json');
  const maxEvents = Math.max(10, Number(deps.maxEvents) || 50);
  const snapshot = {
    initialized: false,
    updatedAt: 0,
    unread: 0,
    events: [],
    seen: {},
  };
  let timer = null;
  let polling = false;
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(await readFile(statePath, 'utf8'));
      if (raw && typeof raw === 'object') {
        snapshot.initialized = raw.initialized === true;
        snapshot.updatedAt = Number(raw.updatedAt) || 0;
        snapshot.seen = raw.seen && typeof raw.seen === 'object' ? raw.seen : {};
        const events = Array.isArray(raw.events) ? raw.events : [];
        snapshot.events = events
          .filter((event) => event && event.id && event.kind)
          .map((event) => ({
            id: String(event.id),
            kind: String(event.kind),
            itemId: String(event.itemId || ''),
            title: String(event.title || ''),
            product: String(event.product || ''),
            change: event.change === 'status' ? 'status' : event.change === 'gone' ? 'gone' : 'assigned',
            statusText: String(event.statusText || ''),
            openedBy: String(event.openedBy || ''),
            url: String(event.url || ''),
            at: Number(event.at) || Date.now(),
            read: event.read === true,
          }));
        snapshot.unread = snapshot.events.filter((event) => !event.read).length;
      }
    } catch (error) {
      // first run or unreadable file: start from a clean snapshot
    }
  }

  async function save() {
    try {
      await mkdir(stateDir, { recursive: true });
      const body = JSON.stringify(
        {
          version: 1,
          initialized: snapshot.initialized,
          updatedAt: snapshot.updatedAt,
          seen: snapshot.seen,
          events: snapshot.events,
        },
        null,
        2,
      );
      const tmp = statePath + '.tmp';
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, statePath);
    } catch (error) {
      // persistence failure must never break polling
    }
  }

  function makeEvent(item, change) {
    seq += 1;
    return {
      id: `${change}-${item.kind}-${item.id}-${Date.now().toString(36)}-${seq}`,
      kind: item.kind,
      itemId: String(item.id),
      title: item.title,
      product: item.product,
      change,
      statusText: item.statusText || '',
      openedBy: item.openedBy || '',
      url: item.url || '',
      at: Date.now(),
      read: false,
    };
  }

  async function loadTaskItems() {
    if (typeof client.myTasks !== 'function') return [];
    try {
      const tasks = await client.myTasks();
      return (Array.isArray(tasks) ? tasks : []).map((task) => ({
        kind: 'task',
        id: String(task.id),
        title: task.title || '',
        product: '',
        openedBy: '',
        statusText: task.statusText || '',
        assignedDate: task.assignedDate || '',
        url: baseUrl + (task.url || '/task-view-' + task.id + '.html'),
        signature: [task.statusText, task.deadline || '', task.assignedTo || ''].join('|'),
      }));
    } catch (error) {
      return [];
    }
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      await load();
      const pagesPromise = Promise.all(
        LIST_PATHS.map(async ([kind, pagePath]) => {
          try {
            const res = await client.get(pagePath);
            return { kind, items: parseMyWorkPage(kind, res.text, baseUrl) };
          } catch (error) {
            return { kind, items: [] };
          }
        }),
      );
      const [pages, taskItems] = await Promise.all([pagesPromise, loadTaskItems()]);
      const items = pages.flatMap((page) => page.items).concat(taskItems);
      const byKey = new Map();
      for (const item of items) byKey.set(`${item.kind}:${item.id}`, item);

      // First successful poll only establishes the baseline; it must not
      // replay every existing assignment as a notification.
      // Tasks were added to the watcher later: old snapshots have no task keys.
      // Seed historical tasks silently, but keep tasks assigned today unseen so
      // they surface as a notification on the first run after the upgrade.
      if (snapshot.initialized && !Object.keys(snapshot.seen).some((key) => key.startsWith('task:'))) {
        const today = new Date().toISOString().slice(0, 10);
        for (const item of taskItems) {
          const assignedDay = String(item.assignedDate || '').slice(0, 10);
          if (assignedDay && assignedDay >= today) continue;
          snapshot.seen['task:' + item.id] = { sig: item.signature, at: Date.now() };
        }
      }

      if (!snapshot.initialized) {
        const seen = {};
        for (const item of items) seen[`${item.kind}:${item.id}`] = { sig: item.signature, at: Date.now() };
        snapshot.seen = seen;
        snapshot.initialized = true;
        snapshot.updatedAt = Date.now();
        await save();
        return;
      }

      const events = [];
      for (const [key, item] of byKey) {
        const prev = snapshot.seen[key];
        if (!prev) {
          events.push(makeEvent(item, 'assigned'));
        } else if (prev.sig !== item.signature) {
          events.push(makeEvent(item, 'status'));
        }
        snapshot.seen[key] = { sig: item.signature, at: Date.now() };
      }
      // Items that left my lists were resolved or reassigned away.
      for (const [key, prev] of Object.entries(snapshot.seen)) {
        if (byKey.has(key)) continue;
        const [kind, id] = key.split(':');
        events.push(
          makeEvent({ kind, id, title: prev.title || '', product: prev.product || '', statusText: '已离开我的列表' }, 'gone'),
        );
        delete snapshot.seen[key];
      }
      if (events.length) {
        snapshot.events = events.concat(snapshot.events).slice(0, maxEvents);
        snapshot.unread = snapshot.events.filter((event) => !event.read).length;
      }
      snapshot.updatedAt = Date.now();
      await save();
    } catch (error) {
      // keep the loop alive; a transient ZenTao failure retries next tick
    } finally {
      polling = false;
    }
  }

  function getSnapshot() {
    return {
      initialized: snapshot.initialized,
      updatedAt: snapshot.updatedAt,
      unread: snapshot.unread,
      events: snapshot.events.slice(),
    };
  }

  async function markRead(ids) {
    await load();
    const wanted = Array.isArray(ids) ? new Set(ids.map(String)) : null;
    let changed = false;
    for (const event of snapshot.events) {
      if (wanted === null || wanted.has(event.id)) {
        if (!event.read) {
          event.read = true;
          changed = true;
        }
      }
    }
    if (changed) {
      snapshot.unread = snapshot.events.filter((event) => !event.read).length;
      await save();
    }
    return getSnapshot();
  }

  async function deleteEvents(ids) {
    await load();
    const wanted = Array.isArray(ids) ? new Set(ids.map(String)) : null;
    if (wanted) {
      const before = snapshot.events.length;
      snapshot.events = snapshot.events.filter((event) => !wanted.has(event.id));
      if (snapshot.events.length !== before) {
        snapshot.unread = snapshot.events.filter((event) => !event.read).length;
        await save();
      }
    }
    return getSnapshot();
  }

  function start() {
    if (timer) return;
    load().then(() => poll()).catch(() => {});
    timer = setInterval(() => {
      poll().catch(() => {});
    }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function setBaseUrl(next) {
    if (next) baseUrl = String(next);
  }

  return { start, stop, poll, getSnapshot, markRead, deleteEvents, setBaseUrl, statePath };
}
