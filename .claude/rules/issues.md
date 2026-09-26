---
paths:
  - "src-tauri/src/issues/**"
  - "src/stores/issues.ts"
  - "src/components/panels/IssuesPanel.vue"
  - "src/components/tabs/IssueTab.vue"
  - "src/lib/issue*.ts"
  - "src/composables/usePanelAvailability.ts"
---

# issue パネル（#278）実装ルール

GitHub の open issue（と、切り替えて open PR。#413）を番号の降順に出す。実体は `src-tauri/src/issues/mod.rs`、
`src/stores/issues.ts`、`src/components/panels/IssuesPanel.vue`。

## 取得と検出
- **`api.github.com` を直接叩かない。** CSP の緩和（`connect-src`）とトークンの保管が要る。
  `gh` に寄せれば認証は丸ごと向こうの持ち物で、Pike はトークンに触らない。マニュアルタブが
  `raw.githubusercontent.com` から生の Markdown を取って自前で描いているのと同じ発想で、
  **issue のページ自体は埋め込めない**（GitHub は `X-Frame-Options: deny` と
  `frame-ancestors 'none'` の二重で拒否する）
- **並びは番号の降順で固定する（#357）。** 更新順にすると、誰かが触るたびに行が動いて追えない。
  **並び替えの修飾子を渡さない**（`gh issue list` の既定が作成順の降順）。**判断の実体は
  `issues_list` の doc が正本**: `--search` を足すと検索 API 側へ回ること、番号と `createdAt` が
  割れるので `parse_list` が並べ直すこと、`--limit` がサーバー側であるがゆえの代償（古い issue が窓から落ちる）
  - **ツリー表示（既定）では、この並びのままにはならない。** `buildIssueTree` が子を親の位置へ
    引き寄せるため。番号の降順の列がそのまま出るのはフラット表示のほう
- **未インストール・未認証・権限なしを「0 件」に見せない**（`ProviderRun.error` と同じ考え方）。
  どれも結果が空になるので、区別が付くよう `IssueListResult.error` に理由を入れる。**実行した
  行もそこへ畳む**: 成功時にも返る別のフィールドにすると、IPC が落ちた経路（フロントの catch）
  だけ古い行が残る。1 行の長さは `types.rs` の `first_line` が 200 文字で切る（`diagnostics` と共有）
- **`gh` の検出は `issues_gh_available`。** 探し方は `ShellConfig::has_command`（`vue-preview` の
  検出と共有）で、`--version` が存在確認を兼ね（`which` を別に叩かない）、
  **一覧と同じ `run_shell_line` を通す**（WSL では `WSL_EXTRA_PATH` が前置されるので
  `~/.local/bin` の `gh` も見つかる。素の `run` で探すと、探し方と走らせ方が食い違って
  「検出できないのに手で打てば動く」になる）。認証までは見ない（`gh auth status` をもう 1 回
  起こすことになるうえ、切れていることは一覧の `error` で分かる）
  - 答えは **`IssuesState` がシェルの導入単位でプロセスに 1 つ**持つ（`SearchState.detected` と
    同じ形）。Pinia のストアはウィンドウごとなので、フロントだけで覚えると同じリポジトリを
    N 枚開いたときに `gh --version` が N 回、WSL では `wsl.exe` の起動が N 回になる。
    **同じ導入単位の probe は 1 本に畳む**（`cache::ProbeEntry::found`。#315）: 畳まないと、
    前回のセッションを復元して複数のウィンドウが同時に立ち上がるときに全部が miss する。
    **キーごとに分かれているので、別の distro を見に来た者は待たない**（1 本の `Mutex` を
    probe 中も握ると、冷えた distro の `gh` を待つあいだ全部が止まる）
  - **これは「検出のためだけに起動時へ `wsl.exe` を足さない」（`os-integration.md`）の例外**。
    `search` のバックエンド検出は初回の検索まで遅延できるが、こちらは**アイコンを出すか
    どうかが答えに依存する**ので、パネルを開くより前に答えが要る。origin が GitHub だと
    分かってからしか走らないので、対象は GitHub のプロジェクトのウィンドウだけ
  - **覚えるのは「見つかった」だけ**（Rust もフロントのラッチも）。見つからなかったほうを
    焼き付けると、時間切れになった 1 回（WSL の冷えた起動で普通に起きる）で
    パネルが消え、**アイコンもパレットも出ないので更新ボタンに手が届かない**＝再起動しか
    手が無くなる。見つからないあいだは watcher が発火するたび（プロジェクト切替・シェル
    変更）に聞き直すので、`gh` を入れれば次の切り替えで出てくる
  - **`force` の逃げ道も残す。** 更新ボタンがその入口で、**`gh` が見つかっていないときだけ**
    再検出する（見つかっているのに probe すると、一覧の前に外部プロセスをもう 1 本
    起こすだけになる）
- **走っている検出はシェルのキーで見張る**（`stores/shellProbe.ts`）。真偽値のガードだと、A の
  probe（最長 10 秒）の最中に B へ切り替えたとき、B の watcher が A の Promise を待ったうえで
  A の答えを B のキーで焼き込む。以後 B は一度も probe されず自己回復しない。`search` の rg・
  この `gh`・エージェント検出の 3 つがこのファクトリを共有する（#275）
- **`loading` は「古い取得は下ろさない・`clear()` が下ろす」で分ける。** 取得中にプロジェクトを
  切り替えると、飛んでいる応答は seq で捨てられるぶん下ろす者が居なくなり、次の
  `ensureLoaded` が「取得中だから」で弾かれて空のまま座る。逆に古い取得に下ろさせると、
  切り替え後に走り始めた取得の最中にスピナーが消える

## パネル
- **「使えるか」は `composables/usePanelAvailability.ts` の 1 箇所**（origin が GitHub かつ
  `gh` がある）。**アイコン列の行に述語を置かないこと**: パネルへの入口は 4 つあり
  （アイコン・`pike:activePanel` からの復元・パレットの `> …`・`panelIssues` アクション）、
  アイコンだけ隠すと残り 3 つから「使えません」しか出ないパネルが開く。`lib/shortcuts.ts` には
  置けない（`stores/project.ts` から import されるので循環する）ので、`APP_ACTIONS` の行は
  `panel` で「どのパネルか」だけを言い、可否は読む側が composable に聞く
  - **`isGitHub` は永続化済みの `project.remoteUrl` を先に見る**。`gitStore.remoteUrl` は
    `git remote get-url` の往復が終わるまで null なので、そちらだけだとアイコン列が起動から
    数百 ms 遅れて増え、一度リフローする。git 側は補正役（リモートを付け替えたら勝つ）
  - **述語は 2 つある（#353）**: `isPanelAvailable`（今そのパネルを出してよいか）と
    `isPanelRuledOut`（**使えないと確定した**か。「使える」の否定ではない）。**開いている
    パネルを逃がす判断は後者**で、理由はあの関数と `stores/issues.ts` の `ruledOut` の隣が正本
    - 逃がす場所はサイドバー（`activePanel` の持ち主）で、**覚えている選択は書き換えない**
      （`fallbackPanel`。人が選んだわけではないため）。監視するのは判定そのもので、
      プロジェクトの id ではない
  - それでもパネル本体は自分で `visible` を見る。到達経路が上のとおり複数あるので、
    見ないと GitHub でないプロジェクトで `gh issue list` が走る
- パネルのヘッダの更新ボタンは **`IconDef.refresh`（`SideBar.vue` の表）** から出す。
  `badge` / `marker` と同じ器で、パネルごとに書き写さない。**右側の
  コントロールは 1 つの `.header-actions` にまとめる**（`.panel-header` が
  `justify-content: space-between` なので、兄弟が 3 つ以上になると隙間が開く）
- **行のクリックは GitHub のページをブラウザのタブで開く**（#379）。コメントやラベルの操作は
  GitHub でするので、最初からそちらを開けば行き来が減る。issue タブは右クリックメニューの
  「簡易表示で開く」に残した（GitHub にログインせずに軽く読みたいとき用）
- ブラウザへ出るのはタブ右上のボタンと、ヘッダの「+」（新規作成）だけで、どちらも
  `openUrlWithConfirm`（GitPanel のコミットリンクと同じ規約。StatusBar のリポジトリリンクは
  #368 からブラウザのタブで開くので、この規約の対象外）。
  **パネルの行のクリックは確認を挟まない**: Pike の中でタブを開くだけなので、外部 URL を
  開く規約の対象外
- **ラベルは色のドットだけにする。** パネルの既定幅は 250px で、名前を並べるとタイトルが
  隠れる。名前は行のツールチップに畳む（ドットだけでは何のラベルか読めないので、行の情報を
  1 箇所に揃える）
- 表示の整形（相対時刻・ツールチップ・ラベル色）は**一覧そのものを入力にした番号引きの
  computed に畳む**（`formatted`）。**絞り込みにも木の形にも依存させないこと**: 絞り込み欄は
  同じコンポーネントの `v-model` なので、依存させると打鍵のたびに全行の日付整形と色の検証を
  やり直す（描く行のほうは木と畳み具合で毎回変わるので、そちらを入力にすると畳んだ意味が
  無くなる）。相対時刻は `lib/paths.ts` の `relativeDate`、ラベル色の綴りの検証は
  `projectColorValue`（任意の CSS 値を style バインドへ通さない規則はあそこが持っている）

## PR の一覧（#413）
- **issue と混ぜず、パネル上部のタブで切り替える**（`issuesStore.kind`。`pike:issues-kind` に
  覚える＝`pike:issues-view` と同じ扱い）。タブの見た目は `theme.css` の `.panel-tabs` /
  `.panel-tab` をアウトラインと共有する
- **取得は `issues_list` の `kind` で分けるだけ**（`ListKind`）。PR も `IssueSummary` で運び、
  片方にしか無いフィールド（issue の `parent`、PR の `isDraft`＝`draft`）だけが違う。
  **`--json` のフィールドは種類ごとに要求する**（`ListKind::list_line`）: `gh pr list` は
  `parent` を、`gh issue list` は `isDraft` を知らず、渡すとエラーで落ちる
- **取得の状態（一覧・`error`・`loading`・`loaded`・seq）は種類ごとに持つ**（`stores/issues.ts` の
  `KindList`）。1 本を共有すると、issue の取得中に PR へ切り替えたとき PR の `ensureLoaded` が
  「取得中だから」で弾かれ、issue の応答が来ても PR を取りに行く者が居ない。`load` は呼んだ
  時点の種類に固定して書き込む。`clear()` は両方を捨てる。更新ボタンは表示中の種類だけ
- **CI の状態は一覧と同じ `gh pr list` で取る**（`statusCheckRollup`）。`gh` の起動は増えないが、
  取得は遅くなる（実測、`--state all --limit 50` で約 0.8 秒 → 約 4.4 秒）。後から別に取る形より
  起動 1 回を選んだ（利用者の判断）。**Rust 側で 1 値にまとめて返す**（`summarize_checks` と
  `CheckState`。並びが優先順位で、失敗 > 実行中 > 成功）: 生の配列は 50 件で約 86KB あり、
  行に出すのはアイコン 1 つなので運ぶ理由が無い。`CheckRun` と `StatusContext` の 2 つの形が
  混ざって来る点は `GhCheck` の doc
- PR は親子を持たないので**常にフラットで描く**。**「今ツリーか」は `treeView` の 1 つ**で、行・
  字下げの枠・全展開ボタンがこれを読む（`view` を直に読むと、好みが `tree` のまま PR へ切り替えた
  ときに字下げの空きが残る）。ツリー / フラットのボタンも PR では出さない
- **種類で変わる文言は `lib/issuePrompt.ts` の `ISSUE_KIND_TEXT` の表 1 つ**（🤖・右クリック・空表示）。
  呼び出し側に `isPr ? a : b` を散らさない。🤖 と「コピー」は PR では「マージしたいのでレビューして」で、
  文面は `issueAgentPrompt`、注入は `injectIssuePrompt`（どちらも種類を受け取る）。**簡易表示（issue タブ）は PR にも出す**:
  `gh issue view` は PR の番号でも本文と会話のコメントを返す（実測。レビューのコメントと差分は
  載らない）。ヘッダの「+」は issue のときだけ（`newIssueUrl`）
  - **issue タブの 🤖 も PR ならレビューの依頼を送る。** タブに種類は持たせず、`detail.url` が
    `/pull/N` かで見分ける（`IssueTab.vue` の `ownUrl`。本文のリンクの判定と同じ解析を共有する。本文の `#123` から PR を開いた場合も同じ）

## sub-issue の木
- **木は `parent` だけで組む**（`lib/issueTree.ts` の `buildIssueTree`）。`gh` は
  `parent` / `subIssues` / `subIssuesSummary` の 3 つを `--json` で返すが、**`subIssues` は
  一覧に載っていない子（closed・取得件数の枠外）も返す**ので、使うと一覧と木で件数が
  食い違う。`parent` を上向きに辿るだけなら、出てくるのは必ず取ってきた一覧の中のものになる。
  フィールドを 1 つ足す代償は小さく（open 50 件で約 0.2 秒）、spawn も IPC も 1 回のまま
  - **親が一覧に居ない子はトップレベルに出す。** そこで隠すと「絞り込んでいないのに
    見えない issue」ができる
  - **絞り込みでは一致した issue の祖先を残す**（親が消えると、子がどこにぶら下がっていたか
    読めなくなる）。**フラット表示では足さない**: 木が無い以上、一致していない親が混ざる
    理由が無い
  - **輪の扱いを知っているのは `indexIssues` だけ。** `parent` は外から来る値なので輪に
    なりうる。**輪に参加する辺をそこで切って**、以降は普通の森として扱う（`buildIssueTree` の
    遡りも走査も、`issueParentNumbers` もガードを持たない）。経路の Set で止めるだけだと、
    輪の全員が根から到達できず「絞り込んでいないのに issue が数件消える」という気付きにくい
    壊れ方になる
  - **畳んだ状態は永続化しない。** issue の番号は増え続けるので、覚えると死んだ番号が
    溜まる。全展開 / 全畳みのボタンが 1 回で戻せる（`tasks` の折り畳みを覚えているのは、
    キーがファイル名で数も増えないため）。ツリー / フラットの選択だけは好みなので
    `pike:issues-view` に持つ（マシンローカル・プロジェクト共通）

## issue タブ
- **1 件を読み取り専用で読むのは issue タブ**（`tabs/IssueTab.vue`、`issues_view`）。マニュアルタブと同じ
  位置づけの読み取り専用で、書き込み（コメント・クローズ・作成）は持たない
  - **描画・外部画像・リンクの横取りの判断は `IssueTab.vue` の doc コメントが正本**。要点だけ:
    見た目は `theme.css` の **`.md-body` / `.md-page` / `.md-toolbar` / `.tool-btn` / `.spin`** を
    マニュアルタブと共有し、**本文の中のリンクは必ずクリックを横取りして止める**（素のままだと
    WebView が**アプリごと**移動し、全タブ・PTY・未保存のバッファが確認なしに消える）
  - **`#123` は別の issue タブへのリンクにする**（`lib/issueRefs.ts` の marked 拡張）。GitHub
    側の変換なので `gh` が返す本文には残っておらず、自前で拾う必要がある。コードスパンと
    コードブロックは marked が先に取るので自動的に除外される。同じリポジトリの issue / PR の
    **URL も同じ扱い**にする（marked が裸の URL を自動リンクするので、本文には両方の書き方が
    混ざる）。基準は `detail.url` から導く（ストアに聞くと、タブがパネルの状態に依存する）
  - **更新に失敗しても読めていた中身は消さない**（パネルのエラー帯と同じ扱い）。開き直しても
    `addIssueTab` は同じタブを返すので、消すと戻す手が無くなる
  - **番号だけで dedupe しない**（`addIssueTab`）。issue の番号はリポジトリごとに 1 から
    振られるので、所有プロジェクトも見ないと、A で #12 を開いたまま B の #12 を押したときに
    パーク中の A のタブが `activeTabId` になり、タブバーには何も出ないのに中身だけ A のものが
    見える。パスで dedupe する種別も distro 違いの WSL プロジェクトでは同じ絶対パスを持ちうる
    が、そちらは同じファイルを指しているので実害が無い
  - **セッションに残さない。** 中身は `gh` を叩き直さないと得られず、復元のたびに外部
    プロセスが起動することになる（`snapshotSession` が terminal / editor / browser だけを拾う）
  - 題名は取得後に **`tabStore.setTabTitle`** で入れる（開く時点では番号しか分からない）。
    直に代入しないこと: あちらの「変わったときだけ書く」ガードを飛ばすと、更新のたびに
    セッションの書き出し（`project.json` の全量書き直しと全ウィンドウへの broadcast）が走る
  - **相対時刻を markdown の computed に混ぜない。** `relativeDate` は `t()` を通るので、
    混ぜると UI 言語を切り替えるだけで全コメントの markdown を組み直すことになる（#264 で
    パーク中のタブも生きているので、別プロジェクトのぶんまで走る）
  - **失敗の形が一覧と違う**（`issues_view` は `Err`、`issues_list` は値の中の `error`）。
    あちらは「0 件」と区別が付かないので理由を値に載せるが、タブは中身が無ければ何も
    出せないので、呼び出し側が空と区別する必要が無い
