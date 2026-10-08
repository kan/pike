---
paths:
  - "src-tauri/src/ci/**"
  - "src/stores/ci.ts"
  - "src/components/panels/CiPanel.vue"
  - "src/lib/ci*.ts"
  - "src/types/ci.ts"
---

# CI パネル（#457）実装ルール

CI の実行（run）を新しい順に出し、再実行・中止・エージェントへの調査の指示を出す。対象は
GitHub Actions と CircleCI。実体は `src-tauri/src/ci/mod.rs`、`src/stores/ci.ts`、
`src/components/panels/CiPanel.vue`。

**作りは issue パネルと同じ**（`issues.md`）。認証も取得も CLI（`gh` / `circleci`）に任せ、
失敗の載せ方（一覧は値の中の `error`、1 件は `Err`）、`loading` と seq の規約、`act` の流れ、
パネルの入口の扱い（`usePanelAvailability`）はあちらが正本。ここには CI で違う点だけを置く。

## 出す条件と検出
- **CI ごとに「設定がある、かつ CLI がある」**（`ciStore.available`）。設定の有無は
  `ci_configs` がディレクトリ（`.github/workflows/` と `.circleci/`）で見る。設定の無い
  リポジトリに、空の一覧しか出ないアイコンを並べない
  - **GitHub Actions は `issuesStore.visible` を借りる**（origin が GitHub で `gh` がある）。
    `gh` を CI の側でも探すと、同じ問いを 2 つの入れ物で覚えて `gh --version` が 2 回走る
  - **`circleci` は `.circleci/` があるリポジトリでしか探さない。** 「検出のためだけに起動時へ
    `wsl.exe` を足さない」（`os-integration.md`）の例外にする範囲を、CircleCI を使う
    リポジトリに絞る。覚え方は `gh` と同じ（`CiState` と `createShellProbe`。見つかっただけ覚える）
  - **設定の有無は root ごとにウィンドウの寿命のあいだ覚える**（`configsByRoot`）。WSL では
    1 回聞くのに `wsl.exe` の起動が要る。設定を足したあとは更新ボタンが聞き直す
  - **WSL の `ci_configs` は `fs::dirs_exist` を使わない。** あちらは distro が応答しないとき
    「在る」に倒す（プロジェクト一覧向けの判断）。ここで受けると偽の「両方在る」を覚えるので、
    シェルが最後まで走った印を見て、答えられなかったら `Err` を返す（フロントは覚えない）
  - origin は CircleCI の条件に入れない。`circleci` は origin からプロジェクトを自分で解決し、
    Bitbucket のリポジトリでも動く（実測）
- **「使えないと確定した」は `ciStore.ruledOut`**（設定を聞き終えていて、どちらの設定も無い。
  GitHub の設定だけがあって origin が GitHub でないときも含む）。CLI が無いだけなら確定させない
- 両方使えるリポジトリでは、パネル上部のタブで切り替える（`pike:ci-provider`）。**覚えている
  選択が使えないプロジェクトでは、使えるほうを出す**（`provider`。選択は書き換えない）

## 2 つの CI を 1 つの器に畳む
- 行は `CiRun`、内訳は `CiJob`、状態は `RunState`（`running` は待ちも含む）。語彙の対応は
  `RunState::of_github` / `of_circleci` が正本。**知らない結果は失敗に倒す**
- **単位が違う。** GitHub Actions の run はワークフロー 1 本の実行で、CircleCI の run（旧称
  pipeline）は複数のワークフローを束ねる。**再実行は GitHub が run、CircleCI がワークフロー**
  なので、**渡す id は Rust が決めて行に載せる**（`CiRun.rerun_ids` / `rerun_failed_ids`）。
  フロントはそれをそのまま `ci_act` に渡し、メニューも同じ配列が空かどうかで出し分ける
  （CI ごとの分岐をフロントに持たない。失敗のログを取るコマンド `failure_log_command` も同じ）
  - **CircleCI では同じ名前のワークフローを 1 本にまとめる**（`circleci_rerun_ids`）。再実行
    すると同じ run の下に同名のワークフローが増え、古いほうも失敗のまま残る。全部を対象に
    すると押すたびに本数が倍になる。どれが新しいかは一覧から分からないので、「その名前が
    1 本でも成功していれば、もう落ちていない」と読む
- **CircleCI の一覧は CLI を 2 本続けて走らせる**（`run list && workflow list`）。`run list` は
  ワークフローも URL も返さない。別の IPC にすると WSL で `wsl.exe` が 2 回になるので、
  1 行にまとめて stdout の JSON 2 つを続けて読む（`parse_circleci_runs`）
  - **開くページはワークフローのもの**（`app.circleci.com/pipelines/workflows/<id>`）。run の
    ページは URL に run の番号が要り、JSON が返さない。ワークフローがまだ無い run は
    `url` が null で、行のクリックは job を開く
  - **2 本目（`workflow list`）だけが失敗しても run は出す。** `&&` でつないでいるので
    終了コードは非 0 になるが、stdout に 1 本目の JSON があればそれを返す（その run は
    ページも再実行の対象も持たないだけ）
  - **run が 1 件も無いと、空の配列ではなく「run が見つからない」のエラー（終了コード 5）が
    返る。** 失敗にせず空の一覧にする
    （`is_no_runs`）。`circleci` は失敗の理由を stderr に JSON で出すので、`failure` は
    その `message` を拾う
  - 時刻は `2026-10-07 08:42 UTC` の形で来るので、Rust で ISO 8601 に直す（`circleci_time`）
- **ブランチの絞り込みは CLI に渡す**（`--branch`）。取ってから絞ると、`limit` の窓がほかの
  ブランチで埋まる。ブランチ名は外から来る値なので `ShellConfig::line_arg` を通す
- **id は形を決め打ちで検証して、引用せずに行へ埋める**（`Provider::valid_id`。GitHub は数字、
  CircleCI は 8-4-4-4-12 の UUID の形まで見る。文字集合だけだと `-f` が通る）。対象のリポジトリを URL で名指ししない理由は `ci_act` の doc

## 取得とポーリング
- **実行中の run が一覧にあるあいだだけ、15 秒ごとに取り直す**（`shouldPoll` と
  `useFocusPolling`。利用者の判断）。issue パネルが持たない定期実行を持つのは、run が終わるのを
  待つ使い方があるため。**パネルを閉じているあいだ、ウィンドウが前に出ていないあいだ、
  実行中のものが無いあいだは CLI を起こさない**
  - **再実行と中止のあとは 60 秒、実行中のものが無くても続ける**（`watchUntil`）。操作の直後は
    サービスの側の一覧が古く、終わった run しか見えないのでポーリングが始まらない
  - **ポーリングの取得ではヘッダの更新ボタンを回さない**（`ProviderList.silent` と `busy`）
- **「今のブランチだけ」で、git の status がまだ無いあいだは最初の取得を待つ**
  （`branchPending`）。待たないと、全ブランチで 1 回取ってから絞って取り直す。プロジェクトを
  切り替えた直後は前の status が残っているので、そこでは 2 回取りうる（既知の制約）
- **job の応答は一覧の seq と突き合わせない**（`loadJobs`）。一覧はポーリングで取り直すので、
  seq で捨てると `loading` が立ったまま残る。行を閉じたか、`clear()` されたかは、入れ物が
  入れ替わったかで見分ける
- **job は行を開いたときに取る**（`ci_jobs`）。一覧を取り直したあとは、**実行中の run と状態が
  変わった run だけ**取り直す（`syncJobs`。終わった run の job は変わらない）
- 取得の状態は CI ごとに持つ（`ProviderList`。`stores/issues.ts` の `KindList` と同じ理由）。
  開いている行（`jobs`）もその中に置く

## パネル
- 行は 2 段（題名と、ワークフロー・ブランチ・相対時刻）。パネルの既定幅では 1 段に収まらない
- **🤖 と「調査の指示」は失敗した run だけ**。文面は `lib/ciPrompt.ts` の `ciAgentPrompt`
  （注入とコピーで共有）。**ログは運ばず、取るコマンドを添える**（`gh run view <id> --log-failed` /
  `circleci run get <id> --failure-report`）
- 絞り込み欄とエラー帯の見た目は `theme.css` の `.panel-filter` / `.panel-error-strip` を
  issue パネルと共有する
- 再実行と中止は右クリックメニューから。確認は `lib/ciActions.ts`、実行は `ciStore.act`。
  **済んだ行は落とさない**（issue のクローズと違い、行は残って状態が変わる）
- ログを Pike の中で読むタブは持たない（利用者の判断。CI のページとエージェントに任せる）
- **Bitbucket Pipelines は対象外。** 公式の CLI が無く、「取得を外部コマンドに任せる」という
  前提に乗らない
