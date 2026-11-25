# 参与贡献 Ekko ToDo

## 第一个 PR 之前：签 CLA

每份贡献都需要签署 [CLA.md](./CLA.md)——它不长，§8 写了怎么签。为什么要有它，一句话：单靠 MIT，项目以后无法选择许可条款，因为每位贡献者仍拥有自己那部分代码。CLA 保留了这个选择权，**但不拿走你的版权**——你写的东西完全归你，已按 MIT 发布的每个版本永远按 MIT 可用。

签署方式：在你的 PR 里发一条评论，内容为下面这句（逐字一致），然后勾选 PR 模板里的 CLA 选项：

```
I have read the CLA Document and I hereby sign the CLA
```

其他都就绪但没签的补丁会被搁置，不会合并。这是本文唯一的硬性要求。

## 环境准备

```bash
npm install
npm run build
npm run harness:check
npm test
```

测试用的 Node.js 版本线写在 `.node-version`（当前 `22.23`），先确认 `node --version` 是 `v22.23.*`。开 PR 之前跑一次完整门禁：

```bash
npm run prepack
```

它会重建 `dist/`、检查插件结构、核对 `THIRD-PARTY-NOTICES.md` 与两个 bundle 里实际编进去的依赖是否一致，并跑完整测试。

## 基本规则

1. `plugin.json` 与 `package.json` 的版本保持一致（`apiVersion: 1`），同时还有 `package-lock.json`（两处）和 `contracts/plugin.json` 描述里的版本字样，共五处。
2. `plugin.json` 里 12 种 `PLUGIN_LOCALES` 的翻译要完整。
3. RPC、工具、动作或事件的结构有变化时，同步更新 `contracts/plugin.json` 与 `docs/CONTRACTS.md`。
4. `dist/server.mjs` 与 `dist/client.mjs` 必须自包含（运行时不 import `node_modules`），开 PR 前跑 `npm run prepack`。
5. 不要提交个人路径、令牌、密钥或本地数据库文件。

## 测试就是审查

PR 按它新增的测试来评判，而不是按描述。标准是：

- **新测试必须在改动前失败、改动后通过。** 把两次运行结果都贴出来；在旧代码上也能通过的测试证明不了修复。
- **声称「这道防线是承重的」时，最好做一次变异检查。** 在本地故意把防线弄坏，确认新测试变红，再恢复，并在 PR 里说明。
- **不要为了让测试通过而削弱已有断言。** 如果某条测试和你的改动矛盾，要么改动有问题，要么那条测试描述的行为需要先和我们讨论。
- **断言要断在点子上，而不是断一个本来就在的子串。** 只检查错误信息里包含某个文件名——而底层工具本来就会打印它——那么删掉添加它的代码后测试照样会绿。

## 什么会被合并

改变行为的功能需要测试；凡是用户看得见的，还需要在 `CHANGELOG.md` 当前版本下加一条。纯重构欢迎，前提是测试集不变且全绿、diff 小到能读完。拿不准是否在范围内，先开 issue——比返工便宜。

## 第三方材料

新增依赖会被编译进两个 bundle，也就是随插件的每一份副本再分发。这带来两条义务：

1. 它的许可必须允许再分发（GPL、AGPL、SSPL 以及非商用条款都不行）。
2. 必须在同一个提交里用 `npm run notices:write` 重新生成 `THIRD-PARTY-NOTICES.md`，否则 CI 会失败。

维护者发版与公开仓同步流程见 [RELEASING.md](./RELEASING.md)。

---

## Appendix: English


### Before your first pull request: the CLA

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

### Setup

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

### Guidelines

1. Keep `plugin.json` and `package.json` versions in sync (`apiVersion: 1`), together with
   `package-lock.json` (both places) and the version in the `contracts/plugin.json` description.
2. Keep all 12 `PLUGIN_LOCALES` translations complete in `plugin.json`.
3. Update `contracts/plugin.json` and `docs/CONTRACTS.md` whenever RPC, tool, action, or event schemas change.
4. Keep `dist/server.mjs` and `dist/client.mjs` self-contained (zero runtime `node_modules` imports) and run `npm run prepack` before opening a pull request.
5. Never commit personal paths, tokens, secrets, or local database files.

### Tests are the review

A pull request is judged on the tests it adds, not on the description. The bar:

- **New tests must fail before your change and pass after it.** Paste both runs; a test that passes on
  the old code proves nothing about the fix.
- **Prefer a mutation check when the claim is "this guard is load-bearing."** Break the guard on purpose
  locally, confirm the new test goes red, restore it. Say so in the pull request.
- **Do not weaken an existing assertion to make it pass.** If a test now contradicts your change, either
  the change is wrong or the test is describing behaviour you should talk to us about first.
- **Assert the thing, not a substring that is already there.** Checking that an error message contains a
  filename the underlying tool prints anyway will keep passing after you delete the code that adds it.

### What gets merged

Features that change behaviour need a test and, for anything user-visible, a `CHANGELOG.md` entry under
the current version. Pure refactors are welcome if the test suite is unchanged and green, and the diff is
small enough to read. If you are unsure whether something is in scope, open an issue first — that is
cheaper than a rewrite.

### Third-party material

Adding a dependency compiles it into both bundles, which means it is redistributed inside every copy of
the plugin. That brings two obligations:

1. Its license must permit redistribution (GPL, AGPL, SSPL and non-commercial terms do not).
2. `THIRD-PARTY-NOTICES.md` must be regenerated with `npm run notices:write` in the same commit — CI
   fails otherwise.
