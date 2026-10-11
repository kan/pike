#!/usr/bin/env bash
# ポータブル版の zip を作る（#451）。**先に `tauri build` を済ませておくこと**
# （リリースのワークフローは tauri-action の直後に呼ぶ）。
#
# 中身はインストーラと同じ `pike.exe` と `rg.exe`、それに目印の `portable.txt`。
# 目印があると Pike はポータブル版として動く（`src-tauri/src/portable.rs`）。
#
# **ファイルは名指しで入れる。** `target/release/` には検証用のバイナリ
# （`src-tauri/src/bin/` の `verify_*.exe`）も並ぶので、ディレクトリごと固めない。
#
# zip の中は `Pike/` の 1 フォルダにする。展開した場所に 3 つのファイルが散らばらず、
# そのフォルダがそのままデータの置き場（`Pike/data`）とプロジェクトの base になる。
set -euo pipefail

RELEASE_DIR="src-tauri/target/release"
OUT_DIR="artifacts/portable"
VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
ZIP="$OUT_DIR/Pike_${VERSION}_x64-portable.zip"
STAGE="$OUT_DIR/Pike"

for f in pike.exe rg.exe; do
  if [ ! -f "$RELEASE_DIR/$f" ]; then
    echo "missing $RELEASE_DIR/$f (run the release build first)" >&2
    exit 1
  fi
done

rm -rf "$OUT_DIR"
mkdir -p "$STAGE"
cp "$RELEASE_DIR/pike.exe" "$RELEASE_DIR/rg.exe" "$STAGE/"
cat > "$STAGE/portable.txt" <<'EOF'
Pike portable

This file makes Pike run as the portable build: settings and data are kept
in the "data" folder next to pike.exe, and nothing is registered with Windows.
Delete this file to run it as a normal (installed-style) build instead.

Projects can only be registered from inside this folder, so the whole folder
can be moved to another drive or PC.
EOF

# Git Bash に `zip` は無いので PowerShell に固めさせる（GitHub の Windows ランナーにも
# 手元にも必ずある）。パスは Windows の絶対パスで渡す（.NET はプロセスの cwd を基準にする）。
#
# **`Compress-Archive` を使わず .NET を直に呼ぶ。** PowerShell 7 から起こされた
# `powershell.exe` は 7 の `PSModulePath` を継ぎ、cmdlet のモジュールを読めずに落ちる
# （Pike のターミナルの pwsh から `just package-portable` を回して実測）。
# 最後の `$true` は「フォルダ自身を zip の中に含める」。
powershell.exe -NoProfile -NonInteractive -Command "
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    '$(cygpath -wa "$STAGE")', '$(cygpath -wa "$ZIP")',
    [System.IO.Compression.CompressionLevel]::Optimal, \$true)
"

rm -rf "$STAGE"
echo "$ZIP"
