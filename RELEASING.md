# 发版与公开仓同步（维护者用）

本文写给维护者。只想安装和使用插件的人看 [README.md](./README.md) 与 [INSTALL.md](./INSTALL.md) 即可。

## 先说节奏：私有仓随时更新，只有大版本才同步到公开仓

- 日常开发在**私有仓**进行，每张任务卡审查通过、合并后，私有仓的 `main` 随时前进、随时发补丁版本。
- **公开仓（本仓库）不跟每一次提交**。只有攒到一个值得对外交付的版本（大版本、或一批修复需要让别人装到）时，才按下面的流程整树同步一次。
- 所以公开仓比私有仓落后几个补丁版本是**正常节奏，不是故障**。不要因为私有仓刚发了一个补丁就去同步公开仓。

## 一、私有仓发版

1. **只合并审查通过的提交。** 每张卡都要在当前 HEAD 上拿到独立审查的 `APPROVED`，针对旧提交的通过结论不算数。
2. **版本五处同改**，缺一处测试就会失败：
   - `package.json` → `version`
   - `plugin.json` → `version`
   - `package-lock.json` → 根 `version`
   - `package-lock.json` → `packages[""].version`
   - `contracts/plugin.json` → `description` 开头的 `v<版本> `

   同时在 `CHANGELOG.md` 顶部加 `## [<版本>] - <日期>` 段。
3. **重建并跑门禁**（Node 用 `.node-version` 指定的版本线）：

   ```bash
   npm run build
   npm run harness:check
   npm test
   ```

   `dist/server.mjs`、`dist/client.mjs`、`dist/bundled-packages.json` 是入库的，重建后一并提交。Studio 安装时 `--ignore-scripts`，不会替你构建——忘了提交 `dist/`，别人装到的就是旧 bundle。
4. **推私有仓**：`git push origin main`，并确认 `git rev-parse HEAD` 与 `git rev-parse origin/main` 相同。
5. **等私有仓 CI**：

   ```bash
   gh run list --branch main --limit 5 --json databaseId,headSha,status,conclusion
   gh run watch <databaseId> --exit-status
   ```

   只认 `headSha` 等于目标提交的那一行，结论必须是 `success`。

## 二、同步到公开仓（只在要对外交付时做）

公开仓是**导出树**，不是私有仓的镜像：不带私有历史，每次同步是一个新提交。

1. **以私有仓 `git ls-files` 的整树为准**，排除内部文件：
   - `OPEN_SOURCE_COMPLIANCE_AUDIT.md`（内部审计件，禁止公开）
   - 任何 denylist 类文件（如 `.private-denylist.json`，本仓库 `.gitignore` 已忽略）
2. **删除公开仓里多出来的 tracked 文件**（只删 `git ls-files` 的差集，不要 `rm -rf` 工作树，`.git` 和 `node_modules` 都在里面）。
3. **逐文件拷贝**（保留时间戳，例如 Python `shutil.copy2`）。
4. **逐文件字节比对**（`cmp` 或 `shasum -a 256`），不一致必须报出来并修到一致；`dist/` 三个文件必须在比对范围内，这是「装上就是这一版行为」的证据。
   - 例外：公开仓自己维护的面向用户文档（本文件、`README.md`、`README.en.md` 等）可以与私有仓不同；如果私有仓也有同名文件，先把差异回灌私有仓再同步，避免下次整树覆盖时被冲掉。
5. **门禁**：在公开仓工作树上同样跑 `npm run build`、`npm run harness:check`、`npm test`，rc 全为 0；构建后 `git status` 里 `dist/` 不应出现改动。
6. **提交与推送**：`git add -A`，提交信息写明版本（如 `Ekko ToDo <版本>`），`git push origin main`。
7. **等公开仓 CI**：

   ```bash
   gh run list --repo <owner>/<公开仓> --limit 5 --json databaseId,headSha,status,conclusion
   gh run watch <databaseId> --repo <owner>/<公开仓> --exit-status
   ```

   同样只认 `headSha` 等于本次提交的那一行。

## 三、泄露扫描（每次同步都做，贴原始输出）

在公开仓工作树上：

```bash
gitleaks detect --no-banner --redact -s .     # 期望 no leaks found
git grep -l -F -e '/Users/<你的用户名>' -e '<你的内网网段前缀>' -e '<个人邮箱或账号>' -e '<已知口令>' -- . ':(exclude)node_modules'
                                              # 期望无输出；用 -F 定字匹配，否则 . 会被当成通配符误报
```

另外按维护者自己的内部项目名、内网域名清单再扫一遍，期望 0 命中；确认 `OPEN_SOURCE_COMPLIANCE_AUDIT.md` 与 denylist 文件**不在**公开树里。扫描用的个人关键词清单放在私有仓或本机，不要写进公开仓。

历史兼容代码里出现的公开产品名（例如 `src/server/db.mjs` 中清理旧配额网关记录的迁移语句）不是泄露，**不要为了让扫描清零而删除迁移代码**，否则老用户的旧数据会残留。

## 四、安装链路实证

推送后，用 Studio 同款命令证明「粘贴仓库链接能装成可加载的包」：

```bash
tmp=$(mktemp -d)
npm install --prefix "$tmp" --ignore-scripts --omit=dev -- github:<owner>/<公开仓>#<本次提交>
node -e "import('$tmp/node_modules/studio-plugin-ekko-todo/dist/server.mjs').then(m=>{if(typeof m.apply!=='function')process.exit(1);console.log('apply ok')})"
```

再回读远端：

```bash
gh api repos/<owner>/<公开仓>/contents/package.json --jq .content | base64 -d | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version"
gh api repos/<owner>/<公开仓>/contents/OPEN_SOURCE_COMPLIANCE_AUDIT.md   # 期望 404
```

## 五、给别人一份离线副本

```bash
git archive --format=zip --prefix=ekko-todo/ -o ekko-todo.zip HEAD
```

对方解压后，在 Studio「安装插件」里填解压目录在 Studio 那台机器上的绝对路径即可。
