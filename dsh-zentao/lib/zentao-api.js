// Generic read-only access to ZenTao's REST API v1.
//
// The chat planner never calls URLs freely: it must pick a path from the
// catalog below, which is filled with the ids already known from the tree
// selection / contexts. Executing a plan only issues GET requests — write
// endpoints stay out of scope until they are deliberately enabled.

/** Read-only capability catalog. `{name}` placeholders are filled from context. */
export const API_CATALOG = [
  { id: 'programs.list', label: '项目集列表', path: 'programs' },
  { id: 'products.list', label: '产品列表', path: 'products' },
  { id: 'products.detail', label: '产品详情', path: 'products/{productId}', requires: ['productId'] },
  { id: 'projects.list', label: '项目列表', path: 'projects' },
  { id: 'projects.detail', label: '项目详情', path: 'projects/{projectId}', requires: ['projectId'] },
  { id: 'executions.list', label: '迭代列表', path: 'executions' },
  { id: 'executions.detail', label: '迭代详情', path: 'executions/{executionId}', requires: ['executionId'] },
  { id: 'users.list', label: '用户列表', path: 'users' },
  { id: 'users.detail', label: '用户详情', path: 'users/{account}', requires: ['account'] },
  { id: 'testtasks.list', label: '测试单列表', path: 'testtasks' },
  { id: 'stories.byProduct', label: '某产品下的研发需求', path: 'products/{productId}/stories', requires: ['productId'] },
  { id: 'bugs.byProduct', label: '某产品下的 BUG', path: 'products/{productId}/bugs', requires: ['productId'] },
  { id: 'plans.byProduct', label: '某产品下的计划', path: 'products/{productId}/plans', requires: ['productId'] },
  { id: 'testcases.byProduct', label: '某产品下的测试用例', path: 'products/{productId}/testcases', requires: ['productId'] },
  { id: 'builds.byProject', label: '某项目下的构建', path: 'projects/{projectId}/builds', requires: ['projectId'] },
  { id: 'releases.byProject', label: '某项目下的发布', path: 'projects/{projectId}/releases', requires: ['projectId'] },
  { id: 'executions.byProject', label: '某项目下的迭代', path: 'projects/{projectId}/executions', requires: ['projectId'] },
  { id: 'bugs.byProject', label: '某项目下的 BUG', path: 'projects/{projectId}/bugs', requires: ['projectId'] },
  { id: 'stories.byProject', label: '某项目下的研发需求', path: 'projects/{projectId}/stories', requires: ['projectId'] },
  { id: 'stories.byExecution', label: '某迭代下的研发需求', path: 'executions/{executionId}/stories', requires: ['executionId'] },
  { id: 'bugs.byExecution', label: '某迭代下的 BUG', path: 'executions/{executionId}/bugs', requires: ['executionId'] },
  { id: 'tasks.byExecution', label: '某迭代下的任务', path: 'executions/{executionId}/tasks', requires: ['executionId'] },
];

/** Human-readable catalog for the planner prompt. */
export function catalogText() {
  return API_CATALOG.map(
    (entry) => `- ${entry.path}${entry.requires ? '（需要：' + entry.requires.join('、') + '）' : ''} — ${entry.label}`,
  ).join('\n');
}

/**
 * Validate a planned path against the catalog (no free-form URLs).
 * @param path - candidate path relative to /api.php/v1/
 * @returns the matched catalog entry, or null.
 */
export function matchCatalogPath(path) {
  const clean = String(path || '').replace(/^\/+/, '').replace(/^api\.php\/v1\//, '').replace(/\/+$/, '');
  for (const entry of API_CATALOG) {
    const pattern =
      '^' +
      entry.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[a-zA-Z]+\\\}/g, '[^/]+') +
      '$';
    if (new RegExp(pattern).test(clean)) return entry;
  }
  return null;
}

/** Fill `{name}` placeholders from the available ids. */
export function fillPath(path, ids) {
  let missing = [];
  const filled = String(path || '').replace(/\{([a-zA-Z]+)\}/g, (_match, name) => {
    const value = ids && ids[name];
    if (value === undefined || value === null || value === '') {
      missing.push(name);
      return '{' + name + '}';
    }
    return String(value);
  });
  return { path: filled, missing };
}

const STATUS_LABELS = {
  normal: '正常',
  doing: '进行中',
  wait: '未开始',
  suspended: '已挂起',
  closed: '已关闭',
  active: '激活',
  resolved: '已解决',
  fixed: '已修复',
  tested: '已测试',
  done: '已完成',
  pause: '已暂停',
  bydesign: '设计如此',
  notrepro: '无法重现',
  duplicate: '重复',
  postponed: '延期',
  willnotfix: '不予解决',
};

function summarizePayload(payload) {
  if (!payload || typeof payload !== 'object') return { total: 0, items: [] };
  const listKey = ['projects', 'products', 'programs', 'executions', 'stories', 'bugs', 'tasks', 'testtasks', 'plans', 'testcases', 'builds', 'releases', 'users'].find(
    (key) => Array.isArray(payload[key]),
  );
  if (!listKey) {
    return { total: 0, items: [], detail: payload };
  }
  const rows = payload[listKey].slice(0, 10).map((item) => {
    const label =
      item.title || item.name || item.realname || item.account || item.id;
    const extra = item.status || item.statusText || item.stage || item.resolution || '';
    const extraText = STATUS_LABELS[String(extra)] || String(extra || '');
    return { id: item.id, label: String(label || ''), extra: extraText };
  });
  return { total: Number(payload.total) || payload[listKey].length, items: rows, detail: null, listKey };
}

/**
 * @param client - ZenTaoClient (session login already handled by get()).
 * @returns executor bound to the catalog + path validation.
 */
export function createZenTaoApi(client) {
  return {
    catalog: catalogText,
    match: matchCatalogPath,
    async run(request) {
      const path = String((request && request.path) || '');
      const entry = matchCatalogPath(path);
      if (!entry) {
        return {
          ok: false,
          error: '接口不在允许的清单里',
          suggestion: '我只能查询产品、项目、迭代、需求、BUG、任务、用例、计划、构建、发布、用户等列表/详情。',
        };
      }
      try {
        const res = await client.get('/api.php/v1/' + path.replace(/^\/+/, ''));
        let payload = null;
        try {
          payload = JSON.parse(res.text);
        } catch (error) {
          return { ok: false, error: '禅道返回的不是 JSON，接口可能不存在', suggestion: '换个查询条件或资源再试。' };
        }
        const summary = summarizePayload(payload);
        return {
          ok: true,
          entry,
          path,
          total: summary.total,
          items: summary.items,
          detail: summary.detail,
        };
      } catch (error) {
        const message = String(error && error.message ? error.message : error);
        let suggestion = '请换个查询条件，或告诉我要查的产品/项目/迭代。';
        if (/404/.test(message)) suggestion = '这个接口或路径当前不可用；可以改查列表接口。';
        if (/400/.test(message)) suggestion = '缺少必要参数（常见是产品 ID、项目 ID 或迭代 ID），补充后再试。';
        return { ok: false, error: message, suggestion };
      }
    },
  };
}
