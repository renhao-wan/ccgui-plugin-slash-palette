#!/usr/bin/env node
/**
 * 把 plugin.libs.mjs 声明的库内联进 src/main.head.js，产出单文件 main.js。
 * 库清单与 validate-manifest.mjs 共用同一份，不会漂开。
 *
 * 骨架在 ccgui-plugin-shared/build-lib 里，六插件共用一份。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlugin } from "ccgui-plugin-shared/build-lib";
import spec from "../plugin.libs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { bytes } = buildPlugin({ root: ROOT, libs: spec });
process.stdout.write("main.js " + bytes + " bytes\n");
