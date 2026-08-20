#!/usr/bin/env bash
#
# Build the self-contained codegraph extractor payload for the sandbox.
#
# Outputs:
#   1. build/codegraph-extractor/             — single-arch unpacked dir, baked
#      into the sandbox image at /opt/codegraph-extractor (docker/Dockerfile
#      COPY). The indexer execs /opt/codegraph-extractor/main.ts — no runtime
#      injection. Arch = --target (default: host).
#   2. build/codegraph-extractor-<arch>.tar.gz — standalone tarballs for both
#      linux-x64 and linux-arm64 (backward-compat / manual use).
#
# The per-platform bundle (kernel .node + compiled dist + own lib/node_modules)
# is self-contained, so only the bundle + main.ts ship.
#
# Usage: scripts/build-codegraph-extractor.sh [--target linux-x64|linux-arm64]
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/codegraph-extractor"
VERSION="$(node -p "require('$ROOT/package.json').devDependencies['@colbymchenry/codegraph'] // '1.5.0'")"

host_arch() {
  case "$(uname -m)" in
    aarch64|arm64) echo "linux-arm64" ;;
    x86_64|amd64) echo "linux-x64" ;;
    *) echo "linux-x64" ;;
  esac
}
TARGET="$(host_arch)"
if [ "${1:-}" = "--target" ]; then TARGET="$2"; fi
case "$TARGET" in linux-x64|linux-arm64) ;; *) echo "bad target: $TARGET" >&2; exit 1 ;; esac

fetch_bundle() {  # $1=target  $2=dest-dir
  local target="$1" dst="$2"
  mkdir -p "$dst/node_modules/@colbymchenry/codegraph-$target"
  local tgz
  tgz="$(cd "$dst" && npm pack "@colbymchenry/codegraph-$target@$VERSION" --silent)"
  tar xzf "$dst/$tgz" -C "$dst/node_modules/@colbymchenry/codegraph-$target" --strip-components=1
  rm "$dst/$tgz"
  test -f "$dst/node_modules/@colbymchenry/codegraph-$target/lib/kernel/codegraph-kernel.node"
}

# 1) Single-arch dir for the sandbox image.
rm -rf "$OUT"
mkdir -p "$OUT/node_modules/@colbymchenry"
cp "$ROOT/src/codegraph/script/main.ts" "$OUT/main.ts"
fetch_bundle "$TARGET" "$OUT"
echo "staged build/codegraph-extractor/ for $TARGET"

# 2) Standalone tarballs for both arches (built in temp dirs, keep #1 clean).
for target in linux-x64 linux-arm64; do
  tmp="$ROOT/build/.cg-tar-$target"
  rm -rf "$tmp" && mkdir -p "$tmp/node_modules/@colbymchenry"
  cp "$ROOT/src/codegraph/script/main.ts" "$tmp/main.ts"
  fetch_bundle "$target" "$tmp"
  ( cd "$tmp" && tar czf "$ROOT/build/codegraph-extractor-$target.tar.gz" . )
  rm -rf "$tmp"
  echo "built build/codegraph-extractor-$target.tar.gz ($(du -sh "$ROOT/build/codegraph-extractor-$target.tar.gz" | cut -f1))"
done
