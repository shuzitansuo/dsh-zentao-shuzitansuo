// Scenario engine for the ZenTao workbench chat.
// Deterministic wizard steps + DeepSeek calls for wording, so every write is
// explicit and confirmed before it reaches ZenTao.

// Keep the two ZenTao rich-text fields separate from the very first draft.
// `description` is posted as `spec`; `acceptance` is posted as `verify`.
const STORY_JSON = '{"title":"...","description":"...","acceptance":"..."}';
const BUG_JSON = '{"title":"...","description":"...","steps":"...","expected":"...","priority":3}';

export function createChatEngine(deps) {
  const conversations = new Map();
  const zt = deps.zentao;
  const statusOptions = deps.statusOptions || {};
  const usageRecord = typeof deps.usageRecord === 'function' ? deps.usageRecord : null;
  const usageRank = typeof deps.usageRank === 'function' ? deps.usageRank : null;
  const zentaoApi = deps.zentaoApi || null;
  const createItem = typeof deps.createItem === 'function' ? deps.createItem : null;
  const createExecution = typeof deps.createExecution === 'function' ? deps.createExecution : null;
  const changeStatus = typeof deps.changeStatus === 'function' ? deps.changeStatus : null;

  const stateOf = (id) => {
    if (!conversations.has(id)) conversations.set(id, { flow: null, step: null, data: {}, history: [] });
    return conversations.get(id);
  };

  const say = (emit, text) => emit({ type: 'delta', text });
  const card = (emit, kind, data) => emit({ type: 'card', card: { kind, data } });
  const choices = (emit, id, options) => card(emit, 'choices', { id, options });

  async function model() {
    const llm = deps.llm;
    if (!llm) throw new Error('DeepSeek 模型服务不可用');
    const sel = deps.selection || {};
    const provider = sel.provider || sel.providerId || sel.route;
    const name = sel.model || sel.modelId || sel.id;
    if (!provider || !name) throw new Error('尚未选择默认模型，请在设置中选择 DeepSeek 模型');
    return { llm, provider, model: name };
  }

  async function complete(system, prompt, { temperature = 0.3, maxTokens = 1800 } = {}) {
    const route = await model();
    const chunks = route.llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      temperature,
      maxTokens,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    });
    let text = '';
    for await (const chunk of chunks) {
      if (chunk && chunk.type === 'text-delta') text += chunk.text;
      if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        throw new Error(chunk.reason.failure?.message || '模型调用失败');
      }
    }
    return text;
  }

  async function stream(system, prompt, emit, { temperature = 0.6, maxTokens = 1500 } = {}) {
    const route = await model();
    const chunks = route.llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      temperature,
      maxTokens,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    });
    let text = '';
    for await (const chunk of chunks) {
      if (chunk && chunk.type === 'text-delta') {
        text += chunk.text;
        emit({ type: 'delta', text: chunk.text });
      }
      if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        throw new Error(chunk.reason.failure?.message || '模型调用失败');
      }
    }
    return text;
  }

  function jsonOf(text) {
    if (!text) return null;
    const fenced = text.replace(/```(?:json)?/gi, '').trim();
    const start = fenced.indexOf('{');
    const end = fenced.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(fenced.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  async function askJson(system, prompt) {
    const first = await complete(system, prompt);
    let parsed = jsonOf(first);
    if (!parsed) {
      const second = await complete(system + '\n只输出一个合法 JSON 对象，不要任何解释或代码块。', prompt);
      parsed = jsonOf(second);
    }
    if (!parsed) throw new Error('模型没有返回可解析的 JSON，请重试');
    return parsed;
  }

  function contextBlock(contexts) {
    if (!contexts || !contexts.length) return '（无附件上下文）';
    return contexts
      .map((item, index) => {
        const head = `【上下文${index + 1}】类型：${labelOfType(item.type)}；编号：${item.id}；标题：${item.title}`;
        const body = item.description ? `\n内容：\n${item.description.slice(0, 6000)}` : '';
        return head + body;
      })
      .join('\n\n');
  }

  function labelOfType(type) {
    return { project: '项目', execution: '迭代', story: '研发需求', bug: 'BUG' }[type] || type;
  }

  function selectionBlock(selection) {
    if (!selection) return '（当前未选择项目/迭代）';
    return `当前项目：${selection.projectName || '-'}（#${selection.projectId || '-'}）；当前迭代：${selection.executionName || '-'}（#${selection.executionId || '-'}）`;
  }

  // ---------- wizard entry ----------

  async function handle(input, emit) {
    const convId = input.conversationId || 'default';
    if (input.action && input.action.type === 'reset') {
      conversations.delete(convId);
      emit({ type: 'done' });
      return;
    }
    const st = stateOf(convId);
    const text = String(input.text || '').trim();
    const action = input.action || null;
    const edit = input.edit && typeof input.edit === 'object' ? input.edit : null;
    const contexts = Array.isArray(input.contexts) ? input.contexts : [];
    const selection = input.selection || {};
    st.history.push({ role: 'user', text: text || (action && action.value) || '' });

    try {
      if (action && action.type === 'quick') {
        await startFlow(st, action.value, text, selection, emit, {
          docItems: Array.isArray(input.docItems) ? input.docItems : null,
          docName: String(input.docName || ''),
        });
      } else if (st.flow) {
        await step(st, { text, action, contexts, selection, edit }, emit);
      } else {
        const intent = detectIntent(text);
        if (intent) await startFlow(st, intent, text, selection, emit);
        else await general(st, text, contexts, selection, emit);
      }
    } finally {
      emit({ type: 'done' });
    }
  }

  function detectIntent(text) {
    if (!text) return null;
    if (/用例|测试用例/.test(text)) return 'testcase';
    if (/(状态|阶段|方案)/.test(text) && /(改|变|设|调|换|关|停|开|挂|激)/.test(text)) return 'status';
    if (/(迭代|执行|项目).*(开始|启动|关闭|关掉|挂起|暂停|激活|恢复|结束|完成|归档)|(开始|启动|关闭|关掉|挂起|暂停|激活|恢复|归档).{0,4}(迭代|执行|项目)/.test(text)) {
      return 'status';
    }
    if (
      /(加入|添加|新增|新建|创建|录入|提|报|记|加).{0,6}(bug|缺陷|问题单)/i.test(text) ||
      /(bug|缺陷|问题单).{0,6}(加入|添加|新增|新建|创建|录入)/i.test(text)
    ) {
      return 'bug';
    }
    if (
      /(加入|添加|新增|新建|创建|录入|提|报|记|加).{0,6}(需求|story)/i.test(text) ||
      /(需求|story).{0,6}(加入|添加|新增|新建|创建|录入)/i.test(text)
    ) {
      return 'story';
    }
    // Check the object being created before treating “迭代” as an action.
    // For example, “在这个迭代下创建一个需求” creates a story *in* an
    // iteration; it does not create another iteration.
    if (/(创建|新增|添加|新建).{0,6}(迭代|执行|sprint)|(迭代|执行).{0,6}(创建|新增|添加|新建)/i.test(text)) return 'execution';
    if (zentaoApi && /(查询|查一下|查下|查看|列出|列一下|有哪些|多少个|多少条|统计|搜索|找一下|拉一下|看下|看看|列表)/.test(text)) {
      return 'api';
    }
    return null;
  }

  async function startFlow(st, flow, text, selection, emit, extra = {}) {
    st.data = { selection, contexts: [] };
    // Writing always starts by confirming the target project/iteration, even
    // when one is already selected in the tree: this prevents the assistant
    // from silently writing into a previously selected iteration.
    if (flow === 'story' || flow === 'bug') {
      st.flow = flow;
      st.step = 'target';
      st.data.pendingText = seedText(text);
      // "在这个迭代下加入需求…" already names the target: skip the confirmation
      // and go straight to drafting (the push still needs confirmation).
      const refersToThisIteration = /((这个|该|当前|此)\s*(迭代|执行))|((这个|该|当前|此)\s*(迭代|执行)\s*(下|里|内))/.test(text || '');
      const ctxExec = (Array.isArray(selection.contexts) ? selection.contexts : []).find(
        (ctx) => ctx && ctx.type === 'execution' && ctx.id,
      );
      const target = ctxExec
        ? {
            projectId: Number(ctxExec.projectId) || Number(selection.projectId) || 0,
            projectName: ctxExec.projectName || selection.projectName || '',
            executionId: Number(ctxExec.id),
            executionName: ctxExec.title || ctxExec.title || '',
          }
        : selection.executionId
          ? {
              projectId: Number(selection.projectId) || 0,
              projectName: selection.projectName || '',
              executionId: Number(selection.executionId),
              executionName: selection.executionName || '',
            }
          : null;
      if (target && refersToThisIteration) {
        // With content already provided, draft and go straight to the write
        // confirmation instead of asking about polishing first.
        if (st.data.pendingText) st.data.autoDraft = true;
        return await applyTarget(st, target, emit);
      }
      return await askTarget(st, emit);
    }
    if (flow === 'execution') {
      st.flow = 'execution';
      st.step = 'project';
      st.data = { selection, contexts: [], projects: [], pendingName: parseExecutionName(text) };
      const ctxs = Array.isArray(selection.contexts) ? selection.contexts : [];
      const projectCtx = ctxs.find((c) => c && c.type === 'project' && c.id);
      if (projectCtx) {
        st.data.project = { id: Number(projectCtx.id), name: String(projectCtx.title || '#' + projectCtx.id) };
        return await askExecutionName(st, st.data.project, emit);
      }
      // "在数字探索CMS下新增迭代" already names the project: skip the picker.
      if (text) {
        try {
          const projects = await zt.projects();
          const doing = projects.filter((project) => project.status === 'doing');
          const hits = doing.filter((project) => text.includes(project.name) || project.name.includes(text.trim()));
          if (hits.length === 1) {
            st.data.project = { id: hits[0].id, name: hits[0].name };
            return await askExecutionName(st, st.data.project, emit);
          }
        } catch (error) {
          /* fall through to the project picker */
        }
      }
      return await askProjects(st, emit);
    }
    if (flow === 'testcase') {
      st.flow = 'case';
      st.step = 'story';
      const ctxs = Array.isArray(selection.contexts) ? selection.contexts : [];
      const storyCtx = ctxs.find((c) => c && c.type === 'story');
      if (storyCtx && storyCtx.id) return await beginCaseForStory(st, storyCtx.id, emit);
      const execCtx = ctxs.find((c) => c && c.type === 'execution');
      if (execCtx && execCtx.id) return await offerStoriesOfExecution(st, execCtx, emit);
      say(emit, '好的，我来生成测试用例。请把目标需求拖进输入框，或直接告诉我需求 ID / 标题（拖入迭代也可以，我会列出该迭代下的需求）。');
      return;
    }
    if (flow === 'doc') {
      const docItems = (extra.docItems || [])
        .filter((item) => item && typeof item.title === 'string' && item.title.trim())
        .map((item) => ({ title: String(item.title).trim().slice(0, 120), description: String(item.description || '').slice(0, 20000) }))
        .slice(0, 30);
      if (!docItems.length) {
        say(emit, '没有从文档里解析出需求内容，换一个文件再试。');
        resetFlow(st);
        return;
      }
      st.flow = 'doc';
      st.step = 'target';
      st.data = { selection, contexts: [], docItems, docName: extra.docName || '' };
      return await askTarget(st, emit);
    }
    if (flow === 'api') {
      st.flow = 'api';
      st.step = 'api-plan';
      return await planApiQuery(st, text, selection, emit);
    }
    if (flow === 'status') {
      st.flow = 'status';
      st.step = 'parse';
      const ctxs = Array.isArray(selection.contexts) ? selection.contexts : [];
      const ctxObj = ctxs.find((c) => c && ['story', 'bug', 'project', 'execution'].includes(c.type) && c.id);
      if (ctxObj) {
        return await beginStatusForContext(st, ctxObj, text, emit);
      }
      if (text) return await parseStatus(st, text, selection, emit);
      say(emit, '请告诉我要修改哪个对象的状态，例如「DSH-禅道-v0.0.1 迭代状态改为已挂起」或「需求 072 状态改为研发中」，也可以直接把对象拖进输入框。');
      return;
    }
  }

  // "在这下面创建一个迭代，迭代名称 test-v0.0.1" already names the iteration:
  // create it directly instead of asking again.
  function parseExecutionName(text) {
    const value = String(text || '');
    const patterns = [
      /(?:迭代|执行|版本|sprint)[\s，,]*?(?:名称|名字)\s*(?:[:：叫是为])?\s*[「"“']?([^\s，,。；;「」"”'）)]+)[」"”']?/i,
      /(?:名称|名字)\s*(?:叫|是|为|：|:)\s*[「"“']?([^\s，,。；;「」"”'）)]+)[」"”']?/,
      /(?:命名为|叫做|名叫)\s*[「"“']?([^\s，,。；;「」"”'）)]+)[」"”']?/,
      /(?:创建|新建|新增|添加)\s*(?:一个|一条|个|条)?\s*(?:迭代|执行|sprint)\s*[「"“']?([^\s，,。；;「」"”'）)]+)[」"”']?/i,
      /(?:迭代|执行)\s*[「"“']([^」"”']+)[」"”']/,
    ];
    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (!match || !match[1]) continue;
      const name = match[1].trim().replace(/[。，,；;]+$/, '');
      if (!name || name.length > 60) continue;
      if (/^(一个|个|条|名称|名字|叫|是|为|吗|呢|吧)$/.test(name)) continue;
      return name;
    }
    return '';
  }

  function seedText(text) {
    if (!text) return '';
    const cleaned = text
      // Commands such as "在这下面新增一个研发需求" identify a target,
      // but are not themselves a requirement description.
      .replace(/^在(?:这|当前|该|此)?(?:个)?(?:迭代|执行)?(?:下面|下|里|内)\s*[，,：:、\s]*/i, '')
      .replace(/^在[^，,。；;]{0,24}?下[，,：:、\s]*/, '')
      .replace(/^(请|帮我|给我)?(加入|添加|新增|新建|创建|录入|提|报|记|加)(一个|一条|个|条)?(研发)?(需求|story)[:：,，\s]*/i, '')
      .replace(/^(请|帮我|给我)?(加入|添加|新增|新建|创建|录入|提|报|记|加)(一个|一条|个|条)?(bug|缺陷|问题单)[:：,，\s]*/i, '')
      .trim();
    return cleaned.length >= 2 ? cleaned : '';
  }

  // ---------- target selection ----------

  let targetCache = null;

  async function loadTargets(force = false) {
    if (!force && targetCache && Date.now() - targetCache.at < 60000) return targetCache.items;
    const items = [];
    try {
      const projects = await zt.projects();
      for (const project of projects) {
        let execs = [];
        try {
          execs = await zt.executions(project.id);
        } catch (error) {
          execs = [];
        }
        for (const exec of execs) {
          if (!exec || !exec.id) continue;
          items.push({
            projectId: Number(project.id),
            projectName: project.name,
            executionId: Number(exec.id),
            executionName: exec.name,
            status: exec.status,
            label: project.name + ' / ' + exec.name,
          });
        }
      }
    } catch (error) {
      /* project list unavailable */
    }
    targetCache = { at: Date.now(), items };
    return items;
  }

  // Everyday iterations first: rank by how often and how recently the user
  // picked a target, capped to a short "frequent" block.
  const FREQUENT_LIMIT = 5;

  async function rankTargets(targets) {
    if (!usageRank) return { items: targets.slice(), frequent: new Set() };
    let rank = {};
    try {
      rank = (await usageRank()) || {};
    } catch (error) {
      rank = {};
    }
    const score = (target) => rank[String(target.executionId)] || null;
    const pinned = targets.filter((target) => score(target));
    const rest = targets.filter((target) => !score(target));
    pinned.sort((a, b) => {
      const left = score(a);
      const right = score(b);
      return right.count - left.count || right.lastUsedAt - left.lastUsedAt;
    });
    const top = pinned.slice(0, FREQUENT_LIMIT);
    const frequent = new Set(top.map((target) => String(target.executionId)));
    return { items: top.concat(pinned.slice(FREQUENT_LIMIT), rest), frequent };
  }

  function recordTargetUsage(target) {
    if (!usageRecord || !target) return;
    try {
      const pending = usageRecord({
        executionId: target.executionId,
        projectId: target.projectId,
        executionName: target.executionName,
        projectName: target.projectName,
      });
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (error) {
      /* usage ranking is best-effort */
    }
  }

  async function askTarget(st, emit) {
    emit({ type: 'status', text: '正在读取项目/迭代…' });
    const targets = await loadTargets();
    st.data.targets = targets;
    const kind = st.flow === 'bug' ? 'BUG' : '研发需求';
    if (!targets.length) {
      say(emit, '没有读到可用的项目/迭代，请先在左侧选择一个迭代，或确认你的禅道账号有项目权限。');
      cancelFlow(st, emit);
      return;
    }
    // The tree selection is a guessed target; confirm it explicitly before
    // writing, so a stale selection can never receive a new story/bug silently.
    const selection = st.data.selection || {};
    const currentExec = Number(selection.executionId) || 0;
    const found = currentExec ? targets.find((t) => t.executionId === currentExec) : null;
    // A closed iteration cannot receive new stories/bugs: skip its confirmation.
    const current = found && found.status !== 'closed' ? found : null;
    if (current) {
      st.data.targetAsk = 'confirm';
      st.data.currentTarget = current;
      say(emit, `这次要在当前迭代「${current.executionName}」下录入${kind}吗？`);
      choices(emit, 'target-confirm', [
        { value: 'use-current', label: `是，在「${current.executionName}」下录入`, tone: 'primary' },
        { value: 'choose-other', label: '不是，换一个迭代' },
      ]);
      return;
    }
    return await showTargetPicker(st, emit, kind);
  }

  async function showTargetPicker(st, emit, kindArg) {
    const targets = st.data.targets || [];
    const kind = kindArg || (st.flow === 'bug' ? 'BUG' : '研发需求');
    const current = st.data.currentTarget || null;
    const currentExec = current ? current.executionId : 0;
    // Closed iterations are not writable targets; never list them.
    const openTargets = targets.filter((t) => t.status !== 'closed');
    const others = openTargets.filter((t) => t.executionId !== currentExec);
    if (!others.length) {
      if (current) {
        say(emit, `当前只有「${current.executionName}」这一个未关闭的迭代可用，继续在它下面录入。`);
        return await applyTarget(st, current, emit);
      }
      say(
        emit,
        '没有可选的未关闭迭代。可以把左侧目录树里的迭代直接拖拽到对话框里，我会用它作为写入目标；也可以稍后回复迭代名称。',
      );
      return;
    }
    const ranked = await rankTargets(others);
    const visible = ranked.items.slice(0, 10);
    st.data.targets = visible;
    say(emit, `请选择要写入的其他项目/迭代${ranked.frequent.size ? '（常用的排在最前面）' : ''}：`);
    choices(
      emit,
      'target',
      visible.map((t) => ({
        value: 'target:' + t.projectId + ':' + t.executionId,
        label: t.label + (ranked.frequent.has(String(t.executionId)) ? '（常用）' : ''),
      })),
    );
    if (ranked.items.length > visible.length) {
      say(emit, `列表只展示前 10 个迭代；其余的可以从左侧目录树直接拖进对话框，或直接回复迭代名称/编号。`);
    } else {
      say(emit, '没有找到想要的迭代？把左侧目录树里的迭代直接拖进对话框即可。');
    }
  }

  function matchTarget(targets, text) {
    const q = String(text || '').trim();
    if (!q) return null;
    const exact = targets.find((t) => t.executionName === q || t.projectName === q || t.label === q);
    if (exact) return exact;
    const idMatch = q.match(/#?(\d{1,6})/);
    if (idMatch) {
      const byId = targets.find((t) => t.executionId === Number(idMatch[1]));
      if (byId) return byId;
    }
    const fuzzy = targets.filter(
      (t) => t.executionName.indexOf(q) >= 0 || t.projectName.indexOf(q) >= 0 || q.indexOf(t.executionName) >= 0,
    );
    if (fuzzy.length === 1) return fuzzy[0];
    return null;
  }

  async function applyTarget(st, target, emit) {
    recordTargetUsage(target);
    st.data.selection = {
      projectId: target.projectId,
      projectName: target.projectName,
      executionId: target.executionId,
      executionName: target.executionName,
    };
    st.step = 'desc';
    const pending = st.data.pendingText || '';
    st.data.pendingText = '';
    say(emit, `已选择「${target.projectName} / ${target.executionName}」。`);
    if (st.flow === 'doc') {
      return await showDocPlan(st, target, emit);
    }
    if (pending) {
      return st.flow === 'bug'
        ? await bugDraft(st, pending, [], st.data.selection, emit)
        : await storyDraft(st, pending, [], st.data.selection, emit);
    }
    say(emit, st.flow === 'bug' ? '请描述 BUG 现象，最好包含触发条件与期望结果。' : '请描述需求内容（背景、目标、范围都可以）。');
  }

  async function handleTargetStep(st, ctx, emit) {
    const targets = st.data.targets || [];
    const action = ctx.action;
    const dragged = (Array.isArray(ctx.contexts) ? ctx.contexts : []).find((c) => c && c.type === 'execution' && c.id);
    if (dragged) {
      const known = targets.find((t) => t.executionId === Number(dragged.id)) || (st.data.currentTarget && st.data.currentTarget.executionId === Number(dragged.id) ? st.data.currentTarget : null);
      const target = known || {
        projectId: Number(dragged.projectId) || 0,
        projectName: String(dragged.projectName || ''),
        executionId: Number(dragged.id),
        executionName: String(dragged.title || ''),
      };
      return await applyTarget(st, target, emit);
    }
    const current = st.data.currentTarget || null;
    if (action && action.type === 'choice' && (action.value === 'use-current' || action.value === 'target-confirm:use-current')) {
      if (current) return await applyTarget(st, current, emit);
      return await showTargetPicker(st, emit);
    }
    if (action && action.type === 'choice' && (action.value === 'choose-other' || action.value === 'target-confirm:choose-other')) {
      st.data.targetAsk = 'pick';
      return await showTargetPicker(st, emit);
    }
    // Free-text answer to the "use the current iteration?" question.
    if (st.data.targetAsk === 'confirm' && current) {
      const text = String(ctx.text || '').trim();
      if (/^(是|好|可以|行|对|确定|没问题|yes|y|嗯)/i.test(text)) return await applyTarget(st, current, emit);
      if (/^(不是|不|否|换|其他|换个|别)/.test(text)) {
        st.data.targetAsk = 'pick';
        return await showTargetPicker(st, emit);
      }
    }
    if (action && action.type === 'choice' && String(action.value).indexOf('target:') === 0) {
      const parts = String(action.value).split(':');
      const projectId = Number(parts[1]);
      const executionId = Number(parts[2]);
      const target = targets.find((t) => t.projectId === projectId && t.executionId === executionId);
      if (target) return await applyTarget(st, target, emit);
    }
    if (/取消|关闭/.test(ctx.text || '')) return cancelFlow(st, emit);
    const matched = matchTarget(targets, ctx.text);
    if (matched) return await applyTarget(st, matched, emit);
    say(emit, '请从上方列表选择一个项目/迭代（也可以回复迭代名称或编号），或回复「取消」。');
  }

  // ---------- story ----------

  async function storyDraft(st, text, contexts, selection, emit) {
    emit({ type: 'status', text: '正在整理需求草稿…' });
    let draft = null;
    try {
      draft = await askJson(
        '你是资深产品经理，负责把口语化描述整理成禅道研发需求。输出 JSON：' + STORY_JSON + '。title 不超过 30 字。description 只写需求描述，不要包含“验收标准”标题或验收条目；验收条目只能写入 acceptance。只输出 JSON。',
        `${selectionBlock(selection)}\n\n${contextBlock(contexts)}\n\n用户描述：\n${text}`,
      );
    } catch (error) {
      draft = fallbackDraft(text);
    }
    const normalized = splitStoryAcceptance(draft.description || text, draft.acceptance || '');
    st.data.draft = {
      title: draft.title || fallbackDraft(text).title,
      description: normalized.description || text,
      acceptance: normalized.acceptance,
    };
    st.data.source = text;
    st.step = 'polish';
    say(emit, '我先把你的描述整理成了草稿：');
    card(emit, 'draft', {
      title: st.data.draft.title,
      description: st.data.draft.description,
      acceptance: st.data.draft.acceptance,
      type: 'story',
    });
    if (st.data.autoDraft) {
      st.data.autoDraft = false;
      return await openConfirm(st, 'story', selection, emit);
    }
    say(emit, '确认草稿后可以直接推送，也可以取消。');
    choices(emit, 'polish', [
      { value: 'skip', label: '推送', tone: 'primary' },
      { value: 'cancel', label: '取消' },
    ]);
  }

  async function storyPolish(st, extra, emit) {
    emit({ type: 'status', text: '正在润色…' });
    const base = st.data.polished || st.data.draft;
    let polished = null;
    try {
      polished = await askJson(
        '你是资深产品经理。请润色研发需求，输出 JSON：{"title":"...","description":"...","acceptance":"验收标准，列表文本","priority":1,"module":"建议模块名或空字符串"}。priority 取 1-4。只输出 JSON。',
        `原标题：${base.title}\n原描述：\n${base.description}\n${extra ? '\n用户补充要求：' + extra : ''}`,
      );
    } catch (error) {
      polished = { ...base, acceptance: '', priority: 3, module: '' };
    }
    const normalized = splitStoryAcceptance(polished.description || base.description, polished.acceptance || '');
    st.data.polished = {
      title: polished.title || base.title,
      description: normalized.description || base.description,
      acceptance: normalized.acceptance,
      priority: clampPriority(polished.priority),
      module: polished.module || '',
    };
    st.step = 'review';
    say(emit, '润色完成，请确认：');
    card(emit, 'polish', {
      title: st.data.polished.title,
      description: st.data.polished.description,
      acceptance: st.data.polished.acceptance,
      priority: st.data.polished.priority,
      module: st.data.polished.module,
      type: 'story',
    });
    say(emit, '要「继续修改」还是「推送到禅道」？');
    choices(emit, 'review', [
      { value: 'modify', label: '继续修改' },
      { value: 'push', label: '推送到禅道', tone: 'primary' },
      { value: 'cancel', label: '取消' },
    ]);
  }

  // ---------- bug ----------

  async function bugDraft(st, text, contexts, selection, emit) {
    emit({ type: 'status', text: '正在整理 BUG 草稿…' });
    let draft = null;
    try {
      draft = await askJson(
        '你是测试工程师，负责把现象整理成禅道 BUG。输出 JSON：' + BUG_JSON + '。steps 是重现步骤（编号列表文本），expected 是期望结果。只输出 JSON。',
        `${selectionBlock(selection)}\n\n${contextBlock(contexts)}\n\n用户描述：\n${text}`,
      );
    } catch (error) {
      draft = { title: fallbackDraft(text).title, description: text, steps: text, expected: '', priority: 3 };
    }
    st.data.draft = {
      title: draft.title || fallbackDraft(text).title,
      description: draft.description || text,
      steps: draft.steps || text,
      expected: draft.expected || '',
      priority: clampPriority(draft.priority),
    };
    st.step = 'polish';
    say(emit, '我先把你的描述整理成了 BUG 草稿：');
    card(emit, 'draft', { ...st.data.draft, type: 'bug' });
    if (st.data.autoDraft) {
      st.data.autoDraft = false;
      return await openConfirm(st, 'bug', selection, emit);
    }
    say(emit, '确认草稿后可以直接推送，也可以取消。');
    choices(emit, 'polish', [
      { value: 'skip', label: '推送', tone: 'primary' },
      { value: 'cancel', label: '取消' },
    ]);
  }

  async function bugPolish(st, extra, emit) {
    emit({ type: 'status', text: '正在润色…' });
    const base = st.data.polished || st.data.draft;
    let polished = null;
    try {
      polished = await askJson(
        '你是测试工程师。请润色 BUG，输出 JSON：{"title":"...","description":"...","steps":"重现步骤","expected":"期望结果","priority":1,"module":"建议模块名或空字符串"}。只输出 JSON。',
        `原标题：${base.title}\n原描述：\n${base.description}\n原重现步骤：\n${base.steps}\n${extra ? '\n用户补充要求：' + extra : ''}`,
      );
    } catch (error) {
      polished = { ...base, module: '' };
    }
    st.data.polished = {
      title: polished.title || base.title,
      description: polished.description || base.description,
      steps: polished.steps || base.steps,
      expected: polished.expected || base.expected || '',
      priority: clampPriority(polished.priority),
      module: polished.module || '',
    };
    st.step = 'review';
    say(emit, '润色完成，请确认：');
    card(emit, 'polish', { ...st.data.polished, type: 'bug' });
    say(emit, '要「继续修改」还是「推送到禅道」？');
    choices(emit, 'review', [
      { value: 'modify', label: '继续修改' },
      { value: 'push', label: '推送到禅道', tone: 'primary' },
      { value: 'cancel', label: '取消' },
    ]);
  }

  // ---------- execution (iteration) creation ----------

  /** Suggest names by following the project's existing naming pattern. */
  function suggestExecutionNames(names) {
    const list = (names || []).map((name) => String(name || '').trim()).filter(Boolean);
    const seen = new Set(list);
    const out = [];
    const push = (name) => {
      if (name && !seen.has(name) && !out.includes(name)) out.push(name);
    };
    const versionRe = /^(.*?)(\d+)\.(\d+)\.(\d+)(\D*)$/;
    const groups = new Map();
    for (const name of list) {
      const m = name.match(versionRe);
      if (!m) continue;
      const key = m[1] + '\u0000' + m[5];
      if (!groups.has(key)) groups.set(key, { prefix: m[1], suffix: m[5], versions: [] });
      groups.get(key).versions.push([Number(m[2]), Number(m[3]), Number(m[4])]);
    }
    let best = null;
    for (const group of groups.values()) {
      if (!best || group.versions.length > best.versions.length) best = group;
    }
    if (best) {
      const sorted = best.versions.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      const [major, minor, patch] = sorted[sorted.length - 1];
      push(best.prefix + major + '.' + minor + '.' + (patch + 1) + best.suffix);
      push(best.prefix + major + '.' + (minor + 1) + '.0' + best.suffix);
    }
    if (out.length < 2) {
      const tailRe = /^(.*?)(\d+)(\D*)$/;
      const parsed = [];
      for (const name of list) {
        const m = name.match(tailRe);
        if (m) parsed.push({ prefix: m[1], value: Number(m[2]), suffix: m[3], name });
      }
      if (parsed.length) {
        parsed.sort((a, b) => b.value - a.value);
        const latest = parsed[0];
        push(latest.prefix + (latest.value + 1) + latest.suffix);
      }
    }
    return out.slice(0, 2);
  }

  async function askProjects(st, emit) {
    emit({ type: 'status', text: '正在读取进行中的项目…' });
    let projects = [];
    try {
      projects = await zt.projects();
    } catch (error) {
      say(emit, `读取项目失败：${error.message}`);
      cancelFlow(st, emit);
      return;
    }
    const doing = projects.filter((project) => project.status === 'doing');
    st.data.projects = doing;
    if (!doing.length) {
      say(emit, '没有读到进行中的项目，请确认你的禅道账号有项目权限，或在左侧树里选择迭代后重试。');
      cancelFlow(st, emit);
      return;
    }
    st.step = 'project';
    say(emit, '请选择要把新迭代创建到哪个项目（以下是你有权限且进行中的项目）：');
    choices(
      emit,
      'exec-project',
      doing.map((project) => ({ value: 'project:' + project.id, label: project.name })),
    );
    say(emit, '也可以直接回复项目名称或编号，或回复「取消」。');
  }

  async function askExecutionName(st, project, emit) {
    emit({ type: 'status', text: '正在读取该项目已有迭代…' });
    let list = [];
    try {
      list = await zt.executions(project.id);
    } catch (error) {
      list = [];
    }
    const names = list.map((execution) => execution.name);
    st.data.existingNames = names;
    if (st.data.pendingName) {
      const name = st.data.pendingName;
      st.data.pendingName = '';
      return await handleNameStep(st, { text: name, action: null }, emit);
    }
    const suggestions = suggestExecutionNames(names);
    st.data.suggestions = suggestions;
    st.step = 'name';
    if (names.length) {
      say(emit, `项目「${project.name}」现有迭代：${names.slice(-4).join('、')}。`);
    } else {
      say(emit, `项目「${project.name}」下还没有迭代。`);
    }
    say(emit, '请给新迭代命名：可以选择下面的建议，也可以直接输入名称（回复「取消」可放弃）。');
    const options = suggestions.map((name, index) => ({
      value: 'name:' + name,
      label: name,
      tone: index === 0 ? 'primary' : undefined,
    }));
    options.push({ value: 'cancel', label: '取消' });
    choices(emit, 'exec-name', options);
  }

  async function handleProjectStep(st, ctx, emit) {
    const projects = st.data.projects || [];
    const action = ctx.action;
    let picked = null;
    if (action && action.type === 'choice' && String(action.value).startsWith('project:')) {
      const id = Number(String(action.value).slice(8));
      picked = projects.find((project) => project.id === id) || null;
    }
    if (!picked && ctx.text) {
      const text = String(ctx.text).trim();
      if (/取消|关闭/.test(text)) return cancelFlow(st, emit);
      picked =
        projects.find((project) => project.name === text) ||
        projects.find((project) => String(project.id) === text) ||
        null;
      if (!picked) {
        const fuzzy = projects.filter((project) => project.name.includes(text) || text.includes(project.name));
        if (fuzzy.length === 1) picked = fuzzy[0];
      }
    }
    if (!picked) {
      say(emit, '请从上方列表选择一个项目（也可以回复项目名称/编号），或回复「取消」。');
      return;
    }
    st.data.project = { id: picked.id, name: picked.name };
    return await askExecutionName(st, st.data.project, emit);
  }

  async function handleNameStep(st, ctx, emit) {
    const action = ctx.action;
    let name = '';
    if (action && action.type === 'choice') {
      const value = String(action.value);
      if (value === 'cancel') return cancelFlow(st, emit);
      if (value.startsWith('name:')) name = value.slice(5);
    }
    if (!name && ctx.text) {
      const text = String(ctx.text).trim();
      if (/取消|关闭/.test(text)) return cancelFlow(st, emit);
      // The reply may still be a full sentence ("创建一个迭代，迭代名称 test-v0.0.1"):
      // take the explicit name instead of using the whole sentence as the title.
      const parsed = parseExecutionName(text);
      if (parsed) {
        name = parsed;
      } else if (
        /[，,。；;]/.test(text) ||
        text.length > 40 ||
        /(创建|新建|新增|添加|帮我|请帮|麻烦|一下|吧|呢|吗)/.test(text)
      ) {
        say(emit, '请只回复迭代名称（例如 test-v0.0.1），或回复「取消」放弃创建。');
        return;
      } else {
        name = text;
      }
    }
    if (!name) {
      say(emit, '请选择建议名称，或直接输入迭代名称（回复「取消」可放弃）。');
      return;
    }
    const existing = (st.data.existingNames || []).map((item) => String(item).toLowerCase());
    if (existing.includes(name.toLowerCase())) {
      say(emit, `项目下已存在名为「${name}」的迭代，请换一个名称后重试。`);
      return;
    }
    const project = st.data.project;
    emit({ type: 'status', text: '正在创建迭代…' });
    let result;
    try {
      result = await deps.createExecution({ projectId: project.id, name });
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    if (result && result.ok) {
      say(
        emit,
        `已在项目「${project.name}」下创建迭代「${result.name || name}」` +
          (result.begin ? `（起止 ${result.begin} ~ ${result.end}，${result.days} 个工作日）` : '') +
          '。',
      );
      card(emit, 'result', {
        ok: true,
        message: '创建成功',
        url: result.url || '',
        kind: 'execution',
        title: result.name || name,
        id: result.id || null,
        executionCreated: {
          projectId: project.id,
          projectName: project.name,
          executionId: result.id || 0,
          executionName: result.name || name,
        },
      });
    } else {
      const reason = (result && (result.error || result.message)) || '未知原因';
      say(emit, `创建迭代失败：${reason}`);
      card(emit, 'result', { ok: false, message: reason, kind: 'execution' });
    }
    st.flow = null;
    st.step = null;
    st.data = {};
  }

  // ---------- testcase ----------

  async function beginCaseForStory(st, storyId, emit) {
    const id = Number(storyId);
    let detail = null;
    try {
      detail = await zt.storyDetail(id);
    } catch (error) {
      say(emit, `读取需求 #${id} 失败：${error.message}`);
      st.step = 'story';
      return;
    }
    st.data.story = { id, title: detail.title, description: detail.description };
    st.step = 'case-mode';
    say(emit, `已读取需求 #${id}「${detail.title}」。`);
    card(emit, 'story', { id, title: detail.title });
    say(emit, '测试用例由你自己输入，还是由我自动生成？');
    choices(emit, 'case-mode', [
      { value: 'manual', label: '自己输入' },
      { value: 'auto', label: '自动生成', tone: 'primary' },
      { value: 'cancel', label: '取消' },
    ]);
  }

  async function offerStoriesOfExecution(st, execCtx, emit) {
    emit({ type: 'status', text: '正在读取该迭代的需求…' });
    let stories = [];
    try {
      stories = await zt.stories(execCtx.id);
    } catch (error) {
      stories = [];
    }
    if (!stories.length) {
      say(emit, `迭代「${execCtx.title}」下没有研发需求，请直接告诉我需求 ID 或标题。`);
      st.step = 'story';
      return;
    }
    say(emit, `已从上下文识别迭代「${execCtx.title}」，请选择要生成用例的需求：`);
    choices(
      emit,
      'story',
      stories.map((s) => ({ value: 'story:' + s.id, label: '#' + s.id + ' ' + s.title })),
    );
  }

  async function caseStory(st, text, emit) {
    const idMatch = text.match(/#?(\d{1,6})/);
    if (!idMatch) {
      say(emit, '请把目标需求拖进输入框，或告诉我需求 ID（例如 72）或标题。');
      return;
    }
    return await beginCaseForStory(st, Number(idMatch[1]), emit);
  }

  async function caseGenerate(st, extra, emit) {
    emit({ type: 'status', text: '正在生成测试用例…' });
    const story = st.data.story;
    const countMatch = (extra || '').match(/(\d{1,2})\s*条/);
    const count = countMatch ? Math.min(8, Math.max(1, Number(countMatch[1]))) : 3;
    let result = null;
    try {
      result = await askJson(
        `你是测试工程师。为需求生成 ${count} 条测试用例，默认 1 条正向、${Math.max(1, count - 1)} 条反向。输出 JSON：{"cases":[{"title":"...","precondition":"...","steps":[{"step":"...","expect":"..."}],"priority":1,"direction":"positive|negative"}]}。只输出 JSON。`,
        `需求标题：${story.title}\n需求内容：\n${story.description}\n${extra ? '\n用户补充要求：' + extra : ''}`,
      );
    } catch (error) {
      result = null;
    }
    const cases = Array.isArray(result?.cases) ? result.cases : [];
    if (!cases.length) {
      say(emit, '用例生成失败，请重试或补充需求细节。');
      st.step = 'story';
      return;
    }
    st.data.cases = cases.map((item, index) => ({
      title: item.title || `${story.title}-用例${index + 1}`,
      precondition: item.precondition || '',
      steps: normalizeSteps(item.steps),
      priority: clampPriority(item.priority),
      direction: item.direction === 'negative' ? 'negative' : 'positive',
    }));
    return presentCases(st, emit, `已自动生成 ${st.data.cases.length} 条测试用例：`);
  }

  function manualCases(st) {
    const text = String(st.data.manualText || '').trim();
    const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    return [{
      title: lines[0] || `${st.data.story.title} - 测试用例`,
      precondition: '',
      steps: normalizeSteps(lines.length > 1 ? lines.slice(1).join('\n') : text),
      priority: 3,
      direction: 'positive',
    }];
  }

  async function polishManualCases(st, emit) {
    emit({ type: 'status', text: '正在润色测试用例…' });
    let result = null;
    try {
      result = await askJson(
        '你是测试工程师。将用户手工输入的测试用例润色为结构化测试用例，不增加用户未表达的业务范围。输出 JSON：{"cases":[{"title":"...","precondition":"...","steps":[{"step":"...","expect":"..."}],"priority":1,"direction":"positive|negative"}]}。只输出 JSON。',
        `需求标题：${st.data.story.title}\n需求内容：\n${st.data.story.description}\n\n用户手工输入：\n${st.data.manualText}`,
      );
    } catch (error) {
      result = null;
    }
    const cases = Array.isArray(result?.cases) ? result.cases : [];
    st.data.cases = cases.length
      ? cases.map((item, index) => ({
          title: item.title || `${st.data.story.title}-用例${index + 1}`,
          precondition: item.precondition || '',
          steps: normalizeSteps(item.steps),
          priority: clampPriority(item.priority),
          direction: item.direction === 'negative' ? 'negative' : 'positive',
        }))
      : manualCases(st);
    return presentCases(st, emit, '已按你的输入整理测试用例：');
  }

  function presentCases(st, emit, message) {
    st.step = 'review';
    say(emit, message);
    card(emit, 'testcases', { cases: st.data.cases, storyId: st.data.story.id, storyTitle: st.data.story.title });
    say(emit, '你可以直接编辑卡片内容，然后选择推送或取消。');
    choices(emit, 'review', [
      { value: 'push', label: '推送到禅道', tone: 'primary' },
      { value: 'cancel', label: '取消' },
    ]);
  }

  function normalizeSteps(steps) {
    if (Array.isArray(steps)) {
      return steps.map((s) => ({ step: String(s.step || ''), expect: String(s.expect || s.expected || '') }));
    }
    const text = String(steps || '');
    return text
      .split(/\n+/)
      .map((line) => line.replace(/^\s*\d+[.、)]\s*/, '').trim())
      .filter(Boolean)
      .map((line) => ({ step: line, expect: '' }));
  }

  // ---------- status ----------

  const STATUS_ALIASES = {
    execution: { 开始: 'doing', 启动: 'doing', 开启: 'doing', 进行: 'doing', 执行中: 'doing', 开始执行: 'doing', 关闭: 'closed', 关掉: 'closed', 结束: 'closed', 完成: 'closed', 归档: 'closed', 挂起: 'suspended', 暂停: 'suspended', 搁置: 'suspended' },
    project: { 开始: 'doing', 启动: 'doing', 开启: 'doing', 进行: 'doing', 关闭: 'closed', 关掉: 'closed', 结束: 'closed', 完成: 'closed', 归档: 'closed', 挂起: 'suspended', 暂停: 'suspended', 搁置: 'suspended' },
    story: { 开发中: 'developing', 研发: 'developing', 测试: 'testing', 关闭: 'closed', 发布: 'released', 验收: 'verified', 完成: 'developed' },
    bug: { 解决: 'fixed', 重复: 'duplicate', 延期: 'postponed', 无法重现: 'notrepro', 不予解决: 'willnotfix' },
  };

  function matchWantedStatus(type, wanted) {
    const text = String(wanted || '').trim();
    if (!text) return null;
    const options = statusOptions[type] || [];
    const norm = text.toLowerCase().replace(/\s+/g, '');
    const direct = options.find(
      (option) => option.label === text || option.key === norm || option.label.toLowerCase() === norm,
    );
    if (direct) return direct;
    const partial = options.find((option) => option.label.includes(text) || text.includes(option.label));
    if (partial) return partial;
    const aliases = STATUS_ALIASES[type] || {};
    for (const alias of Object.keys(aliases)) {
      if (norm.includes(alias)) {
        const hit = options.find((option) => option.key === aliases[alias]);
        if (hit) return hit;
      }
    }
    return null;
  }

  function executionActionFor(key, current) {
    if (key === 'closed') return 'close';
    if (key === 'suspended') return 'suspend';
    return /未开始|wait/i.test(String(current || '')) ? 'start' : 'activate';
  }

  function executionAllowedOptions(actions, current) {
    const set = new Set(actions || []);
    const options = statusOptions.execution || [];
    const allowed = options.filter((option) => {
      if (option.key === 'closed') return set.has('close');
      if (option.key === 'suspended') return set.has('suspend');
      if (option.key === 'doing') return set.has('start') || set.has('activate');
      return false;
    });
    return allowed.length ? allowed : options;
  }

  /** Which states ZenTao will actually let this account move the iteration to. */
  async function executionAllowed(st, target) {
    const actions = await zt.executionActions(target.id).catch(() => []);
    st.data.executionActions = actions;
    return executionAllowedOptions(actions, target.current);
  }

  async function beginStatusForContext(st, ctxObj, text, emit) {
    const type = ctxObj.type;
    const id = Number(ctxObj.id);
    const label = labelOfType(type);
    emit({ type: 'status', text: '正在读取当前状态…' });
    let current = '';
    let currentKey = '';
    let projectId = Number(ctxObj.projectId || 0);
    try {
      if (type === 'story') {
        const detail = await zt.storyDetail(id);
        current = detail.stage;
      } else if (type === 'bug') {
        const detail = await zt.bugDetail(id);
        current = detail.resolution;
      } else if (type === 'execution') {
        const selection = st.data.selection || {};
        const projectIds = [...new Set([projectId, Number(selection.projectId || 0)].filter(Boolean))];
        let found = null;
        for (const pid of projectIds) {
          const list = await zt.executions(pid).catch(() => []);
          found = list.find((item) => item.id === id) || null;
          if (found) {
            projectId = pid;
            break;
          }
        }
        if (!found && !projectId) {
          const projects = await zt.projects().catch(() => []);
          for (const project of projects) {
            const list = await zt.executions(project.id).catch(() => []);
            found = list.find((item) => item.id === id) || null;
            if (found) {
              projectId = project.id;
              break;
            }
          }
        }
        if (found) {
          current = found.statusText;
          currentKey = found.status;
        }
      } else if (type === 'project') {
        const list = await zt.projects().catch(() => []);
        const found = list.find((project) => project.id === id);
        if (found) {
          current = found.statusText;
          currentKey = found.status;
        }
      }
    } catch (error) {
      current = '';
    }
    const target = { type, id, name: ctxObj.title, current, currentKey, projectId };
    st.data.statusTarget = target;
    const options = type === 'execution' ? await executionAllowed(st, target) : statusOptions[type] || [];
    const wanted = matchWantedStatus(type, text || '');
    // The sentence already names a status: no need to ask, act on it.
    if (wanted) {
      if (target.currentKey && target.currentKey === wanted.key) {
        say(emit, `${label}「${ctxObj.title}」当前已经是「${wanted.label}」状态，无需修改。`);
        st.flow = null;
        st.step = null;
        st.data = {};
        return;
      }
      if (options.some((option) => option.key === wanted.key)) {
        // A context iteration is already chosen, so ask once before writing:
        // 修改 / 取消 — the targeted object is explicit, but a stale context
        // should never be written silently.
        st.data.statusTarget = target;
        st.data.statusOption = wanted;
        st.step = 'status-confirm';
        say(emit, `将${label}「${ctxObj.title}」的状态改为「${wanted.label}」吗？`);
        choices(emit, 'status-confirm', [
          { value: 'execute', label: '修改', tone: 'primary' },
          { value: 'cancel', label: '取消' },
        ]);
        return;
      }
    }
    st.step = 'status-choose';
    const blocked = wanted && !options.some((option) => option.key === wanted.key);
    say(
      emit,
      blocked
        ? `禅道当前不允许把${label}「${ctxObj.title}」改为「${wanted.label}」（可能没有权限，或需要先走别的状态）。可选：`
        : `已从上下文识别${label}「${ctxObj.title}」${current ? '（当前：' + current + '）' : ''}，要改成哪个状态？` +
            (type === 'execution' ? '（以下是禅道当前允许的状态）' : ''),
    );
    choices(
      emit,
      'status',
      options.map((o) => ({ value: 'status:' + o.key, label: o.label })),
    );
  }

  async function parseStatus(st, text, selection, emit) {
    const known = (selection.contexts || []).map((c) => `${labelOfType(c.type)} #${c.id} ${c.title}`).join('\n');
    let parsed = null;
    try {
      parsed = await askJson(
        '你负责解析禅道状态修改意图。输出 JSON：{"targetType":"project|execution|story|bug","id":数字或null,"name":"对象名称","targetStatus":"目标状态文本"}。只输出 JSON。',
        `${selectionBlock(selection)}\n已知对象：\n${known || '（无）'}\n\n用户原话：${text}`,
      );
    } catch (error) {
      parsed = null;
    }
    if (!parsed || !parsed.targetType) {
      say(emit, '我没能解析出对象和目标状态，请换个说法，例如「需求 072 状态改为研发中」。');
      return;
    }
    const type = ['project', 'execution', 'story', 'bug'].includes(parsed.targetType) ? parsed.targetType : null;
    if (!type) {
      say(emit, '暂不支持该对象类型，目前支持项目、迭代、需求、BUG。');
      return;
    }
    const target = await resolveTarget(type, parsed, selection, selection.contexts || []);
    if (!target) {
      say(emit, `没有找到「${parsed.name || parsed.id || '该对象'}」，请确认名称或先选中对应迭代。`);
      return;
    }
    st.data.statusTarget = target;
    const wanted = String(parsed.targetStatus || '').trim();
    let options = statusOptions[type] || [];
    let match = matchWantedStatus(type, wanted);
    if (match && target.currentKey && target.currentKey === match.key) {
      say(emit, `${labelOfType(type)}「${target.name}」当前已经是「${match.label}」状态，无需修改。`);
      st.flow = null;
      st.step = null;
      st.data = {};
      return;
    }
    if (type === 'execution') {
      options = await executionAllowed(st, target);
      if (match && !options.some((option) => option.key === match.key)) match = null;
    }
    if (!match) {
      say(
        emit,
        `「${wanted || '该状态'}」不是${labelOfType(type)}当前可选的状态，请从下面选择一个` +
          (type === 'execution' ? '（已按禅道权限与状态过滤）' : '') +
          '：',
      );
      card(emit, 'status-options', { target, options });
      choices(emit, 'status', options.map((o) => ({ value: 'status:' + o.key, label: o.label })));
      st.step = 'status-choose';
      return;
    }
    await statusPlan(st, target, match, emit);
  }

  async function statusPlan(st, target, option, emit) {
    if (target.type === 'execution') {
      if (target.currentKey && target.currentKey === option.key) {
        say(emit, `迭代「${target.name}」当前已经是「${option.label}」状态，无需修改。`);
        st.flow = null;
        st.step = null;
        st.data = {};
        return;
      }
      const actions = st.data.executionActions || (await zt.executionActions(target.id).catch(() => []));
      st.data.executionActions = actions;
      if (actions.length) {
        const needed = executionActionFor(option.key, target.current);
        if (!actions.includes(needed)) {
          const options = executionAllowedOptions(actions, target.current);
          st.data.statusTarget = target;
          st.step = 'status-choose';
          say(
            emit,
            `禅道当前不允许把「${target.name}」改为「${option.label}」（可能是没有权限，或该状态需要别的流转）。可选：`,
          );
          card(emit, 'status-options', { target, options });
          choices(emit, 'status', options.map((o) => ({ value: 'status:' + o.key, label: o.label })));
          return;
        }
      }
    }
    st.data.statusTarget = target;
    st.data.statusOption = option;
    say(emit, `即将把${labelOfType(target.type)}「${target.name}」的状态改为「${option.label}」…`);
    card(emit, 'status-plan', { target, from: target.current || '', to: option.label });
    return await executeStatus(st, emit);
  }

  async function resolveTarget(type, parsed, selection, contexts) {
    const id = Number(parsed.id || 0);
    if (type === 'story') {
      if (id) {
        try {
          const detail = await zt.storyDetail(id);
          return { type, id, name: detail.title, current: detail.stage };
        } catch {
          return null;
        }
      }
      return null;
    }
    if (type === 'bug') {
      if (id) {
        try {
          const detail = await zt.bugDetail(id);
          return { type, id, name: detail.title, current: detail.resolution };
        } catch {
          return null;
        }
      }
      return null;
    }
    if (type === 'execution') {
      const execId = Number(parsed.id || 0);
      const ctxExec = (contexts || []).find((item) => item && item.type === 'execution' && item.projectId);
      const projectIds = [...new Set([
        Number(parsed.projectId || 0),
        Number(selection.projectId || 0),
        Number(ctxExec && ctxExec.projectId || 0),
      ].filter(Boolean))];
      const query = String(parsed.name || '').trim();
      let found = null;
      let foundProject = 0;
      for (const projectId of projectIds) {
        const list = await zt.executions(projectId).catch(() => []);
        if (execId) {
          found = list.find((item) => item.id === execId) || null;
        } else if (query) {
          const fuzzy = list.filter((item) => item.name === query || item.name.includes(query) || query.includes(item.name));
          if (fuzzy.length === 1) found = fuzzy[0];
        }
        if (found) {
          foundProject = projectId;
          break;
        }
      }
      if (!found && query) {
        const projects = await zt.projects().catch(() => []);
        for (const project of projects) {
          const list = await zt.executions(project.id).catch(() => []);
          const fuzzy = list.filter((item) => item.name === query || item.name.includes(query) || query.includes(item.name));
          if (fuzzy.length === 1) {
            found = fuzzy[0];
            foundProject = project.id;
            break;
          }
        }
      }
      if (found) {
        return {
          type,
          id: found.id,
          name: found.name,
          current: found.statusText,
          currentKey: found.status,
          projectId: foundProject,
        };
      }
      const fallbackId = execId || Number(selection.executionId || 0);
      if (!fallbackId) return null;
      return {
        type,
        id: fallbackId,
        name: parsed.name || selection.executionName || '',
        current: '',
        currentKey: '',
        projectId: Number(selection.projectId || 0),
      };
    }
    if (type === 'project') {
      const pid = id || selection.projectId;
      if (!pid) return null;
      const list = await zt.projects().catch(() => []);
      const found = list.find((p) => p.id === Number(pid));
      return { type, id: Number(pid), name: found ? found.name : parsed.name || '', current: found ? found.statusText : '' };
    }
    return null;
  }

  // ---------- step dispatch ----------

  /** Merge edits made in the panel's draft/polish card back into the flow state. */
  function applyEdit(st, edit) {
    if (!edit || typeof edit !== 'object') return;
    if (edit.target === 'cases') {
      const cases = Array.isArray(edit.values && edit.values.cases) ? edit.values.cases : null;
      if (!cases) return;
      st.data.cases = cases.map((item, index) => ({
        title: String(item && item.title || `${st.data.story?.title || '测试用例'}-用例${index + 1}`).trim(),
        precondition: String(item && item.precondition || '').trim(),
        steps: normalizeSteps(item && item.steps),
        priority: clampPriority(item && item.priority),
        direction: item && item.direction === 'negative' ? 'negative' : 'positive',
      }));
      if (st.data.confirm) st.data.confirm.cases = st.data.cases;
      return;
    }
    const target = edit.target === 'draft' ? 'draft' : edit.target === 'polished' ? 'polished' : null;
    if (!target) return;
    const base = st.data[target];
    if (!base) return;
    const values = edit.values && typeof edit.values === 'object' ? edit.values : {};
    const merged = Object.assign({}, base);
    for (const key of ['title', 'description', 'acceptance', 'steps', 'expected', 'module']) {
      if (typeof values[key] === 'string') merged[key] = values[key].trim();
    }
    if (values.priority !== undefined && values.priority !== null && values.priority !== '') {
      const priority = Number(values.priority);
      if (Number.isFinite(priority)) merged.priority = clampPriority(priority);
    }
    st.data[target] = merged;
    // The confirm card snapshots the payload when it opens; keep it in sync so
    // an edit made after the card appeared still reaches ZenTao.
    if (st.data.confirm && st.data.confirm.payload) st.data.confirm.payload = merged;
  }

  async function step(st, ctx, emit) {
    const { text, action, contexts, selection, edit } = ctx;
    const st2 = st;
    if (st2.flow === 'story' || st2.flow === 'bug' || st2.flow === 'case') applyEdit(st2, edit);
    const sel = st2.data.selection || selection;
    // A pending target picker must not swallow a brand-new command: "状态改为
    // 进行中" while the ask-target list is open switches to the status flow.
    if ((st2.flow === 'story' || st2.flow === 'bug') && st2.step === 'target' && text) {
      const freshIntent = detectIntent(text);
      if (freshIntent && freshIntent !== st2.flow) {
        st2.flow = null;
        st2.step = null;
        st2.data = {};
        return await startFlow(st2, freshIntent, text, selection, emit);
      }
    }
    if (st2.step === 'target') return await handleTargetStep(st2, ctx, emit);
    if (st2.flow === 'story') {
      if (st2.step === 'desc') {
        if (!text) return say(emit, '请先描述一下需求内容。');
        return await storyDraft(st2, text, contexts, sel, emit);
      }
      if (st2.step === 'polish') {
        const pick = action && action.type === 'choice' ? action.value : text === '需要润色' || text === '需要' ? 'polish' : text === '不需要' || /直接推送|跳过/.test(text) ? 'skip' : /取消|关闭/.test(text) ? 'cancel' : null;
        if (pick === 'polish') return await storyPolish(st2, '', emit);
        if (pick === 'skip') return await openConfirm(st2, 'story', sel, emit);
        if (pick === 'cancel') return cancelFlow(st2, emit);
        return say(emit, '需要润色吗？可以点上方按钮，或直接回复「需要 / 不需要」。');
      }
      if (st2.step === 'review') {
        const pick = action && action.type === 'choice' ? action.value : null;
        if (pick === 'cancel') return cancelFlow(st2, emit);
        if (pick === 'modify' || (!pick && text)) {
          if (!text) return say(emit, '请告诉我需要怎么修改。');
          st2.step = 'polish';
          return await storyPolish(st2, text, emit).then(() => {});
        }
        if (pick === 'push' || /推送|提交|创建/.test(text)) return await openConfirm(st2, 'story', sel, emit);
        if (/取消|关闭/.test(text)) return cancelFlow(st2, emit);
        return say(emit, '可以「继续修改」「推送到禅道」或「取消」。');
      }
      if (st2.step === 'confirm') {
        if (action && action.type === 'confirm') return await submitCreate(st2, 'story', action.values, sel, emit);
        if (/取消/.test(text)) return cancelFlow(st2, emit);
        return say(emit, '请在上方确认字段后点击「确认推送」，或回复「取消」。');
      }
      return;
    }

    if (st2.flow === 'execution') {
      if (st2.step === 'project') return await handleProjectStep(st2, ctx, emit);
      if (st2.step === 'name') return await handleNameStep(st2, ctx, emit);
      return;
    }

    if (st2.flow === 'bug') {
      if (st2.step === 'desc') {
        if (!text) return say(emit, '请先描述 BUG 现象。');
        return await bugDraft(st2, text, contexts, sel, emit);
      }
      if (st2.step === 'polish') {
        const pick = action && action.type === 'choice' ? action.value : text === '需要润色' || text === '需要' ? 'polish' : text === '不需要' || /直接推送|跳过/.test(text) ? 'skip' : /取消|关闭/.test(text) ? 'cancel' : null;
        if (pick === 'polish') return await bugPolish(st2, '', emit);
        if (pick === 'skip') return await openConfirm(st2, 'bug', sel, emit);
        if (pick === 'cancel') return cancelFlow(st2, emit);
        return say(emit, '需要润色吗？可以点上方按钮，或直接回复「需要 / 不需要」。');
      }
      if (st2.step === 'review') {
        const pick = action && action.type === 'choice' ? action.value : null;
        if (pick === 'cancel') return cancelFlow(st2, emit);
        if (pick === 'modify' || (!pick && text)) {
          if (!text) return say(emit, '请告诉我需要怎么修改。');
          st2.step = 'polish';
          return await bugPolish(st2, text, emit).then(() => {});
        }
        if (pick === 'push' || /推送|提交|创建/.test(text)) return await openConfirm(st2, 'bug', sel, emit);
        if (/取消|关闭/.test(text)) return cancelFlow(st2, emit);
        return say(emit, '可以「继续修改」「推送到禅道」或「取消」。');
      }
      if (st2.step === 'confirm') {
        if (action && action.type === 'confirm') return await submitCreate(st2, 'bug', action.values, sel, emit);
        if (/取消/.test(text)) return cancelFlow(st2, emit);
        return say(emit, '请在上方确认字段后点击「确认推送」，或回复「取消」。');
      }
      return;
    }

    if (st2.flow === 'case') {
      if (st2.step === 'story') {
        if (action && action.type === 'choice' && String(action.value).indexOf('story:') === 0) {
          return await beginCaseForStory(st2, Number(action.value.slice(6)), emit);
        }
        if (text) return await caseStory(st2, text, emit);
        const execCtx = (contexts || []).find((c) => c && c.type === 'execution');
        if (execCtx && execCtx.id) return await offerStoriesOfExecution(st2, execCtx, emit);
        return say(emit, '请把需求拖进输入框（拖入迭代也可以），或告诉我需求 ID。');
      }
      if (st2.step === 'case-mode') {
        const pick = action && action.type === 'choice' ? action.value : /取消|关闭/.test(text) ? 'cancel' : /^(自己输入|手动)/.test(text) ? 'manual' : /^(自动生成|自动)/.test(text) ? 'auto' : null;
        if (pick === 'manual') {
          st2.step = 'case-input';
          return say(emit, '请直接输入测试用例内容。可以写标题、前置条件、步骤和预期结果；每条内容用换行区分。');
        }
        if (pick === 'auto') return await caseGenerate(st2, '', emit);
        if (pick === 'cancel') return cancelFlow(st2, emit);
        return say(emit, '请选择「自己输入」「自动生成」或「取消」。');
      }
      if (st2.step === 'case-input') {
        if (/取消|关闭/.test(text)) return cancelFlow(st2, emit);
        if (!text) return say(emit, '请先输入测试用例内容，或回复「取消」。');
        st2.data.manualText = text;
        st2.step = 'case-manual-polish';
        say(emit, '已收到你的测试用例。需要我润色整理吗？');
        choices(emit, 'case-manual-polish', [
          { value: 'polish', label: '需要润色', tone: 'primary' },
          { value: 'skip', label: '不需要' },
          { value: 'cancel', label: '取消' },
        ]);
        return;
      }
      if (st2.step === 'case-manual-polish') {
        const pick = action && action.type === 'choice' ? action.value : /取消|关闭/.test(text) ? 'cancel' : /^(不需要|不用|跳过)/.test(text) ? 'skip' : /^(需要|润色)/.test(text) ? 'polish' : null;
        if (pick === 'polish') return await polishManualCases(st2, emit);
        if (pick === 'skip') {
          st2.data.cases = manualCases(st2);
          return presentCases(st2, emit, '已按你的原始输入生成测试用例：');
        }
        if (pick === 'cancel') return cancelFlow(st2, emit);
        return say(emit, '请选择「需要润色」「不需要」或「取消」。');
      }
      if (st2.step === 'review') {
        const pick = action && action.type === 'choice' ? action.value : null;
        if (pick === 'cancel') return cancelFlow(st2, emit);
        if (pick === 'push' || /推送|提交|创建/.test(text)) return await submitCases(st2, null, selection, emit);
        if (/取消|关闭/.test(text)) return cancelFlow(st2, emit);
        return say(emit, '请直接编辑上方卡片内容，然后选择「推送」或「取消」。');
      }
      if (st2.step === 'confirm') {
        if (action && action.type === 'confirm') return await submitCases(st2, action.values, selection, emit);
        if (/取消/.test(text)) return cancelFlow(st2, emit);
        return say(emit, '请确认字段后点击「确认推送」，或回复「取消」。');
      }
      return;
    }

    if (st2.flow === 'doc') {
      if (st2.step === 'doc-confirm') {
        const pick =
          action && action.type === 'choice'
            ? action.value
            : /取消|关闭/.test(text || '')
              ? 'cancel'
              : /^(创建|开始|执行|确认|好|是)/.test(text || '')
                ? 'create'
                : null;
        if (pick === 'create') return await createDocBatch(st2, emit);
        if (pick === 'cancel') return cancelFlow(st2, emit, '已取消批量创建，文档内容不会写入禅道。');
        return say(emit, '请选择「开始创建」或「取消」。');
      }
      return;
    }
    if (st2.flow === 'api') {
      if (st2.step === 'api-confirm') {
        const pick =
          action && action.type === 'choice'
            ? action.value
            : /取消|关闭/.test(text || '')
              ? 'cancel'
              : /^(执行|查询|查|好|确认|是|嗯)/.test(text || '')
                ? 'execute'
                : null;
        if (pick === 'execute') return await runApiQuery(st2, emit);
        if (pick === 'cancel') return cancelFlow(st2, emit, '已取消查询。');
        return say(emit, '请选择「执行查询」或「取消」。');
      }
      return;
    }
    if (st2.flow === 'status') {
      if (st2.step === 'parse') {
        if (!text) return say(emit, '请描述要修改的对象与目标状态。');
        return await parseStatus(st2, text, selection, emit);
      }
      if (st2.step === 'status-confirm') {
        const pick =
          action && action.type === 'choice'
            ? action.value
            : /取消|关闭/.test(text || '')
              ? 'cancel'
              : /^(修改|改|执行|确定|好|是|嗯)/.test(text || '')
                ? 'execute'
                : null;
        if (pick === 'execute') return await executeStatus(st2, emit);
        if (pick === 'cancel') return cancelFlow(st2, emit);
        return say(emit, '请选择「修改」或「取消」。');
      }
      if (st2.step === 'status-choose') {
        const target = st2.data.statusTarget;
        const options = (target && statusOptions[target.type]) || [];
        if (action && action.type === 'choice' && String(action.value).indexOf('status:') === 0) {
          const key = action.value.slice(7);
          const option = options.find((o) => o.key === key);
          if (!option) return say(emit, '该状态不可用，请重新选择。');
          return await statusPlan(st2, target, option, emit);
        }
        if (/取消|关闭/.test(text || '')) return cancelFlow(st2, emit);
        const wanted = String(text || '').trim();
        const typed = options.find((o) => o.label === wanted || o.key === wanted);
        if (typed) return await statusPlan(st2, target, typed, emit);
        return say(emit, '请从上方列表中选择一个状态，或回复「取消」。');
      }
      if (st2.step === 'status-plan') {
        const pick = action && action.type === 'choice' ? action.value : /执行|确认|是/.test(text) ? 'execute' : /取消/.test(text) ? 'cancel' : null;
        if (pick === 'execute') return await executeStatus(st2, emit);
        if (pick === 'cancel') return cancelFlow(st2, emit);
        return say(emit, '请点击「执行修改」或「取消」。');
      }
      return;
    }
  }

  function resetFlow(st) {
    st.flow = null;
    st.step = null;
    st.data = {};
  }

  function cancelFlow(st, emit, message) {
    resetFlow(st);
    say(emit, message || '已取消，本次生成的内容不会推送到禅道。');
  }

  // ---------- confirm & create ----------

  async function openConfirm(st, kind, selection, emit) {
    emit({ type: 'status', text: '正在读取可写入字段…' });
    const data = st.data.polished || st.data.draft;
    const executionId = Number(selection.executionId) || 0;
    let metaData;
    try {
      metaData = await zt.formOptions(
        kind === 'bug'
          ? `/bug-create-0-0-executionID=${executionId}.html`
          : `/story-create-0-0-0-0-${executionId}.html`,
      );
    } catch (error) {
      metaData = { product: [], module: [], assignedTo: [], pri: [] };
    }
    // Create pages only expose a partial assignee list (often just the current
    // user); merge in the project/execution team from an existing item's assign
    // form so the picker matches the real team members.
    const team = new Map();
    const addUsers = (list) => {
      for (const option of list || []) {
        if (!option || !option.value || option.value === 'closed') continue;
        const value = String(option.value);
        if (!team.has(value)) {
          team.set(value, { value, label: String(option.label || value).replace(/^[A-Za-z]{1,3}:/, '').trim() || value });
        }
      }
    };
    addUsers(metaData.assignedTo);
    if (executionId) {
      // The execution team is authoritative even when this is a new, empty
      // iteration with no existing story/BUG whose assignment form we can use.
      try {
        addUsers(await zt.executionMembers(executionId));
      } catch (error) {
        /* keep the create-form users as a fallback */
      }
      // Any existing item in the execution exposes the full assignable team on
      // its assign page; use both kinds so a story-only or bug-only iteration
      // still yields the complete member list.
      for (const type of ['story', 'bug']) {
        try {
          const list = type === 'story' ? await zt.stories(executionId) : await zt.bugs(executionId);
          if (list && list.length) {
            const info = await zt.assignOptions(type, list[0].id);
            addUsers(info.users);
          }
        } catch (error) {
          /* fall back to whatever the create form exposed */
        }
      }
    }
    const productId = Number((metaData.product.find((o) => o.selected) || metaData.product[0] || {}).value || 0);
    const modules = metaData.module
      .map((m) => ({ value: Number(m.value), label: m.label }))
      .filter((m) => m.value > 0);
    const users = [...team.values()];
    const suggestedModule = data.module ? modules.find((m) => m.label.includes(data.module) || data.module.includes(m.label)) : null;
    st.data.confirm = {
      kind,
      payload: data,
      productId,
      projectId: selection.projectId || 0,
      executionId: selection.executionId || 0,
      moduleId: suggestedModule ? suggestedModule.value : 0,
      priority: clampPriority(data.priority),
      assignedTo: '',
    };
    st.step = 'confirm';
    const fields = [
      { key: 'project', label: '项目', value: selection.projectName || '-', type: 'readonly' },
      { key: 'execution', label: '迭代', value: selection.executionName || '-', type: 'readonly' },
      {
        key: 'moduleId',
        label: '模块',
        value: st.data.confirm.moduleId,
        type: 'select',
        options: [{ value: 0, label: '不指定模块' }, ...modules],
      },
      {
        key: 'priority',
        label: '优先级',
        value: st.data.confirm.priority,
        type: 'select',
        options: [1, 2, 3, 4].map((n) => ({ value: n, label: 'P' + n })),
      },
      {
        key: 'assignedTo',
        label: '指派人',
        value: '',
        type: 'select',
        options: [{ value: '', label: '未指派' }, ...users],
      },
      { key: 'title', label: '标题', value: data.title, type: 'readonly' },
    ];
    say(emit, '推送前请确认将写入禅道的字段：');
    card(emit, 'confirm', { id: 'create', kind, fields });
  }

  async function openCaseConfirm(st, selection, emit, silent = false) {
    let metaData;
    try {
      metaData = await zt.formOptions(`/testcase-create-0-0-0--0-${st.data.story.id}.html`);
    } catch (error) {
      metaData = { product: [], module: [], assignedTo: [], pri: [] };
    }
    const productId = Number((metaData.product.find((o) => o.selected) || metaData.product[0] || {}).value || 0);
    st.data.confirm = {
      kind: 'testcase',
      cases: st.data.cases,
      storyId: st.data.story.id,
      productId,
      projectId: selection.projectId || 0,
      executionId: selection.executionId || 0,
      moduleId: 0,
      priority: 3,
    };
    if (silent) return;
    st.step = 'confirm';
    say(emit, '推送前请确认用例将创建到：');
    card(emit, 'confirm', {
      id: 'cases',
      kind: 'testcase',
      fields: [
        { key: 'story', label: '需求', value: `#${st.data.story.id} ${st.data.story.title}`, type: 'readonly' },
        { key: 'count', label: '用例数', value: String(st.data.cases.length), type: 'readonly' },
      ],
    });
  }

  async function submitCreate(st, kind, values, selection, emit) {
    const confirm = st.data.confirm;
    if (!confirm) return say(emit, '没有待推送的内容，请重新开始。');
    emit({ type: 'status', text: '正在写入禅道…' });
    const payload = {
      kind,
      productId: confirm.productId || Number(values?.productId || 0),
      projectId: confirm.projectId || selection.projectId || 0,
      executionId: confirm.executionId || selection.executionId || 0,
      moduleId: Number(values?.moduleId ?? confirm.moduleId ?? 0),
      priority: Number(values?.priority ?? confirm.priority ?? 3),
      assignedTo: values?.assignedTo || '',
      title: confirm.payload.title,
    };
    if (kind === 'story') {
      payload.description = confirm.payload.description;
      payload.acceptance = confirm.payload.acceptance || '';
    } else {
      payload.description = confirm.payload.description;
      payload.steps = [confirm.payload.steps, confirm.payload.expected ? '\n\n期望结果：' + confirm.payload.expected : ''].join('');
      payload.severity = 3;
    }
    let result;
    try {
      result = await deps.createItem(payload);
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    if (result.ok) {
      const url = result.url && result.url.includes('undefined') ? '' : result.url;
      const sel = st.data.selection || {};
      say(emit, `已创建${kind === 'story' ? '研发需求' : 'BUG'}「${confirm.payload.title}」。`);
      card(emit, 'result', {
        ok: true,
        message: result.message || '创建成功',
        url,
        kind,
        title: confirm.payload.title,
        id: result.id || null,
        target: sel.executionId
          ? {
              projectId: sel.projectId,
              projectName: sel.projectName,
              executionId: sel.executionId,
              executionName: sel.executionName,
            }
          : null,
      });
      st.flow = null;
      st.step = null;
      st.data = {};
    } else {
      say(emit, `创建失败：${result.error || result.message || '未知原因'}`);
      card(emit, 'result', { ok: false, message: result.error || result.message, kind });
    }
  }

  async function submitCases(st, values, selection, emit) {
    // The editable card's “推送” is the final write action. Load only the
    // necessary metadata instead of inserting a second confirmation card.
    if (!st.data.confirm) await openCaseConfirm(st, selection, emit, true);
    const confirm = st.data.confirm;
    if (!confirm) return say(emit, '没有待推送的用例，请重新生成。');
    emit({ type: 'status', text: '正在写入禅道…' });
    let result;
    try {
      result = await deps.createItem({
        kind: 'testcase',
        productId: confirm.productId,
        storyId: confirm.storyId,
        cases: confirm.cases,
      });
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    if (result.ok) {
      say(emit, `已为需求 #${confirm.storyId} 创建 ${result.created ? result.created.length : confirm.cases.length} 条测试用例。`);
      card(emit, 'result', { ok: true, message: result.message || '创建成功', kind: 'testcase' });
      st.flow = null;
      st.step = null;
      st.data = {};
    } else {
      say(emit, `创建失败：${result.error || '未知原因'}`);
      card(emit, 'result', { ok: false, message: result.error, kind: 'testcase' });
    }
  }

  async function executeStatus(st, emit) {
    const target = st.data.statusTarget;
    const option = st.data.statusOption;
    emit({ type: 'status', text: '正在修改状态…' });
    let result;
    try {
      result = await deps.changeStatus({
        targetType: target.type,
        id: target.id,
        statusKey: option.key,
        current: target.current || '',
      });
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    if (result.ok) {
      say(emit, `已将${labelOfType(target.type)}「${target.name}」的状态改为「${option.label}」。`);
      card(emit, 'result', {
        ok: true,
        message: '状态修改成功',
        kind: 'status',
        statusChanged: {
          type: target.type,
          id: target.id,
          projectId: Number(target.projectId || 0),
          key: option.key,
          label: option.label,
        },
      });
    } else {
      say(emit, `修改失败：${result.error || '禅道拒绝了这个状态变更（可能无权限或状态不允许流转）'}`);
      card(emit, 'result', { ok: false, message: result.error || '状态修改失败', kind: 'status' });
      if (target.type === 'execution') {
        const options = await executionAllowed(st, target).catch(() => statusOptions.execution || []);
        if (options.length) {
          st.data.statusTarget = target;
          st.step = 'status-choose';
          say(emit, '可以换一个禅道允许的状态再试：');
          card(emit, 'status-options', { target, options });
          choices(emit, 'status', options.map((o) => ({ value: 'status:' + o.key, label: o.label })));
          return;
        }
      }
    }
    st.flow = null;
    st.step = null;
    st.data = {};
  }

  // ---------- general ----------

  // ---------- document batch import ----------

  async function showDocPlan(st, target, emit) {
    const items = st.data.docItems || [];
    st.step = 'doc-confirm';
    say(
      emit,
      `从文档「${st.data.docName || '未命名'}」解析到 ${items.length} 条需求，将写入「${target.projectName} / ${target.executionName}」：`,
    );
    card(emit, 'doc-plan', {
      name: st.data.docName || '',
      target: { projectName: target.projectName, executionName: target.executionName },
      count: items.length,
      items: items.map((item) => ({ title: item.title, description: item.description })),
    });
    choices(emit, 'doc-confirm', [
      { value: 'create', label: '开始创建', tone: 'primary' },
      { value: 'cancel', label: '取消' },
    ]);
  }

  async function createDocBatch(st, emit) {
    const items = st.data.docItems || [];
    const selection = st.data.selection || {};
    const executionId = Number(selection.executionId) || 0;
    emit({ type: 'status', text: '正在读取产品信息…' });
    let productId = 0;
    try {
      const options = await zt.formOptions(`/story-create-0-0-0-0-${executionId}.html`);
      const selected = options.product.find((option) => option.selected) || options.product[0];
      productId = Number(selected && selected.value) || 0;
    } catch (error) {
      productId = 0;
    }
    if (!productId) {
      say(emit, '没读到该迭代关联的产品，无法批量创建需求。');
      resetFlow(st);
      return;
    }
    const results = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      emit({ type: 'status', text: `正在创建需求 ${index + 1}/${items.length}…` });
      try {
        const result = await createItem({
          kind: 'story',
          productId,
          projectId: Number(selection.projectId) || 0,
          executionId,
          title: item.title,
          description: item.description,
          priority: 3,
          assignedTo: '',
        });
        results.push({ title: item.title, ok: Boolean(result && result.ok), error: result && result.ok ? '' : (result && (result.error || result.message)) || '创建失败' });
      } catch (error) {
        results.push({ title: item.title, ok: false, error: error.message });
      }
    }
    const okCount = results.filter((item) => item.ok).length;
    say(emit, `批量创建完成：成功 ${okCount} 条，失败 ${results.length - okCount} 条。`);
    card(emit, 'doc-result', { count: results.length, ok: okCount, items: results });
    resetFlow(st);
  }

  // ---------- generic read-only REST queries ----------

  function apiContextIds(selection) {
    const ids = {};
    if (selection && Number(selection.projectId)) ids.projectId = Number(selection.projectId);
    if (selection && Number(selection.executionId)) ids.executionId = Number(selection.executionId);
    const contexts = Array.isArray(selection && selection.contexts) ? selection.contexts : [];
    for (const ctx of contexts) {
      if (!ctx || !ctx.id) continue;
      if (ctx.type === 'project' && !ids.projectId) ids.projectId = Number(ctx.id);
      if (ctx.type === 'execution' && !ids.executionId) ids.executionId = Number(ctx.id);
    }
    return ids;
  }

  function directApiPlan(text) {
    const value = String(text || '');
    const listWords = /(列表|有哪些|哪些|所有|全部|查一下|查询|列出|列一下|我的|我负责)/;
    if (!listWords.test(value)) return null;
    if (/产品/.test(value) && !/(项目|迭代|执行)/.test(value)) {
      return { path: 'products', summary: '查询我权限范围内的产品列表' };
    }
    if (/项目/.test(value) && !/(迭代|执行)/.test(value)) {
      return { path: 'projects', summary: '查询我权限范围内的项目列表' };
    }
    if (/(迭代|执行)/.test(value)) {
      return { path: 'executions', summary: '查询我权限范围内的迭代列表' };
    }
    return null;
  }

  async function planApiQuery(st, text, selection, emit) {
    if (!zentaoApi) {
      say(emit, '当前插件宿主版本还不支持通用接口查询，请重启 DeepSeek Harness 后再试。');
      cancelFlow(st, emit);
      return;
    }
    emit({ type: 'status', text: '正在理解你的查询…' });
    const ids = apiContextIds(selection);
    const contextText = Object.keys(ids).length
      ? Object.entries(ids)
          .map(([key, value]) => key + '=' + value)
          .join('，')
      : '（没有选中项目/迭代）';
    let planned = directApiPlan(text);
    try {
      if (!planned) planned = await askJson(
        '你是禅道查询规划器。只能从下面的只读接口清单里挑一个 path，不要编造接口。' +
          '输出 JSON：{"path":"接口路径","summary":"一句人话说明要查什么"}。' +
          '如果用户要查某个产品/项目/迭代下的东西，用清单里的对应路径；没有上下文 ID 时优先选列表接口。\n\n' +
          zentaoApi.catalog(),
        `上下文：${contextText}\n用户问题：${text}`,
      );
    } catch (error) {
      planned = null;
    }
    const candidate = planned && typeof planned.path === 'string' ? planned.path.replace(/^\/+/, '') : '';
    const entry = candidate ? zentaoApi.match(candidate) : null;
    if (!entry) {
      say(
        emit,
        '我没能把这个查询对应到已知接口。目前支持：产品/项目/迭代/需求/BUG/任务/用例/计划/构建/发布/用户的列表或详情查询。',
      );
      resetFlow(st);
      return;
    }
    // Fill the ids we already know from the tree selection / contexts.
    const filled = zentaoApi.match(candidate) ? fillPlaceholders(candidate, ids) : { path: candidate, missing: [] };
    if (filled.missing.length) {
      say(
        emit,
        `查询 ${entry.label} 需要这几个参数：${filled.missing.join('、')}。请先在左侧选中对应对象，或把产品/项目/迭代拖进对话框后再问一次。`,
      );
      resetFlow(st);
      return;
    }
    st.data.apiRequest = { path: filled.path };
    // The API catalog is allowlisted and `run()` only issues GET requests, so
    // a user-initiated query can run immediately. Confirmation remains for
    // every flow that writes data to ZenTao.
    return await runApiQuery(st, emit);
  }

  function fillPlaceholders(path, ids) {
    const missing = [];
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

  async function runApiQuery(st, emit) {
    const request = st.data.apiRequest;
    emit({ type: 'status', text: '正在查询禅道…' });
    const result = await zentaoApi.run(request);
    st.flow = null;
    st.step = null;
    st.data = {};
    if (!result.ok) {
      say(emit, `查询失败：${result.error}`);
      if (result.suggestion) say(emit, `建议：${result.suggestion}`);
      return;
    }
    if (result.detail) {
      say(emit, `查询完成，返回 ${result.entry.label}：`);
      card(emit, 'api-result', { label: result.entry.label, total: 1, items: [], detail: result.detail, path: result.path });
      return;
    }
    const scopeNote = /\.(list|byProduct|byProject|byExecution)$/.test(result.entry.id)
      ? '（仅包含你权限范围内能查看的数据）'
      : '';
    say(emit, `查询完成，共 ${result.total} 条${scopeNote}${result.total > result.items.length ? '，下面展示前 ' + result.items.length + ' 条' : ''}。`);
    card(emit, 'api-result', { label: result.entry.label, total: result.total, items: result.items, path: result.path });
  }

  async function general(st, text, contexts, selection, emit) {
    if (!text) return say(emit, '你好，我可以帮你录入需求/BUG、生成测试用例、修改状态，也可以基于左侧对象回答禅道相关问题。');
    emit({ type: 'status', text: '思考中…' });
    const system =
      '你是禅道（ZenTao）项目协作助手，回答简洁、可执行。可以引用上下文中的项目、迭代、需求、BUG 信息。' +
      '如果用户想录入需求/BUG、生成测试用例或修改状态，提示他可以点击输入框上方的快捷按钮。';
    try {
      await stream(system, `${selectionBlock(selection)}\n\n${contextBlock(contexts)}\n\n用户问题：${text}`, emit);
    } catch (error) {
      say(emit, `模型调用失败：${error.message}`);
    }
  }

  return { handle };
}

function clampPriority(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.min(4, Math.max(1, Math.round(n)));
}

function fallbackDraft(text) {
  const first = String(text || '').split(/\n|。|；|;/)[0].trim();
  return {
    title: (first || '未命名需求').slice(0, 30),
    description: String(text || '').trim(),
  };
}

/**
 * Models sometimes return a well-labelled acceptance section inside the
 * description despite the JSON contract. Split it before either field is
 * rendered or sent to ZenTao, so `verify` remains the single source of the
 * acceptance criteria.
 */
function splitStoryAcceptance(description, acceptance) {
  let spec = String(description || '').trim();
  let verify = String(acceptance || '').trim();
  const heading = /(?:^|\n)\s*(?:#{1,6}\s*|[-*•]\s*|\d+[.)、]\s*)?(?:验收标准|验收条件|验收准则)\s*[:：]?\s*/i;
  const match = heading.exec(spec);
  if (match) {
    const before = spec.slice(0, match.index).trim();
    const after = spec.slice(match.index + match[0].length).trim();
    if (!verify) verify = after;
    spec = before;
  }
  return { description: spec, acceptance: verify };
}
