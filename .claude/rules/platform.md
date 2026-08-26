# プラットフォーム対応ルール（Windows / macOS）

Pike の第一ターゲットは Windows で、macOS は**ローカルのシェルで開発できる**ところまでを持つ。
実体は `src-tauri/src/types.rs` の `ShellConfig`、`src/lib/host.ts`、`src/types/tab.ts`。

## どこで分岐するか

分岐は**シェル種別**（`ShellConfig` / `ShellType`）でするのが原則で、`cfg!(windows)` を撒かない。
プロジェクトはウィンドウごとに開かれ、そのシェルがパスの作法を決めるため。`cfg` を使うのは
「その OS に API そのものが無い」ものだけ（COM・DWM・WM_COPYDATA・`std::os::windows`）。

- `ShellConfig::Unix { program }` … macOS / Linux ホストのローカルシェル。`program` はログイン
  シェルの絶対パスで、**空にしておくのが既定**（実行時に `$SHELL` を見る。焼き込むと
  ログインシェルを変えたあとも保存済みのタブが古いシェルを起動する）
- **`_ =>` を「Windows である」の意味で使わないこと。** 既存の `match` は WSL とそれ以外の
  2 分岐で書かれていて、`Unix` は黙って Windows 側へ落ちる。判定は次の 2 つで行う:
  - `is_posix()` … 引用・パス区切り・null デバイスが POSIX か（`Wsl` と `Unix`）。
    **`GitBash` は含めない**（引用は bash だが扱うパスは Windows のもの）
  - ファイル I/O は「WSL かどうか」だけ。`Unix` はホスト自身なので `fs/mod.rs` の
    `std::fs` 側の腕にそのまま乗る（WSL だけが `wsl.exe` 越しにコマンドで運ぶ）
- `ShellConfig::host_default()` … シェル指定が無いときの既定（Windows は PowerShell、
  他はログインシェル）。プロジェクト作成・CLI・一時プロジェクトが通る
- フロントのホスト判定は **`src/lib/host.ts` の `isWindowsHost` だけ**。判定は WebView の
  User-Agent で行う（`@tauri-apps/plugin-os` を足さない方針。`defaultShellProfiles` のように
  同期で答えが要る場所から呼ばれるので、IPC にすると起動直後だけ別の一覧が出る）

## PATH（macOS でいちばん踏みやすい落とし穴）

**Finder / Dock / `open` から起動した macOS の GUI プロセスは `launchd` の最小 PATH
（`/usr/bin:/bin:/usr/sbin:/sbin`）しか持たない。** `git` も `rg` も `claude` も解決できない。
ターミナルから `just dev` すると開発者のシェル PATH を継ぐので、**開発中はまったく再現せず
インストール版だけで壊れる**。

- 対策は `main.rs` の先頭で呼ぶ `types::augment_process_path()`。`UNIX_EXTRA_PATH` のうち
  実在するディレクトリをプロセスの PATH に足す。**スレッドが立つ前に呼ぶこと**（`set_var` は
  プロセス全体を触る）
- 呼び出しごとに PATH を組み立てる（`run_shell_line_env` 等）だけでは足りない。`ShellConfig` を
  通らない直接 spawn（PTY・エージェント・updater）が取り残される
- ログインシェルに `$PATH` を聞く方式（VS Code のやり方）は採らない。起動のたびに対話シェルを
  1 本起こすことになり、rc が `exec tmux` する環境で固まる
- 判断は純粋関数 `augmented_path_with` に置いてテストしてある（`set_var` を触るテストは
  互いに干渉するため）
- 対話ターミナルは別経路で解決している。`pty_spawn` の `Unix` は**ログインシェル（`-l`）**で
  起動するので、rc / profile を読んで本来の PATH になる

## macOS で持たない機能

いずれも Windows 専用 API に依存する。**stub を置いて呼び出し側は分岐させない**
（`lib.rs` の `#[cfg(not(windows))] mod ...` が何もしない実装を持つ）。

| 機能 | 理由 |
|---|---|
| ジャンプリスト（#160） | `ICustomDestinationList`（COM）。Dock メニューは別物 |
| タブバーへの OS ファイルドロップの実パス解決 | WebView2 の `ICoreWebView2File`。WKWebView に相当物が無い |
| 管理者ターミナル（#138）・`--wait` の WM_COPYDATA 転送 | すでに `elevate.rs` / `wait.rs` が cfg 済み |
| ウィンドウ背景の透過・アクリル（#162） | `transparent` は `macos-private-api` feature が要るのでビルダーにメソッドが生えない。不透明で生成する |

`busy` 判定（#178）は**代替がある**ので実装してある: WSL の `/proc/*/environ` マーカー走査に
あたるものが、ローカル Unix では `pgrep -P <pid>`（PID が同じ名前空間にあるので
マーカーが要らない）。

**ターミナルの cwd 追跡（OSC 7）は macOS では動かない。** `TerminalTab.vue` の `isBash` が
仕込む `PROMPT_COMMAND` と `trap DEBUG` は bash 固有で、macOS の既定シェルである zsh では
文法が違う（`precmd` が相当）。`unix` を `isBash` に入れると zsh にエラーを流し込むので、
**入れないのが正しい**。影響は `pty_get_cwd` を使う機能（プロジェクト作成時の cwd 検出、
Claude のセッション一覧の参照先）がタブ生成時の cwd に留まること。zsh 用の `precmd` を
足すなら、シェルの実体を見て分岐する必要がある（既定の `Unix { program: "" }` は実体を
持たないので、まず `$SHELL` を解決するところから）。

## ダイアログ

フォルダ / ファイル選択は Windows が PowerShell + WinForms、macOS が `osascript` の
`choose folder` / `choose file` / `choose file name`（`lib.rs`）。**キャンセルの見分け方が違う**:
PowerShell 版は「空文字」、`osascript` は「終了コード 1」なので、成功したときだけ stdout を見る。

## rg サイドカー

`externalBin` は**ビルド対象のトリプルを接尾辞に持つファイル**を必ず要求するので、
`binaries/rg-<triple>` が無いとバンドル直前に落ちる（Rust のコンパイルは通っているのに
`resource path ... doesn't exist` で止まるので、原因が分かりにくい）。`scripts/download-rg.sh`
は既定で `rustc -vV` のホストトリプルを見る（クロスビルドは `TARGET` を明示）。
Windows は zip・それ以外は tar.gz と、アーカイブ形式も接尾辞の `.exe` の有無も変わる。
