#!/usr/bin/env bash
#
# frame-screenshot.sh — 内枠スクショ（WebView）に Windows 11 風のウィンドウ枠を合成する。
#
# saveScreenshot() は WebView 内しか撮れず、ネイティブのタイトルバー・角丸・影は写らない
# （issue #142 の制約）。Store やサイトのヒーロー画像はウィンドウ枠込みを求められるため、
# 撮影済み PNG に後処理でタイトルバー + 角丸 + ドロップシャドウを合成する。
#
# 依存: ImageMagick 7（magick コマンド）。Windows の Segoe UI フォントを使う。
#
# 使い方:
#   scripts/frame-screenshot.sh <input.png> [output.png]   # 単体
#   scripts/frame-screenshot.sh --all                       # artifacts/screenshots/*.png を一括
#
# オプション（環境変数）:
#   THEME=dark|light   ファイル名から判定できないときの明示指定
#   BG=<color>         透過ではなく指定色の背景に載せる（例: BG='#c8ccd2'）。既定は透過
#   TITLE=<text>       タイトルバーの文字（既定 "Pike"）
#   OUTDIR=<dir>       --all の出力先（既定 artifacts/framed）
#
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ICON="$REPO_ROOT/src-tauri/icons/32x32.png"
FONT=/c/Windows/Fonts/segoeui.ttf
TITLE=${TITLE:-Pike}

# ファイル名の末尾 -dark / -light からテーマを推定する。
detect_theme() {
  case "$1" in
    *-dark.png|*-dark.PNG) echo dark ;;
    *-light.png|*-light.PNG) echo light ;;
    *) echo "${THEME:-dark}" ;;
  esac
}

frame_one() {
  local in=$1 out=$2 theme
  theme=$(detect_theme "$in")

  local tmp
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN

  local w h tb rad cw pad winw winh cy
  w=$(magick identify -format '%w' "$in")
  h=$(magick identify -format '%h' "$in")
  tb=40    # タイトルバー高
  rad=10   # 角丸半径
  cw=46    # キャプションボタン幅（Win11 は 46x32）
  pad=64   # 影のための余白
  winw=$w
  winh=$((h + tb))
  cy=$((tb / 2))

  local bar fg glyph edge
  if [ "$theme" = light ]; then
    bar="#eaeaea"; fg="#1a1a1a"; glyph="#404040"; edge="#c9c9c9"
  else
    bar="#2b2b2b"; fg="#e6e6e6"; glyph="#d0d0d0"; edge="#000000"
  fi

  # キャプションボタンのグリフ中心 x（右詰め: 閉じる / 最大化 / 最小化）
  local close_x max_x min_x g
  close_x=$((winw - cw/2))
  max_x=$((winw - cw - cw/2))
  min_x=$((winw - 2*cw - cw/2))
  g=5   # グリフ半幅

  # 1) タイトルバー（アイコン + タイトル + キャプションボタン）
  magick -size "${winw}x${tb}" xc:"$bar" \
    \( "$ICON" -resize 18x18 \) -gravity West -geometry +14+0 -composite \
    -font "$FONT" -pointsize 14 -fill "$fg" -gravity West -annotate +40+0 "$TITLE" \
    -stroke "$glyph" -strokewidth 1.2 -fill none \
    -draw "line $((min_x-g)),$cy $((min_x+g)),$cy" \
    -draw "rectangle $((max_x-g)),$((cy-g)) $((max_x+g)),$((cy+g))" \
    -draw "line $((close_x-g)),$((cy-g)) $((close_x+g)),$((cy+g))" \
    -draw "line $((close_x-g)),$((cy+g)) $((close_x+g)),$((cy-g))" \
    "$tmp/bar.png"

  # 2) タイトルバー + 内枠を縦連結
  magick "$tmp/bar.png" "$in" -append "$tmp/window.png"

  # 3) 四隅を角丸に（白抜きマスク＝不透明、黒＝透明。CopyOpacity は輝度をアルファに使う）
  magick -size "${winw}x${winh}" xc:black -fill white \
    -draw "roundrectangle 0,0,$((winw-1)),$((winh-1)),$rad,$rad" "$tmp/mask.png"
  magick "$tmp/window.png" "$tmp/mask.png" \
    -alpha off -compose CopyOpacity -composite "$tmp/rounded.png"

  # 4) ふちに 1px のヘアラインを重ねて実機の枠に寄せる
  magick "$tmp/rounded.png" \
    -stroke "$edge" -strokewidth 1 -fill none \
    -draw "roundrectangle 0,0,$((winw-1)),$((winh-1)),$rad,$rad" "$tmp/bordered.png"

  # 5) ドロップシャドウを付けて背景（既定は透過）に配置
  mkdir -p "$(dirname "$out")"
  if [ -n "${BG:-}" ]; then
    magick "$tmp/bordered.png" \
      \( +clone -background black -shadow 55x22+0+14 \) \
      +swap -background none -layers merge +repage \
      -bordercolor none -border "${pad}" \
      -background "$BG" -flatten \
      "$out"
  else
    magick "$tmp/bordered.png" \
      \( +clone -background black -shadow 55x22+0+14 \) \
      +swap -background none -layers merge +repage \
      -bordercolor none -border "${pad}" \
      "$out"
  fi

  echo "framed: $out ($(magick identify -format '%wx%h' "$out"), $theme)"
}

if [ "${1:-}" = "--all" ]; then
  outdir=${OUTDIR:-"$REPO_ROOT/artifacts/framed"}
  shopt -s nullglob
  for f in "$REPO_ROOT"/artifacts/screenshots/*.png; do
    base=$(basename "$f")
    frame_one "$f" "$outdir/$base"
  done
else
  in=${1:?usage: frame-screenshot.sh <input.png> [output.png] | --all}
  out=${2:-"$REPO_ROOT/artifacts/framed/$(basename "$in")"}
  frame_one "$in" "$out"
fi
