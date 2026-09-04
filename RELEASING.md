# Releasing

**This repository publishes no artifacts.** A release here is a git tag and a GitHub Release — notes and a source snapshot, nothing more. Neither npmjs.com nor GitHub Packages receives anything, and the schema is not fetchable from any URL other than raw GitHub.

That is deliberate while the name is unsettled: publishing under a working title would burn the names, and npm blocks a name from reuse permanently once it has been published and unpublished. See [Status](./README.md#status).

[`.github/workflows/release.yml`](./.github/workflows/release.yml) therefore only *verifies* a release: it runs the test suite and asserts the release tag matches `package.json`. Nothing it does is irreversible.

## Cutting a release

1. Bump `version` in `package.json`.
2. If the schema's grammar changed, bump the version in the schema's `$id` too, and add a `CHANGELOG.md` entry. The `$id` is what consumers pin, so it is the version that actually matters to them.
3. Commit, then tag: `git tag -a v0.3.0 -m "v0.3.0" && git push --follow-tags`.
4. On GitHub, draft a Release against that tag, paste the changelog entry, and **Publish release**.

The workflow runs tests and checks the tag against `package.json`; a mismatch fails the run. You can also run it by hand from Actions → *Release* → **Run workflow**, which skips the tag check and just runs the suite.

## Consuming the schema meanwhile

Vendor the file. It is self-contained and has no runtime dependencies:

```bash
curl -O https://raw.githubusercontent.com/christosgkoros/json-query-language/main/query-language-schema.json
```

Pin a tag rather than `main` if you want a stable copy — swap `main` for `v0.3.0` in that URL.

## Turning publishing back on

The publish jobs existed and worked; they were removed rather than rewritten, so restore them from history instead of writing new ones:

```bash
git log --oneline -- .github/workflows/release.yml
git show <commit>^:.github/workflows/release.yml
git show <commit>^:.github/scripts/version-published.sh
```

What was there, and what it will need again:

| Registry | Name | Auth |
| --- | --- | --- |
| [npmjs.com](https://www.npmjs.com/) | `json-query-language` | `NPM_TOKEN` secret |
| GitHub Packages | `@christosgkoros/json-query-language` | `GITHUB_TOKEN`, automatic |

The names differ because GitHub Packages accepts **only** scoped names, and the scope must be the repository owner. npmjs.com would carry the plain name, since that is what people search for; the workflow rewrote `package.json` in the GitHub Packages job only, leaving the tarball otherwise byte-identical.

Notes worth keeping, since they cost time to work out:

- **The first publish needs a token, not OIDC.** npm's trusted publishing cannot perform a package's first publish — npm requires the package to exist before a trusted publisher can be attached. Migrate to OIDC after release #1 (npmjs.com → the package → *Settings* → **Trusted Publisher** → *GitHub Actions*, naming `release.yml`), then delete the secret.
- **A granular token cannot be scoped to a package that does not exist.** Since November 2025 npm issues only granular tokens, so the first one must be created with *Packages and scopes → All packages*, read and write, with a short expiry.
- **If the account requires 2FA for write actions, the token needs *Bypass 2FA*,** or publishing fails with `EOTP`.
- **`npm publish --dry-run` does not authenticate,** so it cannot tell you the token is wrong. That is why each publish job ran `npm whoami` first — the only step in a rehearsal that proved the credential worked.
- **`environment: release` is decoration until you configure it.** Referencing an environment that does not exist does not block the run; GitHub creates it with no protection rules. Add yourself as a required reviewer under *Settings → Environments → release* to make it a real gate.
- **Each job checked whether its version was already published and skipped if so,** which is what made re-running a partially-failed release safe when one registry succeeded and the other did not.
- **Consumers of the GitHub Packages copy need auth even though it is public** — an `.npmrc` with `@christosgkoros:registry=https://npm.pkg.github.com` and a token. The npmjs copy needs none, so it is the easier path to document.
