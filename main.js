// Claude 斜杠命令：仅扫描本机 Claude Code 的命令源，搜索并写入输入框草稿。
// 单文件 ESM：不能有 import、JSX、eval / new Function。
// 写入只能经 ctx.composer.setDraft；插件无法读取输入框内容或监听按键。

const PLUGIN_ID = 'slash-palette';
const CACHE_KEY = 'slash-palette-cache-v1';
const SETTINGS_KEY = 'slash-palette-settings-v1';
// 同时用于两处：启动时是否信任磁盘缓存，以及点开面板时是否重扫。
// 一次扫描只是读几十个 .md，耗时通常在 1 秒内，5 分钟足够及时。
const CACHE_TTL = 5 * 60 * 1000;
// 反馈中转。改主机名要同步 manifest.json 的 network:<host>（精确匹配，不支持通配）。
const FEEDBACK_ENDPOINT = 'https://ccgui-feedback.2653990378.workers.dev';
const FEEDBACK_REPO = 'renhao-wan/ccgui-plugin-slash-palette';
const FEEDBACK_PLUGIN_NAME = 'Claude 斜杠命令';
const FEEDBACK_TIMEOUT_MS = 15000;

const DEFAULT_SETTINGS = {
  plugins: true,
  user: true,
  project: true,
  builtin: false,
  showDesc: true,
};

const GROUP_LABEL = {
  'project-command': '项目命令',
  'project-skill': '项目技能',
  'user-command': '用户命令',
  'user-skill': '用户技能',
  'plugin-command': '插件命令',
  'plugin-skill': '插件技能',
  builtin: '内置命令',
};

const GROUP_ORDER = [
  'project-command',
  'project-skill',
  'user-command',
  'user-skill',
  'plugin-command',
  'plugin-skill',
  'builtin',
];

// ---- 以下由 ccgui-plugin-shared 内联生成 ----
// ---- ccgui-plugin-shared/feedback.mjs ----
/**
 * 反馈渠道的纯函数层：正文归一化、Issue 链接拼装、请求体收敛、响应文案。
 *
 * 全部离线可测。网络与 UI 在 main.head.js 里，这一层只回答「发什么」和
 * 「回什么」，方便把隐私边界钉死在测试里：请求体只允许五个字段。
 */

/** 正文上限。再长就不是一条反馈，而是一篇文档了。 */
const TEXT_LIMIT = 1000;

/**
 * 收敛用户输入：去控制字符、统一换行、折叠连续空行与行尾空白、限长。
 * 保留大小写、中文、emoji 与**换行**——用户最常贴的就是报错日志，
 * 压成一行后堆栈就没法看了。
 *
 * @param {unknown} raw
 * @returns {string}
 */
function normaliseFeedbackText(raw) {
  return String(raw === undefined || raw === null ? "" : raw)
    // 先统一换行，再剥控制字符（保留 \n）。制表符换成空格——堆栈缩进有用。
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f�]/g, "")
    // 只去行尾空白与整段的首尾空白。**正文内行首缩进要留着**：
    // 报错堆栈靠它对齐，去掉后 `at fetchTrending` 就和日志正文混在一起了。
    .replace(/[ \t]+$/gm, "")
    .replace(/^[ \t]+/, "")
    // 三个以上连续换行压成两个（一段空行），既保留分段又不留大片空白。
    .replace(/\n{3,}/g, "\n\n")
    // 首尾空行去掉。
    .replace(/^\n+|\n+$/g, "")
    .slice(0, TEXT_LIMIT)
    .replace(/[ \t\n]+$/, "");
}

/**
 * GitHub 新建 Issue 的预填链接。
 *
 * 用预填而不是直接调 API：API 要 PAT，PAT 写进插件源码等于公开。预填链接
 * 只依赖用户浏览器里已有的登录态，插件一行网络代码都不用写。
 *
 * @param {{repo: string, pluginName: string, text: string, pluginVersion: string, hostVersion: string}} o
 * @returns {string}
 */
function buildIssueUrl(o) {
  const text = normaliseFeedbackText(o.text);
  const body = [
    text || "_（请在这里描述问题或建议）_",
    "",
    "---",
    "插件：" + String(o.pluginName || "") + " " + String(o.pluginVersion || ""),
    "CC GUI：" + String(o.hostVersion || ""),
  ].join("\n");
  const q = new URLSearchParams({
    title: "[反馈] " + String(o.pluginName || ""),
    body,
  });
  return "https://github.com/" + String(o.repo || "") + "/issues/new?" + q.toString();
}

/** 请求体允许的字段。白名单而非黑名单：漏传字段比误传路径好。 */
const PAYLOAD_FIELDS = ["text", "pluginId", "pluginVersion", "hostVersion", "ts"];

/**
 * 组装发往中转的请求体，只保留白名单字段。
 *
 * @param {object} o
 * @returns {{text: string, pluginId: string, pluginVersion: string, hostVersion: string, ts: number}}
 */
function buildFeedbackPayload(o) {
  const src = {
    text: normaliseFeedbackText(o.text),
    pluginId: String(o.pluginId || ""),
    pluginVersion: String(o.pluginVersion || ""),
    hostVersion: String(o.hostVersion || ""),
    ts: Number(o.now) || Date.now(),
  };
  const out = {};
  for (const k of PAYLOAD_FIELDS) out[k] = src[k];
  return out;
}

function parseJson(body) {
  if (typeof body !== "string" || !body) return null;
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/**
 * 把服务端给的额度字段收敛成 `number | null`。
 *
 * **别用 `Number.isFinite(Number(v))`**：`Number(null)` 与 `Number("")` 都是 0，
 * 于是「中转没带这个字段」会被读成「今天 0 条额度」，界面就对刚发送成功的
 * 用户说「今天的额度已用完」。这里只认真正的数字与非空数字字符串。
 *
 * @param {unknown} v
 * @returns {number|null}
 */
function quotaCount(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    if (!v.trim()) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 发送成功后更新界面上的剩余额度。
 *
 * 服务端回传的额度优先（顺手纠正「暂时连不上」）；没给就按本地旧值自减
 * 一条，旧值也没有就原样保留。纯函数，单测钉住「别把 null 读成 0」。
 *
 * @param {{remaining?: number, dailyLimit?: number, offline?: boolean}|null} prev
 * @param {unknown} fromServer 服务端回传的 remaining
 * @returns {object|null}
 */
function nextQuota(prev, fromServer) {
  const n = quotaCount(fromServer);
  const fallback = normalizeFallback(prev);
  if (n !== null) {
    return { remaining: n, dailyLimit: (prev && prev.dailyLimit) || 1, fallbackRemaining: fallback };
  }
  const prevRemaining = prev && typeof prev.remaining === "number" ? prev.remaining : null;
  if (prevRemaining === null) return prev;
  return {
    remaining: Math.max(0, prevRemaining - 1),
    dailyLimit: prev.dailyLimit || 1,
    fallbackRemaining: fallback,
  };
}

/** 兜底额度字段的收敛：不是数字就当未知（null），避免 NaN 漏到界面。 */
function normalizeFallback(prev) {
  const v = quotaCount(prev && prev.fallbackRemaining);
  return v === null ? null : Math.max(0, v);
}

/**
 * 把一次中转响应翻译成界面文案。
 *
 * 一条原则：**永远给出「你还能做什么」**。反馈发不出去不是用户的错，
 * 所以每条失败文案都要么说清原因，要么指向还能走的路（GitHub Issue）。
 * 泛泛一句「发送失败」等于让用户卡死在这里。
 *
 * @param {{status?: number, body?: string, error?: Error}} r
 * @returns {{ok: boolean, kind: string, message: string, remaining: number|null}}
 */
function describeFeedbackResult(r) {
  if (r && r.error) {
    const raw = String(r.error.message || r.error);
    if (/timed?\s*out|timeout|ETIMEDOUT/i.test(raw)) {
      return {
        ok: false,
        kind: "timeout",
        message: "发送超时。中转可能被网络挡住，可改用 GitHub Issue 反馈",
        remaining: null,
      };
    }
    if (/network:|permission|授权/i.test(raw)) {
      return { ok: false, kind: "denied", message: "网络权限未生效，请重新安装插件", remaining: null };
    }
    // DNS 污染、代理没开、防火墙——国内最常见的三种，用户能分不清，
    // 但「检查网络或代理」这句对他们是有用的动作。
    return {
      ok: false,
      kind: "network",
      message: "连不上反馈服务，请检查网络或代理，也可改用 GitHub Issue 反馈",
      remaining: null,
    };
  }

  const status = Number(r && r.status) || 0;
  const data = parseJson(r && r.body);
  const remaining = data ? quotaCount(data.remaining) : null;
  const code = data && typeof data.error === "string" ? data.error : "";

  if (status >= 200 && status < 300) {
    // 成功响应必须带 ok:true。只看状态码会把运营商劫持页、登录门户、
    // 代理错误页（都会返回 200）当成「已发送」——用户以为发出去了，
    // 实际什么都没有。
    if (!data || data.ok !== true) {
      return {
        ok: false,
        kind: "garbled",
        message: "反馈服务返回了无法识别的内容，可能被网络拦截，可改用 GitHub Issue 反馈",
        remaining: null,
      };
    }
    return { ok: true, kind: "sent", message: "反馈已发送，谢谢", remaining };
  }

  if (status === 429) {
    // kind 由 Worker 给出：
    //   burst    = 兜底池的 10 分钟窗口撞了（本插件仍在 48h 冷却里）
    //   cooldown = 本插件 48h 冷却中，且兜底池也空了
    // 分不清按 cooldown 说——让人等十分钟比让人白等一天更糟。
    const burst = data && data.kind === "burst";
    return {
      ok: false,
      kind: "rate_limited",
      message: burst
        ? "发得太快了，稍等几分钟再试，或改用 GitHub Issue 反馈"
        : "这个插件每 48 小时只能提交 1 条反馈，可稍后再来，或改用 GitHub Issue 反馈",
      // burst 时兜底池其实还有剩；剩余额度由服务端回传，没给才写 0。
      remaining: burst ? remaining : 0,
    };
  }

  if (status === 413) {
    return { ok: false, kind: "invalid", message: "反馈内容太长了，请缩短后重试", remaining };
  }

  if (status === 400) {
    // 400 的几种原因要分开说：empty_text 是用户没写，unknown_plugin 是
    // 版本错位，叫用户去「缩短内容」是把他引到错的方向。
    if (code === "unknown_plugin") {
      return {
        ok: false,
        kind: "invalid",
        message: "中转不认识这个插件版本，请更新插件，或改用 GitHub Issue 反馈",
        remaining,
      };
    }
    if (code === "empty_text") {
      return { ok: false, kind: "invalid", message: "反馈内容是空的，写点内容再发", remaining };
    }
    return { ok: false, kind: "invalid", message: "反馈内容不合要求，请缩短后重试", remaining };
  }

  if (status === 502 || status === 503 || status === 500) {
    return {
      ok: false,
      kind: "http",
      // 502 = 发不出邮件、503 = KV 不可用、500 = 中转内部错误。
      // 三种都是中转那边的事，用户唯一能做的是稍后再试或换 Issue。
      message: "中转暂时不可用，稍后再试，或改用 GitHub Issue 反馈",
      remaining,
    };
  }

  if (status === 0) {
    // 请求根本没拿到响应：和网络错误一样处理，别把 "HTTP 0" 甩给用户。
    return {
      ok: false,
      kind: "network",
      message: "连不上反馈服务，请检查网络或代理，也可改用 GitHub Issue 反馈",
      remaining: null,
    };
  }

  return {
    ok: false,
    kind: "http",
    message: "发送失败（HTTP " + status + "），可改用 GitHub Issue 反馈",
    remaining,
  };
}

/**
 * 额度提示文案。查不到额度时也要给一句话，不能空着。
 *
 * 额度口径是「本插件每 48 小时 1 条 + 每 IP 每天共享兜底 3 条」，所以
 * 要区分三种状态：
 *   - `{offline: true}`：请求失败（网络/代理/中转挂了）。说「额度有限」
 *     会把网络故障说成用户在刷屏，把他引到错误的方向。
 *   - remaining=1：本插件现在能发。
 *   - remaining=0：本插件在 48 小时冷却里；若 fallbackRemaining>0，仍可
 *     借共享兜底发出去，文案要说清，别让用户以为彻底没戏。
 *
 * @param {{remaining?: number, dailyLimit?: number, fallbackRemaining?: number, offline?: boolean}|null} quota
 * @returns {{remaining: number|null, message: string, canRetry?: boolean}}
 */
function describeQuota(quota) {
  if (quota && quota.offline) {
    return { remaining: null, message: "暂时连不上反馈服务，发送时再试", canRetry: true };
  }
  // Number(null) === 0、Number("") === 0：不显式挡掉，脏数据会被读成「0 条」，
  // 界面就说「今天的额度已用完」。先用「是不是数字」把它挡在这一层。
  const raw = quota ? quota.remaining : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { remaining: null, message: "额度有限，请勿刷屏", canRetry: true };
  }
  const remaining = Math.max(0, raw);
  const fallback = quotaCount(quota ? quota.fallbackRemaining : undefined);
  if (remaining > 0) {
    return { remaining, message: "每个插件每两天可提交 1 条反馈", canRetry: false };
  }
  if (fallback !== null && fallback > 0) {
    return {
      remaining: 0,
      message: "本插件额度已用，仍可借共享额度再发 " + fallback + " 条",
      canRetry: false,
    };
  }
  return { remaining: 0, message: "本插件的反馈额度已用完，48 小时后再来", canRetry: true };
}

// ---- ccgui-plugin-shared/feedback-net.mjs ----
/**
 * 反馈渠道的网络层：`send` 发一条反馈，`quota` 查今天还剩几条。
 *
 * 用工厂而不是两个裸函数，是为了让「插件身份」只能从一处来：`pluginId`
 * 同时决定请求体里的 pluginId 和 User-Agent 前缀，不可能出现「体里是 A、
 * UA 里是 B」的错位。宿主版本也只在这里读一次。
 *
 * 这一层只做「发什么、怎么发、回什么」的搬运；文案全部交给
 * describeFeedbackResult / describeQuota，隐私边界由 buildFeedbackPayload
 * 的白名单钉住。
 */

/**
 * 给 promise 加超时。超时抛 `Error("<label> timeout")`，
 * describeFeedbackResult 靠这个字符串识别超时。
 *
 * 名字带 `fbNet` 前缀：库文件会和 main.head.js 拼进同一作用域，
 * 那边已经有一个给工作区登记与解读用的顶层 withTimeout，重名不是覆盖
 * 而是整个模块语法错误（build.mjs 的顶层重名自检会直接拦住）。
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function fbNetTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + " timeout")), ms);
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

/**
 * 宿主版本。老版本宿主可能没有这一项，取不到就留空——不能因此发不出反馈。
 *
 * @param {object} ctx
 * @returns {string}
 */
function fbNetHostVersion(ctx) {
  try {
    return ctx && ctx.host && typeof ctx.host.appVersion === "string" ? ctx.host.appVersion : "";
  } catch {
    return "";
  }
}

/**
 * 建一整套反馈网络调用。
 *
 * @param {object} ctx 插件上下文（要用 ctx.bridge / ctx.version / ctx.host）
 * @param {{endpoint: string, pluginId: string, timeoutMs?: number}} opts
 *   endpoint 必须与 manifest 的 `network:<host>` 一致，否则宿主会拒。
 * @returns {{send: (text: string) => Promise<object>, quota: () => Promise<object|null>}}
 */
function createFeedbackNet(ctx, opts) {
  const endpoint = String(opts.endpoint || "").replace(/\/+$/, "");
  const pluginId = String(opts.pluginId || "");
  const timeoutMs = Number(opts.timeoutMs) || 15000;
  const userAgent = () => "ccgui-" + pluginId + "/" + ctx.version;

  /**
   * 发一条反馈。返回值就是 describeFeedbackResult 的结果，界面直接渲染。
   *
   * 不做连接层重试：反馈是 POST，重试会把同一条内容发两遍——用户看到
   * 「发送失败」再点一次，比静默重复更可控。
   *
   * @param {string} text
   * @returns {Promise<object>}
   */
  async function send(text) {
    const payload = buildFeedbackPayload({
      text,
      pluginId,
      pluginVersion: ctx.version,
      hostVersion: fbNetHostVersion(ctx),
    });
    try {
      const res = await fbNetTimeout(
        ctx.bridge.invoke("plugin_http_request", {
          method: "POST",
          url: endpoint + "/feedback",
          headers: { "Content-Type": "application/json", "User-Agent": userAgent() },
          body: JSON.stringify(payload),
        }),
        timeoutMs,
        "feedback",
      );
      return describeFeedbackResult({ status: Number(res && res.status) || 0, body: res && res.body });
    } catch (error) {
      return describeFeedbackResult({ error });
    }
  }

  /**
   * 查本插件当前的额度。失败时返回 `{offline: true}`——额度查不到不能挡住
   * 发反馈，但要让界面知道「是连不上」而不是「额度紧张」，两句话说给用户
   * 听的意思完全不同。
   *
   * 必须带 `?pluginId=`：冷却按插件区分，不带的话服务端只能回乐观值。
   *
   * @returns {Promise<{remaining: number, dailyLimit: number, fallbackRemaining?: number}|{offline: true}|null>}
   */
  async function quota() {
    try {
      const res = await fbNetTimeout(
        ctx.bridge.invoke("plugin_http_request", {
          method: "GET",
          url: endpoint + "/quota?pluginId=" + encodeURIComponent(pluginId),
          headers: { "User-Agent": userAgent() },
          body: null,
        }),
        timeoutMs,
        "quota",
      );
      const status = Number(res && res.status) || 0;
      if (!(status >= 200 && status < 300)) return { offline: true };
      const body = res && typeof res.body === "string" ? res.body : "";
      // 劫持页、登录门户都返回 200 + HTML：JSON.parse 会抛，被外层 catch 接住，
      // 与「请求失败」同样按连不上处理——不需要单独再判一次。
      const data = body ? JSON.parse(body) : null;
      // 用 quotaCount 而不是 Number.isFinite(Number(...))：后者把 null/"" 读成 0，
      // 界面会说「额度已用完」。
      const remaining = data ? quotaCount(data.remaining) : null;
      if (remaining === null) return null;
      const fallback = data ? quotaCount(data.fallbackRemaining) : null;
      const out = { remaining, dailyLimit: Number(data.dailyLimit) || 1 };
      if (fallback !== null) out.fallbackRemaining = Math.max(0, fallback);
      return out;
    } catch {
      return { offline: true };
    }
  }

  return { send, quota };
}

// ---- ccgui-plugin-shared/feedback-ui.mjs ----
/**
 * 反馈区的行为层：状态、提交、额度、Issue 链接全在这里，四个插件共用。
 *
 * 为什么分成「行为 + 渲染」两步而不是一个组件：
 * - 每日热点 / 工作志 / 斜杠面板有 CSS 文件，类名各有前缀（gt- / wl- / sp-）；
 * - CLI 安装检测整套 UI 用内联 style，根本没有 CSS 文件。
 *
 * 所以这里只输出「长得一样」的元素树，类名与样式类由调用方传进来；
 * 内联 style 的那个插件可以只用 useFeedbackForm、自己写渲染。
 *
 * 逻辑部分原本在四个插件里各抄一份，而重复的恰好是最容易写错的那几段：
 * sendingRef 挡双击、成功后只清「这次发出去的那段」、额度不能被 null 读成 0。
 * 这些行为现在由 test/feedback-ui.test.mjs 逐个钉住。
 *
 * 依赖 feedback.mjs 的纯函数。内联进 main.js 后两者在同一作用域；
 * 单测里通过这条 import 直接解析。build.mjs 会剥掉这行 import。
 */


/**
 * 反馈区的状态与动作。
 *
 * @param {{useState: Function, useRef: Function, useEffect: Function}} R React 子系统
 *   （插件里是 ctx.react，测试里是假 React 的 api）。
 * @param {object} opts
 * @param {string} opts.repo           Issue 落到哪个仓库（owner/name）。
 * @param {string} opts.pluginName     Issue 标题里的插件中文名。
 * @param {string} opts.pluginVersion  写进请求体与 Issue 的插件版本。
 * @param {string} [opts.hostVersion]  CC GUI 版本，取不到就留空。
 * @param {(text: string) => Promise<object>} opts.send
 * @param {() => Promise<object|null>} opts.quota
 * @returns {object} 状态 + 动作 + `render(h, styleOpts)`
 */
function useFeedbackForm(R, opts) {
  const textState = R.useState("");
  const text = textState[0];
  const setText = textState[1];
  // "" -> "sending" -> "sent"/"error"
  const sendState = R.useState("");
  const sendStatus = sendState[0];
  const setSendStatus = sendState[1];
  const resultState = R.useState(null);
  const result = resultState[0];
  const setResult = resultState[1];
  const quotaState = R.useState(null);
  const quota = quotaState[0];
  const setQuota = quotaState[1];
  // 「只在挂载时查一次额度」的标志。用 ref 而不是 state：它只在 effect
  // 里读写，不该触发重渲染。
  const quotaTried = R.useRef(false);
  // 同步的在途标志。canSend 是渲染时的闭包值，同一 tick 内两次触发都会
  // 读到旧的 sendStatus=""，只在状态里防不住双击。
  const sendingRef = R.useRef(false);

  // 查不到就保持 {canRetry:true}，UI 说明是「连不上」而不是「额度紧张」
  // ——两句话对用户的意思完全不同。
  async function loadQuota() {
    const q = await opts.quota();
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
  const canSend = trimmed.length > 0 && sendStatus !== "sending";

  const issueUrl = buildIssueUrl({
    repo: opts.repo,
    pluginName: opts.pluginName,
    text: trimmed,
    pluginVersion: opts.pluginVersion,
    hostVersion: opts.hostVersion || "",
  });

  async function submit() {
    // sendingRef 是同步的：同一 tick 内两次触发都会读到 true，挡住双击。
    // sendStatus 要等重渲染才更新，靠它挡不住。
    if (!canSend || sendingRef.current) return;
    sendingRef.current = true;
    const submitted = trimmed;
    setSendStatus("sending");
    setResult(null);

    let r;
    try {
      r = await opts.send(submitted);
    } finally {
      sendingRef.current = false;
    }

    setSendStatus(r.ok ? "sent" : "error");
    setResult(r);
    // 失败时正文原样留着：用户重打一遍比什么都糟。
    if (!r.ok) return;

    // 只清掉「这次发出去的那段」。发送期间用户可能又敲了内容（那几个请求
    // 往返里 textarea 没禁用），直接清空会把他新写的也抹掉。
    setText((cur) => (cur === submitted ? "" : cur));

    // 额度优先用服务端回传的真实值。查额度时失败了也不要紧——成功响应里
    // 带了 remaining，正好顺手把「暂时连不上」纠正过来。没有回传就自减一格。
    setQuota((prev) => nextQuota(prev, r.remaining));
  }

  /** 正文变化。重新输入等于开了一条新反馈，上一条的回执（成功或失败）都该撤掉。 */
  function changeText(value) {
    setText(value);
    if (sendStatus !== "sending") {
      setSendStatus("");
      setResult(null);
    }
  }

  const quotaText = describeQuota(quota);
  const statusText =
    sendStatus === "sending" ? "发送中…" : result ? result.message : "";
  // 成功时正文被清空，按钮会变成不可点的死按钮。若文案还停在「发送反馈」，
  // 用户看到的就是「点了没反应」——回执必须落在按钮自己身上。
  const sendLabel =
    sendStatus === "sending" ? "发送中…" : sendStatus === "sent" ? "已发送" : "发送反馈";

  /**
   * 渲染成元素树。
   *
   * @param {Function} h createElement
   * @param {object} [style]
   * @param {string} [style.prefix]      类名前缀，如 "gt"；产出 `${prefix}-feedback-*`
   * @param {number} [style.rows]        正文框行数
   * @param {string} [style.variant]     "section"（带 section 外壳）或 "bare"
   * @param {object} [style.classes]     各插件的样式类：input / primaryBtn /
   *   secondaryBtn / hint / note / linkBtn。缺省为空。
   */
  function render(h, style) {
    const s = style || {};
    const prefix = s.prefix || "fb";
    const rows = s.rows || 5;
    const c = s.classes || {};
    // 统一样式钩子（行为稳定、可被任何插件套）与各插件自己的样式类
    // （决定长什么样）拼在一起。两者都要，缺了哪一半都不行。
    const cls = (name, extra) => {
      const own = prefix + "-feedback-" + name;
      return extra ? own + " " + extra : own;
    };
    const join = (a, b) => (a && b ? a + " " + b : a || b || "");

    const head =
      s.variant === "section"
        ? h(
            "div",
            { className: prefix + "-section-label" },
            h("h2", null, "反馈"),
            h("p", null, "遇到问题或想提建议，两种方式任选其一。"),
          )
        : null;

    const body = [
      h("textarea", {
        className: cls("text", c.input),
        value: text,
        rows: rows,
        maxLength: TEXT_LIMIT,
        placeholder: "描述问题或建议…（最多 " + TEXT_LIMIT + " 字）",
        spellCheck: false,
        "aria-label": "反馈正文",
        onChange: (e) => changeText(e.target.value),
      }),
      h(
        "div",
        { className: cls("row") },
        h("span", { className: cls("count", c.hint) }, text.length + " / " + TEXT_LIMIT),
        h(
          "span",
          { className: cls("quota", c.hint) },
          quotaText.message,
          // 额度查不到 / 用完了都给一条重试路径，否则用户只能重开设置页。
          quotaText.canRetry
            ? h(
                "button",
                {
                  type: "button",
                  className: cls("quota-retry", c.linkBtn),
                  disabled: sendStatus === "sending",
                  onClick: () => void loadQuota(),
                },
                "重试",
              )
            : null,
        ),
      ),
      h(
        "div",
        { className: cls("actions") },
        h(
          "a",
          {
            className: join(
              cls("issue", c.secondaryBtn),
              // 正文为空时 Issue 链接仍可点，但看起来不该和「能发」时一样重。
              // 判断口径必须与 canSend 一致，所以这里用同一个 trimmed，
              // 不能让调用方自己再算一遍（那样两边迟早漂开）。
              trimmed ? "" : c.muted || "",
            ),
            href: issueUrl,
            target: "_blank",
            rel: "noreferrer noopener",
            title: "在浏览器里打开预填好的 Issue 页面",
          },
          "通过 GitHub 提 Issue",
        ),
        h(
          "button",
          {
            type: "button",
            className: cls("send", c.primaryBtn) + (sendStatus === "sent" ? " " + cls("sent") : ""),
            disabled: !canSend,
            onClick: () => void submit(),
          },
          sendLabel,
        ),
      ),
      statusText
        ? h(
            "p",
            {
              className:
                cls("status", c.note) +
                (sendStatus === "sent" ? " is-ok" : "") +
                (sendStatus === "error" ? " is-bad" : ""),
              role: "status",
              "aria-live": "polite",
            },
            statusText,
          )
        : null,
      h(
        "p",
        { className: c.hint || "" },
        "发送的内容只有这段文字、插件版本与 CC GUI 版本。不含会话、代码或本机路径。",
      ),
    ].filter(Boolean);

    if (s.variant === "section") {
      return h(
        "section",
        { className: prefix + "-section" },
        head,
        h("div", { className: prefix + "-section-panel" }, body),
      );
    }
    return h("div", { className: prefix + "-feedback" }, body);
  }

  return {
    text,
    setText: changeText,
    sendStatus,
    result,
    quota,
    quotaText,
    canSend,
    submit,
    retryQuota: loadQuota,
    issueUrl,
    statusText,
    sendLabel,
    render,
  };
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
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  border-top: 1px solid var(--color-separator-border, rgba(127,127,127,.2));
  color: var(--color-text-tertiary, #8b949e);
  font-size: 11px;
}
.sp-foot-warn { color: var(--color-warning-default, #9a6700); }
.sp-foot-right { display: inline-flex; align-items: center; gap: 10px; }
.sp-refresh {
  padding: 2px 8px;
  border: 1px solid var(--color-separator-border, rgba(127,127,127,.28));
  border-radius: 5px;
  background: transparent;
  color: var(--color-text-secondary, #656d76);
  font: inherit;
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.sp-refresh:hover:not(:disabled) {
  background: var(--color-background-tertiary-hover, rgba(127,127,127,.12));
  color: var(--color-text-primary, #1f2328);
  border-color: var(--color-accent-primary-default, #3b82f6);
}
.sp-refresh:disabled { opacity: .5; cursor: not-allowed; }
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

// 工作区路径可能含空格、引号、反斜杠和中文：编码成 base64 再交给
// PowerShell 解码，避免把路径拼进脚本时被当成语法。
function toBase64Utf8(text) {
  const s = String(text || '');
  const bytes = new Uint8Array(s.length * 3);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) {
      bytes[n++] = c;
    } else if (c < 0x800) {
      bytes[n++] = 0xc0 | (c >> 6);
      bytes[n++] = 0x80 | (c & 0x3f);
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i++;
        bytes[n++] = 0xf0 | (c >> 18);
        bytes[n++] = 0x80 | ((c >> 12) & 0x3f);
        bytes[n++] = 0x80 | ((c >> 6) & 0x3f);
        bytes[n++] = 0x80 | (c & 0x3f);
      } else {
        bytes[n++] = 0xef;
        bytes[n++] = 0xbf;
        bytes[n++] = 0xbd;
      }
    } else {
      bytes[n++] = 0xe0 | (c >> 12);
      bytes[n++] = 0x80 | ((c >> 6) & 0x3f);
      bytes[n++] = 0x80 | (c & 0x3f);
    }
  }
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < n; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, n)));
  }
  try {
    return btoa(bin);
  } catch {
    return '';
  }
}

const SCAN_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$homeDir = $env:USERPROFILE
if ([string]::IsNullOrWhiteSpace($homeDir)) { $homeDir = $HOME }
# CLAUDE_CONFIG_DIR 有值时 Claude Code 会把 settings.json / plugins / projects 整体搬过去。
$claudeDir = if ([string]::IsNullOrWhiteSpace($env:CLAUDE_CONFIG_DIR)) {
  Join-Path $homeDir '.claude'
} else {
  [IO.Path]::GetFullPath($env:CLAUDE_CONFIG_DIR)
}

# 工作区路径由 JS 侧 base64 传入，避免引号、空格、中文破坏脚本语法。
$ws = ''
if (-not [string]::IsNullOrWhiteSpace($wsB64)) {
  try { $ws = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($wsB64)) } catch { $ws = '' }
}
if (-not [string]::IsNullOrWhiteSpace($ws)) { $ws = $ws.Trim() }

$rows = New-Object System.Collections.ArrayList
$hidden = 0

function Load-Json {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return ($text | ConvertFrom-Json)
  } catch { return $null }
}

$globalCfg = Load-Json (Join-Path $claudeDir 'settings.json')
$teamCfg = $null
$localCfg = $null
if (-not [string]::IsNullOrWhiteSpace($ws)) {
  $wsSettings = Join-Path (Join-Path $ws '.claude') 'settings.json'
  $wsLocal = Join-Path (Join-Path $ws '.claude') 'settings.local.json'
  $teamCfg = Load-Json $wsSettings
  $localCfg = Load-Json $wsLocal
}

# 三层逐键合并：本地 > 团队 > 全局。项目层 false 能压过全局 true。
# 只要某一层显式写了 enabledPlugins（哪怕是空对象 {}），就按「清单存在」处理：
# 空清单意味着没有插件被启用，而不是「不做过滤」。
$enabledMap = @{}
$skillOv = @{}
$hasEnabledList = $false
foreach ($layer in @($globalCfg, $teamCfg, $localCfg)) {
  if ($layer -and $layer.PSObject.Properties['enabledPlugins'] -and $null -ne $layer.enabledPlugins) {
    $hasEnabledList = $true
    foreach ($p in $layer.enabledPlugins.PSObject.Properties) { $enabledMap[[string]$p.Name] = $p.Value }
  }
  if ($layer -and $layer.PSObject.Properties['skillOverrides'] -and $layer.skillOverrides) {
    foreach ($p in $layer.skillOverrides.PSObject.Properties) { $skillOv[[string]$p.Name] = [string]$p.Value }
  }
}

# skillOverrides 只作用于个人/项目技能；插件技能不受本地开关控制（与 workspace-config 一致）。
function Skill-State {
  param([string]$Name)
  if ($skillOv.ContainsKey($Name)) { return [string]$skillOv[$Name] }
  return ''
}

function Read-Meta {
  param([string]$Path)
  $desc = ''
  $hint = ''
  $name = ''
  # 读前 160 行足以覆盖 frontmatter；超长 frontmatter 的命令极少数会丢 description
  $lines = @(Get-Content -LiteralPath $Path -TotalCount 160 -Encoding UTF8 -ErrorAction SilentlyContinue)
  if ($lines.Count -eq 0) { return [pscustomobject]@{ name = ''; description = ''; hint = '' } }
  $i = 0
  while ($i -lt $lines.Count -and [string]::IsNullOrWhiteSpace([string]$lines[$i])) { $i++ }
  if ($i -ge $lines.Count -or ([string]$lines[$i]).Trim() -ne '---') {
    return [pscustomobject]@{ name = ''; description = ''; hint = '' }
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
    if ($line -match '^name:\s*(.*)$') {
      $name = $Matches[1].Trim().Trim('"').Trim("'")
    } elseif ($line -match '^description:\s*(.*)$') {
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
  return [pscustomobject]@{ name = $name; description = $desc; hint = $hint }
}

function Add-Row {
  param([string]$Kind, [string]$Invoke, [string]$Description, [string]$Hint, [string]$Plugin, [string]$Marketplace, [string]$Path)
  if ([string]::IsNullOrWhiteSpace($Invoke)) { return }
  # 不在扫描期去重：同名条目可能来自不同来源，交给 JS 在应用来源开关后按优先级解析。
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

# 项目/用户/插件三段技能扫描只差目录、来源和两个开关，收进同一处。
# 注意 $hidden 是脚本作用域：函数内必须写 $script:hidden，否则只改局部副本。
function Collect-Skill-Rows {
  param(
    [string]$Root,
    [string]$Kind,
    [string]$Plugin = '',
    [string]$Marketplace = '',
    [bool]$Disabled = $false,
    [bool]$ApplyOverrides = $true
  )
  if (-not (Test-Path -LiteralPath $Root)) { return }
  foreach ($d in @(Get-ChildItem -LiteralPath $Root -Directory -Attributes !ReparsePoint -ErrorAction SilentlyContinue)) {
    $md = Join-Path $d.FullName 'SKILL.md'
    if (-not (Test-Path -LiteralPath $md)) { continue }
    if ($Disabled) { $script:hidden++; continue }
    $meta = Read-Meta $md
    $name = if ([string]::IsNullOrWhiteSpace($meta.name)) { $d.Name } else { $meta.name }
    $desc = $meta.description
    if ($ApplyOverrides) {
      $state = Skill-State $name
      if ($state -eq 'off') { $script:hidden++; continue }
      if ($state -eq 'name-only') { $desc = '' }
    }
    $invoke = if ([string]::IsNullOrWhiteSpace($Plugin)) { '/' + $name } else { '/' + $Plugin + ':' + $name }
    Add-Row $Kind $invoke $desc $meta.hint $Plugin $Marketplace $md
  }
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

# --- 项目级（当前工作区）---
# 先加项目级：Add-Row 按调用名先到先得，同名时项目版自然压过用户版。
if (-not [string]::IsNullOrWhiteSpace($ws)) {
  $wsClaude = Join-Path $ws '.claude'
  $projCmd = Join-Path $wsClaude 'commands'
  if (Test-Path -LiteralPath $projCmd) {
    foreach ($f in @(Get-ChildItem -LiteralPath $projCmd -Recurse -File -Filter *.md -Attributes !ReparsePoint -ErrorAction SilentlyContinue)) {
      $meta = Read-Meta $f.FullName
      Add-Row 'project-command' ('/' + (Strip-Rel $projCmd $f.FullName)) $meta.description $meta.hint '' '' $f.FullName
    }
  }
  $projSkill = Join-Path $wsClaude 'skills'
  Collect-Skill-Rows -Root $projSkill -Kind 'project-skill'
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
Collect-Skill-Rows -Root $userSkill -Kind 'user-skill'

# --- 插件：优先用 Claude Code 记录的安装路径与启用清单 ---
# installed_plugins.json 的 installPath 是当前真正加载的目录（版本名可能是 commit hash），
# 比按目录名或修改时间猜版本可靠；合并后的 enabledPlugins 决定插件命令是否可用。
$cacheRoot = Join-Path $claudeDir 'plugins\cache'
$entries = New-Object System.Collections.ArrayList
$installedFile = Join-Path $claudeDir 'plugins\installed_plugins.json'
$installed = $null

if (Test-Path -LiteralPath $installedFile) {
  try {
    $rawInstalled = Get-Content -LiteralPath $installedFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($rawInstalled -and $rawInstalled.plugins) { $installed = $rawInstalled.plugins }
  } catch {}
}

if ($installed) {
  foreach ($prop in $installed.PSObject.Properties) {
    $key = [string]$prop.Name
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
    # 有启用清单时只保留合并后显式为 true 的插件，避免列出装了但没开、
    # 或被项目/团队层关掉的命令。禁用插件的条目仍进列表，循环里逐条计入隐藏数。
    $disabled = $false
    if ($hasEnabledList) {
      if (-not $enabledMap.ContainsKey($key) -or $enabledMap[$key] -ne $true) { $disabled = $true }
    }
    [void]$entries.Add([pscustomobject]@{ market = $marketName; plugin = $pluginName; dir = $dir; disabled = $disabled })
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
      $key = $plugin.Name + '@' + $market.Name
      $disabledFallback = $false
      if ($hasEnabledList) {
        if (-not $enabledMap.ContainsKey($key) -or $enabledMap[$key] -ne $true) { $disabledFallback = $true }
      }
      [void]$entries.Add([pscustomobject]@{ market = $market.Name; plugin = $plugin.Name; dir = $latest.FullName; disabled = $disabledFallback })
    }
  }
}
  foreach ($e in $entries) {
    $cmdRoot = Join-Path $e.dir 'commands'
    if (Test-Path -LiteralPath $cmdRoot) {
      foreach ($f in @(Get-ChildItem -LiteralPath $cmdRoot -Recurse -File -Filter *.md -Attributes !ReparsePoint -ErrorAction SilentlyContinue)) {
        if ($e.disabled) { $hidden++; continue }
        $meta = Read-Meta $f.FullName
        Add-Row 'plugin-command' ('/' + $e.plugin + ':' + (Strip-Rel $cmdRoot $f.FullName)) $meta.description $meta.hint $e.plugin $e.market $f.FullName
      }
    }
    $skillRoot = Join-Path $e.dir 'skills'
    # 插件技能不读 skillOverrides：它只控制个人/项目技能。
    Collect-Skill-Rows -Root $skillRoot -Kind 'plugin-skill' -Plugin $e.plugin -Marketplace $e.market -Disabled $e.disabled -ApplyOverrides $false
  }

$order = @{
  'project-command' = 0; 'project-skill' = 1;
  'user-command' = 2; 'user-skill' = 3;
  'plugin-command' = 4; 'plugin-skill' = 5
}
$sorted = @($rows | Sort-Object @{ Expression = { $order[$_.kind] } }, @{ Expression = { $_.invoke } })

$result = [pscustomobject]@{
  ok = $true
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  hidden = $hidden
  roots = [pscustomobject]@{
    home = $homeDir
    claude = $claudeDir
    plugins = $cacheRoot
    ws = $ws
  }
  counts = [pscustomobject]@{
    plugins = @($rows | Where-Object { $_.kind -like 'plugin-*' }).Count
    project = @($rows | Where-Object { $_.kind -like 'project-*' }).Count
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

  /** 宿主版本。老版本宿主可能没有这一项，取不到就留空，不能因此发不出反馈。 */
  function hostAppVersion() {
    try {
      return ctx && ctx.host && typeof ctx.host.appVersion === 'string' ? ctx.host.appVersion : '';
    } catch {
      return '';
    }
  }

  // 端点与插件 id 只从常量来，不可能出现「请求体是 A、User-Agent 是 B」的错位。
  const feedbackNet = createFeedbackNet(ctx, {
    endpoint: FEEDBACK_ENDPOINT,
    pluginId: PLUGIN_ID,
    timeoutMs: FEEDBACK_TIMEOUT_MS,
  });
  function sendFeedback(text) {
    return feedbackNet.send(text);
  }
  function fetchQuota() {
    return feedbackNet.quota();
  }

  // 三个 UI 入口不在同一棵 React 树里，共用一份模块内 store
  const store = {
    snap: {
      open: false,
      status: 'idle', // idle | scanning | ok | stale | error
      items: [],
      at: 0,
      ws: '',
      hidden: 0,
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
    // 这里不去重：同名条目可能有不同来源，要等应用来源开关后再按优先级解析。
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const invoke = typeof it.invoke === 'string' ? it.invoke.trim() : '';
      if (!invoke || invoke.charAt(0) !== '/' || invoke.length < 2) continue;
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

  // 同名条目谁生效：命令是项目 > 用户；技能是个人 > 项目（官方 skills 优先级）。
  // 插件命令带命名空间，正常不会撞名，给个中间值兜底。
  const SOURCE_RANK = {
    'project-command': 60,
    'user-command': 50,
    'user-skill': 40,
    'project-skill': 30,
    'plugin-command': 20,
    'plugin-skill': 20,
    builtin: 10,
  };

  function visibleItems(snap) {
    const s = snap.settings || DEFAULT_SETTINGS;
    const out = [];
    const byKey = new Map();
    for (const it of snap.items) {
      if (it.kind.indexOf('plugin-') === 0 && !s.plugins) continue;
      if (it.kind.indexOf('project-') === 0 && !s.project) continue;
      if (it.kind.indexOf('user-') === 0 && !s.user) continue;
      const key = it.invoke.toLowerCase();
      const prev = byKey.get(key);
      if (!prev || (SOURCE_RANK[it.kind] || 0) > (SOURCE_RANK[prev.kind] || 0)) {
        byKey.set(key, it);
      }
    }
    for (const it of byKey.values()) out.push(it);
    if (s.builtin) {
      for (const b of BUILTIN) {
        if (!byKey.has(b.invoke.toLowerCase())) out.push(b);
      }
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
  let inflightWs = '';
  let queuedWs = null;

  // 去尾分隔符、去空白；盘符根（C:\）长度只有 3，不能剥成 C:。
  function normalizeWorkspace(p) {
    if (typeof p !== 'string') return null;
    const trimmed = p.trim();
    if (!trimmed) return null;
    return trimmed.length > 3 ? trimmed.replace(/[\\/]+$/, '') : trimmed;
  }

  function sameWorkspace(a, b) {
    return String(a || '').toLowerCase() === String(b || '').toLowerCase();
  }

  // 宿主 IPC 卡住时不能无限等，否则设置页的 settingsLoaded 永远不置位。
  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((resolve) => {
        setTimeout(() => resolve(null), ms);
      }),
    ]);
  }

  // 拿当前会话所在工作区；宿主未就绪、没授权或超时都返回 null。
  // 用 null 而不是空串，避免把「这次没拿到」误判成「工作区变了」而清掉项目层。
  async function currentWorkspace() {
    try {
      if (!ctx.workspace || typeof ctx.workspace.getMetadata !== 'function') return null;
      const meta = await withTimeout(ctx.workspace.getMetadata(), 1500);
      return meta ? normalizeWorkspace(meta.path) : null;
    } catch {
      return null;
    }
  }

  async function runScan(ws) {
    store.set({ status: 'scanning', error: '' });
    try {
      // 工作区路径经 base64 注入，脚本里再解回字符串。
      const script = "$wsB64 = '" + toBase64Utf8(ws) + "'\n" + SCAN_SCRIPT;
      // Windows 命令行上限 32767 字符；脚本 12K 左右，直传 -Command 即可。
      // 走 -EncodedCommand 会把脚本放大到 ~4/3 倍 UTF-16，超限时进程直接起不来。
      if (script.length > 30000) throw new Error('扫描脚本过长');
      const r = await ctx.bridge.invoke('plugin_exec_run', {
        bin: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', script],
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
      const hidden = Number(data && data.hidden) || 0;
      const roots = data && data.roots && typeof data.roots === 'object' ? data.roots : {};
      const counts = data && data.counts && typeof data.counts === 'object' ? data.counts : {};
      store.set({ status: 'ok', items, at, ws, hidden, roots, counts, error: '' });
      if (ctx.storage) {
        try {
          await ctx.storage.set(CACHE_KEY, { version: 2, at, ws, hidden, items, roots, counts });
        } catch {
          // 缓存写失败不影响本次结果
        }
      }
    } catch (e) {
      // 换工作区后扫描失败时，旧的项目命令已经不属于当前目录，必须剔除；
      // 同一工作区的失败则保留旧列表，避免一次网络/权限抖动把面板清空。
      const prev = store.snap;
      const sameWs = sameWorkspace(ws, prev.ws);
      const items = sameWs ? prev.items : prev.items.filter((it) => it.kind.indexOf('project-') !== 0);
      store.set({
        status: items.length ? 'stale' : 'error',
        items,
        ws,
        hidden: sameWs ? prev.hidden : 0,
        error: errorText(e),
      });
    }
  }

  function scan(ws) {
    if (inflight) {
      // 扫描中切了工作区：排一次队，等当前扫描结束再扫新目录。
      // 又切回正在扫的那个就清掉队列，别在结束后多扫一次旧目标。
      queuedWs = sameWorkspace(ws, inflightWs) ? null : ws;
      return inflight;
    }
    inflightWs = ws;
    inflight = runScan(ws).finally(() => {
      inflight = null;
      const next = queuedWs;
      queuedWs = null;
      if (next !== null && !sameWorkspace(next, ws)) void scan(next);
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

  // 手动刷新不看 TTL，但要带上当前工作区，否则项目层会读到旧目录。
  // 这次没拿到工作区时沿用上次的，绝不拿空串去扫（会把项目层清掉并写进缓存）。
  function refreshNow() {
    return currentWorkspace().then((ws) => scan(ws !== null ? ws : store.snap.ws || ''));
  }

  function openPalette() {
    store.set({ open: true, query: '', activeIndex: 0 });
    void refreshIfNeeded();
  }

  // 状态行按钮和命令面板入口都走这里，所以刷新策略只在这一处判断：
  // 工作区变了、没数据、或数据超过 TTL 才扫；否则直接用内存里的列表。
  async function refreshIfNeeded() {
    const ws = await currentWorkspace();
    const snap = store.snap;
    const changed = ws !== null && !sameWorkspace(ws, snap.ws);
    if (snap.status === 'scanning') {
      // 扫描中切了工作区：排队，别让旧工作区的结果留在 B 的面板里。
      if (changed) void scan(ws);
      return;
    }
    const target = ws !== null ? ws : snap.ws || '';
    const stale = Date.now() - (Number(snap.at) || 0) > CACHE_TTL;
    if (changed || !snap.items.length || stale) void scan(target);
  }

  async function readSettings() {
    if (!ctx.storage) return Object.assign({}, DEFAULT_SETTINGS);
    try {
      const s = await ctx.storage.get(SETTINGS_KEY);
      if (!s || typeof s !== 'object') return Object.assign({}, DEFAULT_SETTINGS);
      return {
        plugins: s.plugins !== false,
        user: s.user !== false,
        project: s.project !== false,
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

  // 启动：先恢复设置与缓存，缓存过期、缺失或换了工作区才重扫
  void (async () => {
    const settings = await readSettings();
    // settingsLoaded 先置位：工作区元数据拿不到时也不能把设置页一直禁用着。
    store.set({ settings, settingsLoaded: true });
    const ws = (await currentWorkspace()) || '';
    store.set({ ws });
    let saved = null;
    if (ctx.storage) {
      try {
        saved = await ctx.storage.get(CACHE_KEY);
      } catch {
        saved = null;
      }
    }
    // 空结果不当作有效缓存：否则 ~/.claude 尚未生成时，5 分钟内新装的命令都看不到。
    // 工作区不同也不能复用：项目层命令完全来自另一个目录。
    if (
      saved &&
      saved.version === 2 &&
      sameWorkspace(saved.ws, ws) &&
      Array.isArray(saved.items) &&
      saved.items.length
    ) {
      store.set({
        status: 'ok',
        items: normalizeItems(saved.items),
        at: Number(saved.at) || 0,
        ws,
        hidden: Number(saved.hidden) || 0,
        roots: saved.roots && typeof saved.roots === 'object' ? saved.roots : {},
        counts: saved.counts && typeof saved.counts === 'object' ? saved.counts : {},
      });
      if (Date.now() - (Number(saved.at) || 0) < CACHE_TTL) return;
    }
    await scan(ws);
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

  // 不要写内联 display：宿主设置侧栏的可拖拽行会渲染两次图标，第二次靠
  // className 里的 `md:hidden` 在桌面隐藏，内联 display 会压过它，变成两个图标。
  function Icon(props) {
    return h(
      'svg',
      {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        'aria-hidden': 'true',
        ...(props && props.className ? { className: props.className } : {}),
      },
      h('path', {
        d: 'M5.44 12.94L10.56 3.06',
        strokeWidth: 1.87,
        strokeLinecap: 'round',
      }),
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
        h('button', { className: 'sp-retry', onClick: () => void refreshNow() }, '重试'),
      );
    } else if (snap.status === 'stale') {
      statusLine = h(
        'div',
        { className: 'sp-status sp-status-warn' },
        '正在使用缓存结果：' + snap.error,
        h('button', { className: 'sp-retry', onClick: () => void refreshNow() }, '重试'),
      );
    } else if (snap.at) {
      statusLine = h(
        'div',
        { className: 'sp-status' },
        '共 ' +
          all.length +
          ' 条 · 更新于 ' +
          fmtTime(snap.at) +
          (snap.hidden ? ' · 已隐藏 ' + snap.hidden + ' 条当前工作区不可用' : ''),
      );
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
          h(
            'span',
            { className: 'sp-foot-right' },
            h('span', { className: 'sp-foot-warn' }, '写入会替换输入框现有内容'),
            h(
              'button',
              {
                type: 'button',
                className: 'sp-refresh',
                disabled: snap.status === 'scanning',
                title: '重新扫描本机命令目录',
                onClick: () => void refreshNow(),
              },
              snap.status === 'scanning' ? '刷新中…' : '刷新',
            ),
          ),
        ),
      ),
    );
  }

  function FeedbackSection() {
    // 这个插件的 React 解构里没有 useState/useRef（其余组件只靠 store），
    // 反馈区是局部状态，直接从 ctx.react 取，别去改顶层的解构。
    const R = ctx.react;
    const h = R.createElement;

    // 状态与提交逻辑由 useFeedbackForm 提供（四插件共用），这里只负责
    // 接到本插件的网络层与样式体系上。
    const form = useFeedbackForm(R, {
      repo: FEEDBACK_REPO,
      pluginName: FEEDBACK_PLUGIN_NAME,
      pluginVersion: ctx.version,
      hostVersion: hostAppVersion(),
      send: (text) => sendFeedback(text),
      quota: () => fetchQuota(),
    });

    return form.render(h, {
      prefix: 'sp',
      rows: 4,
      classes: {
        input: 'sp-feedback-input',
        primaryBtn: 'sp-btn sp-btn-primary',
        secondaryBtn: 'sp-btn',
        hint: 'sp-setting-desc',
        note: '',
        linkBtn: 'sp-link-btn',
        muted: 'sp-btn-muted',
      },
    });
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
      row('project', '项目命令与技能', '读取当前工作区 .claude/commands/*.md 与 .claude/skills/*/SKILL.md。'),
      row('user', '用户命令与技能', '读取 ~/.claude/commands/*.md 与 ~/.claude/skills/*/SKILL.md。'),
      row('plugins', '插件命令与技能', '读取 ~/.claude/plugins/cache 下的 commands/*.md 与 skills/*/SKILL.md。'),
      row('builtin', '内置命令', '补充 /help、/clear、/compact 等常见命令，可能与宿主自带列表重复。'),
      row('showDesc', '显示命令描述', '在列表里显示每个命令 frontmatter 里的 description。'),
      h(
        'div',
        { className: 'sp-actions' },
        h('button', { className: 'sp-btn', onClick: () => void refreshNow() }, snap.status === 'scanning' ? '扫描中…' : '立即刷新'),
        h('span', { className: 'sp-setting-desc' }, '上次扫描：' + fmtTime(snap.at)),
      ),
      snap.error ? h('div', { className: 'sp-status sp-status-error' }, '上次错误：' + snap.error) : null,
      h(
        'div',
        { className: 'sp-diag' },
        '项目命令 ' + (counts.project || 0) +
          ' · 插件命令 ' + (counts.plugins || 0) +
          ' · 用户 ' + (counts.user || 0) +
          (snap.hidden ? ' · 隐藏 ' + snap.hidden : '') + '\n' +
          '工作区：' + shortPath(roots.ws) + '\n' +
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


