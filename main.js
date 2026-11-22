// Claude 斜杠命令：仅扫描本机 Claude Code 的命令源，搜索并写入输入框草稿。
// 单文件 ESM：不能有 import、JSX、eval / new Function。
// 写入只能经 ctx.composer.setDraft；插件无法读取输入框内容或监听按键。

const PLUGIN_ID = 'slash-palette';
const CACHE_KEY = 'slash-palette-cache-v1';
const SETTINGS_KEY = 'slash-palette-settings-v1';
const CACHE_TTL = 10 * 60 * 1000;
// 反馈中转。改主机名要同步 manifest.json 的 network:<host>（精确匹配，不支持通配）。
const FEEDBACK_ENDPOINT = 'https://ccgui-feedback.2653990378.workers.dev';
const FEEDBACK_REPO = 'renhao-wan/ccgui-plugin-slash-palette';
const FEEDBACK_PLUGIN_NAME = 'Claude 斜杠命令';
const FEEDBACK_TIMEOUT_MS = 15000;

const DEFAULT_SETTINGS = {
  plugins: true,
  user: true,
  builtin: false,
  showDesc: true,
};

const GROUP_LABEL = {
  'user-command': '用户命令',
  'user-skill': '用户技能',
  'plugin-command': '插件命令',
  'plugin-skill': '插件技能',
  builtin: '内置命令',
};

const GROUP_ORDER = [
  'user-command',
  'user-skill',
  'plugin-command',
  'plugin-skill',
  'builtin',
];

/* ------------------------------------------------------------------ 反馈纯函数
 * 从 ccgui-plugin-github-trending 的 src/lib/feedback.mjs 原样复制（这个插件
 * 没有构建步骤，只能整段内联）。改这里记得同步那边，两边应当逐字一致。
 * 只回答「发什么」和「回什么」，网络在下方 sendFeedback / fetchQuota 里。
 */

/** 正文上限。再长就不是一条反馈，而是一篇文档了。 */
const TEXT_LIMIT = 1000;

/**
 * 收敛用户输入：去控制字符、统一换行、折叠连续空行与行尾空白、限长。
 * 保留大小写、中文、emoji 与**换行**——用户最常贴的就是报错日志，
 * 压成一行后堆栈就没法看了。
 */
function normaliseFeedbackText(raw) {
  return String(raw === undefined || raw === null ? '' : raw)
    // 先统一换行，再剥控制字符（保留 \n）。制表符换成空格——堆栈缩进有用。
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f�]/g, '')
    // 只去行尾空白与整段的首尾空白。**正文内行首缩进要留着**：
    // 报错堆栈靠它对齐，去掉后 `at fetch` 就和日志正文混在一起了。
    .replace(/[ \t]+$/gm, '')
    .replace(/^[ \t]+/, '')
    // 三个以上连续换行压成两个（一段空行），既保留分段又不留大片空白。
    .replace(/\n{3,}/g, '\n\n')
    // 首尾空行去掉。
    .replace(/^\n+|\n+$/g, '')
    .slice(0, TEXT_LIMIT)
    .replace(/[ \t\n]+$/, '');
}

/**
 * GitHub 新建 Issue 的预填链接。
 *
 * 用预填而不是直接调 API：API 要 PAT，PAT 写进插件源码等于公开。预填链接
 * 只依赖用户浏览器里已有的登录态，插件一行网络代码都不用写。
 */
function buildIssueUrl(o) {
  const text = normaliseFeedbackText(o.text);
  const body = [
    text || '_（请在这里描述问题或建议）_',
    '',
    '---',
    '插件：' + String(o.pluginName || '') + ' ' + String(o.pluginVersion || ''),
    'CC GUI：' + String(o.hostVersion || ''),
  ].join('\n');
  const q = new URLSearchParams({
    title: '[反馈] ' + String(o.pluginName || ''),
    body,
  });
  return 'https://github.com/' + String(o.repo || '') + '/issues/new?' + q.toString();
}

/** 请求体允许的字段。白名单而非黑名单：漏传字段比误传路径好。 */
const PAYLOAD_FIELDS = ['text', 'pluginId', 'pluginVersion', 'hostVersion', 'ts'];

/** 组装发往中转的请求体，只保留白名单字段。 */
function buildFeedbackPayload(o) {
  const src = {
    text: normaliseFeedbackText(o.text),
    pluginId: String(o.pluginId || ''),
    pluginVersion: String(o.pluginVersion || ''),
    hostVersion: String(o.hostVersion || ''),
    ts: Number(o.now) || Date.now(),
  };
  const out = {};
  for (const k of PAYLOAD_FIELDS) out[k] = src[k];
  return out;
}

function parseJsonBody(body) {
  if (typeof body !== 'string' || !body) return null;
  try {
    const v = JSON.parse(body);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * 把服务端给的额度字段收敛成 number | null。
 *
 * 别用 Number.isFinite(Number(v))：Number(null) 与 Number('') 都是 0，
 * 于是「中转没带这个字段」会被读成「今天 0 条额度」，界面就对刚发送成功的
 * 用户说「今天的额度已用完」。这里只认真正的数字与非空数字字符串。
 */
function quotaCount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    if (!v.trim()) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 发送成功后更新界面上的剩余额度：服务端回传的优先，没给就按旧值自减一条。
 */
function nextQuota(prev, fromServer) {
  const n = quotaCount(fromServer);
  if (n !== null) {
    return { remaining: n, dailyLimit: (prev && prev.dailyLimit) || 30 };
  }
  const prevRemaining = prev && typeof prev.remaining === 'number' ? prev.remaining : null;
  if (prevRemaining === null) return prev;
  return { remaining: Math.max(0, prevRemaining - 1), dailyLimit: prev.dailyLimit || 30 };
}

/**
 * 把一次中转响应翻译成界面文案。
 *
 * 一条原则：**永远给出「你还能做什么」**。反馈发不出去不是用户的错，
 * 所以每条失败文案都要么说清原因，要么指向还能走的路（GitHub Issue）。
 */
function describeFeedbackResult(r) {
  if (r && r.error) {
    const raw = String(r.error.message || r.error);
    if (/timed?\s*out|timeout|ETIMEDOUT/i.test(raw)) {
      return {
        ok: false,
        kind: 'timeout',
        message: '发送超时。中转可能被网络挡住，可改用 GitHub Issue 反馈',
        remaining: null,
      };
    }
    if (/network:|permission|授权/i.test(raw)) {
      return { ok: false, kind: 'denied', message: '网络权限未生效，请重新安装插件', remaining: null };
    }
    // DNS 污染、代理没开、防火墙——国内最常见的三种，用户分不清，
    // 但「检查网络或代理」这句对他们是有用的动作。
    return {
      ok: false,
      kind: 'network',
      message: '连不上反馈服务，请检查网络或代理，也可改用 GitHub Issue 反馈',
      remaining: null,
    };
  }

  const status = Number(r && r.status) || 0;
  const data = parseJsonBody(r && r.body);
  const remaining = data ? quotaCount(data.remaining) : null;
  const code = data && typeof data.error === 'string' ? data.error : '';

  if (status >= 200 && status < 300) {
    // 成功响应必须带 ok:true。只看状态码会把运营商劫持页、登录门户、
    // 代理错误页（都会返回 200）当成「已发送」——用户以为发出去了，
    // 实际什么都没有。
    if (!data || data.ok !== true) {
      return {
        ok: false,
        kind: 'garbled',
        message: '反馈服务返回了无法识别的内容，可能被网络拦截，可改用 GitHub Issue 反馈',
        remaining: null,
      };
    }
    return { ok: true, kind: 'sent', message: '反馈已发送，谢谢', remaining };
  }

  if (status === 429) {
    // kind 是 Worker 给的：burst = 10 分钟窗口撞了，daily = 今天真没了。
    // 分不清就按 daily 说——让人等十分钟比让人白等一天更糟。
    const burst = data && data.kind === 'burst';
    return {
      ok: false,
      kind: 'rate_limited',
      message: burst
        ? '发得太快了，稍等几分钟再试，或改用 GitHub Issue 反馈'
        : '今天的反馈额度已用完，明天再来，或改用 GitHub Issue 反馈',
      // burst 时今天还有额度，写死 0 会让界面谎报「今天用完了」。
      remaining: burst ? remaining : 0,
    };
  }

  if (status === 413) {
    return { ok: false, kind: 'invalid', message: '反馈内容太长了，请缩短后重试', remaining };
  }

  if (status === 400) {
    // 400 的几种原因要分开说：empty_text 是用户没写，unknown_plugin 是
    // 版本错位，叫用户去「缩短内容」是把他引到错的方向。
    if (code === 'unknown_plugin') {
      return {
        ok: false,
        kind: 'invalid',
        message: '中转不认识这个插件版本，请更新插件，或改用 GitHub Issue 反馈',
        remaining,
      };
    }
    if (code === 'empty_text') {
      return { ok: false, kind: 'invalid', message: '反馈内容是空的，写点内容再发', remaining };
    }
    return { ok: false, kind: 'invalid', message: '反馈内容不合要求，请缩短后重试', remaining };
  }

  if (status === 502 || status === 503 || status === 500) {
    return {
      ok: false,
      kind: 'http',
      // 502 = 发不出邮件、503 = KV 不可用、500 = 中转内部错误。
      // 三种都是中转那边的事，用户唯一能做的是稍后再试或换 Issue。
      message: '中转暂时不可用，稍后再试，或改用 GitHub Issue 反馈',
      remaining,
    };
  }

  if (status === 0) {
    // 请求根本没拿到响应：和网络错误一样处理，别把 "HTTP 0" 甩给用户。
    return {
      ok: false,
      kind: 'network',
      message: '连不上反馈服务，请检查网络或代理，也可改用 GitHub Issue 反馈',
      remaining: null,
    };
  }

  return {
    ok: false,
    kind: 'http',
    message: '发送失败（HTTP ' + status + '），可改用 GitHub Issue 反馈',
    remaining,
  };
}

/**
 * 额度提示文案。查不到额度时也要给一句话，不能空着。
 *
 * 两种「查不到」要分开：
 *   - `{offline: true}`：请求失败（网络/代理/中转挂了）。说「额度有限」
 *     会把网络故障说成用户在刷屏，把他引到错误的方向。
 *   - 其他：服务端回了但字段脏，或压根没查。这时该提醒别刷屏。
 */
function describeQuota(quota) {
  if (quota && quota.offline) {
    return { remaining: null, message: '暂时连不上反馈服务，发送时再试', canRetry: true };
  }
  // Number(null) === 0、Number("") === 0：不显式挡掉，脏数据会被读成「0 条」，
  // 界面就说「今天的额度已用完」。先用「是不是数字」把它挡在这一层。
  const raw = quota ? quota.remaining : undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { remaining: null, message: '额度有限，请勿刷屏', canRetry: true };
  }
  const remaining = Math.max(0, raw);
  if (remaining === 0) {
    return { remaining: 0, message: '今天的反馈额度已用完，明天再来', canRetry: true };
  }
  return { remaining, message: '今天还可发 ' + remaining + ' 条反馈', canRetry: false };
}

// 宿主可能已经自己处理这些命令，默认不显示，避免重复
const BUILTIN = [
  { kind: 'builtin', invoke: '/help', description: '显示帮助与可用命令', hint: '', plugin: '', marketplace: '', path: '' },
  { kind: 'builtin', invoke: '/clear', description: '清空当前对话', hint: '', plugin: '', marketplace: '', path: '' },
  { kind: 'builtin', invoke: '/compact', description: '压缩上下文，保留摘要', hint: '', plugin: '', marketplace: '', path: '' },
  { kind: 'builtin', invoke: '/model', description: '切换当前会话模型', hint: '', plugin: '', marketplace: '', path: '' },
  { kind: 'builtin', invoke: '/status', description: '查看会话与引擎状态', hint: '', plugin: '', marketplace: '', path: '' },
  { kind: 'builtin', invoke: '/cost', description: '查看本次会话用量与费用', hint: '', plugin: '', marketplace: '', path: '' },
];

const UI_CSS = `
@keyframes sp-spin { to { transform: rotate(360deg); } }
@keyframes sp-fade { from { opacity: 0; transform: translateY(4px) scale(.995); } to { opacity: 1; transform: none; } }
.sp-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 7px;
  border: 1px solid var(--color-separator-border, rgba(127,127,127,.28));
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary, #656d76);
  font: inherit;
  font-size: 11.5px;
  line-height: 1;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.sp-chip:hover, .sp-chip-open {
  background: var(--color-background-tertiary-hover, rgba(127,127,127,.12));
  color: var(--color-text-primary, #1f2328);
  border-color: var(--color-accent-primary-default, #3b82f6);
}
.sp-chip:disabled { opacity: .5; cursor: not-allowed; }
.sp-slash { font-weight: 700; color: var(--color-accent-primary-default, #3b82f6); }
.sp-count {
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--color-background-tertiary-hover, rgba(127,127,127,.16));
  color: var(--color-text-secondary, #656d76);
  font-size: 10.5px;
  text-align: center;
}
.sp-toast {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--color-accent-primary-default, #3b82f6);
  animation: sp-fade 160ms ease-out;
}
.sp-toast-error { color: var(--color-danger, #d1242f); }
.sp-spinner {
  display: inline-block;
  width: 11px;
  height: 11px;
  flex: none;
  border: 2px solid var(--color-separator-border, rgba(127,127,127,.3));
  border-top-color: var(--color-accent-primary-default, #3b82f6);
  border-radius: 50%;
  animation: sp-spin .8s linear infinite;
}
.sp-mask {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6vh 16px;
  background: rgba(0, 0, 0, .38);
  pointer-events: auto;
}
.sp-panel {
  display: flex;
  flex-direction: column;
  width: min(640px, 100%);
  max-height: 78vh;
  overflow: hidden;
  border: 1px solid var(--color-separator-border, rgba(127,127,127,.28));
  border-radius: 12px;
  background: var(--color-background-primary-default, #fff);
  color: var(--color-text-primary, #1f2328);
  box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
  animation: sp-fade 140ms ease-out;
}
.sp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--color-separator-border, rgba(127,127,127,.2));
}
.sp-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: none;
  border-radius: 7px;
  background: var(--color-accent-primary-default, #3b82f6);
  color: #fff;
  font-weight: 700;
  font-size: 15px;
}
.sp-search {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--color-separator-border, rgba(127,127,127,.28));
  border-radius: 7px;
  outline: none;
  background: var(--color-background-secondary-default, transparent);
  color: inherit;
  font: inherit;
  font-size: 13.5px;
}
.sp-search:focus { border-color: var(--color-accent-primary-default, #3b82f6); }
.sp-close {
  width: 26px;
  height: 26px;
  flex: none;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary, #656d76);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.sp-close:hover { background: var(--color-background-tertiary-hover, rgba(127,127,127,.12)); }
.sp-status {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 14px;
  border-bottom: 1px solid var(--color-separator-border, rgba(127,127,127,.14));
  color: var(--color-text-secondary, #656d76);
  font-size: 11.5px;
}
.sp-status-error { color: var(--color-danger-default, #cf222e); }
.sp-status-warn { color: var(--color-warning-default, #9a6700); }
.sp-retry {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: var(--color-accent-primary-default, #3b82f6);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.sp-list { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 6px 6px 8px; }
.sp-group {
  padding: 8px 8px 5px;
  color: var(--color-text-tertiary, #8b949e);
  font-size: 10.5px;
  letter-spacing: .04em;
}
.sp-item {
  display: flex;
  align-items: baseline;
  gap: 9px;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.sp-item-active { background: var(--color-background-tertiary-hover, rgba(127,127,127,.13)); }
.sp-invoke {
  flex: none;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-accent-primary-default, #3b82f6);
  font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 12.5px;
}
.sp-desc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-secondary, #656d76);
  font-size: 12px;
}
.sp-hint {
  flex: none;
  color: var(--color-text-tertiary, #8b949e);
  font-family: var(--font-family-mono, ui-monospace, monospace);
  font-size: 11px;
}
.sp-empty {
  padding: 34px 12px;
  color: var(--color-text-secondary, #656d76);
  font-size: 12.5px;
  text-align: center;
}
.sp-foot {
  display: flex;
  gap: 12px;
  justify-content: space-between;
  padding: 8px 14px;
  border-top: 1px solid var(--color-separator-border, rgba(127,127,127,.2));
  color: var(--color-text-tertiary, #8b949e);
  font-size: 11px;
}
.sp-foot-warn { color: var(--color-warning-default, #9a6700); }
.sp-settings { display: flex; flex-direction: column; gap: 12px; padding: 4px 0; }
.sp-setting {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 10px;
  border: 1px solid var(--color-separator-border, rgba(127,127,127,.2));
  border-radius: 8px;
}
.sp-setting input { margin-top: 2px; }
.sp-setting input:disabled { opacity: .45; cursor: default; }
.sp-setting-title { font-size: 12.5px; font-weight: 600; }
.sp-setting-desc { margin-top: 2px; color: var(--color-text-secondary, #656d76); font-size: 11.5px; }
.sp-actions { display: flex; align-items: center; gap: 10px; }
.sp-btn {
  padding: 5px 11px;
  border: 1px solid var(--color-separator-border, rgba(127,127,127,.28));
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.sp-btn:hover { background: var(--color-background-tertiary-hover, rgba(127,127,127,.12)); }
.sp-diag {
  padding: 9px 10px;
  border-radius: 8px;
  background: var(--color-background-secondary-default, rgba(127,127,127,.06));
  color: var(--color-text-secondary, #656d76);
  font-family: var(--font-family-mono, ui-monospace, monospace);
  font-size: 11px;
  line-height: 1.7;
  word-break: break-all;
}
@media (prefers-reduced-motion: reduce) {
  .sp-spinner, .sp-panel, .sp-toast { animation: none; }
}

/* ---------- 反馈 ---------- */
.sp-feedback { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.sp-feedback-text {
  width: 100%; min-height: 84px; box-sizing: border-box; resize: vertical;
  padding: 8px 10px; border: 1px solid var(--color-separator-border, rgba(127,127,127,.28));
  border-radius: 6px; background: transparent; color: inherit;
  font: inherit; font-size: 12px; line-height: 1.6;
}
.sp-feedback-text:focus { outline: 2px solid var(--color-accent-primary-default, #3b82f6); outline-offset: -1px; }
.sp-feedback-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.sp-feedback-count { font-variant-numeric: tabular-nums; }
.sp-feedback-quota { text-align: right; }
.sp-link-btn {
  margin-left: 6px; padding: 0; border: 0; background: none;
  font: inherit; font-size: 11.5px; color: var(--color-accent-primary-default, #3b82f6);
  text-decoration: underline; cursor: pointer;
}
.sp-link-btn:disabled { opacity: .45; cursor: not-allowed; }
.sp-link-btn:focus-visible { outline: 2px solid var(--color-accent-primary-default, #3b82f6); outline-offset: 2px; }
.sp-feedback-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
/* <a> 当按钮用：补上和 .sp-btn 一样的外观 */
.sp-feedback-issue {
  display: inline-flex; align-items: center; height: 26px; box-sizing: border-box;
  padding: 0 11px; border: 1px solid var(--color-separator-border, rgba(127,127,127,.28));
  border-radius: 6px; background: transparent; color: inherit;
  font-size: 12px; line-height: 1; text-decoration: none;
}
.sp-feedback-issue:hover { background: var(--color-background-tertiary-hover, rgba(127,127,127,.12)); }
.sp-btn.sp-btn-primary { border-color: var(--color-accent-primary-default, #3b82f6); }
.sp-btn:disabled { opacity: .45; cursor: not-allowed; }
.sp-btn.sp-btn-primary:disabled { opacity: .45; }
.sp-feedback-status { font-size: 12px; line-height: 1.6; }
.sp-feedback-status.is-ok { color: var(--color-text-success, #2e7d32); font-weight: 500; }
.sp-feedback-status.is-bad { color: var(--color-text-danger, #c4242a); }
/* 成功回执：按钮从「主操作」变成「已完成」。opacity:1 是必须的——
 * :disabled 的 .45 会把它糊成灰色，等于没改。 */
.sp-btn.sp-feedback-sent { border-color: var(--color-text-success, #2e7d32); color: var(--color-text-success, #2e7d32); opacity: 1; cursor: default; }
`;

// PowerShell 用 -EncodedCommand 传入，必须是 UTF-16LE + base64
function toEncodedCommand(script) {
  const bytes = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i);
    bytes[i * 2] = c & 0xff;
    bytes[i * 2 + 1] = (c >> 8) & 0xff;
  }
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  let b64 = '';
  try {
    b64 = btoa(bin);
  } catch {
    return '';
  }
  return b64;
}

const SCAN_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$homeDir = $env:USERPROFILE
if ([string]::IsNullOrWhiteSpace($homeDir)) { $homeDir = $HOME }
$claudeDir = Join-Path $homeDir '.claude'

$rows = New-Object System.Collections.ArrayList
$seen = @{}

function Read-Meta {
  param([string]$Path)
  $desc = ''
  $hint = ''
  # 读前 160 行足以覆盖 frontmatter；超长 frontmatter 的命令极少数会丢 description
  $lines = @(Get-Content -LiteralPath $Path -TotalCount 160 -Encoding UTF8 -ErrorAction SilentlyContinue)
  if ($lines.Count -eq 0) { return [pscustomobject]@{ description = ''; hint = '' } }
  $i = 0
  while ($i -lt $lines.Count -and [string]::IsNullOrWhiteSpace([string]$lines[$i])) { $i++ }
  if ($i -ge $lines.Count -or ([string]$lines[$i]).Trim() -ne '---') {
    return [pscustomobject]@{ description = ''; hint = '' }
  }
  $field = ''
  $buf = New-Object System.Collections.ArrayList
  for ($j = $i + 1; $j -lt $lines.Count; $j++) {
    $line = [string]$lines[$j]
    if ($line.Trim() -eq '---') { break }
    if ($field -ne '') {
      if ($line -match '^\s+\S') { [void]$buf.Add($line.Trim()); continue }
      if ($field -eq 'description') { $desc = ($buf -join ' ') } else { $hint = ($buf -join ' ') }
      $field = ''
      $buf.Clear()
    }
    if ($line -match '^description:\s*(.*)$') {
      $v = $Matches[1].Trim()
      if ($v -eq '|' -or $v -eq '>' -or $v -eq '|-' -or $v -eq '>-' -or $v -eq '|+' -or $v -eq '>+') { $field = 'description' }
      else { $desc = $v.Trim('"').Trim("'") }
    } elseif ($line -match '^argument-hint:\s*(.*)$') {
      $v = $Matches[1].Trim()
      if ($v -eq '|' -or $v -eq '>' -or $v -eq '|-' -or $v -eq '>-' -or $v -eq '|+' -or $v -eq '>+') { $field = 'hint' }
      else { $hint = $v.Trim('"').Trim("'") }
    }
  }
  if ($field -eq 'description' -and $buf.Count -gt 0) { $desc = ($buf -join ' ') }
  elseif ($field -eq 'hint' -and $buf.Count -gt 0) { $hint = ($buf -join ' ') }
  return [pscustomobject]@{ description = $desc; hint = $hint }
}

function Add-Row {
  param([string]$Kind, [string]$Invoke, [string]$Description, [string]$Hint, [string]$Plugin, [string]$Marketplace, [string]$Path)
  if ([string]::IsNullOrWhiteSpace($Invoke)) { return }
  $k = $Invoke.ToLowerInvariant()
  if ($seen.ContainsKey($k)) { return }
  $seen[$k] = 1
  [void]$rows.Add([pscustomobject]@{
    kind = $Kind
    invoke = $Invoke
    description = $Description
    hint = $Hint
    plugin = $Plugin
    marketplace = $Marketplace
    path = $Path
  })
}

function Strip-Rel {
  param([string]$Root, [string]$Full)
  # 大小写无关地剥掉根前缀；短名/长名不一致时回退到文件名，避免切出半截路径
  $root = ($Root -replace '[\\/]+$', '')
  if ($Full.Length -gt $root.Length -and $Full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    $rel = $Full.Substring($root.Length)
  } else {
    $rel = [IO.Path]::GetFileName($Full)
  }
  if ($rel.StartsWith('\') -or $rel.StartsWith('/')) { $rel = $rel.Substring(1) }
  if ($rel.ToLowerInvariant().EndsWith('.md')) { $rel = $rel.Substring(0, $rel.Length - 3) }
  return ($rel -replace '[\\/]', ':')
}

# --- 用户级 ---
$userCmd = Join-Path $claudeDir 'commands'
if (Test-Path -LiteralPath $userCmd) {
  foreach ($f in @(Get-ChildItem -LiteralPath $userCmd -Recurse -File -Filter *.md -Attributes !ReparsePoint -ErrorAction SilentlyContinue)) {
    $meta = Read-Meta $f.FullName
    Add-Row 'user-command' ('/' + (Strip-Rel $userCmd $f.FullName)) $meta.description $meta.hint '' '' $f.FullName
  }
}
$userSkill = Join-Path $claudeDir 'skills'
if (Test-Path -LiteralPath $userSkill) {
  foreach ($d in @(Get-ChildItem -LiteralPath $userSkill -Directory -Attributes !ReparsePoint -ErrorAction SilentlyContinue)) {
    $md = Join-Path $d.FullName 'SKILL.md'
    if (-not (Test-Path -LiteralPath $md)) { continue }
    $meta = Read-Meta $md
    Add-Row 'user-skill' ('/' + $d.Name) $meta.description $meta.hint '' '' $md
  }
}

# --- 插件：优先用 Claude Code 记录的安装路径与启用清单 ---
# installed_plugins.json 的 installPath 是当前真正加载的目录（版本名可能是 commit hash），
# 比按目录名或修改时间猜版本可靠；settings.json 的 enabledPlugins 决定插件命令是否可用。
$cacheRoot = Join-Path $claudeDir 'plugins\cache'
$entries = New-Object System.Collections.ArrayList
$installedFile = Join-Path $claudeDir 'plugins\installed_plugins.json'
$settingsFile = Join-Path $claudeDir 'settings.json'
$installed = $null
$enabledPlugins = $null

if (Test-Path -LiteralPath $installedFile) {
  try {
    $rawInstalled = Get-Content -LiteralPath $installedFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($rawInstalled -and $rawInstalled.plugins) { $installed = $rawInstalled.plugins }
  } catch {}
}
if (Test-Path -LiteralPath $settingsFile) {
  try {
    $cfg = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg -and $cfg.PSObject.Properties['enabledPlugins']) { $enabledPlugins = $cfg.enabledPlugins }
  } catch {}
}

if ($installed) {
  foreach ($prop in $installed.PSObject.Properties) {
    $key = [string]$prop.Name
    # 有启用清单时只保留显式启用的插件，避免列出装了但没开的命令
    if ($enabledPlugins -ne $null) {
      $ep = $enabledPlugins.PSObject.Properties[$key]
      if (-not $ep -or $ep.Value -ne $true) { continue }
    }
    $list = @($prop.Value)
    if ($list.Count -eq 0) { continue }
    $pick = $null
    foreach ($e in $list) { if ($e.scope -eq 'user') { $pick = $e; break } }
    if (-not $pick) { $pick = $list[0] }
    $dir = [string]$pick.installPath
    if ([string]::IsNullOrWhiteSpace($dir) -or -not (Test-Path -LiteralPath $dir)) { continue }
    $at = $key.LastIndexOf('@')
    $pluginName = if ($at -gt 0) { $key.Substring(0, $at) } else { $key }
    $marketName = if ($at -gt 0) { $key.Substring($at + 1) } else { '' }
    [void]$entries.Add([pscustomobject]@{ market = $marketName; plugin = $pluginName; dir = $dir })
  }
} elseif (Test-Path -LiteralPath $cacheRoot) {
  # 回退：没有安装清单时遍历缓存。时间相同则按语义版本、最后按目录名兜底。
  foreach ($market in @(Get-ChildItem -LiteralPath $cacheRoot -Directory -Attributes !ReparsePoint -ErrorAction SilentlyContinue)) {
    foreach ($plugin in @(Get-ChildItem -LiteralPath $market.FullName -Directory -Attributes !ReparsePoint -ErrorAction SilentlyContinue)) {
      $versions = @(Get-ChildItem -LiteralPath $plugin.FullName -Directory -Attributes !ReparsePoint -ErrorAction SilentlyContinue)
      if ($versions.Count -eq 0) { continue }
      $latest = $versions |
        Sort-Object @{ Expression = { $_.LastWriteTime } }, @{ Expression = { $vm = [regex]::Match($_.Name, '\d+\.\d+\.\d+'); if ($vm.Success) { [version]$vm.Value } else { [version]'0.0.0' } } }, @{ Expression = { $_.Name } } -Descending |
        Select-Object -First 1
      [void]$entries.Add([pscustomobject]@{ market = $market.Name; plugin = $plugin.Name; dir = $latest.FullName })
    }
  }
}
  foreach ($e in $entries) {
    $cmdRoot = Join-Path $e.dir 'commands'
    if (Test-Path -LiteralPath $cmdRoot) {
      foreach ($f in @(Get-ChildItem -LiteralPath $cmdRoot -Recurse -File -Filter *.md -Attributes !ReparsePoint -ErrorAction SilentlyContinue)) {
        $meta = Read-Meta $f.FullName
        Add-Row 'plugin-command' ('/' + $e.plugin + ':' + (Strip-Rel $cmdRoot $f.FullName)) $meta.description $meta.hint $e.plugin $e.market $f.FullName
      }
    }
    $skillRoot = Join-Path $e.dir 'skills'
    if (Test-Path -LiteralPath $skillRoot) {
      foreach ($d in @(Get-ChildItem -LiteralPath $skillRoot -Directory -Attributes !ReparsePoint -ErrorAction SilentlyContinue)) {
        $md = Join-Path $d.FullName 'SKILL.md'
        if (-not (Test-Path -LiteralPath $md)) { continue }
        $meta = Read-Meta $md
        Add-Row 'plugin-skill' ('/' + $e.plugin + ':' + $d.Name) $meta.description $meta.hint $e.plugin $e.market $md
      }
    }
  }

$order = @{
  'user-command' = 0; 'user-skill' = 1;
  'plugin-command' = 2; 'plugin-skill' = 3
}
$sorted = @($rows | Sort-Object @{ Expression = { $order[$_.kind] } }, @{ Expression = { $_.invoke } })

$result = [pscustomobject]@{
  ok = $true
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  roots = [pscustomobject]@{
    home = $homeDir
    claude = $claudeDir
    plugins = $cacheRoot
  }
  counts = [pscustomobject]@{
    plugins = @($rows | Where-Object { $_.kind -like 'plugin-*' }).Count
    user = @($rows | Where-Object { $_.kind -like 'user-*' }).Count
  }
  items = $sorted
}
$result | ConvertTo-Json -Depth 6 -Compress
`;

export default function activate(ctx) {
  const { createElement: h, useEffect, useRef } = ctx.react;

  function errorText(e) {
    if (!e) return '未知错误';
    if (typeof e === 'string') return e;
    return e.message || String(e);
  }

  /** 给桥接调用加一层超时。宿主侧若一直挂着，界面不能永远停在「发送中…」。 */
  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label + ' timeout')), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** 宿主版本。老版本宿主可能没有这一项，取不到就留空，不能因此发不出反馈。 */
  function hostAppVersion() {
    try {
      return ctx && ctx.host && typeof ctx.host.appVersion === 'string' ? ctx.host.appVersion : '';
    } catch {
      return '';
    }
  }

  /**
   * 发一条反馈到中转。返回 describeFeedbackResult 的归一化结果。
   *
   * 不做连接层重试：反馈是 POST，重试会把同一条内容发两遍——
   * 用户看到「发送失败」再点一次，比静默重复更可控。
   */
  async function sendFeedback(text) {
    const payload = buildFeedbackPayload({
      text,
      pluginId: PLUGIN_ID,
      pluginVersion: ctx.version,
      hostVersion: hostAppVersion(),
    });
    try {
      const res = await withTimeout(
        ctx.bridge.invoke('plugin_http_request', {
          method: 'POST',
          url: FEEDBACK_ENDPOINT + '/feedback',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'ccgui-slash-palette/' + ctx.version,
          },
          body: JSON.stringify(payload),
        }),
        FEEDBACK_TIMEOUT_MS,
        'feedback',
      );
      return describeFeedbackResult({ status: Number(res && res.status) || 0, body: res && res.body });
    } catch (error) {
      return describeFeedbackResult({ error });
    }
  }

  /**
   * 查今天的剩余额度。失败时返回 `{offline: true}`——额度查不到不能挡住发反馈，
   * 但要让界面知道「是连不上」而不是「额度紧张」。
   */
  async function fetchQuota() {
    try {
      const res = await withTimeout(
        ctx.bridge.invoke('plugin_http_request', {
          method: 'GET',
          url: FEEDBACK_ENDPOINT + '/quota',
          headers: { 'User-Agent': 'ccgui-slash-palette/' + ctx.version },
          body: null,
        }),
        FEEDBACK_TIMEOUT_MS,
        'quota',
      );
      const status = Number(res && res.status) || 0;
      if (!(status >= 200 && status < 300)) return { offline: true };
      const body = res && typeof res.body === 'string' ? res.body : '';
      const data = body ? JSON.parse(body) : null;
      // 用 quotaCount 而不是 Number.isFinite(Number(...))：后者把 null/'' 读成 0。
      const remaining = data ? quotaCount(data.remaining) : null;
      return remaining === null ? null : { remaining, dailyLimit: Number(data.dailyLimit) || 30 };
    } catch {
      return { offline: true };
    }
  }

  // 三个 UI 入口不在同一棵 React 树里，共用一份模块内 store
  const store = {
    snap: {
      open: false,
      status: 'idle', // idle | scanning | ok | stale | error
      items: [],
      at: 0,
      roots: {},
      counts: {},
      error: '',
      settings: Object.assign({}, DEFAULT_SETTINGS),
      // storage 里的设置读回前为 false：此时开关禁用，避免用默认值覆盖已保存的选择
      settingsLoaded: false,
      toast: '',
      activeIndex: 0,
      query: '',
    },
    listeners: new Set(),
    set(patch) {
      store.snap = Object.assign({}, store.snap, patch);
      for (const fn of Array.from(store.listeners)) {
        try {
          fn();
        } catch {
          // 单个订阅者出错不影响其他入口
        }
      }
    },
    // 箭头函数：useSyncExternalStore 要求 subscribe 是稳定引用，不能依赖 this
    subscribe: (fn) => {
      store.listeners.add(fn);
      return () => {
        store.listeners.delete(fn);
      };
    },
    getSnapshot: () => store.snap,
  };

  // 宿主 React 提供 useSyncExternalStore（已上架插件同样使用），
  // 避免 useState 初值到 useEffect 订阅之间漏掉一次 store 更新。
  const useSnap = () => ctx.react.useSyncExternalStore(store.subscribe, store.getSnapshot);

  function normalizeItems(raw) {
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const out = [];
    const seen = new Set();
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const invoke = typeof it.invoke === 'string' ? it.invoke.trim() : '';
      if (!invoke || invoke.charAt(0) !== '/' || invoke.length < 2) continue;
      const key = invoke.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: typeof it.kind === 'string' ? it.kind : 'other',
        invoke,
        description: typeof it.description === 'string' ? it.description : '',
        hint: typeof it.hint === 'string' ? it.hint : '',
        plugin: typeof it.plugin === 'string' ? it.plugin : '',
        marketplace: typeof it.marketplace === 'string' ? it.marketplace : '',
        path: typeof it.path === 'string' ? it.path : '',
      });
    }
    return out;
  }

  function visibleItems(snap) {
    const s = snap.settings || DEFAULT_SETTINGS;
    const out = [];
    for (const it of snap.items) {
      if (it.kind.indexOf('plugin-') === 0 && !s.plugins) continue;
      if (it.kind.indexOf('user-') === 0 && !s.user) continue;
      out.push(it);
    }
    if (s.builtin) {
      for (const b of BUILTIN) out.push(b);
    }
    return out;
  }

  function filterItems(items, query) {
    const q = String(query || '')
      .trim()
      .toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.invoke.toLowerCase().indexOf(q) >= 0 ||
        String(it.description || '').toLowerCase().indexOf(q) >= 0,
    );
  }

  function orderItems(items) {
    // 未知来源排到最后，避免未来新增 kind 时顶到用户命令前面
    const rank = (kind) => {
      const i = GROUP_ORDER.indexOf(kind);
      return i < 0 ? GROUP_ORDER.length : i;
    };
    return items.slice().sort((a, b) => {
      const oa = rank(a.kind);
      const ob = rank(b.kind);
      if (oa !== ob) return oa - ob;
      return a.invoke.localeCompare(b.invoke);
    });
  }

  let inflight = null;

  async function runScan() {
    store.set({ status: 'scanning', error: '' });
    try {
      const encoded = toEncodedCommand(SCAN_SCRIPT);
      if (!encoded) throw new Error('无法编码 PowerShell 脚本');
      const r = await ctx.bridge.invoke('plugin_exec_run', {
        bin: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        timeoutMs: 30000,
      });
      // 宿主返回值存在数字码与字符串码两种形态
      const code = r ? r.code : undefined;
      if (code !== undefined && code !== null && code !== 0 && code !== '0') {
        throw new Error(String(r.stderr || '').trim() || 'powershell 退出码 ' + code);
      }
      const text = String((r && r.stdout) || '')
        .replace(/^﻿/, '')
        .trim();
      if (!text) throw new Error('扫描没有返回内容');
      const data = JSON.parse(text);
      const items = normalizeItems(data && data.items);
      const at = Date.now();
      const roots = data && data.roots && typeof data.roots === 'object' ? data.roots : {};
      const counts = data && data.counts && typeof data.counts === 'object' ? data.counts : {};
      store.set({ status: 'ok', items, at, roots, counts, error: '' });
      if (ctx.storage) {
        try {
          await ctx.storage.set(CACHE_KEY, { version: 1, at, items, roots, counts });
        } catch {
          // 缓存写失败不影响本次结果
        }
      }
    } catch (e) {
      const hadItems = store.snap.items.length > 0;
      store.set({ status: hadItems ? 'stale' : 'error', error: errorText(e) });
    }
  }

  function scan() {
    if (inflight) return inflight;
    inflight = runScan().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function insert(invoke) {
    try {
      ctx.composer.setDraft(invoke + ' ');
      store.set({ open: false, query: '', activeIndex: 0, toast: '' });
    } catch (e) {
      store.set({
        open: false,
        query: '',
        activeIndex: 0,
        toast: '写入失败',
        error: '写入输入框失败：' + errorText(e),
      });
      setTimeout(() => {
        if (store.snap.toast === '写入失败') store.set({ toast: '' });
      }, 3000);
    }
  }

  function openPalette() {
    store.set({ open: true, query: '', activeIndex: 0 });
    if (!store.snap.items.length && store.snap.status !== 'scanning') void scan();
  }

  async function readSettings() {
    if (!ctx.storage) return Object.assign({}, DEFAULT_SETTINGS);
    try {
      const s = await ctx.storage.get(SETTINGS_KEY);
      if (!s || typeof s !== 'object') return Object.assign({}, DEFAULT_SETTINGS);
      return {
        plugins: s.plugins !== false,
        user: s.user !== false,
        builtin: s.builtin === true,
        showDesc: s.showDesc !== false,
      };
    } catch {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  async function writeSettings(next) {
    store.set({ settings: next });
    if (!ctx.storage) return;
    try {
      await ctx.storage.set(SETTINGS_KEY, next);
    } catch {
      // 设置写失败只在本次会话生效
    }
  }

  // 启动：先恢复设置与缓存，缓存过期或缺失才重扫
  void (async () => {
    const settings = await readSettings();
    store.set({ settings, settingsLoaded: true });
    let saved = null;
    if (ctx.storage) {
      try {
        saved = await ctx.storage.get(CACHE_KEY);
      } catch {
        saved = null;
      }
    }
    // 空结果不当作有效缓存：否则 ~/.claude 尚未生成时，10 分钟内新装的命令都看不到
    if (saved && saved.version === 1 && Array.isArray(saved.items) && saved.items.length) {
      store.set({
        status: 'ok',
        items: normalizeItems(saved.items),
        at: Number(saved.at) || 0,
        roots: saved.roots && typeof saved.roots === 'object' ? saved.roots : {},
        counts: saved.counts && typeof saved.counts === 'object' ? saved.counts : {},
      });
      if (Date.now() - (Number(saved.at) || 0) < CACHE_TTL) return;
    }
    await scan();
  })();

  function fmtTime(ts) {
    if (!ts) return '尚未扫描';
    const d = new Date(ts);
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    return (
      d.getFullYear() +
      '-' +
      pad(d.getMonth() + 1) +
      '-' +
      pad(d.getDate()) +
      ' ' +
      pad(d.getHours()) +
      ':' +
      pad(d.getMinutes())
    );
  }

  function Icon(props) {
    return h(
      'span',
      {
        className: props && props.className,
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 },
      },
      '/',
    );
  }

  function StatusChip() {
    const snap = useSnap();
    const count = visibleItems(snap).length;
    const busy = snap.status === 'scanning';
    return h(
      'span',
      { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
      inlineCss ? h('style', { key: 'sp-style' }, UI_CSS) : null,
      h(
        'button',
        {
          type: 'button',
          className: 'sp-chip' + (snap.open ? ' sp-chip-open' : ''),
          title: '打开 Claude 斜杠命令',
          'aria-label': '打开 Claude 斜杠命令',
          onClick: () => (snap.open ? store.set({ open: false }) : openPalette()),
        },
        busy ? h('span', { className: 'sp-spinner' }) : h('span', { className: 'sp-slash' }, '/'),
        h('span', null, '命令'),
        count ? h('span', { className: 'sp-count' }, String(count)) : null,
      ),
      snap.toast
        ? h(
            'span',
            {
              className: 'sp-toast' + (snap.toast === '写入失败' ? ' sp-toast-error' : ''),
              title: snap.error || snap.toast,
            },
            snap.toast,
          )
        : null,
    );
  }

  function Overlay() {
    const snap = useSnap();
    const listRef = useRef(null);
    const open = snap.open;
    const all = open ? visibleItems(snap) : [];
    const filtered = open ? filterItems(all, snap.query) : [];
    const ordered = open ? orderItems(filtered) : [];
    const active = Math.min(snap.activeIndex, Math.max(0, ordered.length - 1));

    useEffect(() => {
      if (!open) return undefined;
      const box = listRef.current;
      if (!box || !box.querySelector) return undefined;
      const el = box.querySelector('[data-idx="' + active + '"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      return undefined;
    }, [open, active, snap.query, ordered.length]);

    // 面板打开期间锁住宿主页面滚动，关闭或卸载时恢复原值
    useEffect(() => {
      if (!open) return undefined;
      const body = typeof document !== 'undefined' && document.body ? document.body : null;
      const prev = body ? body.style.overflow : '';
      if (body) body.style.overflow = 'hidden';
      return () => {
        if (body) body.style.overflow = prev;
      };
    }, [open]);

    if (!open) return null;

    function onKeyDown(e) {
      // Esc 挂在面板容器上：焦点落在关闭按钮或列表项时同样生效
      if (e.key === 'Escape') {
        e.preventDefault();
        store.set({ open: false });
        return;
      }
      // 焦点在按钮上时把 Enter 留给按钮自身的 click，避免一次按键触发两次插入
      const onControl = e.target && e.target.tagName && e.target.tagName !== 'INPUT';
      if (onControl && (e.key === 'Enter' || e.key === ' ')) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (ordered.length) store.set({ activeIndex: Math.min(active + 1, ordered.length - 1) });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        store.set({ activeIndex: Math.max(active - 1, 0) });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (ordered[active]) insert(ordered[active].invoke);
      }
    }

    const rows = [];
    let lastKind = '';
    ordered.forEach((it, idx) => {
      if (it.kind !== lastKind) {
        lastKind = it.kind;
        rows.push(h('div', { key: 'g-' + it.kind, className: 'sp-group' }, GROUP_LABEL[it.kind] || '其他'));
      }
      rows.push(
        h(
          'button',
          {
            key: 'i-' + it.kind + '-' + it.invoke,
            type: 'button',
            'data-idx': String(idx),
            className: 'sp-item' + (idx === active ? ' sp-item-active' : ''),
            onMouseEnter: () => {
              if (store.snap.activeIndex !== idx) store.set({ activeIndex: idx });
            },
            onClick: () => insert(it.invoke),
            // 不把本机绝对路径暴露在悬停提示里（含用户名）
            title: it.description ? it.invoke + ' — ' + it.description : it.invoke,
          },
          h('span', { className: 'sp-invoke' }, it.invoke),
          snap.settings.showDesc && it.description
            ? h('span', { className: 'sp-desc' }, it.description)
            : h('span', { className: 'sp-desc' }),
          it.hint ? h('span', { className: 'sp-hint' }, it.hint) : null,
        ),
      );
    });

    let statusLine = null;
    if (snap.status === 'scanning') {
      statusLine = h(
        'div',
        { className: 'sp-status' },
        h('span', { className: 'sp-spinner' }),
        '正在扫描本机命令…',
      );
    } else if (snap.status === 'error') {
      statusLine = h(
        'div',
        { className: 'sp-status sp-status-error' },
        '扫描失败：' + snap.error,
        h('button', { className: 'sp-retry', onClick: () => void scan() }, '重试'),
      );
    } else if (snap.status === 'stale') {
      statusLine = h(
        'div',
        { className: 'sp-status sp-status-warn' },
        '正在使用缓存结果：' + snap.error,
        h('button', { className: 'sp-retry', onClick: () => void scan() }, '重试'),
      );
    } else if (snap.at) {
      statusLine = h('div', { className: 'sp-status' }, '共 ' + all.length + ' 条 · 更新于 ' + fmtTime(snap.at));
    }

    return h(
      'div',
      {
        className: 'sp-mask',
        onClick: (e) => {
          if (e.target === e.currentTarget) store.set({ open: false });
        },
      },
      h(
        'div',
        {
          className: 'sp-panel',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': 'Claude 斜杠命令',
          onKeyDown,
        },
        inlineCss ? h('style', { key: 'sp-style' }, UI_CSS) : null,
        h(
          'div',
          { className: 'sp-head' },
          h('span', { className: 'sp-logo' }, '/'),
          h('input', {
            className: 'sp-search',
            autoFocus: true,
            placeholder: '搜索命令或描述…',
            value: snap.query,
            onChange: (e) => store.set({ query: e.target.value, activeIndex: 0 }),
          }),
          h('button', { className: 'sp-close', title: '关闭', onClick: () => store.set({ open: false }) }, '×'),
        ),
        statusLine,
        h(
          'div',
          { className: 'sp-list', ref: listRef },
          ordered.length
            ? rows
            : h('div', { className: 'sp-empty' }, snap.query ? '没有匹配的命令' : '没有扫描到命令'),
        ),
        h(
          'div',
          { className: 'sp-foot' },
          h('span', null, '↑↓ 选择 · Enter 写入 · Esc 关闭'),
          h('span', { className: 'sp-foot-warn' }, '写入会替换输入框现有内容'),
        ),
      ),
    );
  }

  function FeedbackSection() {
    // 这个插件的 React 解构里没有 useState/useRef（其余组件只靠 store），
    // 反馈区是局部状态，直接从 ctx.react 取，别去改顶层的解构。
    const R = ctx.react;
    const textState = R.useState('');
    const text = textState[0];
    const setText = textState[1];
    // '' -> 'sending' -> 'sent'/'error'
    const sendState = R.useState('');
    const sendStatus = sendState[0];
    const setSendStatus = sendState[1];
    const resultState = R.useState(null);
    const result = resultState[0];
    const setResult = resultState[1];
    const quotaState = R.useState(null);
    const quota = quotaState[0];
    const setQuota = quotaState[1];
    const quotaTried = R.useRef(false);
    // 同步的在途标志。canSend 是渲染时的闭包值，同一 tick 内两次触发都会
    // 读到旧的 sendStatus=''，只在状态里防不住双击。
    const sendingRef = R.useRef(false);

    // 只在第一次打开设置页时查额度。查不到就保持 {offline:true}，UI 说明是
    // 「连不上」而不是「额度紧张」。
    async function loadQuota() {
      const q = await fetchQuota();
      setQuota(q);
      return q;
    }

    R.useEffect(() => {
      if (quotaTried.current) return;
      quotaTried.current = true;
      void loadQuota();
      // 只在挂载时查一次；之后由「重试」按钮或发送结果更新。
    }, []);

    const trimmed = normaliseFeedbackText(text);
    const canSend = trimmed.length > 0 && sendStatus !== 'sending';

    const issueUrl = buildIssueUrl({
      repo: FEEDBACK_REPO,
      pluginName: FEEDBACK_PLUGIN_NAME,
      text: trimmed,
      pluginVersion: ctx.version,
      hostVersion: hostAppVersion(),
    });

    async function submit() {
      // sendingRef 是同步的：同一 tick 内两次触发都会读到 true，挡住双击。
      if (!canSend || sendingRef.current) return;
      sendingRef.current = true;
      const submitted = trimmed;
      setSendStatus('sending');
      setResult(null);

      let r;
      try {
        r = await sendFeedback(submitted);
      } finally {
        sendingRef.current = false;
      }

      setSendStatus(r.ok ? 'sent' : 'error');
      setResult(r);
      if (!r.ok) return;

      // 只清掉「这次发出去的那段」。发送期间用户可能又敲了内容，
      // 直接清空会把他新写的也抹掉。
      setText((cur) => (cur === submitted ? '' : cur));

      // 额度优先用服务端回传的真实值。查额度时失败了也不要紧——成功响应里
      // 带了 remaining，正好顺手把「暂时连不上」纠正过来。
      // 没有回传额度就按旧值自减一条，别把它读成 0 条。
      setQuota((prev) => nextQuota(prev, r.remaining));
    }

    const quotaText = describeQuota(quota);
    const statusText = sendStatus === 'sending' ? '发送中…' : result ? result.message : '';
    // 成功时正文被清空，按钮会变成不可点的死按钮。若文案还停在「发送反馈」，
    // 用户看到的就是「点了没反应」——回执必须落在按钮自己身上。
    const sendLabel = sendStatus === 'sending' ? '发送中…' : sendStatus === 'sent' ? '已发送' : '发送反馈';

    return h(
      'div',
      { className: 'sp-feedback' },
      h('div', { className: 'sp-setting-title' }, '反馈'),
      h(
        'div',
        { className: 'sp-setting-desc' },
        '遇到问题或想提建议，两种方式任选其一。发送的内容只有这段文字、插件版本与 CC GUI 版本，不含会话、代码或本机路径。',
      ),
      h('textarea', {
        className: 'sp-feedback-text',
        value: text,
        rows: 4,
        maxLength: TEXT_LIMIT,
        placeholder: '描述问题或建议…（最多 ' + TEXT_LIMIT + ' 字）',
        spellCheck: false,
        'aria-label': '反馈正文',
        onChange: (e) => {
          setText(e.target.value);
          // 重新输入等于开了一条新反馈：上一条的回执都该撤掉。
          if (sendStatus !== 'sending') {
            setSendStatus('');
            setResult(null);
          }
        },
      }),
      h(
        'div',
        { className: 'sp-feedback-row' },
        h('span', { className: 'sp-setting-desc sp-feedback-count' }, text.length + ' / ' + TEXT_LIMIT),
        h(
          'span',
          { className: 'sp-setting-desc sp-feedback-quota' },
          quotaText.message,
          // 额度查不到 / 用完了都给一条重试路径，否则用户只能重开设置页。
          quotaText.canRetry
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'sp-link-btn sp-feedback-quota-retry',
                  disabled: sendStatus === 'sending',
                  onClick: () => void loadQuota(),
                },
                '重试',
              )
            : null,
        ),
      ),
      h(
        'div',
        { className: 'sp-feedback-actions' },
        h(
          'a',
          {
            className: 'sp-feedback-issue',
            href: issueUrl,
            target: '_blank',
            rel: 'noreferrer noopener',
            title: '在浏览器里打开预填好的 Issue 页面',
          },
          '通过 GitHub 提 Issue',
        ),
        h(
          'button',
          {
            type: 'button',
            className:
              'sp-btn sp-btn-primary sp-feedback-send' + (sendStatus === 'sent' ? ' sp-feedback-sent' : ''),
            disabled: !canSend,
            onClick: () => void submit(),
          },
          sendLabel,
        ),
      ),
      statusText
        ? h(
            'div',
            {
              className:
                'sp-feedback-status' +
                (sendStatus === 'sent' ? ' is-ok' : '') +
                (sendStatus === 'error' ? ' is-bad' : ''),
              role: 'status',
              'aria-live': 'polite',
            },
            statusText,
          )
        : null,
    );
  }

  function SettingsSection() {
    const snap = useSnap();
    const s = snap.settings;
    const toggle = (key) => {
      // 设置还没从 storage 读回时忽略点击：否则会用默认值覆盖已保存的选择
      if (!store.snap.settingsLoaded) return;
      // 读实时快照而不是本次渲染的闭包值：连续点两个开关时不会互相覆盖
      const cur = store.snap.settings;
      void writeSettings(Object.assign({}, cur, { [key]: !cur[key] }));
    };

    function row(key, title, desc) {
      return h(
        'label',
        { className: 'sp-setting', key },
        h('input', {
          type: 'checkbox',
          checked: !!s[key],
          disabled: !snap.settingsLoaded,
          onChange: () => toggle(key),
        }),
        h(
          'span',
          null,
          h('div', { className: 'sp-setting-title' }, title),
          h('div', { className: 'sp-setting-desc' }, desc),
        ),
      );
    }

    const roots = snap.roots || {};
    const counts = snap.counts || {};
    // 诊断区把 home 前缀缩成 ~，避免把用户名暴露在截图里
    const shortPath = (p) => {
      if (!p) return '未解析';
      const home = roots.home ? String(roots.home) : '';
      const text = String(p);
      return home && text.indexOf(home) === 0 ? '~' + text.slice(home.length) : text;
    };

    return h(
      'div',
      { className: 'sp-settings' },
      inlineCss ? h('style', { key: 'sp-style' }, UI_CSS) : null,
      h(
        'div',
        { className: 'sp-setting-desc' },
        '仅扫描 Claude Code 的命令目录。在输入框状态行的「/ 命令」按钮里搜索并插入命令；插件只能写入草稿，不能读取输入框内容，也不会自动发送。',
      ),
      row('plugins', '插件命令与技能', '读取 ~/.claude/plugins/cache 下的 commands/*.md 与 skills/*/SKILL.md。'),
      row('user', '用户命令与技能', '读取 ~/.claude/commands/*.md 与 ~/.claude/skills/*/SKILL.md。'),
      row('builtin', '内置命令', '补充 /help、/clear、/compact 等常见命令，可能与宿主自带列表重复。'),
      row('showDesc', '显示命令描述', '在列表里显示每个命令 frontmatter 里的 description。'),
      h(
        'div',
        { className: 'sp-actions' },
        h('button', { className: 'sp-btn', onClick: () => void scan() }, snap.status === 'scanning' ? '扫描中…' : '立即刷新'),
        h('span', { className: 'sp-setting-desc' }, '上次扫描：' + fmtTime(snap.at)),
      ),
      snap.error ? h('div', { className: 'sp-status sp-status-error' }, '上次错误：' + snap.error) : null,
      h(
        'div',
        { className: 'sp-diag' },
        '插件命令 ' + (counts.plugins || 0) + ' · 用户 ' + (counts.user || 0) + '\n' +
          'CLI 目录：' + shortPath(roots.claude) + '\n' +
          '插件缓存：' + shortPath(roots.plugins),
      ),
      h(FeedbackSection, null),
    );
  }

  // 样式优先由宿主主题注入一次（其它已上架插件同样做法）；
  // 老宿主没有 ctx.theme 时回退到各组件内联 <style>。
  let inlineCss = !(ctx.theme && typeof ctx.theme.injectCss === 'function');
  const disposers = [];
  if (!inlineCss) {
    try {
      const disposeCss = ctx.theme.injectCss(UI_CSS);
      if (typeof disposeCss === 'function') disposers.push(disposeCss);
    } catch {
      inlineCss = true;
    }
  }
  disposers.push(ctx.ui.registerComposerStatusItem({ key: PLUGIN_ID, component: StatusChip, order: 10 }));
  disposers.push(ctx.ui.registerOverlay({ key: PLUGIN_ID + '-overlay', component: Overlay, order: 10 }));
  disposers.push(
    ctx.ui.registerSettingsSection({
      key: PLUGIN_ID,
      label: () => 'Claude 斜杠命令',
      icon: Icon,
      component: SettingsSection,
    }),
  );
  disposers.push(
    ctx.ui.registerCommand({
      key: PLUGIN_ID,
      title: () => 'Claude 斜杠命令',
      keywords: () => ['claude', 'claude-code', 'slash', 'command', '命令', '斜杠', 'prompt'],
      run: openPalette,
    }),
  );

  return () => {
    for (const d of disposers) {
      try {
        if (typeof d === 'function') d();
      } catch {
        // 卸载单个入口失败不影响其余清理
      }
    }
  };
}
