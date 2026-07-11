#!/usr/bin/env bash
#
# sync-manual-images.sh — E2E 内枠スクショ（artifacts/screenshots）をマニュアル画像
# （docs/manual/img）へ同期する。
#
# E2E は `{画面}-{lang}-{theme}.png` で撮る（artifacts/ は gitignore）。マニュアルは
# `img/{別名}.png`（ja/dark 相当）を参照する。両者は名前が違うため、下の MAP で
# 「マニュアル名 ← E2E ベース名」を対応づけ、既定で ja/dark を選んでコピーする。
#
# 実際の差し替え（コミット）は issue #145 の作業。このスクリプトはその配管で、
# 走らせて初めて docs/manual/img を更新する。
#
# 使い方:
#   scripts/sync-manual-images.sh --check      # ドライラン（更新予定・未撮影・差分有無を表示）
#   scripts/sync-manual-images.sh              # docs/manual/img へ実コピー
#
# オプション（環境変数）:
#   LANG_=ja|en    選ぶ言語（既定 ja）
#   THEME=dark|light  選ぶテーマ（既定 dark）
#   OUTDIR=<dir>   出力先（既定 docs/manual/img。テスト時に別ディレクトリへ逃がせる）
#
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SRCDIR="$REPO_ROOT/artifacts/screenshots"
OUTDIR=${OUTDIR:-"$REPO_ROOT/docs/manual/img"}
LANG_SEL=${LANG_:-ja}
THEME_SEL=${THEME:-dark}

# マニュアル名 ← E2E ベース名。E2E 側が未撮影のものは "-" にして未対応を明示する
# （#145 でシナリオ追加後に差し替える）。
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
  "overview:overview"
  "screen-layout:screen-layout"
  "global-editor:global-editor"
  "global-terminal:global-terminal"
)

check=0
[ "${1:-}" = "--check" ] && check=1

updated=0 missing=0 pending=0 same=0
for pair in "${MAP[@]}"; do
  manual=${pair%%:*}
  e2e=${pair##*:}
  dst="$OUTDIR/$manual.png"

  if [ "$e2e" = "-" ]; then
    echo "PENDING  $manual.png  (E2E 未撮影 — #145 で用意)"
    pending=$((pending + 1))
    continue
  fi

  src="$SRCDIR/$e2e-$LANG_SEL-$THEME_SEL.png"
  if [ ! -f "$src" ]; then
    echo "MISSING  $manual.png  ← $e2e-$LANG_SEL-$THEME_SEL.png (source not found — run npm run e2e)"
    missing=$((missing + 1))
    continue
  fi

  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    echo "SAME     $manual.png"
    same=$((same + 1))
    continue
  fi

  if [ "$check" = 1 ]; then
    echo "WOULD    $manual.png  ← $(basename "$src")"
  else
    mkdir -p "$OUTDIR"
    cp "$src" "$dst"
    echo "COPIED   $manual.png  ← $(basename "$src")"
  fi
  updated=$((updated + 1))
done

echo ""
echo "対応 ${#MAP[@]} 件: 更新 $updated / 同一 $same / 未撮影(pending) $pending / ソース欠落 $missing"
[ "$check" = 1 ] && echo "(--check: ドライラン。実コピーは引数なしで実行)"
