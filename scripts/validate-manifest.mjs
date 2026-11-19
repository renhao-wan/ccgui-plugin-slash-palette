#!/usr/bin/env node
// 本地/CI 共用的插件自检。零依赖，Node >= 20。
// 规则对齐官方索引仓 zhukunpenglinyutong/ccgui-plugins 的校验器（能本地复现的部分）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];

const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  } catch (e) {
    fail(`${rel} 读取或解析失败：${e.message}`);
    return null;
  }
}

const m = readJson('manifest.json');
if (!m) finish();

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const VER_RE = /^\d+\.\d+\.\d+$/;

if (!ID_RE.test(m.id || '')) fail(`id 不合法：${m.id}`);
if (!VER_RE.test(m.version || '')) fail(`version 不是 x.y.z：${m.version}`);
if (!['declarative', 'js'].includes(m.tier)) fail(`tier 不合法：${m.tier}`);
if (!m.name) fail('缺少 name');
if (!m.description) fail('缺少 description');
if (!m.repo || !/^[^/\s]+\/[^/\s]+$/.test(m.repo)) fail(`repo 形状应为 owner/name：${m.repo}`);

// 权限：基座白名单 + exec:<bin> / network:<host[:port|范围]>
const BASE = new Set([
  'storage', 'ui:settings-section', 'ui:add-menu', 'ui:composer-status', 'ui:panel-tab',
  'ui:status-bar', 'ui:overlay', 'ui:command', 'ui:markdown', 'ui:page', 'ui:timeline-row',
  'ui:workspace-menu', 'ui:session-menu', 'ui:file-link-menu', 'ui:sidebar-entry',
  'ui:center-tab', 'ui:conversation-mode', 'ui:worktree-badge', 'agent', 'theme', 'i18n',
  'events', 'network:none', 'composer:draft', 'host:session', 'host:workspace',
  'host:workspace:remote', 'host:worktree', 'host:window', 'host:models', 'usage.read',
  'limits.read', 'session.lifecycle.read', 'runtime.events.read', 'runtime.switch.observe',
  'prompt.contribute.internal', 'workspace.metadata.read', 'plugin.storage', 'assets:bundle',
  'assets:directory',
]);
const EXEC_RE = /^exec:[A-Za-z0-9._-]+$/;
const NET_RE = /^network:[A-Za-z0-9.-]+(:\d{1,5}(-\d{1,5})?)?$/;

for (const p of m.permissions || []) {
  if (!BASE.has(p) && !EXEC_RE.test(p) && !NET_RE.test(p)) fail(`未知权限：${p}`);
}

// 产物检查
const bundle = path.join(ROOT, 'main.js');
if (!fs.existsSync(bundle)) {
  fail('缺少 main.js');
} else {
  const src = fs.readFileSync(bundle, 'utf8');
  const size = Buffer.byteLength(src);
  if (size > 2 * 1024 * 1024) fail(`main.js ${(size / 1024).toFixed(0)}KB 超过 2MB 硬上限`);
  else if (size > 512 * 1024) warn(`main.js ${(size / 1024).toFixed(0)}KB 超过 512KB 建议值`);

  const banned = [
    [/\beval\s*\(/, 'eval('],
    [/\bnew\s+Function\s*\(/, 'new Function('],
    [/__TAURI__/, '__TAURI__'],
    [/\blocalStorage\b/, 'localStorage'],
    [/\bimport\s*\(\s*['"`]https?:/, '远程 import('],
    [/^\s*import\s+.+from\s+['"][^./]/m, 'bare import'],
    [/^\s*(?:const|let|var)\s+.+=\s*require\s*\(/m, 'require('],
  ];
  for (const [re, label] of banned) if (re.test(src)) fail(`main.js 命中黑名单：${label}`);

  // 权限 ↔ 代码用法一致性：少声明时宿主会在运行期抛错或静默降级
  const declared = new Set(m.permissions || []);
  const required = [];
  if (/\bctx\.storage\s*\./.test(src)) required.push(['storage', 'ctx.storage']);
  if (/\bctx\.ui\.registerSettingsSection\b|\bctx\.ui\.openSettings\b/.test(src))
    required.push(['ui:settings-section', 'settings section']);
  if (/\bctx\.ui\.registerCommand\b/.test(src)) required.push(['ui:command', 'registerCommand']);
  if (/plugin_exec_run[\s\S]{0,300}?bin\s*:\s*['"]powershell['"]/.test(src))
    required.push(['exec:powershell', 'plugin_exec_run powershell']);
  for (const [perm, usage] of required) {
    if (!declared.has(perm)) fail(`源码用到 ${usage}，但 manifest.permissions 缺少 ${perm}`);
  }
}

// 展示素材：必须存在、扩展名合法、不逃逸仓库
function checkAsset(rel, label) {
  if (!rel) return;
  if (/^https:\/\//.test(rel)) return;
  const abs = path.resolve(ROOT, rel);
  if (!abs.startsWith(ROOT + path.sep)) return fail(`${label} 逃逸仓库：${rel}`);
  if (!fs.existsSync(abs)) return fail(`${label} 不存在：${rel}`);
  if (!/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(rel)) fail(`${label} 不是图片：${rel}`);
}

checkAsset(m.icon, 'icon');
for (const s of m.screenshots || []) checkAsset(s, 'screenshot');
if ((m.screenshots || []).length > 5) fail('screenshots 最多 5 张');

for (const r of ['README.md', 'LICENSE']) {
  if (!fs.existsSync(path.join(ROOT, r))) fail(`仓库根缺少 ${r}`);
}

finish();

function finish() {
  for (const w of warnings) console.warn('WARN  ' + w);
  for (const e of errors) console.error('FAIL  ' + e);
  console.log(`\nRESULT=${errors.length === 0 ? 'VALIDATE_OK' : 'VALIDATE_FAIL'} errors=${errors.length} warnings=${warnings.length}`);
  process.exit(errors.length === 0 ? 0 : 1);
}
