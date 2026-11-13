// Host half of the ZenTao AI workbench.
// Serves same-origin JSON/SSE endpoints for the browser panel and owns all
// ZenTao HTTP traffic plus DeepSeek model calls.

import os from 'node:os';
import path from 'node:path';
import { ZenTaoClient } from './lib/zentao.js';
import { createChatEngine } from './lib/chat.js';
import { createZenTaoTools } from './lib/tools.js';
import { createAssignmentWatcher } from './lib/assignments.js';
import { createUsageStore } from './lib/usage.js';
import { createZenTaoApi } from './lib/zentao-api.js';
import { parseDocument } from './lib/doc.js';
import { checkForUpdate, applyUpdate, applyUpdateBuffer } from './lib/update.js';

export const name = 'dsh-zentao';
/** Tools service is optional for the custom-chat mode but required for native mode. */
export const inject = ['tools'];

const ROUTE_PREFIX = '/zentao/api';
// Dashboard statistics fan out across projects/iterations; keep them warm.
const DASHBOARD_TTL = 5 * 60 * 1000;

const STATUS_OPTIONS = {
  project: [
    { key: 'doing', label: '进行中' },
    { key: 'suspended', label: '已挂起' },
    { key: 'closed', label: '已关闭' },
  ],
  execution: [
    { key: 'doing', label: '进行中' },
    { key: 'suspended', label: '已挂起' },
    { key: 'closed', label: '已关闭' },
  ],
  story: [
    { key: 'wait', label: '未开始' },
    { key: 'planned', label: '已计划' },
    { key: 'projected', label: '待开发' },
    { key: 'developing', label: '研发中' },
    { key: 'developed', label: '研发完毕' },
    { key: 'testing', label: '测试中' },
    { key: 'tested', label: '测试完毕' },
    { key: 'verified', label: '已验收' },
    { key: 'released', label: '已发布' },
    { key: 'closed', label: '已关闭' },
  ],
  bug: [
    { key: 'fixed', label: '已解决' },
    { key: 'bydesign', label: '设计如此' },
    { key: 'duplicate', label: '重复BUG' },
    { key: 'external', label: '外部原因' },
    { key: 'notrepro', label: '无法重现' },
    { key: 'postponed', label: '延期处理' },
    { key: 'willnotfix', label: '不予解决' },
  ],
};

export function apply(ctx, config = {}) {
  const client = new ZenTaoClient({
    baseUrl: config.baseUrl || 'http://127.0.0.1:8080',
    account: config.account || '',
    password: config.password || '',
  });
  // Default visibility of closed projects/iterations; the panel also has a
  // per-browser toggle, and the client only falls back to this default.
  const showClosed = config.showClosed !== false;
  // 'native' = chat in DeepSeek's own conversation window, ZenTao driven by tools;
  // 'custom' = the plugin's own three-pane chat panel (the previous behaviour).
  const chatMode = config.chatMode === 'custom' ? 'custom' : 'native';
  // Self-update manifest URL (see lib/update.js for the JSON shape).
  const updateUrl = String(config.updateUrl || '').trim();

  // Background "assigned to me" watcher. Read-only polling of the three
  // ZenTao "my" pages; disable with `assignmentWatch: false`.
  // Local iteration usage ranking: keeps the chat target picker's everyday
  // iterations at the top. Purely local; ZenTao is not modified.
  const zentaoApi = createZenTaoApi(client);

  const usageStore = createUsageStore({
    stateDir: path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'zentao'),
  });

  const assignmentWatcher =
    config.assignmentWatch === false
      ? null
      : createAssignmentWatcher({
          client,
          baseUrl: config.baseUrl || 'http://127.0.0.1:8080',
          intervalMs: Number(config.assignmentIntervalMs) || 60000,
          stateDir: path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'zentao'),
        });
  if (assignmentWatcher) {
    assignmentWatcher.start();
    ctx.effect(() => () => assignmentWatcher.stop());
  }

  const cache = new Map();
  let dashboardRefreshing = false;
  const cached = async (key, ttl, load) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = await load();
    cache.set(key, { at: Date.now(), value });
    return value;
  };
  const invalidate = (prefix) => {
    for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
  };

  // Warm the dashboard cache in the background so opening the app doesn't wait
  // for the full aggregation on every start (read-only, ~20 GET requests).
  setTimeout(() => {
    if (cache.has('dashboard')) return;
    client
      .dashboard()
      .then((data) => cache.set('dashboard', { at: Date.now(), value: data }))
      .catch(() => {});
  }, 1500).unref?.();

  const engine = createChatEngine({
    get llm() {
      return ctx.get('llm');
    },
    get selection() {
      const owner = ctx.get('agentDefaultModel');
      return owner && typeof owner.currentSelection === 'function' ? owner.currentSelection() : undefined;
    },
    zentao: client,
    statusOptions: STATUS_OPTIONS,
    usageRecord: (target) => usageStore.record(target),
    usageRank: () => usageStore.rank(),
    zentaoApi,
    createItem: (body) => createItem(client, body),
    createExecution: async (body) => {
      const result = await client.createExecution(body);
      if (result.ok) {
        // The new iteration must show up in the tree on the next refresh.
        invalidate('tree');
        invalidate('exec:');
        invalidate('items:');
      }
      return result;
    },
    changeStatus: (body) => changeStatus(client, body, STATUS_OPTIONS),
    createTask: async (body) => {
      const result = await client.createTask(body);
      invalidate('items:');
      invalidate('dashboard');
      invalidate('my-tasks');
      return result;
    },
  });

  // Expose the registered ZenTao capabilities to the native agent.
  const toolsService = ctx.get('tools');
  if (toolsService && typeof toolsService.register === 'function' && typeof client.projects === 'function') {
    try {
      const definitions = createZenTaoTools({
        client,
        statusOptions: STATUS_OPTIONS,
        changeStatus: (body) => changeStatus(client, body, STATUS_OPTIONS),
        createItem: (body) => createItem(client, body),
        invalidate,
      });
      for (const definition of definitions) toolsService.register(definition);
    } catch (error) {
      // Tools must never stop the panel from loading.
      console.warn('[zentao] tool registration failed:', error && error.message ? error.message : error);
    }
  }

  const readBody = (req, maxBytes = 2 * 1024 * 1024) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(new Error('payload too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  const json = (res, status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  };

  const fail = (res, error) => {
    const status = error && error.code === 'ZT_DENIED' ? 403 : 500;
    json(res, status, { ok: false, error: error?.message || String(error) });
  };

  async function meta(executionId, projectId, kind) {
    const productForm = `/story-create-0-0-0-0-${executionId || 0}.html`;
    const options = await client.formOptions(productForm);
    let assigned = options.assignedTo;
    if (!assigned || assigned.length === 0) {
      try {
        const bugOptions = await client.formOptions(`/bug-create-0-0-executionID=${executionId || 0}.html`);
        assigned = bugOptions.assignedTo || [];
      } catch (error) {
        assigned = [];
      }
    }
    // The create form can omit iteration members. Merge the explicit execution
    // team so new, empty iterations still offer the people working on them.
    if (executionId) {
      try {
        const members = await client.executionMembers(executionId);
        const all = new Map();
        for (const user of [...(assigned || []), ...members]) {
          if (user && user.value && user.value !== 'closed' && !all.has(String(user.value))) all.set(String(user.value), user);
        }
        assigned = [...all.values()];
      } catch (error) {
        /* keep create-form options when the team page is unavailable */
      }
    }
    const productId = Number((options.product.find((o) => o.selected) || options.product[0] || {}).value || 0);
    const priorities = [1, 2, 3, 4].map((n) => ({ value: String(n), label: 'P' + n }));
    const users = assigned
      .map((u) => ({ value: u.value, label: String(u.label || u.value).replace(/^[A-Za-z]:/, '') }))
      .filter((u) => u.value && u.value !== 'closed');
    return {
      executionId: Number(executionId) || 0,
      projectId: Number(projectId) || 0,
      kind,
      productId,
      products: options.product.map((p) => ({ value: Number(p.value), label: p.label })),
      modules: options.module
        .map((m) => ({ value: Number(m.value), label: m.label }))
        .filter((m) => m.value > 0),
      users,
      priorities,
    };
  }

  async function handle(req, res, url) {
    const path = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '');
    const method = req.method || 'GET';

    if (method === 'GET' && path === 'boot-url') {
      const connection = ctx.get('connection');
      let origin = 'http://127.0.0.1:1167';
      try {
        origin = ctx.get('webServer').getOrigin();
      } catch (error) {
        /* keep default */
      }
      const authenticated =
        connection && typeof connection.authenticatedUrl === 'function' ? connection.authenticatedUrl(origin) : origin;
      return json(res, 200, { ok: true, url: authenticated, origin });
    }

    if (method === 'GET' && path === 'config') {
      // Expose the signed-in identity so the list can highlight "my" items.
      let me = { account: config.account || '', realname: config.account || '' };
      try {
        me = await cached('me', 10 * 60 * 1000, async () => {
          try {
            const res = await client.get('/api.php/v1/users/' + encodeURIComponent(config.account || ''));
            const user = JSON.parse(res.text);
            return {
              account: String(user.account || config.account || ''),
              realname: String(user.realname || user.account || config.account || ''),
            };
          } catch (error) {
            return { account: config.account || '', realname: config.account || '' };
          }
        });
      } catch (error) {
        /* keep the account fallback */
      }
      return json(res, 200, { ok: true, chatMode, account: me.account, realname: me.realname });
    }

    if (method === 'GET' && path === 'assignments') {
      if (!assignmentWatcher) return json(res, 200, { ok: true, disabled: true, unread: 0, events: [], updatedAt: 0 });
      return json(res, 200, Object.assign({ ok: true }, assignmentWatcher.getSnapshot()));
    }

    if (method === 'POST' && path === 'assignments/read') {
      if (!assignmentWatcher) return json(res, 200, { ok: true, unread: 0, events: [], updatedAt: 0 });
      const body = JSON.parse((await readBody(req)) || '{}');
      const ids = body.all === true ? null : Array.isArray(body.ids) ? body.ids : [];
      const snapshot = await assignmentWatcher.markRead(ids);
      return json(res, 200, Object.assign({ ok: true }, snapshot));
    }

    if (method === 'POST' && path === 'assignments/check') {
      if (!assignmentWatcher) return json(res, 200, { ok: true, unread: 0, events: [], updatedAt: 0 });
      await assignmentWatcher.poll().catch(() => {});
      return json(res, 200, Object.assign({ ok: true }, assignmentWatcher.getSnapshot()));
    }

    if (method === 'GET' && path === 'tree') {
      const fresh = url.searchParams.get('fresh') === '1';
      const projects = fresh
        ? await client.projects()
        : await cached('tree', 20000, () => client.projects());
      if (fresh) cache.set('tree', { at: Date.now(), value: projects });
      return json(res, 200, { ok: true, projects, baseUrl: client.baseUrl, config: { showClosed } });
    }

    if (method === 'GET' && path === 'executions') {
      const projectId = Number(url.searchParams.get('projectId') || 0);
      if (!projectId) return json(res, 400, { ok: false, error: 'projectId required' });
      const fresh = url.searchParams.get('fresh') === '1';
      const executions = fresh
        ? await client.executions(projectId)
        : await cached(`exec:${projectId}`, 20000, () => client.executions(projectId));
      if (fresh) cache.set(`exec:${projectId}`, { at: Date.now(), value: executions });
      return json(res, 200, { ok: true, executions });
    }

    if (method === 'GET' && path === 'items') {
      const rawType = url.searchParams.get('type') || 'story';
      const type = ['story', 'bug', 'task', 'testtask', 'report'].includes(rawType) ? rawType : 'story';
      const executionId = Number(url.searchParams.get('executionId') || 0);
      if (!executionId) return json(res, 400, { ok: false, error: 'executionId required' });
      const fresh = url.searchParams.get('fresh') === '1';
      const loaders = {
        story: () => client.stories(executionId),
        bug: () => client.bugs(executionId),
        task: () => client.tasks(executionId),
        testtask: () => client.testTasks(executionId),
        report: () => client.testReports(executionId),
      };
      const load = loaders[type];
      const ttl = type === 'report' ? 5 * 60 * 1000 : type === 'story' || type === 'bug' ? 15000 : 20000;
      const items = fresh ? await load() : await cached(`items:${type}:${executionId}`, ttl, load);
      if (fresh) cache.set(`items:${type}:${executionId}`, { at: Date.now(), value: items });
      return json(res, 200, { ok: true, items, type });
    }

    if (method === 'GET' && path === 'dashboard') {
      const fresh = url.searchParams.get('fresh') === '1';
      try {
        // 仪表盘统计要并发读多个项目/迭代，耗时较长：优先返回已有快照，
        // 过期后在后台刷新（stale-while-revalidate），避免每次打开都等统计。
        if (!fresh) {
          const hit = cache.get('dashboard');
          if (hit) {
            if (Date.now() - hit.at > DASHBOARD_TTL && !dashboardRefreshing) {
              dashboardRefreshing = true;
              client
                .dashboard()
                .then((value) => cache.set('dashboard', { at: Date.now(), value }))
                .catch(() => {})
                .finally(() => {
                  dashboardRefreshing = false;
                });
            }
            return json(res, 200, { ok: true, dashboard: hit.value, cached: true });
          }
        }
        const data = await client.dashboard();
        cache.set('dashboard', { at: Date.now(), value: data });
        return json(res, 200, { ok: true, dashboard: data });
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'GET' && path === 'my-tasks') {
      try {
        const fresh = url.searchParams.get('fresh') === '1';
        const tasks = fresh ? await client.myTasks() : await cached('my-tasks', 60000, () => client.myTasks());
        if (fresh) cache.set('my-tasks', { at: Date.now(), value: tasks });
        return json(res, 200, { ok: true, tasks });
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'GET' && path === 'iterations') {
      try {
        const iterations = await cached('iterations', 5 * 60 * 1000, () => client.iterationsForUser());
        return json(res, 200, { ok: true, iterations });
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'GET' && path === 'iteration-users') {
      const executionId = Number(url.searchParams.get('executionId') || 0);
      if (!executionId) return json(res, 400, { ok: false, error: 'executionId required' });
      try {
        const users = await cached(`team:${executionId}`, 5 * 60 * 1000, () => client.taskTeam(executionId));
        return json(res, 200, { ok: true, users });
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'POST' && path === 'task-create') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const result = await client.createTask(body);
        invalidate('dashboard');
        invalidate('my-tasks');
        invalidate('items:');
        return json(res, 200, { ok: true, result });
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'POST' && path === 'update/import') {
      try {
        const body = JSON.parse((await readBody(req, 40 * 1024 * 1024)) || '{}');
        const data = String(body.data || '');
        if (!data) return json(res, 200, { ok: false, error: '更新包内容为空' });
        const result = await applyUpdateBuffer(Buffer.from(data, 'base64'));
        return json(res, 200, { ok: true, version: result.version, files: result.files, restartRequired: true });
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'GET' && path === 'update/check') {
      try {
        const info = await checkForUpdate({ updateUrl });
        return json(res, 200, { ok: true, update: info });
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'POST' && path === 'update/apply') {
      try {
        const info = await checkForUpdate({ updateUrl });
        if (!info.hasUpdate) {
          return json(res, 200, { ok: true, upToDate: true, version: info.current });
        }
        const result = await applyUpdate({ downloadUrl: info.downloadUrl, sha256: info.sha256 });
        return json(res, 200, { ok: true, version: result.version, files: result.files, restartRequired: true });
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'GET' && path === 'story-module-options') {
      const id = Number(url.searchParams.get('id') || 0);
      if (!id) return json(res, 400, { ok: false, error: 'id required' });
      try {
        const data = await client.storyModuleOptions(id);
        return json(res, 200, Object.assign({ ok: true }, data));
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'POST' && path === 'story-module') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const result = await client.setStoryModule(Number(body.id), Number(body.moduleId));
        invalidate('items:');
        invalidate('dashboard');
        return json(res, 200, { ok: true, result });
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'GET' && path === 'task-module-options') {
      const id = Number(url.searchParams.get('id') || 0);
      if (!id) return json(res, 400, { ok: false, error: 'id required' });
      try {
        const data = await client.taskModuleOptions(id);
        return json(res, 200, Object.assign({ ok: true }, data));
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'POST' && path === 'task-priority') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const result = await client.setTaskPriority(Number(body.id), Number(body.priority));
        invalidate('items:');
        invalidate('dashboard');
        invalidate('my-tasks');
        return json(res, 200, { ok: true, result });
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'POST' && path === 'task-module') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const result = await client.setTaskModule(Number(body.id), Number(body.moduleId));
        invalidate('items:');
        invalidate('dashboard');
        invalidate('my-tasks');
        return json(res, 200, { ok: true, result });
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'GET' && path === 'task-status-options') {
      const id = Number(url.searchParams.get('id') || 0);
      if (!id) return json(res, 400, { ok: false, error: 'id required' });
      try {
        const data = await client.taskStatusOptions(id);
        return json(res, 200, Object.assign({ ok: true }, data));
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'GET' && path === 'task-assign-options') {
      const id = Number(url.searchParams.get('id') || 0);
      if (!id) return json(res, 400, { ok: false, error: 'id required' });
      try {
        const data = await client.taskAssignOptions(id);
        return json(res, 200, Object.assign({ ok: true }, data));
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'POST' && path === 'task-status') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const result = await client.changeTaskStatus(Number(body.id), String(body.statusKey || ''));
        invalidate('items:');
        invalidate('dashboard');
        return json(res, 200, { ok: true, result });
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'POST' && path === 'task-assignee') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const result = await client.assignTask(Number(body.id), String(body.assignedTo || ''));
        invalidate('items:');
        invalidate('dashboard');
        return json(res, 200, { ok: true, result });
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'POST' && path === 'task-deadline') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const result = await client.setTaskDeadline(Number(body.id), String(body.deadline || ''));
        invalidate('items:');
        invalidate('dashboard');
        invalidate('my-tasks');
        return json(res, 200, { ok: true, result });
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'GET' && path === 'detail') {
      const type = url.searchParams.get('type') === 'bug' ? 'bug' : 'story';
      const id = Number(url.searchParams.get('id') || 0);
      if (!id) return json(res, 400, { ok: false, error: 'id required' });
      const detail = await cached(`detail:${type}:${id}`, 30000, () =>
        type === 'bug' ? client.bugDetail(id) : client.storyDetail(id),
      );
      return json(res, 200, { ok: true, detail, type });
    }

    if (method === 'GET' && path === 'meta') {
      const executionId = Number(url.searchParams.get('executionId') || 0);
      const projectId = Number(url.searchParams.get('projectId') || 0);
      const kind = url.searchParams.get('kind') === 'bug' ? 'bug' : 'story';
      const data = await meta(executionId, projectId, kind);
      return json(res, 200, { ok: true, meta: data, statusOptions: STATUS_OPTIONS });
    }

    if (method === 'GET' && path === 'status-options') {
      return json(res, 200, { ok: true, options: STATUS_OPTIONS });
    }

    if (method === 'GET' && path === 'story-status-options') {
      const id = Number(url.searchParams.get('id') || 0);
      if (!id) return json(res, 400, { ok: false, error: 'id required', options: [] });
      const options = await client.storyStatusOptions(id);
      return json(res, 200, { ok: true, options });
    }

    if (method === 'GET' && path === 'assign-options') {
      const type = url.searchParams.get('type') === 'bug' ? 'bug' : 'story';
      const id = Number(url.searchParams.get('id') || 0);
      if (!id) return json(res, 400, { ok: false, error: 'id required' });
      const data = await cached(`assign:${type}:${id}`, 30000, () => client.assignOptions(type, id));
      return json(res, 200, {
        ok: true,
        type,
        id,
        status: data.status,
        users: (data.users || []).filter((user) => user.value && user.value !== 'closed'),
      });
    }

    if (method === 'GET' && path === 'bug-module-options') {
      const id = Number(url.searchParams.get('id') || 0);
      if (!id) return json(res, 400, { ok: false, error: 'id required', modules: [] });
      const modules = await client.bugModuleOptions(id);
      return json(res, 200, { ok: true, id, modules });
    }

    if (method === 'POST' && path === 'assignee') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const type = body.type === 'bug' ? 'bug' : 'story';
      const id = Number(body.id || 0);
      if (!id) return json(res, 400, { ok: false, error: 'id required' });
      const result = await client.assignItem(type, id, body.assignedTo);
      if (result.ok) {
        invalidate('items:');
        invalidate(`assign:${type}:${id}`);
        invalidate('tree');
      }
      return json(res, 200, result);
    }

    if (method === 'POST' && path === 'bug-module') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const id = Number(body.id || 0);
      const moduleId = Number(body.moduleId);
      if (!id || !Number.isInteger(moduleId) || moduleId < 0) {
        return json(res, 400, { ok: false, error: 'id and moduleId required' });
      }
      const result = await client.changeBugModule(id, moduleId);
      if (result.ok) {
        invalidate('items:');
        invalidate('tree');
      }
      return json(res, 200, result);
    }

    if (method === 'GET' && path === 'models') {
      const llm = ctx.get('llm');
      if (!llm || typeof llm.listProviders !== 'function') {
        return json(res, 200, { ok: false, error: '模型服务不可用' });
      }
      try {
        const groups = [];
        for (const provider of llm.listProviders()) {
          let models = [];
          try {
            models = await llm.listModels(provider.id);
          } catch (error) {
            models = [];
          }
          if (!models.length) continue;
          groups.push({
            provider: provider.id,
            label: provider.name || provider.id,
            models: models.map((model) => ({ id: model.id, name: model.name, description: model.description || '' })),
          });
        }
        const current = ctx.get('agentDefaultModel')?.currentSelection?.() || null;
        const currentName = current
          ? (() => {
              for (const group of groups) {
                const hit = group.models.find((model) => model.id === current.model && group.provider === current.provider);
                if (hit) return hit.name;
              }
              return current.model;
            })()
          : '';
        return json(res, 200, { ok: true, current, currentName, groups });
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'POST' && path === 'model') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const service = ctx.get('agentDefaultModel');
      if (!service || typeof service.saveSelection !== 'function') {
        return json(res, 200, { ok: false, error: '当前部署不支持切换默认模型' });
      }
      try {
        const current = service.currentSelection ? service.currentSelection() : {};
        await service.saveSelection({
          provider: String(body.provider || ''),
          model: String(body.model || ''),
          ...current && current.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {},
        });
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'POST' && path === 'doc/parse') {
      try {
        const body = JSON.parse((await readBody(req, 12 * 1024 * 1024)) || '{}');
        const parsed = parseDocument(body.name, body.base64);
        return json(res, 200, {
          ok: true,
          name: String(body.name || ''),
          format: parsed.format,
          count: parsed.items.length,
          items: parsed.items,
        });
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'POST' && path === 'transcribe') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const service = ctx.get('speechToText');
      if (!service || typeof service.transcribe !== 'function') {
        return json(res, 200, { ok: false, error: '语音识别服务未启用（需要安装 SenseVoice 语音包）' });
      }
      try {
        const providers = service.listProviders ? service.listProviders() : [];
        if (!providers.length) return json(res, 200, { ok: false, error: '没有可用的语音识别提供方' });
        const bytes = Buffer.from(String(body.audioBase64 || ''), 'base64');
        if (!bytes.length) return json(res, 200, { ok: false, error: '音频为空' });
        const resolved = service.resolve({ audio: bytes });
        const result = await service.transcribe(resolved, AbortSignal.timeout(120000));
        return json(res, 200, { ok: true, text: String((result && result.text) || '') });
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (method === 'POST' && path === 'create') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = await createItem(client, body);
      invalidate('items:');
      invalidate('tree');
      return json(res, 200, result);
    }

    if (method === 'POST' && path === 'status') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = await changeStatus(client, body, STATUS_OPTIONS);
      invalidate('items:');
      invalidate('tree');
      invalidate('exec:');
      return json(res, 200, { ...result, targetType: body.targetType, id: Number(body.id || 0), key: body.statusKey });
    }

    if (method === 'POST' && path === 'chat') {
      const body = JSON.parse((await readBody(req, 20 * 1024 * 1024)) || '{}');
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const emit = (event) => {
        res.write('data: ' + JSON.stringify(event) + '\n\n');
      };
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
      try {
        await engine.handle(body, emit);
      } catch (error) {
        emit({ type: 'error', message: error?.message || String(error) });
      } finally {
        clearInterval(keepAlive);
        res.end();
      }
      return;
    }

    return json(res, 404, { ok: false, error: 'unknown endpoint' });
  }

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      return scope.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          if (req.headers['x-zentao-client'] !== '1') {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end('{"ok":false,"error":"forbidden"}');
            return;
          }
          let url;
          try {
            url = new URL(req.url || '/', 'http://127.0.0.1');
          } catch {
            res.writeHead(400);
            res.end();
            return;
          }
          try {
            await handle(req, res, url);
          } catch (error) {
            if (!res.headersSent) fail(res, error);
            else res.end();
          }
        },
      });
    });
  });
}
async function createItem(client, body) {
  const kind = body.kind;
  if (kind === 'story') {
    const result = await client.createStory({
      productId: Number(body.productId),
      projectId: Number(body.projectId || 0),
      executionId: Number(body.executionId || 0),
      title: body.title,
      description: body.description || '',
      acceptance: body.acceptance || '',
      priority: Number(body.priority || 3),
      moduleId: Number(body.moduleId || 0),
      assignedTo: body.assignedTo || '',
    });
    const id = result.id || (await findLatestId(() => client.stories(Number(body.executionId) || 0), body.title));
    return { ...result, id, kind, name: body.title, url: id ? `/projectstory-view-${id}.html` : '' };
  }
  if (kind === 'bug') {
    const result = await client.createBug({
      productId: Number(body.productId),
      projectId: Number(body.projectId || 0),
      executionId: Number(body.executionId || 0),
      title: body.title,
      steps: body.steps || body.description || '',
      priority: Number(body.priority || 3),
      severity: Number(body.severity || 3),
      moduleId: Number(body.moduleId || 0),
      assignedTo: body.assignedTo || '',
      openedBuild: body.openedBuild || 'trunk',
    });
    const id = result.id || (await findLatestId(() => client.bugs(Number(body.executionId) || 0), body.title));
    return { ...result, id, kind, name: body.title, url: id ? `/bug-view-${id}.html` : '' };
  }
  if (kind === 'testcase') {
    const created = [];
    for (const item of body.cases || []) {
      const result = await client.createTestcase({
        productId: Number(body.productId),
        storyId: Number(body.storyId || 0),
        moduleId: Number(body.moduleId || 0),
        title: item.title,
        precondition: item.precondition || '',
        steps: item.steps || [],
        priority: Number(item.priority || 3),
        type: item.type || 'feature',
      });
      if (!result.ok) return { ok: false, error: result.message, created, kind };
      created.push({ title: item.title, ok: true, message: result.message });
    }
    return { ok: created.length > 0, kind, created, message: `已创建 ${created.length} 条用例` };
  }
  return { ok: false, error: 'unknown kind' };
}

async function changeStatus(client, body, statusOptions) {
  const targetType = body.targetType;
  const id = Number(body.id);
  const key = body.statusKey;
  const options =
    targetType === 'storyStatus'
      ? [
          { key: 'closed', label: '关闭需求' },
          { key: 'active', label: '激活需求' },
        ]
      : statusOptions[targetType] || [];
  const option = options.find((o) => o.key === key);
  if (!option) return { ok: false, error: '目标状态不存在', options };

  if (targetType === 'story') {
    const result = await client.changeStoryStage([id], key);
    return { ...result, targetType, id, label: option.label };
  }
  if (targetType === 'storyStatus') {
    const result = await client.changeStoryStatus(id, key);
    return { ...result, targetType, id, label: option.label };
  }
  if (targetType === 'bug') {
    const result = await client.resolveBug(id, key);
    return { ...result, targetType, id, label: option.label };
  }
  if (targetType === 'project' || targetType === 'execution') {
    const current = String(body.current || '');
    const action =
      key === 'closed'
        ? 'close'
        : key === 'suspended'
          ? 'suspend'
          : /未开始|wait/i.test(current)
            ? 'start'
            : 'activate';
    const result =
      targetType === 'project'
        ? await client.changeProjectStatus(id, action)
        : await client.changeExecutionStatus(id, action);
    return { ...result, targetType, id, label: option.label };
  }
  return { ok: false, error: '不支持的对象类型' };
}

async function findLatestId(listFn, title) {
  try {
    const list = await listFn();
    const matches = list.filter((item) => item.title === title).sort((a, b) => b.id - a.id);
    return matches.length ? matches[0].id : null;
  } catch (error) {
    return null;
  }
}
