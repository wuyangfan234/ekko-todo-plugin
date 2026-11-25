# 0.9.43 实测记录：大总管上下文胶囊、手动压缩、斜杠命令面板

时间线：本文前半（「环境」到「复现」）记录的是首版 `0864980` 的实测；「第一轮返工」（`dc276d5`）和「第二轮返工」两节记录之后的变化。首版里与现行代码不同的行为已在原处标注「返工前」。

## 环境

- 宿主：本机 Hermes Web UI 0.8.31（`http://127.0.0.1:8648`），Profile `default`。
- 浏览器：Google Chrome for Testing 145.0.7632.6，headless，Playwright 同步 API。1440×900（DPR 1，鼠标）与 390×844（DPR 2，`has_touch`/`is_mobile`）；插件 iframe 实测内宽 1371 与 390。
- 主题：亮色为宿主当前设置；暗色由顶层窗口 init script 给 `<html>` 加 `dark` 类，宿主主题桥下发真实暗色变量，iframe `data-scheme=dark`（实测）。
- 插件页：真实 Studio 页面 + 真实数据，客户端包用路由把 `/api/studio/plugins/ekko-todo/client` 的 `source` 换成本分支 `dist/client.mjs`。运行中的服务端仍是 dev 主仓的 0.9.42，所以：`get-topic-context` 在页内按真实宿主值 mock（`GET /api/studio/sessions/<id>` 得 `source: cli`，`context-length` 得 1000000）；`begin-topic-compress` / `record-topic-command` 被只读拦截挡下，只记录入参。服务端三个 RPC 由 `tests/v0943-chief-context-compress.test.mjs` 覆盖。
- 话题：`topic-e3d34738`（大总管会话 `7e71cf1e-…`，空闲）。

## 疑点 1：命令通道是否被宿主分发（真实宿主）

| 路径 | 结果 |
| --- | --- |
| 真实插件页输入 `/status` 回车（页面实时句柄 `run`） | 0.27 s 收到 `session.command`；`record-topic-command` 入参 message = `Status: idle, source: cli, profile: default, model: deepseek/deepseek-v4.1-flash-ultrafast, queue: 0, run: -, bridge: idle`；没有起模型回合（无运行条），输入框清空 |
| 同上 `/context` | 1.81 s 收到；message = `Context: input 12650, output 764202, total 776852 / 1000000 tokens (77.7%).`；（返工前，`0864980`）胶囊从 53% 更新为 78%。第一轮返工起 `/context` 只用于探测和自检，不再改胶囊 |
| 临时 Hermes 会话（`agent: hermes`，source `cli`），插件自己的 `createCommandRunner` + `runManualCompress` 直连 `/chat-run` | 事件序列 `session.command:status → session.command:context → compression.started → compression.completed → session.command:compress`；流程走完 probe→lock→/compress→record；空会话 `compressed: false`，文案 `上下文没有可压缩的内容，宿主未改动`；会话已删除 |
| 临时默认会话（未指定 agent，source `builtin_agent`） | 宿主走 Ekko 命令路径，`/compress` 的 action 是 `compact`，`/status` 回 `Ekko: idle. Queue: 0.`。据此把 `builtin_agent` 判为 `unknown`（先探测），runner 把 `compact` 视同 `compress` |

结论：大总管会话（source `cli`）的命令由宿主分发，回包走 `session.command`；不需要改用别的通道。没有在用户的大总管会话上执行 `/compress`。

## 疑点 2：是否影响卡片会话

页面命令只发给 App 实时订阅的 `activeTopic.chiefSessionId`（`src/client/App.jsx` 的 connect effect → `use-chief-context.js` 的 `attach(sid, h)`）；`chief-commands.js` / `use-chief-context.js` 不出现 `buildSessionId` / `reviewSessionId`（测试断言）。宿主 `/compress` 只处理收到命令的那个 `session_id`。服务端锁只挡该话题的大总管回合（发送、唤醒、排队投递、立即执行），不碰 todo 的构建与审查。

## 界面测量（`measure-*.json`，首版 `0864980`）

| 档 | 胶囊 | 压缩按钮 | 话题标题 span scroll/client | 模型名 scroll/client | 工具栏按钮重叠 | 页面横溢 |
| --- | --- | --- | --- | --- | --- | --- |
| 1440 亮 / 暗 | 68×32，`53%` | 28×28 | 128/128 | 181/114 | 0 | 0 |
| 390 亮 / 暗 | 60×40，按钮内 `53%` | 60×40 | 128/128 | 181/160 | 0 | 0 |
| 修前 1440 亮（线上 0.9.42 包） | — | — | 128/128 | 181/114 | — | 0 |
| 修前 390 暗 | — | — | 128/128 | 181/160 | — | 0 |

第一版把胶囊放在对话头部，1440 下话题标题被挤到 8 px、390 下 79/128 px；改放到输入框工具栏后标题和模型名宽度与修前一致（上表）。

斜杠面板：`/` 打开 10 条命令，@ 选择卡同时为关；行高 1440 为 35 px、390 为 40 px；面板整块在视口内，三处 `elementFromPoint` 都落在面板内，底色不透明（`rgb(255,255,255)` / `rgb(42,42,42)`）。`/pl`：面板显示 `/pl 是 Hermes Agent 专有命令，大总管会话未开放`，回车后输入框仍是 `/pl`（未发送），Esc 关闭面板。随后输入 `看 @`：@ 选择卡打开、斜杠面板关闭。

确认弹窗：四档整块在视口内；按钮高 34（桌面）/ 40（手机）；点取消后关闭，未发送 `/compress`。

被拦截的写 RPC：只有 2 次 `record-topic-command`（/status、/context 的结果），无其它写入。控制台错误 0。

## 截图（不入仓，存 `~/.hermes/workspace/ekko-todo-evidence/0.9.43/`）

- `header-{1440,390}-{light,dark}.png`：落地后整页，胶囊在发送键左侧。
- `slash-{1440,390}-{light,dark}.png`：斜杠面板。
- `confirm-{1440,390}-{light,dark}.png`：压缩确认弹窗。
- `after-cmds-1440-light.png`：/status、/context 之后。

## 复现

```
/usr/bin/python3 live.py 1440 900 light cmds   # 只有这一档会真的发 /status、/context
/usr/bin/python3 live.py 1440 900 dark
/usr/bin/python3 live.py 390 844 light
/usr/bin/python3 live.py 390 844 dark
OLD=1 /usr/bin/python3 live.py 1440 900 light  # 修前（不替换客户端包）
node runner-e2e.mjs                            # 临时 Hermes 会话上的 /status + 完整压缩流程
node compress-probe.mjs                        # 临时 builtin_agent 会话的事件形状
```

脚本与本文件同在上面的证据目录。

## 第一轮返工

- 胶囊改为只用宿主 `contextTokens`；阈值取宿主 `compression.threshold`。返工后实测见下方「返工复测」。
- 新测试 `tests/v0943-rework1-compress-safety.test.mjs` 在 0864980 上 9/9 失败（日志 `rework1-red-0864980.log`），修复后 9/9 通过。

## 返工复测（真实宿主 + 本分支客户端包，1440 亮、390 暗）

- 宿主 `GET /api/hermes/config?section=compression` 实测只返回 `compression` 一段：`enabled: true, threshold: 0.65`。
- 胶囊：`上下文 55.6万 / 100万 (55.6%)`，窄栏显示 `56%`，悬停提示 `宿主在约 65万（65%）时自动压缩`；级别 ok（未到 58.5万）。
- `/cl` 面板行：`/clear 清空当前显示（宿主历史保留）`；`/clear` 回车弹窗：`清空当前显示？ 只清空宿主当前显示的对话；数据库历史保留，大总管仍记得之前的对话。 插件的聊天记录和任务卡片保留不动。 取消 清空显示`，点取消，未发送。
- 标题 128/128、工具栏按钮重叠 0、横溢 0、@ 选择卡正常、`/pl` 回车不发送、控制台错误 0。截图 `rework1-clear-1440-light.png`、`rework1-clear-390-dark.png` 拍的是 `/cl` 命令面板（不是确认弹窗）；确认弹窗在第二轮返工补拍：`rework2-clear-dialog-*.png`。

## 第二轮返工（真实宿主，1440 亮、390 暗，同一脚本对比 dc276d5 的客户端包）

| 操作 | dc276d5 | 本轮 |
| --- | --- | --- |
| 输入 `/co`，真实点击工具栏 @ | 斜杠面板与 @ 选择卡同时打开，草稿 `/co @` | 斜杠面板关闭，只开 @ 选择卡，草稿 `/co @` |
| 接着回车 | 草稿被改成 `/context`，@ 选择卡仍开着 | 插入 `@大总管 `，草稿 `/co @大总管 `，两个面板都关闭 |
| 输入 `/co`，按 Home 把光标移到开头，回车 | 草稿变成 `/context/co` | 什么都不插入，面板关闭，草稿仍是 `/co` |

- 两档表现一致；控制台错误 0；被拦截的写 RPC 0。
- `/clear` 确认弹窗：`清空当前显示？ 只清空宿主当前显示的对话；数据库历史保留，大总管仍记得之前的对话。 插件的聊天记录和任务卡片保留不动。 取消 清空显示`（`rework2-clear-dialog-{1440-light,390-dark}.png`）；`/cl` 面板行 `/clear 清空当前显示（宿主历史保留）`（`rework2-clear-panel-*.png`）。
- 点击 @ 之后的截图：`rework2-at-button-{1440-light,390-dark}.png`（本轮）、`rework2-at-button-1440-light-dc276d5.png`（修前，两层叠在一起）。
- 胶囊数字随会话增长（58%），标题 128/128、工具栏重叠 0。
- `run.completed` 的 `contextTokens`、探测超时不再禁用按钮，这两项只有单测（`tests/v0943-rework2-panels.test.mjs`），浏览器里没有构造慢宿主。

## 未测

- 有实际内容的会话上的压缩前后 tokens（需要真实模型回合与 LLM 摘要；用户的大总管会话不做实验）。
- 120 秒超时与自检分支只在单测里用假定时器覆盖。
- 真机 iOS、软键盘、输入法组字下的 `/` 触发。
- 服务端三个 RPC 在运行中的 Studio 上（需要合并后 dev 重载）；目前是单测 + 直接 handler 调用。
