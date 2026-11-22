#!/usr/bin/env node
/**
 * 把 src/lib 的共用库内联进 src/main.head.js，产出可分发的单文件 main.js。
 *
 * 这个插件原本是手写单文件、没有构建步骤，纯函数整段复制在 main.js 里。
 * 现在共用层搬到了 npm 包 ccgui-plugin-shared，复制这条路就断了——要么
 * 每处继续手抄，要么加构建。选了构建：产物形态不变，仍是单文件、零 import。
 *
 * 宿主以 ESM blob 加载插件，不能 import 兄弟文件，所以库必须内联。
 * 库文件本身是 ESM（为了单测能直接 import），内联时剥掉 `export ` 前缀，
 * 否则函数体里出现 `export function` 是语法错误。
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const START = "/*__LIB_SOURCE__*/";
const END = "/*__LIB_SOURCE_END__*/";
const require = createRequire(import.meta.url);

// 顺序即内联顺序，同时决定 stripLocalImports 放行哪些兄弟 import。
// 有依赖的必须排在前面：feedback 在 feedback-ui 之前。
// 本插件不渲染 Markdown，所以不含 markdown / markdown-view。
const LIB_ORDER = ["feedback", "feedback-net", "feedback-ui"];

/**
 * 读一个库的源码。
 *
 * 用 require.resolve 而不是拼 node_modules/<name>/src/<name>.mjs：
 * 包的 exports 映射才是入口的真相，拼路径等于把包的目录结构写死一份在这里。
 */
function readLib(name) {
  try {
    return fs.readFileSync(require.resolve("ccgui-plugin-shared/" + name), "utf8");
  } catch (err) {
    throw new Error(
      `读不到共用库 ccgui-plugin-shared/${name}（${err.message}）。` +
        "先跑 npm install——这个包是 npm 依赖，不在仓库里。",
    );
  }
}

function stripExports(source) {
  // 只动行首的 export 关键字，避免误伤字符串里的 "export"。
  return source.replace(/^export\s+(?=(?:function|const|let|var|class)\s)/gm, "");
}

/**
 * 剥掉「指向兄弟 lib 的 import」。
 *
 * 库文件内联进同一个作用域后，这些 import 语句就成了语法错误。只放行
 * `./name.mjs` 这一种形状：真实的外部依赖仍然要拦，否则会产出一个宿主
 * 加载即失败的 main.js。
 */
function stripLocalImports(source, name) {
  return source.replace(
    /^import\s*\{([^}]*)\}\s*from\s*["']\.\/([A-Za-z0-9_-]+)\.mjs["'];?[ \t]*\n/gm,
    (_all, _names, dep) => {
      if (!LIB_ORDER.includes(dep)) {
        throw new Error(`${name}.mjs 引用了不在 LIB_ORDER 里的库：./${dep}.mjs`);
      }
      return "";
    },
  );
}

const head = fs.readFileSync(path.join(ROOT, "src", "main.head.js"), "utf8");
if (!head.includes(START) || !head.includes(END)) {
  throw new Error(`main.head.js 缺少内联标记 ${START} / ${END}`);
}
const startAt = head.indexOf(START);
const endAt = head.indexOf(END);
if (endAt < startAt) throw new Error("内联标记顺序颠倒");

const chunks = [];
for (const name of LIB_ORDER) {
  const raw = readLib(name);
  const src = stripLocalImports(raw, name);
  // 兄弟库的 import 上面已经剥掉了；还剩 import 就说明是外部依赖，
  // 内联进单文件产物后宿主加载会直接失败，必须拦在这里。
  if (/^\s*import\s/m.test(src)) throw new Error(`${name}.mjs 含无法内联的 import`);
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(src)) throw new Error(`${name}.mjs 含禁用写法`);
  chunks.push(
    "// ---- ccgui-plugin-shared/" + name + ".mjs ----\n" + stripExports(src).trim() + "\n",
  );
}

const body = chunks.join("\n");

// 用函数形式替换：字符串替换值会把 $&、$' 当成特殊模式。
// 连标记一起替换掉，产物里不留内联注释（标记本身没有运行时意义）。
const splice =
  head.slice(0, startAt) +
  "// ---- 以下由 ccgui-plugin-shared 内联生成 ----\n" +
  body +
  head.slice(endAt + END.length);
fs.writeFileSync(path.join(ROOT, "main.js"), splice, "utf8");

// 自检：内联内容必须与源文件逐字一致（去掉 export 前缀与兄弟 import 之后）。
// 这里必须和上面的内联走同一套变换，否则带 import 的库永远校验不过。
const written = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
for (const name of LIB_ORDER) {
  const src = stripExports(stripLocalImports(readLib(name), name)).trim();
  if (!written.includes(src)) throw new Error(`内联校验失败：${name}.mjs 与产物不一致`);
}
if (written.includes("__LIB_SOURCE__")) throw new Error("产物里残留内联标记");

// 顶层重名自检：库文件和 main.head.js 会被拼进同一个作用域，重名不是
// 「后一个覆盖前一个」而是整个模块语法错误（宿主导入即失败）。
// 这里只扫顶层声明，函数体内不受影响。
const topLevel = /^(?:export\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm;
const seen = new Map();
let m2;
while ((m2 = topLevel.exec(written))) {
  const name = m2[1];
  const line = written.slice(0, m2.index).split("\n").length;
  if (seen.has(name)) throw new Error(`顶层标识符重名：${name}（第 ${seen.get(name)} 行与第 ${line} 行）`);
  seen.set(name, line);
}

process.stdout.write("main.js " + Buffer.byteLength(splice) + " bytes\n");
