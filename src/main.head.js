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

/*__LIB_SOURCE__*/
/*__LIB_SOURCE_END__*/
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


