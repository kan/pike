# エディタ・パネル実装ルール

CodeMirror 6 のエディタとプレビュー、ファイルツリー、サイドバーの各パネル（検索・タスク・アウトライン・診断）、ファイル監視。
実体は `src/components/tabs/EditorTab.vue`、`src/components/editor/MarkdownToolbar.vue`、`src/components/panels/`、`src/lib/editor*.ts`、`src/lib/outline/`、`src-tauri/src/fs/`、`src-tauri/src/search/`、`src-tauri/src/watcher/`、`src-tauri/src/tasks.rs`、`src-tauri/src/diagnostics/`。

## ファイルツリー / エディタ
- Rust `fs` モジュールがファイル操作を提供（list_dir / read_file / write_file）。分岐は**「WSL かどうか」だけ**で、Windows も macOS も `std::fs` の腕に乗る
- WSL: `wsl.exe find`, `wsl.exe cat`, `wsl.exe bash -c "cat > ..."` 経由
- WSL 以外（Windows / macOS）: `std::fs` 直接アクセス
- ファイルサイズ事前チェック（2MB 制限）
- CodeMirror 6 でエディタタブ。テーマは `lib/editorThemes.ts` の 6 種（One Dark / Default Light / Dracula / Nord / Solarized Light / Monokai）+ Auto（ダーク/ライト追従）、シンタックスハイライトの対応言語は `lib/languages.ts` の `EXT_MAP` / `NAME_MAP` が唯一の出典（件数をここに書かない。足すたびにずれる）
- Ctrl+S で保存、ダーティ表示（タブタイトルに `*`）。Ctrl+Z/Shift+Z で Undo/Redo
- エディタ内検索・置換: Ctrl+F / Ctrl+H でカスタム検索パネル（右上フローティング、アイコンボタン、マッチ数表示）
- Git diff ガター: 追加行（緑）・変更行（黄）・削除行（赤三角）をガターに表示。`git_diff_lines` コマンドで行単位の差分を取得
- ミニマップ: `@replit/codemirror-minimap` を採用。blocks モード、シンタックスカラー反映、正確なスクロール同期、git diff ガター表示
  - **本文と重ならないよう、ミニマップを `.cm-editor` 直下へ出してある（#282）**。パッケージは `.cm-scroller` の中へ `position: sticky; right: 0` で入れるが、`.cm-content` の幅は最長行で決まりミニマップの存在を知らないので、折り返し OFF で長い行があると**スクロールしていなくても**本文がその下を通る。**判断の実体は `lib/editorMinimap.ts` の doc コメントが正本**（なぜ padding でも margin でも直らないか、なぜ再親化してもパッケージが壊れないか、幅の受け渡しがループしない理由）。ここに写しを置くと必ず片方が古くなるので、触るときはあちらを読む
    - **`.cm-scroller` の `position` は触らないこと。** `static` にすれば同じ配置にできるが、CodeMirror が `scrollDOM` へ直接ぶら下げる `.cm-layer`（選択範囲・カーソル）はスクロール済み座標系を前提にしているので、スクロールすると選択とカーソルが本文から剥がれる。Pike は `drawSelection` / `dropCursor` を入れていないため今は表に出ず、足した日に無関係に見える形で壊れる
- エディタコンテキストメニュー: Undo/Redo/Cut/Copy/Paste/Git History（Teleport パターン）
- ファイルツリーに git ステータス色表示（precomputed Map で O(1) ルックアップ）
- **いま開いているファイルの強調（#274）**: 「どのファイルを見ているか」は `composables/useActiveFile.ts` の 1 箇所。**タブの種類で持ち方が違う**ので、そこで絶対パスに揃える（エディタ / プレビュー / PDF は絶対、diff と履歴はルート相対）。区切りも正規化する: git は常に `/` を返し、ファイルツリーはシェルの区切りを使うので、素の比較は Windows で一致しない。**ストアにしないこと**: タブとプロジェクトの両方を読むので、`stores/tabs.ts` に置くと `project → tabs → project` の循環になる。印は `theme.css` の `.active-file`（2 つのパネルで同じ見た目にするため）で、色は `--active-file-bg`。**行全体を塗る**（VSCode の explorer と同じ。細い線だけではざっと見て探せない）が、`selected`（ツリーで選んだ行）とは別の見た目にする。左端の線は inset の影で描く（行の左 padding が深さで変わるので `border-left` は使えない）
  - **各パネルに 2 行のカスケード用の規則が要る**: `.tree-item:hover` / `.tree-item.selected` は scoped の属性が付くぶん詳細度が高く、共有クラスの塗りを上書きしてしまう。色は共有の変数のままにして、詳細度だけ合わせる
  - **ツリーの追従は選択ではなく `revealFile`**（畳んである親を開く）。深いところにあるファイルは、親が畳まれていると行そのものが描かれず、選択もスクロールも見えない。判定は同じ computed を読む: あちらが独自に `kind === 'editor'` を見ていたころは、印の付く行と選択がずれていた
- 画像ビューワタブ（base64 経由、ズーム/回転/反転/パン/fit の表示専用操作）、Markdown プレビュー（Edit/Split/Preview 3モード、スクロール同期、250ms デバウンス）
- Markdown プレビュー内リンク: 外部 URL は confirm 付きで `open_url` 経由の外部ブラウザ起動、ローカルファイルはプロジェクトルート内に限定して EditorTab で開く（`resolveLocalPath` でディレクトリトラバーサル防止 + `decodeURIComponent` 対応）
- 文字コード対応: `encoding_rs` で自動検出 + 指定エンコードでの開き直し/保存（StatusBar 2段階 UI）
- 改行コード LF/CRLF 切替（StatusBar クリック）、保存時に適用
- ファイルツリーコンテキストメニュー: リネーム（インライン入力）、削除（カスタム confirm ダイアログ）、Git History（専用タブ）、フォルダ限定「エクスプローラーで開く」（`fs_open_in_explorer`。WSL は `\\wsl.localhost\{distro}` UNC に変換して explorer.exe 起動）
- ドラッグ&ドロップ移動 + コピーの修飾キー（`dragDropEnabled: false` で Tauri ネイティブ D&D を無効化）。
  判定は `lib/keys.ts` の **`isCopyDragModifier`**（Windows / Linux は Ctrl、macOS は Option）。
  **`hasMod` を使わないこと**: あれは「Pike のショートカットの修飾キー」で、macOS の
  Ctrl+ドラッグは副ボタンのクリックそのものなので、コピーに使える修飾キーが無くなる
- **ツリーの余白はルート宛てのドロップ先にする**（`.tree-root-drop`）: ツリーはルートの子しか描かないので、最後の行より下に落としても受け手がおらず、App.vue の window ガードがイベントを飲んで無言で何も起きない。パネルを `min-height: 100%` で伸ばし、余った縦スペースを占める filler にハンドラを置く。パネルのルート要素に `.self` 修飾子で付ける手もあるが、ツリーがあふれると空き領域がゼロになってルートに落とせなくなる
- ダーティエディタタブの閉じ確認ダイアログ（カスタム confirm）
- WSL コマンドにパス引数前の `--` を付与（フラグ injection 防止）
- 外部 URL オープン: `open_url` コマンドは http/https のみ許可（Rust 側でバリデーション）。`explorer.exe` 経由で開く（`cmd.exe /C start` はシェルメタ文字インジェクションの危険があるため不使用）。フロント側でも confirm ダイアログを表示

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
  あいだは未保存であることに変わりがない。`afterDelay` の待ち時間中に閉じたら、これまでどおり
  確認が出る（タイマーは `onUnmounted` で捨てる）
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
- **自己書き込みの印（`markRecentlySaved`）は通知 1 回ぶんで使い切る。** 「保存から 2 秒のあいだの
  通知を全部捨てる」形だと、自動保存が 2 秒より短い間隔で走るあいだ窓が開きっぱなしになり、
  **その最中にエージェントが同じファイルを書いても外部変更として届かない**＝上の「警告中は
  保存しない」ガードが素通りして、次の自動保存が相手の変更を黙って上書きする。使い切りに
  できるのは、Rust 側の `EventBuffer` が**パスで畳んでから**送るようにしたため（1 回の書き込みは
  Create と Modify のように複数の生イベントを生む）。まとめ切れずに 2 回に割れたときは、余った
  ほうが外部変更として出る（clean なら同じ内容で読み直すだけ、dirty なら消せる警告バーが 1 回）。
  **黙って上書きするより、消せる誤検知を採る**
- 未完成のコンフリクト領域（閉じ `>>>>>>>` がまだ無いもの）も `hasConflictMarkers` は true を返す。
  行頭に `<<<<<<< ` を書いた文書では自動保存が効かなくなるが、そのときはコンフリクトバーも
  出ているので気付ける。**安全側に倒したまま**にしてある

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
- **画像は `composables/useMarkdownImages.ts`**。`.pike/uploads`（チャットとターミナルの置き場）には入れない。あそこは `.gitignore` に `*` があり、ドキュメントが指す画像はドキュメントと一緒にコミットされる必要がある。基準は `project.root` ではなく**そのファイルのディレクトリ**（`tab.path`）と `shellForIO`。無題タブでは挿入できない（置き場所が決まらないので statusMessage で保存を促す）
  - **プロジェクト内の画像はコピーせず相対パスで参照する**（`../` を含む。`paths.ts` の `relativeFromDir`）。コピーするとリポジトリに同じ画像が 2 つ残る。「プロジェクト内か」は `projectPaths.ts` の `relativeToBase`（区切りを正規化してから比べる。素の前方一致だと `C:/src/pike` と `C:\src\pike` が別物になる）。プロジェクトが無いウィンドウでは「内」の範囲がドキュメントのディレクトリになる
  - **バイトをフロントに通すのはクリップボードだけ**。ディスク上のファイルは `fs_import_file` で運ぶ。Windows のファイルを WSL プロジェクトへ入れるときも、**宛先を UNC 形で書けば Windows 側の 1 回のコピーで済む**（`wslNativeToUnc`）。`fs_read_file_base64` → `fs_write_file_base64` の往復にすると、画像が base64 で IPC を 2 回渡るうえ、read 側の 10MB 上限が write 側の 50MB と食い違う
  - **`fs_copy` は使わない**。あれは `std::fs::copy`＝`CopyFileExW` で、**NTFS の代替データストリームまで運ぶ**。ダウンロードした画像には `Zone.Identifier` が付いているので、それを WSL 側へコピーすると 9p にストリームの置き場が無く、隣に `name.png:Zone.Identifier` という**見える実ファイル**ができる（実測）。`fs_import_file` は名前でファイルを開いて本文だけを写す。ツリーのコピー（`fs_copy`）は Windows 内で完結し、ストリームは見えないままなので従来どおりでよい
  - **ドロップされたファイルは `resolveDroppedPaths` で実パスに戻してから**扱う（タブバーのドロップと同じ仕組み）。戻せなければ持っているバイトで書く。実パスが取れれば上の「プロジェクト内ならリンクだけ」もそのまま効く
  - ファイル選択ダイアログは Windows のものなので、WSL プロジェクトの中のファイルは UNC 形で返る。`wslUncToNative` で native に直すが、**distro が一致するときだけ**採用する
  - **書き込みは `useImagePaste` の `saveFileTo` を通す**。あれが `MAX_UPLOAD_SIZE` の番人で、素の `fsWriteFileBase64` を直接呼ぶと上限なしのファイルが base64 で IPC を渡る
  - `pick_open_file` の拡張子は **Rust 側で英数字だけに絞ってから** PowerShell のフィルタ文字列に埋める（コマンドラインを組み立てる側が検証する）。ダイアログ 3 種の共通部分は `lib.rs` の `dialog` モジュール（`dialog::powershell` が WinForms 側、`dialog::osascript` が macOS 側）
  - 貼り付けとドロップは `EditorView.domEventHandlers` を **markdown の compartment に載せる**ので、read-only タブと非 Markdown では素通りする。画像以外は `false` を返して CodeMirror の既定に任せる（`pasteURLAsLink` を潰さない）。ドロップ位置は `posAtCoords` でカーソルを移してから挿入する
  - **複数枚は 1 トランザクションで書く**。1 枚ずつ dispatch すると、直前の挿入が alt テキストを選択したままなので次がその中に入る（`![![b](b.png)](a.png)` になる）
  - **ファイルツリーからのドロップは `text/plain` を読む**が、パスに見えるか（`isAbsolutePath`）を確かめてから信じる。あのスロットは 4 つのパネルが別々の語彙で使っていて、他アプリから `foo.png` という文字列をドラッグしただけでも届く
- **表は形を先に聞く**（行数・列数）ので、固定テンプレートの `block` ではなく独立した action kind。UI はブロックメニューの中身をフォームに差し替える形で、メニューを閉じると `picker` を戻す。**見出し行は必ず入れる**: GFM に見出しの無い表は無く（区切り行はそもそも見出しの下にしか置けない）、セルを空にすると本文の上に空の帯が出るだけなので、見出しの有無を選ばせる余地がない。指定する行数は見出しを除いた本文の行数
- **貼り付けた URL のタイトル取得（#241）は `composables/useMarkdownLinkPaste.ts`**。受け持つのは「カーソルだけの位置に裸の URL を貼った」場合のみで、**選択範囲があるときは触らない**（`pasteURLAsLink` の担当で、作者が自分で書いた文字のほうが取得したタイトルより良い）
  - **URL を先に入れて、タイトルは後から差し替える**。取得を待ってから挿入すると、貼ったのに数秒何も起きない見た目になる。失敗しても「ただの URL が貼られた」で終わり、undo 1 回で素の URL に戻る
  - **差し替え位置は `StateField` で追跡する**（`editorGitGutter.ts` の `diffField` と同じ形）。取得の最中に作者が上の行を編集しても位置がずれない。素朴に from/to を覚えると別の場所を壊す。差し替え前に `sliceDoc` で中身が URL のままかを確かめる
  - **`mapPos` の assoc は `from` に +1、`to` に -1**（既定の向きの逆）。境界に入った文字を範囲の**外**へ置くための指定で、既定のままだと両端が貪欲になる。貼った直後のカーソルは `to` にあるので、取得を待つあいだに書き続けるという最も自然な操作で打った文字が範囲に入り、`sliceDoc` の確認に引っかかってタイトルが黙って入らない
  - **カーソルが複数あるときは見送る**。`replaceSelection` は全部の位置に入れるので、main から求めた 1 つの範囲では差し替え先が決まらない
  - **「聞いた」の記録はダイアログの答えが返ってから**。先に書くと、続けて 2 本目を貼ったときに「もう聞いた」と誤認し、Escape で閉じた場合は二度と提案されなくなる。同時に貼られたぶんは 1 つのダイアログを共有する
  - 取得中の表示は**件数を数える**（StatusBar は 1 つしかないので、先に終わったぶんが hide すると、まだ動いている取得の最中に「何もしていない」表示になる）
  - **既定は OFF で、最初の 1 回だけ有効化を提案する**。これは Pike が作者の代わりに任意のホストへ通信する唯一の機能なので、黙って有効にしない。聞いたかどうかは `pike:link-title-asked`（マシンローカル）に持ち、設定そのもの（`markdownFetchLinkTitle`）は同期対象にする（どのマシンでも同じ判断でよいため）
  - **無効なときは貼り付けに触らない**。OFF（かつ提案済み）なら `false` を返して CodeMirror の既定に任せる。常に横取りして自前で挿入する形だと、既定 OFF の常用パスが素の貼り付けの再実装になる。提案がまだのときも横取りせず、素の貼り付けをさせてから聞き、承諾されたら既に入っている URL をそのまま追跡対象にする
  - **`extension` はハンドラと同じ markdown の compartment に入れる**。基本の拡張リストに置くと、Markdown でないタブや読み取り専用タブ（pending が入りようのないタブ）でも打鍵のたびに `update` が走る。`update` 自身も、何も待っていなければ即座に戻す（空配列を毎回 map しない）
  - **paste ハンドラの順は画像が先**。ファイルを伴う貼り付けはあちらの担当で、URL の判定まで行かせない。返り値の規約（受け持たなければ `false`）は `useMarkdownImages` と同じ
  - リンクの文字列は `editorMarkdown.ts` の **`markdownLink`**（`markdownImage` の対）で作る。宛先のエスケープの判断は `toLinkTarget` にあり、呼び出し側で組み立てるとそれが効かない。URL の判定は同ファイルの **`isHttpUrl`** に寄せてある（ツールバーの `clipboardUrl` と貼り付けで許容する文字が割れると、通る URL が食い違う）
  - **一行に畳むのは Rust の責務**（`collapse_whitespace`）。フロント側は角括弧のエスケープだけを持つ
  - **外部ホストへの取得は `http.rs` に集約**。呼び出し元は 2 つ（画像 #239 / タイトル #241）で方針は本当に違う（リダイレクト・スキーム・不完全な本文の扱い）が、仕組み（TLS プロバイダ・クライアントの使い回し・`Content-Type` の分解・上限付き読み）は同じ
    - **クライアントを毎回組み直さないこと**: rustls の設定とトラストアンカーを読み直すので、同じホストへの 2 回目も TLS ハンドシェイクからやり直しになる（`docker/mod.rs` が `OnceCell` を持つのと同じ理由）。ただし**失敗はキャッシュしない**（`.ok()` を `get_or_init` に入れると、最初の 1 回の失敗がプロセスの寿命ぶん残り、再起動するまで直らない）
    - **途中で切れた本文を握り潰さないこと**。`Partial::Fail` の側（画像）は上限超過も通信断も失敗にする。`Ok` で返すと呼び出し元が完全な本文と区別できず、欠けた画像が data URL として `externalImages` のキャッシュに載る。再試行のチップは null のエントリしか消さないので、壊れた画像が残り続ける
  - Rust 側は `page_title.rs`。**charset は BOM → ヘッダ → `<meta>` → UTF-8 の順**（UTF-16 のページは `<meta>` すら ASCII として読めないので BOM が最初でないと後ろ 2 つが効かない）。**数値実体参照（`&#8211;` / `&#x2019;`）を必ず戻す**: CMS の `<title>` に普通に入っていて、残すと `[Post Title &#8211; Site]` がそのまま文書に書き込まれる。**`<meta charset>` は最初の `charset` という語で打ち切らない**（コメントや `data-charset` 属性が先に来ると宣言を見落とし、この関数が防ぐはずの文字化けが起きる）
  - `remote_image` と違い**リダイレクトを追い、http も許す**（承認ホストの一覧が無いので不追従にする意味が無く、短縮 URL が普通に来る）。守るのは timeout / 512KB / `text/html` / 5 ホップまで。**charset を見る**のが要点で、Shift_JIS や EUC-JP のページを UTF-8 で読むと化けたタイトルが文書に書き込まれる。ヘッダ → `<meta charset>` → UTF-8 の順
  - 失敗は全部 `Ok(None)`。URL は既に文書にあるので、呼び出し側が区別する意味が無い
- **折り返しはタブ単位で上書きできる（#241）**。`EditorTab.vue` の `wordWrapOverride`（null = 設定に従う）で、実効値は `wordWrapOn`。分割表示でエディタ側が半分の幅になるときのための機能なので、タブに属するのが正しい。タブのコンポーネントは `v-show` で生き続けるから component-local な ref で足り、`viewMode` と同じ寿命になる（セッションには残さない）。一度触ったタブは以後その値のままで、設定変更に追従しない（戻すのはボタン 1 回）
  - **ミニマップも同じ形（`minimapOverride` / `minimapOn`、#282）**。隣にボタンを並べるので、片方だけ設定を直に触る作りにすると、並んだ 2 つで効き方が変わる。ボタンは `components/editor/` の `WrapToggle.vue` と `MinimapToggle.vue` で、**見た目は `theme.css` の `.editor-toggle` を共有する**（プレビュー付きツールバーとパンくずヘッダは別のボタン様式を持つので、どちらに置いても同じに見えるには親に合わせないほうが早い）。**2 つのヘッダは排他表示なので、ボタンを足すときは両方に置く**（片方だけだと目視で気付けない）
- 脚注は本文に `[^n]`、**ファイル末尾**に定義行を足してカーソルを定義側へ移す。`n` は既存の `[^数字]` の最大値 + 1
- **プレビューの脚注は `lib/markdownFootnotes.ts`（marked 拡張）**。marked は GFM 脚注を持たず、しかも素通しにならない: `[^1]` は**注釈本文を href に持つリンク**になり、定義行はリンク定義として消える。EditorTab は自前の `new Marked(footnotes())` を持つ（グローバルの `marked.use` にすると他のプレビューにも入る）
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
  - **reStructuredText（#284）**: ハイライトは `codemirror-lang-rst`（CM6 に公式のものが無いので入れた外部パッケージ。依存は `@lezer/highlight` だけで、壊れてもハイライトが崩れるにとどまる）。プレビューは `lib/rstPreview.ts` の `buildRstPreview` で**自前**。判断の実体はあのファイルの doc コメントが正本だが、要点は次のとおり:
    - **変換器を入れなかったのは、#284 の時点で選択肢が悪かったから。** 当時の JS の rst → HTML は `rst2html`（2017 年）と `restructured`（2016 年）くらいで、後者は `power-assert`（650KB）と `commander`（207KB）を production dependencies に持つ
    - **その前提はもう古い（2026-09-01）。** `rst-compiler`（純 TypeScript・MIT・現役）が実用水準にある。`shiki` と `katex` を抱えるので見送っているだけで、**運用して不具合が続くようなら依存が太るのを許容して載せ替える**。Rust 側（`rust_parser` / `rst_renderer`）は完成度が変わらず、しかも「Rust は I/O ブリッジに徹する」に反して打鍵のたびに IPC を往復するので採らない。詳細は `lib/rstPreview.ts` の冒頭が正本
    - **解釈できなかったものは捨てずに字面のまま出す**（セル結合のある表、`toctree` / `math` のような未対応ディレクティブ、扱えなかった置換定義）。**本文から消してよいのは真のコメント・リンク定義・差し替えられた置換定義だけ**で、`..` の分岐はそれ以外の明示マークアップ全部の受け皿でもある（脚注・引用・置換をここで捨てていたのが実際のバグだった）。見た目は `md-preview` を共有し、rst 固有の要素（アドモニション・フィールドリスト）だけ `rst-preview` 側で足す
    - **置換記法（#302）は `replace` と `image` だけ差し替える。** 扱える種別の出典は
      `SUBSTITUTION_RENDERERS` の表 1 つで、定義行を本文から消してよいかの判定もそこを引く
      （2 箇所に分けると、片方だけ増やしたときに定義が差し替えも字面も無いまま消える）。
      半端に解けた値を採用しない理由と、循環の止め方は `collectContext` の `resolveSub` の
      doc コメントが正本
    - **`.. meta::` は本文ではなく文書のメタデータ**（docutils は `<meta>` タグにする）なので、折り畳みの表にして先頭へ出す（#302）。集める先を持てるのはルートの呼び出しだけなので、入れ子（アドモニションの中など）では拾わず従来どおり字面で出る
      - **Markdown のフロントマター（#229）と同じ `details.frontmatter` を使う**ので、CSS も開閉状態の復元（`trackFrontmatterToggle`）もそのまま効く。**あの watcher を Markdown 限定に戻さないこと**（打鍵のたびに開いた状態が閉じる）。CSS は `EditorTab.vue` の `.md-preview :deep(.frontmatter > …)` という子結合子なので、**Markdown 側でこのマークアップの入れ子を変えると rst のメタデータが黙って素の `<details>` に戻る**
    - **脚注と引用は Markdown プレビューの脚注（#241）と同じ HTML 構造で出す。** `md-preview` の CSS がそのまま当たるので、rst 側に見た目を書かずに済む。定義は**書かれた場所に描く**（`buildRstPreview` は入れ子でも呼ばれるので、末尾に集める先を決められない）
    - **エスケープ済みかどうかは `lib/text.ts` の `Html` 型で持つ。** 生の文字列を属性へ差し込む経路がコンパイルエラーになる。セキュリティレビューで実際に見つかったのがこの穴（`anchor` が引用符を戻していて属性から抜けられた）で、散文のコメントでは守れなかった
    - **表は 4 種（grid / simple / `list-table` / `csv-table`）に対応する。** 桁の切り出しは `lib/displayWidth.ts` の `sliceByWidth`（rst の表は**表示幅**で桁を合わせるので、`slice` を code unit で行うと全角を含む表が崩れる）。同ファイルの `displayWidth` は diff タブの横幅の見積もり（#272）から切り出したもので、2 つの消費者が同じ数え方を共有する。**セルの結合には対応しない**: grid の途中の罫線で境界の桁が埋まっていたら結合とみなし、`null` を返して字面のまま出す側へ落とす
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
  - **CSP を `https:` まで広げる案は採らなかった**。CSP は文書単位なので、プレビューのために緩めると**SVG プレビューとマニュアル**まで一緒に壁を失う。代わりに `resolveMarkdownImages` が**ローカル画像で既に使っている `data:` URL 化**に相乗りさせた（`fs_read_file_base64` の隣に `remote_image_fetch` を置いた形）
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
- `composables/useImagePaste.ts`。クリップボード/D&D のファイルを `.pike/uploads/` に保存 → ターミナルへ相対パスを挿入する。画像専用ではなく**任意のファイル**が対象（PDF 等も可）
- **Markdown エディタはここを通さない**（#241）。ドキュメントが指す画像は `.pike/uploads`（gitignore 済み）ではなくファイルの隣に置く。詳細は「Markdown の入力支援」を参照。共有しているのは書き込みの primitive `saveFileTo`（`MAX_UPLOAD_SIZE` の番人）とファイル名生成だけ
- 判別は **file か string か**（`ClipboardEvent` は `item.kind === 'file'`、D&D は `dataTransfer.files`）。テキスト（string）は長さに関係なくインライン貼り付けのまま
- 保存ファイル名は元名を保持（`stem-{hex}.ext`、衝突回避）。名前を持たないクリップボード blob（画像等）は `upload-{ts}-{hex}.{ext}` を生成
- 初回保存時に各プロジェクトへ `.pike/.gitignore`（中身 `*`）を書き込み、退避ファイルを repo から除外
- 小ファイルのインライン展開（`inlineSmallTextFiles` / `tryInlineFile`）は **AgentChatTab 限定**だったので、#275 で一緒に落とした。ターミナルへのドロップは元から常にアップロードで、そちらは変わらない
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
- Rust 側は `watcher::WatcherState` を `manage` して持ち、`fs_watch_start` / `fs_watch_stop` コマンドで出し入れする
- **`changedDirs` の受け手は `stores/fileTree.ts` に置く（#303）。** パネルは `v-if` で
  マウントされるので、あちらで購読すると別のパネルを見ているあいだ購読ごと外れる。溜めて
  おく仕組みと、それを `ensureInit` で流す理由は、あのファイルの doc コメントが正本
- **パスの比較は文字列一致**（root か、展開中のディレクトリか）なので、`activeRoot` は
  末尾の区切りを落とした値を配る（`lib/paths.ts` の `stripTrailingSep`）。**逆に、
  正規化済みの `activeRoot` と生の `project.root` を突き合わせないこと**: 末尾に `/` の
  付いた root が実在するので、その比較は永久に false になる（`stores/git.ts` の origin の
  記録が実際にこれで壊れた。「worktree に居るか」は `activeWorktreeRoot` を見る）
- **`IGNORED_DIRS` のディレクトリは展開できる（#303）が、監視の対象外なのは変わらない。**
  開いているあいだに中身が変わっても自動では反映されない（Rust 側が `path_contains_ignored`
  で捨てるため）。歯車付きのアイコンは、そこが「見えるが追わない場所」だという印
  - **中の listing では `git check-ignore` を走らせない**（`fileTree.ts` の `isUnderIgnored`
    が `checkGitignore` に `false` を渡す）。丸ごと ignore される前提で色を分ける意味が無く、
    `node_modules` 直下は名前を全部並べるとコマンドラインが Windows の上限に近づく
  - **この判定を Rust に置かないこと**: パスのセグメントを見るだけの述語では、`C:\dist\myproj`
    のように `IGNORED_DIRS` と同名のディレクトリの下に置いたプロジェクトで誤爆し、色分けが
    全ディレクトリで黙って消える。root を知っているのはフロント側だけ
  - **展開状態は保存しない**（`saveExpanded` が落とす）。覚えると次にプロジェクトを開くたびに
    そこを読み直すことになる（WSL では 1 ディレクトリにつき `wsl.exe` 1 本）

## 検索 (rg / grep)
- 起動時に `which rg` で backend 判定、以降固定
- rg: `rg --json -F/-e --glob` でパース容易な出力
- grep: `grep -rn --include/--exclude` でフォールバック
- フロントには検索バックエンドをバッジ表示
- 結果クリックでエディタタブを開き、`initialLine` で該当行にジャンプ
- 最大 500 件で打ち切り（`MAX_MATCHES`）、デバウンス 300ms
- **プロセスの実行が `run` 系を通らない唯一の経路（#257）**: `types.rs` の `spawn_capped_lines` が stdout を 1 行ずつ読み、上限に達したらパイプを閉じて子を止める。`run` 系は出力を全部メモリに溜めてから返すので、「大量に出るが先頭しか要らない」検索では作らせたものの大半を捨てることになる（`function` の検索で rg が 8.3MB を作り、実測 2,054ms → 打ち切りで 215ms。検索そのものは 22ms）。rg には**全体**の件数上限にあたるフラグが無い（`--max-count` はファイルごと）ので、受け取る側で止めるしかない
  - **止め方はパイプを閉じること**。`kill` も撃つが、WSL では `wsl.exe` を殺してもディストロの中の rg には届かない
  - **stderr は別スレッドで吸う**。読まずに置くと、エラーを大量に出すコマンドがパイプを埋めたところで止まる
  - `search/mod.rs` に残るのは引数の組み立てと 1 行ごとのパーサ（`parse_rg_line` / `parse_grep_line`）。**打ち切ったかは件数から導く**（上限で止まるので `items.len() >= cap` と同値）
  - `list_project_files`（`--files`、`MAX_FILES`=10,000）も同じ経路
- rg サイドカーバンドル: `src-tauri/binaries/rg-{target}.exe` を `externalBin` でアプリに同梱
  - Windows プロジェクト: システム rg → バンドル版 rg → grep の順でフォールバック
  - WSL プロジェクト: WSL の rg → WSL の grep（バンドル版は Windows バイナリのため使用不可）
  - `scripts/download-rg.sh` でビルド前にダウンロード（バイナリは .gitignore）
- `list_project_files` コマンド: `rg --files` / `find` でプロジェクト内ファイル一覧取得（QuickOpen 用）

## QuickOpen コマンドパレット（Ctrl+P）
- 先頭文字でモード切替: 無印=ファイル fuzzy open、`>`=**コマンドとタスク**、`@`=タブ切替、`:`=行ジャンプ、`!`=Git ブランチ切替、`?`=ヘルプ。`filename:42` サフィックスで行番号ジャンプ
- **`>` に出すコマンドの正本は `lib/shortcuts.ts` の `APP_ACTIONS`**（#270）。ここに `palette`（分類）を持つ行を流すだけで、**パレット側に一覧を持たない**。以前は `QuickOpen.vue` に 3 件ハードコードされていて、機能を足しても誰も気付かなかった（この issue そのもの）
  - **機能を足したらこの表に 1 行足す。** 実装（`useAppActions`）は `Record<AppActionId, …>` なので、足して実装を忘れると型エラーになる。逆向き（機能を足して表に書き忘れる）は型では拾えないので、ここに書いてある
  - 表示は `分類 / 名前 / キー`。絞り込みは**日本語と英語の両方**に当たる（`search` に両方入れてある）。UI 言語が日本語でも `> settings` や `> pull` で引ける
  - `needsProject` を持つ行は、プロジェクトを持たないウィンドウでは出さない。パネルを開く行には付けない（サイドバーのアイコンは常に出ていて、クリックすれば空のパネルが開く。パレットだけ隠すと入口で挙動が割れる）
  - キーの割り当ては別の表（`keyBindings`）。詳細は `.claude/rules/terminal.md` の「キーボードショートカット」
- `QuickOpen.vue` は ProjectSwitcher と同じオーバーレイ + モーダル構造、表示状態は `project.showQuickOpen`
- fzf 風 fuzzy match（ファイル名優先 → パスマッチ）、最近開いたファイルを上位表示
- **最近開いたもの（#271）**: ファイルは**プロジェクトごと**（`pike:recent-files:{projectId}`。他プロジェクトのファイルが混ざると上位表示の役に立たない）、ディレクトリは**マシン全体**（`pike:recent-dirs`。どのプロジェクトからでも同じ場所に戻りたい）。どちらもパスなので同期の対象にしない。ディレクトリは `>` モードにコマンドとタスクの間で出す（「開く」操作の続きなので、コマンドのすぐ下）
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
- **グループの折り畳み（#273）**: 状態は `stores/tasks.ts` が持ち、`localStorage` のキーは**プロジェクトごと**（`pike:tasks-collapsed:{projectId}`。`fileTree` の `expanded` と同型）。`sourceFile` はルート相対なので、1 つのキーに全プロジェクトを入れると別プロジェクトの `package.json` と衝突するうえ、他のウィンドウが書いた分を読み直してから差し替える羽目になる
- グループ見出しの sourceFile クリックで定義ファイルをエディタタブで開く（#159。`taskStore.openSourceFile`、`group.cwd` + `basename(sourceFile)` で絶対パス化）
- フロント: `stores/tasks.ts` + `components/panels/TasksPanel.vue` + `types/tasks.ts`

