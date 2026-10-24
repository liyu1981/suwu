#!/usr/bin/env bash
# Build the suwu-max self-extracting launcher.
#
#   1. builds the frontend + the real suwu binary,
#   2. downloads the pinned tools listed in scripts/max-tools.json for the
#      target architecture (verifying their sha256 when pinned),
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
# --update-pins writes the computed sha256 values back into max-tools.json so
# later builds are reproducible and verified.
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
sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

# Downloads may need auth for rate-limited GitHub API calls, but these are
# direct release-download URLs and need no token.
fetch() {
  local url="$1" dst="$2"
  curl -fL --retry 3 --retry-delay 2 -o "$dst" "$url"
}

PINS=""
while IFS='|' read -r name version archive extract url pin keep; do
  [ -n "$name" ] || continue
  [ -n "$url" ] || die "no asset for $name/$GOARCH in scripts/max-tools.json"
  say "fetching $name $version ($GOARCH)"
  dst="$DOWNLOADS/$name.asset"
  fetch "$url" "$dst"
  got="$(sha256_of "$dst")"
  if [ -n "$pin" ] && [ "$pin" != "$got" ]; then
    die "checksum mismatch for $name: pinned $pin, downloaded $got"
  fi
  PINS="${PINS}${name} ${GOARCH} ${got}
"

  if [ "$archive" = "tar.gz" ]; then
    work="$DOWNLOADS/$name.extract"
    rm -rf "$work"
    mkdir -p "$work"
    tar -xzf "$dst" -C "$work"
    bin="$(find "$work" -type f -name "$extract" -perm -u+x | head -1)"
    [ -n "$bin" ] || die "$name: '$extract' not found in $url"
    install -m 0755 "$bin" "$BUNDLE/$name"
    if [ -n "$keep" ]; then
      top="$(dirname "$bin")"
      IFS=',' read -ra keeps <<< "$keep"
      for item in "${keeps[@]}"; do
        [ -e "$top/$item" ] || continue
        mkdir -p "$BUNDLE/tools/$name"
        cp -R "$top/$item" "$BUNDLE/tools/$name/"
      done
    fi
  else
    install -m 0755 "$dst" "$BUNDLE/$name"
  fi
done < <(python3 - "$GOARCH" <<'PY'
import json, sys
arch = sys.argv[1]
data = json.load(open("scripts/max-tools.json"))
for tool in data["tools"]:
    url = tool["assets"].get(arch, "")
    pin = tool.get("sha256", {}).get(arch, "")
    print("|".join([
        tool["name"], tool.get("version", ""), tool.get("archive", "none"),
        tool.get("extract", tool["name"]), url, pin,
        ",".join(tool.get("keep", [])),
    ]))
PY
)

# Extra docs (man pages) declared per tool.
python3 - "$GOARCH" <<'PY' | while IFS='|' read -r tool file url; do
import json, sys
arch = sys.argv[1]
data = json.load(open("scripts/max-tools.json"))
for tool in data["tools"]:
    for file, url in (tool.get("docs") or {}).items():
        print("|".join([tool["name"], file, url]))
PY
  [ -n "$tool" ] || continue
  mkdir -p "$BUNDLE/tools/$tool"
  say "fetching $tool/$file"
  curl -fL --retry 3 -o "$BUNDLE/tools/$tool/$file" "$url"
done

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
  python3 - "$GOARCH" "$PINS" <<'PY'
import json, sys
arch = sys.argv[1]
pins = {}
for line in sys.argv[2].strip().splitlines():
    name, a, digest = line.split()
    pins.setdefault(name, {})[a] = digest
path = "scripts/max-tools.json"
data = json.load(open(path))
for tool in data["tools"]:
    tool.setdefault("sha256", {})[arch] = pins.get(tool["name"], {}).get(arch, "")
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
fi
