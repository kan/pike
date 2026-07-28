#!/usr/bin/env bash
#
# sync-hero-images.sh — 外枠付きヒーロー画像を撮影結果から作り直して配置する。
#
# README とマニュアル TOP に載せる画像は、ウィンドウ枠込みの見た目を求められるため
# frame-screenshot.sh でタイトルバー・角丸・影を合成する。内枠だけの画像を扱う
# sync-manual-images.sh とは出力先も加工も違うので、こちらで持つ。
#
# 以前はこの 6 枚を e2e/README.md の手打ちコマンドで作っており、再撮影のたびに
# 取り残されて内容が数リリース分古くなっていた。撮影 → 配置を 1 コマンドにする。
#
# 使い方:
#   scripts/sync-hero-images.sh --check      # ドライラン（更新予定・差分有無を表示）
#   scripts/sync-hero-images.sh              # 合成して docs/ へ配置（dark + light）
#
# オプション（環境変数）:
#   LANG_=ja|en    選ぶ言語（既定 ja）
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SRCDIR="$REPO_ROOT/artifacts/screenshots"
TMPDIR_FRAMED="$REPO_ROOT/artifacts/framed"
LANG_SEL=${LANG_:-ja}

# 「配置先（REPO_ROOT 相対、-light を除いた幹）:E2E ベース名」。
# dark は幹そのまま、light は幹 + `-light` に置く（GitHub の <picture> 切替用）。
MAP=(
  "docs/screenshot-editor:hero-editor"
  "docs/screenshot-git:hero-git"
  "docs/manual/img/overview:overview"
)

check=0
[ "${1:-}" = "--check" ] && check=1

updated=0 missing=0 same=0

# 1 枚を合成して配置する。合成は毎回テンポラリへ出し、中身が同じなら触らない
# （枠の合成結果はバイト単位で決まるので、差分の有無をそのまま比較できる）。
sync_one() {
  local src=$1 dst=$2
  local label
  label=${dst#"$REPO_ROOT/"}
  if [ ! -f "$src" ]; then
    echo "MISSING  $label  ← $(basename "$src") (source not found — run npm run e2e)"
    missing=$((missing + 1))
    return
  fi

  local framed="$TMPDIR_FRAMED/$(basename "$src")"
  bash "$REPO_ROOT/scripts/frame-screenshot.sh" "$src" "$framed" >/dev/null

  if [ -f "$dst" ] && cmp -s "$framed" "$dst"; then
    echo "SAME     $label"
    same=$((same + 1))
    return
  fi
  if [ "$check" = 1 ]; then
    echo "WOULD    $label  ← $(basename "$src")"
  else
    mkdir -p "$(dirname "$dst")"
    cp "$framed" "$dst"
    echo "FRAMED   $label  ← $(basename "$src")"
  fi
  updated=$((updated + 1))
}

for pair in "${MAP[@]}"; do
  stem=${pair%%:*}
  e2e=${pair##*:}
  sync_one "$SRCDIR/$e2e-$LANG_SEL-dark.png" "$REPO_ROOT/$stem.png"
  sync_one "$SRCDIR/$e2e-$LANG_SEL-light.png" "$REPO_ROOT/$stem-light.png"
done

echo ""
echo "対応 ${#MAP[@]} 画面 (dark + light): 更新 $updated / 同一 $same / ソース欠落 $missing"
[ "$check" = 1 ] && echo "(--check: ドライラン。実配置は引数なしで実行)"
exit 0
