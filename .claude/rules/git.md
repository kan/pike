# Git 実装ルール

`git` CLI ブリッジ（`git2` クレートは使わない）と worktree 連動。
実体は `src-tauri/src/git/mod.rs`、`src/stores/git.ts`、`src/stores/worktree.ts`、`src/components/panels/GitPanel.vue`、`src/lib/editorConflict.ts`。

## Git 統合
- `git` CLI 経由（WSL/Windows 両対応）。`git2` クレートは使わない
- Rust 側 `build_git_command` が ShellConfig に応じて `wsl.exe git` / `git` を組み立て
- ステータスバーにブランチ名+ダーティ表示、クリックでブランチ切替
- ブランチ切替ドロップダウンのリモートブランチ対応（#197）: `git_branch_list` は `for-each-ref --format=%(refname) refs/heads refs/remotes` で `GitBranches { local, remote }` を返す（`<remote>/HEAD` は symbolic ref なので除外）。リモートは**ローカルに同名が無いものだけ**を「リモートブランチ」見出し配下に出し、選択で `git_checkout_track`（`git checkout --track origin/foo`）で追跡ローカルブランチを作って切替。ローカル名は git に決めさせる（`localBranchName` は表示判定専用のヘルパーで、リモート名にスラッシュを含む稀なケースでも checkout 側は壊れない）。既にローカルがある場合は `--track` が失敗するので `gitCheckout` にフォールバック。ドロップダウンを開くと `refreshRemoteBranches` が**既存の throttled `fetchInBackground`（60 秒間隔・focus 必須）**を再利用して fetch → 一覧再読込（開くたびに通信しない）。一覧は cached refs で即表示し、fetch は待たない。QuickOpen の `!` モードはローカルのみ（従来どおり）
- Git パネル: ステージング/アンステージ、コミット、push/pull/refresh、コミットツリー展開
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
- **参照ルートの単一の真実**: `stores/project.ts` の `activeRoot`（非 null computed = `activeWorktreeRoot ?? currentProject.root ?? ''`）。file tree / git / search / tasks / docker、およびエディタの git 操作（diff ガター・History・定義ジャンプ・MD リンク解決）はすべて `project.root` ではなく `activeRoot` を参照する。root 相対操作で残る `project.root` 直参照は worktree 追従漏れのサイン（ターミナル cwd / agent cwd / 画像アップロード先など意図的にプロジェクト固定の箇所を除く）
- `stores/worktree.ts`: worktree 一覧・`setActiveWorktree(w)`（`isMain` フラグで null/パスを決定。文字列一致に依存しない）・focus 連動ポーリング（`gitStore.status` が非 null の git リポジトリのみ。同一ウィンドウ内ターミナルでの `git worktree add` を反映、古い load 結果は projectId で stale ガード）
- ステータスバーの worktree セレクタ（`FolderGit2`、worktree が 2 つ以上の時のみ表示）。選択で 5 パネル + エディタを再読込
- fs watcher は App.vue の `watch(activeRoot)` 単一所有で再ポイント（worktree 切替・プロジェクト切替の両方をカバー。リポジトリ外の worktree でも更新を取得）
- 切替単位はウィンドウ（プロジェクト）ごとに 1 つ。起動時は常に main worktree（`activeWorktreeRoot=null`）から開始、セッション非永続。タブ切替による自動追従は未実装（agent を root で起動し内部で worktree を選ぶ運用では cwd ベース検出が効かないため手動セレクタを主軸とする。将来 agent タブ常用時に再検討）

