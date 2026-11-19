// ZenTao 16.x HTML adapter (session login + PATH_INFO pages + form posts).
// No external deps; runs in the DSH Host (Node >= 18).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

export function decodeEntities(input) {
  if (!input) return '';
  return input
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/g, (m) => ENTITIES[m] ?? m);
}

export function stripHtml(html) {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cellClass(attrs) {
  const m = attrs.match(/class=['"]([^'"]*)['"]/);
  return m ? m[1].trim() : '';
}

export function parseRows(html) {
  const rows = [];
  const trRe = /<tr([^>]*)>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html))) {
    const attrs = m[1];
    const body = m[2];
    const idMatch = attrs.match(/data-id=['"](\d+)['"]/);
    const cells = [];
    const tdRe = /<td([^>]*)>([\s\S]*?)<\/td>/gi;
    let c;
    while ((c = tdRe.exec(body))) {
      cells.push({ cls: cellClass(c[1]), html: c[2], text: stripHtml(c[2]) });
    }
    if (!idMatch && !cells.length) continue;
    rows.push({ id: idMatch ? Number(idMatch[1]) : null, cells });
  }
  return rows;
}

function byClass(row, prefix) {
  return row.cells.find((cell) => cell.cls.split(/\s+/).some((c) => c === prefix || c.startsWith(prefix + ' ')))
    || row.cells.find((cell) => cell.cls.split(/\s+/).some((c) => c === prefix))
    || row.cells.find((cell) => cell.cls.includes(prefix));
}

function listIdFromCell(cell) {
  const m = cell && cell.html.match(/name='(?:projectIdList|storyIdList|bugIdList|taskIdList)\[\]'\s+value='(\d+)'/);
  if (m) return Number(m[1]);
  const n = cell && cell.text.match(/\d+/);
  return n ? Number(n[0]) : null;
}

function two(n) {
  return String(n).padStart(2, '0');
}

function isoDate(date) {
  return date.getFullYear() + '-' + two(date.getMonth() + 1) + '-' + two(date.getDate());
}

function todayIso() {
  return isoDate(new Date());
}

function addDaysIso(iso, days) {
  const date = new Date(iso + 'T00:00:00');
  date.setDate(date.getDate() + Number(days || 0));
  return isoDate(date);
}

/** Weekdays between two ISO dates, inclusive (ZenTao's "可用工作日"). */
function workingDays(begin, end) {
  const start = new Date(begin + 'T00:00:00');
  const stop = new Date(end + 'T00:00:00');
  let count = 0;
  for (let d = new Date(start); d <= stop; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return Math.max(1, count);
}

/** ZenTao requires a code; derive an ASCII-safe one from the name. */
function codeForName(name) {
  const slug = String(name || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'exec-' + todayIso().replace(/-/g, '');
}

/** ZenTao task status labels. */
const TASK_STATUS_TEXT = {
  wait: '未开始',
  doing: '进行中',
  done: '已完成',
  pause: '已暂停',
  cancel: '已取消',
  closed: '已关闭',
};

/** Form fields of a ZenTao HTML form page, keyed by input name. */
function parseFormFields(html) {
  const fields = {};
  for (const match of String(html || '').matchAll(/<input([^>]*)>/gi)) {
    const name = attrValue(match[1], 'name');
    if (!name || /^(submit|reset|button)$/i.test(attrValue(match[1], 'type'))) continue;
    const type = attrValue(match[1], 'type').toLowerCase();
    if (type === 'file' || type === 'checkbox' || type === 'radio') continue;
    fields[name] = attrValue(match[1], 'value');
  }
  for (const match of String(html || '').matchAll(/<textarea[^>]*name=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/textarea>/gi)) {
    fields[match[1]] = decodeEntities(stripHtml(match[2])).trim();
  }
  for (const match of String(html || '').matchAll(/<select[^>]*name=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/select>/gi)) {
    const selected = [...match[2].matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/gi)].find((option) => /selected/i.test(option[1])) || [...match[2].matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/gi)][0];
    if (selected) fields[match[1]] = attrValue(selected[1], 'value');
  }
  return fields;
}

/** Options of one <select name=...> on a ZenTao form page. */
function selectOptions(html, name) {
  const re = new RegExp(`<select[^>]*name=['"]${name}['"][^>]*>([\\s\\S]*?)<\\/select>`, 'i');
  const m = html.match(re);
  if (!m) return [];
  return [...m[1].matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/gi)].map((option) => ({
    value: (option[1].match(/value=['"]([^'"]*)['"]/) || [])[1] || '',
    label: stripHtml(option[2]).trim(),
  }));
}

function attrValue(attrs, name) {
  const match = String(attrs || '').match(new RegExp(`\\b${name}\\s*=\\s*['"]([^'"]*)['"]`, 'i'));
  return match ? decodeEntities(match[1]) : '';
}

/**
 * Replays the current BUG edit form when changing one small field. ZenTao's
 * edit endpoint accepts a normal full form post, rather than a module-only
 * endpoint; retaining its existing values prevents an unrelated BUG field
 * from being blanked by the update.
 */
function editFormValues(html) {
  const form = new URLSearchParams();
  const append = (name, value) => {
    if (name) form.append(name, decodeEntities(String(value || '')));
  };
  for (const match of String(html || '').matchAll(/<input([^>]*)>/gi)) {
    const attrs = match[1];
    const name = attrValue(attrs, 'name');
    const type = (attrValue(attrs, 'type') || 'text').toLowerCase();
    if (!name || ['button', 'submit', 'reset', 'image', 'file'].includes(type)) continue;
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(attrs)) continue;
    append(name, attrValue(attrs, 'value'));
  }
  for (const match of String(html || '').matchAll(/<textarea([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    append(attrValue(match[1], 'name'), match[2]);
  }
  for (const match of String(html || '').matchAll(/<select([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = attrValue(match[1], 'name');
    if (!name) continue;
    const options = [...match[2].matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/gi)];
    const selected = options.filter((option) => /\bselected\b/i.test(option[1]));
    for (const option of selected.length ? selected : options.slice(0, 1)) append(name, attrValue(option[1], 'value'));
  }
  return form;
}

const STATUS_MAP = {
  '未开始': 'wait',
  '进行中': 'doing',
  '已挂起': 'suspended',
  '已关闭': 'closed',
  '已延期': 'delayed',
  '激活': 'active',
  '已解决': 'resolved',
  '已变更': 'changed',
  '待开发': 'wait',
  '研发中': 'developing',
  '研发完毕': 'developed',
  '测试中': 'testing',
  '测试完毕': 'tested',
  '已验收': 'verified',
  '已发布': 'released',
  '未确认': 'unconfirmed',
  '已确认': 'confirmed',
};

export function statusKey(text) {
  const t = String(text || '').trim();
  return STATUS_MAP[t] || t;
}

export class ZenTaoError extends Error {
  constructor(message, code = 'ZT_ERROR') {
    super(message);
    this.name = 'ZenTaoError';
    this.code = code;
  }
}

/** Parse the 所属模块 value from a story/bug detail page. */
export function parseOwnerModule(html) {
  const match = String(html || '').match(/<th[^>]*>\s*所属模块\s*<\/th>\s*<td([^>]*)>([\s\S]*?)<\/td>/);
  if (!match) return '';
  const titleMatch = match[1].match(/title=['"]([^'"]*)['"]/);
  // Prefer the first link (the module name); the td may also contain action
  // buttons or separator divs after it.
  const linkMatch = match[2].match(/<a[^>]*>([\s\S]*?)<\/a>/);
  const text = (linkMatch ? linkMatch[1] : match[2])
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const value = (titleMatch && titleMatch[1].trim().length > text.length ? titleMatch[1].trim() : text) || '';
  if (!value || value === '/') return '';
  return value.replace(/^\/+/, '').trim();
}

export class ZenTaoClient {
  constructor(options) {
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.account = options.account || '';
    this.password = options.password || '';
    this.timeoutMs = options.timeoutMs || 20000;
    this.cookies = new Map();
    this.loggingIn = null;
    this.loggedInAt = 0;
    // item id -> { name, at } for the 所属模块 enrichment cache
    this.moduleCache = new Map();
    // REST API token (writes need it; reads fall back to the session cookie)
    this.apiToken = '';
    this.apiTokenAt = 0;
    this.taskCache = new Map();
    // ZenTao's execution-team page links to numeric user ids, while creation
    // forms expect account strings. Cache the id -> account resolution.
    this.userAccountCache = new Map();
  }

  get origin() {
    return this.baseUrl;
  }

  /** Apply new credentials from the settings dialog without a restart. */
  applyCredentials({ baseUrl, account, password } = {}) {
    if (baseUrl) this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    if (account) this.account = String(account);
    if (password) this.password = String(password);
    this.cookies.clear();
    this.apiToken = '';
    this.apiTokenAt = 0;
    this.loggedInAt = 0;
    this.loggingIn = null;
    this.taskCache.clear();
    this.moduleCache.clear();
    this.userAccountCache.clear();
  }

  #cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  #storeCookies(res) {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of raw) {
      const pair = line.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > 0) this.cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
  }

  async request(path, init = {}) {
    const url = path.startsWith('http') ? path : this.baseUrl + path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        ...init,
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/json,*/*',
          ...(init.headers || {}),
          cookie: this.#cookieHeader(),
        },
      });
      this.#storeCookies(res);
      const text = await res.text();
      return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
    } finally {
      clearTimeout(timer);
    }
  }

  async login(force = false) {
    if (!force && this.loggedInAt && Date.now() - this.loggedInAt < 30 * 60 * 1000) return;
    if (this.loggingIn) return this.loggingIn;
    this.loggingIn = (async () => {
      this.cookies.clear();
      await this.request('/user-login.html');
      const rnd = await this.request('/user-refreshRandom.html', {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      const rand = rnd.text.trim();
      const body = new URLSearchParams({
        account: this.account,
        password: this.password,
        passwordStrength: '1',
        referer: '/',
        verifyRand: rand,
        keepLogin: '0',
        captcha: '',
      });
      const res = await this.request('/user-login.html', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: this.baseUrl + '/user-login.html',
          Origin: this.baseUrl,
          Accept: 'application/json',
        },
        body: body.toString(),
      });
      let ok = false;
      try {
        ok = JSON.parse(res.text).result === 'success';
      } catch {
        ok = false;
      }
      if (!ok) throw new ZenTaoError('禅道登录失败，请检查账号或密码', 'ZT_LOGIN');
      this.loggedInAt = Date.now();
      return true;
    })();
    try {
      return await this.loggingIn;
    } finally {
      this.loggingIn = null;
    }
  }

  async get(path) {
    await this.login();
    let res = await this.request(path);
    if (this.#isLoginRedirect(res)) {
      await this.login(true);
      res = await this.request(path);
    }
    if (res.status >= 400) throw new ZenTaoError(`禅道请求失败 HTTP ${res.status}`, 'ZT_HTTP');
    return res;
  }

  async post(path, form) {
    await this.login();
    const body = form instanceof URLSearchParams ? form : toForm(form);
    const send = () =>
      this.request(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: this.baseUrl + '/',
          Origin: this.baseUrl,
          Accept: 'application/json, text/javascript, */*; q=0.01',
        },
        body: body.toString(),
      });
    let res = await send();
    if (this.#isLoginRedirect(res)) {
      await this.login(true);
      res = await send();
    }
    return res;
  }

  #isLoginRedirect(res) {
    return /user-login|user-deny/.test(res.location || '') || /self\.location='\/user-login/.test(res.text.slice(0, 200));
  }

  async #page(path) {
    const res = await this.get(path);
    if (this.#isLoginRedirect(res)) throw new ZenTaoError('禅道会话已失效', 'ZT_AUTH');
    if (/user-deny/.test(res.text.slice(0, 300))) throw new ZenTaoError('没有权限访问该禅道页面', 'ZT_DENIED');
    return res.text;
  }

  /** Projects visible to the signed-in account. */
  async projects() {
    const html = await this.#page('/project-browse-0-all.html');
    const out = [];
    for (const row of parseRows(html)) {
      const idCell = byClass(row, 'c-id');
      const id = row.id || listIdFromCell(idCell);
      if (!id) continue;
      const nameCell = byClass(row, 'c-name');
      if (!nameCell || !/project-index/.test(nameCell.html)) continue;
      const name = stripHtml((nameCell.html.match(/<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || nameCell.text)
        .replace(/^Scrum\s+/, '')
        .replace(/^瀑布\s+/, '')
        .replace(/^看板\s+/, '')
        .trim();
      const statusCell = byClass(row, 'c-status');
      out.push({
        id,
        name,
        status: statusKey(statusCell ? statusCell.text : ''),
        statusText: statusCell ? statusCell.text : '',
        pm: byClass(row, 'c-PM') ? byClass(row, 'c-PM').text : '',
      });
    }
    return dedupeById(out);
  }

  /** Executions (iterations) of one project. */
  async executions(projectId) {
    const html = await this.#page(`/project-execution-all-${projectId}.html`);
    const out = [];
    for (const row of parseRows(html)) {
      if (!row.id) continue;
      const nameCell = byClass(row, 'c-name');
      if (!nameCell) continue;
      const statusCell = byClass(row, 'c-status');
      out.push({
        id: row.id,
        name: stripHtml((nameCell.html.match(/<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || nameCell.text).trim(),
        status: statusKey(statusCell ? statusCell.text : ''),
        statusText: statusCell ? statusCell.text : '',
        projectId: Number(projectId),
      });
    }
    return out.filter((e) => e.name);
  }

  /** Stories linked to an execution. */
  /** Fill moduleName from the entity detail page, cached per item for 10 minutes. */
  async #enrichModules(kind, items) {
    const pending = (items || []).filter((item) => item && item.id && !item.moduleName);
    if (!pending.length) return;
    const cache = this.moduleCache;
    const worker = async (queue, indexRef) => {
      while (indexRef.index < queue.length) {
        const item = queue[indexRef.index];
        indexRef.index += 1;
        const key = kind + ':' + item.id;
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < 10 * 60 * 1000) {
          item.moduleName = hit.name;
          continue;
        }
        try {
          const html = await this.#page(kind === 'bug' ? `/bug-view-${item.id}.html` : `/story-view-${item.id}.html`);
          const name = parseOwnerModule(html);
          cache.set(key, { name, at: Date.now() });
          item.moduleName = name;
        } catch (error) {
          /* leave the module blank when the detail page is unavailable */
        }
      }
    };
    const indexRef = { index: 0 };
    await Promise.all(Array.from({ length: Math.min(6, pending.length) }, () => worker(pending, indexRef)));
  }

  async stories(executionId) {
    const html = await this.#page(`/execution-story-${executionId}.html`);
    const out = [];
    for (const row of parseRows(html)) {
      if (!row.id) continue;
      const cells = row.cells;
      const titleCell = byClass(row, 'c-title') || byClass(row, 'c-name') || cells[3];
      if (!titleCell || !stripHtml(titleCell.html)) continue;
      const priCell = byClass(row, 'c-pri') || cells[2];
      const statusCell = byClass(row, 'c-status') || cells[8];
      const stageCell = byClass(row, 'c-stage') || cells[9];
      const assignedCell = byClass(row, 'c-assignedTo') || cells[6] || cells[5];
      out.push({
        id: row.id,
        type: 'story',
        title: stripHtml(titleCell.html).trim(),
        moduleId: 0,
        moduleName: '',
        priority: priCell ? priCell.text.trim() : '',
        assignedTo: assignedCell ? assignedCell.text.trim() : '',
        status: statusKey(statusCell ? statusCell.text : ''),
        statusText: statusCell ? statusCell.text.trim() : '',
        stage: stageCell ? stageCell.text.trim() : '',
        url: `/projectstory-view-${row.id}.html`,
      });
    }
    await this.#enrichModules('story', out);
    return out;
  }

  /** Bugs linked to an execution. */
  async bugs(executionId) {
    return this.#listBugs(`/execution-bug-${executionId}.html`);
  }

  /** Bugs of a product (fallback list). */
  async productBugs(productId) {
    return this.#listBugs(`/bug-browse-${productId}.html`);
  }

  async #listBugs(path) {
    const html = await this.#page(path);
    const out = [];
    for (const row of parseRows(html)) {
      const cells = row.cells;
      let id = row.id;
      if (!id) {
        for (const cell of cells) {
          id = listIdFromCell(cell);
          if (id) break;
        }
      }
      if (!id) continue;
      const titleCell = byClass(row, 'c-title') || cells[3];
      if (!titleCell || !/bug-view/.test(titleCell.html)) continue;
      const statusCell = byClass(row, 'c-status');
      const resolutionCell = byClass(row, 'c-resolution') || cells[8];
      const moduleCell = byClass(row, 'c-module');
      const resolution = resolutionCell ? resolutionCell.text.trim() : '';
      out.push({
        id,
        type: 'bug',
        title: stripHtml(titleCell.html).trim(),
        moduleId: 0,
        moduleName: moduleCell ? moduleCell.text.trim() : '',
        priority: (byClass(row, 'c-pri') || cells[2] || { text: '' }).text.trim(),
        assignedTo: (byClass(row, 'c-assignedTo') || cells[6] || { text: '' }).text.trim(),
        status: statusKey(statusCell ? statusCell.text : ''),
        statusText: statusCell ? statusCell.text.trim() : '',
        resolution,
        url: `/bug-view-${id}.html`,
      });
    }
    await this.#enrichModules('bug', out);
    return out;
  }

  /** ZenTao REST API v1 with token auth (needed for writes). */
  async #apiToken(force = false) {
    if (!force && this.apiToken && Date.now() - this.apiTokenAt < 20 * 60 * 1000) return this.apiToken;
    const res = await this.request('/api.php/v1/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: this.account, password: this.password }),
    });
    if (res.status >= 400) throw new ZenTaoError(`获取禅道 API token 失败 HTTP ${res.status}`, 'ZT_API');
    let data = {};
    try {
      data = JSON.parse(res.text);
    } catch (error) {
      data = {};
    }
    if (!data.token) throw new ZenTaoError('禅道没有返回 API token', 'ZT_API');
    this.apiToken = data.token;
    this.apiTokenAt = Date.now();
    return this.apiToken;
  }

  async #apiRequest(method, path, body, retry = true) {
    const token = await this.#apiToken(false);
    const res = await this.request('/api.php/v1/' + String(path).replace(/^\/+/, ''), {
      method,
      headers: Object.assign({ 'content-type': 'application/json', Token: token }, body === undefined ? {} : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && retry) {
      this.apiToken = '';
      this.apiTokenAt = 0;
      return this.#apiRequest(method, path, body, false);
    }
    if (res.status >= 400) {
      throw new ZenTaoError(`禅道接口请求失败 HTTP ${res.status}: ${res.text.slice(0, 200)}`, 'ZT_API');
    }
    try {
      return JSON.parse(res.text);
    } catch (error) {
      return res.text;
    }
  }

  /** Tasks of one iteration (REST v1). */
  async tasks(executionId) {
    const id = Number(executionId) || 0;
    if (!id) return [];
    const data = await this.#apiRequest('GET', `executions/${id}/tasks`);
    const list = Array.isArray(data.tasks) ? data.tasks : [];
    // 任务接口只返回 module id；从任务编辑页的模块下拉里取一次 id→名称映射
    const moduleNames = new Map();
    const sample = list.find((task) => Number(task.module) > 0);
    if (sample) {
      try {
        const cacheKey = 'modules:' + id;
        const cached = this.taskCache.get(cacheKey);
        if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
          for (const [key, value] of cached.value) moduleNames.set(key, value);
        } else {
          const html = await this.#page(`/task-edit-${sample.id}.html`);
          for (const option of selectOptions(html, 'module')) {
            const moduleId = Number(option.value);
            if (moduleId > 0) moduleNames.set(moduleId, String(option.label || '').replace(/^\/+/, '').trim());
          }
          this.taskCache.set(cacheKey, { at: Date.now(), value: moduleNames });
        }
      } catch (error) {
        /* module names are optional */
      }
    }
    return list.map((task) => ({
      id: task.id,
      type: 'task',
      title: task.name || '',
      moduleName: moduleNames.get(Number(task.module)) || '',
      priority: task.pri || '',
      status: task.status || '',
      statusText: TASK_STATUS_TEXT[task.status] || task.status || '',
      done: task.status === 'done' || task.status === 'closed',
      assignedTo: task.assignedTo?.realname || task.assignedToRealName || '',
      assignedToAccount: task.assignedTo?.account || '',
      deadline: task.deadline || '',
      estimate: task.estimate || 0,
      consumed: task.consumed || 0,
      left: task.left || 0,
      execution: task.execution || id,
      url: `/task-view-${task.id}.html`,
    }));
  }

  /** Test tasks (测试单) of one iteration. */
  async testTasks(executionId) {
    const id = Number(executionId) || 0;
    if (!id) return [];
    const data = await this.#apiRequest('GET', 'testtasks');
    const list = (Array.isArray(data.testtasks) ? data.testtasks : []).filter((item) => Number(item.execution) === id);
    return list.map((item) => ({
      id: item.id,
      type: 'testtask',
      title: item.name || '',
      status: item.status || '',
      statusText: TASK_STATUS_TEXT[item.status] || item.status || '',
      owner: item.owner?.realname || '',
      ownerAccount: item.owner?.account || '',
      begin: item.begin || '',
      end: item.end || '',
      reportId: Number(item.testreport) || 0,
      url: `/testtask-view-${item.id}.html`,
    }));
  }

  /** Test reports linked to the iteration's test tasks. */
  async testReports(executionId) {
    const id = Number(executionId) || 0;
    if (!id) return [];
    const cachedReports = this.taskCache.get('reports:' + id);
    if (cachedReports && Date.now() - cachedReports.at < 5 * 60 * 1000) return cachedReports.value;
    const tasks = await this.testTasks(id);
    const ids = [...new Set(tasks.map((task) => task.reportId).filter(Boolean))];
    const reports = await Promise.all(
      ids.map(async (reportId) => {
        let title = '';
        let date = '';
        try {
          const html = await this.#page(`/testreport-view-${reportId}.html`);
          title = stripHtml((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '')
            .replace(/\s*-\s*禅道\s*$/, '')
            .replace(/^\d{4}-\d{2}-\d{2}\s+/, '')
            .replace(/^TESTTASK#\d+\s*/i, '')
            .replace(/\s*测试报告\s*$/, '')
            .trim();
          date = (html.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
        } catch (error) {
          title = '';
        }
        const linked = tasks.filter((task) => task.reportId === reportId).map((task) => task.title).join('、');
        return {
          id: reportId,
          type: 'report',
          title: title || '测试报告 #' + reportId,
          testtaskName: linked,
          date,
          url: `/testreport-view-${reportId}.html`,
        };
      }),
    );
    this.taskCache.set('reports:' + id, { at: Date.now(), value: reports });
    return reports;
  }

  /** One task detail (REST). */
  async taskDetail(taskId) {
    return await this.#apiRequest('GET', `tasks/${Number(taskId)}`);
  }

  /** Action links available on a task detail page. */
  async taskActions(taskId) {
    const id = Number(taskId);
    const html = await this.#page(`/task-view-${id}.html`);
    const found = [...html.matchAll(new RegExp(`task-(start|finish|close|cancel|pause|restart|activate)-${id}\\.html`, 'gi'))].map(
      (match) => match[1].toLowerCase(),
    );
    return [...new Set(found)];
  }

  /** Allowed target statuses for a task, derived from its available actions. */
  async taskStatusOptions(taskId) {
    const task = await this.taskDetail(taskId);
    // Show the same six statuses as ZenTao's own task form. Workflow actions are
    // tried first; unavailable transitions fall back to the edit form.
    const all = ['wait', 'doing', 'done', 'pause', 'cancel', 'closed'];
    return {
      current: task.status,
      currentText: TASK_STATUS_TEXT[task.status] || task.status,
      options: all.map((key) => ({ key, label: TASK_STATUS_TEXT[key] || key })),
    };
  }

  /** Set a task status directly through the edit form (used when workflow
   * actions are unavailable for the requested transition). */
  async setTaskStatusDirect(taskId, statusKey) {
    const pagePath = `/task-edit-${Number(taskId)}.html`;
    const html = await this.#page(pagePath);
    const form = parseFormFields(html);
    form.status = String(statusKey);
    const res = await this.post(pagePath, form);
    const parsed = parseFormResponse(res, 'task-edit-status');
    return Object.assign({ ok: true, status: statusKey }, parsed);
  }

  /** Assignable members for one task. */
  async taskAssignOptions(taskId) {
    const task = await this.taskDetail(taskId);
    const executionId = Number(task.execution) || 0;
    let html = '';
    if (executionId) html = await this.#page(`/task-assignTo-${executionId}-${Number(taskId)}.html?onlybody=yes`).catch(() => '');
    if (!html) html = await this.#page(`/task-assignTo-${Number(taskId)}.html`).catch(() => '');
    const users = selectOptions(html, 'assignedTo')
      .map((option) => ({
        value: option.value,
        label: String(option.label || option.value).replace(/^[A-Za-z]{1,3}:/, '').trim(),
      }))
      .filter((option) => option.value);
    return { users, current: task.assignedTo?.account || '' };
  }

  /** Change a task status through the matching ZenTao action page. */
  async changeTaskStatus(taskId, statusKey) {
    const id = Number(taskId);
    const task = await this.taskDetail(id);
    const actions = await this.taskActions(id).catch(() => []);
    const has = (action) => actions.includes(action);
    const candidates =
      statusKey === 'doing'
        ? ['start', 'restart', 'activate']
        : statusKey === 'done'
          ? ['finish']
          : statusKey === 'pause'
            ? ['pause']
            : statusKey === 'cancel'
              ? ['cancel']
              : statusKey === 'closed'
                ? ['close']
                : [];
    const action = candidates.find((name) => has(name));
    if (!action) {
      // 选择器展示全部状态；没有对应工作流动作时直接回放编辑表单。
      return await this.setTaskStatusDirect(id, statusKey);
    }
    const pagePath = `/task-${action}-${id}.html`;
    const html = await this.#page(pagePath);
    const form = parseFormFields(html);
    const today = new Date().toISOString().slice(0, 10);
    if (action === 'start' || action === 'restart' || action === 'activate') {
      form.realStarted = form.realStarted && form.realStarted !== '0000-00-00' ? form.realStarted : today;
      // 禅道 start 表单校验「总计消耗」不能为空/0
      form.consumed = String(Math.max(1, Number(task.consumed) || 0));
      // 预计剩余必须 > 0，否则禅道会认为任务已做完直接完成
      form.left = String(Math.max(1, Number(task.left) || Number(task.estimate) || 0));
      if ('currentConsumed' in form) form.currentConsumed = form.consumed;
    }
    if (action === 'finish') {
      // 禅道 finish 表单校验「本次消耗」不能为 0，至少要填 1 小时
      const spent = Math.max(1, (Number(task.consumed) || 0) + (Number(task.left) || 0));
      form.consumed = String(spent);
      if ('currentConsumed' in form) form.currentConsumed = String(spent);
      form.left = '0';
      // 未开始的任务直接完成时，禅道要求填写实际开始日期
      if ('realStarted' in form && (!form.realStarted || form.realStarted.startsWith('0000'))) {
        form.realStarted = today;
      }
      // 完成日期：禅道 finish 表单要求 finishedDate（YYYY-MM-DD HH:mm:ss）
      const finishedAt = new Date();
      const finishedDate =
        finishedAt.getFullYear() +
        '-' +
        String(finishedAt.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(finishedAt.getDate()).padStart(2, '0') +
        ' ' +
        String(finishedAt.getHours()).padStart(2, '0') +
        ':' +
        String(finishedAt.getMinutes()).padStart(2, '0') +
        ':' +
        String(finishedAt.getSeconds()).padStart(2, '0');
      if ('finishedDate' in form) form.finishedDate = finishedDate;
    }
    form.comment = '';
    const res = await this.post(pagePath, form);
    const parsed = parseFormResponse(res, '修改任务状态');
    return Object.assign({ status: statusKey, action }, parsed);
  }

  /** Re-assign a task. */
  async assignTask(taskId, account) {
    const id = Number(taskId);
    const value = String(account || '').trim();
    if (!value) throw new ZenTaoError('指派账号不能为空', 'ZT_INPUT');
    await this.#apiRequest('PUT', `tasks/${id}`, { assignedTo: value });
    return { ok: true, assignedTo: value };
  }

  /** Resolve the product behind an execution (list API often omits it). */
  async executionProduct(executionId) {
    const detail = await this.#apiRequest('GET', `executions/${Number(executionId)}`);
    const productId = Number(detail.product) || Number(Array.isArray(detail.products) && detail.products[0] && detail.products[0].id) || 0;
    const name = (Array.isArray(detail.products) && detail.products[0] && detail.products[0].name) || '';
    return { productId, name };
  }

  /** Module options available to a story (from its edit form). */
  async storyModuleOptions(storyId) {
    const html = await this.#page(`/story-edit-${Number(storyId)}.html`);
    const modules = selectOptions(html, 'module').map((option) => ({
      value: String(option.value),
      label: String(option.label || '').replace(/^\/+/, '').trim() || '无',
    }));
    return { modules };
  }

  /** Move a story into another module (replays the edit form). */
  async setStoryModule(storyId, moduleId) {
    const value = Number(moduleId);
    if (!Number.isFinite(value) || value < 0) throw new ZenTaoError('模块不合法', 'ZT_INPUT');
    const pagePath = `/story-edit-${Number(storyId)}.html`;
    const html = await this.#page(pagePath);
    const form = parseFormFields(html);
    form.module = String(value);
    const res = await this.post(pagePath, form);
    const parsed = parseFormResponse(res, '修改需求模块');
    return Object.assign({ ok: true, moduleId: value }, parsed);
  }

  /** Module options available to a task (from its edit form). */
  async taskModuleOptions(taskId) {
    const html = await this.#page(`/task-edit-${Number(taskId)}.html`);
    const modules = selectOptions(html, 'module').map((option) => ({
      value: String(option.value),
      label: String(option.label || '').replace(/^\/+/, '').trim() || '无',
    }));
    return { modules };
  }

  /** Upload an image through ZenTao's KindEditor endpoint and return its url. */
  async uploadEditorImage(buffer, mimeType, filename) {
    const pageHtml = await this.#page('/story-create-1-0-0-0.html');
    const kuid = (pageHtml.match(/kuid\s*=\s*'([^']+)'/) || [])[1];
    if (!kuid) throw new ZenTaoError('无法获取禅道图片上传凭证', 'ZT_UPLOAD');
    const form = new FormData();
    form.append('imgFile', new Blob([buffer], { type: mimeType || 'image/png' }), filename || 'image.png');
    const res = await this.request(`/file-ajaxUpload-${kuid}.html?onlybody=yes`, {
      method: 'POST',
      body: form,
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Referer: this.baseUrl + '/story-create-1-0-0-0.html',
      },
    });
    let data = null;
    try {
      data = JSON.parse(res.text || '{}');
    } catch (error) {
      data = null;
    }
    if (!data || data.error || !data.url) {
      throw new ZenTaoError((data && data.message) || '图片上传失败', 'ZT_UPLOAD');
    }
    return { ok: true, url: String(data.url) };
  }

  /** Update a task priority (1 P1 .. 3 P3). */
  async setTaskPriority(taskId, priority) {
    const value = Number(priority);
    if (![1, 2, 3].includes(value)) throw new ZenTaoError('优先级只能是 1/2/3', 'ZT_INPUT');
    // REST 更新会忽略 pri，这里回放任务编辑表单来改优先级
    const pagePath = `/task-edit-${Number(taskId)}.html`;
    const html = await this.#page(pagePath);
    const form = parseFormFields(html);
    form.pri = String(value);
    const res = await this.post(pagePath, form);
    const parsed = parseFormResponse(res, '修改任务优先级');
    return Object.assign({ ok: true, priority: value }, parsed);
  }

  /** Move a task into another module. */
  async setTaskModule(taskId, moduleId) {
    const value = Number(moduleId);
    if (!Number.isFinite(value) || value < 0) throw new ZenTaoError('模块不合法', 'ZT_INPUT');
    await this.#apiRequest('PUT', `tasks/${Number(taskId)}`, { module: value });
    return { ok: true, moduleId: value };
  }

  /** Iterations a task can be moved to (from its edit form). */
  async taskExecutionOptions(taskId) {
    const html = await this.#page(`/task-edit-${Number(taskId)}.html`);
    const options = selectOptions(html, 'execution').map((option) => ({
      value: String(option.value),
      label: String(option.label || option.value).trim(),
    }));
    const task = await this.taskDetail(taskId);
    return { options, current: String(task.execution || '') };
  }

  /** Move a task to another iteration by replaying its edit form. */
  async setTaskExecution(taskId, executionId) {
    const id = Number(taskId);
    const target = Number(executionId);
    if (!Number.isFinite(target) || target <= 0) throw new ZenTaoError('迭代不合法', 'ZT_INPUT');
    const pagePath = `/task-edit-${id}.html`;
    const html = await this.#page(pagePath);
    const form = parseFormFields(html);
    form.execution = String(target);
    const res = await this.post(pagePath, form);
    const parsed = parseFormResponse(res, '修改任务所属迭代');
    return Object.assign({ ok: true, executionId: target }, parsed);
  }

  /** Update a task deadline (YYYY-MM-DD). */
  async setTaskDeadline(taskId, deadline) {
    const id = Number(taskId);
    const value = String(deadline || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ZenTaoError('截止日期格式应为 YYYY-MM-DD', 'ZT_INPUT');
    await this.#apiRequest('PUT', `tasks/${id}`, { deadline: value });
    return { ok: true, deadline: value };
  }

  /** Current week's pending work for the signed-in account (dashboard). */
  async dashboard() {
    const me = String(this.account || '').toLowerCase();
    const now = new Date();
    const monday = new Date(now);
    const day = (now.getDay() + 6) % 7;
    monday.setDate(now.getDate() - day);
    const weekStart = [monday.getFullYear(), String(monday.getMonth() + 1).padStart(2, '0'), String(monday.getDate()).padStart(2, '0')].join('-');
    const weekEndDate = new Date(monday);
    weekEndDate.setDate(monday.getDate() + 6);
    const weekEnd = [weekEndDate.getFullYear(), String(weekEndDate.getMonth() + 1).padStart(2, '0'), String(weekEndDate.getDate()).padStart(2, '0')].join('-');
    // assignedTo is an object on bugs/tasks and a plain account string on
    // execution stories.
    const assigneeOf = (item) =>
      typeof item?.assignedTo === 'string' ? item.assignedTo : item?.assignedTo?.account;
    const isMine = (item) => String(assigneeOf(item) || '').toLowerCase() === me;
    const inWeek = (deadline) => Boolean(deadline) && deadline <= weekEnd;
    const strip = (text) => decodeEntities(stripHtml(String(text || ''))).replace(/<[^>]+>/g, '').trim();
    const projects = await this.#apiRequest('GET', 'projects');
    const projectList = Array.isArray(projects.projects) ? projects.projects : [];
    // 需求按迭代日期筛选：先找与本周有交集的迭代，再取这些迭代里的未关闭需求
    const [taskData, executionsData, ...bugResults] = await Promise.all([
      this.#apiRequest('GET', 'tasks').catch(() => ({ tasks: [] })),
      this.#apiRequest('GET', 'executions').catch(() => ({ executions: [] })),
      ...projectList.map((project) =>
        this.#apiRequest('GET', `projects/${project.id}/bugs`).catch(() => ({ bugs: [] })),
      ),
    ]);
    const executions = Array.isArray(executionsData.executions) ? executionsData.executions : [];
    const weekExecutions = executions.filter(
      (item) => item.begin && item.end && item.begin <= weekEnd && item.end >= weekStart,
    );
    const executionStoryResults = await Promise.all(
      weekExecutions.map((execution) =>
        this.#apiRequest('GET', `executions/${execution.id}/stories`).catch(() => ({ stories: [] })),
      ),
    );
    const stories = new Map();
    for (const data of executionStoryResults) {
      for (const item of data.stories || []) stories.set(item.id, item);
    }
    const bugs = new Map();
    for (const data of bugResults) {
      for (const item of data.bugs || []) bugs.set(item.id, item);
    }
    // 需求：本周有交集的迭代内、指派给我的未关闭需求
    const storyList = [...stories.values()]
      .filter((item) => isMine(item) && item.status !== 'closed')
      .map((item) => ({
        id: item.id,
        type: 'story',
        title: strip(item.title),
        deadline: item.deadline || '',
        status: item.status,
        statusText: item.statusText || '',
        url: `/story-view-${item.id}.html`,
      }))
      .sort((a, b) => (a.deadline || '9999-99-99').localeCompare(b.deadline || '9999-99-99'));
    const bugList = [...bugs.values()]
      .filter((item) => isMine(item) && item.status !== 'closed' && inWeek(item.deadline || ''))
      .map((item) => ({
        id: item.id,
        type: 'bug',
        title: strip(item.title),
        deadline: item.deadline || '',
        status: item.status,
        statusText: item.statusText || '',
        url: `/bug-view-${item.id}.html`,
      }))
      .sort((a, b) => (a.deadline || '9999-99-99').localeCompare(b.deadline || '9999-99-99'));
    const taskList = (Array.isArray(taskData.tasks) ? taskData.tasks : [])
      .filter(
        (item) =>
          String(item?.assignedTo?.account || '').toLowerCase() === me &&
          !['done', 'closed', 'cancel'].includes(item.status) &&
          inWeek(item.deadline || ''),
      )
      .map((item) => ({
        id: item.id,
        type: 'task',
        title: strip(item.name),
        deadline: item.deadline || '',
        status: item.status,
        statusText: TASK_STATUS_TEXT[item.status] || item.status || '',
        url: `/task-view-${item.id}.html`,
      }))
      .sort((a, b) => (a.deadline || '9999-99-99').localeCompare(b.deadline || '9999-99-99'));
    return {
      weekStart,
      weekEnd,
      account: this.account,
      totals: { story: storyList.length, bug: bugList.length, task: taskList.length },
      lists: { story: storyList, bug: bugList, task: taskList },
    };
  }

  /** All tasks across visible iterations, including completed/closed ones. */
  async teamTasks() {
    const [projectsData, executionsData] = await Promise.all([
      this.#apiRequest('GET', 'projects').catch(() => ({ projects: [] })),
      this.#apiRequest('GET', 'executions').catch(() => ({ executions: [] })),
    ]);
    const projectNames = new Map();
    for (const project of Array.isArray(projectsData.projects) ? projectsData.projects : []) {
      projectNames.set(Number(project.id), project.name || '');
    }
    const executions = Array.isArray(executionsData.executions) ? executionsData.executions : [];
    const tasks = [];
    const members = new Map();
    let cursor = 0;
    const worker = async () => {
      while (cursor < executions.length) {
        const execution = executions[cursor];
        cursor += 1;
        const cacheKey = 'team-exec:' + execution.id;
        try {
          const cached = this.taskCache.get(cacheKey);
          let rows;
          if (cached && Date.now() - cached.at < 3 * 60 * 1000) {
            rows = cached.value;
          } else {
            const data = await this.#apiRequest('GET', `executions/${execution.id}/tasks`);
            rows = (Array.isArray(data.tasks) ? data.tasks : []).map((task) => ({
              id: task.id,
              type: 'task',
              title: task.name || '',
              assignedTo: task.assignedTo?.realname || task.assignedToRealName || '',
              assignedToAccount: task.assignedTo?.account || '',
              resolver: task.finishedBy?.realname || task.finishedBy?.account || task.closedBy?.realname || task.closedBy?.account || '',
              resolverAccount: task.finishedBy?.account || task.closedBy?.account || '',
              resolvedDate: String(task.finishedDate || task.closedDate || '').slice(0, 10),
              status: task.status || '',
              statusText: TASK_STATUS_TEXT[task.status] || task.status || '',
              deadline: task.deadline || '',
              done: task.status === 'done' || task.status === 'closed',
              executionId: Number(execution.id),
              executionName: execution.name || '',
              projectId: Number(execution.project) || 0,
              projectName: projectNames.get(Number(execution.project)) || '',
              url: `/task-view-${task.id}.html`,
            }));
            this.taskCache.set(cacheKey, { at: Date.now(), value: rows });
          }
          for (const row of rows) {
            tasks.push(row);
            if (row.assignedToAccount || row.assignedTo) {
              const key = row.assignedToAccount || row.assignedTo;
              if (!members.has(key)) {
                members.set(key, { account: row.assignedToAccount || '', label: row.assignedTo || key });
              }
            }
          }
        } catch (error) {
          /* keep other iterations */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, Math.max(1, executions.length)) }, () => worker()));
    return {
      tasks,
      members: [...members.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN')),
      updatedAt: Date.now(),
    };
  }

  /** All unfinished tasks assigned to me (calendar source). */
  async myTasks() {
    const me = String(this.account || '').toLowerCase();
    const data = await this.#apiRequest('GET', 'tasks');
    const list = Array.isArray(data.tasks) ? data.tasks : [];
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 365);
    const cutoff = cutoffDate.toISOString().slice(0, 10);
    return list
      .filter((item) => {
        const account = String(item?.assignedTo?.account || '').toLowerCase();
        if (account !== me || item.status === 'cancel') return false;
        // Keep recently completed tasks so the calendar can show them grayed out.
        if (['done', 'closed'].includes(item.status)) return Boolean(item.deadline) && item.deadline >= cutoff;
        return true;
      })
      .map((item) => ({
        id: item.id,
        type: 'task',
        title: item.name || '',
        deadline: item.deadline || '',
        assignedDate: item.assignedDate || '',
        status: item.status || '',
        statusText: TASK_STATUS_TEXT[item.status] || item.status || '',
        done: item.status === 'done' || item.status === 'closed',
        execution: item.execution || 0,
        project: item.project || 0,
        url: `/task-view-${item.id}.html`,
      }))
      .sort((a, b) => (a.deadline || '9999-99-99').localeCompare(b.deadline || '9999-99-99'));
  }

  /** Iterations visible to the signed-in account (calendar task creation). */
  async iterationsForUser() {
    const [projectsData, executionsData] = await Promise.all([
      this.#apiRequest('GET', 'projects').catch(() => ({ projects: [] })),
      this.#apiRequest('GET', 'executions').catch(() => ({ executions: [] })),
    ]);
    const names = new Map();
    for (const project of Array.isArray(projectsData.projects) ? projectsData.projects : []) names.set(project.id, project.name);
    const list = Array.isArray(executionsData.executions) ? executionsData.executions : [];
    return list
      .filter((item) => ['wait', 'doing'].includes(item.status))
      .map((item) => ({
        id: item.id,
        name: item.name || '',
        projectId: item.project || 0,
        projectName: names.get(item.project) || '',
        productId: item.product || 0,
        status: item.status || '',
        statusText: item.status === 'doing' ? '进行中' : item.status === 'suspended' ? '已挂起' : item.status === 'wait' ? '未开始' : item.status || '',
        begin: item.begin || '',
        end: item.end || '',
      }))
      .sort((a, b) => {
        // 进行中 first, then 未开始; stable by project/name inside a group.
        if (a.status !== b.status) return a.status === 'doing' ? -1 : 1;
        return a.projectName.localeCompare(b.projectName, 'zh-Hans-CN') || a.id - b.id;
      });
  }

  /** Members of an iteration's team (assignee options). */
  async taskTeam(executionId) {
    return await this.executionMembers(Number(executionId));
  }

  /** Create a task inside an iteration (REST v1). */
  async createTask(input) {
    const executionId = Number(input.executionId) || 0;
    const projectId = Number(input.projectId) || 0;
    const name = String(input.title || '').trim();
    if (!name) throw new ZenTaoError('任务标题不能为空', 'ZT_INPUT');
    if (!executionId) throw new ZenTaoError('请选择迭代', 'ZT_INPUT');
    const today = new Date().toISOString().slice(0, 10);
    const body = {
      project: projectId,
      name,
      type: 'devel',
      pri: Math.min(3, Math.max(1, Number(input.priority) || 3)),
      assignedTo: String(input.assignedTo || ''),
      deadline: String(input.deadline || today),
      estStarted: today,
      estimate: 0,
      left: 0,
      desc: String(input.description || ''),
      module: 0,
      story: Number(input.storyId) || 0,
    };
    // ZenTao v1 creates tasks under an execution: POST /executions/{id}/tasks
    try {
      const res = await this.#apiRequest('POST', `executions/${executionId}/tasks`, body);
      const id = Number(res && res.id) || 0;
      if (!id) throw new ZenTaoError('禅道没有返回新任务 ID', 'ZT_API');
      return { ok: true, id, name: (res && res.name) || name, url: `/task-view-${id}.html` };
    } catch (error) {
      // 部分禅道账号的 REST 任务创建被拒绝（HTTP 403 Access not allowed），
      // 但其网页创建表单有权限；回放表单创建，避免直接失败。
      if (!/HTTP 403/.test(String(error && error.message))) throw error;
      return await this.#createTaskViaForm(input, executionId, body, name);
    }
  }

  async #createTaskViaForm(input, executionId, body, name) {
    const pagePath = `/task-create-${executionId}.html`;
    const html = await this.#page(pagePath);
    const form = parseFormFields(html);
    form.execution = String(executionId);
    form.name = name;
    form.pri = String(body.pri);
    form.assignedTo = String(body.assignedTo || '');
    if ('assignedTo[]' in form) form['assignedTo[]'] = String(body.assignedTo || '');
    form.deadline = body.deadline;
    form.estStarted = body.estStarted;
    form.estimate = String(body.estimate || 0);
    form.desc = body.desc || '';
    form.module = String(body.module || 0);
    form.story = String(body.story || 0);
    const res = await this.post(pagePath, form);
    const parsed = parseFormResponse(res, 'task-create');
    if (parsed && parsed.ok === false) throw new ZenTaoError(parsed.message || parsed.error || '创建任务失败', 'ZT_API');
    const id = Number(parsed && parsed.id) || 0;
    return { ok: true, id, name, url: id ? `/task-view-${id}.html` : '' };
  }

  /** Detail text blocks of a story: description, acceptance criteria. */
  async storyDetail(storyId) {
    const html = await this.#page(`/projectstory-view-${storyId}.html`);
    const title = stripHtml((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/\s*-\s*[^-]*-\s*禅道\s*$/, '').trim();
    const blocks = [];
    const detailRe = /<div class=["']detail-title["']>([\s\S]*?)<\/div>\s*<div class=["']detail-content[^"']*["']>([\s\S]*?)<\/div>\s*<\/div>/gi;
    let m;
    while ((m = detailRe.exec(html))) {
      blocks.push({ title: stripHtml(m[1]).trim(), text: stripHtml(m[2]).trim() });
    }
    const stageMatch = html.match(/<th>所处阶段<\/th>\s*<td>\s*([\s\S]*?)\s*<\/td>/);
    const statusMatch = html.match(/status-story status-([a-z]+)/);
    const contentBlocks = blocks.filter((b) => !/历史记录|附件|评论/.test(b.title));
    return {
      id: Number(storyId),
      title: title.replace(/^STORY\s*#\d+\s*/, '').trim(),
      status: statusMatch ? statusMatch[1] : '',
      stage: stageMatch ? stripHtml(stageMatch[1]).trim() : '',
      blocks: contentBlocks,
      description: contentBlocks.map((b) => (b.title ? b.title + '\n' : '') + b.text).join('\n\n'),
      url: `/projectstory-view-${storyId}.html`,
    };
  }

  async bugDetail(bugId) {
    const html = await this.#page(`/bug-view-${bugId}.html`);
    const title = stripHtml((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/\s*-\s*[^-]*-\s*禅道\s*$/, '').trim();
    const blocks = [];
    const detailRe = /<div class=["']detail-title["']>([\s\S]*?)<\/div>\s*<div class=["']detail-content[^"']*["']>([\s\S]*?)<\/div>\s*<\/div>/gi;
    let m;
    while ((m = detailRe.exec(html))) {
      blocks.push({ title: stripHtml(m[1]).trim(), text: stripHtml(m[2]).trim() });
    }
    const resMatch = html.match(/<th>方案<\/th>\s*<td>([\s\S]*?)<\/td>/);
    const contentBlocks = blocks.filter((b) => !/历史记录|附件|评论/.test(b.title));
    return {
      id: Number(bugId),
      title: title.replace(/^BUG\s*#\d+\s*/, '').trim(),
      blocks: contentBlocks,
      resolution: resMatch ? stripHtml(resMatch[1]).trim() : '',
      description: contentBlocks.map((b) => (b.title ? b.title + '\n' : '') + b.text).join('\n\n'),
      url: `/bug-view-${bugId}.html`,
    };
  }

  /** Options rendered inside a create form (product/module/user selects). */
  async formOptions(path) {
    const html = await this.#page(path);
    const select = (name) => {
      const re = new RegExp(`<select[^>]*name=['"]${name}['"][^>]*>([\\s\\S]*?)<\\/select>`, 'i');
      const m = html.match(re);
      if (!m) return [];
      return [...m[1].matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/gi)].map((o) => ({
        value: (o[1].match(/value=['"]([^'"]*)['"]/) || [])[1] || '',
        label: stripHtml(o[2]).trim(),
        selected: /selected/i.test(o[1]),
      }));
    };
    return {
      product: select('product'),
      module: select('module'),
      assignedTo: select('assignedTo'),
      pri: select('pri'),
      severity: select('severity'),
      openedBuild: select('openedBuild'),
    };
  }

  /** Members explicitly assigned to an iteration's team. */
  async executionMembers(executionId) {
    const html = await this.#page(`/execution-team-${Number(executionId)}.html`);
    const users = [];
    for (const row of parseRows(html)) {
      const cell = row.cells[0];
      if (!cell) continue;
      // ZenTao's team page links the member column to /user-view-{account}.html.
      const match = cell.html.match(/user-view-([^/'"?]+)\.html/i);
      let value = match ? decodeEntities(match[1]).trim() : '';
      if (!value || value === 'closed') continue;
      if (/^\d+$/.test(value)) {
        const userId = value;
        if (!this.userAccountCache.has(userId)) {
          try {
            const res = await this.get('/api.php/v1/users/' + encodeURIComponent(userId));
            const user = JSON.parse(res.text);
            this.userAccountCache.set(userId, String(user.account || ''));
          } catch (error) {
            this.userAccountCache.set(userId, '');
          }
        }
        value = this.userAccountCache.get(userId) || value;
      }
      users.push({ value, label: cell.text.trim() || value });
    }
    return [...new Map(users.map((user) => [user.value, user])).values()];
  }

  /** Create a story; executionId links it to that iteration. */
  async createStory(input) {
    const form = new URLSearchParams();
    form.set('uid', randomUid());
    form.set('product', String(input.productId));
    form.set('module', String(input.moduleId || 0));
    form.set('plan', '0');
    form.set('source', input.source || '');
    form.set('sourceNote', '');
    form.set('title', input.title || '');
    form.set('color', '');
    form.set('category', 'feature');
    form.set('pri', String(input.priority || 3));
    form.set('estimate', '');
    // ZenTao's separate rich-text fields: spec = 需求描述, verify = 验收标准.
    // Do not merge these, otherwise the acceptance content only appears inside
    // the description section on the story detail page.
    form.set('spec', input.description || '');
    form.set('verify', input.acceptance || '');
    form.set('status', 'draft');
    form.set('type', 'story');
    form.set('keywords', '');
    form.set('needNotReview', '1');
    if (input.assignedTo) form.set('assignedTo', input.assignedTo);
    const res = await this.post(`/story-create-${input.productId}-0-0-0-${input.executionId || input.projectId}.html`, form);
    return parseFormResponse(res, `story-create`);
  }

  /** Create a bug; executionId + projectId bind it to the iteration. */
  async createBug(input) {
    const form = new URLSearchParams();
    form.set('uid', randomUid());
    form.set('product', String(input.productId));
    form.set('module', String(input.moduleId || 0));
    form.set('project', String(input.projectId || 0));
    form.set('execution', String(input.executionId || 0));
    form.set('openedBuild', input.openedBuild || 'trunk');
    form.set('assignedTo', input.assignedTo || '');
    form.set('type', input.type || 'codeerror');
    form.set('os', input.os || '');
    form.set('browser', input.browser || '');
    form.set('title', input.title || '');
    form.set('color', '');
    form.set('severity', String(input.severity || 3));
    form.set('pri', String(input.priority || 3));
    form.set('steps', input.steps || '');
    form.set('story', '0');
    form.set('task', '0');
    form.set('oldTaskID', '0');
    form.set('status', 'active');
    form.set('keywords', '');
    form.set('case', '0');
    form.set('caseVersion', '0');
    form.set('result', '0');
    form.set('testtask', '0');
    const query = input.executionId ? `executionID=${input.executionId}` : `projectID=${input.projectId}`;
    const res = await this.post(`/bug-create-${input.productId}-0-${query}.html`, form);
    return parseFormResponse(res, 'bug-create');
  }

  /** Create one test case under a story. */
  async createTestcase(input) {
    const form = new URLSearchParams();
    form.set('product', String(input.productId));
    form.set('module', String(input.moduleId || 0));
    form.set('story', String(input.storyId || 0));
    form.set('title', input.title || '');
    form.set('color', '');
    form.set('pri', String(input.priority || 3));
    form.set('type', input.type || 'feature');
    form.set('precondition', input.precondition || '');
    const steps = input.steps && input.steps.length ? input.steps : [{ step: '', expect: '' }];
    for (const item of steps) {
      form.append('steps[]', item.step || '');
      form.append('expects[]', item.expect || '');
      form.append('stepType[]', 'item');
    }
    const res = await this.post(`/testcase-create-${input.productId}-0-0--0-${input.storyId || 0}.html`, form);
    return parseFormResponse(res, 'testcase-create');
  }

  /** Modules offered by the BUG edit page. An absent select means no edit access. */
  async bugModuleOptions(bugId) {
    const html = await this.#page(`/bug-edit-${bugId}.html`);
    return selectOptions(html, 'module')
      .filter((option) => option.value !== '')
      .map((option) => ({ value: String(option.value), label: option.label || '/' }));
  }

  /** Change a BUG's module, preserving all other values from its edit form. */
  async changeBugModule(bugId, moduleId) {
    const html = await this.#page(`/bug-edit-${bugId}.html`);
    const allowed = selectOptions(html, 'module').some((option) => String(option.value) === String(moduleId));
    if (!allowed) return { ok: false, error: '当前账号没有修改该 BUG 模块的权限，或模块不存在' };
    const form = editFormValues(html);
    form.delete('module');
    form.set('module', String(moduleId));
    form.set('comment', '');
    const res = await this.post(`/bug-edit-${bugId}.html`, form);
    const result = parseFormResponse(res, 'bug-edit');
    // The list enriches its module name from the BUG detail page and keeps it
    // in memory. Drop the old value immediately so the post-save refresh does
    // not misleadingly render the previous module for up to ten minutes.
    if (result.ok) this.moduleCache.delete(`bug:${bugId}`);
    return result;
  }

  /** Assignee picker for one story/bug (reads the assignTo form). */
  async assignOptions(type, id) {
    const path = type === 'bug' ? `/bug-assignTo-${id}.html` : `/story-assignTo-${id}.html`;
    const html = await this.#page(path);
    const status = (html.match(/<input[^>]*name=['"]status['"][^>]*value=['"]([^'"]*)['"]/i) || [])[1] || '';
    const users = selectOptions(html, 'assignedTo')
      .map((option) => ({
        value: option.value,
        label: String(option.label || option.value).replace(/^[A-Za-z]:/, '').trim(),
      }))
      .filter((option) => option.value);
    return { users, status };
  }

  /** Re-assign one story/bug; ZenTao posts to the same assignTo endpoint. */
  async assignItem(type, id, assignedTo) {
    const kind = type === 'bug' ? 'bug' : 'story';
    const info = await this.assignOptions(kind, id);
    const form = new URLSearchParams();
    form.set('assignedTo', String(assignedTo || ''));
    if (info.status) form.set('status', info.status);
    form.set('comment', '');
    const res = await this.post(`/${kind}-assignTo-${id}.html`, form);
    const parsed = parseFormResponse(res, kind + '-assign');
    return { ...parsed, type: kind, id: Number(id), assignedTo: String(assignedTo || '') };
  }

  /** Status actions ZenTao offers for one execution (permission/state aware). */
  async executionActions(id) {
    const html = await this.#page(`/execution-view-${id}.html`);
    const actions = new Set();
    for (const match of html.matchAll(/execution-([a-zA-Z]+)-\d+\.html/g)) {
      actions.add(match[1]);
    }
    return [...actions];
  }

  /** Create an execution (iteration) under a project. */
  async createExecution(input) {
    const projectId = Number(input && input.projectId) || 0;
    if (!projectId) throw new ZenTaoError('缺少项目，无法创建迭代', 'ZT_BAD_INPUT');
    const name = String((input && input.name) || '').trim();
    if (!name) throw new ZenTaoError('迭代名称不能为空', 'ZT_BAD_INPUT');
    const begin = (input && input.begin) || todayIso();
    const end = (input && input.end) || addDaysIso(begin, 14);
    const form = new URLSearchParams();
    form.set('uid', randomUid());
    form.set('project', String(projectId));
    form.set('name', name);
    form.set('code', (input && input.code) || codeForName(name));
    form.set('begin', begin);
    form.set('end', end);
    form.set('days', String((input && input.days) || workingDays(begin, end)));
    form.set('lifetime', (input && input.lifetime) || 'short');
    const status = ['wait', 'doing'].includes(input && input.status) ? input.status : 'wait';
    form.set('status', status);
    const res = await this.post(`/execution-create-${projectId}.html`, form);
    const parsed = parseFormResponse(res, 'execution-create');
    if (!parsed.ok) return parsed;
    let id = parsed.id || null;
    if (!id && parsed.locate) {
      const m = parsed.locate.match(/execution-(?:view|task)-(\d+)/) || parsed.locate.match(/executionID=(\d+)/);
      if (m) id = Number(m[1]);
    }
    if (!id) {
      const list = await this.executions(projectId).catch(() => []);
      const match = list
        .filter((execution) => execution.name === name)
        .sort((a, b) => (b.id || 0) - (a.id || 0))[0];
      if (match) id = match.id;
    }
    if (status === 'doing' && id) {
      // 有些禅道模板忽略创建表单里的 status，需要再执行一次启动。
      await this.changeExecutionStatus(id, 'start').catch(() => {});
    }
    return {
      ok: true,
      id,
      name,
      projectId,
      begin,
      end,
      days: form.get('days'),
      lifetime: form.get('lifetime'),
      message: parsed.message || '创建成功',
      url: id ? `/execution-view-${id}.html` : `/project-execution-all-${projectId}.html`,
    };
  }

  /** Change a story stage through the batch endpoint. */
  async changeStoryStage(storyIds, stage) {
    const form = new URLSearchParams();
    for (const id of storyIds) form.append('storyIdList[]', String(id));
    const res = await this.post(`/story-batchChangeStage-${stage}.html`, form);
    return parseFormResponse(res, 'story-batchChangeStage');
  }

  /** Actual story-status transitions offered to the signed-in user. */
  async storyStatusOptions(storyId) {
    const html = await this.#page(`/projectstory-view-${storyId}.html`);
    const options = [];
    if (/\/story-close-\d+\.html/i.test(html)) options.push({ key: 'closed', label: '关闭需求' });
    if (/\/story-activate-\d+\.html/i.test(html)) options.push({ key: 'active', label: '激活需求' });
    return options;
  }

  /** Change the actual story status, relying on ZenTao's own permission checks. */
  async changeStoryStatus(storyId, status) {
    const id = Number(storyId);
    if (status === 'closed') {
      const form = new URLSearchParams();
      form.set('closedReason', 'done');
      form.set('duplicateStory', '');
      form.set('childStories', '');
      form.set('status', 'closed');
      form.set('comment', '');
      const res = await this.post(`/story-close-${id}.html`, form);
      return parseFormResponse(res, 'story-close');
    }
    if (status === 'active') {
      const form = new URLSearchParams();
      form.set('status', 'active');
      form.set('comment', '');
      const res = await this.post(`/story-activate-${id}.html`, form);
      return parseFormResponse(res, 'story-activate');
    }
    return { ok: false, error: '当前不支持该需求状态流转' };
  }

  /** Resolve a bug (方案 = resolution). */
  async resolveBug(bugId, resolution, comment = '') {
    const form = new URLSearchParams();
    form.set('resolution', resolution);
    form.set('status', 'resolved');
    form.set('comment', comment);
    form.set('resolvedBuild', 'trunk');
    const res = await this.post(`/bug-resolve-${bugId}.html`, form);
    return parseFormResponse(res, 'bug-resolve');
  }

  /** Project status action: close|suspend|activate|start. */
  async changeProjectStatus(projectId, action) {
    const form = new URLSearchParams();
    form.set('comment', '');
    form.set('status', projectStatusValue(action));
    const res = await this.post(`/project-${action}-${projectId}.html`, form);
    return parseFormResponse(res, `project-${action}`);
  }

  /** Execution status action: close|suspend|activate|start. */
  async changeExecutionStatus(executionId, action) {
    const form = new URLSearchParams();
    form.set('comment', '');
    form.set('status', projectStatusValue(action));
    const res = await this.post(`/execution-${action}-${executionId}.html`, form);
    return parseFormResponse(res, `execution-${action}`);
  }
}

function projectStatusValue(action) {
  switch (action) {
    case 'close': return 'closed';
    case 'suspend': return 'suspended';
    case 'activate': return 'doing';
    case 'start': return 'doing';
    default: return action;
  }
}

function toForm(obj) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    form.set(k, String(v));
  }
  return form;
}

function randomUid() {
  return Math.random().toString(36).slice(2, 10);
}

function dedupeById(list) {
  const seen = new Set();
  return list.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function parseFormResponse(res, label) {
  const text = res.text || '';
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (json && typeof json === 'object') {
    if (json.result === 'success') {
      return {
        ok: true,
        id: json.id || json.idList ? Number(json.id || (json.idList && json.idList[0])) : null,
        idList: json.idList || undefined,
        message: typeof json.message === 'string' ? json.message : '',
        locate: json.locate || '',
      };
    }
    if (json.result === 'fail') {
      return { ok: false, message: normalizeMessage(json.message), error: normalizeMessage(json.message) };
    }
  }
  const looksLikeNavScript = text.length < 600 && !/失败|错误|error|denied|nopriv/i.test(text) && /(?:location|reload)\s*[.(=]/i.test(text);
  const success =
    (/保存成功|成功|success/i.test(text) && !/失败|error/i.test(text.slice(0, 200))) ||
    /(?:parent\.|top\.|self\.)?location(?:\.href)?\s*=/.test(text) ||
    /js::locate|window\.location/.test(text) ||
    looksLikeNavScript;
  const idm =
    text.match(/storyID=(\d+)/) ||
    text.match(/bugID=(\d+)/) ||
    text.match(/caseID=(\d+)/) ||
    text.match(/executionID=(\d+)/);
  if (success) return { ok: true, id: idm ? Number(idm[1]) : null, message: '操作成功', locate: '' };
  return { ok: false, message: `禅道返回异常（${label}）`, error: text.slice(0, 300) };
}

function normalizeMessage(message) {
  if (!message) return '操作失败';
  if (typeof message === 'string') return stripHtml(message);
  try {
    return stripHtml(JSON.stringify(message));
  } catch {
    return '操作失败';
  }
}
