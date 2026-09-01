# ビルド・CI・配布ルール

開発ビルドの起動、本番ビルド限定の落とし穴、E2E スクリーンショット、CI ワークフロー、セルフアップデート。
実体は `justfile`、`src-tauri/tauri*.conf.json`、`e2e/`、`scripts/`、`.github/workflows/`。

## タスクランナー（just、#231）
- 開発タスクの入口は `justfile`。`just` でレシピ一覧、`just check` でコミット前チェック一式、`just bump X.Y.Z` でバージョン更新。CI の 3 ワークフローも同じレシピを呼ぶ（ステップ名は残したまま中身だけ just に寄せてあるので、失敗箇所の粒度は従来どおり）
- **レシピの実体は `package.json` の scripts に置いたまま**、just はその薄いファサードにしてある。tauri CLI や CI の慣習で npm 経由が要るもの（`npm run build` 等）を壊さないため。例外は `e2e-sync` 系で、こちらは `scripts/*.sh` を直接呼ぶ（理由は次の bullet）
- **`set windows-shell := ["C:/Program Files/Git/bin/bash.exe", "-cu"]` が要る**。理由は 2 つで、(1) just の Windows 既定シェルは `sh -c` だが **`sh` はこのマシンの PATH に無い**（全レシピが即座に落ちる）、(2) PATH 上の `bash` は `C:\Windows\System32\bash.exe`＝**WSL ランチャ**で、そちらには Windows 側の node / tauri / ImageMagick が無い。Git Bash を指すと `magick` も PATH で解決するので、「`npm run e2e:sync` を WSL の bash で回すと ImageMagick が見つからず止まる」という従来の落とし穴もレシピ側で塞がる
- `cmd.exe /c` は候補から外した。**先頭が引用符の行を cmd が引用符ごと剥がす**ため、`"C:/Program Files/Git/bin/bash.exe" scripts/x.sh` が `'C:/Program' は…認識されていません` になる（実測）
- 別の場所に Git を入れている環境は `just --shell <bash へのパス>` で上書きする（設定値は文字列リテラルしか取れないので変数化できない）
- **シェルスクリプトは `bash script.sh` の形で呼ぶ**（`package.json` の scripts が最初からそうしている）。
  直接呼ぶとファイルの実行ビットに依存するが、**Windows の Git Bash は shebang があれば実行ビットが
  無くても走らせてしまう**ので、Windows だけで開発しているあいだは気付けない。v0.43.0 のリリースで
  macOS のジョブが `just fetch-rg` の `Permission denied` で落ちて初めて出た（`scripts/*.sh` は
  `100644` のままだった）。実行ビット自体も立てたが、呼び方のほうが本命
- CI での just 導入は `extractions/setup-just`（他の action と同じく SHA ピン留め）

## 開発ビルド
- `just dev`（= `npm run tauri:dev`）で開発版を起動（`tauri.dev.conf.json` で identifier を `com.pike.dev.debug` に上書き）
- インストール版 Pike (`com.pike.dev`) と開発版 (`com.pike.dev.debug`) は single-instance が別扱いになるため共存可能
- `import.meta.env.DEV` が true の場合、ウィンドウタイトルに `[DEBUG]` プレフィックスを付与
- トレイアイコンも同じ表記で見分ける（`tray::app_label` が「Pike [DEBUG]」を返し、ツールチップとメニュー先頭の見出しに出る）。判定は `cfg!(debug_assertions)`（`tauri:dev`）または identifier の `.debug` 接尾辞（`tauri build --config tauri.dev.conf.json` は release プロファイルなので前者では拾えない）。アイコン画像はインストール版と共通なので、これが無いとトレイ上で区別できない
- `npm run tauri dev` は identifier が本番と同一のため、インストール版と競合する点に注意

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
- **macOS で mold は使えない**（ELF 専用で Mach-O は対象外）。かつての `zld` も Xcode 15 の
  新リンカ（`ld_prime`）に置き換えられてアーカイブ済みで、macOS の既定リンカは既に新実装。
  リンカ側は何もしないのが妥当で、上の `debug = false` は OS 非依存に効く
- **CI では `cargo clippy` は影響を受けない**（リンクしない）。効くのは `cargo test` の
  テストバイナリのリンクと、`just build`。release は `[profile.release]` が既定で
  デバッグ情報を持たないため対象外

## CSP と動的スタイル注入（本番ビルド限定の落とし穴、#v0.26.3）
`tauri.conf.json` の `app.security.csp` を設定すると、**本番（埋め込み）ビルドでのみ** Tauri が `style-src` / `script-src` に nonce/hash を注入する（`tauri` クレートの `manager::set_csp` → `replace_csp_nonce`）。CSP 仕様上、**nonce か hash が directive に 1 つでも入ると同 directive の `'unsafe-inline'` は無視される**。

- **症状**: xterm（ターミナルの色・フォント）と CodeMirror（style-mod で実行時に `<style>` を注入。エディタ本文・シンタックス色）が実行時注入するスタイルが全滅する。ターミナルは色/フォント崩れ、エディタは本文が消えて**行番号ガターだけ**残る。**dev（`tauri:dev`）は Vite 配信で nonce/hash 注入が走らないため再現しない**＝「本番ビルドだけ崩れる」形になる
- **対策**: `app.security.dangerousDisableAssetCspModification: ["style-src"]` を設定し、**style-src への nonce/hash 注入だけを止めて `'unsafe-inline'` を有効に保つ**（CodeMirror/xterm 等の CSS-in-JS 系ライブラリ向けの Tauri 標準の対処）。`script-src`（XSS 対策の要）の nonce/hash 注入は維持する。config の型は `DisabledCspModificationKind`（`bool` または directive 名の配列）、キーは `deny_unknown_fields` なので誤字はビルドエラーになる
- **切り分けの注意**: この不具合は dev で再現しないため、原因調査は**本番ビルドで**行う必要がある。加えて、同一 identifier（`com.pike.dev`）のインストール版が起動中だと single-instance で新ビルドの起動が既存インスタンスに転送され、**古い壊れた画面を検証してしまう**。切り分け時は `--config tauri.dev.conf.json`（identifier を `com.pike.dev.debug` に）を付けて `tauri build` し、併存起動できる別 identifier ビルドで確認するのが確実。埋め込み後の実 HTML/CSP は `target/release/build/pike-*/out/tauri-codegen-assets/*.html`（brotli 圧縮、`zlib.brotliDecompressSync` で復元可）で確認できる
- **`index.html` にインライン `<style>` を置かない**のが安全側（Tauri がその hash を style-src に足して同じ問題を誘発しうる）。基本レイアウトは `src/assets/theme.css`（`main.ts` 先頭 import でバンドル CSS の `<link>` になり render-blocking＝FOUC も起きない）に置く

## E2E スクリーンショット自動化（#142）
マニュアル画像（`docs/manual/img/`）の自動再撮影パイプライン。詳細・設計の正本は `e2e/README.md`。

1. `just e2e-build`: 撮影用バイナリをビルド（`PIKE_E2E=1` + `--features e2e` + `tauri.e2e.conf.json`。identifier=`com.pike.e2e` で既存 Pike / dev 版と single-instance 衝突しない）
2. `just e2e`: wdio 実行。`e2e/specs/*.ts` が ja/en × light/dark の 4 バリアントで `artifacts/screenshots/{画面}-{lang}-{theme}.png` に撮影（`artifacts/` は gitignore）。ウィンドウ寸法は 3 クラス: クローズアップ＝既定 1280×832（内枠 1259×777）、全体レイアウト系（layout.ts の `FULL`）＝1600×1000（内枠 1578×945）、**外枠付きヒーロー（`HERO` = `FULL` の 2 倍）＝3200×2000（内枠 3179×1944）**
   - `HERO` はプライマリモニタ（3413×1440）より縦が大きいが、WebView2 の撮影は画面外にはみ出した分も含めて撮れるので問題ない。DPR を上げる方向（`--force-device-scale-factor=2`）は撮影が CSS ピクセル基準で行われるため効かない（実測済み）
   - **論理サイズを 2 倍にすると表示内容が増える**ぶん、フィクスチャが短いと下半分が空く。`HERO` を使う spec（overview / hero-editor / hero-git）のダミーデータは、この寸法で画面が埋まる量にしてある（README は 60 行超、ターミナルのセッションは 78 行、コミット履歴は 8 件）。寸法を変えたら埋まり方も見直す。**v0.46.0 で実際に踏んだ**: #275 でチャットを外したとき `hero-git` の右ペインを 30 行のターミナルに置き換えたところ、下半分が空いた状態で README のヒーローに載った
> `just e2e-build` の出力を `| tail` などに通さないこと。Rust のコンパイルが落ちても
> パイプ側の終了コード 0 が返り、**古いバイナリのまま撮影して気付けない**（実際に
> 「新しい画面が出ない」を追う羽目になった）。ログはファイルに落として `$?` を見る。

3. `scripts/sync-manual-images.sh --check` でドライラン → 引数なしで `docs/manual/img/` へ同期。スクリプト内 `MAP` が「マニュアル名 ← E2E ベース名」を対応付け、ja の dark（`{名前}.png`）+ light（`{名前}-light.png`）の 2 枚を持つ（GitHub の `<picture>` 切替用）
4. 変更画像を目視確認してコミット

- 外枠付きヒーロー画像（README / overview の `screenshot-*`）は `scripts/sync-hero-images.sh`（内部で `frame-screenshot.sh` を呼ぶ）で合成・配置する。`sync-manual-images.sh` の MAP には含まれないため、**同期は 2 本を続けて走らせる `just e2e-sync`（確認は `e2e-sync-check`）を使う**。以前この合成が e2e/README の手打ちコマンドだけだったため、7-20 の再撮影でヒーローだけ v0.26 世代のまま取り残された
- **ヒーロー画像の合成には ImageMagick（`magick`）が要る**。マニュアル画像のコピーは要らないので、`magick` が無いと**マニュアル 46 枚だけ更新されてヒーロー 6 枚が古いまま残る**（`sync-hero-images.sh` が `magick: コマンドが見つかりません` で落ちるが、先に走る `sync-manual-images.sh` は成功している）。この PC では Windows 側（`C:\Program Files\ImageMagick-7.0.10-Q16-HDRI`）にあり **WSL の PATH には無い**ので、WSL の bash で回すとここで止まる（v0.35.0 の再撮影で実際に踏んだ）。`just e2e-sync` は Git Bash で走るので `magick` が PATH で解決する（#231。それ以前は `npm run e2e:sync` が WSL の bash を掴んでいた）
- 撮影画面を追加したら `e2e/specs/` に追記し、マニュアルで使う場合は `sync-manual-images.sh` の MAP にも対応を追加
- **MAP に足し忘れた画像は「撮っているのに使われない」まま溜まる。** `check-docs` は
  「マニュアルが参照する画像が実在するか」と「参照されない画像が `docs/manual/img/` に残っていないか」は
  見るが、`artifacts/screenshots/` にしか無いものには気付けない。v0.43.0 の棚卸しでは 9 枚
  （`outline-panel` / `diff-tab` / `history-tab` / `csv-preview` / `json-preview` / `mermaid-preview` /
  `svg-preview` / `pdf-tab` / `agent-claude`）がこの状態だった。差分を見るには
  `comm -23 <(grep -rhoE "shoot\('[a-z0-9-]+'" e2e/specs/*.ts | sed "s/shoot('//;s/'//" | sort -u) <(grep -oE '"[a-z0-9-]+:[a-z0-9-]+"' scripts/sync-manual-images.sh | sed 's/.*://;s/"//' | sort -u)`
  （`overview` と `hero-*` は `sync-hero-images.sh` の担当なので出てきてよい）
- **待ち合わせに使うセレクタは `data-testid` を足す。** クラス名は見た目の都合で変わるが、
  testid は撮影のための契約として残る（`diagnostics-panel` / `git-operation` はこのために足した）
- **画像には StatusBar のバージョン（`v0.33.0`）が写る**。`useUpdater` の `getVersion()` は `@tauri-apps/api` 経由で `tauri.conf.json` の version を読むため、`lib/tauri.ts` の invoke ラッパを通らず **E2E のモックでは差し替えられない**（`tauri.e2e.conf.json` で version を上書きするのは 2 箇所 bump の drift 要因なので採らない）。リリースに合わせて撮り直すときは **bump 済みのツリーで撮る**（bump → 撮影 → 同期 → タグ の順）
- ドロップダウンやトースト等、アニメーションを含む UI は**静止するまで待ってから撮る**（例: リモートブランチ取得中の `.spin-icon` が残ると実行ごとに回転角の差分が出る）。撮影に安定したセレクタが必要な場合は `data-testid` を足す（`worktree-selector` / `branch-selector`）
- 撮影コードを本番ビルドに混入させない仕組み（`e2e` Cargo feature / vite define `__PIKE_E2E__` / `capabilities-runtime` の実行時登録）は `e2e/README.md` を参照

## セルフアップデート
- `tauri-plugin-updater` + `tauri-plugin-process` で GitHub Releases の `latest.json` を参照
- 署名キー: `~/.tauri/pike.key`（秘密鍵）、公開鍵は `tauri.conf.json` の `plugins.updater.pubkey` に埋め込み
- CI: `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` を GitHub Secrets に設定
- Settings タブの About セクションに「更新を確認」ボタン + 「更新して再起動」ボタン
- SideBar 歯車アイコンに更新通知ドット（起動時に `check()` でバックグラウンド確認）
- `bundle.createUpdaterArtifacts: true` で `.sig` ファイルを自動生成

## CI/CD
- `.github/workflows/ci.yml`: push/PR で `biome check`、`npm run build`（vue-tsc + vite）、`cargo clippy -- -D warnings`、`cargo test` を実行（Windows runner）
- `.github/workflows/release.yml`: タグ push (`v*`) で `tauri-action` が **Windows と macOS(arm64) の 2 ジョブ**をマトリクスで走らせ、同じタグのドラフトへ両方の成果物をアップロードする（2 つ目のジョブは既存のドラフトを見つけて追加する）。`fail-fast: false` なので macOS が落ちても Windows は最後まで走る
  - **macOS 側は updater の経路に載せない**。`uploadUpdaterJson: false` で `latest.json` を触らせず、`--config src-tauri/tauri.macos.conf.json` で `createUpdaterArtifacts` も切る（**パスはリポジトリルート基準**。`tauri-action` はルートから CLI を起動するので、`package.json` の `tauri:dev` / `e2e:build` と同じく `src-tauri/` を付ける。落とすと `Provided config path ... does not exist` で止まる）。配布物が未署名で Gatekeeper に隔離されるため、自動更新に載せると壊れた更新を配ることになる（README にユーザー向けの但し書きがある）
  - `macos-latest` は Apple Silicon なので**ホストのトリプルがそのまま `aarch64-apple-darwin`**。クロスビルドの指定は要らず、`just fetch-rg` も `rustc -vV` からその名前でサイドカーを取る。Intel 向けは配布しない
  - `rust-cache` の `key` を OS で分ける（分けないと 2 ジョブが同じキャッシュを取り合う）
- `.github/workflows/security.yml`: push/PR で `cargo audit` + `npm audit`、週次スケジュール実行
- `.github/dependabot.yml`: npm / Cargo / GitHub Actions の依存更新 PR を週次自動作成

