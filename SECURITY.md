# Security Policy

## Scope & Guarantees

- **No model or engine credentials.** Ekko ToDo never receives, stores, logs, or transmits model API keys, Studio bearer tokens, or session cookies. Every agent run delegates authentication to Ekko Studio (`ctx.host.sessions.*`) and to the user's own configured local runtimes.
- **Two opt-in features do persist a secret.** The quota panel stores a per-provider credential (and can reuse a credential your local CLI already has, for example the auth file under your home directory) in order to call that provider's official usage endpoint; repository import can store a GitHub personal access token. Both stay inert until configured, are keyed by `(identity.userId, identity.profile)`, and are sent only to the endpoint the user configured. They are the complete list of what this plugin persists outside its own SQLite file.
- **Identity & Profile Isolation**: Every RPC and MCP tool binds strictly to `run.identity.userId` and `run.identity.profile` supplied by the Ekko Studio host.
- **Repository Isolation**: Worker builds execute inside isolated Git worktrees under `ctx.paths.dataDir/worktrees/`. Merge operations refuse to proceed if the main repository working tree has uncommitted changes and automatically run `git merge --abort` on conflicts.
- **Deployment Guardrail**: Deployment todos (`kind: "deploy"`) always require explicit human approval before completion, and a merge whose acceptance command could not be run stays on the human gate as well.

## Reporting a Vulnerability

Please report suspected security issues privately through GitHub Security Advisories on this repository instead of opening a public issue. Reports are acknowledged within 72 hours.
