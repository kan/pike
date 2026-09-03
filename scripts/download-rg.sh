#!/usr/bin/env bash
# Download ripgrep binary for Tauri sidecar bundling
#
# Tauri の externalBin は「ビルド対象のターゲットトリプルを接尾辞に持つファイル」を
# 必ず要求するので、Windows 決め打ちだと macOS / Linux のビルドが
# `resource path binaries/rg-aarch64-apple-darwin doesn't exist` で落ちる。
# 既定は rustc のホストトリプル。クロスビルドでは TARGET を明示する。
set -euo pipefail

VERSION="15.2.0"
TARGET="${TARGET:-$(rustc -vV | sed -n 's/^host: //p')}"
OUT_DIR="src-tauri/binaries"

# ripgrep が配っていないトリプルは、実行できる同等物に読み替える。x86_64 Linux は
# `-gnu` のビルドが無く `-musl`（静的リンクなので glibc 環境でも動く）だけ。読み替えないと
# `curl -f` が 404 で落ち、`set -e` で Tauri のビルド前に止まる。
case "$TARGET" in
  x86_64-unknown-linux-gnu) DL_TARGET="x86_64-unknown-linux-musl" ;;
  *)                        DL_TARGET="$TARGET" ;;
esac

# 「Windows 向けか」は 1 度だけ判定する。アーカイブ形式・実行ファイル名・出力名の
# 拡張子・展開コマンドが全部この 1 つの事実から決まるので、case を分けると増やしたとき
# 3 箇所を突き合わせることになり、食い違うとヘッダのコメントにある
# `resource path ... doesn't exist` で落ちる。
#
# 出力名は**ビルド対象のトリプル**（Tauri が要求するもの）、取得元は読み替え後。
# サイドカーの接尾辞はトリプルで、拡張子は Windows だけ付く（Tauri の規約）。
case "$TARGET" in
  *windows*)
    ARCHIVE="ripgrep-${VERSION}-${DL_TARGET}.zip"
    BIN="rg.exe"
    OUT_FILE="${OUT_DIR}/rg-${TARGET}.exe"
    EXTRACT="unzip"
    ;;
  *)
    ARCHIVE="ripgrep-${VERSION}-${DL_TARGET}.tar.gz"
    BIN="rg"
    OUT_FILE="${OUT_DIR}/rg-${TARGET}"
    EXTRACT="tar"
    ;;
esac

URL="https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${ARCHIVE}"

if [ -f "$OUT_FILE" ]; then
  echo "rg sidecar already exists: ${OUT_FILE}"
  exit 0
fi

mkdir -p "$OUT_DIR"
TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

echo "Downloading ripgrep ${VERSION} for ${TARGET} (${DL_TARGET})..."
curl -fsSL -o "${TMP_DIR}/${ARCHIVE}" "$URL"

SRC_DIR="ripgrep-${VERSION}-${DL_TARGET}"
case "$EXTRACT" in
  unzip) unzip -o "${TMP_DIR}/${ARCHIVE}" "${SRC_DIR}/${BIN}" -d "$TMP_DIR" ;;
  tar)   tar -xzf "${TMP_DIR}/${ARCHIVE}" -C "$TMP_DIR" "${SRC_DIR}/${BIN}" ;;
esac

cp "${TMP_DIR}/${SRC_DIR}/${BIN}" "$OUT_FILE"
chmod +x "$OUT_FILE"
echo "Done: ${OUT_FILE}"
