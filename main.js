// Claude 斜杠命令：仅扫描本机 Claude Code 的命令源，搜索并写入输入框草稿。
// 单文件 ESM：不能有 import、JSX、eval / new Function。
// 写入只能经 ctx.composer.setDraft；插件无法读取输入框内容或监听按键。

const PLUGIN_ID = 'slash-palette';
const CACHE_KEY = 'slash-palette-cache-v1';
const SETTINGS_KEY = 'slash-palette-settings-v1';
const CACHE_TTL = 10 * 60 * 1000;

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

# --- 插件缓存：同一插件只取最近写入的版本目录 ---
$cacheRoot = Join-Path $claudeDir 'plugins\cache'
if (Test-Path -LiteralPath $cacheRoot) {
  $entries = New-Object System.Collections.ArrayList
  foreach ($market in @(Get-ChildItem -LiteralPath $cacheRoot -Directory -Attributes !ReparsePoint -ErrorAction SilentlyContinue)) {
    foreach ($plugin in @(Get-ChildItem -LiteralPath $market.FullName -Directory -Attributes !ReparsePoint -ErrorAction SilentlyContinue)) {
      $versions = @(Get-ChildItem -LiteralPath $plugin.FullName -Directory -Attributes !ReparsePoint -ErrorAction SilentlyContinue)
      if ($versions.Count -eq 0) { continue }
      $latest = $versions | Sort-Object LastWriteTime -Descending | Select-Object -First 1
      [void]$entries.Add([pscustomobject]@{ market = $market.Name; plugin = $plugin.Name; dir = $latest.FullName })
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
    store.set({ settings });
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

  function SettingsSection() {
    const snap = useSnap();
    const s = snap.settings;
    const toggle = (key) => {
      // 读实时快照而不是本次渲染的闭包值：连续点两个开关时不会互相覆盖
      const cur = store.snap.settings;
      void writeSettings(Object.assign({}, cur, { [key]: !cur[key] }));
    };

    function row(key, title, desc) {
      return h(
        'label',
        { className: 'sp-setting', key },
        h('input', { type: 'checkbox', checked: !!s[key], onChange: () => toggle(key) }),
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
