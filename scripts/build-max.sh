#!/usr/bin/env bash
# Build the suwu-max self-extracting launcher.
#
#   1. builds the frontend + the real suwu binary,
#   2. installs the pinned tools listed in tools/catalog.json for the target
#      architecture (verifying their sha256),
#   3. assembles build/bundle/ with the binaries, licenses and a manifest,
#   4. embeds the bundle into the launcher (go build -tags max),
#   5. writes dist/suwu-max-<version>-<goos>-<goarch>.tar.gz.
#
# Usage:
#   scripts/build-max.sh [--goos linux] [--goarch amd64|arm64]
#                        [--version X.Y.Z] [--skip-frontend]
#                        [--update-pins]
#
# The target defaults to the host (go env GOOS/GOARCH). Only Linux is
# supported; --goarch allows a cross build (used by CI for arm64).
#
# --update-pins writes the computed sha256 values back into tools/catalog.json
# so later builds are reproducible and verified. That file is the single source
# of truth shared with the server (see docs/TOOLS_PLAN.md §5).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HOST_GOOS="$(go env GOOS)"
HOST_GOARCH="$(go env GOARCH)"
GOOS="$HOST_GOOS"
GOARCH="$HOST_GOARCH"
VERSION=""
SKIP_FRONTEND=0
UPDATE_PINS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --goos) GOOS="$2"; shift 2 ;;
    --goarch) GOARCH="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --skip-frontend) SKIP_FRONTEND=1; shift ;;
    --update-pins) UPDATE_PINS=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$GOOS" != "linux" ]; then
  echo "suwu-max currently builds for Linux only (host is $HOST_GOOS/$HOST_GOARCH)" >&2
  exit 2
fi
case "$GOARCH" in
  amd64|arm64) ;;
  *) echo "unsupported --goarch $GOARCH (amd64 or arm64)" >&2; exit 2 ;;
esac

if [ -z "$VERSION" ]; then
  VERSION="$(node -p 'require("./package.json").version')"
fi

BUILD="$ROOT/build/max"
BUNDLE="$BUILD/bundle"
DOWNLOADS="$BUILD/downloads"
rm -rf "$BUILD"
mkdir -p "$BUNDLE" "$DOWNLOADS"

say() { printf '\033[1;34m->\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m!\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. frontend + real suwu ─────────────────────────────────────────────
if [ "$SKIP_FRONTEND" -eq 0 ]; then
  say "building frontend"
  pnpm --dir frontend build >/dev/null
fi

say "building suwu $VERSION for $GOOS/$GOARCH"
CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" go build \
  -ldflags "-s -w -X suwu/pkg/version.Version=$VERSION" \
  -o "$BUNDLE/suwu" ./cmd/Suwu
chmod 0755 "$BUNDLE/suwu"

# ── 2. tools ────────────────────────────────────────────────────────────
CATALOG="$ROOT/tools/catalog.json"
PAYLOAD="$ROOT/scripts/tool-payload.py"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Downloads may need auth for rate-limited GitHub API calls, but these are
# direct release-download URLs and need no token.
fetch() {
  local url="$1" dst="$2"
  curl -fL --retry 3 --retry-delay 2 -o "$dst" "$url"
}

PIN_ARGS=()
while IFS='|' read -r name version archive url pin strip entries keep docs; do
  [ -n "$name" ] || continue
  say "fetching $name $version ($GOOS/$GOARCH)"
  dst="$DOWNLOADS/$name.asset"
  fetch "$url" "$dst"
  got="$(sha256_of "$dst")"
  if [ -n "$pin" ] && [ "$pin" != "$got" ]; then
    die "checksum mismatch for $name: pinned $pin, downloaded $got"
  fi
  PIN_ARGS+=("--name" "$name=$got")

  # Only the declared entries are unpacked: an unexpected file in a release
  # archive never reaches the bundle.
  python3 "$PAYLOAD" --catalog "$CATALOG" extract \
    --source "$dst" --archive "$archive" --out "$BUNDLE" \
    --strip "$strip" --entries "$entries" --keep "$keep" --name "$name"

  if [ -n "$docs" ]; then
    IFS=',' read -ra doclist <<< "$docs"
    for item in "${doclist[@]}"; do
      file="${item%%:*}"
      docurl="${item#*:}"
      mkdir -p "$BUNDLE/tools/$name"
      say "fetching $name/$file"
      curl -fL --retry 3 -o "$BUNDLE/tools/$name/$file" "$docurl"
    done
  fi
done < <(python3 "$PAYLOAD" --catalog "$CATALOG" list --goos "$GOOS" --goarch "$GOARCH" --bundled max)

# ── 3. manifest ─────────────────────────────────────────────────────────
say "writing manifest"
python3 - "$GOOS" "$GOARCH" "$VERSION" "$BUNDLE" <<'PY'
import hashlib, json, os, stat, sys
goos, goarch, version, bundle = sys.argv[1:5]
entries = []
for root, _dirs, files in os.walk(bundle):
    for name in files:
        full = os.path.join(root, name)
        rel = os.path.relpath(full, bundle).replace(os.sep, "/")
        mode = stat.S_IMODE(os.stat(full).st_mode)
        h = hashlib.sha256()
        with open(full, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        entries.append({
            "name": os.path.basename(rel),
            "file": rel,
            "mode": f"{mode:04o}",
            "sha256": h.hexdigest(),
        })
# suwu first (the launcher promotes it before the rest)
entries.sort(key=lambda e: (e["file"] != "suwu", e["file"]))
manifest = {"schema": 1, "version": version, "goos": goos, "goarch": goarch, "entries": entries}
with open(os.path.join(bundle, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
print(f"  {len(entries)} entries")
PY

# ── 4. embed + build launcher ───────────────────────────────────────────
say "building suwu-max"
mkdir -p cmd/SuwuMax/bundle
tar -czf cmd/SuwuMax/bundle/bundle.tar.gz -C "$BUNDLE" .
cp "$BUNDLE/manifest.json" cmd/SuwuMax/bundle/manifest.json
CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" go build \
  -tags max \
  -ldflags "-s -w -X suwu/pkg/version.Version=$VERSION" \
  -o "$BUILD/suwu-max" ./cmd/SuwuMax
chmod 0755 "$BUILD/suwu-max"

# ── 5. package ──────────────────────────────────────────────────────────
mkdir -p dist
ARCHIVE="dist/suwu-max-$VERSION-$GOOS-$GOARCH"
tar -cf "$ARCHIVE.tar" -C "$BUILD" suwu-max
gzip -f "$ARCHIVE.tar"
say "wrote $ARCHIVE.tar.gz ($(du -h "$ARCHIVE.tar.gz" | cut -f1))"

if [ "$UPDATE_PINS" -eq 1 ]; then
  say "updating sha256 pins"
  python3 "$PAYLOAD" --catalog "$CATALOG" pin --goos "$GOOS" --goarch "$GOARCH" "${PIN_ARGS[@]}"
fi
