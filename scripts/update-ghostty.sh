#!/bin/bash
# Rebuild the ghostty-web dependency from HEAD of liyu1981/ghostty-web
# (customization fixes live there, upstream npm release lags) and vendor
# it into frontend/vendor/ghostty-web for reproducible installs.
#
# Requires: bun (install + lib build), zig 0.15.x on PATH or under
# ~/.asdf/installs/zig (the wasm build per Ghostty's requirements).
#
# Usage: pnpm update-ghostty   (or ./scripts/update-ghostty.sh)
set -euo pipefail

repo="$HOME/src/ghostty-web"

if [ -d "$repo/.git" ]; then
  echo "==> Updating $repo to origin/main"
  git -C "$repo" fetch origin main
  git -C "$repo" reset --hard origin/main
else
  echo "==> Cloning ghostty-web into $repo"
  git clone --depth 1 --recurse-submodules --shallow-submodules \
    https://github.com/liyu1981/ghostty-web "$repo"
fi

cd "$repo"
echo "==> ghostty-web @ $(git rev-parse --short HEAD)"

echo "==> bun install"
bun install

echo "==> building ghostty-vt.wasm (zig)"
./scripts/build-wasm.sh

echo "==> building lib"
bun run build:lib

echo "==> vendoring dist -> frontend/vendor/ghostty-web"
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$project_root/frontend/vendor/ghostty-web"
rm -rf "$target/dist"
cp -r "$repo/dist" "$target/dist"
cp "$repo/ghostty-vt.wasm" "$repo/package.json" "$repo/README.md" "$repo/LICENSE" "$target/"

cd "$project_root/frontend"
pnpm install
pnpm typecheck

echo "==> done: ghostty-web vendored from $(git -C "$repo" rev-parse --short HEAD)"
