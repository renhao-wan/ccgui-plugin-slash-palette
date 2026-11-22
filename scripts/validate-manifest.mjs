#!/usr/bin/env node
// 斜杠命令面板的插件自检。
// 通用规则（manifest 形状、权限白名单、产物黑名单、权限↔用法一致性、展示素材、
// 版本一致）在 ccgui-plugin-shared/validate-core 里，四插件共用一份；这里只放
// 本插件特有的检查。
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validatePlugin } from "ccgui-plugin-shared/validate-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

// 构建时要从包里读的入口。缺任何一个 build.mjs 都会失败，但那就得等到
// 跑构建才知道；这里先报出来。本插件不渲染 Markdown，所以不含 markdown。
const SHARED_ENTRIES = ["feedback", "feedback-net", "feedback-ui"];

const result = validatePlugin({
  root: ROOT,
  extraRules({ fail }) {
    for (const name of SHARED_ENTRIES) {
      try {
        require.resolve("ccgui-plugin-shared/" + name);
      } catch {
        fail(`读不到共用库 ccgui-plugin-shared/${name}：先跑 npm install`);
      }
    }
  },
});

process.exit(result.code);
