#!/usr/bin/env node
// 斜杠命令面板的插件自检。
// 通用规则在 ccgui-plugin-shared/validate-core 里，六插件共用一份。
// 库清单读 plugin.libs.mjs，与 build.mjs 是同一份。
import { runValidateCli } from "ccgui-plugin-shared/validate-core";

runValidateCli(import.meta.url, {
  libSpec: "plugin.libs.mjs",
  required: ["src/main.head.js"],
}).then((r) => process.exit(r.code));
