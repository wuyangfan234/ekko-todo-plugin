# Contributing to Ekko ToDo

## Before your first pull request: the CLA

Every contribution needs a signed [CLA.md](./CLA.md) — it is short, and §8 says what to do. The
one-line version of why it exists: MIT alone cannot let the project choose its license terms later,
because every contributor would still own their part of the code. The CLA leaves that choice open
**without taking your copyright** — you keep full ownership of what you write, and every release
published under MIT stays available under MIT.

Sign by posting this as a comment on your pull request, then ticking the CLA box in the template:

```
I have read the CLA Document and I hereby sign the CLA
```

A patch that is otherwise ready but unsigned will be parked, not merged. That is the only hard
requirement in this document.

## Setup

```bash
npm install
npm run build
npm run harness:check
npm test
```

Before opening a pull request, run the full gate:

```bash
npm run prepack
```

It builds `dist/`, checks the plugin harness, verifies that `THIRD-PARTY-NOTICES.md` still matches what
is compiled into the two bundles, and runs the whole test suite.

## Guidelines

1. Keep `plugin.json` and `package.json` versions in sync (`apiVersion: 1`), together with
   `package-lock.json` (both places) and the version in the `contracts/plugin.json` description.
2. Keep all 12 `PLUGIN_LOCALES` translations complete in `plugin.json`.
3. Update `contracts/plugin.json` and `docs/CONTRACTS.md` whenever RPC, tool, action, or event schemas change.
4. Keep `dist/server.mjs` and `dist/client.mjs` self-contained (zero runtime `node_modules` imports) and run `npm run prepack` before opening a pull request.
5. Never commit personal paths, tokens, secrets, or local database files.

## Tests are the review

A pull request is judged on the tests it adds, not on the description. The bar:

- **New tests must fail before your change and pass after it.** Paste both runs; a test that passes on
  the old code proves nothing about the fix.
- **Prefer a mutation check when the claim is "this guard is load-bearing."** Break the guard on purpose
  locally, confirm the new test goes red, restore it. Say so in the pull request.
- **Do not weaken an existing assertion to make it pass.** If a test now contradicts your change, either
  the change is wrong or the test is describing behaviour you should talk to us about first.
- **Assert the thing, not a substring that is already there.** Checking that an error message contains a
  filename the underlying tool prints anyway will keep passing after you delete the code that adds it.

## What gets merged

Features that change behaviour need a test and, for anything user-visible, a `CHANGELOG.md` entry under
the current version. Pure refactors are welcome if the test suite is unchanged and green, and the diff is
small enough to read. If you are unsure whether something is in scope, open an issue first — that is
cheaper than a rewrite.

## Third-party material

Adding a dependency compiles it into both bundles, which means it is redistributed inside every copy of
the plugin. That brings two obligations:

1. Its license must permit redistribution (GPL, AGPL, SSPL and non-commercial terms do not).
2. `THIRD-PARTY-NOTICES.md` must be regenerated with `npm run notices:write` in the same commit — CI
   fails otherwise.
