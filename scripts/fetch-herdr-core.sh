#!/usr/bin/env bash
# Fetch the pinned herdr-core archive for a target into pkg/herdr/assets/, where
# a `-tags hcbin` build embeds it so `suwu hc` (and the Baikal tile) work on a
# machine that never installed herdr-core.
#
#   scripts/fetch-herdr-core.sh [--goos linux] [--goarch amd64|arm64] [--force]
#
# The version, URL and sha256 come from tools/catalog.json (entry herdr-core) —
# the same file the tools installer and the herdr runtime read, so the engine a
# release embeds can never drift from the tool the settings page installs.
# Nothing is downloaded twice unless --force is given. The output directory is
# gitignored: each release artifact carries the archive for its own platform
# only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CATALOG="tools/catalog.json"
OUT="pkg/herdr/assets/herdr-core.tar.gz"

GOOS="$(go env GOOS)"
GOARCH="$(go env GOARCH)"
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --goos) GOOS="$2"; shift 2 ;;
    --goarch) GOARCH="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

TARGET="$GOOS-$GOARCH"

read_catalog() {
  python3 - "$ROOT/$CATALOG" "$TARGET" <<'PY'
import json, sys
catalog, target = sys.argv[1:3]
data = json.load(open(catalog))
tool = next((t for t in data["tools"] if t["name"] == "herdr-core"), None)
if tool is None:
    sys.exit("tools/catalog.json has no herdr-core entry")
platform = tool["platforms"].get(target)
if platform is None:
    sys.exit(f"no pinned herdr-core build for {target}")
print(platform["url"])
print(platform["sha256"])
print(tool["version"])
PY
}

mapfile -t INFO < <(read_catalog)
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
