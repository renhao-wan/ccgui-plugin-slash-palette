// 冒烟测试：用最小 React 替身渲染三个入口，bridge 真实调用 PowerShell。
// 不依赖宿主；只验证「能跑通、扫描有结果、写入参数正确」。
// 替身不模拟重渲染，因此交互修复（连续开关、按钮焦点下按 Esc）
// 通过直接调用 props 回调覆盖，不覆盖真实 React 生命周期。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const PLUGIN = new URL('../main.js', import.meta.url).href;
const MANIFEST = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

const states = new Map();
let stateIdx = 0;
let refIdx = 0;
// 用 let：renderFresh 必须整体换新数组，否则字符串键的 ref 会跨挂载残留。
let refs = [];
let effects = [];
// hook 槽位按「组件实例」分域：嵌套函数组件（如反馈区）不能和父组件共用序号，
// 否则父组件多一个 useState 就把子组件的槽位整体挤歪。
let domain = 'root';
let domainSeq = new Map();

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => {
    const i = domain + '|' + stateIdx++;
    if (!states.has(i)) states.set(i, typeof init === 'function' ? init() : init);
    return [
      states.get(i),
      (v) => {
        states.set(i, typeof v === 'function' ? v(states.get(i)) : v);
      },
    ];
  },
  useEffect: (fn) => {
    effects.push(fn);
  },
  useRef: (init) => {
    const i = domain + '|' + refIdx++;
    if (!refs[i]) refs[i] = { current: init === undefined ? null : init };
    return refs[i];
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  // 组件订阅 store 时直接取当前快照；不模拟 store 变更后的重渲染
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
};

// React 会调用函数组件；替身也要展开，否则拿到的只是 { type: Comp } 外壳。
function expand(node) {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== 'object') return node;
  if (typeof node.type === 'function') {
    const nm = node.type.name || 'anon';
    const inst = domainSeq.get(nm) || 0;
    domainSeq.set(nm, inst + 1);
    const prev = { domain, stateIdx, refIdx };
    domain = nm + '#' + inst;
    stateIdx = 0;
    refIdx = 0;
    const props = Object.assign({}, node.props || {}, { children: node.children || [] });
    const out = node.type(props);
    domain = prev.domain;
    stateIdx = prev.stateIdx;
    refIdx = prev.refIdx;
    return expand(out);
  }
  return Object.assign({}, node, { children: (node.children || []).map(expand) });
}

const storageData = new Map();
const clone = (v) => JSON.parse(JSON.stringify(v));
const drafts = [];
const execCalls = [];
const injectedCss = [];

let statusItem = null;
let overlay = null;
let settingsSection = null;
let paletteCommand = null;
// 反馈相关的桥接替身：默认全部拒绝（等同「权限未生效」），由各条用例自己设。
const httpCalls = [];
let httpResponder = null;

const ctx = {
  react: fakeReact,
  pluginId: 'slash-palette',
  version: MANIFEST.version,
  theme: {
    injectCss: (css) => {
      injectedCss.push(css);
      return () => {};
    },
  },
  storage: {
    get: async (k) => (storageData.has(k) ? clone(storageData.get(k)) : null),
    set: async (k, v) => {
      storageData.set(k, clone(v));
    },
    delete: async (k) => {
      storageData.delete(k);
    },
  },
  ui: {
    registerComposerStatusItem: (def) => {
      statusItem = def;
      return () => {};
    },
    registerOverlay: (def) => {
      overlay = def;
      return () => {};
    },
    registerSettingsSection: (def) => {
      settingsSection = def;
      return () => {};
    },
    registerCommand: (def) => {
      paletteCommand = def;
      return () => {};
    },
    openSettings: () => {},
  },
  composer: {
    setDraft: (text) => {
      drafts.push(text);
    },
  },
  workspace: {
    getMetadata: async () => ({ path: process.cwd() }),
  },
  workspaces: {
    list: async () => [],
  },
  bridge: {
    invoke: async (name, args) => {
      if (name === 'plugin_http_request') {
        httpCalls.push(args);
        if (httpResponder) return httpResponder(args);
        // 默认拒绝，等同「network: 权限未生效」——各条用例自己设 responder
        throw new Error('network:ccgui-feedback.2653990378.workers.dev not granted');
      }
      if (name !== 'plugin_exec_run') throw new Error('unexpected command ' + name);
      if (args.bin !== 'powershell') throw new Error('unexpected bin ' + args.bin);
      execCalls.push(args.args.join(' '));
      const out = execFileSync(args.bin, args.args, {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: args.timeoutMs || 30000,
      });
      return { code: 0, stdout: out, stderr: '' };
    },
  },
};

const mod = await import(PLUGIN);
const dispose = mod.default(ctx);

// 启动时的设置读取是异步的：微任务跑完之前开关应禁用，
// 否则用户在这几十毫秒内点击会用默认值覆盖已保存的设置。
const preLoadBoxes = checkboxes(renderFresh(settingsSection.component).tree);
const disabledBeforeLoad =
  preLoadBoxes.length > 0 && preLoadBoxes.every((b) => b.props && b.props.disabled === true);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每次渲染都从零开始：清空 hooks 槽，避免不同组件串状态。
// 注意同理——要整棵树都清，否则嵌套组件（反馈区）会读到上一次的额度/正文。
function renderFreshState(comp, props) {
  states.clear();
  // refs 槽位键是字符串，`length = 0` 清不掉它们：必须换新数组，
  // 否则 useRef 里的「只在挂载时跑一次」标志会跨挂载残留。
  refs = [];
  stateIdx = 0;
  refIdx = 0;
  domain = 'root';
  domainSeq = new Map();
  effects = [];
  return expand(comp(props || {}));
}

function renderFresh(comp, props) {
  return { tree: renderFreshState(comp, props), effects };
}

// 保留组件内部状态的重渲染：用于验证「输入 → 点按钮 → 读结果」这类交互。
function renderKeep(comp, props) {
  let tree = null;
  // 组件渲染期间改状态会立刻重渲染，替身多跑几轮直到稳定
  for (let pass = 0; pass < 5; pass += 1) {
    const before = new Map(states);
    stateIdx = 0;
    refIdx = 0;
    domain = 'root';
    domainSeq = new Map();
    effects = [];
    tree = expand(comp(props || {}));
    let changed = before.size !== states.size;
    for (const [k, v] of states) {
      if (!changed && before.get(k) !== v) changed = true;
    }
    if (!changed) break;
  }
  return tree;
}

function walk(node, fn) {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, fn);
    return;
  }
  if (!node || typeof node !== 'object') return;
  fn(node);
  for (const k of Array.isArray(node.children) ? node.children : []) walk(k, fn);
}

function textOf(node) {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!node || typeof node !== 'object') return '';
  return (node.children || []).map(textOf).join('');
}

function find(tree, pred) {
  let hit = null;
  walk(tree, (n) => {
    if (!hit && pred(n)) hit = n;
  });
  return hit;
}

function byClass(tree, cls) {
  return find(tree, (n) => n.props && typeof n.props.className === 'string' && n.props.className.split(' ').includes(cls));
}

// ---- 第一段：启动扫描 ----
if (!statusItem || !overlay || !settingsSection || !paletteCommand) {
  console.log('RESULT=SMOKE_FAIL 入口未全部注册');
  process.exit(1);
}

const t0 = Date.now();
let chipText = '';
let scanMs = -1;
for (let i = 0; i < 120; i++) {
  await sleep(100);
  const tree = renderFresh(statusItem.component).tree;
  chipText = textOf(tree);
  if (chipText.indexOf('命令') >= 0 && /\d/.test(chipText.replace('命令', ''))) {
    scanMs = Date.now() - t0;
    break;
  }
}
if (scanMs < 0) scanMs = Date.now() - t0;

const chipTree = renderFresh(statusItem.component).tree;
const chipBtn = byClass(chipTree, 'sp-chip');
if (chipBtn && chipBtn.props.onClick) chipBtn.props.onClick();

// ---- 第二段：overlay 列表 ----
const overlayTree = renderFresh(overlay.component).tree;
const overlayText = textOf(overlayTree);
const searchInput = byClass(overlayTree, 'sp-search');
const allInvocations = [];
walk(overlayTree, (n) => {
  if (n.props && typeof n.props.className === 'string' && n.props.className.split(' ').includes('sp-invoke')) {
    allInvocations.push(textOf(n));
  }
});

// 找到一个插件命名空间的命令（插件命令或插件技能）
const pluginInvoke = allInvocations.find((s) => /^\/[^/\s]+:[^/\s]+/.test(s)) || '';

// ---- 第三段：搜索过滤 ----
// 用完整的「插件名:命令名」做搜索词，避免命中同名的用户技能（如 /code-review）
const needle = pluginInvoke ? pluginInvoke.replace(/^\//, '') : 'devflow:plan';
if (searchInput && searchInput.props.onChange) {
  searchInput.props.onChange({ target: { value: needle } });
}
const filteredTree = renderFresh(overlay.component).tree;
const filteredText = textOf(filteredTree);
const filteredInput = byClass(filteredTree, 'sp-search');

// ---- 第四段：Enter 写入草稿 ----
// Enter 处理器挂在面板容器上（而不是搜索框），焦点在任意子元素时都能触发
const filteredPanel = byClass(filteredTree, 'sp-panel');
if (filteredPanel && filteredPanel.props.onKeyDown) {
  filteredPanel.props.onKeyDown({ key: 'Enter', preventDefault() {} });
}
const lastDraft = drafts[drafts.length - 1] || '';

// ---- 第五段：设置页 ----
const settingsTree = renderFresh(settingsSection.component).tree;
const settingsText = textOf(settingsTree);

// ---- 第六段：命令面板入口 ----
paletteCommand.run();
const reopened = renderFresh(overlay.component).tree;
const reopenedSearch = byClass(reopened, 'sp-search');

// ---- 第七段：Esc 在面板容器上生效（模拟焦点不在搜索框）----
const reopenedPanel = byClass(reopened, 'sp-panel');
if (reopenedPanel && reopenedPanel.props.onKeyDown) {
  reopenedPanel.props.onKeyDown({ key: 'Escape', preventDefault() {} });
}
const afterEsc = renderFresh(overlay.component).tree;
const escClosed = afterEsc === null;

// ---- 第八段：连续切换两个开关不互相覆盖 ----
function checkboxes(tree) {
  const out = [];
  walk(tree, (n) => {
    if (n.type === 'input' && n.props && n.props.type === 'checkbox') out.push(n);
  });
  return out;
}
const firstBoxes = checkboxes(renderFresh(settingsSection.component).tree);
if (firstBoxes[0]) firstBoxes[0].props.onChange(); // 关闭「插件命令与技能」
const secondBoxes = checkboxes(renderFresh(settingsSection.component).tree);
if (secondBoxes[2]) secondBoxes[2].props.onChange(); // 打开「内置命令」
const thirdBoxes = checkboxes(renderFresh(settingsSection.component).tree);
const togglesIndependent = !!(
  thirdBoxes[0] &&
  thirdBoxes[0].props.checked === false &&
  thirdBoxes[2] &&
  thirdBoxes[2].props.checked === true
);
const enabledAfterLoad = thirdBoxes.length > 0 && thirdBoxes.every((b) => b.props.disabled !== true);

// ---- 第七段：卸载清理 ----
let disposeOk = true;
try {
  dispose();
} catch {
  disposeOk = false;
}

// ---- 第八段：反馈区 ----
// dispose() 已把旧 ctx 的入口都注销了，重新激活一份给反馈用例单独用。
const dispose2 = mod.default(ctx);

// 每次渲染都从零开始的替身里，反馈组件的额度查询在 effect 里：
// 先渲染一次收 effect，跑掉，再等结果落定。
async function mountFeedback(responder) {
  httpResponder = responder;
  httpCalls.length = 0;
  const { effects: fx } = renderFresh(settingsSection.component);
  for (const fn of fx) fn();
  await sleep(60);
}

const snap = () => renderKeep(settingsSection.component);

function findLink(tree, text) {
  return find(tree, (n) => n.type === 'a' && textOf(n).indexOf(text) >= 0);
}

const okQuota = () => ({ status: 200, body: JSON.stringify({ remaining: 25, dailyLimit: 30 }) });
const okSend = (remaining) => ({ status: 200, body: JSON.stringify({ ok: true, remaining }) });

const feedbackChecks = [];
let feedbackFailed = 0;
function fb(name, fn) {
  try {
    fn();
    feedbackChecks.push([name, true]);
  } catch (e) {
    feedbackFailed += 1;
    feedbackChecks.push([name + ' —— ' + e.message, false]);
  }
}

await (async () => {
  await mountFeedback((args) => (args.url.endsWith('/quota') ? okQuota() : okSend(24)));
  const tree = snap();

  fb('反馈：两种渠道都在，Issue 链接指向本仓库', () => {
    assert.ok(byClass(tree, 'sp-feedback-text'), '应有反馈输入框');
    assert.equal(byClass(tree, 'sp-feedback-text').props.maxLength, 1000);
    const link = findLink(tree, '通过 GitHub 提 Issue');
    assert.ok(link, '应有 Issue 链接');
    assert.ok(
      link.props.href.indexOf('https://github.com/renhao-wan/ccgui-plugin-slash-palette/issues/new?') === 0,
      '链接应指向本仓库：' + link.props.href,
    );
  });

  fb('反馈：额度文案用服务端回传的真实值', () => {
    const q = textOf(byClass(tree, 'sp-feedback-quota'));
    assert.ok(q.indexOf('25') >= 0, '应显示 25，实际：' + q);
    assert.equal(byClass(tree, 'sp-feedback-quota-retry'), null, '有额度时不该挂重试按钮');
  });

  byClass(tree, 'sp-feedback-text').props.onChange({
    target: { value: '点「/ 命令」后按 Enter 没反应\nError: boom\n    at insert (main.js:12)' },
  });
  const filled = snap();
  fb('反馈：正文保留换行与堆栈缩进', () => {
    const v = byClass(filled, 'sp-feedback-text').props.value;
    assert.ok(/\nError: boom\n {4}at insert/.test(v), '实际：' + JSON.stringify(v));
    assert.ok(/^\d+ \/ 1000$/.test(textOf(byClass(filled, 'sp-feedback-count'))), '字数应显示 n / 1000');
  });

  const sendBtn = byClass(filled, 'sp-feedback-send');
  fb('反馈：有内容时发送按钮可用', () => {
    assert.ok(sendBtn, '应有发送按钮');
    assert.equal(sendBtn.props.disabled, false);
  });
  sendBtn.props.onClick();
  sendBtn.props.onClick(); // 同一 tick 连点两次
  await sleep(100);

  fb('反馈：同一 tick 连点两次只发一条，请求体只有白名单字段', () => {
    const posts = httpCalls.filter((c) => c.url.endsWith('/feedback'));
    assert.equal(posts.length, 1, '应只发 1 条，实际 ' + posts.length);
    const payload = JSON.parse(posts[0].body);
    assert.deepEqual(Object.keys(payload).sort(), ['hostVersion', 'pluginId', 'pluginVersion', 'text', 'ts']);
    assert.equal(payload.pluginId, 'slash-palette');
    assert.equal(posts[0].method, 'POST');
  });

  const sent = snap();
  fb('反馈：成功后清空正文、按钮显示已发送、额度用回传值', () => {
    assert.equal(byClass(sent, 'sp-feedback-text').props.value, '');
    assert.ok(textOf(byClass(sent, 'sp-feedback-send')).indexOf('已发送') >= 0, '按钮应变成「已发送」');
    assert.ok(textOf(byClass(sent, 'sp-feedback-quota')).indexOf('24') >= 0, '额度应更新为 24');
    assert.ok(textOf(byClass(sent, 'sp-feedback-status')).indexOf('已发送') >= 0);
  });
})();

await (async () => {
  // 200 但不是我们的 JSON（运营商劫持页 / 登录门户）
  await mountFeedback((args) =>
    args.url.endsWith('/quota') ? okQuota() : { status: 200, body: '<html>请登录校园网</html>' },
  );
  byClass(snap(), 'sp-feedback-text').props.onChange({ target: { value: '被劫持' } });
  byClass(snap(), 'sp-feedback-send').props.onClick();
  await sleep(80);
  const t = snap();
  fb('反馈：200 但正文不是我们的 JSON 时不当成功', () => {
    assert.ok(textOf(t).indexOf('已发送') < 0, '劫持页不能判成功');
    assert.ok(textOf(byClass(t, 'sp-feedback-status')).indexOf('GitHub Issue') >= 0);
    assert.notEqual(byClass(t, 'sp-feedback-text').props.value, '', '失败时正文必须留着');
  });
})();

await (async () => {
  await mountFeedback((args) => {
    if (args.url.endsWith('/quota')) return okQuota();
    throw new Error('net::ERR_NAME_NOT_RESOLVED');
  });
  byClass(snap(), 'sp-feedback-text').props.onChange({ target: { value: '断网' } });
  byClass(snap(), 'sp-feedback-send').props.onClick();
  await sleep(80);
  const t = snap();
  fb('反馈：网络不通时提示检查网络或代理', () => {
    const s = textOf(byClass(t, 'sp-feedback-status'));
    assert.ok(/网络|代理/.test(s), s);
    assert.ok(s.indexOf('GitHub Issue') >= 0);
  });
})();

await (async () => {
  await mountFeedback((args) => (args.url.endsWith('/quota') ? { status: 500, body: 'boom' } : okSend(23)));
  const tree = snap();
  fb('反馈：额度查不到时说连不上并给重试入口', () => {
    assert.ok(/连不上|暂时/.test(textOf(byClass(tree, 'sp-feedback-quota'))));
    assert.ok(byClass(tree, 'sp-feedback-quota-retry'), '应有重试按钮');
  });

  httpResponder = () => okQuota();
  const before = httpCalls.filter((c) => c.url.endsWith('/quota')).length;
  byClass(snap(), 'sp-feedback-quota-retry').props.onClick();
  await sleep(80);
  fb('反馈：重试按钮会重新查额度', () => {
    assert.equal(httpCalls.filter((c) => c.url.endsWith('/quota')).length, before + 1);
    assert.ok(textOf(byClass(snap(), 'sp-feedback-quota')).indexOf('25') >= 0);
  });

  // 发送成功时顺手把「连不上」纠正成服务端回传的额度
  httpResponder = (args) => (args.url.endsWith('/quota') ? { status: 500, body: 'boom' } : okSend(23));
  byClass(snap(), 'sp-feedback-text').props.onChange({ target: { value: '一条反馈' } });
  byClass(snap(), 'sp-feedback-send').props.onClick();
  await sleep(80);
  const after = snap();
  fb('反馈：额度查不到但发送成功，额度区不再停留在连不上', () => {
    const q = textOf(byClass(after, 'sp-feedback-quota'));
    assert.ok(q.indexOf('23') >= 0, q);
    assert.ok(q.indexOf('连不上') < 0, q);
  });
})();

await (async () => {
  await mountFeedback((args) =>
    args.url.endsWith('/quota')
      ? okQuota()
      : { status: 429, body: '{"ok":false,"error":"rate_limited","kind":"burst","remaining":25}' },
  );
  byClass(snap(), 'sp-feedback-text').props.onChange({ target: { value: '发太快' } });
  byClass(snap(), 'sp-feedback-send').props.onClick();
  await sleep(80);
  const t = snap();
  fb('反馈：突发限流说稍等几分钟，不谎报今天用完', () => {
    const s = textOf(byClass(t, 'sp-feedback-status'));
    assert.ok(/太快|稍候|分钟/.test(s), s);
    assert.ok(s.indexOf('明天') < 0, '突发不该说成今天用完');
  });
})();

await (async () => {
  // 回归：中转返回 ok:true 但没带 remaining（旧版中转）。旧写法
  // Number.isFinite(Number(null)) === true 会把它读成 0，界面谎报「今天用完」。
  await mountFeedback((args) =>
    args.url.endsWith('/quota') ? okQuota() : { status: 200, body: '{"ok":true}' },
  );
  byClass(snap(), 'sp-feedback-text').props.onChange({ target: { value: '没有 remaining' } });
  byClass(snap(), 'sp-feedback-send').props.onClick();
  await sleep(80);
  const t = snap();
  fb('反馈：中转没回传额度时按旧值自减，不说「今天用完」', () => {
    const q = textOf(byClass(t, 'sp-feedback-quota'));
    assert.ok(q.indexOf('24') >= 0, '应自减为 24，实际：' + q);
    assert.ok(q.indexOf('用完') < 0, '不能谎报额度耗尽：' + q);
    assert.ok(textOf(byClass(t, 'sp-feedback-send')).indexOf('已发送') >= 0);
  });
})();

httpResponder = null;
try {
  dispose2();
} catch {
  feedbackFailed += 1;
}

const checks = [
  ['注册了状态行控件', !!statusItem],
  ['注册了 overlay', !!overlay],
  ['注册了设置页', !!settingsSection],
  ['注册了命令面板入口', !!paletteCommand],
  ['设置页标题为中文', settingsSection.label() === 'Claude 斜杠命令'],
  ['命令标题为中文', paletteCommand.title() === 'Claude 斜杠命令'],

  ['扫描耗时 < 15 秒', scanMs < 15000],
  ['状态按钮渲染出「命令」', chipText.indexOf('命令') >= 0],
  ['状态按钮渲染出数量', /\d/.test(chipText.replace('命令', ''))],
  ['真实调用了 PowerShell', execCalls.length > 0],

  ['面板渲染出搜索框', !!searchInput],
  ['面板渲染出命令列表', allInvocations.length >= 20],
  ['列表包含插件命名空间命令', !!pluginInvoke],
  ['面板渲染出分组标题', /插件命令|插件技能|用户命令|用户技能/.test(overlayText)],
  ['面板渲染出替换提示', overlayText.indexOf('替换') >= 0],
  ['面板渲染出快捷键提示', overlayText.indexOf('Esc') >= 0],

  ['搜索过滤后仍显示命令', !!filteredInput],
  ['过滤命中目标命名空间', filteredText.toLowerCase().indexOf(needle.toLowerCase()) >= 0],
  ['过滤后列表变短', filteredText.length < overlayText.length],

  ['Enter 写入了一条草稿', drafts.length > 0],
  ['草稿以命令开头', lastDraft.charAt(0) === '/'],
  ['草稿以空格结尾，方便继续写参数', /\s$/.test(lastDraft)],
  ['草稿命令属于插件命名空间', /^\/[^/\s]+:[^/\s]+/.test(lastDraft)],

  ['设置页渲染出来源开关', settingsText.indexOf('插件命令与技能') >= 0],
  ['设置页不再出现项目级开关', settingsText.indexOf('项目命令与技能') < 0],
  ['设置页渲染出刷新按钮', settingsText.indexOf('立即刷新') >= 0],
  ['设置页渲染出诊断路径', settingsText.indexOf('CLI 目录') >= 0],

  ['命令面板入口能重新打开面板', !!reopenedSearch],
  ['面板容器响应 Esc（焦点不在搜索框也有效）', escClosed],
  ['连续切换两个开关互不覆盖', togglesIndependent],
  ['设置加载完成前开关禁用', disabledBeforeLoad],
  ['设置加载完成后开关可用', enabledAfterLoad],
  ['样式通过宿主主题注入一次', injectedCss.length >= 1 && injectedCss[0].indexOf('.sp-chip') >= 0],
  ['卸载函数可安全执行', disposeOk],
  ...feedbackChecks,
];

console.log('\n--- checks ---');
for (const [n, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${n}`);
const all = checks.every(([, ok]) => ok) && feedbackFailed === 0;
console.log(`\n扫描耗时 ${scanMs}ms，列表 ${allInvocations.length} 条，写入 ${JSON.stringify(lastDraft)}`);
console.log(`RESULT=${all ? 'SMOKE_OK' : 'SMOKE_PARTIAL'}`);
process.exit(all ? 0 : 1);
