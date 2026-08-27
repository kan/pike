#!/usr/bin/env bash
# アプリアイコン一式を `src-tauri/icons/icon.svg` から作り直す（#256）。
#
#     bash scripts/make-icons.sh
#
# 要るのは ImageMagick（`magick`）と tauri CLI（`npx tauri`）だけで、macOS は要らない。
# tauri CLI は icns も書けるので、Apple の `iconutil` を使うために実機へ渡す必要はない。
#
# ## なぜ tauri icon を 2 回走らせるのか
#
# **macOS のアイコンには決まった余白がある。** Apple のグリッドでは 1024x1024 の
# キャンバスに対して本体が 824x824（80.5%）で、周囲に約 10% の透明な余白を残す。
# 一方 Windows のタスクバーは端まで描くアイコンが普通で、そちらに余白を足すと
# 理由なく小さくなる。`tauri icon` は入力をリサイズするだけで余白を足さないので、
# **入力を 2 つ用意して、icns だけ余白付きから採る**。
#
#   1 回目: icon.svg そのまま      → icon.png / icon.ico / PNG 一式 / ios / android
#   2 回目: 824 を 1024 に収めた版 → icon.icns だけ
#
# これをしないと、Dock で他のアプリより 1 辺で約 1.24 倍・面積で約 1.54 倍に見える。
#
# ## icns は毎回バイトが変わる
#
# tauri CLI は icns の中のエントリを毎回違う順で書く（中身は同一で、`.icns` は順序に
# 依存しない形式なので絵としては変わらない）。**アイコンを変えていなくても
# `icon.icns` に差分が出る**ので、意図しない変更と勘違いしないこと。
# 逆に、絵を変えたかどうかを見るときは `icon.png` など PNG 側の差分を見る
# （あちらは決定的に同じバイトになる）。

set -euo pipefail

cd "$(dirname "$0")/.."

SRC="src-tauri/icons/icon.svg"
DEST="src-tauri/icons"

command -v magick >/dev/null || { echo "エラー: ImageMagick (magick) が要ります" >&2; exit 1; }
[ -f "$SRC" ] || { echo "エラー: $SRC がありません" >&2; exit 1; }

# **作業ディレクトリはリポジトリ相対にする。** `mktemp -d` が返す `/tmp/...` は
# Git Bash（MSYS）のパスで、ネイティブの `magick.exe` や tauri CLI は解釈できない。
# 相対パスならどの OS でもそのまま通る。
TMP="src-tauri/target/icon-build"
rm -rf "$TMP"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/full" "$TMP/mac"

# macOS 用の入力。本体を 824 にしてから 1024 の透明キャンバス中央へ置く。
magick -background none "$SRC" -resize 824x824 \
  -background none -gravity center -extent 1024x1024 PNG32:"$TMP/padded.png"

# 念のため寸法を確かめる。ここがずれると Dock でだけ大きさが狂い、気付きにくい。
box=$(magick "$TMP/padded.png" -alpha extract -trim -format '%wx%h' info:)
[ "$box" = "824x824" ] || { echo "エラー: 余白付き入力の本体が $box です（824x824 が要る）" >&2; exit 1; }

echo "1/2 端まで版を生成中…"
npx tauri icon "$SRC" -o "$TMP/full" >/dev/null
echo "2/2 余白版（icns 用）を生成中…"
npx tauri icon "$TMP/padded.png" -o "$TMP/mac" >/dev/null

# 端まで版を全部入れてから、icns だけ余白版で上書きする。
cp -r "$TMP/full/." "$DEST/"
cp "$TMP/mac/icon.icns" "$DEST/icon.icns"

echo
echo "できました。確認:"
magick identify -format '  icon.png  %wx%h\n' "$DEST/icon.png"
magick "$DEST/icon.png" -alpha extract -trim -format '  icon.png  本体 %wx%h（端まで描くのが正しい）\n' info:
echo "  icon.icns 1024 の本体は 824x824（キャンバスの 80.5%）が正しい"
echo "  ios/ と android/ は .gitignore 対象なのでコミットには出ない"
