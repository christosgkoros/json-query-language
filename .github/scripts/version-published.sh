#!/usr/bin/env bash
# Reports whether the current package version already exists on a registry, so a
# re-run after a partial failure skips the registry that already succeeded
# instead of failing with a version conflict.
#
# Reads the package name from package.json — the GitHub Packages job rewrites it
# to the scoped form before calling this, so both jobs can share the script.
#
# Env:
#   VERSION   version to look for (required)
#   REGISTRY  registry URL (optional; defaults to whatever npm is configured for)
# Output:
#   published=true|false  on $GITHUB_OUTPUT
set -euo pipefail

name="$(node -p "require('./package.json').name")"
spec="${name}@${VERSION}"

args=(view "$spec" version)
[ -n "${REGISTRY:-}" ] && args+=("--registry=${REGISTRY}")

# `npm view` exits non-zero both for "no such version" and for real errors such
# as a bad token, so distinguish them: a genuine miss says E404, anything else
# should fail the job rather than be mistaken for "not published yet".
if output="$(npm "${args[@]}" 2>&1)"; then
  echo "::notice::${spec} is already published; skipping this registry."
  echo "published=true" >> "$GITHUB_OUTPUT"
elif grep -qiE 'E404|404 Not Found|is not in this registry' <<<"$output"; then
  echo "${spec} not found on the registry — will publish."
  echo "published=false" >> "$GITHUB_OUTPUT"
else
  echo "::error::Could not determine whether ${spec} is published."
  echo "$output"
  exit 1
fi
