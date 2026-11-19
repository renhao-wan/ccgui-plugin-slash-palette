// 冒烟测试：用最小 React 替身渲染三个入口，bridge 真实调用 PowerShell。
// 不依赖宿主；只验证「能跑通、扫描有结果、写入参数正确」。
import { execFileSync } from 'node:child_process';

const PLUGIN = new URL('../main.js', import.meta.url).href;

const states = new Map();
let stateIdx = 0;
let refIdx = 0;
const refs = [];
let effects = [];

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => {
    const i = stateIdx++;
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
    const i = refIdx++;
    if (!refs[i]) refs[i] = { current: init === undefined ? null : init };
    return refs[i];
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};

const storageData = new Map();
const clone = (v) => JSON.parse(JSON.stringify(v));
const drafts = [];
const execCalls = [];

let statusItem = null;
let overlay = null;
let settingsSection = null;
let paletteCommand = null;

const ctx = {
  react: fakeReact,
  pluginId: 'slash-palette',
  version: '1.0.0',
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每个组件独立渲染：清空 hooks 槽，避免不同组件串状态
function renderFresh(comp, props) {
  states.clear();
  refs.length = 0;
  stateIdx = 0;
  refIdx = 0;
  effects = [];
  return { tree: comp(props || {}), effects };
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
if (filteredInput && filteredInput.props.onKeyDown) {
  filteredInput.props.onKeyDown({ key: 'Enter', preventDefault() {} });
}
const lastDraft = drafts[drafts.length - 1] || '';

// ---- 第五段：设置页 ----
const settingsTree = renderFresh(settingsSection.component).tree;
const settingsText = textOf(settingsTree);

// ---- 第六段：命令面板入口 ----
paletteCommand.run();
const reopened = renderFresh(overlay.component).tree;
const reopenedSearch = byClass(reopened, 'sp-search');

// ---- 第七段：卸载清理 ----
let disposeOk = true;
try {
  dispose();
} catch {
  disposeOk = false;
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
  ['卸载函数可安全执行', disposeOk],
];

console.log('\n--- checks ---');
for (const [n, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${n}`);
const all = checks.every(([, ok]) => ok);
console.log(`\n扫描耗时 ${scanMs}ms，列表 ${allInvocations.length} 条，写入 ${JSON.stringify(lastDraft)}`);
console.log(`RESULT=${all ? 'SMOKE_OK' : 'SMOKE_PARTIAL'}`);
process.exit(all ? 0 : 1);
