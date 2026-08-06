# Releasing

Releases ship from [`.github/workflows/release.yml`](./.github/workflows/release.yml), triggered when a GitHub Release is **published**. The same commit goes to two registries under two names:

| Registry | Name | Auth |
| --- | --- | --- |
| [npmjs.com](https://www.npmjs.com/) | `json-query-language` | `NPM_TOKEN` secret |
| GitHub Packages | `@christosgkoros/json-query-language` | `GITHUB_TOKEN`, automatic |

The names differ because GitHub Packages accepts **only** scoped names, and the scope must be the repository owner. npmjs.com carries the plain name, since that is what people search for; the workflow rewrites `package.json` in the GitHub Packages job only. The tarball is otherwise byte-identical.

## One-time setup

### 1. `NPM_TOKEN`

npm's OIDC trusted publishing cannot perform a package's **first** publish — npm requires the package to exist before a trusted publisher can be attached to it. So the first release needs a token.

Since November 2025 npm issues only *granular* access tokens; the legacy classic/automation/publish types are gone. Two things about granular tokens matter here:

- **A granular token cannot be scoped to a package that does not exist.** `json-query-language` has never been published, so it will not appear in the package picker. The first token must therefore be created with **Packages and scopes → All packages**, read and write. After release #1 you can reissue it scoped to just this package — or better, skip straight to OIDC and delete it.
- **If your account requires 2FA for write actions, the token needs *Bypass 2FA* enabled**, or publishing fails with `EOTP`.

Steps:

1. npmjs.com → *Access Tokens* → **Generate New Token** → *Granular Access Token*.
2. Permissions: **Read and write**. Packages and scopes: **All packages**. Set a short expiry — this token is disposable.
3. Add it to the repo as a secret named exactly `NPM_TOKEN` (*Settings → Secrets and variables → Actions*).

`GITHUB_TOKEN` needs no setup; the workflow requests `packages: write` for it.

### 2. The `release` environment (recommended)

The `npmjs` job targets an environment named `release`. Referencing an environment that does not exist does **not** block the run — GitHub creates it on first use, with no protection rules — so the line buys you nothing until you configure it.

To make it a real gate: *Settings → Environments → release* → add yourself as a **required reviewer**. The job then pauses for approval before it can touch the registry.

If you don't want a gate, delete the `environment: release` line rather than leaving it as decoration.

### 3. Migrate to OIDC after the first release

Once `json-query-language` exists on npmjs, you can drop the token:

1. npmjs.com → the package → *Settings* → **Trusted Publisher** → *GitHub Actions*.
2. Enter the repository and `release.yml` as the workflow filename.
3. Delete the `NPM_TOKEN` secret and the `NODE_AUTH_TOKEN` env block from the `npmjs` job. The `id-token: write` permission is already there.

Short-lived OIDC credentials beat a long-lived token in a secret store — worth doing as soon as release #1 lands.

## Cutting a release

1. Bump `version` in `package.json`.
2. If the schema's grammar changed, bump the version in the schema's `$id` too, and add a `CHANGELOG.md` entry. The `$id` is what consumers pin, so it is the version that actually matters to them.
3. Commit, then tag: `git tag -a v0.3.0 -m "v0.3.0" && git push --follow-tags`.
4. On GitHub, draft a Release against that tag, paste the changelog entry, and **Publish release**.

The workflow then runs tests, asserts the tag matches `package.json` (a mismatch fails the run before anything is uploaded), and publishes to both registries. Releases marked **pre-release** publish under the `next` dist-tag instead of `latest`.

## Rehearsing

Actions → *Release* → **Run workflow**. It defaults to a dry run: tests, packaging and both publish commands run with `--dry-run`, uploading nothing.

Note that `npm publish --dry-run` does **not** contact the registry to authenticate, so on its own it would tell you nothing about whether your token works. That is why each publish job runs `npm whoami` first — that step does authenticate, and it is what makes a rehearsal meaningful. If the token is missing, expired or wrongly scoped, the run fails there.

Worth doing before the first real release, since publishing cannot be undone cleanly: npm allows unpublish within 72 hours, and the name is then blocked from reuse permanently.

## Re-running after a partial failure

The two registries publish independently, so one can succeed while the other fails. Before publishing, each job asks its registry whether the version already exists and skips if it does — so re-running a partially-failed release is safe and will only publish what is actually missing. A version conflict will not fail the run.

## Installing from GitHub Packages

Consumers of the scoped copy need to point the scope at GitHub and authenticate, since GitHub Packages requires a token even for public packages:

```ini
# .npmrc
@christosgkoros:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
npm install @christosgkoros/json-query-language
```

For most consumers the npmjs copy is the easier path — it needs no auth at all.
