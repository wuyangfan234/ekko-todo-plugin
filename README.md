# Ekko ToDo · Ekko Studio 的总管派工看板插件

<p align="center"><img src="./assets/logo.png" width="96" height="96" alt="Ekko ToDo 图标"></p>

**一句话：** 在 Ekko Studio（`hermes-web-ui`）里用说话的方式提需求，由一个「总管」拆成任务卡，派给编码 Agent 在独立的 Git 工作树里实现，再交给另一个 Agent 独立审查，最后合并——全程在一块四列看板上看得见、管得住。

> 直接装：Studio「插件中心 → 安装插件」里粘贴 `https://github.com/wuyangfan234/ekko-todo-plugin`，勾选信任，点「安装」，再点「启用」。详细步骤见下文「怎么装」与 [INSTALL.md](./INSTALL.md)。
>
> English: [README.en.md](./README.en.md)

## 它解决什么问题

让 AI 改代码，难的不是「写」，而是「管」：谁在改哪个仓、改到哪了、改坏了怎么退、改完有没有人看过。Ekko ToDo 把这几件事收进 Studio 里的一个工作台——你跟总管说需求，总管拆卡、派工、构建、审查、合并：

- **一个总管（Chief）**：每个话题对应一个总管会话。你只跟它说目标，它负责拆卡、派工、跟进、汇报。总管有常驻章程（Charter）和可折叠的话题简报（目标 / 进展 / 下一步 / 等你决定 / 受阻）。
- **多引擎编码 Agent**：每个 Agent 可配最多 8 条有序模型（1 主 + 最多 7 备），遇到限流、额度、鉴权、5xx、超时自动切到下一条；思考深度按模型实际支持的档位调。
- **隔离的 Git 工作树**：每张卡在自己的分支和 `git worktree` 里执行，不碰你主仓的工作区；差异用影子索引快照采集，失败的卡可「继续」或「从头再来」。
- **独立审查**：构建完成后由另一个 Agent 审查，给出 `APPROVED` 或 `CHANGES_REQUESTED`；审查没给结论会催一次，仍没有就停在「需人工」关口，不会自己放行。
- **四列看板**：待开始 / 执行中 / 待你处理 / 已完成。卡片可以拖进对话框引用。
- **其他**：GitHub 仓库导入（可用本机 `gh`，也可直接粘贴仓库地址）、分作用域的长期记忆（总管 / 项目 / Agent）、定时任务、运行记录回看、用量与配额面板、`⌘K` 命令面板。
- **在普通 Studio 对话里也能用**：启用后 Studio 的 Agent 多出一个名为 `ekko-todo` 的 MCP 服务，共 32 个工具（32 tools），例如 `list_todos`、`create_todo`、`run_build`、`run_review`、`merge_build`。

## 装之前需要什么

| 条件 | 说明 |
| --- | --- |
| Ekko Studio **0.8.30** | 只在这个版本（Plugin SDK `apiVersion: 1`）上实测过。其他版本没有验证过，出问题请先核对版本（头像菜单底部写着 `Studio v…`） |
| Studio **超级管理员**账号 | 只有超级管理员能安装和启用；装好之后所有账号都能用 |
| 运行 Studio 的 Node.js **≥ 22.13.0** | 插件用到 Node 内置的 `node:sqlite`。浏览器打开 `<Studio 地址>/health` 看 `node_version` |
| Studio 所在机器上的 Git **≥ 2.25** | 每张卡都用 `git worktree` 隔离执行 |
| Studio「Agent 管理」里至少一个能正常对话的引擎 | 总管本身就是一个 Studio 会话 |
| GitHub CLI（`gh`），可选 | 装了能在插件里浏览自己的仓库；不装也能粘贴仓库地址或选本地目录 |

插件声明的权限是 `ui`、`api.read`、`api.write`、`tools`、`events`、`automation`。这只限制它能调用哪些 Studio 接口，不是沙箱：插件后端和 Studio 以同一个系统账号运行。请只安装你信任的来源。

## 怎么装

1. 用超级管理员登录 Studio，左侧导航点「插件中心」（Plugins），再点「安装插件」（Install plugin）。
2. 输入框里粘贴本仓库链接：

   ```text
   https://github.com/wuyangfan234/ekko-todo-plugin
   ```

   勾选「我信任此插件……」，点「安装」（Install）。
3. 新卡片默认「已禁用」。点「启用」（Enable），确认后点「打开」（Open）。

Studio 安装器在这一步的实际行为：

- **粘贴仓库链接即可，不用填提交 hash。** Studio 自动取该仓库**默认分支的当前提交**，并把安装固定在这个完整提交上；仓库之后再有新提交，也不会悄悄改变你已装好的版本（升级走卡片上的「升级」）。
- **也支持另外三种来源**：Studio 那台机器上的**绝对目录**（从 `/` 写起、第一层就有 `plugin.json`）、npm 包的**精确版本**（`package@1.2.3` 这种写法）、以及**固定到完整提交**的仓库（如 `github:owner/repo#<40 位 SHA>`）。
- **远程包必须自带 `plugin.json` 和已构建好的入口。** 安装时 Studio 只装运行时依赖、不跑构建脚本，所以本仓库把编好的 `dist/server.mjs` 与 `dist/client.mjs` 直接提交在仓库里，你的机器上不需要构建。

把入口固定到左侧导航、升级、回滚、卸载，见 [INSTALL.md](./INSTALL.md)（中文分步说明，带每一步应该看到的界面文字）。

## 装上后第一眼看到什么

地址是 `/#/studio/plugins/ekko-todo/chief`，页面分三栏：

- **左栏**：「新建」按钮、项目与话题列表，以及「用量与配额」「定时任务」「运行记录」「Agent」「配置中心」入口。
- **中间**：总管对话区。第一次打开是欢迎卡：「添加项目后，直接告诉大总管你的目标。」
- **右栏**：四列看板，起初都是「暂无任务」。

同时弹出三步引导：选择主力大总管、选择协作场景、连接项目（可跳过）。界面明暗跟随 Studio。

## 常见问题

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| 安装时报 `API Error 400: Use a GitHub repository URL (https://github.com/owner/repo), an absolute directory, …` | **链接带了子路径**（如 `/tree/main`、`/blob/…`），或者填的**目录没从根写起**（相对路径） | 链接只写到仓库这一层：`https://github.com/wuyangfan234/ekko-todo-plugin`；目录写 Studio 那台机器上从 `/` 开始的绝对路径 |
| 插件中心没有「安装插件」按钮 | 当前账号不是超级管理员 | 换超级管理员登录 |
| 卡片显示「失败」，日志里提到 `node:sqlite` | 运行 Studio 的 Node.js 低于 22.13.0，没有内置的 `node:sqlite` | 把 Studio 的 Node.js 升到 22.13.0 或更高并重启 Studio，再启用插件 |
| `API Error 422: Unable to resolve GitHub repository; check network access and try again` | Studio 那台机器访问不到 `api.github.com`，或仓库地址拼错 | 检查网络；或把仓库拷到那台机器上，改用绝对目录安装 |
| `API Error 409: Plugin already installed; use Update` | 已经装过 | 在卡片「详情 → 开发与维护」里用「升级」 |
| 左侧导航里找不到入口 | Studio 不会自动把插件加进导航，每个账号要自己加一次 | 头像菜单 →「导航栏设置」→ 添加 Ekko ToDo |

更全的报错对照表见 [INSTALL.md](./INSTALL.md) 的「排查」一节。

## 安全与隐私

- **模型 / 引擎凭据一律不经过插件。** 所有 Agent 运行都通过 Studio 的会话接口（`ctx.host.sessions.*`）和你在 Studio 里已配好的运行时完成，插件拿不到、也不保存模型 API Key 或 Studio 登录令牌。
- **但有两个可选功能会保存凭据：**
  1. **配额面板**：在插件自己的 SQLite 文件里保存各提供方**自己的**凭据，也可以复用你本机 CLI 已有的 auth 文件（例如主目录下的认证文件），用来调用**该提供方官方的用量接口**。
  2. **仓库导入**：可以保存一个 GitHub 个人访问令牌（PAT），用于导入和克隆仓库。

  这两项**默认关闭**，你配置了才生效；按 `(userId, profile)` 隔离；只发往你自己配置的那个端点，不会发给维护者或任何第三方。前端只拿到「是否已配置」或脱敏后的预览，拿不到明文。
- 插件数据全部按 Studio 提供的 `(identity.userId, identity.profile)` 分区。
- 不改 Studio 自己的文件，也不会替你改导航设置。
- 主仓有未提交改动时拒绝合并，冲突时自动 `git merge --abort`；部署类任务必须人工批准。
- 两个 `dist/` 文件把第三方依赖编译在内，许可清单见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。
- 发现漏洞请按 [SECURITY.md](./SECURITY.md) 私下报告，不要开公开 issue。接口与存储结构见 [docs/CONTRACTS.md](./docs/CONTRACTS.md)。

## 许可与贡献

- MIT 许可，见 [LICENSE](./LICENSE)。随附的 Ekko Studio SDK 文件仍按其 MIT 许可（`sdk/LICENSE`、`sdk/NOTICE`）。
- 贡献需要签 [CLA](./CLA.md)：版权仍归你，已按 MIT 发布的版本永远按 MIT 可用。流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
- 维护者的发版与公开仓同步流程见 [RELEASING.md](./RELEASING.md)。

## 开发与验证

```bash
npm install
npm run build          # 重建 dist/server.mjs 与 dist/client.mjs
npm run harness:check  # 插件结构与契约检查
npm test               # node --test tests/*.test.mjs
```

测试用的 Node.js 版本线写在 `.node-version`（当前 `22.23`）。插件开发文档：<https://github.com/EKKOLearnAI/ekko-studio/blob/main/docs/plugins.md>。
