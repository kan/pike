---
paths:
  - "src-tauri/src/fs/**"
  - "src/components/editor/MacroButtons.vue"
  - "src/components/editor/WrapToggle.vue"
  - "src/components/editor/MinimapToggle.vue"
  - "src/components/tabs/EditorTab.vue"
  - "src/components/panels/FileTreePanel.vue"
  - "src/components/panels/OutlinePanel.vue"
  - "src/components/panels/outline/**"
  - "src/components/QuickOpen.vue"
  - "src/lib/editor*.ts"
  - "src/lib/jumpTo/**"
  - "src/lib/outline/**"
  - "src/lib/fileType.ts"
  - "src/lib/languages.ts"
  - "src/lib/templateModes.ts"
  - "src/lib/fileIcons.ts"
  - "src/lib/openFile.ts"
  - "src/stores/fileTree.ts"
  - "src/composables/useOutlineSource.ts"
  - "src/composables/useActiveFile.ts"
  - "src/composables/useImagePaste.ts"
---

# エディタ実装ルール

CodeMirror 6 のエディタ、ファイルツリー、保存、マクロと整形、QuickOpen、定義ジャンプ、アウトライン。
実体は `src/components/tabs/EditorTab.vue`、`src/lib/editor*.ts`、`src/lib/outline/`、`src-tauri/src/fs/`。

同じ領域の別ファイル: プレビューと Markdown の入力支援は `preview.md`、検索は `search.md`、
ファイル監視は `watcher.md`、issue パネルは `issues.md`、診断とタスクのパネルは `panels.md`。

## ファイルツリー / エディタ
- Rust `fs` モジュールがファイル操作を提供（list_dir / read_file / write_file）。分岐は**「WSL かどうか」だけ**で、Windows も macOS も `std::fs` の腕に乗る
- WSL: `wsl.exe find`, `wsl.exe cat`, `wsl.exe bash -c "cat > ..."` 経由
- **ファイルサイズの上限（#362）**: エディタは設定の `editorMaxFileSizeMb`（2〜50MB、既定 10MB）を `fs_read_file` の `max_bytes` に渡す。**渡さない呼び出し元（定義ジャンプの設定ファイル読み・diff の省略行の取り寄せ等）は 2MB**（`DEFAULT_MAX_SIZE`）
  - **超えたらエラーではなく結果で返す**（`FileReadResult.too_large`。`allow_missing` と `is_new` と同じ「頼んだ呼び出しにだけ返る」形）。`max_bytes` を渡さない呼び出し元にはエラー。エラー文の綴りを Rust と TS で取り決める形は採らない
  - EditorTab はエラー画面ではなく、開き方を選ばせる画面（`tooLargeSize`）を出す: 先頭から読み込む（部分読み込み）・関連付けられたアプリで開く（`lib/openFile.ts` の `openWithDefaultApp`。**実行形式の拡張子は確認を挟む**: Windows の `explorer.exe` はスクリプトもショートカットもそのまま起動する。ファイルツリーの右クリックもここを通る）・フォルダを開く（`fs_reveal_in_explorer`。Windows の `/select,` は `raw_arg` でないと効かない理由は `types::os_reveal` の doc）
  - **部分読み込み（`fs_read_file_chunk`）の切れ目は最後の改行の直後**（`chunk_end`）。続きを足したとき 1 行が割れない。改行が無い長い 1 行だけ UTF-8 の文字境界で切る。**UTF-16 は対象外**（`0x0A` が文字の途中に現れる）。エンコードは**UTF-8 のあいだは断片ごとに判定し、UTF-8 以外に決まったら固定する**（`applyChunk`。先頭が ASCII だけのログを UTF-8 で固定すると、後ろの Shift_JIS が化ける）
  - **「続きを読む」は上部のバーと本文の末尾の 2 か所**（末尾は `lib/editorLoadMore.ts` のブロック widget）。**CSV では上部のバーのボタンを出さず、表の上（コピーの注意書きの下）に案内とボタンを描く**（`lib/csvPreview.ts` の `CsvPartialLoad`、クリックは `handleCsvControls`）。ページの帯と並ぶと、どちらが何を送るのか紛らわしいうえ、「全行をコピー」の全行が読み込んだ範囲だと同じ場所で言える。**押したときだけ読む**: 末尾までスクロールしたら自動で読む形は、スクロールしただけで数 MB ずつ読み込みとメモリが増えるので採らない
    - **末尾の行は `overflow-anchor: none`**。押した直後に画面に残っているのはその行だけなので、ブラウザのスクロールアンカーに選ばれると、足した本文のぶんだけ送られて新しい末尾へ飛ぶ。末尾から読んだときは、それまでの最終行を下端に据える（`loadMore(fromEnd)`）
  - **続きの断片は全体で NUL を見る**（`fs_read_file_chunk`）。`decode_bytes` の判定は先頭 8KB だけなので、テキストの後ろにバイナリが続くファイルで化けた本文が足される
  - **部分読み込み中は読み取り専用**（`isReadOnlyTab` に含める。保存すると読んでいない後半が消える）。保存・自動保存・diff ガター・外部変更の「上書き」がすべてこの 1 つを見る
  - **部分読み込み中は外部変更で自動リロードしない**。読み直しは先頭の 1 回ぶんに戻るので、書き足され続けるログで「続きを読む」の位置が変更のたびに失われる。警告バーの「再読み込み」は出す
  - **部分読み込み中は `updateDirtyState` が何もしない**（読み取り専用で未保存になりようがない）。全文比較は続きを足すたびに文書全体（数十 MB）を文字列にするので、比較そのものを飛ばす。`savedContent` も伸ばさない
- CodeMirror 6 でエディタタブ。テーマは `lib/editorThemes.ts` の 6 種（One Dark / Default Light / Dracula / Nord / Solarized Light / Monokai）+ Auto（ダーク/ライト追従）
  - **選択範囲の色には `::selection` を必ず併記する**（#407。綴りの出典は同ファイルの `selectionRules` で、選択行と行番号のガターを対で塗るのもあそこ）。Pike は `drawSelection` を入れていないので、選択を描くのは `.cm-selectionBackground` ではなく**ブラウザ自身**で、そこへ届くのは `::selection` だけ。書かないとテーマの選択色が 1 つも効かず、WebView の既定色（app のテーマに追従しない）のまま残る。以前は One Dark だけが正しく見えていたのは、パッケージ側のテーマがこの綴りを持っていたため
  - **選択行（`.cm-activeLine`）と選択範囲の濃さは、テーマごとに手で置く。** 背景色からの機械的な計算にしないのは、本文が読める濃さがテーマによって違うため。関係は「選択行 < 選択範囲」で、One Dark はパッケージのテーマを触れないので `oneDarkTuning` を重ねる（あちらの `.cm-activeLine` は不透明度 4% で、背景とほぼ見分けられない）
    - **重ねるモジュールは詳細度で勝たせる**（`&.cm-editor` を足す）。拡張の並びでも勝てるが、その根拠は `@codemirror/view` が theme の facet を `reverse()` して mount するという**内部の挙動で、公開契約ではない**。順序に頼るとパッケージの更新で無言で効かなくなり、気付けるのは目視だけになる
  - **エディタの外の選択範囲は `theme.css` の `::selection` と `color-scheme`**（#407）。`color-scheme` を宣言しないと、UA が自前で決める色（既定の選択範囲・ネイティブのフォーム部品）が OS のテーマのままになり、Pike をライトにしていても選択範囲だけダークの色合いで描かれる
- **「このファイルは何か」を決めるのは `lib/fileType.ts` の `fileTypeKey` ただ 1 つ（#347 / #348）。** 種別のキーとラベルの正本は同ファイルの `FILE_TYPE_LABELS`（件数をここに書かない。足すたびにずれる）。読む側は 4 つで、**新しく「ファイルの種別を見る」コードを書くときも必ずここを通す**（系統ごとに判定すると、同じファイルで答えが割れる）
  - ハイライトと StatusBar の種別（`lib/languages.ts` の `EXT_MAP`）／アウトラインの抽出器（`lib/outline/index.ts` の `EXTRACTORS`）／定義ジャンプの `langId`（`lib/jumpTo/`）／ファイルアイコンの補い（`lib/fileIcons.ts` の `ICON_FALLBACK`）
  - **`EXT_MAP` と `EXTRACTORS` は `Partial<Record<FileTypeKey, …>>` で縛ってある。** ラベルを持たないキーにモードや抽出器を足すとコンパイルエラーになるので、「色は付くのに種別が Plain Text」が型の届かないところに戻らない。逆（ラベルだけあってモードが無い）は許す
  - **判定の表に CodeMirror を import しない。** アイコンやアウトラインから、種別を知りたいだけのために言語モードの束を読み込ませないため
  - 優先順（名前 → 後ろ 2 セグメント → 拡張子 → 先頭セグメント → shebang）と、先頭セグメントで引く名前を絞る理由（`go.mod` の誤判定）は `fileTypeKey` の doc が正本
  - **shebang に載せるのは既に import 済みのモードだけ**（「軽さ最優先」。`fish` / `awk` はモードを増やすことになるので入れない）。`env` と `-S`、末尾のバージョン（`python3.11`）の扱いは `shebangKey` の doc が正本
  - **テンプレートエンジン（ERB / Blade / Twig / Smarty / Text::Xslate、#409）は `lib/templateModes.ts` の `multiplex`。** legacy の `html` モードに、区切りの内側だけ別の StreamParser を差し込む（CM5 の multiplex と同じ手法）。依存は増やさない
    - **外側は `lang-html`（Lezer）ではなく legacy の `html`**。行の文字列を閉じの区切りの手前で切って（`withCut`）内側のモードに見せる手法は、StreamParser 同士でしか組めない
    - 中身は ERB だけ `ruby` のモード、残りは自前の小さな式のモード（`exprMode`。語彙を切り替えて使う）。**legacy-modes に PHP は無い**（`lang-php` は Lezer）ので、Blade も `exprMode`
    - **`<script>` / `<style>` の中身は legacy の JS / CSS にし、その中でも同じ区切りを拾う**（`template` の `embed`）。`.blade.php` は以前 `lang-php` 経由でここに色が付いていたので、落とすと退行になる。入り方は正規表現の開きではなく `enterAfter`（外側が `>` を読んだ直後に行のそこまでを見る）。後読みの開きだと `<script>` と同じ行でしか当たらず、中身が次の行から始まる普通の書き方で入れない
    - **Mod+/ のために `commentTokens` を渡す**（エンジンのコメント記法。Xslate は行コードの `: #`）。StreamParser が持たないと、コメントの切り替えが何もしない
    - `.blade.php` のアウトラインは出なくなった（以前は `phpExtractor`）。拾うのは `class` / `function` の宣言だけで、ビューには無いので実害は無い
    - **`.blade.php` は `fileTypeKey` の `SUFFIX_KEYS`（後ろ 2 セグメント）で拡張子より先に拾う**。最後の拡張子で引くと PHP になる
    - Smarty は **`{` の直後が空白ならタグにしない**（Smarty 3 の auto_literal）。埋め込んだ JS / CSS の波括弧を拾わないため。`.tpl` を Smarty に当てたのは #409 での判断（他のエンジンも使う拡張子）
    - Haml / Slim は対象外（HTML への埋め込みではなくインデントで構造を表す形で、専用のモードが要る。#409 で見送り）
  - **`.jsonc` / `.jsonl` は `json()`（Lezer）のままにしてある（#350 で実測して現状維持）。同じ疑問で調べ直さないこと**
    - `.jsonl` / `.ndjson` は壊れていない。パーサはレコードごとに復帰し、行の境目に入るのは**幅 0** のエラーノードだけで、トークンの色は落ちない
    - `.jsonc` で壊れるのはコメントの範囲だけ（`// comment` が 2 つのエラーノードになり、残りは正しく解析される）
    - `@codemirror/legacy-modes/mode/javascript` の `json`（stream）に移せばコメントも複数レコードも通るが、**`jsonExtractor` は Lezer の木（`Object` / `Property`）を歩く**ので `.jsonc` のアウトラインが消える。`property` のタグも既定の対応表に無いので `tokenTable` が要る
    - コメントを書くことが多い `tsconfig.json` / `.vscode/settings.json` は**拡張子が `.json`** なので、そもそも `jsonc` のキーに当たらない
  - **Vue SFC は `vue({ base: html({ nestedLanguages }) })` の重ね方で作る（#346）。** 3 つの層が別々の理由で要る。判断の実体は `vueSupport` の doc が正本
    - `<style lang="scss">` / `<style lang="less">` … `html()` の `nestedLanguages`（既定の規則が CSS を当てるのは `lang` が無いか `css` のときだけ）
    - テンプレートの式（`{{ }}` と `v-if` / `:prop` / `@event` の属性値）… `@codemirror/lang-vue`。**`nestedAttributes` では代用できない**（属性名を固定で並べる形なので、`:` と `@` で任意の名前が作られる Vue のバインディングを表せない）
    - `<script setup lang="ts">` … lang-html の既定の規則が元から効いているので足すものは無い
    - **`base` は `html()` の結果でなければならない**（lang-vue の契約）。style の設定はそちらへ乗せてから渡す
    - **定義ジャンプは壊れない。** `findInFile` が歩く `<script>` の部分木は変わらず、`tagNameAt` はそもそも構文木ではなく生テキストを見る（実測で確認済み）。アウトラインの Vue 抽出は自前のパーサを回すので元から独立
  - **SQL の方言はキーを分けて持つ（#358）。** `.sql` の自動判定が既定で解決するのは `sql`（標準）のまま。設定 `sqlDialect` が選ばれていると `fileTypeKey` がそこへ振り替える（`withSqlDialect`。動くのは `sql` に解決したときだけ）
    - **`FILE_TYPE_LABELS` は「引ける拡張子」の一覧でもある**ので、キーを足したことで `foo.mysql` / `foo.pgsql` / `foo.sqlite` も自動判定に載る。**`.sqlite` はバイナリ DB の拡張子でもある**が、`fs_read_file` の NUL ガードが先に弾く。方言の拡張子で開いたものは設定で振り替えない（書き手が方言を名乗っているため）
    - **開いているタブにも反映する**（`EditorTab.vue` の `sqlDialect` の watcher が言語を張り直す）。流し込みだけでは次に判定するときの値が替わるだけで、開いているタブは開き直すまで変わらない
    - **knob は `lib/fileType.ts` に置き、設定ストア側が流し込む**（`lib/shortcuts.ts` の `setShortcutPreset` と同じ形。あのモジュールはアイコンとアウトラインからも読まれるので、ストアを読む向きにすると依存が逆流する）。`immediate: true` が要る
    - **手動選択はこの設定に縛られない。** StatusBar は `languageByKey` を直に引くので、設定が `standard` のままでも 3 つの方言を選べる。`languageOptions()` はラベルで畳むが、`SQL` / `MySQL` / `PostgreSQL` / `SQLite` は別ラベルなので 4 つとも出る
    - **残りの方言（`mariaDB` / `msSQL` / `plSQL` 等）は入れない**（要望が出てから）
  - **Markdown のフェンスの中身も `EXT_MAP` で解析する（#344）。** `markdown()` に `codeLanguages` を渡す形で、**依存は増えない**（`@codemirror/language-data` は入れない）。別名表（`FENCE_ALIASES`）を実在するフェンス名から作った理由と、`Language` をキーごとにキャッシュする理由は `languages.ts` の doc が正本。プレビューのコードブロックの色付け（#359）は `preview.md`
    - **アウトラインにフェンスの中身は出ない。** `@lezer/markdown` はフェンスを**オーバーレイ**としてマウントし、`Tree.iterate` はオーバーレイに入らないため（`IterMode` の指定では変わらないことを実測で確認）。**`resolveInner` 系へ書き換えるときは要注意**: あちらは中へ入るので、```` ```md ```` に貼ったコード例の見出しが文書の構造に混ざる
  - **shebang はアウトラインには効かない。** `langId` は `fileTypeKey(path)` で共通の判定を通るが、**1 行目を渡していない**ので shebang の段に届かない。効かせるなら `EditorTab.vue` が `langId` を作るところで 1 行目を渡すことになる
  - 判定は**開いたときと Save As の 1 回**。あとから shebang を書き足しても切り替わらない
  - **StatusBar から手動で上書きできる**。`fileTypeOverride` はタブ単位で
    セッションに残さない（`wordWrapOverride` / `minimapOverride` と同じ）。選択肢は
    `languageOptions()` が `EXT_MAP` から作り、**ラベルで畳む**（利用者に見せたいのは言語で
    あって拡張子ではない）。**ラベルを持たないキーは出さない**: 選んでも表示が `Plain Text` の
    ままで、切り替わったのか分からない
    - **変えるのはハイライトだけ**。プレビューと Markdown の入力支援（`isMarkdown` / `isCsv` /
      `hasPreview`）は `tab.path` から導いたままにする。連動させると、プレビュー表示中に
      Plain Text を選んだときの `viewMode` の戻し先まで設計が要る。線引きはマニュアルにも書いた
  - StatusBar へ渡す操作は `EditorActions` の 1 オブジェクト。**登録が 2 箇所ある**（読み込み
    直後とタブ切替）ので、位置引数にすると片方で末尾が抜ける
- **Save As は `tab.path` を書き換えるだけでビューを作り直さない**ので、ファイルの種類で決まるものは `tab.path` の watcher で張り直す。対象は**言語（`languageCompartment`）・入力支援のキー（`markdownCompartment`）・アウトラインの登録（`registerOutlineSource`）の 3 つ**。言語を入れ忘れると、無題バッファを `notes.md` として保存したときに「ツールバーとショートカットは効くのにハイライトも Enter の継続も無い」という半端な状態になる（Enter の継続は `@codemirror/lang-markdown` が持ち込むため）。アウトラインは登録時の path を焼き込むうえ、そのタブは既に active なので activeTabId の watcher では張り直されない
  - **compartment を 1 つにまとめないこと**。2 つは拡張リスト上の位置が違い、その順序が効いている: `defaultKeymap` が `Mod-i` を `selectParentSyntax` に割り当てているので、入力支援の keymap は**それより前に登録されている**から勝てる。言語は最後
  - diff ガター・Problems・ミニマップ・定義ジャンプは path を遅延で読むので張り直し不要（`hasFile` は無題バッファでも真になる）
- Ctrl+S で保存、ダーティ表示（タブタイトルに `*`）。Ctrl+Z/Shift+Z で Undo/Redo
- エディタ内検索・置換: Ctrl+F / Ctrl+H でカスタム検索パネル（右上フローティング、アイコンボタン、マッチ数表示）
- Git diff ガター: 追加行（緑）・変更行（黄）・削除行（赤三角）をガターに表示。`git_diff_lines` コマンドで行単位の差分を取得
  - **ポイントすると消えた行を出す（#322）**。`git_diff_lines` が行番号と一緒に `removed`（`RemovedBlock`）を返し、`editorGitGutter.ts` が `showTooltip` で見せる
    - **出すのは `-` の側だけ。** `+` の側は今エディタに映っているので、並べると同じ内容が 2 度出る。追加だけの行は何も持たない＝ツールチップも出ない
    - **Rust 側で切る**（`MAX_PREVIEW_LINES`=40 行 / `MAX_PREVIEW_LINE_LEN`=200 文字）。ガターはファイルを開くたびに取るので、全消しやミニファイされた JS では数 MB の JSON が毎回 IPC を渡ることになる。`total` に本当の行数を持たせて「ほか N 行」を出す。**切るのは文字数で**（バイトで切るとマルチバイトの途中で panic する）
    - **Rust は変更範囲の開始行にしか紐付けない**（`RemovedBlock.line`）。範囲の全行から引けるよう広げるのは `buildDiffData` の仕事で、同じ参照を張るので複製にはならない
    - **当たり判定は左へ 6px 広げる**（`.cm-gutterElement::after`）。帯は 3px しかなく、そこへマウスを合わせるのは狙いすぎになる。**右（本文側）へは広げないこと**: 本文に重なるとテキストの選択を奪う。左は行番号ガターで、Pike はそこに何も割り当てていない
    - ツールチップは `pointer-events: none`（本文に重なるため）＋ `overflow: hidden`。**`auto` にしないこと**: ガターから離れると消えるので、出したスクロールバーは押せない
    - ホバーの検出は `gutter` の `domEventHandlers`。**`mouseleave` も届く**（CodeMirror は gutter 要素そのものに `addEventListener` する）。`mousemove` は 1 ピクセルごとに来るので、**行が変わったときだけ dispatch する**
    - **`gutterMarkers` は `diffField` の結果を読む**（`tr.state.field(diffField)`）。`buildDiffData` を 2 度走らせないためで、`gitDiffGutter()` があちらを先に並べていることに依存する（StateField は extension の順に計算される）。**並びを変えるときはここも見ること**
    - **on-demand で取りに行く形は採らない。** ホバーのたびに `git diff` を起こすことになり、対話 UI のために外部プロセスを起こさないという方針（`agent.md` / `os-integration.md`）に反する。代償は「ホバーしない人も保存のたびに払う」ことだが、上限で最悪 80KB 程度のローカル IPC に収まる
- ミニマップ: `@replit/codemirror-minimap` を採用。blocks モード、シンタックスカラー反映、正確なスクロール同期、git diff ガター表示
  - **本文と重ならないよう、ミニマップを `.cm-editor` 直下へ出してある（#282）**。パッケージは `.cm-scroller` の中へ `position: sticky; right: 0` で入れるが、`.cm-content` の幅は最長行で決まりミニマップの存在を知らないので、折り返し OFF で長い行があると**スクロールしていなくても**本文がその下を通る。**判断の実体は `lib/editorMinimap.ts` の doc コメントが正本**（なぜ padding でも margin でも直らないか、なぜ再親化してもパッケージが壊れないか、幅の受け渡しがループしない理由）。触るときはあちらを読む
    - **`.cm-scroller` の `position` は触らないこと。** `static` にすれば同じ配置にできるが、CodeMirror が `scrollDOM` へ直接ぶら下げる `.cm-layer`（選択範囲・カーソル）はスクロール済み座標系を前提にしているので、スクロールすると選択とカーソルが本文から剥がれる。Pike は `drawSelection` / `dropCursor` を入れていないため今は表に出ず、足した日に無関係に見える形で壊れる
- **折り返しはタブ単位で上書きできる（#241）**。`EditorTab.vue` の `wordWrapOverride`（null = 設定に従う）で、実効値は `wordWrapOn`。分割表示でエディタ側が半分の幅になるときのための機能なので、タブに属するのが正しい。タブのコンポーネントは `v-show` で生き続けるから component-local な ref で足り、`viewMode` と同じ寿命になる（セッションには残さない）。一度触ったタブは以後その値のままで、設定変更に追従しない（戻すのはボタン 1 回）
  - **プレビューにも同じ `wordWrapOn` が効く（#367）**。プレビューのペインに `wrap` の class を付け、CSS で `pre`（JSON も `<pre>`）と表の `white-space` を戻し、長い値の割り方は容器の `overflow-wrap: break-word` 1 つで継承させる。**`anywhere` にしないこと**（表の列が 1 文字幅まで潰れる。理由は CSS の隣のコメント）。**`previewHtml` に混ぜないこと**: 混ぜると切り替えのたびに HTML を作り直し、mermaid の再描画とローカル画像の読み直しが走る
  - **ミニマップも同じ形（`minimapOverride` / `minimapOn`、#282）**。隣にボタンを並べるので、片方だけ設定を直に触る作りにすると、並んだ 2 つで効き方が変わる。ボタンは `components/editor/` の `WrapToggle.vue` と `MinimapToggle.vue` で、**見た目は `theme.css` の `.editor-toggle` を共有する**（プレビュー付きツールバーとパンくずヘッダは別のボタン様式を持つので、どちらに置いても同じに見えるには親に合わせないほうが早い）。**2 つのヘッダは排他表示なので、ボタンを足すときは両方に置く**（片方だけだと目視で気付けない）
- エディタコンテキストメニュー: Undo/Redo/Cut/Copy/Paste/Git History と、右クリックした行の参照（Teleport パターン）
  - **参照（#335）の綴りは `lib/paths.ts` の `fileLineRef`**（`相対パス:行` / `相対パス:開始-終了`）。読む側（`lib/terminalLinks.ts` の `PATH_RE`）と対になるので、書く側もコンポーネントではなく `lib/` に置く。「1 行か範囲か」の分岐は `lib/format.ts` の `lineRangeSuffix` 1 つで、表示用の `L`（`formatLineRange`）もそこに乗る
  - **コンポーネント側の入口は `withLineRef`**。参照を使う 3 つの項目（コピー・参照だけの注入・選択本文つきの注入）が通るので、メニューを閉じる契機と「参照を作れるか」の判定が 1 箇所に集まる
  - 対象の行は `computeContextLineRange`（選択があればその範囲、無ければ右クリックした行）。「この行の Git 履歴」と共有する
  - **可否は `tab.path` で見る（`hasFile` ではない）。** あれは `initialContent` の有無で、無題バッファは `addBlankEditorTab` が `initialContent: ''` で作るため**空文字が falsy で真になる**。参照に要るのは保存先のパスそのものなので、それを直に見る
- ファイルツリーに git ステータス色表示（precomputed Map で O(1) ルックアップ）
- **いま開いているファイルの強調（#274）**: 「どのファイルを見ているか」は `composables/useActiveFile.ts` の 1 箇所。**タブの種類で持ち方が違う**ので、そこで絶対パスに揃える（エディタ / プレビュー / PDF は絶対、diff と履歴はルート相対で、**繋ぐ相手はそのタブの `root`**。`activeRoot` ではない理由は `git-diff.md` の #321）。区切りも正規化する: git は常に `/` を返し、ファイルツリーはシェルの区切りを使うので、素の比較は Windows で一致しない。**ストアにしないこと**: タブとプロジェクトの両方を読むので、`stores/tabs.ts` に置くと `project → tabs → project` の循環になる。印は `theme.css` の `.active-file`（2 つのパネルで同じ見た目にするため）で、色は `--active-file-bg`。**行全体を塗る**（VSCode の explorer と同じ。細い線だけではざっと見て探せない）が、`selected`（ツリーで選んだ行）とは別の見た目にする。左端の線は inset の影で描く（行の左 padding が深さで変わるので `border-left` は使えない）
  - **各パネルに 2 行のカスケード用の規則が要る**: `.tree-item:hover` / `.tree-item.selected` は scoped の属性が付くぶん詳細度が高く、共有クラスの塗りを上書きしてしまう。色は共有の変数のままにして、詳細度だけ合わせる
  - **ツリーの追従は選択ではなく `revealFile`**（畳んである親を開く）。深いところにあるファイルは、親が畳まれていると行そのものが描かれず、選択もスクロールも見えない。判定は強調と同じ computed を読む（別々に判定すると、印の付く行と選択がずれる）
- 文字コード対応: `encoding_rs` で自動検出 + 指定エンコードでの開き直し/保存（StatusBar 2段階 UI）
- **バイナリ安全装置**: `fs_read_file` の自動判定時に先頭 8KB（`BINARY_SNIFF_LEN`）の NUL バイトで Err を返す（EditorTab がエラー表示）。UTF-16 BOM は先に BOM 判定してテキスト扱い、UTF-8 BOM は素通し（保存ラウンドトリップ維持）。StatusBar からの明示エンコード指定はガードなし（escape hatch）
- 改行コード LF/CRLF 切替（StatusBar クリック）、保存時に適用
- ファイルツリーコンテキストメニュー: リネーム（インライン入力）、削除（カスタム confirm ダイアログ）、Git History（専用タブ）、フォルダ限定「エクスプローラーで開く」（`fs_open_in_explorer`。WSL は `\\wsl.localhost\{distro}` UNC に変換して explorer.exe 起動）
- ドラッグ&ドロップ移動 + コピーの修飾キー（`dragDropEnabled: false` で Tauri ネイティブ D&D を無効化）。
  判定は `lib/keys.ts` の **`isCopyDragModifier`**（Windows / Linux は Ctrl、macOS は Option）。
  **`hasMod` を使わないこと**: あれは「Pike のショートカットの修飾キー」で、macOS の
  Ctrl+ドラッグは副ボタンのクリックそのものなので、コピーに使える修飾キーが無くなる
- **ツリーの余白はルート宛てのドロップ先にする**（`.tree-root-drop`）: ツリーはルートの子しか描かないので、最後の行より下に落としても受け手がおらず、App.vue の window ガードがイベントを飲んで無言で何も起きない。パネルを `min-height: 100%` で伸ばし、余った縦スペースを占める filler にハンドラを置く。パネルのルート要素に `.self` 修飾子で付ける手もあるが、ツリーがあふれると空き領域がゼロになってルートに落とせなくなる
- ダーティエディタタブの閉じ確認ダイアログ（カスタム confirm）
- WSL コマンドにパス引数前の `--` を付与（フラグ injection 防止）
- 外部 URL オープン: `open_url` コマンドは **http / https / mailto のみ許可**（Rust 側でバリデーション）。開くのは `types::os_open_url`＝Windows は `ShellExecuteW`、他は `open` / `xdg-open`（`cmd.exe /C start` はシェルメタ文字インジェクションの危険があるため不使用）。フロント側でも confirm ダイアログを表示
  - **`explorer.exe` に URL を渡さないこと。** あれの引数はまずシェルのオブジェクト（パス）として解釈されるので、**クエリや fragment を含む URL ではブラウザではなくエクスプローラーのウィンドウが開く**。理由は `types.rs` の `os_open_url` の doc が正本。ディレクトリを開く `os_open` は `explorer.exe`
  - **フロント側の規約は `frontend.md` の「外部ブラウザで URL を開く」**（#311）。呼び出し元が 8 か所に散る横断的な話なので、エディタ領域には置いていない

## 保存の責任（#276）

**保存の主体は `Ctrl+S` を押す人。** 自動保存（#262）はその押し忘れを代行するだけ、という
位置づけで入れてある。diff タブの編集（#266）もこの規則に従う。

- **書くのは `EditorTab.save()` の 1 本**。自動保存はそれを呼ぶだけで、別経路を作らない
  （CRLF 変換・エンコード・`markRecentlySaved`・ガター更新・診断の trigger が 1 箇所に残る）
- **止める条件は `maybeAutoSave` に書き、`save()` には書かない。** あちらは人が押したときの
  経路で、下の理由のどれにも従わない（外部変更の警告バーの「上書き」がまさにそれ）。止めるのは
  無題タブ（保存先を聞くダイアログが勝手に開く）・読み取り専用・**外部変更の警告中**（人が
  選ぶまで待つ。ここで書くとエージェントや別のエディタの変更を黙って潰す）・**コンフリクトの
  マーカーが残っている**（`editorConflict.ts` の `hasConflictMarkers`。解消の中間状態を勝手に
  残さない）の 4 つ
- **`*`（ダーティ表示）と閉じるときの確認は残す。** 自動保存が有効でも、保存されるまでの
  あいだは未保存であることに変わりがない。`afterDelay` の待ち時間中に閉じたら確認が出る
  （タイマーは `onUnmounted` で捨てる）
- 契機は CodeMirror の `updateListener` で取る。`focusChanged && !hasFocus` は**タブ切替でも
  発火する**（`v-show` の `display: none` はフォーカスを外す）ので、`activeTabId` を別に
  見る必要はない
- **`save()` は書く直前の文書を控えて `savedContent` に使う。** `await` のあとにライブの doc を
  読み直すと、書き込み中に打った文字が「保存済み」に化けて `*` が消え、clean になったせいで
  外部変更の**自動リロード**の対象にもなる（そこで消える）。自動保存は打鍵が止まってから書くので、
  少し考えてから打ち直すという普通の操作で当たる
- **自動保存の失敗で `error` を立てない。** あれはエディタ本体を `v-show` で消して「破棄して
  読み直す」ボタンだけを残す画面で、人が `Ctrl+S` を押した結果ならよいが、WSL が落ちた等で
  自動発火が失敗したときにそこへ落ちると、**何も操作していないのに未保存の内容を捨てる操作しか
  残らない**。StatusBar に 1 回出して、次の契機で普通に再試行する（`save(enc, auto)` の `auto`）
- **見えていないタブでは自動保存しない。** `shellForIO` は今表示しているプロジェクトのシェルを
  返すので、#264 で保持している別プロジェクトのタブのタイマーが発火すると、WSL のパスを
  PowerShell で書きに行く。人が押す `Ctrl+S` は見えているタブにしか届かないため、この不変条件は
  自動保存で初めて壊れる
- **ダイアログが開いているあいだも書かない**（`useConfirmDialog` の `dialogOpen`）。「未保存の
  変更を破棄しますか」は答えを待つあいだコンポーネントが生きているので、待っていたタイマーが
  その裏で書くと、破棄したはずの内容がディスクに残る
- **自己書き込みの印（`markRecentlySaved`）は通知 1 回ぶんで使い切る。** 時間の窓で捨てる形だと、
  自動保存が短い間隔で走るあいだ窓が開きっぱなしになり、エージェントの書き込みが外部変更として
  届かず、上の「警告中は保存しない」ガードが素通りする。**黙って上書きするより、消せる誤検知を採る**。
  理由と使い切れる前提（Rust の `EventBuffer` がパスで畳む）は `isRecentlySaved` の隣の doc が正本
- 未完成のコンフリクト領域（閉じ `>>>>>>>` がまだ無いもの）も `hasConflictMarkers` は true を返す。
  行頭に `<<<<<<< ` を書いた文書では自動保存が効かなくなるが、そのときはコンフリクトバーも
  出ているので気付ける。**安全側に倒したまま**にしてある

## キーボードマクロ（#180）

サクラエディタ風の記録・再生（`Mod+Shift+M` / `Mod+Shift+L`）。**判断の実体は `lib/editorMacro.ts` の doc が正本**（キーを記録して差分を記録しない理由・IME と貼り付けだけ文字列で持つ理由・記録しないもの）。

- **キーは CodeMirror の層**（`keyBindings` の表には載せない）。エディタの中でしか意味が無く、ターミナルでは同じキーがシェルへ行くのが正しい。一覧（`KeyboardShortcuts.vue`）とマニュアルは手で揃える（`shortcuts.md` の「表に無い層のキー」）。キーの綴りは `MACRO_CHORDS` が正本で、記録から自分のキーを除く判定もそこから作る
  - **プリセット別の早見表には載せない**（`editorChordsFor` にも入れない）。あの表は「プリセットで変わるキー」のもので、エディタの中だけで効きプリセットで変わらないキーは載せない決まり
  - **`APP_ACTIONS` には行を置く**（`macroRecord` / `macroPlay`。パレットから引けるように）。実装は `useOutlineSource` の登録にある「今見えているエディタ」に対して呼ぶ
- `Mod-Shift-l` は `searchKeymap` の「同じ文字列をすべて選択」と同じキーで、`Prec.high` で奪っている。読み取り専用のタブにはマクロを入れないので、そこでは「すべて選択」が効く
- **ツールバーのボタン（`components/editor/MacroButtons.vue`）は `mousedown` を止めてフォーカスを奪わない**。記録はエディタに届いた打鍵しか拾わないので、ボタンにフォーカスが移ると記録を始めた直後の打鍵が消える。押したあとは `EditorTab` がエディタへフォーカスを戻す
- **再生は読み取り専用なら何もしない**（`playMacro` の先頭）。部分読み込み（#362）はビューを作ったあとから読み取り専用になるので、拡張を入れるかどうかでは守れない
- **再生はキーマップへ流すだけ**（`runScopeHandlers`）。受け手の無い印字キーだけ文字として入れ、そのときも `EditorView.inputHandler` を通す（括弧の自動補完などが打鍵と同じに効く）

## クイック整形（#366）

選択範囲、無ければファイル全体を整形する。実体は `lib/editorFormat.ts`（判断の正本はあのファイルの doc）。入口は右クリックの「整形 ›」、プリセットのキー（`editorChordsFor` の `format`）、パレット（`APP_ACTIONS` の `format`）の 3 つで、**段取り（種別の解決・区切り文字を聞く・整形・適用・通知）は `runFormat` の 1 つ**。入口を足すときもコンポーネントに段取りを書かない。

- **StatusBar で選んだ言語（手動の上書き）が効くのは右クリックとキーだけ**。パレットは `useOutlineSource` の `langId`（パスから決めたもの）を使う既知の制約
- **HTML / XML / CSS / JavaScript は `js-beautify`**。依存を足した理由は精度（`pre` / `script` / 閉じタグの要らない要素）。**動的 import で使うときだけ読む**（ビルドで約 100KB の別チャンクになる）。CommonJS なので、関数が `default` の下に入る読み込み方がある（Node の ESM）。型は同梱されないので `types/js-beautify.d.ts` に使う分だけ宣言した
- **TypeScript と Vue をファイル種別の自動整形に入れないこと**。`js-beautify` は型引数を `Map < string, number[] >` に崩す。Vue は `<script lang="ts">` の中身が同じ経路で崩れる
- **JSON は `JSON.stringify` で書き直さない**（`reindentJson` が文字の並びだけを見て字下げする）。往復すると 2^53 を超える整数の精度・重複したキー・`1.0` の書き方が黙って変わる。構文の検査にだけ `JSON.parse` を使う
- **末尾の改行は整形の外に置く**（`formatText` が外して付け直す）。整形器に渡すと落ちるうえ、並べ替えでは空行が先頭へ移る
- **整形の読み込みを待つあいだに本文が変わったら書かない**（`EditorTab` の `runFormat` が doc の同一性を見る）。変わらなければ dispatch しない（Undo の履歴を汚さない）
- 右クリックのメニューは子メニューにせず、同じメニューの中身を一覧に切り替える（位置合わせが要らない）。切り替えたら測り直す（項目数が変わって画面の下端からはみ出しうる）

## CodeMirror 6
- シンタックスハイライトのみ、LSP・補完は実装しない
- 言語パッケージは使うもの（Go, Rust, TypeScript, Vue, YAML 等）だけ import
- ファイル保存は `Ctrl+S` → `invoke('fs_write_file', ...)`

## ファイル/画像ペースト
- `composables/useImagePaste.ts`。クリップボード/D&D のファイルを `.pike/uploads/` に保存 → ターミナルへ相対パスを挿入する。画像専用ではなく**任意のファイル**が対象（PDF 等も可）
- **Markdown エディタはここを通さない**（#241）。ドキュメントが指す画像は `.pike/uploads`（gitignore 済み）ではなくファイルの隣に置く。詳細は `preview.md` の「Markdown の入力支援」。共有しているのは書き込みの primitive `saveFileTo`（`MAX_UPLOAD_SIZE` の番人）とファイル名生成だけ
- 判別は **file か string か**（`ClipboardEvent` は `item.kind === 'file'`、D&D は `dataTransfer.files`）。テキスト（string）は長さに関係なくインライン貼り付けのまま
- 保存ファイル名は元名を保持（`stem-{hex}.ext`、衝突回避）。名前を持たないクリップボード blob（画像等）は `upload-{ts}-{hex}.{ext}` を生成
- 初回保存時に各プロジェクトへ `.pike/.gitignore`（中身 `*`）を書き込み、退避ファイルを repo から除外
- ターミナルへのドロップは常にアップロード（小さいファイルを本文としてインライン展開する経路は持たない）
- xterm は Ctrl+V を SYN(`\x16`) として食うため `attachCustomKeyEventHandler` で横取り。右クリック/Ctrl+V は `navigator.clipboard.read()` 経由だが、この API は**画像とテキストのみ**返す（任意ファイルは取得不可）→ ターミナルへの任意ファイル投入は D&D が主経路
- ファイルツリー / OS からのドラッグ&ドロップにも対応

## QuickOpen コマンドパレット（Ctrl+P）
- 先頭文字でモード切替: 無印=ファイル fuzzy open、`>`=**コマンドとタスク**、`@`=タブ切替、`:`=行ジャンプ、`!`=Git ブランチ切替、`?`=ヘルプ。`filename:42` サフィックスで行番号ジャンプ
- **`>` に出すコマンドの正本は `lib/shortcuts.ts` の `APP_ACTIONS`**（#270）。ここに `palette`（分類）を持つ行を流すだけで、**パレット側に一覧を持たない**（パレットに一覧を持つと、機能を足しても載らない）
  - **機能を足したらこの表に 1 行足す。** 実装（`useAppActions`）は `Record<AppActionId, …>` なので、足して実装を忘れると型エラーになる。逆向き（機能を足して表に書き忘れる）は型では拾えないので、ここに書いてある
  - 表示は `分類 / 名前 / キー`。絞り込みは**日本語と英語の両方**に当たる（`search` に両方入れてある）。UI 言語が日本語でも `> settings` や `> pull` で引ける
  - `needsProject` を持つ行は、プロジェクトを持たないウィンドウでは出さない。パネルを開く行には付けない（サイドバーのアイコンは常に出ていて、クリックすれば空のパネルが開く。パレットだけ隠すと入口で挙動が割れる）
  - キーの割り当ては別の表（`keyBindings`）。詳細は `.claude/rules/shortcuts.md`
- `QuickOpen.vue` は ProjectSwitcher と同じオーバーレイ + モーダル構造、表示状態は `project.showQuickOpen`
- fzf 風 fuzzy match（ファイル名優先 → パスマッチ）、最近開いたファイルを上位表示
- **最近開いたもの（#271）**: ファイルは**プロジェクトごと**（`pike:recent-files:{projectId}`。他プロジェクトのファイルが混ざると上位表示の役に立たない）、ディレクトリは**マシン全体**（`pike:recent-dirs`。どのプロジェクトからでも同じ場所に戻りたい）。どちらもパスなので同期の対象にしない。ディレクトリは `>` モードにコマンドとタスクの間で出す（「開く」操作の続きなので、コマンドのすぐ下）
- `rg --files` の結果をフロントでキャッシュ、プロジェクト切替時にリセット（取得は `search.md` の `list_project_files`）

## 定義ジャンプ（Ctrl+Click / F12）
- `lib/editorJumpTo.ts` + `lib/jumpTo/`。TS/JS/Vue/Go の import パスを Ctrl+Click でファイル open
- 識別子は同一ファイル内宣言（Lezer 構文木）と import 経由のクロスファイル定義の両方に対応
- Vue カスタムコンポーネントは `<script setup>` の PascalCase import / Options-API `components` / `app.component()` グローバル登録 / `components.d.ts` の 4 段で解決
  - **`components.d.ts` は import の無い自動登録（unplugin-vue-components・Nuxt）のため（#406）**。生成物が `Name: typeof import('./x.vue')['default']` の形で定義元を書くので、その文字列を **d.ts 自身を起点に** `resolveImport` へ渡す（import 行と同じ解決）。置き場の候補は `COMPONENTS_DTS_NAMES`、解析は `findComponentDeclaration`
  - **最初に見つかった d.ts で打ち切らない**。実在するものを近い順に全部受け取り（`findAllUpward`）、名前が載っている最初のものを採る。手書きの `types/components.d.ts`（`declare module '*.vue'` だけ等）が `.nuxt/components.d.ts` を隠すため（alias の #398 と同じ形）
  - **d.ts はキャッシュしない。** `.nuxt` は監視の `IGNORED_DIRS` に入っているので、`main.ts` のようにキャッシュすると Nuxt の再生成を取りこぼす。他の段で解決できなかったクリックでだけ読むので、1 クリック 1 回の読み込みで足りる
  - `RouterLink: typeof import('vue-router')` のようなパッケージの登録は、import 行と同じく解決できない（node_modules は歩かない）
- **Text::Xslate（`.tx`）は `include` / `cascade` の引数でテンプレートを開く**（`lib/jumpTo/xslateInclude.ts` の `xslateTemplateAt`）。裸の名前は Xslate と同じく `::` → `/` と `.tx` を足す。見るのは Kolon のコードの中だけ（行頭の `:` 以降と `<: :>`）
  - **解決は「開いているファイルから上へ辿り、`ディレクトリ + 名前` が実在する最初の場所」**（`findNearestUpward`）。Xslate はテンプレートを Perl 側の設定（`path`）のディレクトリから引くが、Pike はそれを読めない。テンプレートの木の中のファイル同士なら木の根で見つかる。`path` に並べた別のディレクトリのものは開けない（見つからない表示）
  - 行コードの始まりの正規表現は `KOLON_LINE_CODE` の 1 つを、ハイライト（`templateModes.ts`）と共有する。片方だけ直すと色の付く範囲と Ctrl+Click の効く範囲が食い違う
  - `$` / `.` の直後の裸の名前は拾わない（`: include $tmpl` の変数を `tmpl.tx` と読まない）
- path alias 解決: tsconfig/jsconfig の `compilerOptions.paths` と vite.config の `resolve.alias`（祖先方向に config 探索、モノレポ対応、設定変更で自動 invalidate）
  - **最初に見つかった設定ファイルで打ち切らない（#398）**。`fs_existing_paths` で実在するものを近い順（同じ階層では tsconfig → jsconfig → vite.config）に全部受け取り、**いちばん近い階層のものの中で** alias を得られた最初のものを採る（祖先まで上ると、モノレポのパッケージに TS が与えないルートの alias を当ててしまう）。1 つで打ち切ると、`references` だけの `tsconfig.json`（`npm create vue` の構成）が隣の `vite.config.ts` を隠す
  - **プロジェクトの外のファイルは、そのファイル自身の木を上へ辿る**（`ancestorCandidates`）。プロジェクトのルートで止めるのは、ファイルがその下にあるときだけ（判定は `projectPaths.ts` の `isSameOrUnder`）。以前は外のファイルでも今のプロジェクトのルートを候補に足していたので、別の repo のファイルに今のプロジェクトの alias が当たった
  - **vite.config の alias の置換先は `resolveFrom` を通す**（#398）。置換先は `path.resolve(__dirname, …)` を解いた絶対パスで、`joinPath` は絶対パスの `rel` でも後ろに足すので、`paths` と同じく `joinPath(baseUrl, …)` に通すと壊れたパスになる
  - tsconfig は相対パスの `extends` をたどり、起点のファイルからだけ `references` を 1 段たどる。**パッケージ名の `extends` は読まない**（node_modules を歩くことになる）。`paths` の基準は TS と同じく「チェーンのどこかの `baseUrl`、無ければ `paths` を書いたファイルのディレクトリ」
- **Ctrl+ホバーの下線の範囲はジャンプの側が返す**（`jumpableRangeAt`。import のパス・Vue のタグ名・Xslate のテンプレート名・識別子）。呼び出し側で語の範囲を推し量ると、`foo::bar` や `@/foo` のように語の文字で切れる対象で下線がずれる。判定と範囲を 1 つの関数にしてあるので、言語を足すときは分岐を 1 か所に書けばよい
- 進捗・結果は `stores/statusMessage.ts` 経由で StatusBar に表示（スピナー / 開いたファイル名 / 見つからない）

## アウトラインパネル（Outline）
- `outline` サイドバーパネル。`lib/outline/` の言語別 extractor（18 言語: Markdown / TypeScript+JSX / Vue / HTML / CSS+SCSS / Rust / Python / Go / Perl / YAML / JSON / Ruby / Kotlin / Swift / PHP / Dockerfile / TOML / Makefile）でシンボルを抽出
- カーソル位置追従ハイライト・祖先自動展開・scrollIntoView、タブ別スクロール位置保持
- Outline / History 2 タブ構成（`OutlineTreeView.vue` / `OutlineHistoryView.vue`）。History はファイル別 git log を表示、行クリックで diff タブを開く
- 行オフセットは `buildLineOffsets` / `lineStart` で O(N) 前計算（`composables/useOutlineSource.ts`）
