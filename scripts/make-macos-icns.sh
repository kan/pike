#!/usr/bin/env bash
# macOS のアプリアイコン（icon.icns）を作り直す（#256）。
#
# ## なぜ専用のスクリプトなのか
#
# macOS のアイコンには決まった余白がある。Apple のグリッドでは 1024x1024 の
# キャンバスに対して本体が 824x824（80.5%）で、周囲に約 10% の透明な余白を残す。
# `tauri icon` はこの余白を足さない（元画像をリサイズするだけ）ため、端まで
# 描かれた素材をそのまま渡すと、Dock で他のアプリより 1 辺で約 1.24 倍、面積で
# 約 1.54 倍に見える。
#
# 入力の `icon-macos-1024.png` は**その余白を付け終わった状態**でコミットしてある。
# ここでやるのは iconset への切り出しと `iconutil` の呼び出しだけ。
#
# ## 触るのは icns だけ
#
# `icon.ico` と PNG 一式（Windows のタスクバーとトレイが使う）は変更しない。
# 両方に余白を付けると、今度は Windows のアイコンが理由なく小さくなる。
# トレイアイコンは `app.default_window_icon()` 由来で PNG 一式を見るので、
# この変更の影響を受けない。
#
# ## 使い方（macOS で実行する）
#
#     bash scripts/make-macos-icns.sh
#
# 必要なのは `sips` と `iconutil` で、どちらも macOS に付属する
# （`iconutil` は Xcode Command Line Tools）。ImageMagick は要らない。

set -euo pipefail

cd "$(dirname "$0")/.."

SRC="src-tauri/icons/icon-macos-1024.png"
OUT="src-tauri/icons/icon.icns"

if [ "$(uname)" != "Darwin" ]; then
  echo "エラー: macOS で実行してください（iconutil が要る）" >&2
  exit 1
fi
for cmd in sips iconutil; do
  command -v "$cmd" >/dev/null || {
    echo "エラー: $cmd が見つかりません（Xcode Command Line Tools を入れてください）" >&2
    exit 1
  }
done
[ -f "$SRC" ] || { echo "エラー: $SRC がありません" >&2; exit 1; }

# 入力が本当に 1024 か確かめる。違うサイズを渡されると、iconutil は通るのに
# Dock でぼやけたアイコンが出るだけ、という気付きにくい壊れ方をする。
w=$(sips -g pixelWidth "$SRC" | awk '/pixelWidth/{print $2}')
h=$(sips -g pixelHeight "$SRC" | awk '/pixelHeight/{print $2}')
if [ "$w" != "1024" ] || [ "$h" != "1024" ]; then
  echo "エラー: $SRC は ${w}x${h} です。1024x1024 が要ります" >&2
  exit 1
fi

SET=$(mktemp -d)/icon.iconset
mkdir -p "$SET"
trap 'rm -rf "$(dirname "$SET")"' EXIT

# iconutil が要求するファイル名と寸法（この 10 個で固定）。
emit() { # emit <出力名> <ピクセル>
  sips -s format png -z "$2" "$2" "$SRC" --out "$SET/$1" >/dev/null
}
emit icon_16x16.png 16
emit icon_16x16@2x.png 32
emit icon_32x32.png 32
emit icon_32x32@2x.png 64
emit icon_128x128.png 128
emit icon_128x128@2x.png 256
emit icon_256x256.png 256
emit icon_256x256@2x.png 512
emit icon_512x512.png 512
emit icon_512x512@2x.png 1024

iconutil -c icns "$SET" -o "$OUT"

echo "書き出しました: $OUT ($(wc -c < "$OUT") バイト)"
echo
echo "確認: Finder で $OUT を選び、スペースキーで Quick Look する。"
echo "      Dock の他のアプリと同じくらいの余白があれば正しい。"
echo "      数値で見るなら README の #256 の手順を参照。"
