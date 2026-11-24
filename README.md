# Claude 斜杠命令（CC GUI 插件）

在 CC GUI 输入框状态行加一个「/ 命令」按钮：点开后搜索本机 Claude Code 的插件命令、技能与用户命令，回车即把 `/命令 ` 写进输入框。

## 适用范围

**仅支持 Claude Code。** 不扫描也不写入 Codex、OpenCode、Gemini、CodeBuddy、Cursor、Kimi、Grok、Qoder、MiniMax、OMP、DSH、AGY、Pi 等引擎的命令。

原因有两条：

1. **插件拿不到当前会话的引擎。** SDK 没有 `getCurrentEngine()`；`registerRuntimeSwitchHooks` 只能观察之后的切换事件，插件激活时无法判断当前会话用的是哪个引擎。
2. **写错引擎的命令是负收益。** `setDraft` 写入的是当前会话输入框；把 OpenCode 的命令写进 Codex 会话只会报错。

如果宿主后续开放当前引擎或补全接口，再评估扩展。

## 为什么不是「输入 / 时自动补全」

CC GUI 插件 SDK（0.3.x）的 composer 能力只有 `ctx.composer.setDraft(text)`：

- 没有读取输入框内容的接口；
- 没有键盘事件监听；
- 没有注册补全 provider 的扩展点。

因此插件无法感知你正在输入 `/`，也无法在输入框内原地弹出候选。真正的内联补全会涉及输入框内部状态，只能由宿主（CC GUI）实现。本插件的定位是「选命令」而不是「补全」：点按钮 → 搜索 → 写入。

## 功能

- 状态行「/ 命令」按钮，点击打开居中面板；CC GUI 命令面板搜「斜杠」也能唤起。
- 列出当前工作区的项目命令/技能、用户级命令/技能与已启用插件的命令/技能；项目级禁用（`enabledPlugins` / `skillOverrides`）的条目不会出现，避免插入后执行报错。
- 搜索命令名或 frontmatter 里的 `description`。
- 键盘 `↑` `↓` 选择、`Enter` 写入、`Esc` 关闭；鼠标同样可用。
- 按来源分组，可在设置页逐项开关。
- 扫描结果缓存 5 分钟：点开面板时若超过 5 分钟会自动重扫，未超时直接复用；面板底部有「刷新」按钮可随时强制重扫。扫描失败保留旧缓存，空结果不写缓存。

## 命令来源

| 来源 | 路径 | 调用名 |
|---|---|---|
| 项目命令 | `<workspace>/.claude/commands/**/*.md` | `/命令名` |
| 项目技能 | `<workspace>/.claude/skills/*/SKILL.md` | `/技能名` |
| 插件命令 | Claude Code 记录的插件安装目录（`installed_plugins.json` 的 `installPath`） | `/插件名:命令名` |
| 插件技能 | 同上 | `/插件名:技能名` |
| 用户命令 | `~/.claude/commands/**/*.md` | `/命令名` |
| 用户技能 | `~/.claude/skills/*/SKILL.md` | `/技能名` |
| 内置命令（默认关闭） | 插件内置 | `/help` 等 |

同名命令的优先级是 **项目 > 用户**；同名技能是 **个人 > 项目**（与 Claude Code 的 skills 优先级一致）。插件启用状态按 **本地 `.claude/settings.local.json` > 团队 `.claude/settings.json` > 全局 `~/.claude/settings.json`** 逐键合并 `enabledPlugins`（任一层写了 `enabledPlugins`，即使为空对象，也按清单生效）；`skillOverrides` 只作用于个人/项目技能（`off` 隐藏、`name-only` 只留名称），插件技能不受本地开关控制。被当前工作区禁用的条目会从列表里移除，状态行显示「已隐藏 N 条」。没有 `installed_plugins.json` 时回退到遍历 `plugins/cache`，同一插件有多个缓存版本时以记录的安装目录为准，其次按修改时间与版本号选择。设了 `CLAUDE_CONFIG_DIR` 时全局层跟着切换。

## 已知限制

1. **写入是替换**：`setDraft` 会整体替换当前会话的草稿。面板底部常驻提示，避免误覆盖。
2. **不会自动发送**：写入后仍需你自己按发送。
3. **弹层是居中浮层**：SDK 不暴露输入框坐标，插件也不能读宿主 DOM，无法做成紧贴输入框的下拉。
4. **Windows 专用**：扫描走 `exec:powershell`。macOS / Linux 需要另加 `exec:sh` 与第二套脚本，当前版本未实现。
5. **首次打开有扫描延迟**：缓存缺失或过期（超过 5 分钟）时，打开面板（或面板底部点「刷新」、设置页点「立即刷新」）会调用 PowerShell 扫描本机命令目录，通常 1–2 秒；之后 5 分钟内直接读缓存。
6. **不读企业 managed settings**：只合并全局、仓库共享（团队）与本地三层；企业/系统级强制配置目前不参与判断。

## 权限

| 权限 | 用途 |
|---|---|
| `ui:composer-status` | 状态行按钮 |
| `ui:overlay` | 居中弹层 |
| `ui:command` | CC GUI 命令面板入口 |
| `ui:settings-section` | 设置页 |
| `composer:draft` | 写入草稿 |
| `exec:powershell` | 列目录、读 frontmatter |
| `theme` | 通过宿主主题接口注入插件样式（老宿主回退到组件内联） |
| `storage` | 缓存命令列表与设置 |
| `workspace.metadata.read` | 读取当前会话所在工作区路径，用于扫描项目层命令与覆盖配置 |
| `network:ccgui-feedback.2653990378.workers.dev` | 「发送反馈」：把你填的那段文字转发到作者邮箱。不点就不会发 |

`exec:powershell` 只执行插件内置的只读扫描脚本：列目录、读命令文件的 frontmatter，不写入。除你主动点「发送反馈」外不发起任何网络请求——扫描本身不联网。

## 反馈

设置页底部有「反馈」一区，两种方式任选：

1. **通过 GitHub 提 Issue** —— 打开已经预填好你那段文字的 Issue 页面，
   登录状态下只差一次点击。不需要任何网络权限，永远可用。
2. **发送反馈** —— 经中转直接发到作者邮箱，不用注册、不用跳转。

**发送的内容只有**：你填的那段文字、插件版本、CC GUI 版本、时间戳。
不含会话内容、代码、文件路径或任何本机信息。请求体字段在单测里钉死了白名单
（`test/feedback.test.mjs`），多一个字段就测试失败。

额度是**每个插件每台机器滚动 48 小时 1 条**，四个插件各自独立计数；
另有一个**每台机器每天 3 条的共享兜底池**，跨插件共用，只在本插件冷却命中时才动用，
用来放过公司 / 校园 / CGNAT 这类共享出口的正常用户（另加 10 分钟 2 条突发保护）。
被冷却拦下时界面会直说规则，并提示改用 GitHub Issue——不会静默失败。

中转是作者自建的 Cloudflare Worker，凭据只存在它的 secret 里——
插件里没有任何邮件密钥，因为没有密钥可放。**中转的代码是公开的**，
上面关于隐私的每一项承诺都可以自己核对：
[ccgui-feedback-worker](https://github.com/renhao-wan/ccgui-feedback-worker)。

### 发不出去时

`workers.dev` 在国内常被 DNS 污染，邮件中转可能连不上。插件不会卡在那里，
每种失败都给出下一步：

| 情况 | 你会看到 | 还能做什么 |
|---|---|---|
| 网络/DNS 不通 | 连不上反馈服务，请检查网络或代理 | 改用 GitHub Issue |
| 请求超时 | 发送超时。中转可能被网络挡住 | 改用 GitHub Issue |
| 返回 200 但不是中转的 JSON | 反馈服务返回了无法识别的内容，可能被网络拦截 | 改用 GitHub Issue |
| 发得太快（10 分钟内第 4 条） | 发得太快了，稍等几分钟再试 | 稍候，或改用 Issue |
| 本插件 48h 内已发过、兜底也用完 | 这个插件每 48 小时只能提交 1 条反馈 | 48 小时后，或改用 Issue |
| 中转内部出错（5xx） | 中转暂时不可用，稍后再试 | 稍后重试，或改用 Issue |
| 权限没生效（旧版本升级） | 网络权限未生效，请重新安装插件 | 重新「从本地目录安装」 |

第二行这条别忽略：运营商劫持页、校园网登录门户、代理错误页**都会返回 200**。
只看状态码就会告诉你「已发送」，而你实际什么都没发出去。所以判成功要求
响应体里带 `ok: true`，不是 2xx 就算。

**GitHub Issue 那条路不依赖中转**，国内网络下基本总能走通，所以它始终在按钮旁边。

失败时**正文不会清空**，可以直接重试，不用重打一遍。发送期间继续打字也不会
被清掉——成功时只清掉「这次发出去的那段」。

额度查不到时，额度那一行会给出「重试」按钮，不用重开设置页。

## 安装与迭代

1. CC GUI 侧边栏「插件」→「从本地目录安装」→ 选择本仓库根目录（含 `manifest.json` 的那一层）。
2. 改完 `main.js` 重新执行一次安装即可热重载，不需要重启应用。
3. 卸载在插件页操作；插件数据保留 30 天。

## 本地自检

```bash
npm install                          # 共用层来自 ccgui-plugin-shared（npm 依赖）
node scripts/build.mjs               # 把共用库内联进 src/main.head.js → main.js
node scripts/validate-manifest.mjs   # manifest、权限、黑名单、产物大小
node scripts/smoke.mjs               # 真实调用 PowerShell，验证扫描与写入
```

`main.js` 是构建产物：反馈相关的纯函数、网络层与反馈区组件来自
`ccgui-plugin-shared`，改逻辑请改那个包并升版本，不要直接改产物。改了源码
忘了构建，CI 的 `git diff --exit-code main.js` 会拦住。

## 发布

推送与 `manifest.json` 的 `version` 相同的 tag（无 `v` 前缀也可）触发 GitHub Actions：

```bash
git tag 0.2.0
git push origin 0.2.0
```

流水线会校验 manifest、比对 tag、生成 `checksums.txt`，并把 `main.js`、`manifest.json`、`checksums.txt` 附到 Release。

## 许可

MIT
