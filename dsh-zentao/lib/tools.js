// Native-conversation tools for the ZenTao workbench.
//
// The plugin's custom chat panel can be switched off (`chatMode: native` in
// cordis.patch.yml); the DeepSeek conversation then drives ZenTao through the
// tool definitions below. Definitions are built by hand (no dsh-tools import,
// so the plugin keeps zero host dependencies) following the registry contract:
// `{ name, description, parameters, output: { schema, render }, execute }`.

const STATUS_ENUM = ['doing', 'suspended', 'closed'];

function ok(text, extra) {
  return Object.assign({ ok: true, summary: text }, extra || {});
}

function fail(text, extra) {
  return Object.assign({ ok: false, summary: text }, extra || {});
}

function preview(items, label, mapItem) {
  if (!items.length) return `没有${label}。`;
  const lines = items.slice(0, 20).map((item, index) => `${index + 1}. ${mapItem(item)}`);
  const more = items.length > 20 ? `\n…共 ${items.length} 条` : '';
  return lines.join('\n') + more;
}

/**
 * @param deps - host services the tools are allowed to use.
 * @param deps.client - ZenTaoClient
 * @param deps.statusOptions - STATUS_OPTIONS from index.js
 * @param deps.changeStatus - the host's status-change helper
 * @param deps.createItem - the host's story/bug creation helper
 * @returns tool definitions accepted by ctx.tools.register()
 */
export function createZenTaoTools(deps) {
  const { client, statusOptions, changeStatus, createItem } = deps;
  const invalidate = typeof deps.invalidate === 'function' ? deps.invalidate : () => {};
  const bump = (...prefixes) => prefixes.forEach((prefix) => invalidate(prefix));
  const tools = [];

  // ── read-only ────────────────────────────────────────────────────────────
  tools.push({
    name: 'zentao_list_projects',
    description:
      'List ZenTao projects visible to the signed-in account. Use this before any project-scoped action when the user did not name a project id.',
    parameters: {
      type: 'object',
      properties: {
        includeClosed: { type: 'boolean', description: 'Include closed/suspended projects (default false).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          projects: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer' },
                name: { type: 'string' },
                status: { type: 'string' },
              },
              required: ['id', 'name', 'status'],
            },
          },
        },
        required: ['ok', 'summary', 'projects'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const projects = await client.projects();
      const list = args.includeClosed ? projects : projects.filter((p) => p.status !== 'closed');
      const rows = list.map((p) => ({ id: Number(p.id), name: p.name, status: p.statusText || p.status }));
      return ok(preview(rows, '可见项目', (p) => `#${p.id} ${p.name}（${p.status}）`).replace(/^\d+\. /gm, '- '), { projects: rows });
    },
  });

  tools.push({
    name: 'zentao_list_iterations',
    description: 'List the iterations (executions) of one ZenTao project.',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'integer', description: 'ZenTao project id.' },
        includeClosed: { type: 'boolean', description: 'Include closed/suspended iterations (default false).' },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          iterations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer' },
                name: { type: 'string' },
                status: { type: 'string' },
              },
              required: ['id', 'name', 'status'],
            },
          },
        },
        required: ['ok', 'summary', 'iterations'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const list = await client.executions(Number(args.projectId));
      const rows = list
        .filter((e) => args.includeClosed || e.status !== 'closed')
        .map((e) => ({ id: Number(e.id), name: e.name, status: e.statusText || e.status }));
      return ok(preview(rows, '迭代', (e) => `#${e.id} ${e.name}（${e.status}）`).replace(/^\d+\. /gm, '- '), { iterations: rows });
    },
  });

  tools.push({
    name: 'zentao_list_work_items',
    description: 'List the stories or bugs of one ZenTao iteration.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['story', 'bug'], description: 'story or bug.' },
        executionId: { type: 'integer', description: 'ZenTao iteration id.' },
      },
      required: ['kind', 'executionId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer' },
                title: { type: 'string' },
                status: { type: 'string' },
                assignedTo: { type: 'string' },
                priority: { type: 'string' },
              },
              required: ['id', 'title', 'status', 'assignedTo', 'priority'],
            },
          },
        },
        required: ['ok', 'summary', 'items'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const executionId = Number(args.executionId);
      const raw = args.kind === 'bug' ? await client.bugs(executionId) : await client.stories(executionId);
      const rows = raw.map((item) => ({
        id: Number(item.id),
        title: item.title,
        status: item.type === 'bug' ? item.resolution || item.statusText || '' : item.stage || item.statusText || '',
        assignedTo: item.assignedTo || '',
        priority: item.priority ? 'P' + item.priority : '',
      }));
      const label = args.kind === 'bug' ? 'BUG' : '研发需求';
      return ok(
        preview(rows, label, (item) => `#${item.id} ${item.title}（${item.status || '—'}${item.assignedTo ? ' / ' + item.assignedTo : ''}）`).replace(/^\d+\. /gm, '- '),
        { items: rows },
      );
    },
  });

  // ── iteration status (permission/state aware) ────────────────────────────
  tools.push({
    name: 'zentao_change_iteration_status',
    description:
      'Change one ZenTao iteration status. The tool checks which transitions this account may perform and refuses impossible ones, returning the allowed statuses instead.',
    parameters: {
      type: 'object',
      properties: {
        executionId: { type: 'integer', description: 'ZenTao iteration id.' },
        status: { type: 'string', enum: STATUS_ENUM, description: 'doing | suspended | closed.' },
      },
      required: ['executionId', 'status'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          allowedStatuses: {
            type: 'array',
            items: { type: 'string', enum: STATUS_ENUM },
          },
        },
        required: ['ok', 'summary'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const executionId = Number(args.executionId);
      const status = String(args.status);
      const actions = await client.executionActions(executionId).catch(() => []);
      // Derive the current phase from the actions ZenTao offers (wait has start,
      // suspended/closed have activate, in-progress has close/suspend).
      const currentKey = actions.includes('start')
        ? 'wait'
        : actions.includes('activate')
          ? 'closed'
          : actions.includes('close') || actions.includes('suspend')
            ? 'doing'
            : '';
      const allowed = allowedStatuses(actions);
      if (currentKey === status) {
        return ok(`迭代 #${executionId} 当前已经是「${statusLabel(status)}」，无需修改。`);
      }
      const needed =
        status === 'closed'
          ? 'close'
          : status === 'suspended'
            ? 'suspend'
            : currentKey === 'wait'
              ? 'start'
              : 'activate';
      if (actions.length && !actions.includes(needed)) {
        return fail(
          `禅道当前不允许把迭代 #${executionId} 改为「${statusLabel(status)}」（可能没有权限或需要先走别的状态）。可选：${allowed
            .map(statusLabel)
            .join('、')}`,
          { allowedStatuses: allowed },
        );
      }
      const result = await client.changeExecutionStatus(executionId, needed);
      if (!result.ok) {
        return fail(`修改失败：${result.error || result.message || '禅道拒绝了这次状态变更'}`, { allowedStatuses: allowed });
      }
      bump('tree', 'exec:', 'items:');
      return ok(`已将迭代 #${executionId} 的状态改为「${statusLabel(status)}」。`);
    },
  });

  // ── work item status / assignee ──────────────────────────────────────────
  tools.push({
    name: 'zentao_change_work_item_status',
    description: 'Change a story stage or a bug resolution in ZenTao.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['story', 'bug'], description: 'story or bug.' },
        id: { type: 'integer', description: 'ZenTao story/bug id.' },
        statusKey: { type: 'string', description: 'Target status key, e.g. developing / testing / fixed / bydesign.' },
      },
      required: ['kind', 'id', 'statusKey'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, summary: { type: 'string' } },
        required: ['ok', 'summary'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const result = await changeStatus({
        targetType: args.kind === 'bug' ? 'bug' : 'story',
        id: Number(args.id),
        statusKey: String(args.statusKey),
      });
      if (!result.ok) return fail(`修改失败：${result.error || result.message || '禅道拒绝了这次状态变更'}`);
      bump('items:');
      return ok(`已将${args.kind === 'bug' ? 'BUG' : '需求'} #${args.id} 的状态改为「${result.label || args.statusKey}」。`);
    },
  });

  tools.push({
    name: 'zentao_assign_work_item',
    description: 'Re-assign a story or bug to a project member. Use zentao_assign_options first to list valid accounts.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['story', 'bug'], description: 'story or bug.' },
        id: { type: 'integer', description: 'ZenTao story/bug id.' },
        assignedTo: { type: 'string', description: 'ZenTao account, e.g. zhangsan.' },
      },
      required: ['kind', 'id', 'assignedTo'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, summary: { type: 'string' } },
        required: ['ok', 'summary'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const result = await client.assignItem(args.kind === 'bug' ? 'bug' : 'story', Number(args.id), String(args.assignedTo));
      if (!result.ok) return fail(`指派失败：${result.error || result.message || '禅道拒绝了这次指派'}`);
      bump('items:', 'assign:');
      return ok(`已把${args.kind === 'bug' ? 'BUG' : '需求'} #${args.id} 指派给 ${args.assignedTo}。`);
    },
  });

  tools.push({
    name: 'zentao_assign_options',
    description: 'List assignable accounts for one story/bug (project team members).',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['story', 'bug'], description: 'story or bug.' },
        id: { type: 'integer', description: 'ZenTao story/bug id.' },
      },
      required: ['kind', 'id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          users: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { value: { type: 'string' }, label: { type: 'string' } },
              required: ['value', 'label'],
            },
          },
        },
        required: ['ok', 'summary', 'users'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const data = await client.assignOptions(args.kind === 'bug' ? 'bug' : 'story', Number(args.id));
      const users = (data.users || []).filter((user) => user.value && user.value !== 'closed');
      return ok(
        users.length ? '可指派：' + users.map((user) => `${user.label}(${user.value})`).join('、') : '没有可指派的成员。',
        { users },
      );
    },
  });

  // ── creation ─────────────────────────────────────────────────────────────
  tools.push({
    name: 'zentao_create_iteration',
    description: 'Create an iteration under a ZenTao project. Suggest a name following the project’s existing naming pattern before calling this.',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'integer', description: 'ZenTao project id.' },
        name: { type: 'string', description: 'Iteration name.' },
        begin: { type: 'string', description: 'Start date YYYY-MM-DD (default today).' },
        end: { type: 'string', description: 'End date YYYY-MM-DD (default +14 days).' },
      },
      required: ['projectId', 'name'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          executionId: { type: 'integer' },
        },
        required: ['ok', 'summary'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const result = await client.createExecution({
        projectId: Number(args.projectId),
        name: String(args.name),
        begin: args.begin,
        end: args.end,
      });
      if (!result.ok) return fail(`创建迭代失败：${result.error || result.message || '禅道拒绝创建'}`);
      bump('tree', 'exec:');
      return ok(
        `已创建迭代「${result.name || args.name}」` +
          (result.begin ? `（${result.begin} ~ ${result.end}，${result.days} 个工作日）` : '') +
          (result.id ? `，id #${result.id}` : ''),
        result.id ? { executionId: Number(result.id) } : {},
      );
    },
  });

  async function createWorkItem(kind, args) {
    const executionId = Number(args.executionId);
    const formPath =
      kind === 'bug'
        ? `/bug-create-0-0-executionID=${executionId}.html`
        : `/story-create-0-0-0-0-${executionId}.html`;
    let productId = 0;
    try {
      const options = await client.formOptions(formPath);
      const selected = (options.product || []).find((option) => option.selected) || (options.product || [])[0];
      productId = Number(selected && selected.value) || 0;
    } catch (error) {
      productId = 0;
    }
    if (!productId) return fail('没有读到该迭代关联的产品，无法创建（请先在禅道里关联产品）。');
    const result = await createItem({
      kind,
      productId,
      projectId: Number(args.projectId || 0),
      executionId,
      title: String(args.title || ''),
      description: String(args.description || ''),
      steps: kind === 'bug' ? [String(args.steps || args.description || ''), args.expected ? '\n\n期望结果：' + args.expected : ''].join('') : undefined,
      acceptance: kind === 'story' ? String(args.acceptance || '') : undefined,
      priority: Number(args.priority || 3),
    });
    if (!result.ok) return fail(`创建失败：${result.error || result.message || '禅道拒绝创建'}`);
    bump('items:', 'tree');
    return ok(`已创建${kind === 'bug' ? 'BUG' : '研发需求'}「${args.title}」${result.id ? '，id #' + result.id : ''}。`, {
      itemId: result.id ? Number(result.id) : undefined,
    });
  }

  tools.push({
    name: 'zentao_create_story',
    description: 'Create a research requirement (story) in one ZenTao iteration.',
    parameters: {
      type: 'object',
      properties: {
        executionId: { type: 'integer', description: 'ZenTao iteration id.' },
        projectId: { type: 'integer', description: 'ZenTao project id (optional).' },
        title: { type: 'string', description: 'Story title.' },
        description: { type: 'string', description: 'Story description.' },
        acceptance: { type: 'string', description: 'Acceptance criteria.' },
        priority: { type: 'integer', description: 'Priority 1-4 (default 3).' },
      },
      required: ['executionId', 'title'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, summary: { type: 'string' }, itemId: { type: 'integer' } },
        required: ['ok', 'summary'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    execute: (args) => createWorkItem('story', args),
  });

  tools.push({
    name: 'zentao_create_bug',
    description: 'Create a bug in one ZenTao iteration.',
    parameters: {
      type: 'object',
      properties: {
        executionId: { type: 'integer', description: 'ZenTao iteration id.' },
        projectId: { type: 'integer', description: 'ZenTao project id (optional).' },
        title: { type: 'string', description: 'Bug title.' },
        description: { type: 'string', description: 'Bug description.' },
        steps: { type: 'string', description: 'Reproduction steps.' },
        expected: { type: 'string', description: 'Expected result.' },
        priority: { type: 'integer', description: 'Priority 1-4 (default 3).' },
      },
      required: ['executionId', 'title'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, summary: { type: 'string' }, itemId: { type: 'integer' } },
        required: ['ok', 'summary'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    execute: (args) => createWorkItem('bug', args),
  });

  return tools;
}

function statusLabel(status) {
  return status === 'closed' ? '已关闭' : status === 'suspended' ? '已挂起' : '进行中';
}

function allowedStatuses(actions) {
  const set = new Set(actions || []);
  const allowed = [];
  if (set.has('start') || set.has('activate')) allowed.push('doing');
  if (set.has('suspend')) allowed.push('suspended');
  if (set.has('close')) allowed.push('closed');
  return allowed.length ? allowed : STATUS_ENUM.slice();
}
