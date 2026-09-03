# Git 実装ルール

`git` CLI ブリッジ（`git2` クレートは使わない）と worktree 連動。
実体は `src-tauri/src/git/mod.rs`、`src/stores/git.ts`、`src/stores/worktree.ts`、`src/components/panels/GitPanel.vue`、`src/lib/editorConflict.ts`。

## Git 統合
- `git` CLI 経由（WSL / Windows / macOS のいずれでも動く）。`git2` クレートは使わない
- Rust 側は `types.rs` の `git_args` が引数（`-c core.quotePath=false` と `-C <root>`）を組み、`ShellConfig::run*` が ShellConfig に応じて `wsl.exe git` / `git` を起動する（`git/mod.rs` の `run_git` / `run_git_full` / `run_git_raw_stdout` がその入口）。WSL で複数の git 呼び出しを 1 回の spawn にまとめる経路だけ、argv ではなく bash 行を組む `git_bash_prefix` を使う
- ステータスバーにブランチ名+ダーティ表示、クリックでブランチ切替
- ブランチ切替ドロップダウンのリモートブランチ対応（#197）: `git_branch_list` は `for-each-ref --format=%(refname) refs/heads refs/remotes` で `GitBranches { local, remote }` を返す（`<remote>/HEAD` は symbolic ref なので除外）。リモートは**ローカルに同名が無いものだけ**を「リモートブランチ」見出し配下に出し、選択で `git_checkout_track`（`git checkout --track origin/foo`）で追跡ローカルブランチを作って切替。ローカル名は git に決めさせる（`localBranchName` は表示判定専用のヘルパーで、リモート名にスラッシュを含む稀なケースでも checkout 側は壊れない）。既にローカルがある場合は `--track` が失敗するので `gitCheckout` にフォールバック。ドロップダウンを開くと `refreshRemoteBranches` が**既存の throttled `fetchInBackground`（60 秒間隔・focus 必須）**を再利用して fetch → 一覧再読込（開くたびに通信しない）。一覧は cached refs で即表示し、fetch は待たない。QuickOpen の `!` モードはローカルのみ（従来どおり）
- Git パネル: ステージング/アンステージ、コミット、push/pull/refresh、コミットツリー展開
- **porcelain v2 の `2 ` 行（リネーム / コピー）はフィールドが 1 つ多い（#306）**。`1 ` が
  `<XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` の 9 個なのに対し、`2 ` はそのあいだに
  スコア（`R100` / `C75`）が入って 10 個で、最後が `<path><TAB><origPath>`（**新しい名前が先**）。
  どちらも `splitn(9)` で分けていたころは、9 個目に「スコア + 空白 + パス」がまるごと残り、
  タブで切っても `R100 new.md` がファイル名になっていた
  - 症状は**静かに壊れる側**だった: 存在しない名前がパネルに並び、クリックすると
    `git diff -- "R100 new.md"` が exit 0 の無出力を返すので**空の diff タブが黙って開く**。
    アンステージも exit 0 で何もしない（ステージだけは `pathspec ... did not match` で落ちる）
  - `git show --pretty= --name-status` 側（`git_show_files`）は別の形（`R100\told\tnew`）で、
    タブで分けて末尾を取っており正しい。`u ` 行はリネームを伴わないので 11 個で固定
- 非 git リポジトリ対応（#156）: `git status` がエラーの時、`git_is_repo`（`git rev-parse --is-inside-work-tree`、非 repo でも Err にせず `false` を返す）で「リポジトリじゃない」を切り分け、`gitStore.isRepo=false` にして生の git エラーを出さない。GitPanel は専用ビュー（メッセージ + 「リポジトリを初期化」ボタン → `git_init`）を表示（VSCode 風）。init 後は status/log/remote を再読込
- コンフリクト（unmerged）表示: `parse_status` が porcelain v2 の `u ` 行をパースし `GitStatusResult.conflicted`（status は XY コード `UU`/`AA` 等）に格納。GitPanel 最上部の専用「Conflicts」セクションでパスを赤字（`--danger`）表示、クリックで作業ツリーのファイルをエディタで開く。SideBar の Git バッジ件数に conflicted を加算し、コンフリクト時は danger（赤）バッジ。エディタは `lib/editorConflict.ts`（CodeMirror ViewPlugin）でマーカー行（`<<<<<<<`/`|||||||`/`=======`/`>>>>>>>`）と各セクション本文を色分けハイライト（半透明オーバーレイで両テーマ対応）
- **エディタ上のコンフリクト解消（#223）**: 同じ `editorConflict.ts` に、各領域の上へブロック widget のボタン列（ours / theirs / 両方）と、`showPanel` の上部バー（件数＋ファイル全体の一括適用）を足した
  - **パースは `StateField<Conflict[]>` に 1 回だけ**（`editorGitGutter.ts` の `diffField` と同じ形）。decoration・パネルの出し入れ・パネルの中身・widget が全部これを読む。この拡張は**全エディタタブに常時入っている**ので、素朴に書くと打鍵ごとに全行走査が 4 周する（コンフリクトの無いファイルでも）。走査は `doc.iterLines()` の 1 パスで、行ごとの `doc.line(i)`（木を毎回降りる）は使わない
  - `Conflict.lines` が領域内の全行と色分け種別を持つので、**decoration の構築はドキュメント全行ではなくコンフリクト行数に比例する**
  - **ボタンのラベルはマーカー行から取る**（`<<<<<<< HEAD` → 「HEAD を採用」）。無ければ「現在の変更を採用」に落とす
  - **diff3（`|||||||` あり）では ours の終端が `=======` ではなく base マーカー**。base セクションはどちらの側でもない
  - 置換は 1 トランザクションにまとめる（一括適用も `Ctrl+Z` 一回で戻る）。片側が空のときは直前の改行ごと消す（残すと空行が残る）
  - **保存もステージもしない**。`Ctrl+S` と Git パネルの担当のままにして、解消 → 保存 → ステージ → #222 の「続行」という既存の流れに乗せる
  - **ステージの導線は Conflicts セクションに足した**（各行の Check ボタンと見出しの「すべて解決済みに」）。porcelain v2 の `u ` 行は `conflicted` にしか入らず、コンフリクト中のファイルは Unstaged 一覧に出ないため、**それまでは Pike からステージする手段が無かった**（作業ツリーのマーカーを消しても index は unmerged のままで、`git add` するまで一覧に残り続ける）。マーカーが残っているファイルは `fs_read_file` で見て名前を挙げて確認する（そのままステージするとマーカーごとコミットされる）
  - 未完成の領域（`<<<<<<<` はあるが `>>>>>>>` がまだ無い＝編集中）は色分けだけして**ボタンを出さない**。丸ごと書き換えられる領域だけが対象
  - **読み取り専用の判定は `EditorState.readOnly`**。`EditorView.editable` は Pike が一度も設定しない別 facet（既定 true）なので、あれを見てもガードにならない
  - `WidgetType.eq` はオフセットを比較しない（上を編集するたびに全部の行がずれて、下の widget が毎打鍵で作り直される）。index とラベルだけを見て、クリック時に `conflictField` から現在の領域を読み直す
  - **ラベルは DOM 構築時に焼き込まれる**ので、UI 言語の切替に追随させるため `EditorTab.vue` が `conflictCompartment` で再登録する（他の設定と同じ compartment の流儀）
- diff タブ: 左右分割表示、文字単位ハイライト（common prefix/suffix 方式）
- **diff の横スクロールはセルの中で起こす（#272 → #297）**: `table-layout: fixed` ＋ `width: 100%` ＋ セルの `overflow: hidden` だと、長い行はセルの中で切られて**テーブルが横に伸びない**＝スクロールすべき領域そのものが生まれない（#272 の「横スクロールが効かない」の正体）。かといって表を最長行に合わせて広げると（#272 の直し方）、左右の欄はどちらも最長行の幅になるので**右のペインの開始位置が画面の外へ出る**（#297）。いまは表をウィンドウ幅に固定し、欄の中身（`.cell-inner`）を `transform` でずらす。ずらす量は下端に置いた 1 本の帯（`.hscroll`）の `scrollLeft`
  - **左右は連動させる**（同じ行の左右を見比べる用途なので、同じ桁が両側に出ているほうがよい）。連動するから帯は 1 本で足りる
  - **表をやめて左右を別々のスクロール領域に割らないこと**。いまの `<table>` が「同じ行の左右が必ず同じ高さに揃う」を保証していて、折り返し ON では左右で行の高さが変わりうる
  - **`.cell-inner` は `display: block`**。素のインライン要素には `transform` が効かない
  - **帯は要るときだけ高さを持たせる**（`display: none` にすると幅を測れず、出すかどうかの判定そのものができなくなる）。`height: 0` ＋ `overflow-x: scroll` なら測れる
  - `table-layout: fixed` は最初の行から列幅を取るので、**列幅は `<colgroup>` で決める**（#285 の帯が先頭に来ると 4 列が等分される）。左の欄だけ `--split` で幅を持ち、右は残りを取る
  - **分割線はドラッグできる**（`--split`、タブ単位でセッションには残さない。ダブルクリックで半々）。表の列のあいだには要素を置けないので、位置は実測して重ねる（縦スクロールバーの幅も込みになる）。配線は `composables/useDragResize.ts`（サイドバーの幅と共有。見た目は `theme.css` の `.drag-x-handle`）
  - **スクロールとドラッグの最中は Vue を通さない**。`--scroll-x` や `--split` を `:style` に載せると、動かすたびにコンポーネントの render が丸ごと走り、仮想化していない表の vnode が行数ぶん作り直される。書きたいのはカスタムプロパティ 1 つなので、そこだけ素の DOM 操作に逃がす。確定値だけを ref に入れて、そこで 1 回測り直す（ドラッグ中に `measureLayout` を呼ぶと強制リフローが mousemove ごとに走る）
  - `--scroll-x` の置き場は `.diff-scroll`（読むのは `.cell-inner` だけ）。ツールバーや検索パネルまで含む `.diff-tab` に置くと、無関係な部分までスタイル再計算の検討対象になる。`--split` / `--content-ch` は帯（表の外）も読むので `.diff-tab` に置く
  - 幅の見積もりは**セル数**で数える（`ch` は等幅フォントの 1 セル）。全角は 2、タブは 8（`tab-size` 未指定なので CSS の既定値。エディタの `editorTabSize` とは無関係）と、どちらも上限側に倒す。多く見積もっても余分にスクロールできるだけだが、少ないと `overflow: hidden` が黙って切る。**ASCII は `charCodeAt` で先に片付ける**: 折り返し OFF が既定なので diff を開くたびに全文を 1 度なめる。code point の反復子は 1 文字ごとに文字列を作るので 4 倍かかる
  - **`calc()` は CSS 側に置く**（`.hscroll-inner`）。足すのは行番号列の幅と padding で、どれもすぐ上の `.line-num` / `.line-content` の宣言そのもの。px の合計を JS に持たせると、padding を変えたときに横スクロールの範囲が黙って足りなくなる。**寸法とフォントの変数は `.diff-tab` に置く**（帯は表の外にあり、`1ch` を同じフォントで解決する必要がある）
  - 折り返しはタブ単位で上書きできる（既定は設定の `diffWordWrap` = `auto` / `on` / `off`）。エディタの `WrapToggle.vue` を共用し、検索パネルと同じ角に出るので開いているあいだは隠す
  - **`auto` の判定はブラウザに測らせる**（帯のはみ出しを狭いほうの欄の幅で割って `AUTO_WRAP_RATIO`=2 超）。`--content-ch` は見積もりで、フォントの実寸もペインの幅も知らない。**live な computed にしないこと**: 折り返すとはみ出しが消えるので、はみ出し量から直に導くと ON と OFF を往復する。折り返しているあいだは測らず、結果は `autoWrapped` に latch する
  - 既定を `auto` にしたのは、**横スクロールに気付けない**ため（`theme.css` のスクロールバーは 6px）。同じ理由で、横にスクロールできる差分では折り返しボタンを薄くせず出したままにし、帯だけ 10px にしてある
  - **検索の移動は横にも寄せる**。桁の外にある一致は `scrollIntoView` では出てこない（あちらはスクロールできる祖先しか動かさない）
  - **欄は `overflow: clip`（`hidden` ではない）**。`hidden` は欄自身をスクロール領域にするので、`scrollIntoView` が欄そのものを横に動かし、`--scroll-x` のずらしと二重にかかる
  - **横のホイールを受けても、縦成分があるなら `preventDefault` しない**。タッチパッドの斜めのジェスチャは `deltaX` と `deltaY` を同時に持つので、止めると縦に動かなくなる
  - **代償は、横スクロールがネイティブの合成から外れること**。`--scroll-x` の書き換えは（表を仮想化していないので）全セルの再計算を伴うので、書き込みは `requestAnimationFrame` で 1 フレーム 1 回に畳んである。数千行の diff で重くなるなら、次の手は行の仮想化（左右の高さを揃える保証をどう保つかから設計し直しになる）
  - **「まとめて表示」には上限がある**（`EXPAND_ALL_MAX`=2000）。仮想化していないので、2 万行のファイルの 1 行を直した差分では 1 クリックでウィンドウが固まる。上限を超える領域はボタンの文言を変えて「N 行のうち M 行」と出す
- **省略された行の展開（#285）**: hunk と hunk のあいだをボタンで少しずつ広げる（GitHub / VS Code と同じ）。`diffParser.ts` の `DiffLine.hunk`（`@@` 行だけが持つ `HunkRange`）が唯一の情報源で、計算は **`lib/diffExpand.ts` の `expandDiff`**（純粋）が「展開済み ＋ 残り ＋ 展開済み」に分けて行を積む。`DiffTab.vue` に残るのは取得（IPC）と操作だけ（`parseDiff` / `collectMatches` と同じ分け方）
  - **取り寄せるのは新しい側のファイルだけでよい**。省略されているのは変更のない context 行なので左右の欄は同じテキストになり、行番号は hunk ヘッダから引ける。旧側も取ると IPC が 2 回になるうえ、両者の対応付けを自前で持つことになる
  - 取得先は diff の出どころで変わる: コミットならそのコミット、ステージ済みなら index（`git show :<path>`＝空リビジョン）、それ以外は作業ツリー。**押されるまで取りに行かない**（開いただけの diff で IPC を増やさない）。**例外は帯が 1 つも出ないとき**で、そのときだけ自分から 1 回取りに行く: 末尾の省略は行数が分からないと帯を出せず、その行数は取り寄せて初めて分かるので、hunk が 1 つで 1 行目から始まる差分（先頭の省略も無い）は押す場所が生まれず一生広げられない
  - **取り寄せた全文が diff のものか `matchesDiff` で確かめる**。diff タブは開いたあと取り直さないので、開いたままエディタで保存すると行がずれる。確かめずに使うと、行番号だけ付いた空行や別の場所の内容が「省略されていた行」として無言で混ざる。改行コードは比べない（`core.autocrlf` の環境では diff が LF・作業ツリーが CRLF になる）
  - **展開の状態のキーは直後の hunk の `rawLines` での位置**。帯を出す位置（`Gap.at`）は展開するたびに動くので、そちらを覚えると 1 回広げた時点で行き先を見失う
  - `head` / `tail`（上・下に hunk が無い）でボタンを出し分ける。ファイル先頭の領域は上へ、末尾の領域は下へしか意味がない
  - **広げ切っても帯は残す**（`Gap.count` が 0 になり `shown` が残る）。畳み直す入口はそこにしか無いので、消すと一度広げた領域を元に戻せない
  - **列幅は `<colgroup>` で決める。** `table-layout: fixed` は既定で最初の行から幅を取るので、帯（`colspan="4"` の 1 セル）が先頭に来ると 4 列が等分され、行番号の欄が本文と同じ幅になる（差分が 3 分割されたように見える）。`<col>` の幅は border-box なので、セルの `width` と `padding` を足した値にする
  - **`parseDiff` は末尾の改行が作る空要素を捨てる**。context 行として拾うと実在しない空行が最終行の次に付き、行番号も 1 つ余分に進む。長らく「diff の最後に空行が 1 つ出る」だけだったが、省略された行を埋めるようになって、埋めた行の番号が実ファイルとずれる形で表に出た
  - 帯と行は `blocks` の 1 本の列にまとめる。末尾のぶんを `v-for` の外に出すと、同じマークアップを 2 つ持つことになる。`gaps` は `at` の昇順で出てくるので、合流はポインタ 1 本で足りる
  - 折り返しの「自動」の判断は**差分が入れ替わったときだけ**やり直す。展開のたびに `autoWrapped` を落とすと、折り返しが外れてから測り直して戻るので画面が揺れる
- **途中停止した操作の検出と再開（#222）**: `GitStatusResult.operation`（`GitOperation { kind, branch, step, total, stop, stoppedSha, stoppedSubject }`）を `git_status` の中で埋め、GitPanel 最上部にバナー＋続行 / 中止ボタンを出す。別コマンドにしないのは、10 秒ポーリング・StatusBar・worktree ストアが既に `git_status` を通っているため（2 つに分けると「競合あり」と「操作なし」が食い違いうる）。探索の失敗は握り潰す（`operation` のせいで status が Err になってはいけない）
  - **検出を条件で間引かない**: 「HEAD が detached、または競合あり」のときだけ探索する案は**素の `git pull`（マージ）の停止を丸ごと取りこぼす**。実測で、マージ競合停止は `# branch.head` が `main` のままで、署名失敗のマージに至っては競合 0・detached でない・`MERGE_HEAD` だけが痕跡という状態になる。代わりに探索を `git status` と同じ 1 往復に畳んだ（WSL は `remote_urls_wsl` と同じ「`bash -c` で複数の git 呼び出しを 1 回の `wsl.exe` にまとめる」手口。定常コストは従来と同じ 1 spawn）
  - 状態ファイルは gitdir 配下にあるので、`git rev-parse --absolute-git-dir` 1 回で `.git` がファイルの linked worktree も通る。ただし **Windows 側は `<root>/.git` がディレクトリなら rev-parse を省く**（通常のリポジトリはこれで当たり、プロセス起動が 1 回で済む。WSL 側は既に同じ spawn の中なので分岐しない）。**パスのキャッシュは持たない**（ステートレス方針）
  - **存在判定に `fs::batch_read_files` を使わない**: あれは中身を trim して空を `None` に潰すため、`message` が「空」なのか「無い」のか区別できない。`commit-failed` の判定はそこに乗っている。WSL 側は `exists FS content` のレコードを `OP_STATE_FILES` の順で返す（`remote_urls_wsl` と同じ位置対応。名前は流さない）
  - `OP_STATE_FILES` は `(パス, 内容を読むか)` の表。ほとんどは「git が書いたか」だけが信号なので `cat` しない。とくに `BISECT_LOG` は bisect の 1 ステップごとに増えるため、読むと 10 秒ごとに全文がパイプを渡る
  - **どの種別にボタンを出すかは Rust が `can_continue` で返す**（`am` はメールボックス、`bisect` は good/bad が要るので対象外）。フロントの定数にすると、種別を増やしたときに更新漏れが型エラーにならず無言でボタンが消える
  - **`rebase-merge/interactive` は `-i` の判別に使えない**（素の `git rebase` でも作られる。実測）。rebase / am の区別は `rebase-apply/applying` の有無
  - `stop` の分類: 競合あり → `conflict`（`.git` から再導出せず、パース済みの `conflicted` を使う）/ rebase かつ競合なしかつ `message` も `stopped-sha` も無い → `commit-failed` / それ以外 → `stopped`。**マージ系に `commit-failed` の特別扱いは要らない**（`git merge --continue` が `MERGE_MSG` でコミットし直すので、署名失敗でも通常の続行で復帰する。実測）
  - **復帰コマンドはターミナルタブで走らせる**（`runCommandTab`、`cwd=activeRoot`・`keepOnError: true`・`onExit` で status/log 再取得）。`git rebase --continue` は `$EDITOR` を開き、署名は 1Password の承認ダイアログを伴い、バックエンドの git 呼び出しは TTY 無し・stdout 破棄・30 秒タイムアウトでどれも通らない。`--abort` も同じ経路（失敗しうるものをバックエンドに回すと、この issue が直そうとしている「生の stderr がパネルを潰す」経路に戻る）
  - **コンフリクトが残っている間は「続行」を押せない**（`conflicted` が非空なら disable ＋ ツールチップ、store 側にも同じガード）。どの `--continue` も未 merge のパスがあると `You must edit all merge conflicts and then mark them as resolved using git add` で即座に拒否するので、押せるようにしておくとユーザーをそのエラーに突き当てるだけになる
  - **コマンドの連結は `types/tab.ts` の `chainOnSuccess` を通す**: **Windows PowerShell 5 には `&&` が無く**（パースエラー。pwsh 7 / cmd / bash 系にはある）、`;` は失敗しても次を走らせてしまうので、あのシェルだけ `; if ($LASTEXITCODE -eq 0) { … }` に落とす。復帰は「コミットし直してから続行」の 2 段なので、コミットが再び失敗したら続行してはいけない
  - **`git commit -C <SHA>` の誤爆ガード**: SHA は `rebase-merge/done` の**末尾行**から取る（競合停止では todo が空になるため、todo の先頭行は当てにできない。両方の停止で実測）。`done` は追記書き込みなので末尾行が不完全なことがあり、`pick`/`reword`/`edit`/`squash`/`fixup` で始まり SHA が hex であることを確認する。`exec` / `break` の停止ではコミットは既に成功しているので**ボタンを出さない**（出すと他コミットの author・日時・メッセージを被せた偽コミットを黙って作る）。押下時は確認ダイアログに SHA・件名・実行コマンドを出す
- `git_pull` だけ失敗時に stdout も返す（`CONFLICT (content): …` は stdout 側で、共通の `spawn_stdout` は stderr しか残さない）。`spawn_stdout` 自体は触らない（全 git コマンドのエラー文が変わる）
- **`gitStore.error` はパネル全体を置き換えない**: `status` があるときはセクション上部のストリップとして出す。以前は `v-else-if` でパネル本体ごと差し替えていたため、pull が止まった瞬間に競合一覧もコミット欄も消えていた。`pull()` は失敗時も `refreshStatus` / `refreshLog` を呼ぶ（呼ばないとバナーと競合一覧が次のポーリングまで 10 秒出ない）。**エラーの代入は refresh の後**（`doRefreshStatus` は成功時に `error` を null に戻すので、先に入れると消える）
- SideBar の git マーカー（ahead/behind の矢印）は、操作が止まっているときは `!` を優先表示する。署名失敗の pull は競合 0・変更件数 0 なので、パネルを閉じているとバッジにも矢印にも出ない
- ahead/behind: `git status --porcelain=v2 --branch` の `# branch.ab` 行をパース。GitPanel コミットボタン下にテキスト表示、SideBar の pull/push ボタンを primary スタイルに変更
- コミットログは `%B`（全文）取得、一覧は1行目のみ表示、ホバーで全文ツールチップ
- ツールチップ・コンテキストメニューの位置決め（#204）: 高さが中身次第で決まるので、**hidden で描画 → 実測 → 配置**の順に置く。配線は `composables/useAnchoredPopup.ts`（`useTemplateRef` で受けた要素を `nextTick` 後に計測し、`style` に位置と `visibility` を返す）、幾何は `lib/popupPosition.ts`（`placeNearAnchor` = 上優先・入らなければ下、`clampToViewport` = カーソル位置を画面内へ）。測るまで hidden なのは仮位置に 1 フレーム出てから飛ぶのを防ぐため（`display: none` は測れず、`opacity: 0` はクリックを拾う）。ウィンドウより高いメッセージは CSS の `max-height` で頭を残して切る（`pointer-events: none` なのでスクロールできない）。**CSS の anchor positioning は採らない**: Chromium 125+ が要るが Tauri は WebView2 のバージョンを固定できず、失敗しても例外ではなく「変な位置に出る」だけで気付けない。カーソル位置に開くメニューは**全部この composable を通す**（GitPanel のコミット/ファイル、FileTreePanel、TabPane のタブ/管理者、SideBar の pull-push、EditorTab）。**新しいメニューを足すときも同じ**（生の `clientX/clientY` を `style` に流すと画面端で見切れる）。SideBar の pull/push メニューだけは `.sidebar.ui-zoom` の内側にあり、UI ズームが 1 以外だと clamp が概算になる（座標系が zoom 倍される。既定の 1 では厳密）
- ブランチマージグラフ: `git log --all` + `%P`（親ハッシュ）/`%D`（refs）で取得、`gitGraph.ts` のレーン割当アルゴリズムで SVG 描画。List / Graph 切替
- git log フォーマット区切り: ASCII Unit Separator (`%x1f`) + Record Separator (`%x1e`) を使用（NUL だと `%D` が空のコミットでレコード区切りと衝突するため）

## Git worktree 連動
- `git_worktree_list` コマンド（`git worktree list --porcelain` をパース）が `{ path, branch, head, isBare, isDetached, isMain }[]` を返す。bare クローン構成では bare エントリを main 扱いせず**最初の非 bare** を `isMain` とし、`prunable`（ディレクトリ消失）worktree は一覧から除外
- **参照ルートの単一の真実**: `stores/project.ts` の `activeRoot`（非 null computed = `activeWorktreeRoot ?? currentProject.root ?? ''`）。file tree / git / search / tasks / docker、およびエディタの git 操作（diff ガター・History・定義ジャンプ・MD リンク解決）はすべて `project.root` ではなく `activeRoot` を参照する。root 相対操作で残る `project.root` 直参照は worktree 追従漏れのサイン
- **「これから開くもの」も追従する（#269）**: 新規ターミナルの cwd（`useAppActions.openTerminal` / `useCliOpen` / セッション復元）・アップロード先（`.pike/uploads`）・TODO（`.pike/todo.md`）・usage の集計 root。**以前は「意図的にプロジェクト固定」としていたが、固定する理由が無かった**: どれも受け手はターミナルやエージェントの cwd で、そちらが worktree に居るなら基準が食い違う。実害は 3 つで、(1) 貼り付いた `.pike/uploads/…` の相対パスがエージェントに届かない、(2) `pike todo` は cwd から上に辿って worktree の `.pike/todo.md` を書くのでパネルと別ファイルになる、(3) usage は cwd と root の一致で集計するので、worktree で作業しているあいだ数字が 0 になる
- **走っているターミナルの基準は動かさない**: ドロップの相対パスはそのタブを開いた cwd を基準にする。ここで `activeRoot` を読み直すと、あとから worktree を切り替えたときに、走っているシェルへ届かないパスを送る
  - **`saveUploadFile` の置き場も同じ理由で呼び出し側が決める**（`root` 引数）。ターミナルはそのタブを開いた cwd。ここだけ `activeRoot` にすると、切り替え前から開いているタブに貼ったファイルが、そのタブからは見えない場所に置かれる。**ターミナルはシェルの現在地（OSC 7）を使わない**: `cd` した先に `.pike/` を作ると、`pike todo` の「既存の `.pike` を最優先」がリポジトリのルートより手前のそれを拾う
  - `.pike/` を作る側は **`lib/pikeDir.ts` の `ensurePikeDir`** を通す（`.gitignore` の設置込み）。アップロードと TODO が同じ手順を別々に持っていて、「1 度だけ」の記憶をどちらもディレクトリ単位に変えたときに完全な複製になった
  - **保存待ちの書き出しは、切り替えの前に流す**（`stores/todo.ts` の `flushSave`）。`load` は保存待ちのあいだ読み込みを捨てるので、流さずに切り替えると切り替え前のタスクを表示したままになり、次の編集がその内容を切り替え先のファイルへ書き込む
  - **usage の追従は `createUsageStore` が持つ**（`rootScoped`、既定 true）。工場側で `activeRoot` を watch し、取得中に root が変わったら結果を捨てて取り直す（`refreshGuard` は取得のあいだ立ちっぱなしなので、切り替え側から叩いても弾かれる）。**切り替え側から名指しで叩かないこと**: 「どの usage が root に依存するか」の知識が 2 箇所に分かれ、store を増やしたときに片方だけ漏れる。レートは `rootScoped: false`（アカウント単位で、`project_root` はシェルを選ぶためにしか使わない）
- **TODO の保存先は予約時に確定させる**（`stores/todo.ts` の `scheduleSave`）。デバウンス中に参照先が変わるので、`persistNow` が `location()` を呼び直すと待機中の編集が切り替え先のファイルへ書き込まれる。同じ理由で読み込みの stale ガードもプロジェクト id ではなくパスで見る
- **追従させないもの**: worktree 一覧の取得（`gitWorktreeList` は main から引く）と `git.ts` の remoteUrl 記録（main のときだけ書く、が仕様）
- `stores/worktree.ts`: worktree 一覧・`setActiveWorktree(w)`（`isMain` フラグで null/パスを決定。文字列一致に依存しない）・focus 連動ポーリング（`gitStore.status` が非 null の git リポジトリのみ。同一ウィンドウ内ターミナルでの `git worktree add` を反映、古い load 結果は projectId で stale ガード）
- ステータスバーの worktree セレクタ（`FolderGit2`、worktree が 2 つ以上の時のみ表示）。選択で 5 パネル + エディタを再読込
- fs watcher は App.vue の `watch(activeRoot)` 単一所有で再ポイント（worktree 切替・プロジェクト切替の両方をカバー。リポジトリ外の worktree でも更新を取得）
- 切替単位はウィンドウ（プロジェクト）ごとに 1 つ。起動時は常に main worktree（`activeWorktreeRoot=null`）から開始、セッション非永続。タブ切替による自動追従は未実装（agent を root で起動し内部で worktree を選ぶ運用では cwd ベース検出が効かないため手動セレクタを主軸とする。将来 agent タブ常用時に再検討）

