# Contributing to Ekko ToDo

## Setup

```bash
npm install
npm run build
npm run harness:check
npm test
```

## Guidelines

1. Keep `plugin.json` and `package.json` versions in sync (`apiVersion: 1`).
2. Keep all 12 `PLUGIN_LOCALES` translations complete in `plugin.json`.
3. Update `contracts/plugin.json` and `docs/CONTRACTS.md` whenever RPC, tool, action, or event schemas change.
4. Keep `dist/server.mjs` and `dist/client.mjs` self-contained (zero runtime `node_modules` imports) and run `npm run prepack` before opening a pull request.
5. Never commit personal paths, tokens, secrets, or local database files.
