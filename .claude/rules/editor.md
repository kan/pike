# エディタ・パネル実装ルール

CodeMirror 6 のエディタとプレビュー、ファイルツリー、サイドバーの各パネル（検索・タスク・アウトライン・診断）、ファイル監視。
実体は `src/components/tabs/EditorTab.vue`、`src/components/editor/MarkdownToolbar.vue`、`src/components/panels/`、`src/lib/editor*.ts`、`src/lib/outline/`、`src-tauri/src/fs/`、`src-tauri/src/search/`、`src-tauri/src/watcher/`、`src-tauri/src/tasks.rs`、`src-tauri/src/diagnostics/`。

## ファイルツリー / エディタ
- Rust `fs` モジュールが WSL/Windows 両対応のファイル操作を提供（list_dir / read_file / write_file）
- WSL: `wsl.exe find`, `wsl.exe cat`, `wsl.exe bash -c "cat > ..."` 経由
- Windows: `std::fs` 直接アクセス
- ファイルサイズ事前チェック（2MB 制限）
- CodeMirror 6 でエディタタブ。テーマは `lib/editorThemes.ts` の 6 種（One Dark / Default Light / Dracula / Nord / Solarized Light / Monokai）+ Auto（ダーク/ライト追従）、シンタックスハイライトは 30 言語（一覧の唯一の出典は `lib/languages.ts` の `EXT_MAP` / `NAME_MAP`）
- Ctrl+S で保存、ダーティ表示（タブタイトルに `*`）。Ctrl+Z/Shift+Z で Undo/Redo
- エディタ内検索・置換: Ctrl+F / Ctrl+H でカスタム検索パネル（右上フローティング、アイコンボタン、マッチ数表示）
- Git diff ガター: 追加行（緑）・変更行（黄）・削除行（赤三角）をガターに表示。`git_diff_lines` コマンドで行単位の差分を取得
- ミニマップ: `@replit/codemirror-minimap` を採用。blocks モード、シンタックスカラー反映、正確なスクロール同期、git diff ガター表示
- エディタコンテキストメニュー: Undo/Redo/Cut/Copy/Paste/Git History（Teleport パターン）
- ファイルツリーに git ステータス色表示（precomputed Map で O(1) ルックアップ）
- 画像ビューワタブ（base64 経由、ズーム/回転/反転/パン/fit の表示専用操作）、Markdown プレビュー（Edit/Split/Preview 3モード、スクロール同期、250ms デバウンス）
- Markdown プレビュー内リンク: 外部 URL は confirm 付きで `open_url` 経由の外部ブラウザ起動、ローカルファイルはプロジェクトルート内に限定して EditorTab で開く（`resolveLocalPath` でディレクトリトラバーサル防止 + `decodeURIComponent` 対応）
- 文字コード対応: `encoding_rs` で自動検出 + 指定エンコードでの開き直し/保存（StatusBar 2段階 UI）
- 改行コード LF/CRLF 切替（StatusBar クリック）、保存時に適用
- ファイルツリーコンテキストメニュー: リネーム（インライン入力）、削除（カスタム confirm ダイアログ）、Git History（専用タブ）、フォルダ限定「エクスプローラーで開く」（`fs_open_in_explorer`。WSL は `\\wsl.localhost\{distro}` UNC に変換して explorer.exe 起動）
- ドラッグ&ドロップ移動 + Ctrl でコピー（`dragDropEnabled: false` で Tauri ネイティブ D&D を無効化）
- **ツリーの余白はルート宛てのドロップ先にする**（`.tree-root-drop`）: ツリーはルートの子しか描かないので、最後の行より下に落としても受け手がおらず、App.vue の window ガードがイベントを飲んで無言で何も起きない。パネルを `min-height: 100%` で伸ばし、余った縦スペースを占める filler にハンドラを置く。パネルのルート要素に `.self` 修飾子で付ける手もあるが、ツリーがあふれると空き領域がゼロになってルートに落とせなくなる
- ダーティエディタタブの閉じ確認ダイアログ（カスタム confirm）
- WSL コマンドにパス引数前の `--` を付与（フラグ injection 防止）
- 外部 URL オープン: `open_url` コマンドは http/https のみ許可（Rust 側でバリデーション）。`explorer.exe` 経由で開く（`cmd.exe /C start` はシェルメタ文字インジェクションの危険があるため不使用）。フロント側でも confirm ダイアログを表示

## CodeMirror 6
- シンタックスハイライトのみ、LSP・補完は実装しない
- 言語パッケージは使うもの（Go, Rust, TypeScript, Vue, YAML 等）だけ import
- ファイル保存は `Ctrl+S` → `invoke('fs_write_file', ...)`

## Markdown の入力支援（#241）
- コマンドは `lib/editorMarkdown.ts`、ボタン列は `components/editor/MarkdownToolbar.vue`。ツールバーは **Edit/Split/Preview と同じ行**に入れる（専用の行を足すとエディタの高さが約 28px 減る）。出す条件は `isMarkdown && showEditor && !readOnly`
- **UI は `MarkdownAction` を emit するだけ**にして、`EditorView` は EditorTab が持ったままにする。ショートカットとボタンが同じ関数を通るので、片方だけ壊れることがない
- **リスト継続・番号の自動インクリメント・URL 貼り付けのリンク化は書かない**。`@codemirror/lang-markdown` の `markdown()` が既定（`addKeymap` / `pasteURLAsLink`）で `Prec.high` の Enter / Backspace と paste ハンドラを入れており、自前で書くと同じキーを取り合う。**足りないのはトグル**（既存行を箇条書きにする / 外す）だけ
- **`Mod-k` は binding の `stopPropagation: true` で解決する**。`useKeyboardShortcuts` の window リスナーはバブル段階なので、CodeMirror がそこで止めればグローバル側は無改造で済む（`defaultPrevented` ガードを足すと、他のキーの取り合いまで一括で変わる）。`runHandlers` は **コマンドが true を返したときだけ** `stopPropagation` するので、read-only タブや非 Markdown では Ctrl+K は従来どおりショートカット一覧に届く
- 行単位のトグル（見出し・箇条書き・引用）は **選択全体で 1 つの判定**にする（`markerOf` が全行で一致したら外す）。行ごとに決めると、半分に付いた選択で押したとき付け外しが入り混じる
- 空行は複数行選択のときだけ飛ばす（段落の区切りに `- ` を足さない）。1 行だけの選択ではリストの開始なので飛ばさない
- テンプレートのプレースホルダは選択状態で入れる（最初の打鍵で置き換わる）。コードブロックだけは**言語の位置**にカーソルを置く（フェンスは書けても言語は書き手しか知らない）
- **表は形を先に聞く**（行数・列数）ので、固定テンプレートの `block` ではなく独立した action kind。UI はブロックメニューの中身をフォームに差し替える形で、メニューを閉じると `picker` を戻す。**見出し行は必ず入れる**: GFM に見出しの無い表は無く（区切り行はそもそも見出しの下にしか置けない）、セルを空にすると本文の上に空の帯が出るだけなので、見出しの有無を選ばせる余地がない。指定する行数は見出しを除いた本文の行数
- 脚注は本文に `[^n]`、**ファイル末尾**に定義行を足してカーソルを定義側へ移す。`n` は既存の `[^数字]` の最大値 + 1
- **プレビューの脚注は `lib/markdownFootnotes.ts`（marked 拡張）**。marked は GFM 脚注を持たず、しかも素通しにならない: `[^1]` は**注釈本文を href に持つリンク**になり、定義行はリンク定義として消える。EditorTab は自前の `new Marked(footnotes())` を持つ（グローバルの `marked.use` にするとエージェントチャットの markdown にも入る）
  - 定義は**書かれた場所にそのまま描く**（末尾に集めない）。ツールバーもユーザーもファイル末尾に足すので位置は同じで、トークンをまたぐ集計が要らない
  - **block の `start` は「行頭の定義」だけを返す**。marked は `start` に**先頭 1 文字を除いた src** を渡し、`index + 1` で段落を切る。`/^\[\^/m` にすると行の途中のオフセットを返してしまい、段落が 2 つに割れて再結合のときに改行が紛れ込む（`` `[^x]` `` のコードスパンの中に空白が 1 つ増える、という形で出た）
  - 番号は**登場順**に振り、`hooks.preprocess` でパースごとにリセットする（プレビューは打鍵のたびに作り直される）。`id` を持つのは最初の参照だけ（同じ id を 2 回出さないため）
- 「Markdown か」の判定は **`paths.ts` の `isMarkdownPath`** を通す。拡張子ごとの言語は `languages.ts` の `EXT_MAP` が正本で、`.markdown` もそこに足してある（構造が違うので述語には畳めない。片方だけ `.markdown` を知っていたせいで「ツールバーは出るのに Enter の継続が効かない」が起きた）。`lib/outline/index.ts` の `pickExtractor` は langId で分岐する別の形なので通していない
- **プレビューの marked インスタンスは 2 つ**（`markedPlain` / `markedFootnotes`）で、`parserFor` が本文に `[^` があるかで選ぶ。block 拡張を 1 つでも登録すると marked は `startBlock` の経路に入り、**段落ごとに残り全文をコピーする**（文書サイズに対して二次オーダー）。マニュアルを連結した実測で 49KB +13% / 390KB +136%。プレビューは打鍵のたびに作り直されるので、脚注を使わない文書にこれを払わせない
- **Save As は `tab.path` を書き換えるだけでビューを作り直さない**ので、ファイルの種類で決まるものは `tab.path` の watcher で張り直す。対象は**言語（`languageCompartment`）・入力支援のキー（`markdownCompartment`）・アウトラインの登録（`registerOutlineSource`）の 3 つ**。言語を入れ忘れると、無題バッファを `notes.md` として保存したときに「ツールバーとショートカットは効くのにハイライトも Enter の継続も無い」という半端な状態になる（Enter の継続は `@codemirror/lang-markdown` が持ち込むため）。アウトラインは登録時の path を焼き込むうえ、そのタブは既に active なので activeTabId の watcher では張り直されない
  - **compartment を 1 つにまとめないこと**。2 つは拡張リスト上の位置が違い、その順序が効いている: `defaultKeymap` が `Mod-i` を `selectParentSyntax` に割り当てているので、入力支援の keymap は**それより前に登録されている**から勝てる。言語は従来どおり最後
  - diff ガター・Problems・ミニマップ・定義ジャンプは path を遅延で読むので張り直し不要（`hasFile` は無題バッファでも真になる）

## プレビュー拡張
- CSV/TSV・Mermaid・JSON/JSONL・SVG・Markdown は専用タブではなく **`EditorTab` の Edit/Split/Preview トグル**で描画する（タブ種別は `editor`。`isCsv` / `isMermaid` / `isSvg` / `isJson` 等の computed で分岐）
  - CSV/TSV: `buildCsvPreview` でテーブル化（RFC 4180 準拠の引用符対応パーサ、10,000 行 truncate、sticky ヘッダ）
  - Mermaid (`.mermaid`/`.mmd`): `renderStandaloneMermaid` が `lib/mermaid.ts` の `getMermaid()` を遅延 import して SVG 描画（ズーム対応）
  - JSON/JSONL: キー/文字列/数値/bool/null を色分け、JSONL は 1000 件 truncate、`\n`/`\r` を含む文字列値クリックでデコード済みポップアップ
  - SVG: `DOMPurify.sanitize` + `SVG_PURIFY_OPTS`。`IMAGE_EXTS` から除外し EditorTab で開く
- Markdown 内 mermaid: previewHtml 更新時に `code.language-mermaid` ブロックを検出し `mermaid.render()` で SVG に差し替え
- **Markdown フロントマター（#229）**: `lib/frontmatter.ts` の `detectFrontmatter` が範囲を返し、`lib/frontmatterParse.ts` の `parseFrontmatter` が `yaml` / `smol-toml` / `JSON.parse` で key/value に落とす。プレビュー（`buildMarkdownPreview` が `marked.parse` の前に本文を切り出して `<details>` の表を前置）とアウトライン（`extractors/markdown.ts` が `bodyFrom` より前の見出しを捨てる）で**範囲検出だけ**を共有する（描画経路がテキストと Lezer 構文木で別のため）
  - **ファイルを 2 つに割っているのはバンドルの都合**。`lib/outline/index.ts` が 18 個の extractor を静的 import で 1 チャンクに束ねるので、パーサを同居させると YAML/TOML パーサ（合わせて約 106KB）が Go や Rust のアウトラインにも載る。実測で outline チャンクが 267KB → 161KB。`frontmatter.ts` は依存ゼロを保つこと
  - **パース失敗は理由（`reason`）で返し、文言はプレビュー側で当てる**。`t()` をパーサに置くと、`not-mapping` だけ日本語で `yaml` クレート由来のメッセージは英語のまま、という食い違いになる
  - **切り離さないとフロントマターが `<h2>` に化ける**。CommonMark では水平線と setext 見出しが両方成立するとき setext が勝つので、開きの `---` が見出し本文、閉じの `---` がその下線になる。marked のバグではない。アウトラインに出ていたのも Lezer が同じ判定で `SetextHeading2` を作るため
  - **判定はファイル 1 行目のデリミタだけ**。フロントマターに仕様は無く（Jekyll 発祥の慣習で、CommonMark にも GFM にも規定がない）実装ごとに差があるので、文書の途中の `---` を拾わない線引きに寄せる。YAML `---` / TOML `+++` / JSON `{`（Hugo。フェンスが無いので波括弧の釣り合いで終端を決める）の 3 つ
  - 閉じデリミタが無ければフロントマター無しとして扱う。BOM は不可視のまま全オフセットをずらすので先に長さを測る
  - **パース失敗は握り潰さず生テキストを `<pre>` で出す**（黙って消すと本文が消えたようにしか見えない）。この場合だけ `<details>` を開いた状態で出す
  - 開閉状態は `frontmatterOpen`（**ref ではなく素の変数**）に持ち、`trackFrontmatterToggle` が描画のたびに DOM へ復元する。`previewHtml` は編集のたびに HTML を作り直すので DOM 側だけに置くと打鍵で閉じるが、reactive にすると開閉のクリックごとに `previewHtml` が無効化され、mermaid の再描画とローカル画像 1 枚につき 1 回の IPC 読みが走る
- **外部ドメインの画像（#239）**: README のバッジを出せるようにするためのドメイン単位のオプトイン。**CSP は広げない**（`img-src` は `'self' data: blob:` ＋マニュアル用の raw.githubusercontent.com のまま）。承認済みホストの画像だけ `remote_image_fetch` で取ってきて `data:` URL にする。承認は `settings` の `allowedImageHosts`（`pike:settings` に載るので同期・クロスウィンドウ broadcast の対象）
  - **CSP を `https:` まで広げる案は採らなかった**。CSP は文書単位なので、プレビューのために緩めると**エージェントチャット（`AgentChatTab.vue` の markdown）・SVG プレビュー・マニュアル**まで一緒に壁を失う。とくにチャットは web fetch の結果や貼り付けた README がそのまま流れてくる面で、いちばん緩めたくない。代わりに `resolveMarkdownImages` が**ローカル画像で既に使っている `data:` URL 化**に相乗りさせた（`fs_read_file_base64` の隣に `remote_image_fetch` を置いた形）
  - この分担だと**実際に遮断しているのは CSP で、フロントの処理は見た目だけ**になる。取りこぼした経路があっても壊れた画像が出るだけで、黙って通信が飛ぶことはない
  - **画像の解決はすべて `resolveMarkdownImages` の 1 パス**。ローカルと外部を分けると、同じ `<img>` を 2 回走査したうえに「どちらが後に src を書いたか」に依存する。読み込みは `Promise.all` で並列（遅いホストが隣の画像を待たせない）
  - **`srcset` と `<picture><source>` は落とす**。ブラウザは `src` より先にそちらを見るので、残すと解決した `src` が使われない。挿入後に落として構わない（CSP が既にリクエストを止めている）
  - 対象は `https:` だけ。`http:` はバックエンドが弾くので承認する意味がなく、チップも出さない
  - **ローカル画像の解決は `resolveLocalImage` の 3 つのガードで決まる（#241）**: 拡張子の判定の前に `?` / `#` 以降を落とす、`paths.ts` の `isEmbeddableImage`（＝`isImageFile` + svg）で見る、`/` で始まる src はプロジェクトルート起点にする。**`IMAGE_EXTS` に svg を足さないこと**（あれはタブの振り分け用で、`.svg` は EditorTab で開く仕様）。`<img>` の中の SVG はスクリプトも外部参照も走らない（secure static mode）ので、`.svg` タブ側のサニタイズは要らない
  - **取得結果はモジュールレベルでキャッシュする**（`lib/externalImages.ts`）。プレビューは打鍵のたびに作り直すので、無いとバッジを打鍵ごとに取りに行く。**失敗も覚える**（死んだ URL を同じ頻度で叩かないため）。チップのクリックが `retryRemoteImage` でその 1 件だけ忘れる
  - チップの文言は DOM に焼き込まれるので、再適用の watcher は許可リストと `locale` の 2 つ。**`previewHtml` は許可リストに依存させない**（依存させると承認のたびに mermaid の再描画とローカル画像 1 枚につき 1 回の IPC 読みが走る）
  - **許可は同期対象にしてある**: バッジのホストを信用したという判断はマシンに依存しない（`globalShell` 等のマシンローカル扱いとは別）
  - Rust 側のガードは https / **リダイレクト不追従** / `image/*` / 15 秒 / 8MB の 5 つ。**どのホストを許すかは持たない**（承認リストとダイアログはフロントの持ち物）。リダイレクトを追わないのはフロントの判定を意味あるものに保つため（追うと `img.shields.io` を許可したつもりが 302 で任意のホストへ飛べる＝承認したホストと応答するホストがずれる）。解決先アドレスの制限（loopback / RFC1918 / link-local）は**入れていない**: 社内の画像サーバーを指す README は実在するうえ、ホスト名を出したダイアログで承認させている。入れるなら解決したアドレスを接続に固定するところまでやらないと、リテラル IP を弾くだけで rebinding は通る。TLS プロバイダは updater と同じ ring を明示的に入れる（updater は自分がクライアントを組むときにしか入れないので、更新確認より先に画像を取ると provider 無しで落ちる）
- 画像: `PreviewTab.vue`（base64 dataUrl を `<img>` 表示）。上部ツールバーで**表示専用**（ファイルは無変更）のビューワ操作を提供:
  - 拡大 / 縮小 / 100% / ウィンドウに合わせる（fit）、左右 90° 回転・左右反転
  - スクロールコンテナは flex 中央寄せを使わず**ステージ側 `margin: auto`** で中央寄せ（`align-items: center` だと画像がビューポートより大きいとき上端がスクロール領域外に押し出され到達不能になる不具合を回避）。スクロール領域は**回転後のバウンディングボックス**（`stageW`/`stageH` computed）が駆動
  - ズームは transform scale ではなく img の width/height で表現し、回転・反転は `translate(-50%,-50%) rotate() scaleX()` の transform で適用
  - `applyZoom` がズーム前後のスクロール比から `scrollLeft/Top` を補正し、カーソル（または中央）位置を固定。Ctrl+ホイールズーム / ドラッグでパン（`canPan` 時のみ、グローバル mousemove/mouseup は `onUnmounted` でも除去）/ ダブルクリックで fit⇔100%
  - キーボード（canvas に `tabindex="0"`）: `+`/`-` ズーム、`0`=100%、`f`=fit、`r`/`Shift+R`=回転。透過グリッド（チェッカーボード）背景の切替、画像実寸（W×H）表示。ツールバー文言は `preview.*` i18n（日英）
- PDF: `PdfTab.vue`（`<iframe src="data:application/pdf;base64,...">` による WebView2 内蔵レンダリング）
- ファイルツリー `openFile()` が拡張子で画像→PreviewTab / PDF→PdfTab / その他→EditorTab を振り分ける

## ファイル/画像ペースト
- `composables/useImagePaste.ts`。クリップボード/D&D のファイルを `.pike/uploads/` に保存 → 相対パスを挿入（エージェントチャットは `@パス` メンション、ターミナルは bare path）。画像専用ではなく**任意のファイル**が対象（PDF 等も可）
- 判別は **file か string か**（`ClipboardEvent` は `item.kind === 'file'`、D&D は `dataTransfer.files`）。テキスト（string）は長さに関係なくインライン貼り付けのまま
- 保存ファイル名は元名を保持（`stem-{hex}.ext`、衝突回避）。名前を持たないクリップボード blob（画像等）は `upload-{ts}-{hex}.{ext}` を生成
- 初回保存時に各プロジェクトへ `.pike/.gitignore`（中身 `*`）を書き込み、退避ファイルを repo から除外
- **小ファイルのインライン展開**（設定 `inlineSmallTextFiles`、既定OFF / 閾値 `inlineSmallTextThreshold` 既定4KB）: **AgentChatTab 限定**。ファイルがサイズ上限以下 **かつ** 中身が UTF-8 テキスト（`isProbablyText` で NUL/不正バイト判定）なら、アップロードせず内容を直接挿入。PDF・画像等のバイナリは常にアップロード。ターミナルへのドロップは常にアップロード（`tryInlineFile` は使わない）
- xterm は Ctrl+V を SYN(`\x16`) として食うため `attachCustomKeyEventHandler` で横取り。右クリック/Ctrl+V は `navigator.clipboard.read()` 経由だが、この API は**画像とテキストのみ**返す（任意ファイルは取得不可）→ ターミナルへの任意ファイル投入は D&D が主経路
- ファイルツリー / OS からのドラッグ&ドロップにも対応

## ファイル監視 (File Watcher)
- Windows プロジェクト: `notify` クレート（v7）で `ReadDirectoryChangesW` ベースの再帰監視
- WSL プロジェクト: `wsl.exe inotifywait -m -r` を長寿命サブプロセスとして起動（`inotify-tools` 必要、未インストール時は graceful degrade）
- イベントバッチ処理: 200ms デバウンス + 1s max wait でフロントに送信
- `IGNORED_DIRS` (.git, node_modules 等) をフィルタ
- `fs_changed` イベントで `changedDirs`（ツリー更新用）+ `changedFiles`（エディタ更新用）を送信
- エディタ外部変更検知: clean タブは自動リロード、dirty タブはインライン警告バー（Reload/Overwrite/Dismiss）
- 自己書き込み除外: `markRecentlySaved()` で 2秒 TTL のパス Set を管理
- ウィンドウ破棄時に全 watcher 停止（`watcher::stop_all`）
- Rust `WatcherState` を `AppState` で管理、`fs_watch_start` / `fs_watch_stop` コマンド

## 検索 (rg / grep)
- 起動時に `which rg` で backend 判定、以降固定
- rg: `rg --json -F/-e --glob` でパース容易な出力
- grep: `grep -rn --include/--exclude` でフォールバック
- フロントには検索バックエンドをバッジ表示
- 結果クリックでエディタタブを開き、`initialLine` で該当行にジャンプ
- 最大 500 件で truncate、デバウンス 300ms
- rg サイドカーバンドル: `src-tauri/binaries/rg-{target}.exe` を `externalBin` でアプリに同梱
  - Windows プロジェクト: システム rg → バンドル版 rg → grep の順でフォールバック
  - WSL プロジェクト: WSL の rg → WSL の grep（バンドル版は Windows バイナリのため使用不可）
  - `scripts/download-rg.sh` でビルド前にダウンロード（バイナリは .gitignore）
- `list_project_files` コマンド: `rg --files` / `find` でプロジェクト内ファイル一覧取得（QuickOpen 用）

## QuickOpen コマンドパレット（Ctrl+P）
- 先頭文字でモード切替: 無印=ファイル fuzzy open、`>`=タスク実行、`@`=タブ切替、`:`=行ジャンプ、`!`=Git ブランチ切替、`?`=ヘルプ
- `> Claude` / `> Codex` で新規エージェントタブ作成。`filename:42` サフィックスで行番号ジャンプ
- `QuickOpen.vue` は ProjectSwitcher と同じオーバーレイ + モーダル構造、表示状態は `project.showQuickOpen`
- fzf 風 fuzzy match（ファイル名優先 → パスマッチ）、最近開いたファイルを上位表示
- `rg --files` の結果をフロントでキャッシュ、プロジェクト切替時にリセット

## 定義ジャンプ（Ctrl+Click / F12）
- `lib/editorJumpTo.ts` + `lib/jumpTo/`。TS/JS/Vue/Go の import パスを Ctrl+Click でファイル open
- 識別子は同一ファイル内宣言（Lezer 構文木）と import 経由のクロスファイル定義の両方に対応
- Vue カスタムコンポーネントは `<script setup>` の PascalCase import / Options-API `components` / `app.component()` グローバル登録の 3 段で解決
- path alias 解決: tsconfig/jsconfig の `compilerOptions.paths` と vite.config の `resolve.alias`（祖先方向に config 探索、モノレポ対応、設定変更で自動 invalidate）
- 進捗・結果は `stores/statusMessage.ts` 経由で StatusBar に表示（スピナー / 開いたファイル名 / 見つからない）

## アウトラインパネル（Outline）
- `outline` サイドバーパネル。`lib/outline/` の言語別 extractor（18 言語: Markdown / TypeScript+JSX / Vue / HTML / CSS+SCSS / Rust / Python / Go / Perl / YAML / JSON / Ruby / Kotlin / Swift / PHP / Dockerfile / TOML / Makefile）でシンボルを抽出
- カーソル位置追従ハイライト・祖先自動展開・scrollIntoView、タブ別スクロール位置保持
- Outline / History 2 タブ構成（`OutlineTreeView.vue` / `OutlineHistoryView.vue`）。History はファイル別 git log を表示、行クリックで diff タブを開く
- 行オフセットは `buildLineOffsets` / `lineStart` で O(N) 前計算（`composables/useOutlineSource.ts`）

## 診断パネル（Problems）
- **常駐 LSP は持たない**（「軽さ最優先」）。`src-tauri/src/diagnostics/mod.rs` が検出したツールチェインの CLI を**オンデマンドで 1 回**走らせ、構造化出力をパースして `Diagnostic` に正規化する
  - Rust: `cargo check --message-format=json`（stdout の JSON Lines）/ Go: `go vet ./...`（stderr のテキスト）/ TS・JS: `tsc --noEmit --pretty false`（stdout のテキスト）
  - マニフェスト（`Cargo.toml` / `go.mod` / `tsconfig.json`）の探索深さは `MAX_DEPTH`=4。コマンドは**そのマニフェストのディレクトリ**で実行するので、出力のパスがそのまま解決できる
  - 冷えた `cargo check` / `tsc` は遅いので `TIMEOUT_SECS`=180。UI が溢れないよう `MAX_DIAGNOSTICS`=2000 で打ち切る
  - 結果は `ProviderRun`（プロバイダ名 / 実行ディレクトリ / **実行したコマンド** / ok / error / 件数）も返し、パネルのヘッダで失敗したチェッカーを提示する（`title` にコマンドとエラー文。コマンドはプロジェクト側で上書きできるので、名前だけでは何が走ったか分からない）
  - `Task.command` は `Option`。**既定は `None`＝worker 側で解決**で、`golangci` だけ go.mod を読んだついでに確定済みの値を載せる。`ts` の vue-tsc プローブ（WSL では 1 dir につき `wsl.exe` 1 回）は worker で走らせないと並列性を失い、tsconfig の数だけ直列の待ちが増える
- **golangci-lint（#213、opt-in）**: Go モジュールに `.golangci.{yml,yaml,toml,json}` が同階層以上にある、または go.mod が golangci-lint を参照していれば対象（`golangci_tasks`）。**検出は毎回・実行は要求時だけ**で、`diagnostics_run(shell, root, golangci)` の引数と結果の `golangciAvailable` で分ける（モジュール全体の型検査を伴い他のチェッカーより重いため、自動更新に常時混ぜない）
  - 起動方法は go.mod 由来（`go_mod_golangci` がコマンド文字列を直接返す）: Go 1.24 の `tool` ディレクティブなら `go tool golangci-lint run ./...`、それ以外で名前が出てくれば PATH 上のバイナリ。go.mod は `crate::fs::batch_read_files` で**全モジュールを 1 回の wsl.exe 往復**で読む（トグルが OFF でも可否判定に go.mod が要るので Go プロジェクトでは毎回 1 往復かかる。秒単位のチェッカーの隣なので許容している）
  - **コマンド上書き（`ProjectConfig.golangciCommand`）**: lint の入口が Docker にあるプロジェクト向け（sitter の `docker compose exec -T golang make lint` 等）。**上書きがあれば検出も go.mod 読みもしない**（プロジェクトが lint 方法を宣言している時点で opt-in なので、`.golangci.*` の有無を問わず go.mod のあるディレクトリ全部が対象になる）。実行ディレクトリは組み込みと同じ Go モジュールのディレクトリで、コンテナ側の作業ディレクトリにそのモジュールをマウントしていれば出力のパスがそのまま解決できる。**モジュールが複数あっても実行は 1 回**（いちばん浅いディレクトリ）: 兄弟モジュールに配ると同じコマンドが N 回走るうえ、同一の指摘が別々の base で解決されて `dedup` が畳めない（存在しないパスを指すコピーが N-1 個出る）。UI は ProjectPanel の編集フォーム（`ProjectListItem.vue`）の入力欄で、パネルのトグルの tooltip に実行するコマンドを出す。同期（#164）の共有フィールドにも入れてある（マシン非依存なため）
  - **出力フォーマットのフラグは渡さない**。JSON 出力のフラグ名が v1（`--out-format`）と v2（`--output.json.path`）で変わっており、知らないフラグを渡すと実行自体が落ちる。既定のテキスト出力は両者共通で、色は stdout が TTY でないため自動的に切れる
  - パースは go vet と同じ `path:line:col: message` なので `split_location` を共有。末尾の `(linter)` は `code` に移し、`typecheck` だけ Error（実際のコンパイルエラーのため）。**v1 が各指摘の下に流す元ソース行とキャレットは、行頭が空白かどうかで落とす**（`"a:1:2: x"` のような文字列リテラルを含む行が位置行として通ってしまうため。指摘行は必ずパスで始まる）
  - **未インストールを「問題なし」に見せない**: `ProviderSpec.optional_binary`（golangci だけ true）が立っていると、終了コード != 0 かつパース結果 0 件のとき stderr の 1 行目を `ProviderRun.error` に出す。issue 検出時も非 0 で終わるので、パース結果 0 件が「そもそも走らなかった」の目印になる。cargo / go vet / tsc も同じ死角を持つが、既存プロジェクトの表示を変えることになるので false のまま据え置いている
- フロントは `stores/diagnostics.ts` + `panels/DiagnosticsPanel.vue`。パネルを開いた時に未実行なら `run()`（`lastRunAt` で判定）。行クリックで該当箇所をエディタで開き、ホバーの 🤖 で修正依頼をターミナルへ注入（前述の `useTerminalInject`）。エディタ側のインライン下線は `lib/editorDiagnostics.ts`。`golangciAvailable` のときだけ出る golangci-lint トグルは `localStorage` の `pike:diagnostics-golangci` に**プロジェクト id の配列**で永続化する（`golangciAvailable` はプロジェクト固有なので `clear()` で落とす）。**グローバルな真偽値にしないこと**: パネルは初回 `run()` の応答で可否を知るので、フラグが立っていると別プロジェクトを開いてパネルを出した瞬間に、そのプロジェクトの（コンテナ実行かもしれない）lint が同意なしに走る

## タスクランナー（Tasks パネル）
- `tasks` サイドバーパネル。`src-tauri/src/tasks.rs` の `task_discover` がプロジェクトルートを**最大深さ 5**で再帰走査し、`package.json` / `Makefile` / `justfile` / `deno.json` / `Cargo.toml` を検出
- `package.json` の `scripts`、Makefile のターゲット、deno tasks、cargo（#122: 標準サブコマンド build/check/test/clippy/fmt + `[[bin]]` ごとの `run --bin {name}` を合成。パースは `toml` クレート。**Tauri 判定はマニフェスト隣の `tauri.conf.json` 存在**（tauri-cli 自身の契約。依存名スキャンだとプラグイン開発リポジトリ等で誤検出）で `tauri dev`/`tauri build` を追加。`src/main.rs` があれば `run`（`[[bin]]` 併存時は `run --bin {package名}`）。**workspace メンバーは標準セットを出さない**（ルートと重複して洪水になるため。bins/tauri/run のみ）。bin/package 名は Makefile と同じ文字種検証（英数 `-_.`）でシェルメタ文字注入を防止。`tauri.conf.json`/`main.rs` は existence-only マーカーとしてグロブに含め content は読まない。`[package]`/`[workspace]` を持たない Cargo.toml は対象外。vendor/ 配下は全タスク検出から除外、読み込みは `MAX_TASK_FILES`=300 で打ち切り）をそれぞれ「グループ」として一覧表示（ラベルに相対ディレクトリ名を付与）
- **パッケージマネージャの判別**: `package.json` の scripts は npm 決め打ちではなく、`node_runner_for` が npm / pnpm / yarn / bun を選ぶ（`RUNNER_COMMANDS` が `pnpm run {name}` などを組む）。優先順は (1) そのファイルの `packageManager` フィールド（corepack。パッケージ自身の宣言なので最優先。`pnpm@9.1.0` の名前部分だけ見る）、(2) **直近の祖先**にある lock ファイル、(3) npm。**祖先方向に辿るのが要点**で、pnpm モノレポでは lock がリポジトリ root にしか無く、配下の `packages/*/package.json` は自分のディレクトリを見ても分からない（実測: ratatoskr の `web/package.json`）。lock ファイルは cargo の `tauri.conf.json` と同じ existence-only マーカー（`pnpm-lock.yaml` / `pnpm-workspace.yaml` / `yarn.lock` / `bun.lockb` / `bun.lock` / `package-lock.json`）で、中身は読まない。同じディレクトリに複数あるときは `rank` の高いほうを採り、**`package-lock.json` を最も弱くする**（pnpm へ移行しても消し忘れて残りがちなため）。祖先判定は文字列の前方一致だけでは足りず区切り文字まで見る（`/repo/app2` は `/repo/app` の配下ではない）
- **just（#231）**: `parse_justfile` が justfile を自前でパースする（`just --summary` を叩かない。**just 未インストールでも一覧が出る**し、他の runner と同じ「見つけたファイルを `batch_read_files` で 1 回まとめて読む」に乗る＝WSL への往復が増えない）。レシピ行は「インデントされていない行のうち、クォートの外に `:` を持つもの」で、`x := "y"` の代入・`alias b := build`・`set shell := [...]` は `:` の直後が `=`、`import 'x'` / `mod sub` はそもそも `:` を持たないので落ちる。`_` 始まりと `[private]` 属性は出さない。ファイル名は just と同じく大小文字の変種（`justfile` / `Justfile` / `JUSTFILE` / `.justfile`）を並べる（rg の glob と WSL の `find -name` は大小を区別する。`.justfile` は隠しファイルだが `--hidden` は `.cargo/` 用に既に付いている）
- **doc comment を表示に使う**（#231）: `DiscoveredTask.description` は just だけが持ち、レシピ直前の `#` コメント（`just --list` が右に出すもの）を入れる。パネルはこれを名前の右に薄く出し、QuickOpen の `>` モードでは `command` の代わりに出して**絞り込みの対象にも入れる**（日本語で書いたコメントから引ける）。名前だけでは何をするレシピか分からないため。`command` は `just bump VERSION` のような**引数込みの呼び出し行**にしてあり（実行されるのは `RUNNER_COMMANDS` が名前から組む `just bump` なので）、引数が要るレシピはツールチップで分かる
- **cargo alias**: `.cargo/config.toml` の `[alias]` を検出し `cargo {alias名}` タスクとして表示。同じベースディレクトリ（`.cargo` の親）に Cargo.toml があればその cargo グループの**先頭**にマージ（同名の合成タスクは除去。alias は builtin を上書きできないため実行結果は同一）、なければ独立グループ「cargo alias」（例: musql の repo root）。alias 名は `is_safe_cargo_name` で検証（シェルに渡るのは名前のみ）、値（string / string 配列）は tooltip 表示用の展開コマンドにのみ使用。検出は rg なら `--hidden -g '!.git'` + `**/.cargo/config.toml` glob（隠しディレクトリのため）、find/walkdir フォールバックは basename `config.toml` マッチ後に親が `.cargo` のものだけ残す（Hugo 等の無関係な config.toml は content-read しない）。ancestor 方向の alias 継承（cargo 本来の config 解決）は追わず同一ディレクトリのみ
- 除外: `IGNORED_DIRS`（`.git node_modules __pycache__ .next .nuxt target dist build .cache .venv venv`）
- `.gitignore` を尊重するのは **rg バックエンド使用時のみ**（`rg --files --max-depth 5 -g <glob>`）。rg が無く `find`(WSL)/walkdir(Windows) フォールバックの場合は `.gitignore` を見ず `IGNORED_DIRS` のみで除外するため、ネストした `package.json` がより多く出る
- タスク実行はプロジェクトのデフォルトシェルで `autoStart` + `closeOnExit`（完了でタブ自動クローズ）。サブディレクトリのタスクは正しい CWD で起動
- グループ見出しの sourceFile クリックで定義ファイルをエディタタブで開く（#159。`taskStore.openSourceFile`、`group.cwd` + `basename(sourceFile)` で絶対パス化）
- フロント: `stores/tasks.ts` + `components/panels/TasksPanel.vue` + `types/tasks.ts`

