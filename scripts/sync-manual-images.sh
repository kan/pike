#!/usr/bin/env bash
#
# sync-manual-images.sh — E2E 内枠スクショ（artifacts/screenshots）をマニュアル画像
# （docs/manual/img）へ同期する。
#
# E2E は `{画面}-{lang}-{theme}.png` で撮る（artifacts/ は gitignore）。マニュアルは
# GitHub の light/dark 切替（<picture> + prefers-color-scheme）に対応するため、各画像を
# `{別名}.png`（dark 既定・<img> フォールバック）と `{別名}-light.png`（light 上書き）の
# 2 枚で持つ。下の MAP で「マニュアル名 ← E2E ベース名」を対応づけ、ja の dark/light を
# それぞれコピーする。
#
# 外枠付きヒーロー（overview / README の screenshot-*）は frame-screenshot.sh で別途生成
# するためこの MAP には含めない。
#
# 使い方:
#   scripts/sync-manual-images.sh --check      # ドライラン（更新予定・差分有無を表示）
#   scripts/sync-manual-images.sh              # docs/manual/img へ実コピー（dark + light）
#
# オプション（環境変数）:
#   LANG_=ja|en    選ぶ言語（既定 ja）
#   OUTDIR=<dir>   出力先（既定 docs/manual/img。テスト時に別ディレクトリへ逃がせる）
#
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SRCDIR="$REPO_ROOT/artifacts/screenshots"
OUTDIR=${OUTDIR:-"$REPO_ROOT/docs/manual/img"}
LANG_SEL=${LANG_:-ja}

# マニュアル名 ← E2E ベース名（frameless 内枠のみ。overview 等の framed ヒーローは含めない）。
MAP=(
  "new-project:new-project"
  "settings-appearance:settings"
  "git-graph:git-graph"
  "terminal-agent-buttons:terminal"
  "docker:docker-panel"
  "search:search-panel"
  "tasks:tasks-panel"
  "todo:todo-panel"
  "command-palette:quickopen"
  "markdown-preview:markdown-preview"
  "image-viewer:image-viewer"
  "agent-chat:agent-codex"
  "worktree-selector:worktree-selector"
  "screen-layout:screen-layout"
  "global-editor:global-editor"
  "global-terminal:global-terminal"
)

check=0
[ "${1:-}" = "--check" ] && check=1

updated=0 missing=0 same=0

# 1 ファイルを同期する（src → dst）。存在確認・差分確認・--check を共通化。
sync_one() {
  local src=$1 dst=$2
  local label
  label=$(basename "$dst")
  if [ ! -f "$src" ]; then
    echo "MISSING  $label  ← $(basename "$src") (source not found — run npm run e2e)"
    missing=$((missing + 1))
    return
  fi
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    echo "SAME     $label"
    same=$((same + 1))
    return
  fi
  if [ "$check" = 1 ]; then
    echo "WOULD    $label  ← $(basename "$src")"
  else
    mkdir -p "$OUTDIR"
    cp "$src" "$dst"
    echo "COPIED   $label  ← $(basename "$src")"
  fi
  updated=$((updated + 1))
}

for pair in "${MAP[@]}"; do
  manual=${pair%%:*}
  e2e=${pair##*:}
  sync_one "$SRCDIR/$e2e-$LANG_SEL-dark.png" "$OUTDIR/$manual.png"
  sync_one "$SRCDIR/$e2e-$LANG_SEL-light.png" "$OUTDIR/$manual-light.png"
done

echo ""
echo "対応 ${#MAP[@]} 画面 (dark + light): 更新 $updated / 同一 $same / ソース欠落 $missing"
[ "$check" = 1 ] && echo "(--check: ドライラン。実コピーは引数なしで実行)"
