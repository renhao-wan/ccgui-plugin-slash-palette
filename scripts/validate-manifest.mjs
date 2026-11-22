#!/usr/bin/env node
// 斜杠命令面板的插件自检。
// 通用规则（manifest 形状、权限白名单、产物黑名单、权限↔用法一致性、展示素材、
// 版本一致）在 scripts/validate-core.mjs 里，四插件共用一份；这里只放本插件
// 特有的检查。
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validatePlugin } from "./validate-core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 这个插件没有构建步骤，main.js 是手写的唯一产物：
// 纯函数与网络层与基准的逐字一致性由 scripts/check-feedback-sync.mjs 负责，
// 这里不必再查源文件是否存在。
const result = validatePlugin({ root: ROOT });

process.exit(result.code);
