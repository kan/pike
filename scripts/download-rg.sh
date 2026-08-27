#!/usr/bin/env bash
# Download ripgrep binary for Tauri sidecar bundling
#
# Tauri の externalBin は「ビルド対象のターゲットトリプルを接尾辞に持つファイル」を
# 必ず要求するので、Windows 決め打ちだと macOS / Linux のビルドが
# `resource path binaries/rg-aarch64-apple-darwin doesn't exist` で落ちる。
# 既定は rustc のホストトリプル。クロスビルドでは TARGET を明示する。
set -euo pipefail

VERSION="14.1.1"
TARGET="${TARGET:-$(rustc -vV | sed -n 's/^host: //p')}"
OUT_DIR="src-tauri/binaries"

case "$TARGET" in
  *windows*) ARCHIVE="ripgrep-${VERSION}-${TARGET}.zip"; BIN="rg.exe" ;;
  *)         ARCHIVE="ripgrep-${VERSION}-${TARGET}.tar.gz"; BIN="rg" ;;
esac

# サイドカーの接尾辞はトリプルで、拡張子は Windows だけ付く（Tauri の規約）。
case "$TARGET" in
  *windows*) OUT_FILE="${OUT_DIR}/rg-${TARGET}.exe" ;;
  *)         OUT_FILE="${OUT_DIR}/rg-${TARGET}" ;;
esac

URL="https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${ARCHIVE}"

if [ -f "$OUT_FILE" ]; then
  echo "rg sidecar already exists: ${OUT_FILE}"
  exit 0
fi

mkdir -p "$OUT_DIR"
TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

echo "Downloading ripgrep ${VERSION} for ${TARGET}..."
curl -fsSL -o "${TMP_DIR}/${ARCHIVE}" "$URL"

SRC_DIR="ripgrep-${VERSION}-${TARGET}"
case "$ARCHIVE" in
  *.zip)    unzip -o "${TMP_DIR}/${ARCHIVE}" "${SRC_DIR}/${BIN}" -d "$TMP_DIR" ;;
  *.tar.gz) tar -xzf "${TMP_DIR}/${ARCHIVE}" -C "$TMP_DIR" "${SRC_DIR}/${BIN}" ;;
esac

cp "${TMP_DIR}/${SRC_DIR}/${BIN}" "$OUT_FILE"
chmod +x "$OUT_FILE"
echo "Done: ${OUT_FILE}"
