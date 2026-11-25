# Ekko ToDo (English)

> 中文主文见 [README.md](./README.md)。The Chinese README is the primary document; this English page is kept for reference.

An official Plugin SDK v1 extension for **Ekko Studio (`hermes-web-ui`)** that brings a unified **Chief Orchestrator + Multi-Engine Coding Agent + GitHub Import + Isolated Git Worktree Diff Review + 4-Column Kanban** workflow directly inside Studio.

## Features

- **Single-Entry Autonomous Chief with Standing Charter & Super-Admin Governance**: Talk to one Chief orchestrator per topic with zero-modal instant topic creation, automatic model-generated topic titles, collapsible **Topic Briefs** (`Goal / Progress / Next / Waiting on you / Blocked`), and a standing **Charter** layer. Empower the Chief with configurable authority to manage agents, switch primary/fallback models and thinking depth, import GitHub projects, and curate persistent memories.
- **Engineering-Grade Agent Management, Primary/Fallback Model Chains & Auto-Failover**: Configure every Agent in a clean master-detail workspace with up to **8 ordered model configurations** (1 primary + up to 7 fallbacks across engines or custom gateways) and automatic failover on rate-limit, quota, auth, 5xx, or timeout faults (with 1-hour fault cooldowns), paired with a precision Radix UI **Reasoning Effort Slider** adapting to each model's real supported effort spectrum (`default` → `ultra`).
- **GitHub Repository Import & Local Directory Binding**: Search and import repositories via local GitHub CLI (`gh`) or paste any `owner/repo` / HTTPS / SSH URL—either link an existing local checkout or clone into a chosen local directory, with automatic GitHub remote detection.
- **Structured Chief, Project & Agent Memory**: Manage durable memories across scopes (`chief`, `project`, `agent`) and categories (`preference`, `convention`, `architecture`, `pitfall`, `decision`), with pinning, enable/disable toggles, automatic repository `AGENTS.md`/`CLAUDE.md` loading, Chief MCP memory tools, and an optional read-only host Hermes memory reference bridge.
- **Zero-Pollution Isolated Git Worktrees & Shadow Snapshots**: Every dispatched task runs on its own worktree and branch under `ctx.paths.dataDir/worktrees/`. Captures committed and uncommitted diffs via a temporary `GIT_INDEX_FILE` shadow snapshot without dirtying your main checkout, with reversible `failed` retries (`Continue` or `Start over`).
- **Real-Time Streaming UX, Drag-to-Chat, Resizable Split & `⌘K` Command Palette**: RAF-batched live token streaming, collapsible real-time thinking accordion (`reasoning.delta`), live tool-call pills (`tool.started`/`tool.completed`), drag-and-drop Kanban cards into the composer, draggable split-pane resizing, collapsible Kanban columns, Chief quick-config popover, `⌘K` (`cmdk`) command palette, Todos keyboard shortcuts (`⌘B`, `⌘⌥B`, `⌘⇧↵`, `⌥↑/↓`), and subtle `motion/react` animations.
- **Dedicated `ekko-todo` MCP Server (32 Tools)**: task orchestration (`list_todos`, `create_todo`, `run_build`, `run_review`, `merge_build`, `retry_merge`, …), topic governance (`rename_topic`, `update_topic_brief`), schedules, and Chief configuration & memory tools (`get_system_config`, `configure_chief`, `configure_agent`, `configure_project`, `import_github_project`, `list_memories`, `manage_memory`, …). Once the plugin is enabled, any Studio agent can call them from an ordinary Studio chat.
- **Native Studio Theme Parity**: Inherits Ekko Studio light and dark tokens automatically with a calm 3-column workbench (`Projects & Topics | Chief Conversation | 4-Column Uniform Kanban`).

## Requirements

- **Ekko Studio (`hermes-web-ui`)**: tested on `0.8.30` only (Plugin SDK `apiVersion: 1`)
- **A Studio super administrator account**: required to install and enable; every account can use the plugin afterwards
- **Node.js**: `>= 22.13.0` for the Studio process (the plugin uses built-in `node:sqlite`)
- **Git**: `>= 2.25` on the Studio machine (for `git worktree`)
- **At least one engine installed in Studio's Agent Manager**: the Chief runs as a Studio session
- **GitHub CLI (`gh`)**: Optional (enables browsing your GitHub repositories & private repo cloning; direct URL import works without `gh`)

## Install

This is an Ekko Studio plugin, not a stand-alone site. Studio installs it straight from this repository: the compiled `dist/` entries are committed, so nothing is built or downloaded on your machine.

1. Check that the Studio process runs Node.js `>= 22.13.0` — the plugin uses the built-in `node:sqlite`. Open `<studio-url>/health` and read `node_version`.
2. In Studio open **Plugins → Install plugin**.
3. Paste `https://github.com/wuyangfan234/ekko-todo-plugin`, tick the trust box, click **Install**. Studio resolves the repository's latest commit and installs exactly that revision.
4. Click **Enable** on the new card, then **Open**.

Paste the bare repository link. `https://github.com/owner/repo/tree/main` or any path below the repository is rejected, and so is a link to a private repository you have not signed in for. Because Studio pins the install to a full commit SHA, an upgrade is a deliberate step (the card's **Update** action) rather than a silent pull — see [INSTALL.md](./INSTALL.md) for the Chinese step-by-step, including what you should see on screen at each step, how to pin the plugin to the sidebar, and how to upgrade or roll back.

You should see the three-column workbench with an empty board and the welcome wizard. [INSTALL.md](./INSTALL.md) (简体中文) is the full guide: it covers how the plugin connects to Studio's sessions, model picker, directory picker, uploads and theme, what it cannot do, and how to tell a wrong path from a disabled plugin from a host mismatch.

## Development & Verification

```bash
npm install
npm run build
npm run harness:check
npm test
```

Both `dist/server.mjs` and `dist/client.mjs` are bundled as self-contained ES modules (Node built-ins only at runtime) so Ekko Studio hosts can install and load the plugin without running `npm install`.

## Security & Scope Boundaries

- **No model or engine credentials for agent runs.** Agent runs delegate authentication to Ekko Studio (`ctx.host.sessions.*`) and to the runtimes you already configured; the plugin never stores a model API key or a Studio bearer token.
- **Two optional features do hold a secret, and say so.** The quota panel keeps each provider's own credential in the plugin's SQLite file and can reuse credentials your local CLIs already have (for example the auth files under your home directory) to ask that provider's official usage endpoint; without a local CLI login it reads, at query time only, the same provider's credential Ekko Studio is signed in with (Hermes `auth.json` / `.env`) and does not store it. A GitHub personal access token can be stored for repository import. Both stay off until you configure them, are scoped to your `(identity.userId, identity.profile)`, and are sent only to the endpoint you configured — never to the maintainer.
- Never modifies Ekko Studio host files or your navigation preferences automatically.
- All plugin data is scoped by `(identity.userId, identity.profile)` provided by the Studio host.
- Both `dist/` bundles are self-contained ES modules with the third-party packages compiled in; their licences are listed in [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
- See [SECURITY.md](./SECURITY.md), [RELEASING.md](./RELEASING.md) and [docs/CONTRACTS.md](./docs/CONTRACTS.md) for details.

## License

MIT License — see [LICENSE](./LICENSE). Bundled Ekko Studio SDK files remain under their MIT license (`sdk/LICENSE`, `sdk/NOTICE`).

Contributions are accepted under the [Contributor License Agreement](./CLA.md). It keeps your copyright with you, and every release published under MIT stays available under MIT; what it adds is the project's ability to choose its terms for future editions.
