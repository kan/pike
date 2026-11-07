---
paths:
  - "justfile"
  - "package.json"
  - "vite.config.ts"
  - "src-tauri/tauri*.conf.json"
  - "src-tauri/Cargo.toml"
  - "src-tauri/build.rs"
  - "e2e/**"
  - "scripts/**"
  - ".github/**"
  - "src/composables/useUpdater.ts"
  - "src-tauri/src/app_log.rs"
  - "src/lib/errorLog.ts"
  - "CHANGELOG.md"
---

# ビルド・CI・配布ルール

開発ビルドの起動、本番ビルド限定の落とし穴、E2E スクリーンショット、CI ワークフロー、セルフアップデート。
実体は `justfile`、`src-tauri/tauri*.conf.json`、`e2e/`、`scripts/`、`.github/workflows/`。

## タスクランナー（just、#231）
- 開発タスクの入口は `justfile`。`just` でレシピ一覧、`just check` でコミット前チェック一式。版はリリース PR だけが上げる（#565。`just bump` は無くした。下の「リリース PR（tagpr）」）。CI の 3 ワークフローも同じレシピを呼ぶ（ステップは 1 レシピずつに分けてあるので、どこで落ちたかがステップ名で分かる）
- **レシピの実体は `package.json` の scripts に置いたまま**、just はその薄いファサードにしてある。tauri CLI や CI の慣習で npm 経由が要るもの（`npm run build` 等）を壊さないため。例外は `e2e-sync` 系で、こちらは `scripts/*.sh` を直接呼ぶ（理由は次の bullet）
- **`set windows-shell := ["C:/Program Files/Git/bin/bash.exe", "-cu"]` が要る**。理由は 2 つで、(1) just の Windows 既定シェルは `sh -c` だが **`sh` はこのマシンの PATH に無い**（全レシピが即座に落ちる）、(2) PATH 上の `bash` は `C:\Windows\System32\bash.exe`＝**WSL ランチャ**で、そちらには Windows 側の node / tauri / ImageMagick が無い。Git Bash を指すと E2E の画像合成が使う `magick` も PATH で解決する
- `cmd.exe /c` は候補から外した。**先頭が引用符の行を cmd が引用符ごと剥がす**ため、`"C:/Program Files/Git/bin/bash.exe" scripts/x.sh` が `'C:/Program' は…認識されていません` になる（実測）
- 別の場所に Git を入れている環境は `just --shell <bash へのパス>` で上書きする（設定値は文字列リテラルしか取れないので変数化できない）
- **シェルスクリプトは `bash script.sh` の形で呼ぶ**（`package.json` の scripts が最初からそうしている）。
  直接呼ぶとファイルの実行ビットに依存するが、**Windows の Git Bash は shebang があれば実行ビットが
  無くても走らせてしまう**ので、Windows では気付けず macOS で `Permission denied` になる。
  実行ビットも立ててあるが、呼び方のほうが本命
- CI での just 導入は `extractions/setup-just`（他の action と同じく lockfile で固定。下の「CI/CD」）

## クレジット（#420）
- About（`components/AboutDialog.vue`）に出す依存のライセンス一覧は `scripts/gen-credits.mjs` が作る `src/assets/credits.json`。**生成物を commit する**（ビルドのたびに作ると、ビルドが cargo のレジストリと node_modules の中身に依存する）
  - 集める範囲は、リリースするターゲット（Windows x64 と macOS arm64）の通常の依存でたどれるクレート、package-lock.json の `dev` でないパッケージ、ripgrep。**build / dev の依存は含めない**（配布物に入らない）。ターゲットを増やしたら `RUST_TARGETS` も直す
  - 本文を同梱していないパッケージは SPDX の標準文で補う（`standard`、版を固定した `SPDX_TEXT` から取る）。ripgrep の本文も GitHub から取るので、**作り直しはネットワークに出る**。`--check` は名前と版の集合しか見ないので出ない
  - **フロントは `?url` で資産として出して、About を開いたときに `fetch` する。** `import` すると起動時のバンドルに約 1MB 乗るうえ、`resolveJsonModule` で vue-tsc が巨大な JSON の型を推論する
- **一覧はリリース PR が作り直す**（#529。`tagpr.yml` の `credits` ジョブが作り、`scripts/release-prepare.mjs` が置き換える。下の「リリース PR（tagpr）」）。依存を更新する PR では作り直さず、**`just check` と CI にも照合を入れない**（`just check-credits` は手で確かめるとき用に残してある）。一覧は版まで持つので、配布物に入る依存の更新は patch でも必ず食い違う
  - 配布物はリリース PR をマージしたコミットから作るので、そこで作り直せば About と配布物の依存は合う。main の途中のコミットでは一覧が古くてよい
  - **CI が dependabot のブランチへ作り直した一覧を push する形は採らない**（人や bot が push したブランチは dependabot が rebase しなくなる）。照合を名前だけにする形も採らない（About に古い版が出たままになる）

## 開発ビルド
- `just dev`（= `npm run tauri:dev`）で開発版を起動（`tauri.dev.conf.json` で identifier を `com.pike.dev.debug` に上書き）
- インストール版 Pike (`com.pike.dev`) と開発版 (`com.pike.dev.debug`) は single-instance が別扱いになるため共存可能
- `import.meta.env.DEV` が true の場合、ウィンドウタイトルに `[DEBUG]` プレフィックスを付与
- トレイアイコンも同じ表記で見分ける（`tray::app_label` が「Pike [DEBUG]」を返し、ツールチップとメニュー先頭の見出しに出る）。判定は `cfg!(debug_assertions)`（`tauri:dev`）または identifier の `.debug` 接尾辞（`tauri build --config tauri.dev.conf.json` は release プロファイルなので前者では拾えない）。アイコン画像はインストール版と共通なので、これが無いとトレイ上で区別できない
- `npm run tauri dev` は identifier が本番と同一のため、インストール版と競合する点に注意
- **`BrowserTab.vue`（#368）をホットリロードしたら、開発版を再起動する。** 作り直された
  コンポーネントが新しいラベルで子 webview を作り、古いほうはウィンドウに残るので、
  タブを切り替えても消えないページが出る（開発版だけの症状）

## リンク時間

**開発の内側ループのコストはリンクで、その大半はデバッグ情報の生成。** `Cargo.toml` の
`[profile.dev.package."*"] debug = false` で依存クレートのぶんだけ落としてある。

Windows・debug・`main.rs` を触っての増分リビルドで実測した値（リンカ自身の計測。
wall-clock は全再ビルドでディスクキャッシュが動くと 20% ほど揺れるので当てにしない）:

| | リンク時間 | 増分リビルド | `pike.pdb` |
|---|---|---|---|
| 依存もフルのデバッグ情報 | 2,986 ms | 5,424 ms | 281 MB |
| 依存のみ `debug = false`（現在） | 1,860 ms | 4,195 ms | 144 MB |
| ＋自分のクレートも `line-tables-only` | — | 3,852 ms | 65 MB |

同一セッションで PDB 生成そのものを止めた（`/DEBUG:NONE`）ときのリンクは 1,090〜1,178 ms。
つまり**リンク時間の 65〜75% がデバッグ情報**で、残りの約 1.1 秒（入力読み込み・GC・
レイアウト・出力）は動かせない。

- **`line-tables-only` まで進めない**。さらに 8% 縮むが、自分のコードの変数がデバッガで
  見えなくなる。効果に対して失うものが大きい
- **リンカは替えない**。`link.exe` 3.03 秒に対し `rust-lld`（lld-link）2.99 秒で誤差の範囲。
  どちらも同じ量の PDB を作るので当然で、リンカを替えても PDB の話は解決しない。
  なお `-C linker-features=+lld` は `-C help` に出るが実際は nightly 専用で、stable で
  使うなら `-Clinker=<sysroot>/lib/rustlib/<target>/bin/rust-lld.exe -Clinker-flavor=lld-link`
- **macOS で mold は使えない**（ELF 専用で Mach-O は対象外）。`zld` はアーカイブ済みで、
  macOS の既定リンカは Xcode 15 以降の新実装（`ld_prime`）。リンカ側は何もしないのが妥当で、
  上の `debug = false` は OS 非依存に効く
- **CI では `cargo clippy` は影響を受けない**（リンクしない）。効くのは `cargo test` の
  テストバイナリのリンクと、`just build`。release は `[profile.release]` が既定で
  デバッグ情報を持たないため対象外

## リリースプロファイル

**`[profile.release]` は cargo の既定のままにしてある。** `lto = true` / `codegen-units = 1` /
`strip = true` を試して採らなかった（#458）。Windows・`tauri build --no-bundle`・フルビルドの実測:

| | `pike.exe` | Rust のコンパイル |
|---|---|---|
| 既定（現在） | 27.6 MB | 4 分 34 秒 |
| LTO ＋ `codegen-units = 1` ＋ `strip` | 25.0 MB | 10 分 25 秒 |

サイズは 9.6% しか縮まず、コンパイルは約 2.3 倍になる。リリースの待ち時間は遅いほうの OS の
ビルドで決まる（下の「CI/CD」）ので、延びたぶんがそのまま乗る。起動時間と実行速度は測っていない。
`lto = "thin"` も測っていない。

## CSP と動的スタイル注入（本番ビルド限定の落とし穴）
`tauri.conf.json` の `app.security.csp` を設定すると、**本番（埋め込み）ビルドでのみ** Tauri が `style-src` / `script-src` に nonce/hash を注入する（`tauri` クレートの `manager::set_csp` → `replace_csp_nonce`）。CSP 仕様上、**nonce か hash が directive に 1 つでも入ると同 directive の `'unsafe-inline'` は無視される**。

- **症状**: xterm（ターミナルの色・フォント）と CodeMirror（style-mod で実行時に `<style>` を注入。エディタ本文・シンタックス色）が実行時注入するスタイルが全滅する。ターミナルは色/フォント崩れ、エディタは本文が消えて**行番号ガターだけ**残る。**dev（`tauri:dev`）は Vite 配信で nonce/hash 注入が走らないため再現しない**＝「本番ビルドだけ崩れる」形になる
- **対策**: `app.security.dangerousDisableAssetCspModification: ["style-src"]` を設定し、**style-src への nonce/hash 注入だけを止めて `'unsafe-inline'` を有効に保つ**（CodeMirror/xterm 等の CSS-in-JS 系ライブラリ向けの Tauri 標準の対処）。`script-src`（XSS 対策の要）の nonce/hash 注入は維持する。config の型は `DisabledCspModificationKind`（`bool` または directive 名の配列）、キーは `deny_unknown_fields` なので誤字はビルドエラーになる
- **切り分けの注意**: この不具合は dev で再現しないため、原因調査は**本番ビルドで**行う必要がある。加えて、同一 identifier（`com.pike.dev`）のインストール版が起動中だと single-instance で新ビルドの起動が既存インスタンスに転送され、**古い壊れた画面を検証してしまう**。切り分け時は `--config tauri.dev.conf.json`（identifier を `com.pike.dev.debug` に）を付けて `tauri build` し、併存起動できる別 identifier ビルドで確認するのが確実。埋め込み後の実 HTML/CSP は `target/release/build/pike-*/out/tauri-codegen-assets/*.html`（brotli 圧縮、`zlib.brotliDecompressSync` で復元可）で確認できる
- **`index.html` にインライン `<style>` を置かない**のが安全側（Tauri がその hash を style-src に足して同じ問題を誘発しうる）。基本レイアウトは `src/assets/theme.css`（`main.ts` 先頭 import でバンドル CSS の `<link>` になり render-blocking＝FOUC も起きない）に置く

## E2E スクリーンショット自動化（#142）
マニュアル画像（`docs/manual/img/`）の自動再撮影パイプライン。詳細・設計の正本は `e2e/README.md`。

**リリース前の撮影は CI の `Screenshots` ワークフローで行う**（#506。下の「CI/CD」の `screenshots.yml`。手順は `release` スキル）。撮影・同期・リリース PR のブランチへのコミットまでジョブが行う。下の 1〜4 は、手元で撮るとき（spec を書いている途中、CI が使えないとき）の手順。**ジョブが呼ぶのは 1〜2 と `just e2e-sync`（マニュアルとヒーローの 2 本）で、4 の目視確認はリリース PR の画面で行う。**

1. `just e2e-build`: 撮影用バイナリをビルド（`PIKE_E2E=1` + `--features e2e` + `tauri.e2e.conf.json`。identifier=`com.pike.e2e` で既存 Pike / dev 版と single-instance 衝突しない）
2. `just e2e`: wdio 実行。`e2e/specs/*.ts` が ja/en × light/dark の 4 バリアントで `artifacts/screenshots/{画面}-{lang}-{theme}.png` に撮影（`artifacts/` は gitignore）。ウィンドウ寸法は 3 クラス: クローズアップ＝既定 1280×832（内枠 1266×796）、全体レイアウト系（layout.ts の `FULL`）＝1600×1000（内枠 1586×964）、**外枠付きヒーロー（`HERO` = `FULL` の 2 倍）＝3200×2000（内枠 3186×1964）**。内枠は CSS ピクセルで、**画像はそれに表示倍率 1.5 を掛けた大きさ**（クローズアップで 1899×1194 px）
   - **撮影環境の前提（表示倍率 1.5・UI は Yu Gothic UI・等幅は PlemolJP Console NF・UI の拡大率 1）は `prepare()` が毎回確かめ、食い違えば撮る前に落とす**（#466。`e2e/support/prepare.ts` の `assertCaptureEnvironment`、値は `CAPTURE_ENV`）。値は手元の撮影機（日本語の Windows・拡大率 150%）で測ったもので、CI のランナー（英語版・100%）は `screenshots.yml` と撮影用ビルドがこれに揃える（倍率は `tauri.e2e.conf.json`、UI のフォントは `SYSTEM_UI_FONT`、等幅はワークフローが入れる）。前提を変えるなら `CAPTURE_ENV`・上の寸法・CI 側の揃え方を一緒に直す
   - `HERO` は画面（手元の 3413×1440、CI の 1024×768）より大きいが、WebView2 の撮影は画面外にはみ出した分も含めて撮れるので問題ない（CI でも同じ大きさで撮れた）
   - **論理サイズを 2 倍にすると表示内容が増える**ぶん、フィクスチャが短いと下半分が空く。`HERO` を使う spec（overview / hero-editor / hero-git）のダミーデータは、この寸法で画面が埋まる量にしてある（README は 60 行超、ターミナルのセッションは 78 行、コミット履歴は 8 件）。寸法を変えたら埋まり方も見直す。**画面の中身を差し替えたときも同じ**（行数の少ないものに替えると、下半分が空いたまま README のヒーローに載る）
> `just e2e-build` の出力を `| tail` などに通さないこと。Rust のコンパイルが落ちても
> パイプ側の終了コード 0 が返り、**古いバイナリのまま撮影して気付けない**。
> ログはファイルに落として `$?` を見る。
>
> **撮影用のビルドは開発版と同じ `target/debug/pike.exe` を差し替える。** 開発版
> （`just dev`）や以前の撮影が動いたままだと、コンパイルは全部通ったあとに
> `failed to remove file ... アクセスが拒否されました。 (os error 5)` で落ちる。
> リリース前は動作確認で開発版を起動していることが多いので、撮影の前に閉じる。
> 残っているかは `Get-Process pike` の `Path` で分かる
> （インストール版は `AppData\Local\Pike\pike.exe` なので、そちらは閉じなくてよい）。

3. `scripts/sync-manual-images.sh --check` でドライラン → 引数なしで `docs/manual/img/` へ同期。スクリプト内 `MAP` が「マニュアル名 ← E2E ベース名」を対応付け、ja の dark（`{名前}.png`）+ light（`{名前}-light.png`）の 2 枚を持つ（GitHub の `<picture>` 切替用）
4. 変更画像を目視確認してコミット

- 外枠付きヒーロー画像（README / overview の `screenshot-*`）は `scripts/sync-hero-images.sh`（内部で `frame-screenshot.sh` を呼ぶ）で合成・配置する。`sync-manual-images.sh` の MAP には含まれないため、**同期は 2 本を続けて走らせる `just e2e-sync`（確認は `e2e-sync-check`）を使う**。片方だけ走らせると、ヒーローだけ古い世代のまま取り残される
- **ヒーロー画像の合成には ImageMagick（`magick`）が要る**。マニュアル画像のコピーは要らないので、`magick` が無いと**マニュアルのぶんだけ更新されてヒーロー 6 枚が古いまま残る**（`sync-hero-images.sh` が `magick: command not found` で落ちるが、**先に走る `sync-manual-images.sh` は成功している**）。`just e2e-sync` は 2 本を続けて走らせるので、**成否は最後の行だけでなく両方の「更新 N / 同一 N」を見ること**
  - **クリーンな環境には入っていない。** `winget install ImageMagick.Q16-HDRI` で入れる（`magick` は `AppData\Local\Microsoft\WindowsApps` の実行エイリアスとして PATH に入り、Git Bash からそのまま解決する）
  - 入っている環境では Windows 側にあり **WSL の PATH には無い**ので、WSL の bash で回すとここで止まる。`just e2e-sync` は Git Bash で走るので解決する（#231）
- 撮影画面を追加したら `e2e/specs/` に追記し、マニュアルで使う場合は `sync-manual-images.sh` の MAP にも対応を追加
- **MAP に足し忘れた画像は「撮っているのに使われない」まま溜まる。** `check-docs` は
  「マニュアルが参照する画像が実在するか」と「参照されない画像が `docs/manual/img/` に残っていないか」は
  見るが、`artifacts/screenshots/` にしか無いものには気付けない。差分を見るには
  `comm -23 <(grep -rhoE "shoot\('[a-z0-9-]+'" e2e/specs/*.ts | sed "s/shoot('//;s/'//" | sort -u) <(grep -oE '"[a-z0-9-]+:[a-z0-9-]+"' scripts/sync-manual-images.sh | sed 's/.*://;s/"//' | sort -u)`
  （`overview` と `hero-*` は `sync-hero-images.sh` の担当なので出てきてよい）
- **待ち合わせに使うセレクタは `data-testid` を足す。** クラス名は見た目の都合で変わるが、
  testid は撮影のための契約として残る（例: `diagnostics-panel` / `git-operation`）
- **画像には StatusBar のバージョンが写る**。`useUpdater` の `getVersion()` は `@tauri-apps/api` 経由で `tauri.conf.json` の version を読むため、`lib/tauri.ts` の invoke ラッパを通らず **E2E のモックでは差し替えられない**（`tauri.e2e.conf.json` で version を上書きするのは 2 箇所 bump の drift 要因なので採らない）。リリースに合わせて撮り直すときは **bump 済みのツリーで撮る**（bump 済みのリリース PR のブランチで撮影 → 同期 → マージでタグ の順）
- ドロップダウンやトースト等、アニメーションを含む UI は**静止するまで待ってから撮る**（例: リモートブランチ取得中の `.spin-icon` が残ると実行ごとに回転角の差分が出る）。撮影に安定したセレクタが必要な場合は `data-testid` を足す（`worktree-selector` / `branch-selector`）
- 撮影コードを本番ビルドに混入させない仕組み（`e2e` Cargo feature / vite define `__PIKE_E2E__` / `capabilities-runtime` の実行時登録）は `e2e/README.md` を参照
- **`@wdio/tauri-service` / `@wdio/tauri-plugin` を上げたら、`package.json` の `overrides` の `@wdio/native-utils` を、
  その版が宣言する版に合わせる**（`npm view @wdio/tauri-service@<版> dependencies.@wdio/native-utils`）。固定は
  2 つのパッケージ（と `@wdio/native-core`）の宣言の食い違いをそろえるためのもので、宣言が上がると古い固定の
  ほうに新しい関数が無く、**撮影が起動の時点で落ちる**（v0.65 の 2.8.0、v0.70 の 2.8.1 で 2 回踏んだ）。
  **E2E は `just check` にも PR の CI にも入っていない**ので、dependabot の CI が通っても気付けない。
  取り込んだら `npm ls @wdio/native-utils` で 1 つの版にそろっていることを見る

## ログファイル（#415）
- **インストール版でもログをファイルに書く**（`src-tauri/src/app_log.rs`）。リリースビルドは DevTools を開けず（`devtools` feature を入れていない）、以前はプラグインを開発版でしか登録していなかったので、Rust の `log::warn!` もフロントの例外もどこにも残らなかった（#411 が再現も調査もできなかった理由）
  - 置き場は `app_log_dir`（Windows は `%LOCALAPPDATA%\{identifier}\logs\Pike.log`）。開発版（`com.pike.dev.debug`）とインストール版（`com.pike.dev`）は identifier で分かれる。標準出力にも出すのは開発版だけ
  - **レベルは全体を Warn、Pike 自身（`app_lib`）だけ Info**。依存クレートの Info まで書くと、何も起きていないときもファイルが伸びる
  - **panic も書く**（`log_panics`）。コマンドの中で panic すると invoke が戻らないまま残り、下の「戻らない」の行だけが残って原因が分からない。既定の hook は後ろに繋ぐ
  - **サイズと世代は明示する**（`MAX_FILE_SIZE` / `KEEP_ROTATED`）。プラグインの既定は 40KB・`KeepOne` で、スタックトレースを数件書けば回り、回った瞬間に直前のログが消える。時刻も既定は UTC なのでローカルにしてある
  - **登録は `setup` の先頭で、失敗しても起動を続ける**（`app_log::init`）。Builder に `.plugin()` で載せると、フォルダを作れない・ファイルを開けない・起動時のローテーションで rename できない、のどれでも `run` の `expect` まで届いて Pike が起動しなくなる。`setup` は single-instance の初期化より後なので 2 つ目に起動したプロセスはログファイルを開かずに終わり、先頭なので `setup` の途中の `log::warn!` も拾える
  - **`--new-instance`（管理者として開き直したプロセス、#138）は `Pike-elevated.log` に書く**。single-instance を通らず元のプロセスと並んで動くので、同じファイルだと互いのサイズの数え方がずれ、片方のローテーションがもう片方の書いているファイルを動かす
- **フロントの例外は `lib/errorLog.ts` の 3 つの受け口**（`error` / `unhandledrejection` / Vue の `errorHandler`）から `log_frontend` へ流す。Vue の中の例外は前 2 つに届かないので 3 つとも要る。`errorHandler` を置くと Vue は自分で console に出さなくなるので `console.error` を続けて呼ぶ
  - **同じエラーは 60 秒に 1 件だけ書く**（`createThrottle`。鍵はスタックを除いた 1 行目）。描画のたびに出るエラーでファイルが膨らまないように。省いた回数は次に書く 1 件に添える
  - **`errorLog.ts` は tauri を import しない**（書き込み先を引数で受ける）。間引きと整形を Node のテストから確かめるため
  - **ログを書く失敗は捨てる**（`logFrontend`）。書けないことをまたログに書こうとすると、受け口と回り続ける
  - URL やファイルのパスはそのまま書く（伏せると調べる手がかりが消える）。外へは送らないので、共有するかは利用者が中身を見て決める。設定画面の説明とマニュアルにそう書いてある
- **子 webview への指示が 5 秒戻らないと 1 行残す**（`lib/tauri.ts` の `inOrder` と `checkStall`。見張りは鎖が動いているあいだだけ 1 本で、1 件ごとにタイマーを張らない。`browser_place` はリサイズ中に毎フレーム流れる。#411 の「`inOrder` の鎖の 1 件が戻らず、全部のブラウザのタブが止まる」説を確かめるため）。戻ったときにももう 1 行書くので、遅いだけか永久に戻らないかを分けられる。測るのは順番が来て送った時点からで、前に詰まって待たされていた時間は含めない（詰まらせた 1 件だけが名前を残す）
- 設定画面の「バージョン情報」に「ログのフォルダを開く」（`log_open_dir`。まだ 1 行も書いていなくてもフォルダを作って開く）

## セルフアップデート
- `tauri-plugin-updater` + `tauri-plugin-process` で GitHub Releases の `latest.json` を参照
- 署名キー: `~/.tauri/pike.key`（秘密鍵）、公開鍵は `tauri.conf.json` の `plugins.updater.pubkey` に埋め込み
- CI: `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` を GitHub Secrets に設定
- Settings タブの About セクションに「更新を確認」ボタン + 「更新して再起動」ボタン
- SideBar 歯車アイコンに更新通知ドット（`startBackgroundCheck` が起動時と以後 1 時間ごとに `check()` で確認）
- **確認のたびに結果を置き換える**（#414）。「更新あり」になったあとも自動チェック・歯車メニュー・設定画面のボタンは取り直す。取り直さないと、さらに新しいリリースが出ても最初に見つけた版のまま固定される。置き換えた古い `Update` は Rust 側のリソースを握っているので `close()` する。**適用中は差し替えない**（`installing`。確認ダイアログを出した時点から立てる。使用中の `Update` を閉じるとダウンロードが壊れ、ダイアログで見せた版と違う版を入れることにもなる）。取り直しに失敗しても、先に見つけた更新があれば「更新あり」のまま残す
- `bundle.createUpdaterArtifacts: true` で `.sig` ファイルを自動生成

## CI/CD
- `.github/workflows/ci.yml`: push/PR で **Windows と macOS の 2 ジョブ**（`fail-fast: false`）を回す。各ステップは `justfile` を呼ぶので、ローカルの `just check` と同じコマンドが走る
  - **Windows だけが持つのは OS に依らない検査**（`just lint` / `fmt-check` / `check-docs` / `check-shortcuts` / `test-ts` / `build-web`）。2 回走らせても同じ結果にしかならない
  - **macOS 側は `just build-web-dist`（`vite build` だけ）→ `clippy` → `test`**。`generate_context!` が `dist/` を読むので Rust の検査にもフロントの成果物が要るが、型検査は Windows 側が済ませている
  - macOS ジョブを足した理由（`cfg` の向こう側が Windows のジョブからは 1 行も見えない）は `platform.md` の「キーボードショートカット」の末尾
- `.github/workflows/tagpr.yml`: main の push で tagpr がリリース PR を作り直し、リリース PR がマージされたらタグを打って `release.yml` をそのタグで起動する（#529。下の「リリース PR（tagpr）」）。**持つのは `credits` ジョブと、kan/tagpr-scripts の共通の workflow を呼ぶジョブだけ**（#573）。tagpr を動かすこと、落ちた run でリリース PR を draft にすること、タグを annotated に打ち直すこと、`release.yml` の起動は共通の workflow が行う
- `.github/workflows/verify-lockfile.yml`: PR と main への push で `gh actions-lock --verify` を回す（#562。下の「action の固定」）
- `.github/workflows/release.yml`: **タグを ref にした `workflow_dispatch` で起動され**（#562。tagpr のワークフローが呼ぶ共通の workflow の `release` ジョブが `gh workflow run release.yml --ref vX.Y.Z` で起動する）、**権限と鍵ごとに分けたジョブ**が走る（#505 / #585）。タグは `github.ref_name` から取ってワークフローの `env.TAG` に置き、checkout は ref を指定せずに起動したタグのコミットを取る。**タグ以外の ref で起動したら `draft` が止める**。**`push.tags` は置かない**（tagpr のタグでは起動しないうえ、入口を増やすとタグの取り方が分かれる）。**`workflow_call` で tagpr の run から呼ばない**（v0.70.0 まではそうしていた）。呼ぶと run の ref が `refs/heads/main` になり、attestation の source ref もそれを名乗る。同じタグの run は `concurrency` で並べない（draft ジョブが互いのドラフトを消し合う）。`draft`（ドラフトを 1 つ作る）→ `build`（Windows と macOS(arm64) の 2 ジョブを**並列に**。コンパイルだけ）→ `bundle`（OS ごとにインストーラを作って署名する）→ `attest`（来歴の証明）と `upload`（8 つのアセットをドラフトへ上げる）→ `updater-json`（`latest.json` を組み立てて上げる）
  - **ジョブは権限と鍵ごとに分ける。依存のコードを動かすジョブには、書き込みの権限も署名の鍵も持たせない**（#585。kan/tagpr-scripts#9）。依存のコードが乗っ取られても、タグや Release の書き換え、別のものへの attestation、鍵の読み出しに届かないようにするため
    - `build`（`contents: read`、secret なし）: `just fetch-rg` → `npm ci` → `npx tauri build --no-bundle` →（Windows）ポータブル版の zip。依存の build.rs・proc macro・npm のビルドが動くのはこのジョブだけ。渡すファイルは `scripts/release-assets.mjs handoff` の一覧（`pike`、sidecar の `src-tauri/binaries/rg-<triple>`、Windows ではポータブル版の zip。zip は表の `portable` の付いた項目）で、リポジトリと同じ配置で artifact に上げる。**バンドラは crate の bin をすべて同梱する**が、検証バイナリ（`src/bin/`）は `required-features` の陰にあってリリースのビルドで作られず、バンドラも飛ばす（#587。`testing.md` の「検証バイナリの置き場」）。陰に置き忘れた bin があると `tauri bundle` が「Failed to copy binary」で落ちる（v0.70.1 までは検証バイナリが配布物に入っていた）
    - **`bundle` は `build` の出力を信用しない。** artifact を作業ツリーの外に落とし、`handoff` の一覧にあるファイルだけを、通常のファイル（symlink でない）であることを確かめてから決まった場所へ写す。一覧は checkout したリポジトリと triple から作るので、artifact の中身には左右されない。**artifact を作業ツリーへ丸ごと展開しないこと**（tar も同じ）。乗っ取られた `build` が `tauri.conf.json` や `package-lock.json` を紛れ込ませると、`beforeBundleCommand` などを通して鍵を持つ `bundle` で依存のコードが動く。upload-artifact は実行ビットを落とすので、写したあとに付け直す
    - `bundle`（`contents: read`、updater の署名鍵と Apple の鍵を持つ）: `handoff` のファイルを写す → `npm ci --ignore-scripts` → `npx tauri bundle` →（macOS）`.dmg` の公証と staple → アセットを最終の名前にそろえて artifact へ。**動くのは tauri-cli とバンドラのツール（NSIS・WiX・WebView2 の bootstrapper、Apple の codesign / notarytool / hdiutil）だけ。** `tauri bundle` が走らせるのは `build.beforeBundleCommand` だけで、`tauri.conf.json` にはそれを置いていない（**置かないこと**。置くと鍵を持つジョブで依存の JS が動く）。setup-node のキャッシュとツールチェーンを入れる action も使わない（`tauri bundle` が使う cargo は、ランナーの rustup で stable を入れる）。上流の `draft` が dry-run で skipped になるので、`if` に状態の関数を書く（暗黙の `success()` だと dry-run で飛ばされる）
    - **updater の鍵と Apple の署名を `bundle` からさらに分けない。** `.app.tar.gz` は `createUpdaterArtifacts` を有効にしたバンドラしか作らず、作るときに秘密鍵が要る（自前で作って `tauri signer sign` すると、updater が展開する形を本番の前に確かめられない）。Apple の codesign・公証・`.dmg` の作成もバンドラの流れに入っていて、外へ出すと sidecar の署名・entitlements・`.dmg` の配置を作り直すことになる。`bundle` で依存のコードを動かさないことで守る
    - `attest`（`id-token: write` / `attestations: write` だけ）と `upload`（`contents: write` だけ）は ubuntu で artifact を落とすだけで、依存のコードを動かさない
  - **`dry-run` の入力で、ブランチでも `build` と `bundle` までを確かめられる**（`gh workflow run release.yml --ref <ブランチ> -f dry-run=true`）。`draft` / `attest` / `upload` / `updater-json` は飛ばし、成果物は artifact `release-Windows` / `release-macOS` に残る。**`draft` のタグの検査は緩めない。** `build` は「dry-run か、`draft` が成功したとき」だけ走るので、タグでもなく dry-run でもない起動では何も作らない。dry-run でも本物の鍵で署名・公証するので、`release.yml` を変えたらマージの前に 1 回通す
  - **Windows の `build` はポータブル版の zip も作る**（#451。`tauri build --no-bundle` の直後に `just package-portable`）。インストーラと同じ `pike.exe` を固めるだけなので、ビルドは増えない。バンドラは作業ツリーの `pike.exe` を書き換えない（zip の `pike.exe` のバンドルの種類は、v0.70.1 も #585 の dry-run も `__TAURI_BUNDLE_TYPE_VAR_UNKE` のまま）ので、`tauri bundle` の前に作ってよい。`latest.json` には載らない。詳細は `portable.md`
  - **artifact の保持は 30 日。** 落ちたジョブだけの再実行（`gh run rerun --failed`）は前のジョブの artifact を落とし直すので、保持が切れると丸ごとやり直すしかなくなる
  - **macOS も updater の経路に載せる**（#283 の Developer ID 署名と公証が前提。未署名だと Gatekeeper に隔離される）
  - **ドラフトは `draft` ジョブが先に 1 つだけ作る。** アセットは `upload` が 1 回でまとめて上げる（並列の 2 ジョブがそれぞれドラフトを探すと、どちらも「無い」と見て 2 つ作りうる）。`draft` はタグが `vX.Y.Z` の形でないときと、`tauri.conf.json` の version と食い違うときに止める（成果物の名前は version から付くので、食い違うと別の名前のファイルが上がる）
    - **ドラフトの本文は `scripts/release-notes.mjs` が CHANGELOG の節から作る**（`## Pike vX.Y.Z` ＋節の本文）。`updater-json` はドラフトの本文を `latest.json` の `notes` に写すので、`notes` もこれになる。`latest.json` は公開前に上がって公開後は差し替えられないので、公開時に手で書いた本文では `notes` に届かない。節が無いか空なら止める
    - **同じタグのドラフトが残っていれば消してから作り直す**（ワークフローの丸ごとの再実行やタグの打ち直し）。ドラフトを常に 1 つにしておくと、タグ名で上げる `upload` と `updater-json` が同じドラフトに当たり、前の実行の `latest.json` も残らない。公開済みのリリースがあれば止める。**落ちたジョブだけの再実行では `draft` は走らない**ので、ドラフトはそのまま残る
  - **アセットの名前と性質は `scripts/release-assets.mjs` の表にだけ書く。** `bundle` の「Collect the release assets」（最終の名前で写す）、`attest`（表の `attest` の付いたものを証明する）、`upload`（表のとおりちょうどそろっているかの検査）、`updater-json.mjs`（表の `updater` の付いたものを latest.json に載せる）がこの表を引く。アセットを足すときも名前を変えるときも、直すのはここだけ
    - **名前は、`updater-json.mjs` が読むものと、これまでのリリースのアセットの名前を変えないこと。** バンドラが付ける名前のままでよいものは写すだけで、`Pike.app.tar.gz`（と `.sig`）だけを `Pike_X.Y.Z_aarch64.app.tar.gz` にする（以前は tauri-action が付け替えていた）。1 つずつ名指しして写し、欠けていれば止める（`bundle/` には配布しない `.msi.zip` なども並ぶので、グロブで集めない）
  - **`latest.json` は 1 回だけ組み立てて上げる。** 各 OS が自分の分をマージして上げ直す形（以前の tauri-action の動き）は、並列だと後から読んだ側がもう片方の書き込み前の内容を見て、そのプラットフォームを落としたファイルを上げうる。**失敗は静かで「その OS にだけ更新が来ない」という形でしか気付けない**（以前は `max-parallel: 1` の直列でこれを避け、リリースに 18 分前後かかっていた）
    - **`updater-json` は `needs: [draft, upload, attest]` で、両 OS のアセットが上がり、証明も付いたときだけ走る。** 証明が落ちたまま latest.json がそろうと、仕上がったドラフトに見えるため（Immutable releases なので、公開してから証明は足せない）。 `scripts/updater-json.mjs` がドラフトのアセットから組み立てるので、片方の OS だけが載った `latest.json` はできない
    - **中身の形は tauri-action v1 の出力（`updaterJsonPreferNsis: true`）に合わせてある。** `platforms` は `windows-x86_64`（setup.exe）/ `windows-x86_64-nsis` / `windows-x86_64-msi` / `darwin-aarch64` / `darwin-aarch64-app` の 5 つで、`url` はブラウザ用ではなく API のアセット URL（`/repos/.../releases/assets/<id>`。updater は `Accept: application/octet-stream` を付けて取りに来る）。v0.65.0 のリリースに当てて、tauri-action が作ったものと `platforms` が一致することを確かめてある。tauri-action を上げて形が変わったら、スクリプトの表（`updaters`）も直す
    - **書き出す前に、各 URL の実ファイルを落として `tauri.conf.json` の公開鍵で minisign の署名を検証する**（本体の署名、trusted comment の署名、trusted comment の `version:`）。公開後は Immutable releases で直せないので、updater が弾く `latest.json` はここで止める。gh の認証があれば手元でも `node scripts/updater-json.mjs <release-id> <出力先>` で同じことができる
    - **`build` と `bundle` は `fail-fast: false` にしてある。** どちらかが落ちれば `upload` も `updater-json` も走らないので、もう片方を止める理由が無い。落ちたジョブだけを再実行すれば済む
  - **`rust-cache` は使わない**（#505）。Actions のキャッシュは保存した ref とデフォルトブランチからしか読めず、リリースは毎回新しいタグで走るので、復元は毎回 `No cache found.` で保存の時間（1 ジョブあたり 30〜75 秒）だけがかかっていた。main の CI のキャッシュはプロファイル（dev）が違うので使えない
  - **`.dmg` は tauri が公証しない。** 公証・staple するのは `.app` だけで、そのあとに作る `.dmg` は署名するだけ。配布物は `.dmg` なので、そのままだとダウンロードした利用者の Gatekeeper が弾く（`spctl -a -t open --context context:primary-signature` が `rejected / source=Unnotarized Developer ID` を返す。macOS 実機で確認）。`bundle` で `tauri bundle` のあとに `xcrun notarytool submit` → `xcrun stapler staple` → `spctl` で確かめ、staple した `.dmg` を artifact に出す
  - **手でダウンロードする成果物には Artifact attestations（来歴の証明）を付ける**（#468。`actions/attest`）。updater は minisign、macOS は公証で守られているが、Releases から手で落とした Windows のインストーラや zip が「このリポジトリの、このワークフローで作られた」ことを確かめる手段が無かった。利用者は `gh attestation verify <ファイル> --repo kan/pike` で確かめる
    - 対象は 5 つ: Windows の `-setup.exe` / `.msi` / `-portable.zip`、macOS の `.dmg` / `.app.tar.gz`。**付けるのは `attest` のジョブだけ**で、`id-token: write` と `attestations: write` を持つのもこのジョブだけ（署名は OIDC と Sigstore の短命証明書なので、鍵の secret は要らない）。`bundle` の artifact を落として、その digest に付ける
    - **証明するのは配布するファイルそのもの。** staple は `.dmg` にチケットを書き足してダイジェストを変えるので、`bundle` は staple のあとの `.dmg` を artifact に出す。staple の前のファイルを証明すると、配布している `.dmg` の検証が通らない
    - **`.sig` と `latest.json` は対象にしない。** updater の経路は minisign の検証で足りている
    - **対象は表から名指しで渡す**（`node scripts/release-assets.mjs attest release`）。その前に `check` で artifact が表とちょうど一致することを確かめるので、欠けたファイルを黙って飛ばさない。それでも公開前に 5 つとも検証する手順が `release` スキルに入っている
    - 証明に載る名前は、`bundle` がそろえた最終の名前（リリースのアセットと同じ）になる
    - **Immutable releases（リポジトリ設定）を有効にしてある**（#468。効くのは v0.62.1 より後のリリースで、今の状態は `gh api repos/kan/pike/immutable-releases` で分かる）。公開した時点で成果物とタグが不変になり、release attestation が自動で付く（`gh release verify`）。ドラフトに成果物を揃えてから公開する流れにそのまま乗るが、**公開後は成果物の差し替えもタグの打ち直しもできない**ので、公開前の確認が `release` スキルに入っている。リリースノートの本文とタイトルは公開後も編集できる
    - **attestation の署名者は `release.yml`、source の ref はタグ（`refs/tags/vX.Y.Z`）**（#562 から。タグで dispatch するため。検証は `--signer-workflow kan/pike/.github/workflows/release.yml --source-ref refs/tags/vX.Y.Z`）。v0.70.0 までは `workflow_call` で呼んでいたので、source の ref が呼び出し元の `refs/heads/main` になっている（v0.69.0 で確かめた。証明書の Build Signer は `…/release.yml@refs/heads/main`、trigger は `push`）。それらの版を検証するときは `--source-ref` にタグを渡さない
    - **SLSA Build L3 は狙っていない。** ビルドを reusable workflow に切り出す必要がある。ジョブは権限と鍵ごとに分けてある（#585）が、`build` と `attest` は同じワークフローの中にある
  - **署名と公証の資格情報は GitHub Secrets の `APPLE_*` 7 つ**（`APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` / `APPLE_TEAM_ID` / `APPLE_API_ISSUER` / `APPLE_API_KEY` / `APPLE_API_KEY_BASE64`）。**`notarytool` は鍵をファイルで受け取る**ので、`APPLE_API_KEY_BASE64` を書き出して `APPLE_API_KEY_PATH` を `GITHUB_ENV` 経由で渡す（`APPLE_API_KEY` は鍵そのものではなく Key ID）
  - **証明書を再発行するときは Developer Portal で G2 Sub-CA を選ぶ。** Xcode の「Manage Certificates → +」が作る Developer ID は G1 CA 由来で、G1 中間 CA 自身の失効日（2027-02-01）で頭打ちになる。G2 なら通常どおり 5 年
  - `macos-latest` は Apple Silicon なので**ホストのトリプルがそのまま `aarch64-apple-darwin`**。クロスビルドの指定は要らず、`just fetch-rg` も `rustc -vV` からその名前でサイドカーを取る。Intel 向けは配布しない
- `.github/workflows/security.yml`: push/PR で `cargo audit` + `npm audit`、週次スケジュール実行
- `.github/workflows/screenshots.yml`: **スクリーンショットを Windows ランナーで撮る**（#506。`workflow_dispatch` のみ。リリースの前に `release` スキルの手順から、リリース PR のブランチを ref にして起動する）。撮影の前提（`CAPTURE_ENV`）を揃えてから `just e2e-build` → `just e2e` を流し、画像をアーティファクト `screenshots` に上げる
  - **`commit: true`（既定）なら `just e2e-sync` で同期し、差分があれば起動したブランチ（リリース PR の `tagpr-from-v<前回の版>`）へコミットを 1 つ積む**（#529）。差分が無ければ何もしない。画像はリリース PR の画面で確かめる
    - **画像に写る版は、チェックアウトしたブランチの `tauri.conf.json` で決まる。** リリース PR のブランチは bump 済みなので、その版の画像になる。**`commit` はリリース PR のブランチからしか起動できず、`any_env` と同時には使えない**（main はリリース PR のマージまで前の版のまま。前提の外れた画像は積まない）。**その版のタグが既にあれば撮る前に止める**（マージ済みのブランチを撮ろうとしている）
    - **tagpr は PR を作り直すときもこのコミットを引き継ぐ**（リリース PR のブランチに積んだ手のコミットを、作り直したブランチに載せ直す）。main の変更で UI が変わったら撮り直す
    - **コミットは撮影したコミット（`github.sha`）の上に作って push する。** 撮影の 12 分のあいだに tagpr がブランチを作り直していれば fast-forward にならずに落ちるので、起動し直す（古いツリーで撮った画像を新しいブランチに載せない）
    - **書き込みの権限（`contents: write`）はコミットするジョブ（`commit`、ubuntu）だけに付ける。** 撮影のジョブは依存（npm の postinstall、クレートの build.rs）とアプリを動かすので読み取りだけで走らせ（checkout も `persist-credentials: false`）、同期した `docs/manual/img/` をアーティファクト `manual-img` で渡す
    - **続けて起動したら前の run を止める**（`concurrency`。同じブランチへ画像のコミットを 2 つ積みうる）
    - **同期は `SYNC_STRICT=1` で回す**（`sync-*-images.sh` が撮影元の欠けで落ちる。欠けた画像は古いまま残り、PR の差分にも出ない）
    - ヒーロー画像の枠の合成に ImageMagick が要るので、**公式の portable 版を版を固定して落とす**（ワークフローの `IMAGEMAGICK_VERSION`）。同期は合成結果をバイト単位で比べるので、版が変わると見た目が同じでもヒーロー 6 枚が差分になる
  - **ランナーは英語版の Windows で画面は 100%**。**表示倍率は撮影用ビルドが自分で 1.5 に固定する**（`tauri.e2e.conf.json` の main ウィンドウの `additionalBrowserArgs` に `--force-device-scale-factor=1.5`。手元の拡大率 150% と同じ値なので、手元の絵は変わらない）
    - **環境変数 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` では効かなかった**（試作 1 回目で `devicePixelRatio` が 1 のまま）。wry がブラウザの引数を明示的に渡すため
    - **`additionalBrowserArgs` は wry の既定の引数（`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`）を置き換える**ので、設定の値にも並べてある
    - 設定の `app.windows` は配列なので、マージで丸ごと置き換わる。**`tauri.conf.json` の main ウィンドウの設定を変えたら、`tauri.e2e.conf.json` の写しも変える**（`tests/e2eConfig.test.ts` が食い違いを落とす）
    - **main 以外の webview（`build_window` と子 webview の 2 つ）にも同じ引数を渡す**（`lib.rs` の `e2e_browser_args`）。WebView2 は同じデータディレクトリの webview が同じ引数を持つことを求める
    - **OS の拡大率は 100% のままなので、`setWindowSize` の大きさでは WebView の内寸が手元の 1/1.5 になる**。`prepare()` の `fitInnerSize` が内寸を測って外形を合わせ直す（手元では最初から合っているので何もしない）
  - **UI のフォントは撮影用ビルドだけ Yu Gothic UI を名指しする**（`lib/fontDetection.ts` の `SYSTEM_UI_FONT`）。英語版では `system-ui` が Segoe UI になり、表示言語は変えられないため。**`font-family` を書いていないフォームの部品（ボタン・入力欄・選択）は UA の既定の書体で描かれ**、英語版ではかなの字間が開いた別の書体になる。そこで `prepare()` の撮影用の CSS が `:where(button, input, select, textarea)` に UI のフォントを指定する（日本語の Windows の UA の既定と同じ Yu Gothic UI のはず、という前提に立っている）。**iframe の中と SVG の画像（`e2e/specs/vue-preview.ts` と `media.ts` のフィクスチャ）にはどちらも届かない**ので、フィクスチャに `CAPTURE_ENV.uiFont` / `CAPTURE_ENV.monoFont` を埋め込む（`sans-serif` と `ui-monospace` は OS の表示言語で変わる）。`SYSTEM_UI_FONT`（アプリ側）と `CAPTURE_ENV.uiFont`（検査側）は別ファイルにあり、片方を変えたらもう片方も変える
  - **総称の `monospace` で描く箇所は手元と字形が違う（許容している）。** Git パネルのハッシュ・履歴・QuickOpen・Docker パネル・vue-preview のフォームなど 15 か所（`var(--font-mono, monospace)` の `--font-mono` はどこにも定義が無いので、これも `monospace` に落ちる）。総称名は CSS から差し替えられず、英語版のランナーでは英語の既定の等幅（Consolas 系）になる。**WebView2 に `--lang=ja` を渡しても変わらなかった**（文書は元から `lang="ja"`）。揃えるなら `--font-mono` を定義して 15 か所をそれに寄せる（利用者の画面の等幅も変わる）
  - **Yu Gothic UI はランナーのイメージに最初から入っている**（日本語の補助フォントの追加機能で増えたファイルに `YuGoth*.ttc` は無かった）。**補助フォント（`Add-WindowsCapability` の `Language.Fonts.Jpan`。Meiryo / BIZ UD / MS 明朝 / Noto など）は入れない**: Windows Update から落とすので約 15 分かかる。ファイルを Actions のキャッシュに置く手は、公開リポジトリではフォークの PR のワークフローからも復元でき、Microsoft のフォントを取り出せる形になるので採らない。**そのぶん、日本語の字形の代わりに使われるフォントは手元と違いうる**（手元のプレビューのコードブロックの日本語は BIZ UDGothic。`e2e/README.md`）
  - PlemolJP Console NF を入れるのは `scripts/install-fonts.ps1`。マシンのフォントとして写してレジストリに載せ、`AddFontResourceW` と `FontCache` サービスの再起動で今のセッションにも見せる。WebView2 は DirectWrite でフォントを引くので、効いたかは `prepare()` の検査の警告で見る。PlemolJP の版はワークフローの `PLEMOLJP_VERSION`
  - **撮影のたびに、撮影機と先の撮影から持ち込まれる状態を消す**（`main.ts` の `resetState`。`prepare()` が呼ぶ）。設定を既定へ戻す（撮影用プロファイルに残った値）、「管理者」の表示を消す（CI のランナーは管理者で動く）、Git の状態を空にする、エージェントの使用量を空にする（撮影機の実際の Claude の使用量が写っていた。取得は `prepare()` が失敗させてある）。**手元の画像もこれで変わる**
    - **Git の状態は `setFakeProject` が今のモックで取り直し、終わるまで待つ。** 擬似プロジェクトのルートは毎回同じなので、取り直しが起きないとステータスバーのブランチが空のまま写る（hero-editor で起きた）。`git_status` のモックは `setFakeProject` より前に置き、状態を直接差す（`setGitStatus`）ならその後に置く
  - **タイムゾーンを日本時間にする**（ランナーは UTC）。エージェントのメニューの相対日時（「昨日」）は日付の境目で変わる
- `.github/dependabot.yml`: npm / Cargo / GitHub Actions の依存更新 PR を週次自動作成

### リリース PR（tagpr、#529）
- **リリースは [tagpr](https://github.com/Songmu/tagpr) のリリース PR をマージして始める。** main に push があるたびに `tagpr.yml` が、前のタグ以降の変更を載せたリリース PR を作り直す。**ブランチ名は `tagpr-from-v<前回の版>`**（v0.69.0 を出すリリース PR なら `tagpr-from-v0.68.0`。tagpr が今のタグから付ける）。マージすると、次の run がマージ後の main の先頭にタグを打ち、同じ run の `release` ジョブが `release.yml` をそのタグを ref にした `workflow_dispatch` で起動する（Release は別の run になる）。設定は `.tagpr`、手順は `release` スキル
- **tagpr のジョブは kan/tagpr-scripts の共通の workflow を呼ぶ**（#573。kan/tagpr-scripts#6。`uses: kan/tagpr-scripts/.github/workflows/tagpr.yml@<SHA>`）。`tagpr.yml` に残すのは `credits` ジョブと、それを呼ぶジョブだけ。tagpr を動かすこと、draft と ready の切り替え、タグを annotated に打ち直すこと、`release.yml` の起動（中の `release` ジョブ）は共通の workflow にある。入力は `release-workflow: release.yml` / `artifact: credits` / `timeout-minutes: 20`。動きと落ちたときの扱いの正本は `scripts/tagpr/README.md` の「The tagpr workflow」
  - **SHA は `scripts/tagpr/` に取り込んだ tagpr-scripts の commit に揃える。subtree pull をする PR で、呼ぶ行の SHA も一緒に上げる。** 値は squash のコミットのメッセージにある `git-subtree-split` の SHA（pike の squash やマージのコミットの SHA ではない）。別の repo の reusable workflow は `actions.lock` が固定しないので SHA で書く。中の action（tagpr など）は tagpr-scripts の `actions.lock` が実行時に固定する
  - **Dependabot にはこの行を上げさせない**（`dependabot.yml` の github-actions の `ignore`）。SHA だけが上がると、`scripts/tagpr/` の写しと実際に動く workflow が食い違い、何も落ちない。ignore を外さないこと
  - **tagpr の run が落ちると、リリース PR は draft になる。** tagpr は `postVersionCommand` が落ちてもリリース PR を作り直す（版だけが上がる）ので、マージできないように共通の workflow が draft にし、コメントを付ける。ready に戻す条件は `scripts/tagpr/README.md` の「The tagpr workflow」
  - **出すものが無いときは tagpr を走らせない。** `## [Unreleased]` が空で、タグより新しい版の節も無いとき（リリースの直後）は、共通の workflow が notice を出して run を success で終える（kan/tagpr-scripts#13。`scripts/tagpr/release-pending.mjs`）。リリース PR は作られない。マージの run、タグが打たれていない版があるとき、ready のリリース PR が開いているとき、`workflow_dispatch` の run では tagpr を走らせる
  - **タグは annotated に打ち直してから `release.yml` を起動する。** tagpr が打つのは lightweight のタグで、`git describe`（`--tags` 無し）が無視する。共通の workflow が同じコミットに API で annotated のタグを打ち直す。**タグからコミットを取るときは `vX.Y.Z^{commit}` と書く**（`vX.Y.Z` だけだとタグのオブジェクトを指す）。**手でタグを打つときも `git tag -a` にする**（`release` スキルの「タグを打ち直す場合」）
  - **前のリリース PR（版だけ上がって draft で残ったもの）はマージしない。** タグが打たれた後、main への push で成功した run がコメントを付けて閉じる（kan/tagpr-scripts#11。正本は `scripts/tagpr/README.md` の「The tagpr workflow」）。閉じられた PR を開き直さない
  - **`scripts/tagpr/` と呼ぶ行の SHA が揃っているかは、`ci.yml` の `node scripts/tagpr/verify-subtree.mjs` が PR で確かめる**（kan/tagpr-scripts#10）。SHA の上げ忘れ、subtree の取り込み忘れ、`scripts/tagpr/` の手での編集で落ちる
- **リリース PR の中身は `scripts/release-prepare.mjs` がそろえる**（`.tagpr` の `postVersionCommand`）。tagpr が `versionFile` の 3 ファイルの版を書き換えた後に呼ばれ、CHANGELOG と 2 つの lockfile（`scripts/tagpr/`）、クレジットの順にそろえる。PR を作り直すたびに main から走る
  - **CHANGELOG と lockfile の読み書きは [kan/tagpr-scripts](https://github.com/kan/tagpr-scripts) に任せる**（#562 / #565。subtree で `scripts/tagpr/` に取り込んである。lily / roji / notify-slack / hokora / musql と共有）。`release-prepare.mjs` は `scripts/tagpr/release-prepare.mjs --cargo src-tauri` を呼び（`--changelog-only` は付けない。付けると package-lock.json を飛ばす）、lockfile をそろえ（下の項）、`## [Unreleased]` を `## [X.Y.Z] - 日付`（日本時間）にし、空の `## [Unreleased]` を上に戻し、末尾のリンク定義の先頭に `[X.Y.Z]: https://github.com/kan/pike/releases/tag/vX.Y.Z` を足す。`release-notes.mjs` は `scripts/tagpr/release-notes.mjs` の出力の先頭に `## Pike vX.Y.Z` を足すだけ。使い方と CHANGELOG の規則は `scripts/tagpr/README.md`
  - **`scripts/tagpr/` の中は編集しない。** 直すものがあれば kan/tagpr-scripts を直して subtree pull で取り込む（コマンドとマージの仕方は CLAUDE.md の「コミット & PR 運用ルール」の subtree の例外）。pike の側で回避しない
  - **`scripts/tagpr/` が落ちたら、クレジットは置き換えない**（そちらは検査をすべて済ませてから書くので、落ちるときは lockfile も CHANGELOG も書き換えない）。**ただし 3 ファイルの版は、呼ばれる前に tagpr が書き換えている。** tagpr は失敗してもリリース PR を作るので、版だけ上がって lockfile が古いリリース PR が残る（共通の workflow が draft にする）。run が赤ならマージしない
  - **CHANGELOG に最新のタグ（`TAGPR_CURRENT_VERSION`）より新しい版の節があると落ちる。** リリース PR はマージされたのにタグが打たれていない印で、多いのはマージの run が cancelled になったとき（下の `concurrency` の項）。cancelled のマージの run は次の run が再実行するので、ここで落ちるのはそれができなかったとき。新しいリリース PR をマージせず、マージコミットの tagpr の run を手で再実行する（`release` スキル）
  - **CHANGELOG の改行は LF だけを受ける**（CR があると落ちる）。`.gitattributes` で `eol=lf` にしてあるので、`core.autocrlf=true` の Windows の作業ツリーでも手元で試せる
  - **クレジットはこのジョブで作らない。** 作るには依存のコード（node_modules）を読みネットワークにも出るので、書き込みの権限を持たない `credits` ジョブが main のツリーで `gen-credits.mjs` を走らせ、artifact `credits` で tagpr のジョブに渡す。共通の workflow がそれを展開し、そのディレクトリを環境変数 `TAGPR_ARTIFACT_DIR` で渡す（artifact は `src/assets/credits.json` だけなので、直下に `credits.json` ができる）。`release-prepare.mjs` は `TAGPR_ARTIFACT_DIR/credits.json` で `src/assets/credits.json` を置き換えるだけ（無ければ何も書き換えずに落ちる。展開に失敗すると `TAGPR_ARTIFACT_DIR` は空になる）。一覧は Pike 自身を含まないので、版を上げる前のツリーで作っても同じになる。**`credits` が落ちても tagpr のジョブは走る**（呼ぶジョブの `if: ${{ !cancelled() }}`。外さないこと）。マージの run はタグを打つだけでクレジットを使わないので、ネットワークの一時的な失敗でタグを打ち損ねない。リリース PR を作り直す run は `credits.json` が無いので落ちる。run を再実行する
  - **版の表記は `versionFile` の 3 ファイル（`tauri.conf.json` / `Cargo.toml` / `package.json`）を tagpr が書く**（#565）。tagpr は各ファイルで今の版の文字列の最初の 1 か所を書き換えるので、**3 ファイルとも自身の版が最初に出てくる形を保つ**（版より前に同じ文字列が出てくると別の行が書き換わる）。**`scripts/tagpr/` が `.tagpr` の versionFile を読み、3 ファイルとも本来の版（JSON は最上位の `"version"`、Cargo.toml は `[package]`）が提案と同じかを、何かを書く前に確かめる**ので、食い違えば run が赤になり、lockfile も CHANGELOG も書き換わらない。**マージ後のタグは先頭の `tauri.conf.json` の版から決まる**
  - **lockfile は versionFile に入れず、`scripts/tagpr/release-prepare.mjs --cargo src-tauri` がそろえる。** tagpr は lockfile を自分では探さず、versionFile に書けば書き換えるが、最初の 1 か所だけなので同じ版の依存の行に当たりうる。 `Cargo.toml` の `[package]` と `package.json` の版が提案と同じかを確かめ、`Cargo.lock` の pike 自身の `[[package]]`（`source` の行が無いもの）と `package-lock.json` の `version` / `packages[""].version` だけを書き換える。cargo も npm も呼ばず、ネットワークにも出ない。`cargo update --workspace` と `npm install --package-lock-only` の出力とバイト単位で同じになることを確かめてある（#565）。`package-lock.json` は JSON を読み直して 2 スペースで書き出すので、lockfileVersion 2 以上と LF（`.gitattributes`）が前提
  - **コマンドが失敗しても tagpr はリリース PR を作り、ステップを失敗で終える。** そのリリース PR は共通の workflow が draft にする。tagpr の run が赤ならリリース PR をマージしない
- **版は PR のラベルで決まる。** マージ済みの PR に `enhancement` があれば minor（`.tagpr` の `minorLabels`）、無ければ patch。**版を変えたいときは版のファイルを手で書き換えない**（リリース PR のブランチへのコミットは、tagpr の作り直しで消えるか、作り直しとぶつかる）。リリース PR に `tagpr:minor` を付ける。ラベルを付け外しすると `tagpr-label.yml` がリリース PR を draft にし、`tagpr.yml` を起動して作り直させる（kan/tagpr-scripts#3。`pull_request_target` で、何も checkout しない）。`tagpr.yml` の名前と `workflow_dispatch:` を変えない。マージ済みの PR のラベル（`enhancement` など）を変えたときは起動しないので、`gh workflow run tagpr.yml` で作り直す
- **CHANGELOG は tagpr に作らせない**（`changelog = false`）。tagpr の生成は PR タイトルを並べるだけなので、利用者向けの説明は各 PR が `## [Unreleased]` に書く（CLAUDE.md の「CHANGELOG の書き方」）。リリース PR の本文に出る PR の一覧は `.github/release.yml` の分類に従う
- **GitHub のリリースも tagpr に作らせない**（`release = false`）。Immutable releases を有効にしてあるので、tagpr が公開すると成果物を足せなくなる。ドラフトは今までどおり `release.yml` の `draft` ジョブが作る
- **トークンは GITHUB_TOKEN のまま**（GitHub App は作っていない）。GITHUB_TOKEN で打ったタグの push ではワークフローが起動しないので、`release.yml` を同じ run から `workflow_dispatch` で起動する（`workflow_dispatch` はこの制限の例外。起動するのは共通の workflow の `release` ジョブで、使う `actions: write` は呼ぶジョブの `permissions` に書く。`release.yml` は secrets をリポジトリから直接読む）。その代わり、**ボットが作ったリリース PR の CI と Security Check の run は承認待ち（`action_required`）で止まる。** tagpr の作り直しのたびと、撮影のコミット（これも GITHUB_TOKEN の push）のたびに 2 本ずつできる。承認は API で通る（`gh api -X POST repos/kan/pike/actions/runs/<id>/approve`。v0.69.0 で確かめた）。承認しないままだと期限切れの `failure` になる（画面には「ワークフローファイルの問題」と出るが、run のページのエラーは `required approval but was not approved before it expired`）
- **tagpr のジョブは書き込みの権限（`contents` / `pull-requests`）を持つので、依存のコードを走らせない。** `npm ci` はしない（クレジットは `credits` ジョブが作る）。npm も cargo も呼ばない（版は tagpr が書き、lockfile は `scripts/tagpr/` が書き換える）。`scripts/tagpr/` は Node の組み込みのモジュールしか使わない。Node は共通の workflow が `setup-node`（キャッシュなし）で 24 に固定する（ランナーの既定の版が変わると、`import.meta.dirname` などが無い版に当たりうる）
- **呼ぶジョブには権限を 4 つとも書く**（`contents: write` / `pull-requests: write` / `issues: read` / `actions: write`）。共通の workflow が使える上限で、GitHub は run の始めに、飛ばされるジョブの権限まで検査する。`actions: write` を使うのは中の `release` ジョブだけ
- **`credits` ジョブは読み取りの権限だけで走る**（`npm ci --ignore-scripts` → `gen-credits.mjs`。checkout も `persist-credentials: false`）
- **どちらのジョブも `setup-node` のキャッシュは使わない**（別のワークフローが書いたキャッシュを、tagpr のジョブがコミットするものに混ぜない）
- **`tagpr.yml` に `concurrency` を付けない。** run を並べるのは共通の workflow の tagpr のジョブ（group は `tagpr-scripts-release-pr`、`cancel-in-progress: false`。tagpr どうしが同じブランチを作り直し合わないように並べ、タグを打った直後に止めて成果物の無いタグを残さないように止めない）。**呼ぶ側に同じ名前の group を付けると、GitHub が deadlock として run を止める。** 別の名前を付けても、待っている run が置き換えられる場所が 2 つに増える。中の `release` ジョブは group に含まれないので、ビルドの最中に来た push もリリース PR の作り直しを待たされない
  - **それでも GitHub は待っている run を 1 つしか持たない。** リリース PR のマージの run が待っている間に push が来ると、その run は cancelled になり、タグが打たれない。**次の run が、tagpr を走らせる前に、取り消されたマージの run を再実行してタグを打たせる**（kan/tagpr-scripts#4。`scripts/tagpr/missed-tags.mjs`。正本は `scripts/tagpr/README.md` の「A missed tag is made by re-running the run of its merge」）。再実行できなかったときは、その run が CHANGELOG の検査（タグより新しい版の節がある）で赤になる。そのときだけマージコミットの run を手で再実行する。ラベルの付け外しで起動した作り直しの run も、push と同じく待っている run を置き換えうる
- **Rust のツールチェーンは入れない**（`credits` ジョブはランナーの stable で `cargo metadata` だけを呼ぶ。tagpr のジョブは cargo を呼ばない）。tagpr のワークフローに `@master` 参照の action を増やさない
- **やり直し**: ビルドが落ちたら Release の run の落ちたジョブだけを再実行する（`gh run rerun <run-id> --failed`）。打ってあるタグで丸ごとやり直すなら `gh workflow run release.yml --ref vX.Y.Z`（`--ref` にタグを渡す）。コードを直してタグを打ち直すときは、直す PR をマージしてから手で **annotated の**タグ（`git tag -a`）を打って push し、同じく `workflow_dispatch` で起動する（`release.yml` は `push: tags` を持たないので、手で push したタグでも起動しない）。タグを消したあいだに main が進むと、その tagpr の run は「タグより新しい版の節がある」で赤になる。タグを打ち直したら次の run から通る
  - **タグは打たれたのに `release.yml` が起動していないときは、そのマージの tagpr の run を再実行する**（tagpr は既にあるタグを受け入れるので、annotated への打ち直しと起動がもう一度動く）。**`release.yml` が既に起動した run は再実行しない**（同じタグで 2 回目が起動する）。正本は `scripts/tagpr/README.md` の「When the run of a merge made the tag but failed after it」
    - 再実行できない run（30 日を過ぎたもの）だけ、その README の手順で手で直す。**`release.yml` は `push: tags` を持たないので、タグを手で push しても起動しない**（roji や lily と違う点）。最後に `gh workflow run release.yml --ref vX.Y.Z` で起動する

### action の固定（workflow lockfile）
- **action は `.github/workflows/actions.lock` でコミットに固定する**（GitHub Actions の workflow lockfile。2026-10-28 に GA）。生成と更新は GitHub CLI の拡張 `gh actions-lock`（`gh extension install github/gh-actions-lock`）で行い、**手で編集しない**。推移的な依存（composite action が呼ぶ action。今は `extractions/setup-just` の中の `extractions/setup-crate`）と、参照先リポジトリの ID も記録される
- **`uses:` には SHA を書かず、タグかブランチで書く**（`actions/checkout@v7.0.1`）。SHA を直接書くと `sha-as-ref` として lockfile に入らず、生成そのものが失敗する（解決できない参照が 1 つでもあると何も書き込まれない）
  - **例外は、別の repo の reusable workflow を呼ぶ行**（`jobs.<id>.uses: owner/repo/...`）。lockfile はこれを固定しないので、commit の SHA で書く。今あるのは `tagpr.yml` が kan/tagpr-scripts の共通の workflow を呼ぶ行だけで、SHA は subtree と揃える（「リリース PR（tagpr）」）
- **`uses:` を足す・消す・ワークフローを足したら `gh actions-lock` を流し直し、lockfile も同じコミットに入れる。** 載っていない参照があると、そのワークフローはジョブが始まる前に `startup_failure` で止まる。コミット前の確認は `gh actions-lock --verify`（書き込まずに検査する。ネットワークに出る）。CI でも `verify-lockfile.yml` が PR と main への push のたびに同じ検査を回す（#562。拡張の版は `--pin` で固定してあり、Dependabot は上げない。lockfile の形式が上がって落ちたら、手元の拡張と同じ版に上げる）
- **タグの更新は Dependabot が lockfile ごと上げる**（github-actions の更新 PR が対応するエントリも作り直す）。`@v4` のような部分版は生成時に完全な版（`@v4.0.0`）へ書き換わる
- **`dtolnay/rust-toolchain` は `@master` で参照する**（ツールチェーンは `toolchain: stable` の入力で選ぶ）。この action の `stable` などのブランチは上流で作り直されるため、以前に固定した SHA がどのブランチにもタグにも無くなっていて、lockfile が「上流の履歴に無いコミット」として拒否した。ブランチ参照は Dependabot が追わないので、上げるときは `gh actions-lock --relock` で全参照を解決し直し、`commit` の差分を確かめてからコミットする

