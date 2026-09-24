---
paths:
  - "src-tauri/src/diagnostics/**"
  - "src-tauri/src/tasks.rs"
  - "src/stores/diagnostics.ts"
  - "src/stores/tasks.ts"
  - "src/types/diagnostics.ts"
  - "src/types/tasks.ts"
  - "src/components/panels/DiagnosticsPanel.vue"
  - "src/components/panels/TasksPanel.vue"
  - "src/lib/editorDiagnostics.ts"
---

# 診断パネル（Problems）とタスクランナー（Tasks）実装ルール

どちらもプロジェクトのツールチェインを外部コマンドとして叩くサイドバーのパネル。
実体は `src-tauri/src/diagnostics/mod.rs` と `src-tauri/src/tasks.rs`。

## 診断パネル（Problems）
- **常駐 LSP は持たない**（「軽さ最優先」）。`src-tauri/src/diagnostics/mod.rs` が検出したツールチェインの CLI を**オンデマンドで 1 回**走らせ、構造化出力をパースして `Diagnostic` に正規化する
  - Rust: `cargo check --message-format=json`（stdout の JSON Lines）/ Go: `go vet ./...`（stderr のテキスト）/ TS・JS: `tsc --noEmit --pretty false`（stdout のテキスト）
  - マニフェスト（`Cargo.toml` / `go.mod` / `tsconfig.json`）の探索深さは `MAX_DEPTH`=4。コマンドは**そのマニフェストのディレクトリ**で実行するので、出力のパスがそのまま解決できる
  - 冷えた `cargo check` / `tsc` は遅いので `TIMEOUT_SECS`=180。UI が溢れないよう `MAX_DIAGNOSTICS`=2000 で打ち切る
  - 結果は `ProviderRun`（プロバイダ名 / 実行ディレクトリ / **実行したコマンド** / ok / error / 件数）も返し、パネルのヘッダで失敗したチェッカーを提示する（`title` にコマンドとエラー文。コマンドはプロジェクト側で上書きできるので、名前だけでは何が走ったか分からない）
  - `Task.command` は `Option`。**既定は `None`＝worker 側で解決**で、`golangci` だけ go.mod を読んだついでに確定済みの値を載せる。`ts` の vue-tsc プローブ（WSL では 1 dir につき `wsl.exe` 1 回）は worker で走らせないと並列性を失い、tsconfig の数だけ直列の待ちが増える
- **golangci-lint（#213、opt-in）**: Go モジュールに `.golangci.{yml,yaml,toml,json}` が同階層以上にある、または go.mod が golangci-lint を参照していれば対象（`golangci_tasks`）。**検出は毎回・実行は要求時だけ**で、`diagnostics_run(shell, root, golangci)` の引数と結果の `golangciAvailable` で分ける（モジュール全体の型検査を伴い他のチェッカーより重いため、自動更新に常時混ぜない）
  - 起動方法は go.mod 由来（`go_mod_golangci` がコマンド文字列を直接返す）: Go 1.24 の `tool` ディレクティブなら `go tool golangci-lint run ./...`、それ以外で名前が出てくれば PATH 上のバイナリ。go.mod は `crate::fs::batch_read_files` で**全モジュールを 1 回の wsl.exe 往復**で読む（トグルが OFF でも可否判定に go.mod が要るので Go プロジェクトでは毎回 1 往復かかる。秒単位のチェッカーの隣なので許容している）
  - **コマンド上書き（`ProjectConfig.golangciCommand`）**: lint の入口が Docker にあるプロジェクト向け（`docker compose exec -T golang make lint` 等）。**上書きがあれば検出も go.mod 読みもしない**（プロジェクトが lint 方法を宣言している時点で opt-in なので、`.golangci.*` の有無を問わず go.mod のあるディレクトリ全部が対象になる）。実行ディレクトリは組み込みと同じ Go モジュールのディレクトリで、コンテナ側の作業ディレクトリにそのモジュールをマウントしていれば出力のパスがそのまま解決できる。**モジュールが複数あっても実行は 1 回**（いちばん浅いディレクトリ）: 兄弟モジュールに配ると同じコマンドが N 回走るうえ、同一の指摘が別々の base で解決されて `dedup` が畳めない（存在しないパスを指すコピーが N-1 個出る）。UI は ProjectPanel の編集フォーム（`ProjectListItem.vue`）の入力欄で、パネルのトグルの tooltip に実行するコマンドを出す。同期（#164）の共有フィールドにも入れてある（マシン非依存なため）
  - **出力フォーマットのフラグは渡さない**。JSON 出力のフラグ名が v1（`--out-format`）と v2（`--output.json.path`）で変わっており、知らないフラグを渡すと実行自体が落ちる。既定のテキスト出力は両者共通で、色は stdout が TTY でないため自動的に切れる
  - パースは go vet と同じ `path:line:col: message` なので `split_location` を共有。末尾の `(linter)` は `code` に移し、`typecheck` だけ Error（実際のコンパイルエラーのため）。**v1 が各指摘の下に流す元ソース行とキャレットは、行頭が空白かどうかで落とす**（`"a:1:2: x"` のような文字列リテラルを含む行が位置行として通ってしまうため。指摘行は必ずパスで始まる）
  - **未インストールを「問題なし」に見せない**: `ProviderSpec.optional_binary`（golangci だけ true）が立っていると、終了コード != 0 かつパース結果 0 件のとき stderr の 1 行目を `ProviderRun.error` に出す。issue 検出時も非 0 で終わるので、パース結果 0 件が「そもそも走らなかった」の目印になる。cargo / go vet / tsc も同じ死角を持つが、既存プロジェクトの表示を変えることになるので false のまま据え置いている
- フロントは `stores/diagnostics.ts` + `panels/DiagnosticsPanel.vue`。パネルを開いた時に未実行なら `run()`（`lastRunAt` で判定）。行クリックで該当箇所をエディタで開き、ホバーの 🤖 で修正依頼をターミナルへ注入（`useTerminalInject`）。エディタ側のインライン下線は `lib/editorDiagnostics.ts`。`golangciAvailable` のときだけ出る golangci-lint トグルは `localStorage` の `pike:diagnostics-golangci` に**プロジェクト id の配列**で永続化する（`golangciAvailable` はプロジェクト固有なので `clear()` で落とす）。**グローバルな真偽値にしないこと**: パネルは初回 `run()` の応答で可否を知るので、フラグが立っていると別プロジェクトを開いてパネルを出した瞬間に、そのプロジェクトの（コンテナ実行かもしれない）lint が同意なしに走る

## タスクランナー（Tasks パネル）
- `tasks` サイドバーパネル。`src-tauri/src/tasks.rs` の `task_discover` がプロジェクトルートを**最大深さ 5**（`MAX_DEPTH`）で再帰走査し、`package.json` / `Makefile` / `justfile` / `deno.json` / `Cargo.toml` を検出
- **npm scripts と deno tasks の並びは、そのファイルに書いてある順**（アルファベット順ではない）。`serde_json` の `preserve_order`（#299 で `settings.json` のキー順を保つために入れた）はクレート全体に効くので、`Value` の object を `iter()` で回すここにも波及する。**意図した並びなので戻さない**（書き手が並べた順のほうが読みやすい）が、あの feature を外すとアルファベット順に戻る
- **cargo（#122）**: 標準サブコマンド build/check/test/clippy/fmt + `[[bin]]` ごとの `run --bin {name}` を合成する。パースは `toml` クレート
  - **Tauri 判定はマニフェスト隣の `tauri.conf.json` の存在**（tauri-cli 自身の契約。依存名スキャンだとプラグイン開発リポジトリ等で誤検出）で `tauri dev`/`tauri build` を追加。`src/main.rs` があれば `run`（`[[bin]]` 併存時は `run --bin {package名}`）。`tauri.conf.json`/`main.rs` は existence-only マーカーとしてグロブに含め content は読まない
  - **workspace メンバーは標準セットを出さない**（ルートと重複して洪水になるため。bins/tauri/run のみ）。`[package]`/`[workspace]` を持たない Cargo.toml は対象外
  - bin/package 名は Makefile と同じ文字種検証（英数 `-_.`）でシェルメタ文字注入を防止
- どの種類も「グループ」として一覧表示する（ラベルに相対ディレクトリ名を付与）。vendor/ 配下は全タスク検出から除外、読み込みは `MAX_TASK_FILES`=300 で打ち切り
- **パッケージマネージャの判別**: `package.json` の scripts は npm 決め打ちではなく、`node_runner_for` が npm / pnpm / yarn / bun を選ぶ（`RUNNER_COMMANDS` が `pnpm run {name}` などを組む）。優先順は (1) そのファイルの `packageManager` フィールド（corepack。パッケージ自身の宣言なので最優先。`pnpm@9.1.0` の名前部分だけ見る）、(2) **直近の祖先**にある lock ファイル、(3) npm。**祖先方向に辿るのが要点**で、pnpm モノレポでは lock がリポジトリ root にしか無く、配下の `packages/*/package.json` は自分のディレクトリを見ても分からない。lock ファイルは cargo の `tauri.conf.json` と同じ existence-only マーカー（`pnpm-lock.yaml` / `pnpm-workspace.yaml` / `yarn.lock` / `bun.lockb` / `bun.lock` / `package-lock.json`）で、中身は読まない。同じディレクトリに複数あるときは `rank` の高いほうを採り、**`package-lock.json` を最も弱くする**（pnpm へ移行しても消し忘れて残りがちなため）。祖先判定は文字列の前方一致だけでは足りず区切り文字まで見る（`/repo/app2` は `/repo/app` の配下ではない）
- **just（#231）**: `parse_justfile` が justfile を自前でパースする（`just --summary` を叩かない。**just 未インストールでも一覧が出る**し、他の runner と同じ「見つけたファイルを `batch_read_files` で 1 回まとめて読む」に乗る＝WSL への往復が増えない）。レシピ行は「インデントされていない行のうち、クォートの外に `:` を持つもの」で、`x := "y"` の代入・`alias b := build`・`set shell := [...]` は `:` の直後が `=`、`import 'x'` / `mod sub` はそもそも `:` を持たないので落ちる。`_` 始まりと `[private]` 属性は出さない。ファイル名は just と同じく大小文字の変種（`justfile` / `Justfile` / `JUSTFILE` / `.justfile`）を並べる（rg の glob と WSL の `find -name` は大小を区別する。`.justfile` は隠しファイルだが `--hidden` は `.cargo/` 用に既に付いている）
- **doc comment を表示に使う**（#231）: just はレシピ直前の `#` コメント（`just --list` が右に出すもの）を `DiscoveredTask.description` に入れる。パネルはこれを名前の右に薄く出し、QuickOpen の `>` モードでは `command` の代わりに出して**絞り込みの対象にも入れる**（日本語で書いたコメントから引ける）。名前だけでは何をするレシピか分からないため。`command` は `just bump VERSION` のような**引数込みの呼び出し行**にしてあり（実行されるのは `RUNNER_COMMANDS` が名前から組む `just bump` なので）、引数が要るレシピはツールチップで分かる
- **説明の出どころは 3 つ**: justfile の doc comment（上）、deno.json のタスクの `description`、package.json / deno.json の `"//name"` というコメント用のキー。パネルと QuickOpen はどれも同じ `description` として扱うので、増やすときに触るのは `tasks.rs` だけ
  - **`//` は npm の仕様ではない。** `npm run` の一覧にそのまま並び、`npm run //build` は**コメント本文をシェル行として実行する**。JSON にコメントを書けないことへの民間の回避策にすぎないので、**タスクとして並べると押した先が必ず壊れる**。一覧から落として同名スクリプトの説明に回す。判断の実体は `comment_key_target` の doc が正本
  - **普及しているとは言えず、用法も揃っていない**ので、期待しすぎないこと。「一時的に無効化したスクリプトの退避先」として使う例もあり（`"//test": "xo && ava && tsd"`）、字面から意図は読めないので区別せず、退避されたコマンドが説明欄に出るのは許容する（**実行できない行が一覧から消える利得のほうが大きい**）。ただし **QuickOpen の `>` モードでは説明が呼び出し行を置き換える**（justfile のための既定）ので、そのプロジェクトでは実際に走るものと違う字面がパレットに出る。パネルのツールチップには両方出る
  - **deno.json のオブジェクト形式は仕様のほう**（Deno 2 の `{ description, command }`）。文字列形式しか見ないと、この形式のタスクが丸ごと一覧から消える。`command` を持たない依存だけのタスク（`dependencies`）も `deno task` からは走るので、コマンドを空にして一覧には出す。両方あるときは宣言された `description` を採る（コメント用のキーは書き手の間に合わせなので）
- **cargo alias**: `.cargo/config.toml` の `[alias]` を検出し `cargo {alias名}` タスクとして表示。同じベースディレクトリ（`.cargo` の親）に Cargo.toml があればその cargo グループの**先頭**にマージ（同名の合成タスクは除去。alias は builtin を上書きできないため実行結果は同一）、なければ独立グループ「cargo alias」。alias 名は `is_safe_cargo_name` で検証（シェルに渡るのは名前のみ）、値（string / string 配列）は tooltip 表示用の展開コマンドにのみ使用。検出は rg なら `--hidden -g '!.git'` + `**/.cargo/config.toml` glob（隠しディレクトリのため）、find/walkdir フォールバックは basename `config.toml` マッチ後に親が `.cargo` のものだけ残す（Hugo 等の無関係な config.toml は content-read しない）。ancestor 方向の alias 継承（cargo 本来の config 解決）は追わず同一ディレクトリのみ
- 除外: `IGNORED_DIRS`（一覧の正本は `src-tauri/src/fs/mod.rs`）
- `.gitignore` を尊重するのは **rg バックエンド使用時のみ**（`rg --files --max-depth 5 -g <glob>`）。rg が無く `find`(WSL)/walkdir(Windows) フォールバックの場合は `.gitignore` を見ず `IGNORED_DIRS` のみで除外するため、ネストした `package.json` がより多く出る
- タスク実行はプロジェクトのデフォルトシェルで `autoStart` + `closeOnExit`（完了でタブ自動クローズ）。サブディレクトリのタスクは正しい CWD で起動
- **グループの折り畳み（#273）**: 状態は `stores/tasks.ts` が持ち、`localStorage` のキーは**プロジェクトごと**（`pike:tasks-collapsed:{projectId}`。`fileTree` の `expanded` と同型）。`sourceFile` はルート相対なので、1 つのキーに全プロジェクトを入れると別プロジェクトの `package.json` と衝突するうえ、他のウィンドウが書いた分を読み直してから差し替える羽目になる
- グループ見出しの sourceFile クリックで定義ファイルをエディタタブで開く（#159。`taskStore.openSourceFile`、`group.cwd` + `basename(sourceFile)` で絶対パス化）
- フロント: `stores/tasks.ts` + `components/panels/TasksPanel.vue` + `types/tasks.ts`
