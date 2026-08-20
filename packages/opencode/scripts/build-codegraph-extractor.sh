#!/usr/bin/env bash
#
# Build the self-contained codegraph extractor payload for the sandbox.
#
# Output: build/codegraph-extractor-<arch>.tar.gz for both linux-x64 and
# linux-arm64 (K8s sandboxes are amd64; local Docker sandboxes on Apple Silicon
# are arm64).
#   codegraph-extractor/
#     main.ts                                   (extraction script, run with bun)
#     node_modules/@colbymchenry/codegraph-<platform>-<arch>/{lib/kernel,lib/dist,...}
#
# Each per-platform bundle is self-contained (kernel .node + compiled dist +
# its own lib/node_modules deps), so nothing else ships. The server uploads
# this tarball into the sandbox (files API), untars, and runs
#   bun /tmp/codegraph-extractor/main.ts index --root /workspace ...
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/codegraph-extractor"
VERSION="$(node -p "require('$ROOT/package.json').devDependencies['@colbymchenry/codegraph'] // '1.5.0'")"

# bun refuses to link platform-mismatched packages into node_modules, so fetch
# the per-platform bundles directly from the registry tarballs.
fetch_bundle() {
  local target="$1" # e.g. linux-x64
  local dst="$OUT/node_modules/@colbymchenry/codegraph-$target"
  mkdir -p "$dst"
  local tgz
  tgz="$(cd "$OUT" && npm pack "@colbymchenry/codegraph-$target@$VERSION" --silent)"
  tar xzf "$OUT/$tgz" -C "$dst" --strip-components=1
  rm "$OUT/$tgz"
  test -f "$dst/lib/kernel/codegraph-kernel.node"
}

rm -rf "$OUT"
mkdir -p "$OUT/node_modules/@colbymchenry"
cp "$ROOT/src/codegraph/script/main.ts" "$OUT/main.ts"

for target in linux-x64 linux-arm64; do
  fetch_bundle "$target"
done

for target in linux-x64 linux-arm64; do
  tar czf "$ROOT/build/codegraph-extractor-$target.tar.gz" -C "$ROOT/build" codegraph-extractor
  echo "built build/codegraph-extractor-$target.tar.gz ($(du -sh "$ROOT/build/codegraph-extractor-$target.tar.gz" | cut -f1))"
done
