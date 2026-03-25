#!/usr/bin/env bash
# Download ripgrep binary for Tauri sidecar bundling
set -euo pipefail

VERSION="14.1.1"
TARGET="x86_64-pc-windows-msvc"
ARCHIVE="ripgrep-${VERSION}-${TARGET}.zip"
URL="https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${ARCHIVE}"
OUT_DIR="src-tauri/binaries"
OUT_FILE="${OUT_DIR}/rg-${TARGET}.exe"

if [ -f "$OUT_FILE" ]; then
  echo "rg sidecar already exists: ${OUT_FILE}"
  exit 0
fi

mkdir -p "$OUT_DIR"
TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

echo "Downloading ripgrep ${VERSION} for ${TARGET}..."
curl -sL -o "${TMP_DIR}/${ARCHIVE}" "$URL"
unzip -o "${TMP_DIR}/${ARCHIVE}" "ripgrep-${VERSION}-${TARGET}/rg.exe" -d "$TMP_DIR"
cp "${TMP_DIR}/ripgrep-${VERSION}-${TARGET}/rg.exe" "$OUT_FILE"
echo "Done: ${OUT_FILE}"
