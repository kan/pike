# Pike

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-24C8D8?logo=tauri&logoColor=white)](https://v2.tauri.app)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white)](https://vuejs.org)
[![Rust](https://img.shields.io/badge/Rust-2021-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org)

**「AI エージェント × ターミナル」に特化した、軽量な Windows 向け開発環境です。** ターミナル中心のワークフローにおける、VS Code の軽量な代替を目指しています。

Tauri v2（Rust + Vue / TypeScript）製。Windows を主対象としています。

![エディタとファイルツリー](docs/screenshot-editor.png)

![Git パネルと Claude Code](docs/screenshot-git.png)

## 主な機能

- **マルチターミナル**：xterm.js + PTY（WSL / cmd / PowerShell / PowerShell 7 / Git Bash）
- **AI エージェント**：Claude Code と Codex を統一チャットタブで。`@` メンションでのファイル参照、セッション復帰、トークン使用量・コスト表示
- **ターミナルの AI 補助**：`claude` 等をターミナルで使うための、ワンクリック起動 / 定型プロンプト挿入、出力中の `file:line` クリックでエディタを開く、エディタ選択範囲や診断をターミナルへ送る
- **エディタ**：CodeMirror 6（30+ 言語）、ミニマップ、検索・置換、git diff ガター、コンフリクト表示、定義ジャンプ、文字コード/改行コード対応
- **プレビュー**：Markdown / Mermaid / CSV / JSON / SVG / PDF、表示専用の画像ビューア
- **Git**：ステージング、コミット、push/pull、diff、コミットグラフ、コンフリクト表示、worktree 切替
- **サイドバーパネル**：ファイルツリー、検索（ripgrep 同梱）、Docker、タスクランナー、アウトライン、Problems
- **プロジェクト管理**：WSL / Windows プロジェクト、グループ整理、マルチウィンドウ、セッション復元
- **設定**：UI / ターミナル / エディタの個別フォント設定、ダーク/ライト、日英 i18n、設定同期、自動更新
- **pike CLI**：`pike file.rs:42` でファイルを開く、`pike <dir>` でプロジェクト切替、`--wait` で `GIT_EDITOR` 連携

## 使い方

詳しい使い方は **[ユーザーマニュアル](docs/manual/README.md)** を参照してください。

- [はじめに（インストール・初回起動・画面構成）](docs/manual/getting-started.md)
- [プロジェクトとウィンドウ](docs/manual/projects-and-windows.md)
- [ターミナルと AI エージェント](docs/manual/terminal-and-agents.md)
- [エディタとプレビュー](docs/manual/editor-and-preview.md)
- [Git](docs/manual/git.md)
- [サイドバーパネル](docs/manual/panels.md)
- [設定](docs/manual/settings.md)
- [ショートカットと CLI](docs/manual/shortcuts-and-cli.md)

## インストール

[GitHub Releases](https://github.com/kan/pike/releases/latest) から最新のインストーラをダウンロードして実行します。

| ファイル | 種類 |
|----------|------|
| `Pike_x.x.x_x64-setup.exe` | Windows インストーラ（NSIS、推奨） |
| `Pike_x.x.x_x64_en-US.msi` | Windows インストーラ（MSI） |

インストール後は自動でアップデートを確認します。手動で確認するときは歯車メニュー →「更新を確認」から行えます。

## ソースからビルド

### 必要なもの

- **Windows 11**
- **Node.js** >= 20
- **Rust** >= 1.77
- [Tauri v2 の前提条件](https://v2.tauri.app/start/prerequisites/)
- **WSL2**（任意。WSL シェルや Docker 連携を使う場合に必要）

### ビルドと実行

```bash
# 依存をインストール
npm install

# 同梱用の ripgrep バイナリをダウンロード
bash scripts/download-rg.sh

# 開発版（インストール版と共存して起動できます）
npm run tauri:dev

# 本番ビルド
npm run tauri build
```

## 開発・コントリビュート

アーキテクチャ、実装ルール、コミット規約などの開発者向け情報は **[CLAUDE.md](CLAUDE.md)** にまとまっています。

## ライセンス

[MIT](LICENSE)
