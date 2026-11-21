#!/usr/bin/env bash
# Fetch the pinned herdr-core archive for a target into pkg/herdr/assets/, where
# a `-tags hcbin` build embeds it so `suwu hc` (and the Baikal tile) work on a
# machine that never installed herdr-core.
#
#   scripts/fetch-herdr-core.sh [--goos linux] [--goarch amd64|arm64] [--force]
#
# The version, URLs and sha256 come from pkg/herdr/herdr-core-lock.json; nothing
# is downloaded twice unless --force is given. The directory is gitignored: each
# release artifact carries the archive for its own platform only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOCK="pkg/herdr/herdr-core-lock.json"
OUT="pkg/herdr/assets/herdr-core.tar.gz"

GOOS="$(go env GOOS)"
GOARCH="$(go env GOARCH)"
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --goos) GOOS="$2"; shift 2 ;;
    --goarch) GOARCH="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$GOARCH" in
  amd64) ARCH=x86_64 ;;
  arm64) ARCH=aarch64 ;;
  *) echo "unsupported arch: $GOARCH" >&2; exit 2 ;;
esac
case "$GOOS" in
  linux) OS=linux ;;
  darwin) OS=macos ;;
  *) echo "herdr-core ships for linux and macOS (got $GOOS)" >&2; exit 2 ;;
esac
TARGET="$OS-$ARCH"

read_lock() {
  node -e '
    const lock = require(process.argv[1]);
    const target = lock.targets[process.argv[2]];
    if (!target) { console.error("no pinned build for " + process.argv[2]); process.exit(1); }
    console.log(target.url);
    console.log(target.sha256);
    console.log(lock.version);
  ' "$ROOT/$LOCK" "$TARGET"
}
mapfile -t INFO < <(read_lock)
URL="${INFO[0]}"
SHA="${INFO[1]}"
VERSION="${INFO[2]}"

if [ -f "$OUT" ] && [ "$FORCE" = 0 ]; then
  have=$(sha256sum "$OUT" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$OUT" | cut -d' ' -f1)
  if [ "$have" = "$SHA" ]; then
    echo "herdr-core $VERSION ($TARGET) already fetched"
    exit 0
  fi
fi

mkdir -p "$(dirname "$OUT")"
tmp="$(mktemp "${TMPDIR:-/tmp}/herdr-core.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
echo "fetching herdr-core $VERSION ($TARGET)"
curl -fsSL --max-time 180 "$URL" -o "$tmp"
got=$(sha256sum "$tmp" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$tmp" | cut -d' ' -f1)
if [ "$got" != "$SHA" ]; then
  echo "checksum mismatch for $URL" >&2
  echo "  want $SHA" >&2
  echo "  got  $got" >&2
  exit 1
fi
mv "$tmp" "$OUT"
echo "herdr-core $VERSION ($TARGET) -> $OUT"
