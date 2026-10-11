---
paths:
  - "src-tauri/src/portable.rs"
  - "src/lib/portable.ts"
  - "scripts/package-portable.sh"
  # ここから下は、破るとポータブル版でだけ静かに壊れる規範の相手（データの置き場と
  # identifier、project.json のパスの欄、登録の入口）。
  - "src-tauri/src/types.rs"
  - "src-tauri/src/project/**"
  - "src/types/project.ts"
  - "src/stores/project.ts"
---

# ポータブル版 実装ルール

インストールせずに使える配布形（#451）。実行ファイルのフォルダの中に設定とデータをすべて持ち、
ホストの OS には何も登録しない。**対象は Windows だけ**（macOS は見送り）。

**判断の正本は `src-tauri/src/portable.rs` のモジュール doc**（判定を目印のファイルにした理由、
identifier をフォルダごとにした理由、変わるものと止めるものの一覧）。ここには、ほかの領域を
触る人が踏まないための規範だけ置く。

## 判定

- **実行ファイルの隣に `portable.txt` があればポータブル版**（`portable::get`）。バイナリは
  インストール版と同じ 1 つで、別ビルドも Cargo の feature も持たない
- **Rust の判定は `AppHandle` にも `tauri::Context` にも依らない。** `pike agent-hook` は Tauri を
  起動せずに終わる（`main.rs`）ので、本体と同じ答えをそこでも出す必要がある
- **フロントは mount の前に 1 回聞いて、あとは同期で答える**（`lib/portable.ts` の
  `isPortable` / `portableBase`、聞くのは `main.ts`）。`lib/window.ts` の `elevated` のように
  あとから ref に入る形にしないこと: base と同期先はストアの生成時に決まる

## データの置き場と identifier

- **置き場は `<フォルダ>\data`。** Tauri のパス API を通るもの（プロジェクト・ウィンドウの位置・
  ログ・WebView2 のユーザーデータ＝localStorage の設定）は `portable::apply` が設定を
  差し替えて動かす。**通らないものは `types::pike_config_dir_for` が動かす**（hook の申告と
  レートの報告、同梱の mod、`window_geom::prune_plugin_state`）
  - **データの置き場を足すときは、このどちらかを通す。** `APPDATA` や `LOCALAPPDATA` を
    直に読むと、ポータブル版だけがホストへ書く
  - **書けなければ起動をやめる**（`lib.rs` の `fatal_startup_error`）。`%APPDATA%` へ逃がさない
- **identifier はフォルダのパスから作る**（`portable.rs` の `identifier_for`）。single-instance の
  プラグインは実行時の `app.config().identifier` を読み、`wait.rs` と hook の通知は
  `types::app_identifier` を読むので、**両方がポータブルの値を返す**。identifier を
  コンパイル時の定数として読む箇所を足すと、ポータブル版でだけ相手を見つけられなくなる
- **hook の申告の置き場はインストール版と共有しない**（`agent_hook.rs` の `STORE_IDENTIFIER` は
  開発版とインストール版で 1 本を共有するための固定値だが、ポータブル版は `data` に置く）

## プロジェクト

- **base は実行ファイルのフォルダに固定**（`stores/settings.ts` の `projectBase`。保存しない）
- **登録できるのは base と同じか、その下だけ。** 正本は Rust（`portable::can_register`。
  `project.json` を書く `project/mod.rs` の `serialize_config` が断る）で、フロントの
  `stores/project.ts` の `canRegisterRoot` は入口を畳んで理由を出すための写し
  - WSL のディレクトリも base の外の Windows のディレクトリも、**登録せずに開くことはできる**
    （#230 の一時プロジェクト）。登録の入口を足すときは `canRegisterRoot` を見る
- **`project.json` のパスは base からの相対で書く**（`portable::to_disk` / `from_disk`。
  綴りは `pike-portable:` ＋ `/` 区切り）。フォルダごと移してドライブレターが変わっても開ける
  - **`project.json` を読むのは `parse_config`、書くのは `serialize_config` の 1 か所ずつ。**
    ここを通さずに読むと、相対のままの root が出て行く
  - **パスを持つ欄を足したら `project/mod.rs` の `map_paths` にも足す**（今は root、エディタの
    タブのパス、`agentSession.dir`）。足さないと、その欄だけ移した先で古いパスを指す
  - localStorage にある絶対パス（最近開いたファイル、ツリーの展開状態など）は付け替えない。
    移した先では古いパスとして残るが、どれも見つからなければ何もしない類のもの

## 止めてあるもの

ホストに登録が残る機能は、ポータブル版では入口で断る。**Rust の入口が正本**で、フロントは
項目を出さないだけ（設定画面の `portable` の `v-if`）。

| 機能 | 断る場所 | 理由 |
|---|---|---|
| デスクトップ通知 | `toast::toast_notify` | スタートメニューのショートカットと HKCU の `pike:` スキームが要る。スキームはインストール版の登録を上書きする |
| ジャンプリスト | `jumplist::refresh` | Windows がユーザープロファイルに覚える。トレイのメニューは残す |
| ログイン時の起動 | `autostart::autostart_set` | `Run` キーに実行ファイルのパスが残る |
| `settings.json` への hook の登録 | `agent_hook.rs` の `edit_settings` | 同梱の mod だけを使う。書く行は実行ファイルの場所に依存する |
| セルフアップデート | `lib.rs` の `run`（updater のプラグインを載せない）と、`useUpdater` の `supported` | インストーラを落として走らせる仕組みなので、適用するとインストール版が入る |
| 設定の同期 | `stores/sync.ts` の `loadTarget`（同期先を「なし」と読む） | 同期先と baseline はマシンごとの値。エクスポートとインポートは残す。**Rust に止める場所は無い**（読み書きのコマンドをエクスポートとインポートも使う） |
| OS の通知（トレイへ畳んだときの初回ヒント） | `lib/notify.ts` の `resolveNotifier` | 通知の送り主としてホストに記録が残る。代わりの知らせは無い（畳んだ時点でウィンドウが見えない） |

- **ホストへ登録する機能を足すときは `portable::ensure_installed` を入口に置く**（`Result` を
  返せない入口は `portable::is_portable` を見る）。フロントの `v-if` だけにすると、IPC を
  直に呼ばれたときに書く。止めてある箇所は、この 2 つを読む側を引けば洗い出せる
- 残してあるもの: トレイ（実行中だけのアイコン）、管理者として開き直す、`pike` CLI
  （ユーザーの PATH には入らないが、Pike のターミナルの中ではプロセスの PATH に入る）、
  同梱の mod（ターミナルの環境変数で読み込ませるだけ）

## 配布

- zip は `scripts/package-portable.sh`（`just package-portable`）が作る。中身は `pike.exe`・
  `rg.exe`・`portable.txt` を `Pike/` の 1 フォルダに入れたもの。**ファイルは名指しで入れる**
  （`target/release/` には検証用の `verify_*.exe` も並ぶ）
- リリースのワークフローが tauri-action の直後に作ってドラフトへ足す（`build.md` の「CI/CD」）。
  署名と `latest.json` には載せない
- **WebView2 ランタイムは同梱しない**（インストーラは無ければ導入するが、zip にはその段が無い）。
  Windows 11 は標準で持つので、マニュアルに前提として書いてある
