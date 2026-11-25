# 在 Ekko Studio 里装上 Ekko ToDo

Ekko ToDo 是 Ekko Studio（`hermes-web-ui`）的插件，不是独立网站。装它只要在 Studio 的「插件中心」里粘贴本仓库的 GitHub 链接，Studio 自己取最新提交装到本机——编好的 `dist/` 就在仓库里，你不需要 `npm install`，不需要构建。

下面的步骤、界面文字和报错原文，都在一台全新的 Studio 0.8.30 上实际走过；没有走过的地方会单独注明。括号里是 Studio 英文界面下的同一个按钮。安装链路本身我在本机按 Studio 的同一套命令实测过：`npm install --prefix <空目录> --ignore-scripts --omit=dev -- github:owner/repo#<提交>` 能把仓库装成一个可加载的插件包，`dist/server.mjs` 无第三方依赖也能 `import` 成功并导出 `apply`。

## 需要什么

| 条件 | 怎么确认 |
| --- | --- |
| 一台正在运行 Ekko Studio 的机器。本插件只在 **0.8.30** 上实测过 | 点左下角头像，菜单底部写着 `Studio v0.8.30` |
| Studio 的**超级管理员**账号。安装和启用只有超级管理员能做，装好以后所有账号都能用 | 普通账号的插件中心里没有「安装插件」按钮 |
| 运行 Studio 的 Node.js 不低于 **22.13.0**（插件用到内置的 `node:sqlite`） | 浏览器打开 `http://<Studio 地址>/health`，看 `node_version` |
| Studio 所在机器装有 Git 2.25 或更高（派工时每个任务在独立的 `git worktree` 里执行） | 在那台机器上运行 `git --version` |
| Studio 的「Agent 管理」里至少有一个引擎显示「已安装」，并且能正常对话 | 先在 Studio 自己的单聊里发一句话试试 |

可选：GitHub CLI（`gh`）。装了可以在插件里浏览自己的仓库；不装也能用仓库地址或本地目录添加项目。

插件声明的 Studio 权限：`ui`、`api.read`、`api.write`、`tools`、`events`、`automation`。这些只限制它能调用哪些 Studio 接口，不是沙箱：插件后端和 Studio 用同一个系统账号运行。只安装你信得过来源的副本。

## 安装

1. 打开 Studio，左侧导航点「插件中心」（Plugins），再点右上的「安装插件」（Install plugin）。
2. 在输入框里粘贴仓库链接：`https://github.com/wuyangfan234/ekko-todo-plugin`，勾选「我信任此插件。后端代码使用 Studio 的操作系统访问权限。」，点「安装」（Install）。
   - 链接要**正好到仓库这一层**。带 `/tree/main`、`/blob/…` 或任何子路径的地址会被拒，报 `Use a GitHub repository URL (https://github.com/owner/repo), an absolute directory, …`。
   - Studio 会先问 GitHub 要该仓库最新提交的完整 SHA，再按这个 SHA 安装。所以「装到的就是那个提交」，不会因为仓库后来又提交而变。
   - 装的过程中 Studio 会在本机跑一次 npm 安装（只装运行时依赖），几十秒内结束。不要断网，也不要在中途重启 Studio。
   - 成功后列表里出现一张卡片：`Ekko ToDo · 本地版本 · 已禁用 · v<版本号>`。新装的插件默认是禁用的。
3. 点卡片上的「启用」（Enable），在确认框里再点一次「启用」。
   - 卡片状态变成「运行中」（Active），按钮变成「打开」。
4. 点「打开」（Open）。

**没有网络、或者你想用自己改过的副本**：同一个输入框也接受本机绝对目录（下文写作 `/absolute/path/to/ekko-todo`）。把仓库拷到**运行 Studio 的那台机器**上，目录第一层要有 `plugin.json`、`package.json` 和 `dist/`，然后填这个绝对路径。注意几点：填的是目录不是 ZIP；路径必须是 Studio 那台机器上的，不是你浏览器所在电脑的；Studio 跑在 NAS 或另一台机器上时尤其容易填错。

## 第一眼应该看到什么

地址栏是 `/#/studio/plugins/ekko-todo/chief`，页面分三栏：

- 左栏：「新建」按钮、「项目 0」、「话题 0 · 暂无话题」，下面是「用量与配额」「定时任务」「运行记录」「Agent」「配置中心」。
- 中间：Ekko ToDo 欢迎卡，写着「添加项目后，直接告诉大总管你的目标。」，带「从 GitHub 导入」「添加本地项目」两个按钮。
- 右栏：看板四列「待开始 / 执行中 / 待你处理 / 已完成」，都是「暂无任务」。
- 最上层弹出「欢迎使用 Ekko ToDo」向导，三步：选择主力大总管、选择协作场景、连接项目（可选）。可以点「跳过引导，以后再说」。

Studio 是深色时，插件也是深色。

## 把入口固定到左侧导航

Studio 的规则是：插件装好后**不会**自动出现在左侧导航，需要每个账号自己加一次。

1. 点左下角头像，选「导航栏设置」（Navigation settings）。
2. 在「添加入口」下面找到 Ekko ToDo，点「+ 添加」。底部显示「所有更改已保存」，不用再点保存。
3. 关掉弹窗，左侧导航多了一个 Ekko ToDo 图标，点它就进插件。

不固定也能用：插件中心的卡片上点「打开」，或直接访问 `/#/studio/plugins/ekko-todo/chief`。

插件的设置在 Studio「设置」的侧栏里也有一项「Ekko ToDo」（地址 `/#/studio/plugin-settings/ekko-todo/settings`），和插件页面里的「配置中心」是同一份配置。

## 第一次用

1. 在向导里选一个 Studio 已安装的引擎当大总管，或者先跳过。
2. 加一个项目：左栏点「导入 GitHub / 本地项目」，切到「本地 Git 仓库」，点「浏览」。这里弹出的是 Studio 自己的目录选择器，选一个已有的 Git 仓库。
3. 在中间的输入框里直接写目标，回车发送。大总管会把它拆成任务放进右边的看板。

## 它和 Studio 的哪些功能是通的

| 你想做的事 | 在哪里做 | 说明 |
| --- | --- | --- |
| 进入插件 | 左侧导航（固定后）、插件中心卡片「打开」 | 见上一节 |
| 改插件设置 | Studio「设置」→「Ekko ToDo」，或插件里的「配置中心」 | 同一份配置 |
| 选模型 | 插件里配置大总管或 Agent 的模型时 | 弹出的是 Studio 的模型选择器；模型凭证留在 Studio，插件拿不到 |
| 选目录 | 添加项目、设置默认克隆目录时点「浏览」 | 弹出的是 Studio 的目录选择器，收藏和最近记录与 Studio 共用 |
| 看对话记录 | Studio 自己的会话列表 | 大总管、构建、审查都是真正的 Studio 会话，标题以 `[Ekko ToDo]` 开头 |
| 传文件给大总管 | 输入框的「上传文件（最大 50MB）」，或把文件拖进输入框 | 文件存进 Studio 的上传目录 |
| 在普通 Studio 对话里用看板 | 任意 Studio 对话，直接让 Agent「列出 Ekko ToDo 的任务」「建一张任务」 | 启用后 Studio 的 Agent 多出一个名为 `ekko-todo` 的 MCP 服务，共 32 个工具（`list_todos`、`create_todo`、`run_build` 等） |
| 明暗主题 | 跟随 Studio | 不需要在插件里再设 |
| 提示消息 | Studio 自己的提示条 | 插件不另做一套 |

## 做不到的事

- 不会自动出现在左侧导航。这是 Studio 的规则，只能按上面的步骤手动添加。
- 界面只有简体中文。Studio 切成其他语言时，插件的名称、描述和页面仍然是中文。
- 不能在 Studio 对话的输入框里用斜杠命令呼出，也不会出现在 Studio 的 Agent 列表里。它提供的是页面和工具，不是一个可以直接聊天的 Agent。
- Token 用量只对 Hermes 引擎的会话是完整的。Studio 没有向插件公开用量接口，插件读的是 Hermes 引擎在本机的会话账本；其他引擎只有插件自己记到的部分。
- 上传用的是 Studio 的上传接口，这个接口不在插件 SDK 的公开清单里。Studio 升级后如果它变了，大文件上传可能失败，小文件会改走插件自己的通道。
- 不会自动升级，也没有上架插件市场。新版本要按下面「升级」一节手动换。
- 手机 App 里没有验证过。

## 排查：没看到界面时先看这里

先分清是哪一种，再看对应那一行。报错原文是 Studio 给的，原样照抄。

| 你看到的 | 原因 | 怎么办 |
| --- | --- | --- |
| 插件中心里没有「安装插件」按钮 | 当前账号不是超级管理员。直接调接口会得到 `Installing executable plugins requires a super administrator login` | 换超级管理员账号登录 |
| `API Error 500: ENOENT: no such file or directory, realpath '<你填的路径>'` | 这个路径在 Studio 那台机器上不存在。最常见的是填了自己电脑上的路径 | 把目录放到 Studio 所在机器，填那台机器上的绝对路径 |
| `API Error 500: ENOENT: … realpath '<你填的路径>/package.json'` | 目录指错了一层：指到了上一级，或者指到了 `src` 之类的子目录 | 填第一层就有 `plugin.json` 的那个目录 |
| `API Error 400: Local plugin source must be a directory` | 填的是 ZIP 文件 | 先解压，填解压出来的目录 |
| `API Error 400: Use a GitHub repository URL (https://github.com/owner/repo), an absolute directory, package@exact-version or a supported repository pinned to a full commit` | 输入的不是这三样之一：常见的是链接带了子路径（`/tree/main`、`/blob/…`），或者目录没从根写起 | 链接用正好到仓库这一层的，例如 `https://github.com/wuyangfan234/ekko-todo-plugin`；目录从 `/` 开始 |
| `API Error 409: Plugin already installed; use Update` | 已经装过，又走了一次「安装插件」 | 按下面「升级」一节操作 |
| 卡片显示「已禁用」；或打开插件页看到「此插件已禁用，请在插件中心启用。」 | 装了但没启用 | 回插件中心，点卡片上的「启用」 |
| 打开插件页看到「此页面不可用，请检查插件状态或页面地址。」 | 还没安装，或地址写错了 | 确认插件中心里有 Ekko ToDo 卡片；地址应为 `/#/studio/plugins/ekko-todo/chief` |
| 左侧导航里找不到 Ekko ToDo | 没有手动添加，或者当前账号没加过（按账号保存） | 见「把入口固定到左侧导航」 |
| 发出第一条消息后，对话顶部出现「大总管没有启动：Studio 里这个引擎的运行时还没有装好…」 | 大总管选的引擎在 Studio 里不可用 | 到 Studio「Agent 管理」安装或修复该引擎，或在插件「Agent」页把大总管换成已安装的引擎，再发一次 |

下面几种情况没有在实机上复现过，写的是 Studio 0.8.30 安装器里对应的报错和判断方法：

| 你看到的 | 原因 | 怎么办 |
| --- | --- | --- |
| `API Error 422: Unable to resolve GitHub repository; check network access and try again` | Studio 那台机器问 GitHub 要不到这个仓库的最新提交：仓库是私有的、地址拼错、或机器连不上 `api.github.com` | 确认仓库是公开的；确认那台机器能访问 `api.github.com`；也可以改用本机绝对目录安装 |
| `API Error 422: GitHub repository has no commits to install` | 仓库是空的 | 先往里推一次提交 |
| `API Error 422: GitHub did not return a valid commit; try again later or use a local plugin directory` | GitHub 返回了但拿不到提交 SHA，通常是限流 | 过一会儿重试，或改用本机绝对目录 |
| `API Error 422: Package installation failed; check the package version, network and npm access` | 安装器在跑 npm 那一步失败：机器连不上 npm 源，或仓库里的 `package.json` 不完整 | 在 Studio 那台机器上手动跑一次 `npm install` 看真实报错；企业网络需要给 npm 配代理 |
| `Package and plugin versions must match` | 目录里 `package.json` 和 `plugin.json` 的版本不一致，通常是拿到的副本被改过或不完整 | 重新取一份完整的仓库副本 |
| 卡片显示「失败」 | 插件后端没能启动 | 点卡片「详情」→「开发与维护」→「日志」看第一条报错。如果提到 `node:sqlite`，说明 Studio 的 Node.js 低于 22.13.0 |
| 头像菜单里没有「导航栏设置」，或插件中心长得和本文不一样 | Studio 版本和实测版本不同 | 看头像菜单底部的版本号；本文只对 0.8.30 负责 |

## 升级

已安装的插件不要再走一遍「安装插件」，Studio 会回 `Plugin already installed; use Update`。走卡片上的升级：

1. 插件中心里点 Ekko ToDo 卡片的「详情」，切到「开发与维护」。
2. 在输入框里粘贴**同一个仓库链接**，勾选信任，点「升级」（Update）。
   - Studio 会重新问 GitHub 要最新提交，装上新版本，并把旧版本留成回滚点。
   - 想让升级停在某个具体提交上，就把链接换成带完整 SHA 的形式：`github:owner/repo#<40 位 SHA>`。
3. 版本号变成新的，状态仍是「运行中」。同一处会出现「回滚 <旧版本号>」按钮，新版有问题可以退回去。

如果当前 Studio 版本详情页里没有这一步，等价做法是：先「卸载」（Studio 会保留插件数据），再按上面「安装」一节重新粘贴链接。项目、话题、任务、Agent 配置都在。

升级不动插件数据：项目、话题、任务、Agent 配置都还在。

## 停用与卸载

- 停用：详情页点「禁用」。插件页面不可用，左侧导航里的入口暂时隐藏；重新启用后入口自己回来。
- 卸载：卡片上点「卸载」。Studio 会提示已保存的插件数据会保留。
- 插件数据（一个 SQLite 文件和各任务的工作树）放在 Studio 数据目录下的 `plugins/global/plugin-data/ekko-todo/`。Studio 数据目录默认是运行 Studio 的那个系统账号主目录里的 `.hermes-web-ui`。想彻底清掉，卸载后手动删除这个目录。
- 不要手动删 Studio 数据目录里 `plugins/global/versions/` 下的运行副本，用插件中心的「卸载」。

## 给维护者：发版与交付

仓库里已提交的文件就是完整的交付物：编好的 `dist/server.mjs` 与 `dist/client.mjs` 都入库，不含 `node_modules`。Studio 用的也是这一份——它按 GitHub 上的提交装包，`--ignore-scripts` 关掉了 `prepack`，所以**发版前必须把 `dist/` 重新构建并提交**，否则别人装到的是旧的 bundle。

测试用的 Node.js 版本线写在仓库根的 `.node-version`（现在是 `22.23`），本机开发、CI（`.github/workflows/check.yml` 读同一个文件）和插件自己的验收命令都按它来；`package.json` 的 `engines.node` 只表示运行 Studio 的进程的下限，不是测试用的版本。声明不能比 `engines.node` 的下限宽：只写 `22` 会把 `v22.5.0` 也算作符合，所以要写到次版本。跑下面的命令前先确认 `node --version` 是 `v22.23.*`；换到更新的版本线时只改这一个文件。

验收命令（项目的「测试命令」）在任务工作树里执行时，插件按工作树根目录的 `.node-version` 找对应的 `node`：先看 Studio 进程的 `PATH`，再看 Homebrew 的 `node@<主版本>` 和 nvm / Volta / fnm / asdf / mise 的常见安装目录。找到就用它，结论里写明版本，例如 `Passed (rc=0, 26.0s, node v22.23.2)`；找不到就直接判失败并写清 `期望 node v22.23.x（.node-version），当前 PATH 里找到的是 v26.12.1（…）`，不会改用别的版本。查找最多用 15 秒。没有 `.node-version` 的项目（比如 Python、Go 项目）照旧按 `PATH` 执行，结论里标 `未声明`；`.node-version` 在但读不了（是个目录、没有读权限、是断开的链接）则判失败，不执行命令。

发版检查单：

1. `npm run build` 重建 `dist/`，`git status` 只应看到预期的文件。
2. `npm run harness:check` 与 `npm test` 全绿。
3. `package.json`、`plugin.json`、`package-lock.json` 两处、`contracts/plugin.json` 描述里的版本号一致。
4. 推到公开仓的 `main`。Studio 装的是公开仓最新的那个提交。

给别人一份离线副本时也用 `git archive`：

```bash
git archive --format=zip --prefix=ekko-todo/ -o ekko-todo.zip HEAD
```

`npm test` 里有一条测试会把已提交的文件原样拷到空目录，按 Studio 安装器的规则检查并加载入口，保证这样交出去的目录能被直接装上；另一条测试会在没有 `node_modules` 的情况下 `import` 服务端入口，所以「bundle 是不是自带的」每次都会被验一遍。

改插件代码用开发链接（`ekko-studio plugins link /absolute/path/to/ekko-todo`，然后在插件中心的「开发插件」里启用），见 [CONTRIBUTING.md](./CONTRIBUTING.md) 和 [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)。只想用插件的人不需要这一步。
