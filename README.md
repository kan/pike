# Pike

軽量な AI コーディング特化開発環境。Tauri v2 (Rust + Vue/TypeScript) 製、Windows 向け。

## 前提条件

- Windows 11
- WSL2 (Ubuntu) インストール済み
- Docker Desktop（WSL2 バックエンド）インストール済み
- WSL2 内に tmux インストール済み (`sudo apt install tmux`)
- Rust (rustup) インストール済み
- Node.js 20+ インストール済み
- Tauri CLI: `cargo install tauri-cli --version "^2"`

## セットアップ

```bash
# Tauri プロジェクトの初期化（初回のみ）
cargo tauri init

# 依存関係インストール
npm install

# 開発サーバー起動
cargo tauri dev
```

## 開発の始め方

**必ず CLAUDE.md と MILESTONE.md を読んでから作業を始めること。**

現在のフォーカス: `MILESTONE.md` の「現在のマイルストーン」を参照。

## 検証バイナリの実行

```bash
# PTY 接続確認
cargo run --bin verify_pty

# Docker socket 接続確認
cargo run --bin verify_bollard
```
