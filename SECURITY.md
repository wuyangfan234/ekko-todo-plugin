# 安全策略

## 范围与承诺

- **Agent 运行的凭据不经过插件。** Ekko ToDo 不保存、不记录、不转发模型 API Key、Studio 登录令牌或会话 Cookie。所有 Agent 运行都通过 Ekko Studio 的会话接口（`ctx.host.sessions.*`）和用户自己在 Studio 里配好的运行时完成鉴权。唯一会读到提供方凭据的是下面的配额面板。
- **有两个可选功能会保存凭据，完整清单就是这两项：**
  1. **配额面板**：在插件自己的 SQLite 文件里保存各提供方**自己的**凭据，也可以复用用户本机 CLI 已有的 auth 文件（例如主目录下的认证文件），用来调用**该提供方官方的用量接口**。本机 CLI 没有登录态时，会在查询那一刻读取 Ekko Studio 自己已登录的同一提供方凭据（Hermes 主目录的 `auth.json` / `.env`），只发往该提供方官方用量接口，不写进插件数据库。
  2. **仓库导入**：可以保存一个 GitHub 个人访问令牌（PAT），用于导入和克隆仓库。

  两项都**默认关闭**，用户配置了才生效；按 `(identity.userId, identity.profile)` 隔离；只发往用户自己配置的那个端点，不会发给维护者或任何第三方。前端只拿到「是否已配置」或脱敏后的预览（`hasSecret`、`secretPreview`、`hasGithubToken`），拿不到明文。
- **身份与 Profile 隔离**：每个 RPC 和 MCP 工具都严格绑定 Studio 提供的 `run.identity.userId` 与 `run.identity.profile`。
- **仓库隔离**：构建在 `ctx.paths.dataDir/worktrees/` 下的独立 Git 工作树里执行。主仓工作区有未提交改动时拒绝合并，遇到冲突自动 `git merge --abort`。
- **部署护栏**：部署类任务（`kind: "deploy"`）完成前一律需要人工批准；验收命令没能执行的合并同样停在人工关口。

## 报告漏洞

请通过本仓库的 GitHub Security Advisories 私下报告疑似安全问题，不要开公开 issue。我们会在 72 小时内确认收到。

---

## Appendix: English


### Scope & Guarantees

- **No model or engine credentials for agent runs.** Ekko ToDo never stores, logs, or forwards model API keys, Studio bearer tokens, or session cookies. Every agent run delegates authentication to Ekko Studio (`ctx.host.sessions.*`) and to the user's own configured local runtimes.
- **Two opt-in features do persist a secret.** The quota panel stores a per-provider credential (and can reuse a credential your local CLI already has, for example the auth file under your home directory) in order to call that provider's official usage endpoint (when no local CLI login exists it reads, at query time only, the same provider's credential Ekko Studio itself is signed in with — Hermes `auth.json` / `.env` — without storing it); repository import can store a GitHub personal access token. Both stay inert until configured, are keyed by `(identity.userId, identity.profile)`, and are sent only to the endpoint the user configured. These two are the complete list of secrets this plugin persists; both live in the plugin's own SQLite file.
- **Identity & Profile Isolation**: Every RPC and MCP tool binds strictly to `run.identity.userId` and `run.identity.profile` supplied by the Ekko Studio host.
- **Repository Isolation**: Worker builds execute inside isolated Git worktrees under `ctx.paths.dataDir/worktrees/`. Merge operations refuse to proceed if the main repository working tree has uncommitted changes and automatically run `git merge --abort` on conflicts.
- **Deployment Guardrail**: Deployment todos (`kind: "deploy"`) always require explicit human approval before completion, and a merge whose acceptance command could not be run stays on the human gate as well.

### Reporting a Vulnerability

Please report suspected security issues privately through GitHub Security Advisories on this repository instead of opening a public issue. Reports are acknowledged within 72 hours.
