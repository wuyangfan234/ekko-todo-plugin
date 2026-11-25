<!--
Thanks for sending a patch. Two things before this can be merged:

  1. Tick the CLA box below. Contributing for an employer? Read CLA.md §8.2 first.
  2. Run `npm run prepack` (build + harness + notices + every test) and paste the summary.

Keep the sections you filled in and delete the ones you did not.
-->

## What this changes

<!-- One paragraph. What was wrong or missing, and what it does now. -->

## How it was verified

<!--
Not "tests pass" — what you actually ran and saw. Commands with exit codes, a failing case before the
fix and the same case passing after, a screenshot path, a measured number.
-->

```
$ npm run prepack
```

## Checklist

- [ ] `npm run prepack` passes locally (it builds `dist/`, checks the harness, regenerates and compares
      `THIRD-PARTY-NOTICES.md`, then runs every test)
- [ ] `plugin.json`, `package.json`, `package-lock.json` (two places) and the `contracts/plugin.json`
      description carry the same version
- [ ] `contracts/plugin.json` and `docs/CONTRACTS.md` updated if any RPC, MCP tool, action or event
      schema changed
- [ ] Added tests that fail without this change — coding rules, UI spacing and "it looks right" do not
      count as verification
- [ ] No personal paths, tokens, secrets, local database files or internal host names in the diff
- [ ] Any third-party code, font or image is identified below together with its license
- [ ] `dist/` was rebuilt by `npm run build`, not edited by hand

## Third-party material

<!--
"None" if there is none. Otherwise: what it is, where it came from, and its license. Adding a package
to package.json means it is compiled into both bundles and therefore redistributed — mention it here.
-->

None.

## CLA

- [ ] **I have read [CLA.md](../CLA.md) and I hereby sign the CLA.**

<!--
The box alone is not the signature — CLA.md §8.1 asks for this exact comment on the pull request:

    I have read the CLA Document and I hereby sign the CLA

Post it, then tick the box. A pull request without both is not merged, however good the patch is.
Signing once covers your future contributions too.
-->
