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

1. On npmjs.com → *Access Tokens* → **Generate New Token** → *Granular Access Token*.
2. Scope it to the `json-query-language` package with **Read and write**. Set a short expiry.
3. Add it to the repo as a secret named `NPM_TOKEN` (*Settings → Secrets and variables → Actions*).

`GITHUB_TOKEN` needs no setup; the workflow requests `packages: write` for it.

### 2. The `release` environment (recommended)

The `npmjs` job targets an environment named `release`. Create it under *Settings → Environments* and add yourself as a **required reviewer**. The job then pauses for approval before it can touch the registry — the last chance to stop an unintended publish.

If you'd rather not have the gate, delete the `environment: release` line from the workflow.

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

Actions → *Release* → **Run workflow**. It defaults to a dry run, which exercises checkout, auth, packaging and both publish commands with `--dry-run`, uploading nothing. Worth doing before the first real release, since publishing cannot be undone cleanly — npm allows unpublish within 72 hours, but the name is then blocked from reuse permanently.

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
