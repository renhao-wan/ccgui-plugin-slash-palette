# 斜杠命令面板（CC GUI 插件）

在 CC GUI 输入框状态行加一个「/ 命令」按钮：点开后搜索本机 Claude Code 的插件命令、技能与用户命令，回车即把 `/命令 ` 写进输入框。

## 为什么不是「输入 / 时自动补全」

CC GUI 插件 SDK（0.3.x）的 composer 能力只有 `ctx.composer.setDraft(text)`：

- 没有读取输入框内容的接口；
- 没有键盘事件监听；
- 没有注册补全 provider 的扩展点。

因此插件无法感知你正在输入 `/`，也无法在输入框内原地弹出候选。真正的内联补全会涉及输入框内部状态，只能由宿主（CC GUI）实现。本插件的定位是「选命令」而不是「补全」：点按钮 → 搜索 → 写入。

## 功能

- 状态行「/ 命令」按钮，点击打开居中面板；CC GUI 命令面板搜「斜杠」也能唤起。
- 搜索命令名或 frontmatter 里的 `description`。
- 键盘 `↑` `↓` 选择、`Enter` 写入、`Esc` 关闭；鼠标同样可用。
- 按来源分组，可在设置页逐项开关。
- 扫描结果缓存 10 分钟，过期后台重扫；扫描失败保留旧缓存。

## 命令来源

| 来源 | 路径 | 调用名 |
|---|---|---|
| 插件命令 | `~/.claude/plugins/cache/*/*/*/commands/**/*.md` | `/插件名:命令名` |
| 插件技能 | `~/.claude/plugins/cache/*/*/*/skills/*/SKILL.md` | `/插件名:技能名` |
| 用户命令 | `~/.claude/commands/**/*.md` | `/命令名` |
| 用户技能 | `~/.claude/skills/*/SKILL.md` | `/技能名` |
| 项目命令（默认关闭） | `<工作区>/.claude/commands/**/*.md` | `/命令名` |
| 项目技能（默认关闭） | `<工作区>/.claude/skills/*/SKILL.md` | `/技能名` |
| 内置命令（默认关闭） | 插件内置 | `/help` 等 |

同一插件在缓存里存在多个版本目录时，只取最近写入的那一个。

## 已知限制

1. **写入是替换**：`setDraft` 会整体替换当前会话的草稿。面板底部常驻提示，避免误覆盖。
2. **不会自动发送**：写入后仍需你自己按发送。
3. **弹层是居中浮层**：SDK 不暴露输入框坐标，插件也不能读宿主 DOM，无法做成紧贴输入框的下拉。
4. **Windows 专用**：扫描走 `exec:powershell`。macOS / Linux 需要另加 `exec:sh` 与第二套脚本，当前版本未实现。
5. **项目级路径不确定**：`ctx.workspace.getMetadata()` 的返回形状在 SDK 文档里没有展开，插件按 `path` / `workspacePath` / `rootPath` 多字段尝试，再降级到侧栏工作区列表；都拿不到就跳过项目级扫描，设置页会显示实际解析结果。

## 权限

| 权限 | 用途 |
|---|---|
| `ui:composer-status` | 状态行按钮 |
| `ui:overlay` | 居中弹层 |
| `ui:command` | CC GUI 命令面板入口 |
| `ui:settings-section` | 设置页 |
| `composer:draft` | 写入草稿 |
| `exec:powershell` | 列目录、读 frontmatter |
| `storage` | 缓存命令列表与设置 |
| `host:workspace` | 降级读取侧栏工作区路径 |
| `workspace.metadata.read` | 读取当前工作区元数据 |

`exec:powershell` 只执行插件内置的只读扫描脚本：列目录、读命令文件的 frontmatter，不写入、不联网。

## 安装与迭代

1. CC GUI 侧边栏「插件」→「从本地目录安装」→ 选择本仓库根目录（含 `manifest.json` 的那一层）。
2. 改完 `main.js` 重新执行一次安装即可热重载，不需要重启应用。
3. 卸载在插件页操作；插件数据保留 30 天。

## 本地自检

```bash
node scripts/validate-manifest.mjs   # manifest、权限、黑名单、产物大小
node scripts/smoke.mjs               # 真实调用 PowerShell，验证扫描与写入
```

## 发布

推送与 `manifest.json` 的 `version` 相同的 tag（无 `v` 前缀也可）触发 GitHub Actions：

```bash
git tag 1.0.0
git push origin 1.0.0
```

流水线会校验 manifest、比对 tag、生成 `checksums.txt`，并把 `main.js`、`manifest.json`、`checksums.txt` 附到 Release。

## 许可

MIT
