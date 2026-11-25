# 0.9.44 实测记录：话题「改挂项目」入口与新建话题的项目默认值

## 环境

- 宿主：本机 Hermes Web UI（`http://127.0.0.1:8648`），Profile `default`。
- 浏览器：Google Chrome for Testing（headless，Playwright 同步 API）。1440×900（DPR 1，亮色）与 390×844（DPR 2，`has_touch`/`is_mobile`，暗色）。
- 插件页：真实 Studio 页面 + 真实数据，客户端包用路由把 `/api/studio/plugins/ekko-todo/client` 的 `source` 换成本分支 `dist/client.mjs`（提交 `894e29c`）。运行中的服务端仍是 dev 主仓的 0.9.43。
- 只读：页面里除读取类 RPC 外全部拦截，只记录入参；没有任何话题被改挂，也没有新建话题。
- 话题：`topic-e3d34738`（「Ekko ToDo 三线改造」，当前 `project_id = proj-21bc1b92`，是另一个项目，下文记作「项目 A」）。

## 结果

| 项 | 1440 亮 | 390 暗 |
| --- | --- | --- |
| 话题菜单条目 | 重命名话题 / 置顶话题 / 复制链接 / 改挂项目 / 归档话题 / 删除话题 | 同左 |
| 菜单行高、文字截断、是否在视口内 | 42 px ×6、0 处截断、在视口内 | 42 px ×6、0 处截断、在视口内 |
| 点「改挂项目」后 | 菜单关闭，弹窗打开 | 同左 |
| 弹窗「当前」一行 | `话题「Ekko ToDo 三线改造」当前：<项目 A 的名称>` | 同左 |
| 下拉第一项 | `不归属项目（可跨项目使用）`（value 为空串），其后是全部项目 | 同左 |
| 未改动时「保存」 | 禁用 | 禁用 |
| 弹窗位置 | 480×329，整块在视口内 | 367×350，整块在视口内 |
| 保存按钮高 | 34 px | 40 px |
| 页面横向溢出 | 0 | 0 |
| 选「不归属项目」后点保存 | 弹窗关闭；被拦截的调用 `update-topic` 入参 `{ topicId: "topic-e3d34738", projectId: "" }` | 同左 |
| 在对话页点「新建 → 新话题」 | 被拦截的调用 `create-topic` 入参 `{ projectId: "", autopilot: true }`（修前这里是项目列表第一个或当前话题的项目） | 同左 |
| 控制台错误 | 0 | 0 |

被拦截的写 RPC 只有上面两次（`update-topic`、`create-topic`）。

## 未在界面实测

- 真正执行改挂（写入）：服务端由 `tests/v0944-caller-topic-resolution.test.mjs` 的 `update-topic moves a topic to a project…` 覆盖。
- 在项目页里新建话题会带上该项目：由源码断言覆盖，未在界面点测。
- 建卡落点（活跃总管运行推断、跨项目兜底）是服务端逻辑，由同一测试文件覆盖；运行中的服务端是 0.9.43，没有在真实大总管会话上建探针卡。

## 截图与脚本（不入仓，存 `~/.hermes/workspace/ekko-todo-evidence/0.9.44/`）

`menu-1440-light.png`、`dialog-1440-light.png`、`dialog-detach-1440-light.png`、`menu-390-dark.png`、`dialog-390-dark.png`、`dialog-detach-390-dark.png`、`measure-1440-light.json`、`measure-390-dark.json`、`live33.py`。
