# Pike — Claude Code ガイド

## プロジェクト概要

**Pike** は Tauri v2 (Rust + Vue/TypeScript) で構築する軽量開発環境。第一ターゲットは Windows で、
macOS はローカルのシェルで開発できるところまで対応する。
「AI エージェント × ターミナル」に特化し、VS Code より大幅に軽いことが最重要の差別化点。

### 設計思想
- **軽さ最優先**: Monaco は使わない。CodeMirror 6 のみ。拡張機能システムは作らない
- **タブ統一**: エディタ・ターミナル・Docker logs をすべて同一タブで扱う
- **Rust はステートレスに**: Rust は I/O ブリッジに徹する。セッション復帰は各ツールの resume 機能（`claude --continue` 等）に委譲
- **外部依存は明示**: rg なければ grep、と graceful degrade する。tmux はオプション機能

### ターゲット環境
- **OS**: Windows 11（メイン開発・動作環境）。macOS はローカルのシェルで開発できるところまで対応する（詳細と制約は `.claude/rules/platform.md`）
- **実行環境**: WSL2 上のシェル・Docker コンテナ、または Windows ホスト上のシェル。macOS ではホストのログインシェル
- **GUI**: Tauri v2 webview（ホストのネイティブプロセス。Windows は WebView2、macOS は WKWebView）
- **対応シェル**: WSL bash / cmd.exe / PowerShell / Git Bash / ローカル Unix シェル（macOS）

---

## 詳細ルール（触る領域のものを読む）

このファイルには全体像と運用を置き、領域別の実装ルールは `.claude/rules/` に分けてある。どれも非自明な判断・定数・落とし穴の記録で、読まずに書くと過去に踏んだものを踏み直す。

各ファイルは先頭の `paths:` フロントマターで対象を絞ってあり、**当てはまるファイルを Read したときにだけ読み込まれる**（起動時には読み込まない。全部を常に読み込むと指示ファイルの合計が上限を超える）。**Grep や Glob だけで済ませて Read しないまま書くときは、下の表から該当するものを自分で読むこと。** ルールを足したり、担当するファイルが増えたりしたら `paths:` も直す。

| ファイル | 中身 |
|---|---|
| `rust.md` | Tauri コマンドの形・状態管理・文字列・非同期・命名規約 |
| `rust-window.md` | Rust からウィンドウと webview を触るとき（`Window` を使う・ack を待たない・ドロップの無効化） |
| `frontend.md` | どの画面にも当てはまる規則（Vue/Pinia の構成・URL を開く・overlay・フォーカス・スタイル・アイコン・i18n・禁止事項） |
| `tabs.md` | タブ管理・タブバー・作業領域の分割・OS ファイルドロップ |
| `settings-ui.md` | 設定画面・テーマの追従・フォント・シェルプロファイル |
| `testing.md` | 自動テストの範囲・検証バイナリの置き場 |
| `terminal.md` | PTY とシェル対応・ターミナルの coding agent 補助・ターミナル検索 |
| `shortcuts.md` | キーボードショートカットの層と正本・ターミナルとのキーの取り合い・マニュアルとの照合 |
| `project.md` | プロジェクトの登録・管理・切替・一時プロジェクト・セッション永続化 |
| `sync.md` | 設定とプロジェクト一覧の同期（#403） |
| `window.md` | マルチウィンドウ・ウィンドウ状態の永続化・仮想デスクトップ・背景透過 |
| `os-integration.md` | グローバルモード・`pike` CLI・`--wait`・ジャンプリスト・トレイ |
| `git.md` | git CLI ブリッジ・コンフリクト解消・ログ・リモート操作・worktree |
| `git-diff.md` | diff タブと履歴タブ |
| `git-graph.md` | ブランチグラフとコミットタブ |
| `editor.md` | ファイルツリー・エディタ本体・保存の責任・QuickOpen・定義ジャンプ・アウトライン |
| `preview.md` | Markdown の入力支援・各種プレビュー・画像ビューワと PDF |
| `search.md` | 検索パネル・rg の検出・置換 |
| `watcher.md` | ファイル監視 |
| `issues.md` | issue パネルと issue タブ |
| `panels.md` | 診断パネル（Problems）とタスクランナー |
| `agent.md` | エージェントの一覧と起動・シェルへの問い合わせ（エージェントはターミナルで動かす、#275） |
| `agent-hook.md` | 入力待ちの知らせ・デスクトップ通知・hook による申告・`CLAUDE_CONFIG_DIR` |
| `agent-usage.md` | トークン使用量とレート制限の表示 |
| `docker.md` | bollard 連携・compose の探索・ログ・ポートフォワード |
| `build.md` | 開発ビルド・本番ビルド限定の落とし穴（CSP）・E2E スクリーンショット・CI・セルフアップデート |
| `platform.md` | Windows / macOS の分岐の作法・GUI プロセスの PATH・macOS で持たない機能・rg サイドカー |

---

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────┐
│  Tauri WebView (ネイティブプロセス)                      │
│  ┌────────────┐  ┌──────────────────────────────────┐  │
│  │ 左サイドバー│  │ タブペイン                        │  │
│  │ アイコン   │  │ [📌CC][📌Codex][editor][shell][+]│  │
│  │ ナビ       │  │                                    │  │
│  │ ─────────  │  │  xterm.js / CodeMirror 6          │  │
│  │ 🗂 files   │  │  (アクティブタブのコンテンツ)      │  │
│  │ 🌿 git     │  │                                    │  │
│  │ 🔍 search  │  └──────────────────────────────────┘  │
│  │ 🐋 docker  │                                         │
│  │ 📁 projects│                                         │
│  │ 📋 tasks   │                                         │
│  │ 🔭 outline │                                         │
│  │ ⚠ problems │                                         │
│  │ ✅ issues   │                                         │
│  └────────────┘                                         │
└──────────────┬──────────────────────────────────────────┘
               │ Tauri IPC (invoke / events)
┌──────────────▼──────────────────────────────────────────┐
│  Rust バックエンド                                        │
│  pty_manager   git_manager   fs_watcher   search         │
│  project_store docker_client                             │
└──────────────┬──────────────────────────────────────────┘
               │ wsl.exe spawn / ホストのシェル / bollard / git CLI / notify
┌──────────────▼──────────────────────────────────────────┐
│  WSL2 (Windows) / ホストのログインシェル (macOS)          │
│  Claude Code / bash / zsh / etc.                         │
│  Docker (WSL2 backend) ← コンテナ群                      │
└─────────────────────────────────────────────────────────┘
```

---

## ディレクトリ構成

ファイル単位の構成は `.claude/structure.md` にある（起動時には読み込まない）。どこに何があるかを
探すとき、新しいモジュールの置き場を決めるときに読む。**`src/` と `src-tauri/src/` にファイルを足したら
そこにも 1 行足す**（`just check-docs` が照合する）。

```
pike/
├── CLAUDE.md / README.md / justfile
├── docs/manual/        # ユーザーマニュアル（画像は img/）
├── scripts/            # bump・check-docs・check-shortcuts・rg の取得など
├── tests/              # フロントの純粋なロジックのテスト
├── src-tauri/src/      # Rust バックエンド
├── src/                # Vue/TypeScript フロント
└── .claude/            # rules/（領域別ルール）・skills/release/（リリース手順）・structure.md
```

---

## 開発の進め方

機能追加・修正は **GitHub Issue 駆動**で行う。作業前に対象 Issue を確認すること。

ドキュメントの役割分担を守ること:

- **README.md** … ユーザー向け（概要・インストール・主な機能・マニュアルへの導線）。AI 開発の内部情報は書かない。
- **docs/manual/** … ユーザーマニュアル（日本語）。使い方・操作手順はここに集約し、拡充する。
- **CLAUDE.md（本ファイル）** … AI 開発のための情報のうち、全体像・構造・規約・運用。ユーザー向けの使い方は書かない。
- **.claude/rules/** … 領域別の実装ルールと落とし穴。実装の細部はここに書く（上の索引を参照）。
- **.claude/structure.md** … ファイル単位のディレクトリ構成。
- **.claude/skills/** … 決まった手順（リリースなど）。

### ドキュメント校正ルール

**日本語のユーザー向けドキュメントを更新・追加したら、コミット前に必ず校正する。**

- 対象：`README.md` / `docs/manual/` 配下 / `CHANGELOG.md`（リリース時に足す新しいセクション）
- 対象外：`CLAUDE.md` と `e2e/README.md`（どちらも密な技術メモで、読み手が開発者）、英語で書く `SECURITY.md`

1. **textlint（機械チェック）** を npx で実行し、**今回書いた箇所**の ai-writing 系の指摘を 0 にする（既存の指摘は 4 を参照）:

   ```bash
   npx --yes --package textlint \
     --package textlint-rule-preset-ai-writing \
     --package textlint-rule-preset-ja-technical-writing \
     -- textlint --rule preset-ai-writing --rule preset-ja-technical-writing \
     README.md docs/manual/*.md CHANGELOG.md
   ```
   （リポジトリに textlint は未導入。実行は npx で都度行う）

2. **`japanese-tech-writing` スキル**（判断ベース）で、textlint が拾えない空句・冗長・演出・論証を点検する。

3. **守る表記規約**:
   - 箇条書きの太字ラベルの区切りは**全角コロン**で `**用語**：説明` と書く。半角コロン `:` は `no-ai-list-formatting` に触れるため使わない。
   - 地の文・見出しで **em ダッシュ `—` を使わない**（全角コロンか句読点にする）。
   - 誇張語（「大幅に」等）・LLM 空句（「重要なのは」「正面から」「多角的」等）を使わない。
   - 二重助詞・一文内の過多カンマ（4 個以上）を避ける。

4. **据え置いてよい指摘**:
   - `no-mix-dearu-desumasu`（本文の「です・ます」と箇条書き・表セルの体言止めの混在）と、列挙が主因の `sentence-length`。マニュアルとして自然なので無理に潰さない。
   - **CHANGELOG の過去セクション**。出荷済みの記録なので、表記の一括正規化（全角コロンへの統一など）以外は書き換えない。校正するのはそのリリースで足す節だけ。
   - 誤検出の常連が 2 つある。UI 名やエスケープシーケンスに出るリテラルの `?`（`no-exclamation-question-mark`）と、行を折り返した括弧（`no-unmatched-pair` が閉じ括弧を見失う）。

5. **見出しを変更したら、ページ内アンカー（`](#...)`）との整合を確認する**。Pike のプレビューは見出しテキストを「小文字化＋`[^\p{L}\p{N}_\s-]` 除去＋空白→ハイフン」で slug 化して `id` を振る（`src/lib/slug.ts`）。アンカーはこの slug 規則に一致させる。

### コミット前チェック

**コミットの前は、変更の規模に応じて次を実行し、指摘を反映してからコミットする。**

| 変更の規模 | 実行するもの |
|---|---|
| ある程度の規模の実装・修正 | `/code-review` → `simplify` → `just check` |
| 軽微なコード修正 | `simplify` → `just check`（自明な 1 行修正などは直接コミットしてもよい） |
| ドキュメントのみ（`README.md` / `docs/manual/` / `CHANGELOG.md`） | 「ドキュメント校正ルール」の校正 ＋ `just check-docs` |
| CLAUDE.md / `.claude/` 配下の md（rules・skills・structure.md）のみ | `just check-docs`（開発者向けなので日本語校正の対象外） |
| バージョン bump のみ | 何も要らない |

- **順序を守る**。`/code-review`（バグ探索）で挙がったものを直してから `simplify`（再利用・単純化・効率・抽象度の品質整理）を回す。simplify はバグを探さないので、先に回しても直すべきコードを整えるだけになる。
- どちらもコードを書き換えるため、必ず**ユーザの動作確認より前**に実行する（ユーザは適用後のコードを試す）。
- `/code-review` はスキルとして実行できる。ユーザーが自分でコマンドを打つこともある。

その上でコミット前に **`just check`** を実行し、エラー・警告がゼロであることを確認する。中身は次の 8 つで、CI（`ci.yml`）も同じレシピを呼ぶ:

- **Frontend**: `just lint`（= `npm run lint` = `biome check src/ tests/`）
- **TypeScript 型検査**: `just typecheck`（= `npx vue-tsc --noEmit`。`tsc` ではなく `vue-tsc` を使うこと — Vue SFC の型チェックに必要）
- **ドキュメント整合**: `just check-docs`（= `node scripts/check-docs.mjs`）
- **ショートカット照合**: `just check-shortcuts`（= `tsx scripts/check-shortcuts.ts`。マニュアルの早見表と実装の割り当てを突き合わせる。#280）
- **TS のテスト**: `just test-ts`（= `tsx --test tests/*.test.ts`。Node 標準の `node:test` で、フロントの純粋なロジックだけを見る。#403）
- **Rust の整形**: `just fmt-check`（= `src-tauri/` で `cargo fmt --check`。設定は `src-tauri/rustfmt.toml`。整形するときは `just fmt`。#313）
- **Rust**: `just clippy`（= `src-tauri/` で `cargo clippy --all-targets -- -D warnings`。`--all-targets` が無いと `#[cfg(test)]` の中だけ素通りする。追加の lint は `src-tauri/Cargo.toml` の `[lints.clippy]`、#382）
- **Rust テスト**: `just test`（= `src-tauri/` で `cargo test`）

**`git blame` の設定を 1 回だけ入れる。** 全体を rustfmt に通したコミット（#313）で Rust の
36 ファイルが動いているので、そのままでは blame がそこで埋まる。clone したら次を実行する:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

### ドキュメント乖離のチェック

`npm run check:docs` は機械的に照合できる乖離だけを見る。落ちたらコミット前に直す。

1. `src/` と `src-tauri/src/` のファイルが `.claude/structure.md` の構成に載っているか（**新しいファイルを足したら構成にも 1 行足す**）
2. 開発ノート（CLAUDE.md と `.claude/` 配下の md）が挙げるファイルパスが実在するか（削除・改名の取り残し）
3. 開発ノートがバッククォートで挙げるシンボル名が実在するか（**関数の改名・削除の取り残し**。2 はパスしか見ない）。**README とマニュアルは対象外**（読み手が利用者で、架空の例が普通に出てくる）。他所の API と、「もう無い」と書くために出す名前は、スクリプト内の `EXTERNAL_NAMES` / `GONE_NAMES` に理由付きで並べる。**名前の出典として読むのは追跡ファイルだけ**（`git ls-files`）で、生成物や手元の作業ファイルは数えない。ここを歩き回りにすると「手元では通って CI で落ちる」が起きる
4. README とマニュアルが参照する画像が実在するか、逆に参照されない画像が残っていないか（画像の置き場は `docs/manual/img/` に集約する。README のヒーロー画像もここ。#279）
5. md 間のリンクとページ内アンカーが解決するか（`src/lib/slug.ts` と同じ slug 規則。あちらを変えるとスクリプトが検知して落ちる）

スクリプトで判定できない「説明が実装と合っているか」は、差分の性質から自分で判断する。**ユーザーに見える挙動を変えたら、実装と同じコミットで対応するドキュメントも直す**:

| 変えたもの | 直すドキュメント |
|---|---|
| UI の操作・表示 | `docs/manual/` の該当ページ（機能一覧レベルの変化なら README も） |
| 設定項目の追加・変更 | `docs/manual/settings.md` |
| キーボードショートカット | `docs/manual/shortcuts-and-cli.md` と `components/KeyboardShortcuts.vue` の一覧 |
| `pike` CLI の引数・サブコマンド | `docs/manual/shortcuts-and-cli.md` |
| 非自明な実装判断・定数・落とし穴 | `.claude/rules/` の該当ファイル（全体像・運用に関わるものは CLAUDE.md。数値は出典のコードを併記して drift を防ぐ） |

後の棚卸しでまとめて直すと漏れる。**実装したコミットで一緒に直す。**

**プラットフォームを増やす変更は、OS を限定した記述（「Windows 専用」など）を横断的に古くする。**
そういう変更では `grep -rn Windows` で全ドキュメントを一度洗う。

### コミット & push 運用ルール
個人開発のため、自分の変更に PR は作らない。Claude が変更を加えた場合は以下のフローを厳守:

1. **コミット前に必ずユーザの動作確認 OK を取る** — `cargo clippy` / `biome` / `vue-tsc` が通っていてもコミットしてはいけない。ユーザは GUI 上で実際に挙動を試す必要があるため、Claude が「テスト通った」だけで自動コミットすると確認前に履歴が確定してしまう。「コミットしていい？」と聞くか、ユーザが明示的に「コミットして」と言うまで待つ
2. **`main` ブランチに直接コミット**（feature ブランチや PR は作らない）
3. **`git push` は実行しない** — push の判断はユーザに委ねる（ユーザはローカル確認後に自分で push する運用）。**例外はリリース依頼時**（次項 5）
4. ユーザから明示的に「PR にして」「ブランチ切って」等の指示があった場合のみ、その指示に従う
   - **外部からの PR も来る**。取り込むときは通常のコミット前チェックと同じ扱いで、
     `/code-review` → `simplify` を回してから main へマージする。ロックファイルを共有する
     dependabot の PR は、1 件ずつマージするとリベース待ちが連鎖するので、ローカルでまとめて
     取り込んで push する（PR は依存が更新された時点で自動クローズされる）
5. **リリース依頼は end-to-end で Claude が実行する**（push の個別確認は不要）。手順は `release` スキル

---

## Tauri IPC 規約

コマンド名は `snake_case`、フロントからは `invoke('command_name', { ...args })` で呼ぶ。

```typescript
// フロント側の呼び出し例
import { invoke } from '@tauri-apps/api/core'
const result = await invoke<PtyOutput>('pty_write', { id: termId, data: input })
```

```rust
// Rust 側のコマンド定義例
#[tauri::command]
async fn pty_write(id: String, data: String, state: State<'_, PtyState>) -> Result<(), String> {
    // ...
}
```

ストリーミングデータ（PTY stdout、Docker logs）は `emit` イベントで Rust → フロントに push する：

```rust
app_handle.emit("pty_output", PtyOutputPayload { id, data }).unwrap();
```

---

## リリース手順

リリースを頼まれたら `release` スキル（`.claude/skills/release/SKILL.md`）の手順で進める。
push・タグ・ドラフトの公開まで含めて Claude が実行する。
