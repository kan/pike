---
paths:
  - "src-tauri/src/git/**"
  - "src-tauri/src/ssh_agent.rs"
  - "src/stores/git.ts"
  - "src/stores/worktree.ts"
  - "src/types/git.ts"
  - "src/components/panels/GitPanel.vue"
  - "src/lib/git*.ts"
  - "src/lib/editorConflict.ts"
  - "src/lib/editorGitGutter.ts"
  - "src/lib/popupPosition.ts"
  - "src/composables/useAnchoredPopup.ts"
---

# Git 実装ルール

`git` CLI ブリッジ（`git2` クレートは使わない）と worktree 連動。
実体は `src-tauri/src/git/mod.rs`、`src/stores/git.ts`、`src/stores/worktree.ts`、`src/components/panels/GitPanel.vue`、`src/lib/editorConflict.ts`。
diff タブは `git-diff.md`、ブランチグラフとコミットタブは `git-graph.md`。

## Git 統合
- `git` CLI 経由（WSL / Windows / macOS のいずれでも動く）。`git2` クレートは使わない
- Rust 側は `types.rs` の `git_args` が引数（`-c core.quotePath=false` と `-C <root>`）を組み、`ShellConfig::run*` が ShellConfig に応じて `wsl.exe git` / `git` を起動する（`git/mod.rs` の `run_git` / `run_git_network` / `run_git_raw_stdout` がその入口）。WSL で複数の git 呼び出しを 1 回の spawn にまとめる経路だけ、argv ではなく bash 行を組む `git_bash_prefix` を使う
- ステータスバーにブランチ名+ダーティ表示、クリックでブランチ切替
- ブランチ切替ドロップダウンのリモートブランチ対応（#197）: `git_branch_list` は `for-each-ref --format=%(refname) refs/heads refs/remotes` で `GitBranches { local, remote }` を返す（`<remote>/HEAD` は symbolic ref なので除外）。リモートは**ローカルに同名が無いものだけ**を「リモートブランチ」見出し配下に出し、選択で `git_checkout_track`（`git checkout --track origin/foo`）で追跡ローカルブランチを作って切替。ローカル名は git に決めさせる（`localBranchName` は表示判定専用のヘルパーで、リモート名にスラッシュを含む稀なケースでも checkout 側は壊れない）。既にローカルがある場合は `--track` が失敗するので `gitCheckout` にフォールバック。ドロップダウンを開くと `refreshRemoteBranches` が**既存の throttled `fetchInBackground`（60 秒間隔・focus 必須）**を再利用して fetch → 一覧再読込（開くたびに通信しない）。一覧は cached refs で即表示し、fetch は待たない。QuickOpen の `!` モードはローカルのみ
- Git パネル: ステージング/アンステージ、コミット、push/pull/refresh、コミットツリー展開
- **porcelain v2 の `2 ` 行（リネーム / コピー）はフィールドが 1 つ多い（#306）**。`1 ` が
  `<XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` の 9 個なのに対し、`2 ` はそのあいだに
  スコア（`R100` / `C75`）が入って 10 個で、最後が `<path><TAB><origPath>`（**新しい名前が先**）。
  `splitn(9)` で分けると 9 個目に「スコア + 空白 + パス」がまるごと残り、`R100 new.md` がファイル名になる
  - 誤ると**静かに壊れる**: 存在しない名前がパネルに並び、`git diff -- "R100 new.md"` が exit 0 の
    無出力を返すので空の diff タブが黙って開く。アンステージも exit 0 で何もしない
  - **アンステージは両方の名前を渡す。** 新しい名前だけを `git reset` すると、元の名前が
    「削除」としてステージに残り、新しいほうが untracked になる（実測）
  - `git show --pretty= --name-status` 側（`git_show_files`）は別の形（`R100\told\tnew`）で、
    **元の名前が先**（porcelain v2 の `2 ` 行とは逆）。`u ` 行はリネームを伴わないので 11 個で固定
- **リネームした差分は、片側だけの pathspec では出ない（#306）**。`git diff -- <新しい名前>` の
  ように絞ると git はリネーム検出を諦め、**名前を変えただけのファイルが「新規追加」として
  全行出る**。持っている情報が違うので、経路ごとに違う手を使う
  - 作業ツリー / index（`git_diff`）: `GitFileChange.origPath`（`parse_status` が拾う元の名前）を
    **pathspec にもう 1 つ足す**。作業ツリー側に元の名前はもう無いが、一致しない pathspec は
    無視されるだけなので、staged かどうかで分けない
  - コミット（`git_diff_commit`）: 元の名前を知らない呼び出し元（履歴タブ）があるので
    `git log --follow -p` で追う。親を持たない最初のコミットもそのまま扱える
    - **`--format=%H` を付けて、要求したコミットのものか確かめる**（`commit_patch`）。`git log` は
      pathspec に一致しないコミットを飛ばして遡るので、「そのコミットはこのパスを触っていない」
      場合に**祖先の差分**が返る（実測）
    - **`--no-show-signature` は `git log` を叩く 4 箇所すべてに要る**（`NO_SHOW_SIGNATURE`）。
      `log.showSignature=true` を設定していると、`git log` は検証結果を**標準出力の
      `--format` より前**に出すので、位置で読む側（`parse_log` / `parse_log_simple` /
      `commit_patch`）が丸ごと外れ、履歴もコミットの差分も空になる。`git diff` は影響を
      受けないぶん気付きにくい
    - **マージコミットだけは第 1 親との差分**。パスを絞った `git log` はマージを
      素通りして祖先へ遡るので、上の確認で弾かれて空になる。リネーム検出は効かない
      - **代償は、マージのファイルを開いたときだけ spawn が 2 回になること**（1 回目が作った
        祖先のパッチは丸ごと捨てる）。呼び出し元が親の数を知っていれば先に振り分けられるが、
        3 つのうち 2 つ（履歴タブ・アウトラインの履歴）が読む `git_log_file` の書式に `%P` が
        無く、そこへ通す配線のほうが高くつくので採っていない
      - **失敗を空に潰さないこと。** 「変更なし」と出して終わると「静かに壊れる」形になる。
        `~1` を持たない最初のコミットだけ `--root` で拾う
  - リネームが hunk を持たない場合の表示は `git-diff.md`
- 非 git リポジトリ対応（#156）: `git status` がエラーの時、`git_is_repo`（`git rev-parse --is-inside-work-tree`、非 repo でも Err にせず `false` を返す）で「リポジトリじゃない」を切り分け、`gitStore.isRepo=false` にして生の git エラーを出さない。GitPanel は専用ビュー（メッセージ + 「リポジトリを初期化」ボタン → `git_init`）を表示（VSCode 風）。init 後は status/log/remote を再読込
- コンフリクト（unmerged）表示: `parse_status` が porcelain v2 の `u ` 行をパースし `GitStatusResult.conflicted`（status は XY コード `UU`/`AA` 等）に格納。GitPanel 最上部の専用「Conflicts」セクションでパスを赤字（`--danger`）表示、クリックで作業ツリーのファイルをエディタで開く。SideBar の Git バッジ件数に conflicted を加算し、コンフリクト時は danger（赤）バッジ。エディタは `lib/editorConflict.ts`（CodeMirror ViewPlugin）でマーカー行（`<<<<<<<`/`|||||||`/`=======`/`>>>>>>>`）と各セクション本文を色分けハイライト（半透明オーバーレイで両テーマ対応）
- **エディタ上のコンフリクト解消（#223）**: 同じ `editorConflict.ts` に、各領域の上へブロック widget のボタン列（ours / theirs / 両方）と、`showPanel` の上部バー（件数＋ファイル全体の一括適用）がある
  - **パースは `StateField<Conflict[]>` に 1 回だけ**（`editorGitGutter.ts` の `diffField` と同じ形）。decoration・パネルの出し入れ・パネルの中身・widget が全部これを読む。この拡張は**全エディタタブに常時入っている**ので、素朴に書くと打鍵ごとに全行走査が 4 周する（コンフリクトの無いファイルでも）。走査は `doc.iterLines()` の 1 パスで、行ごとの `doc.line(i)`（木を毎回降りる）は使わない
  - `Conflict.lines` が領域内の全行と色分け種別を持つので、**decoration の構築はドキュメント全行ではなくコンフリクト行数に比例する**
  - **ボタンのラベルはマーカー行から取る**（`<<<<<<< HEAD` → 「HEAD を採用」）。無ければ「現在の変更を採用」に落とす
  - **diff3（`|||||||` あり）では ours の終端が `=======` ではなく base マーカー**。base セクションはどちらの側でもない
  - 置換は 1 トランザクションにまとめる（一括適用も `Ctrl+Z` 一回で戻る）。片側が空のときは直前の改行ごと消す（残すと空行が残る）
  - **保存もステージもしない**。`Ctrl+S` と Git パネルの担当のままにして、解消 → 保存 → ステージ → #222 の「続行」という既存の流れに乗せる
  - **ステージの導線は Conflicts セクションにある**（各行の Check ボタンと見出しの「すべて解決済みに」）。porcelain v2 の `u ` 行は `conflicted` にしか入らず、コンフリクト中のファイルは Unstaged 一覧に出ないため、ここが無いと Pike からステージできない（作業ツリーのマーカーを消しても index は unmerged のままで、`git add` するまで一覧に残り続ける）。マーカーが残っているファイルは `fs_read_file` で見て名前を挙げて確認する（そのままステージするとマーカーごとコミットされる）
  - 未完成の領域（`<<<<<<<` はあるが `>>>>>>>` がまだ無い＝編集中）は色分けだけして**ボタンを出さない**。丸ごと書き換えられる領域だけが対象
  - **読み取り専用の判定は `EditorState.readOnly`**。`EditorView.editable` は Pike が一度も設定しない別 facet（既定 true）なので、あれを見てもガードにならない
  - `WidgetType.eq` はオフセットを比較しない（上を編集するたびに全部の行がずれて、下の widget が毎打鍵で作り直される）。index とラベルだけを見て、クリック時に `conflictField` から現在の領域を読み直す
  - **ラベルは DOM 構築時に焼き込まれる**ので、UI 言語の切替に追随させるため `EditorTab.vue` が `conflictCompartment` で再登録する（他の設定と同じ compartment の流儀）
- **ファイルの右クリックメニュー（#309）**: 1 枚のメニューを CHANGES の staged / unstaged、
  Conflicts、コミット配下の 4 か所で共有し、`fileCtx.section` で出し分ける。**出せない項目は
  無効化ではなく出さない**（他のメニューと同じ流儀）
  - **操作の実体は行のホバーボタンと同じ関数を呼ぶ**（`discardFile` / `unstageFile` /
    `markResolved`）。untracked の破棄が `git checkout` ではなくファイル削除になること、
    ステージ済みの新規追加を外すときの確認、リネームの両方の名前を外すこと（#306）は、どれも
    そちらが持っている分岐で、メニュー側で書き直すと同じ分岐が 2 か所に散る
  - **コンフリクト中の行では「差分を開く」を出さない**。unmerged なパスに `git diff` を撃つと
    combined diff が返り、`diffParser.ts` が読めない。解消はエディタでやるもの（#223）なので、
    開く先は作業ツリーのファイルだけにする
  - **`.gitignore` に追加は untracked の行だけ**。追跡済みのファイルを書いても git は追跡を
    やめないので、出すと「押しても何も起きない項目」になる。`.git/info/exclude` を採らないのは、
    あれが手元だけの除外で、コミットして共有する側とは用途が違うため
    - **書く先は `activeRoot` 直下で、「リポジトリルート」ではない**。リポジトリのサブ
      ディレクトリをプロジェクトとして開いていれば、そのディレクトリの `.gitignore` に書く。
      git が返すパスも `-C <activeRoot>` からの相対なので、これで揃う（`git -C subdir status
      --porcelain=v2` が `deep/z.txt` を返すことを実測で確認）。worktree を切り替えている
      あいだはその worktree が基準
    - **1 行の作り方（ルート固定の `/` 前置・glob のエスケープ）と重複の判定は
      `lib/gitignore.ts` が正本**。あそこは純粋な計算だけで、IPC と再読込は
      `ctxAddToGitignore` の担当（`diffExpand.ts` と `DiffTab.vue` と同じ分け方）。
      理由はあのファイルの doc コメントを読むこと
  - パスの組み立ては `workingPath`（git は常に `/` を返すので `joinPath` でシェルの区切りへ
    揃える）。**素の文字列連結に戻さないこと**: 混ざった区切りのパスは fs watcher のイベント
    （完全一致で比べる）と噛み合わない
- **途中停止した操作の検出と再開（#222）**: `GitStatusResult.operation`（`GitOperation { kind, branch, step, total, stop, stoppedSha, stoppedSubject }`）を `git_status` の中で埋め、GitPanel 最上部にバナー＋続行 / 中止ボタンを出す。別コマンドにしないのは、10 秒ポーリング・StatusBar・worktree ストアが既に `git_status` を通っているため（2 つに分けると「競合あり」と「操作なし」が食い違いうる）。探索の失敗は握り潰す（`operation` のせいで status が Err になってはいけない）
  - **検出を条件で間引かない**: 「HEAD が detached、または競合あり」のときだけ探索する案は**素の `git pull`（マージ）の停止を丸ごと取りこぼす**。実測で、マージ競合停止は `# branch.head` が `main` のままで、署名失敗のマージに至っては競合 0・detached でない・`MERGE_HEAD` だけが痕跡という状態になる。代わりに探索を `git status` と同じ 1 往復に畳んである（WSL は `remote_urls_wsl` と同じ「`bash -c` で複数の git 呼び出しを 1 回の `wsl.exe` にまとめる」手口。定常コストは 1 spawn）
  - 状態ファイルは gitdir 配下にあるので、`git rev-parse --absolute-git-dir` 1 回で `.git` がファイルの linked worktree も通る。ただし **Windows 側は `<root>/.git` がディレクトリなら rev-parse を省く**（通常のリポジトリはこれで当たり、プロセス起動が 1 回で済む。WSL 側は既に同じ spawn の中なので分岐しない）。**パスのキャッシュは持たない**（ステートレス方針）
  - **存在判定に `fs::batch_read_files` を使わない**: あれは中身を trim して空を `None` に潰すため、`message` が「空」なのか「無い」のか区別できない。`commit-failed` の判定はそこに乗っている。WSL 側は `exists FS content` のレコードを `OP_STATE_FILES` の順で返す（`remote_urls_wsl` と同じ位置対応。名前は流さない）
  - `OP_STATE_FILES` は `(パス, 内容を読むか)` の表。ほとんどは「git が書いたか」だけが信号なので `cat` しない。とくに `BISECT_LOG` は bisect の 1 ステップごとに増えるため、読むと 10 秒ごとに全文がパイプを渡る
  - **どの種別にボタンを出すかは Rust が `can_continue` で返す**（`am` はメールボックス、`bisect` は good/bad が要るので対象外）。フロントの定数にすると、種別を増やしたときに更新漏れが型エラーにならず無言でボタンが消える
  - **`rebase-merge/interactive` は `-i` の判別に使えない**（素の `git rebase` でも作られる。実測）。rebase / am の区別は `rebase-apply/applying` の有無
  - `stop` の分類: 競合あり → `conflict`（`.git` から再導出せず、パース済みの `conflicted` を使う）/ rebase かつ競合なしかつ `message` も `stopped-sha` も無い → `commit-failed` / それ以外 → `stopped`。**マージ系に `commit-failed` の特別扱いは要らない**（`git merge --continue` が `MERGE_MSG` でコミットし直すので、署名失敗でも通常の続行で復帰する。実測）
  - **復帰コマンドはターミナルタブで走らせる**（`runCommandTab`、`cwd=activeRoot`・`keepOnError: true`・`onExit` で status/log 再取得）。`git rebase --continue` は `$EDITOR` を開き、署名は 1Password の承認ダイアログを伴い、バックエンドの git 呼び出しは TTY 無し・stdout 破棄・30 秒タイムアウトでどれも通らない。`--abort` も同じ経路（失敗しうるものをバックエンドに回すと、生の stderr がパネルを潰す）
  - **コンフリクトが残っている間は「続行」を押せない**（`conflicted` が非空なら disable ＋ ツールチップ、store 側にも同じガード）。どの `--continue` も未 merge のパスがあると `You must edit all merge conflicts and then mark them as resolved using git add` で即座に拒否するので、押せるようにしておくとユーザーをそのエラーに突き当てるだけになる
  - **コマンドの連結は `types/tab.ts` の `chainOnSuccess` を通す**: **Windows PowerShell 5 には `&&` が無く**（パースエラー。pwsh 7 / cmd / bash 系にはある）、`;` は失敗しても次を走らせてしまうので、あのシェルだけ `; if ($LASTEXITCODE -eq 0) { … }` に落とす。復帰は「コミットし直してから続行」の 2 段なので、コミットが再び失敗したら続行してはいけない
  - **`git commit -C <SHA>` の誤爆ガード**: SHA は `rebase-merge/done` の**末尾行**から取る（競合停止では todo が空になるため、todo の先頭行は当てにできない。両方の停止で実測）。`done` は追記書き込みなので末尾行が不完全なことがあり、`pick`/`reword`/`edit`/`squash`/`fixup` で始まり SHA が hex であることを確認する。`exec` / `break` の停止ではコミットは既に成功しているので**ボタンを出さない**（出すと他コミットの author・日時・メッセージを被せた偽コミットを黙って作る）。押下時は確認ダイアログに SHA・件名・実行コマンドを出す
- `git_pull` だけ失敗時に stdout も返す（`CONFLICT (content): …` は stdout 側で、共通の `spawn_stdout` は stderr しか残さない）。`spawn_stdout` 自体は触らない（全 git コマンドのエラー文が変わる）
- **`gitStore.error` はパネル全体を置き換えない**: `status` があるときはセクション上部のストリップとして出す。パネル本体ごと差し替えると、pull が止まった瞬間に競合一覧もコミット欄も消える。`pull()` は失敗時も `refreshStatus` / `refreshLog` を呼ぶ（呼ばないとバナーと競合一覧が次のポーリングまで 10 秒出ない）。**エラーの代入は refresh の後**（`doRefreshStatus` は成功時に `error` を null に戻すので、先に入れると消える）
- SideBar の git マーカー（ahead/behind のドット）は、操作が止まっているときは赤い `!` を優先表示する。署名失敗の pull は競合 0・変更件数 0 なので、パネルを閉じているとバッジにもドットにも出ない
  - **ahead/behind は文字ではなくドット**（`MarkerInfo.kind`）。`↑↓` は 11px で見分けにくい。向きと件数はツールチップ（`title`）で読む
- ahead/behind: `git status --porcelain=v2 --branch` の `# branch.ab` 行をパース。GitPanel コミットボタン下にテキスト表示、SideBar の pull/push ボタンを primary スタイルにする
- コミットログは `%B`（全文）取得、一覧は1行目のみ表示、ホバーで全文ツールチップ
- **日時は committer date（`%cI`、#396）。author date ではない。** git に「push した時刻」は
  無く、持っているのは変更を書いた時刻（author date）と、コミットオブジェクトを作った時刻
  （committer date）の 2 つだけ。rebase / cherry-pick / amend で更新されるのは後者なので、
  **その履歴に載った時刻**としてはこちらが近く、SourceTree の既定の Date 列とも揃う。
  `--date-order` の並びも committer date 基準なので、グラフの並びと表示が食い違わない。
  **戻すなら 3 か所とも戻すこと**（`git_log` / `git_log_file` / `git_log_file_lines`）。
  片方だけだと、同じコミットが Git パネルとファイル履歴で違う時刻に見える
- ツールチップ・コンテキストメニューの位置決め（#204）: 高さが中身次第で決まるので、**hidden で描画 → 実測 → 配置**の順に置く。配線は `composables/useAnchoredPopup.ts`（`useTemplateRef` で受けた要素を `nextTick` 後に計測し、`style` に位置と `visibility` を返す）、幾何は `lib/popupPosition.ts`（`placeNearAnchor` = 上優先・入らなければ下、`clampToViewport` = カーソル位置を画面内へ）。測るまで hidden なのは仮位置に 1 フレーム出てから飛ぶのを防ぐため（`display: none` は測れず、`opacity: 0` はクリックを拾う）。ウィンドウより高いメッセージは CSS の `max-height` で頭を残して切る（`pointer-events: none` なのでスクロールできない）。**CSS の anchor positioning は採らない**: Chromium 125+ が要るが Tauri は WebView2 のバージョンを固定できず、失敗しても例外ではなく「変な位置に出る」だけで気付けない。カーソル位置に開くメニューは**全部この composable を通す**（GitPanel のコミット/ファイル、FileTreePanel、TabPane のタブ/管理者、SideBar の pull-push、EditorTab）。**新しいメニューを足すときも同じ**（生の `clientX/clientY` を `style` に流すと画面端で見切れる）。SideBar の pull/push メニューだけは `.sidebar.ui-zoom` の内側にあり、UI ズームが 1 以外だと clamp が概算になる（座標系が zoom 倍される。既定の 1 では厳密）
- git log フォーマット区切り: ASCII Unit Separator (`%x1f`) + Record Separator (`%x1e`) を使用（NUL だと `%D` が空のコミットでレコード区切りと衝突するため）

## リモートに触る 3 つ（fetch / pull / push、#384）

**バックエンドの git には TTY が無い。** だから鍵にパスフレーズが付いていると、ssh が
入力を待ったまま 30 秒のタイムアウトで殺される。通るのは `run_git_network` の 1 本で、
そこだけが次の 3 つを足す。**残りの git 呼び出しには足さない**（ローカルの操作に ssh は
要らないし、`git status` は 10 秒ごとに走る）。

- **`SSH_AUTH_SOCK` を運ぶ**（`shell_probe::ssh_auth_sock`）。非対話の `bash -c` は rc の
  export を継がないので、**ターミナルでは打てるのにバックエンドでは agent に届かない**。
  `agent-hook.md` が `CLAUDE_CONFIG_DIR` について書いているのと同じ形で、同じ `-lic` の probe に
  相乗りしている。**WSL では `Command::env` が distro の中へ届かない**ので、`WSLENV` に
  名前を並べる（`types::wslenv_with` / `command_env`）。**運ぶのは POSIX のシェルだけ**
  （`env_names`）: Windows のシェルは Pike のプロセス環境をそのまま継ぐ。Git Bash で
  `.bashrc` から agent を起こしている人には届かないが、そこは probe が cmd 構文なので
  別の話になる
- **`BatchMode=yes` を足す**（`ssh_config_arg`）。ssh を「聞かずに失敗する」に倒すと、
  待ち込みが即座の失敗に変わり、失敗の文字列で資格情報待ちを見分けられる
  （`AUTH_MARKERS`）。**利用者の `core.sshCommand` は潰さない**: 読んでから末尾に足す
  （`compose_ssh_command`）。Windows の `ssh.exe` を指している構成が実在する。
  **覚えるのは確かめられた答えだけ**（終了コード 0 か 1）: 冷えた WSL のタイムアウトを
  覚えると、利用者の設定を 5 分のあいだ素の `ssh` に落とし、それ自体が認証を失敗させる。
  **`core.sshCommand` が無く、ssh の起動を env で決めている構成には手を出さない**
  （`ssh_set_by_env`）: `GIT_SSH_COMMAND` があれば `-c` は読まれず、`GIT_SSH` は `-c` に
  負けるので、渡すと PuTTY / plink の転送を素の `ssh` に差し替えてしまう
- **`GIT_TERMINAL_PROMPT=0`**。https のリモートでも git 自身が聞きに行かないよう揃える。
  資格情報ヘルパー（GCM など）はこれでは止まらないので、Windows の利用者はそちらが聞く

**待ち込む形は環境依存なので、塞ぎ方も環境に依らないものを選んである。** 実測した 2 つ:
`wsl.exe` 越しでは stdio を 3 つとも繋ぎ替えても `/dev/tty` が開ける（＝`spawn_piped` の
stdin を閉じるだけでは止まらない）が、`ssh-keygen` は askpass を選んで即座に失敗する。
どちらに落ちるかはシェルの起こし方と `ssh-askpass` の有無で変わる。

**代償**: GUI の askpass でパスフレーズを出せていた構成では、そこが出なくなる。代わりに
下の「ターミナルで実行」で入力する形に揃う。

**`SSH_ASKPASS=<存在しないパス>` ＋ `SSH_ASKPASS_REQUIRE=force` に置き換える案は採らない。**
`core.sshCommand` を読まずに済む（＝上の読みとキャッシュが丸ごと消える）ぶん魅力はあるが、
(1) `SSH_ASKPASS_REQUIRE` は OpenSSH 8.4 以降にしか無い、(2) 存在しない askpass を指すのは
同じ代償を回りくどく払う形、(3) plink（`GIT_SSH`）はどちらの手も無視するので、あちらの
待ち込みはどのみち塞げない。`BatchMode` は古い ssh にもあり、実測してある。

### 入力する場所はターミナルタブ

失敗が資格情報待ちだったときだけ、Git パネルのエラーの帯に「ターミナルで実行」を出す
（`GitNetworkResult.command` を `gitStore.runAuthCommand` が走らせる）。`runRecovery`
（#222）と同じ理由でバックエンドへ戻さない。

- **失敗を `Err` ではなく値で返す**（`FileReadResult.too_large` と同じ形）。エラー文字列の
  綴りを Rust と TS で取り決める形は採らない。**3 つとも同じ形**にしてあり、「背景の取得だから
  黙る」は呼び出し側（`fetchInBackground`）の方針として持つ
- **「資格情報が要る」の真偽値は持たない**（`command` の有無がそれ）。2 つ持つと「真なのに
  ボタンが出ない」という説明できない状態を作れる
- **走らせる 1 行は Rust が組む**（`terminal_command`）。オプション → git のフラグの対応は
  `PullOption` / `PushOption` が持っているので、TS 側で組み直すと必ずずれる
- **鍵が拒否されたときは `ssh-add` を前に置く**（agent に届いていると分かっているときだけ）。
  **パスフレーズを保持するのは agent**: Pike はパスフレーズを受け取らないし、どこにも書かない。
  素の `git pull` だけを走らせると ssh がその 1 回のために聞いて捨てるので、次の pull でまた聞かれる
- **`error` を直に `null` にしないこと**（`stores/git.ts` の `clearError`）。ボタンはその失敗に
  紐づくので、片方だけ残ると押せる嘘のボタンになる
- **ポーリングの成功では下ろさない**（`clearTransientError`）。10 秒ごとの `git status` が
  通っても pull が失敗した事実は変わらないのに、素の `clearError` を置くと**入力する唯一の
  入口が押される前に消える**。下りるのは次の pull / push を始めた時点か、ボタンを押した時点
- **ステータスバーの知らせからも入口へ導く**（`git.runInTerminalHint`）。知らせはアプリ全体
  （パレットやサイドバーから pull できる）なのに、押せるのは Git パネルの中だけなので、
  そこまで書かないと開けば拾えることに気付けない。**`statusMessage` にボタンを持たせるのは
  採らない**（あの器は今のところ文言だけで、入口を 1 つ増やすために作りを変えることになる）
- **root に紐づく状態のスタンプが、このストアで 3 つ目**（`remoteResolvedFor` #353、
  `logScope` #374 に続く）。本筋は `activeRoot` の watcher を 1 本置いて root 依存の状態を
  まとめて捨てることだが、「root が変わった」の入口が App.vue の watcher と
  `setActiveWorktree` に割れているので、そこを 1 つにするところから。**次にスタンプを
  足したくなったら、先にそちらを畳む**

### パスフレーズは Pike のダイアログで受け取る（#386）

鍵が agent に入っていないときは、**帯を出す前に伏せ字の入力欄を開く**。受け取った値を
`ssh-add` へ中継し、失敗した操作をやり直す。実体は `src-tauri/src/ssh_agent.rs`
（**判断の正本はあのファイルの doc**）で、ここには規範だけ置く。

- **聞くのが先、帯は断られてから**（`handleNetworkFailure`）。利用者がしたいのは
  「pull を通すこと」で、要るものはパスフレーズ 1 つと分かっている。先に帯を出すと、
  エラーを読んでボタンを探す手間を挟むことになる
- **聞くのは利用者が押した 1 回につき最大 1 度**（`keyAsked`。やり直しの側が真を渡す）。
  無いと、鍵は入るのに（`identity_for` が別の鍵を当てたので）pull が通らない構成で
  **入力欄が延々と出続ける**
- **保持するのは引き続き agent で、Pike ではない。** 受け取った値は子プロセスの標準入力へ
  一度流すだけで、ディスクにも設定にも書かない。器（`inputValue`）にも残さない
  （`secretDialog`）。**秘密を運ぶ経路は `types::run_posix_line_stdin` の 1 本**で、
  **行そのものは argv に出る**のでそこへ埋めないこと
- **対象は POSIX のシェルだけ。** Windows のシェルのプロジェクトは 1Password や Windows の
  agent が鍵を持つので、`ssh-add` を走らせる話にならない
- **ターミナルで実行する道は残す。** ホスト鍵の確認など、パスフレーズ以外を聞かれる
  ことがある。**2 つのボタンは同じ結末に揃える**（`failure.addKeyRetry`）: あちらは
  `ssh-add; git pull` を走らせる＝やり直しまで含むので、ダイアログ側だけ「鍵は入ったが
  何も起きない」で終わると、隣り合ったボタンで結果が違うことになる
- **`can_add_key` は `command` の言い換えではない。** あちらは「資格情報が要るか」、
  こちらは「**どの**資格情報か」。ホスト鍵の確認や https の利用者名でパスフレーズを
  聞いても何も進まない
- **利用者が起こした agent には手を出さない。** Pike が起こすのは 1 つも届かないときだけで、
  止めるのも自分で起こしたものだけ（`shutdown_all`）

## Git worktree 連動
- `git_worktree_list` コマンド（`git worktree list --porcelain` をパース）が `{ path, branch, head, isBare, isDetached, isMain }[]` を返す。bare クローン構成では bare エントリを main 扱いせず**最初の非 bare** を `isMain` とし、`prunable`（ディレクトリ消失）worktree は一覧から除外
- **参照ルートの単一の真実**: `stores/project.ts` の `activeRoot`（非 null computed = `activeWorktreeRoot ?? currentProject.root ?? ''`）。file tree / git / search / tasks / docker、およびエディタの git 操作（diff ガター・History・定義ジャンプ・MD リンク解決）はすべて `project.root` ではなく `activeRoot` を参照する。root 相対操作で残る `project.root` 直参照は worktree 追従漏れのサイン
- **「これから開くもの」も追従する（#269）**: 新規ターミナルの cwd（`useAppActions.openTerminal` / `useCliOpen` / セッション復元）・アップロード先（`.pike/uploads`）・usage の集計 root。**プロジェクトに固定しない**: どれも受け手はターミナルやエージェントの cwd で、そちらが worktree に居るなら基準が食い違う。固定すると (1) 貼り付いた `.pike/uploads/…` の相対パスがエージェントに届かない、(2) usage は cwd と root の一致で集計するので、worktree で作業しているあいだ数字が 0 になる
- **走っているターミナルの基準は動かさない**: ドロップの相対パスはそのタブを開いた cwd を基準にする。ここで `activeRoot` を読み直すと、あとから worktree を切り替えたときに、走っているシェルへ届かないパスを送る
  - **`saveUploadFile` の置き場も同じ理由で呼び出し側が決める**（`root` 引数）。ターミナルはそのタブを開いた cwd。ここだけ `activeRoot` にすると、切り替え前から開いているタブに貼ったファイルが、そのタブからは見えない場所に置かれる。**ターミナルはシェルの現在地（OSC 7）を使わない**: `cd` するたびにその先へ `.pike/` を作ることになり、置き場がリポジトリ内に散らばる
  - `.pike/` を作る側は **`lib/pikeDir.ts` の `ensurePikeDir`** を通す（`.gitignore` の設置込み）。手順を呼び出し側ごとに持つと複製になる
  - **usage の追従は `createUsageStore` が持つ**。工場側で `activeRoot` を watch し、取得中に root が変わったら結果を捨てて取り直す（`refreshGuard` は取得のあいだ立ちっぱなしなので、切り替え側から叩いても弾かれる）。**切り替え側から名指しで叩かないこと**: 「どの usage が root に依存するか」の知識が 2 箇所に分かれ、store を増やしたときに片方だけ漏れる。レートも同じ経路で追従する（取り直しても Rust のキャッシュが返す）
- **追従させないもの**: worktree 一覧の取得（`gitWorktreeList` は main から引く）と `git.ts` の remoteUrl 記録（main のときだけ書く、が仕様）
- `stores/worktree.ts`: worktree 一覧・`setActiveWorktree(w)`（`isMain` フラグで null/パスを決定。文字列一致に依存しない）・focus 連動ポーリング（`gitStore.status` が非 null の git リポジトリのみ。同一ウィンドウ内ターミナルでの `git worktree add` を反映、古い load 結果は projectId で stale ガード）
- ステータスバーの worktree セレクタ（`FolderGit2`、worktree が 2 つ以上の時のみ表示）。選択で 5 パネル + エディタを再読込
- fs watcher は App.vue の `watch(activeRoot)` 単一所有で再ポイント（worktree 切替・プロジェクト切替の両方をカバー。リポジトリ外の worktree でも更新を取得）
- 切替単位はウィンドウ（プロジェクト）ごとに 1 つ。起動時は常に main worktree（`activeWorktreeRoot=null`）から開始、セッション非永続。タブ切替による自動追従は未実装（agent を root で起動し内部で worktree を選ぶ運用では cwd ベース検出が効かないため手動セレクタを主軸とする。将来 agent タブ常用時に再検討）
