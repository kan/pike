# Pike のタスクランナー。`just` で一覧、`just check` でコミット前チェック一式。
#
# レシピの実体は package.json の scripts に置いたまま、just はその薄いファサード
# にしてある（tauri CLI や CI の慣習で npm 経由が要るものを壊さないため）。例外は
# scripts/*.sh を呼ぶ E2E 同期系で、理由は下の windows-shell のコメントを参照。
# **スクリプトは `bash script.sh` の形で呼ぶこと**（`package.json` の scripts と同じ）。
# 直接呼ぶとファイルの実行ビットに依存する。Windows の Git Bash は shebang があれば
# 実行できてしまうので気付けず、macOS の CI で `Permission denied` になって初めて出た
# （v0.43.0 のリリースで実際に踏んだ）。

# レシピは Git Bash で走らせる。PATH 上の bash は WSL ランチャ
# （C:\Windows\System32\bash.exe）で、そちらには Windows 側の node / tauri /
# ImageMagick が無い。just の Windows 既定シェル（sh -c）に至っては PATH に存在
# しない。Git を別の場所に入れている場合は `just --shell <bash へのパス>` で上書き
# する（GitHub の windows runner はこのパスで合っている）。
set windows-shell := ["C:/Program Files/Git/bin/bash.exe", "-cu"]

# レシピ一覧を出す
default:
    @just --list --unsorted

# --- 開発 ---

# 開発版を起動する（identifier は com.pike.dev.debug なのでインストール版と共存できる）
dev:
    npm run tauri:dev

# Vite の dev サーバだけを起動する
dev-web:
    npm run dev

# インストーラまで含めた本番ビルド
build:
    npm run tauri build

# フロントだけビルドする（vue-tsc + vite）
build-web:
    npm run build

# rg サイドカーバイナリを取得する（ビルド前に 1 回。バイナリは gitignore）
fetch-rg:
    bash scripts/download-rg.sh

# --- コミット前チェック ---

# コミット前チェック一式（lint / 型検査 / ドキュメント整合 / clippy / test）
check: lint typecheck check-docs clippy test

# Biome（src/）
lint:
    npm run lint

# Biome の自動修正
fix:
    npm run lint:fix

# Vue SFC 込みの型検査（tsc ではなく vue-tsc を使うこと）
typecheck:
    npx vue-tsc --noEmit

# CLAUDE.md のディレクトリ構成・参照パス、マニュアルの画像とリンク
check-docs:
    npm run check:docs

# clippy（警告もエラー扱い）
[working-directory('src-tauri')]
clippy:
    cargo clippy -- -D warnings

# Rust のユニットテスト
[working-directory('src-tauri')]
test:
    cargo test

# --- 監査（security ワークフローと同じ内容） ---

# 依存の脆弱性を見る（cargo install cargo-audit が要る）
[working-directory('src-tauri')]
audit-cargo:
    cargo audit

# npm の依存を見る（本番依存のみ・critical だけ落とす）
audit-npm:
    npm audit --omit=dev --audit-level=critical

# --- E2E スクリーンショット ---

# 撮影用バイナリをビルドする（出力をパイプに通さないこと。CLAUDE.md 参照）
e2e-build:
    npm run e2e:build

# ja/en × light/dark の 4 バリアントを artifacts/screenshots へ撮影する
e2e:
    npm run e2e

# 撮影結果を docs/manual/img と docs/ へ同期する（ヒーロー画像の合成に magick が要る）
e2e-sync:
    bash scripts/sync-manual-images.sh
    bash scripts/sync-hero-images.sh

# 同期のドライラン
e2e-sync-check:
    bash scripts/sync-manual-images.sh --check
    bash scripts/sync-hero-images.sh --check

# --- リリース ---

# バージョンを上げる（3 ファイル + lockfile 2 つ）。CHANGELOG は手で書く
bump VERSION:
    node scripts/bump-version.mjs {{VERSION}}
    cd src-tauri && cargo check --quiet
    npm install --package-lock-only
