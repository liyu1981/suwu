#!/bin/sh
set -eu

REPO="liyu1981/suwu"
INSTALL_DIR="${SUWU_INSTALL_DIR:-$HOME/.local/bin}"

info()  { printf '\033[1;34m->\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m->\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m!\033[0m %s\n' "$*" >&2; exit 1; }

# ── check dependencies ──
for cmd in curl tar; do
  command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' is required but not found"
done

# ── detect arch ──
case "$(uname -m)" in
  x86_64|amd64)   ARCH="amd64" ;;
  aarch64|arm64)   ARCH="arm64" ;;
  *)               die "unsupported architecture: $(uname -m)" ;;
esac

# ── fetch latest release ──
info "fetching latest release from GitHub..."
API_URL="https://api.github.com/repos/${REPO}/releases/latest"

HEADERS=""
if [ -n "${GITHUB_TOKEN:-}" ]; then
  HEADERS="-H \"Authorization: Bearer ${GITHUB_TOKEN}\""
fi

RESPONSE=$(curl -fsSL \
  ${HEADERS:+-H "Authorization: Bearer ${GITHUB_TOKEN}"} \
  -H "Accept: application/vnd.github+json" \
  "$API_URL") \
  || die "failed to fetch release info (are you offline or rate-limited?)"

VERSION=$(printf '%s' "$RESPONSE" | grep '"tag_name"' | sed 's/.*"tag_name": *"//;s/".*//')
[ -n "$VERSION" ] || die "could not parse version from GitHub response"

# strip leading v for asset filename (matches release workflow convention)
ASSET_VERSION="${VERSION#v}"

ASSET_NAME="suwu-${ASSET_VERSION}-linux-${ARCH}.tar.gz"
DOWNLOAD_URL="https://github.com/${REPO}/re/download/${VERSION}/${ASSET_NAME}"

info "version:  ${VERSION}"
info "asset:    ${ASSET_NAME}"

# ── download ──
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

TARBALL="${TMPDIR}/${ASSET_NAME}"
info "downloading ${DOWNLOAD_URL}..."
curl -fSL -o "$TARBALL" "$DOWNLOAD_URL" \
  || die "download failed — check that release ${VERSION} exists with asset ${ASSET_NAME}"

# ── extract ──
info "extracting..."
tar -xzf "$TARBALL" -C "$TMPDIR"

# find the suwu binary in extracted contents
BIN=$(find "$TMPDIR" -maxdepth 1 -name suwu -type f | head -1)
[ -n "$BIN" ] || die "suwu binary not found in archive"

# ── install ──
mkdir -p "$INSTALL_DIR"
cp "$BIN" "${INSTALL_DIR}/suwu"
chmod 755 "${INSTALL_DIR}/suwu"

info "installed ${INSTALL_DIR}/suwu ${VERSION}"

# ── warn if not on PATH ──
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) warn "${INSTALL_DIR} is not in your PATH — add it or use full path" ;;
esac

# ── onboard ──
info "running suwu onboard..."
exec "${INSTALL_DIR}/suwu" onboard
