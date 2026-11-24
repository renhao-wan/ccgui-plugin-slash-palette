// 冒烟测试：用最小 React 替身渲染三个入口，bridge 真实调用 PowerShell。
// 不依赖宿主；只验证「能跑通、扫描有结果、写入参数正确」。
// 替身不模拟重渲染，因此交互修复（连续开关、按钮焦点下按 Esc）
// 通过直接调用 props 回调覆盖，不覆盖真实 React 生命周期。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const PLUGIN = new URL('../main.js', import.meta.url).href;
const MANIFEST = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

/* ------------------------------------------------------------ React 替身 */

// 替身本体在 ccgui-plugin-shared/fake-react（四插件共用一份源码）。
// 这里保留 `renderFresh` 返回 { tree, effects } 的旧形状：本文件十余处
// 调用点都在用 `.tree`，而 mountFeedback 要手动跑 effect。
import {
  createFakeReact,
  walk,
  textOf,
  byClass,
  findAll,
} from 'ccgui-plugin-shared/fake-react';

// 本文件早年用 `find` 这个名字；保留它，省得改几十处调用点。
const find = (tree, pred) => findAll(tree, pred)[0] || null;

const fake = createFakeReact({ componentName: 'anon' });
const fakeReact = fake.api;

// slash 的组件只依赖 useState/useRef/useSyncExternalStore，effect 由用例自己跑。
// 用一层包装把「这一轮渲染里注册的 effect」收集出来，保持 renderFresh 的返回值不变。
let collectedEffects = [];
const baseUseEffect = fakeReact.useEffect;
fakeReact.useEffect = (fn, deps) => {
  collectedEffects.push({ fn, deps });
  baseUseEffect(fn, deps);
};

function renderFresh(comp, props) {
  collectedEffects = [];
  const tree = fake.renderFresh(comp, props);
  const effects = collectedEffects.map((e) => e.fn);
  return { tree, effects };
}

function renderKeep(comp, props) {
  return fake.renderKeep(comp, props);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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


// 查询辅助（walk / textOf / byClass / findAll / find）来自 ccgui-plugin-shared/fake-react。

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
// TTL 内（刚扫完）再打开面板不应触发第二次扫描，否则等于每次点开都重扫。
const execBeforeReopen = execCalls.length;
paletteCommand.run();
const reopened = renderFresh(overlay.component).tree;
const reopenedSearch = byClass(reopened, 'sp-search');
await sleep(400);
const noRescanWithinTtl = execCalls.length === execBeforeReopen;

// 面板底部刷新按钮：手动强制重扫，不看 TTL。
const refreshBtn = byClass(reopened, 'sp-refresh');
const hasRefreshBtn = !!refreshBtn && textOf(refreshBtn).indexOf('刷新') >= 0;
const execBeforeRefresh = execCalls.length;
if (refreshBtn && refreshBtn.props.onClick) refreshBtn.props.onClick();
await sleep(400);
const refreshRescans = execCalls.length > execBeforeRefresh;

// 超过 TTL 后再打开面板必须强制重扫（用假时钟快进，不改系统时间）。
// 先等手动刷新那次扫描落定，否则快进后的重扫会被 inflight 去重吃掉。
for (let i = 0; i < 100; i++) {
  await sleep(100);
  const t = textOf(renderFresh(overlay.component).tree || []);
  if (t.indexOf('正在扫描') < 0) break;
}
const realNow = Date.now;
const skew = 6 * 60 * 1000; // 超过 5 分钟 TTL
Date.now = () => realNow() + skew;
const execBeforeStale = execCalls.length;
paletteCommand.run();
await sleep(400);
Date.now = realNow;
const staleRescans = execCalls.length > execBeforeStale;

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
// 按设置行标题找开关：新增「项目命令」开关后，按下标取会张冠李戴。
function boxFor(tree, title) {
  const row = find(
    tree,
    (n) =>
      n.props &&
      typeof n.props.className === 'string' &&
      n.props.className.split(' ').includes('sp-setting') &&
      textOf(n).indexOf(title) >= 0,
  );
  if (!row) return null;
  let box = null;
  walk(row, (n) => {
    if (!box && n.type === 'input' && n.props && n.props.type === 'checkbox') box = n;
  });
  return box;
}
const boxPlugins = boxFor(renderFresh(settingsSection.component).tree, '插件命令与技能');
if (boxPlugins) boxPlugins.props.onChange(); // 关闭「插件命令与技能」
const boxBuiltin = boxFor(renderFresh(settingsSection.component).tree, '内置命令');
if (boxBuiltin) boxBuiltin.props.onChange(); // 打开「内置命令」
const afterToggle = renderFresh(settingsSection.component).tree;
const togglesIndependent = !!(
  boxFor(afterToggle, '插件命令与技能') &&
  boxFor(afterToggle, '插件命令与技能').props.checked === false &&
  boxFor(afterToggle, '内置命令') &&
  boxFor(afterToggle, '内置命令').props.checked === true
);
const enabledAfterLoad = checkboxes(afterToggle).every((b) => b.props.disabled !== true) && checkboxes(afterToggle).length > 0;

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

const okQuota = () => ({ status: 200, body: JSON.stringify({ remaining: 1, dailyLimit: 1, fallbackRemaining: 3 }) });
// 发送成功后本插件即进入 48h 冷却（remaining:0），兜底池少一条。
const okSend = () => ({ status: 200, body: JSON.stringify({ ok: true, remaining: 0, dailyLimit: 1, fallbackRemaining: 2 }) });

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
  await mountFeedback((args) => (args.url.includes('/quota') ? okQuota() : okSend()));
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
    assert.ok(/两天|48/.test(q), '应显示「每两天可提交 1 条」，实际：' + q);
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
  fb('反馈：成功后清空正文、按钮显示已发送、额度反映冷却状态', () => {
    assert.equal(byClass(sent, 'sp-feedback-text').props.value, '');
    assert.ok(textOf(byClass(sent, 'sp-feedback-send')).indexOf('已发送') >= 0, '按钮应变成「已发送」');
    assert.ok(/共享|48|两天/.test(textOf(byClass(sent, 'sp-feedback-quota'))), '额度区应反映冷却状态');
    assert.ok(textOf(byClass(sent, 'sp-feedback-status')).indexOf('已发送') >= 0);
  });
})();

await (async () => {
  // 200 但不是我们的 JSON（运营商劫持页 / 登录门户）
  await mountFeedback((args) =>
    args.url.includes('/quota') ? okQuota() : { status: 200, body: '<html>请登录校园网</html>' },
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
    if (args.url.includes('/quota')) return okQuota();
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
  await mountFeedback((args) => (args.url.includes('/quota') ? { status: 500, body: 'boom' } : okSend()));
  const tree = snap();
  fb('反馈：额度查不到时说连不上并给重试入口', () => {
    assert.ok(/连不上|暂时/.test(textOf(byClass(tree, 'sp-feedback-quota'))));
    assert.ok(byClass(tree, 'sp-feedback-quota-retry'), '应有重试按钮');
  });

  httpResponder = () => okQuota();
  const before = httpCalls.filter((c) => c.url.includes('/quota')).length;
  byClass(snap(), 'sp-feedback-quota-retry').props.onClick();
  await sleep(80);
  fb('反馈：重试按钮会重新查额度', () => {
    assert.equal(httpCalls.filter((c) => c.url.includes('/quota')).length, before + 1);
    assert.ok(/两天|48/.test(textOf(byClass(snap(), 'sp-feedback-quota'))));
  });

  // 发送成功时顺手把「连不上」纠正成服务端回传的额度
  httpResponder = (args) => (args.url.includes('/quota') ? { status: 500, body: 'boom' } : okSend());
  byClass(snap(), 'sp-feedback-text').props.onChange({ target: { value: '一条反馈' } });
  byClass(snap(), 'sp-feedback-send').props.onClick();
  await sleep(80);
  const after = snap();
  fb('反馈：额度查不到但发送成功，额度区不再停留在连不上', () => {
    const q = textOf(byClass(after, 'sp-feedback-quota'));
    assert.ok(/共享|48|两天/.test(q), q);
    assert.ok(q.indexOf('连不上') < 0, q);
  });
})();

await (async () => {
  await mountFeedback((args) =>
    args.url.includes('/quota')
      ? okQuota()
      : { status: 429, body: '{"ok":false,"error":"rate_limited","kind":"burst","remaining":25}' },
  );
  byClass(snap(), 'sp-feedback-text').props.onChange({ target: { value: '发太快' } });
  byClass(snap(), 'sp-feedback-send').props.onClick();
  await sleep(80);
  const t = snap();
  fb('反馈：突发限流说稍等几分钟，不谎报额度耗尽', () => {
    const s = textOf(byClass(t, 'sp-feedback-status'));
    assert.ok(/太快|稍候|分钟/.test(s), s);
    assert.ok(s.indexOf('48') < 0, '突发不该说成 48 小时冷却');
  });
})();

await (async () => {
  // 回归：中转返回 ok:true 但没带 remaining（旧版中转）。旧写法
  // Number.isFinite(Number(null)) === true 会把它读成 0，界面谎报「今天用完」。
  await mountFeedback((args) =>
    args.url.includes('/quota') ? okQuota() : { status: 200, body: '{"ok":true}' },
  );
  byClass(snap(), 'sp-feedback-text').props.onChange({ target: { value: '没有 remaining' } });
  byClass(snap(), 'sp-feedback-send').props.onClick();
  await sleep(80);
  const t = snap();
  fb('反馈：中转没回传额度时自减，不谎报额度耗尽', () => {
    const q = textOf(byClass(t, 'sp-feedback-quota'));
    assert.ok(/共享|48|两天/.test(q), '应自减并显示冷却文案，实际：' + q);
    assert.ok(textOf(byClass(t, 'sp-feedback-send')).indexOf('已发送') >= 0);
  });
})();

httpResponder = null;
try {
  dispose2();
} catch {
  feedbackFailed += 1;
}

// ---- 第九段：项目/团队层与禁用覆盖 ----
// fixture 全部落在临时目录：CLAUDE_CONFIG_DIR 隔离全局层，工作区用 getMetadata 注入。
// 独立 import 一份模块（query 串避开上面的 import 缓存），入口各自捕获。
const layered = {
  projCmd: false,
  projSkill: false,
  userOnly: false,
  projectWins: false,
  pluginHidden: false,
  offHidden: false,
  hiddenHint: false,
  projectToggle: false,
  projectDiag: false,
  wsSwitch: false,
  skillPrecedence: false,
  toggleFallback: false,
  pluginSkillKeeps: false,
  emptyListHides: false,
  pathNormalized: false,
  nullWsKeeps: false,
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slash-palette-fixture-"));
{
  const cfgDir = path.join(tmpRoot, "config");
  const pluginDir = path.join(tmpRoot, "plugin");
  const wsDir = path.join(tmpRoot, "ws");
  const write = (rel, text) => {
    const file = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
  };
  const cmd = (desc) => `---\ndescription: ${desc}\n---\nbody\n`;
  const skill = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`;

  write("config/settings.json", JSON.stringify({ enabledPlugins: { "demo@mkt": true } }));
  write(
    "config/plugins/installed_plugins.json",
    JSON.stringify({
      version: 2,
      plugins: { "demo@mkt": [{ scope: "user", installPath: pluginDir }] },
    }),
  );
  write("config/commands/useronly.md", cmd("USER ONLY"));
  write("config/commands/dup.md", cmd("CMD-FROM-USER"));
  write("config/skills/offskill/SKILL.md", skill("offskill", "USER OFF SKILL"));
  write("config/skills/dupskill/SKILL.md", skill("dupskill", "SKILL-FROM-USER"));

  write("plugin/commands/pcmd.md", cmd("PLUGIN CMD"));
  write("plugin/skills/pskill/SKILL.md", skill("pskill", "PLUGIN SKILL"));

  write("ws/.claude/commands/projcmd.md", cmd("PROJECT CMD"));
  write("ws/.claude/commands/dup.md", cmd("CMD-FROM-PROJECT"));
  write("ws/.claude/skills/projskill/SKILL.md", skill("projskill", "PROJECT SKILL"));
  write("ws/.claude/skills/projoff/SKILL.md", skill("projoff", "PROJECT OFF SKILL"));
  write("ws/.claude/skills/dupskill/SKILL.md", skill("dupskill", "SKILL-FROM-PROJECT"));
  // 团队层禁用插件；项目技能 offskill / projoff 关闭。
  write(
    "ws/.claude/settings.json",
    JSON.stringify({
      enabledPlugins: { "demo@mkt": false },
      skillOverrides: { offskill: "off", projoff: "off" },
    }),
  );

  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfgDir;
  let layeredDispose = null;
  try {
    let fItem = null;
    let fOverlay = null;
    let fSettings = null;
    let fCommand = null;
    let layeredWs = wsDir;
    const layeredStorage = new Map();
    const layeredCtx = {
      ...ctx,
      storage: {
        get: async (k) => (layeredStorage.has(k) ? clone(layeredStorage.get(k)) : null),
        set: async (k, v) => layeredStorage.set(k, clone(v)),
        delete: async (k) => layeredStorage.delete(k),
      },
      workspace: { getMetadata: async () => ({ path: layeredWs }) },
      ui: {
        ...ctx.ui,
        registerComposerStatusItem: (def) => {
          fItem = def;
          return () => {};
        },
        registerOverlay: (def) => {
          fOverlay = def;
          return () => {};
        },
        registerSettingsSection: (def) => {
          fSettings = def;
          return () => {};
        },
        registerCommand: (def) => {
          fCommand = def;
          return () => {};
        },
      },
    };
    const mod2 = await import(PLUGIN + "?layered=1");
    layeredDispose = mod2.default(layeredCtx);
    const invokesOf = (tree) => {
      const out = [];
      walk(tree, (n) => {
        if (n.props && typeof n.props.className === "string" && n.props.className.split(" ").includes("sp-invoke")) {
          out.push(textOf(n));
        }
      });
      return out;
    };
    const overlayNow = () => {
      const tree = renderFresh(fOverlay.component).tree;
      return { text: textOf(tree || ""), inv: invokesOf(tree) };
    };
    async function waitFor(pred) {
      for (let i = 0; i < 120; i++) {
        await sleep(100);
        const now = overlayNow();
        if (pred(now)) return now;
      }
      return overlayNow();
    }
    const clickRefresh = () => {
      const tree = renderFresh(fSettings.component).tree;
      const btn = find(tree, (n) => n.type === "button" && textOf(n).indexOf("立即刷新") >= 0);
      if (btn && btn.props.onClick) btn.props.onClick();
    };
    fCommand.run();

    let overlayText2 = "";
    let invokes2 = [];
    for (let i = 0; i < 120; i++) {
      await sleep(100);
      const tree = renderFresh(fOverlay.component).tree;
      overlayText2 = textOf(tree || []);
      invokes2 = [];
      walk(tree, (n) => {
        if (n.props && typeof n.props.className === "string" && n.props.className.split(" ").includes("sp-invoke")) {
          invokes2.push(textOf(n));
        }
      });
      if (overlayText2.indexOf("正在扫描") < 0 && invokes2.length > 0) break;
    }

    layered.projCmd = invokes2.includes("/projcmd");
    layered.projSkill = invokes2.includes("/projskill");
    layered.userOnly = invokes2.includes("/useronly");
    layered.projectWins = overlayText2.includes("CMD-FROM-PROJECT") && !overlayText2.includes("CMD-FROM-USER");
    // 同名技能反过来：个人 > 项目。
    layered.skillPrecedence =
      overlayText2.includes("SKILL-FROM-USER") && !overlayText2.includes("SKILL-FROM-PROJECT");
    layered.pluginHidden = !invokes2.includes("/demo:pcmd") && !invokes2.includes("/demo:pskill");
    layered.offHidden = !invokes2.includes("/offskill") && !invokes2.includes("/projoff");
    layered.hiddenHint = overlayText2.indexOf("已隐藏 4 条") >= 0;

    const settingsTree2 = renderFresh(fSettings.component).tree;
    const settingsText2 = textOf(settingsTree2);
    layered.projectToggle = settingsText2.indexOf("项目命令与技能") >= 0;
    layered.projectDiag = settingsText2.indexOf("工作区：") >= 0;

    // 切换工作区：路径变了应立即重扫，项目层命令随之从列表里消失。
    const ws2 = path.join(tmpRoot, "ws2");
    layeredWs = ws2;
    fs.mkdirSync(layeredWs, { recursive: true });
    const execBeforeSwitch = execCalls.length;
    fCommand.run();
    for (let i = 0; i < 120; i++) {
      await sleep(100);
      const tree = renderFresh(fOverlay.component).tree;
      const inv = [];
      walk(tree, (n) => {
        if (n.props && typeof n.props.className === "string" && n.props.className.split(" ").includes("sp-invoke")) {
          inv.push(textOf(n));
        }
      });
      if (execCalls.length > execBeforeSwitch && !inv.includes("/projcmd") && inv.includes("/useronly")) {
        layered.wsSwitch = true;
        break;
      }
    }

    // 关掉「项目命令与技能」后，同名用户命令必须回补，而不是彻底消失。
    const projBox = boxFor(renderFresh(fSettings.component).tree, "项目命令与技能");
    if (projBox) projBox.props.onChange();
    fCommand.run();
    const afterOff = await waitFor(
      ({ text, inv }) => !inv.includes("/projcmd") && text.includes("CMD-FROM-USER") && !text.includes("CMD-FROM-PROJECT"),
    );
    layered.toggleFallback = afterOff.text.includes("CMD-FROM-USER") && !afterOff.text.includes("CMD-FROM-PROJECT");
    const projBox2 = boxFor(renderFresh(fSettings.component).tree, "项目命令与技能");
    if (projBox2) projBox2.props.onChange();

    // 插件技能不吃 skillOverrides：把 pskill 写成 off，仍应列出 /demo:pskill。
    write("ws2/.claude/settings.json", JSON.stringify({ skillOverrides: { pskill: "off" } }));
    clickRefresh();
    const plugged = await waitFor(({ inv }) => inv.includes("/demo:pskill"));
    layered.pluginSkillKeeps = plugged.inv.includes("/demo:pskill");

    // 空 enabledPlugins 表示「没有插件被启用」，不是「不做过滤」。
    write("config/settings.json", JSON.stringify({ enabledPlugins: {} }));
    clickRefresh();
    const emptied = await waitFor(({ inv }) => !inv.includes("/demo:pcmd") && !inv.includes("/demo:pskill"));
    layered.emptyListHides = !emptied.inv.includes("/demo:pcmd") && !emptied.inv.includes("/demo:pskill");

    // 路径只差尾分隔符和空白时不能触发重扫。
    layeredWs = ws2 + "\\  ";
    const execBeforeNorm = execCalls.length;
    fCommand.run();
    await sleep(700);
    layered.pathNormalized = execCalls.length === execBeforeNorm;
    layeredWs = ws2;

    // getMetadata 返回 null（超时/未授权）时沿用上次工作区，不发起空扫描。
    layeredWs = null;
    const execBeforeNull = execCalls.length;
    fCommand.run();
    await sleep(500);
    layered.nullWsKeeps = execCalls.length === execBeforeNull;
    layeredWs = ws2;
  } finally {
    if (layeredDispose) layeredDispose();
    process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
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
  ['设置页渲染出项目命令开关', settingsText.indexOf('项目命令与技能') >= 0],
  ['设置页渲染出刷新按钮', settingsText.indexOf('立即刷新') >= 0],
  ['设置页渲染出诊断路径', settingsText.indexOf('CLI 目录') >= 0],

  ['命令面板入口能重新打开面板', !!reopenedSearch],
  ['TTL 内重新打开面板不重扫', noRescanWithinTtl],
  ['超过 TTL 后打开面板会重扫', staleRescans],
  ['面板底部有刷新按钮', hasRefreshBtn],
  ['点面板刷新按钮会强制重扫', refreshRescans],
  ['面板容器响应 Esc（焦点不在搜索框也有效）', escClosed],
  ['连续切换两个开关互不覆盖', togglesIndependent],
  ['设置加载完成前开关禁用', disabledBeforeLoad],
  ['设置加载完成后开关可用', enabledAfterLoad],
  ['项目命令出现在面板', layered.projCmd],
  ['项目技能出现在面板', layered.projSkill],
  ['CLAUDE_CONFIG_DIR 生效（用户命令来自 fixture）', layered.userOnly],
  ['同名项目命令覆盖用户命令', layered.projectWins],
  ['项目层禁用插件后其命令与技能不出现', layered.pluginHidden],
  ['skillOverrides=off 的技能不出现', layered.offHidden],
  ['状态行提示隐藏数量', layered.hiddenHint],
  ['设置页有项目命令开关', layered.projectToggle],
  ['设置页诊断显示工作区', layered.projectDiag],
  ['切换工作区后重扫并移除旧项目命令', layered.wsSwitch],
  ['同名技能个人版覆盖项目版', layered.skillPrecedence],
  ['关掉项目开关后同名用户命令回补', layered.toggleFallback],
  ['插件技能不受 skillOverrides 影响', layered.pluginSkillKeeps],
  ['空 enabledPlugins 会隐藏全部插件命令', layered.emptyListHides],
  ['路径仅差尾分隔符/空白时不重扫', layered.pathNormalized],
  ['工作区取不到时沿用上次且不重扫', layered.nullWsKeeps],
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
