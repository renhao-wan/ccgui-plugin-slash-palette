// 反馈纯函数是从 ccgui-plugin-github-trending/src/lib/feedback.mjs 整段复制的
// （这个插件没有构建步骤，只能内联）。注释里写了「改这里记得同步」，但注释拦不住
// 忘同步。这个脚本把「两份逐字一致」变成可执行检查。
//
// 只比对纯函数层（正文收敛、Issue 链接、请求体白名单、额度文案）——
// 网络与 UI 各自实现，不在比对范围。
//
// 用法：node scripts/check-feedback-sync.mjs
//   基准文件默认是本地兄弟目录里的 github-trending；CI 里没有兄弟目录，
//   可以用环境变量 FEEDBACK_BASE 指到 checkout 下来的那份。
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const REPO = path.resolve(HERE, '..');
const BASE =
  process.env.FEEDBACK_BASE ||
  path.resolve(REPO, '..', 'ccgui-plugin-github-trending', 'src', 'lib', 'feedback.mjs');
const TARGET = path.join(REPO, 'main.js');

// 按函数名切段：从 `function X(` 或 `const X =` 到下一个同级声明。
// 只在反馈纯函数区间里找，避免把 UI 里的同名局部量算进来。
const NAMES = [
  'TEXT_LIMIT',
  'normaliseFeedbackText',
  'buildIssueUrl',
  'PAYLOAD_FIELDS',
  'buildFeedbackPayload',
  'parseJson',
  'quotaCount',
  'nextQuota',
  'describeFeedbackResult',
  'describeQuota',
];

// 归一化：把 `function parseJson(` 与 `function parseJsonBody(` 当成同一个名字
// （无构建插件里为避免与其它符号冲突改了名），并抹掉引号风格与分号。
function normalize(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\bparseJson\b/g, 'parseJsonBody')
    .replace(/export\s+/g, '')
    .replace(/;/g, '')
    .replace(/["']/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// 从一段源码里抓出某个声明的完整文本。
// 允许前导空白：无构建插件的纯函数嵌在 activate() 里，比基准多一层缩进。
function grab(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = new RegExp(`^[ \\t]*(?:export\\s+)?(?:async\\s+)?(?:function|const|let|var)\\s+${escaped}\\b`, 'm');
  const m = start.exec(source);
  if (!m) return null;
  const begin = m.index;
  // 单行声明（const X = ...;）到行尾；函数体按大括号配平。
  const head = source.slice(begin, begin + 200);
  if (!/\b(function|=>)\b/.test(head.split('\n')[0]) && !head.includes('{')) {
    const nl = source.indexOf('\n', begin);
    return source.slice(begin, nl === -1 ? undefined : nl);
  }
  if (/^(?:export\s+)?(?:async\s+)?function\b/.test(head)) {
    let depth = 0;
    let started = false;
    for (let i = begin; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '{') {
        depth += 1;
        started = true;
      } else if (ch === '}') {
        depth -= 1;
        if (started && depth === 0) return source.slice(begin, i + 1);
      }
    }
    return null;
  }
  // const + 对象/数组字面量：配平到分号或行尾
  let depth = 0;
  for (let i = begin; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    else if (ch === ';' && depth === 0) return source.slice(begin, i);
    else if (ch === '\n' && depth === 0) {
      // 继续看下一行，可能是多行的 const（三元/数组）
      const rest = source.slice(i + 1).split('\n')[0];
      if (!/^\s{2, }\S/.test(rest) && !/^\s{2,}/.test(rest)) return source.slice(begin, i);
    }
  }
  return source.slice(begin);
}

if (!fs.existsSync(BASE)) {
  // 本地缺基准可以跳过；CI 里跳过就等于没检查，所以只认显式声明的环境。
  if (process.env.CI) {
    console.log(`FAIL=找不到基准文件（${BASE}）。CI 里请 checkout github-trending 并设置 FEEDBACK_BASE`);
    process.exit(1);
  }
  console.log(`SKIP=基准文件不存在（${BASE}）`);
  process.exit(0);
}

const baseSrc = fs.readFileSync(BASE, 'utf8');
const targetSrc = fs.readFileSync(TARGET, 'utf8');

const diffs = [];
for (const name of NAMES) {
  // 基准里是 parseJson，无构建插件里为了避免与其它符号冲突叫 parseJsonBody。
  const localName = name === 'parseJson' ? 'parseJsonBody' : name;
  const a = grab(baseSrc, name);
  const b = grab(targetSrc, localName);
  if (a === null) {
    diffs.push(`${name}：基准里找不到（基准文件结构变了？）`);
    continue;
  }
  if (b === null) {
    diffs.push(`${name}：main.js 里找不到`);
    continue;
  }
  if (normalize(a) !== normalize(b)) diffs.push(`${name}：与基准不一致`);
}

if (diffs.length === 0) {
  console.log('RESULT=FEEDBACK_IN_SYNC');
  process.exit(0);
}

console.log('反馈纯函数与基准不一致：');
for (const d of diffs) console.log('  - ' + d);
console.log('\n基准：' + path.relative(REPO, BASE));
console.log('把基准里对应的函数整段复制到 main.js，保持逐字一致（只改引号风格与 parseJson 命名）。');
process.exit(1);
