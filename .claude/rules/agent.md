---
paths:
  - "src-tauri/src/agents.rs"
  - "src-tauri/src/agent_sessions.rs"
  - "src-tauri/src/shell_probe.rs"
  - "src-tauri/src/cache.rs"
  - "src-tauri/src/claude_usage/sessions.rs"
  - "src/lib/agents.ts"
  - "src/stores/agents.ts"
  - "src/stores/shellProbe.ts"
  - "src/types/agentSession.ts"
  - "src/composables/useAgentMenu.ts"
  - "src/components/AgentSessionsMenu.vue"
  - "src-tauri/src/claude_usage/live.rs"
  - "src-tauri/src/agent_live.rs"
  - "src-tauri/src/codex_usage/live.rs"
  - "src/lib/liveSessions.ts"
  - "src/lib/liveSessionIcons.ts"
  - "src/stores/liveSessions.ts"
  - "src/types/liveSession.ts"
  - "src/components/panels/AgentSessionsPanel.vue"
  - "src/components/LiveSessionMenu.vue"
  - "src/components/tabs/AgentSessionsTab.vue"
---

# エージェント実装ルール

エージェントの一覧（レジストリ）と検出、再開できるセッションの一覧。
実体は `src/lib/agents.ts`、`src-tauri/src/agents.rs`、`src-tauri/src/shell_probe.rs`、
`src-tauri/src/agent_sessions.rs`。関連する規則はほかに 2 本ある。

- `agent-usage.md` … トークン使用量・レート・エージェント状態タブ
- `agent-hook.md` … hook（入力待ちの知らせ・アカウントの申告）と `CLAUDE_CONFIG_DIR` の解決

## 方針

- **エージェントはターミナルで動かす（#275）。** 独自 UI で会話を進めるチャットのタブと、
  その裏の統一エージェント API は持たない（ターミナルで agent CLI を直接動かして支障が無く、
  独自 UI を保つ価値が薄い）。**新しいエージェントを足すときもチャットは実装しない**
- **エージェント向けのタスク置き場は作らない（#278）。** エージェントが自分のタスク管理を内蔵
  しているので、別の置き場を用意する意味が薄い（TODO パネルと `pike todo` はこの理由で削除した）。
  ユーザーの `.pike/todo.md` は消さない
- hook を持たないエージェント（Copilot CLI / opencode）向けの、出力のパターン一致による
  入力待ちの検出は未実装

## Claude のセッション一覧と worktree（#432）

**Claude は記録を「書いた時点の作業ディレクトリ」の slug（`projects/<slug>/`）に置く。**
セッションの途中で worktree へ移ると、以降の記録は移動先の slug に書かれ、`claude --resume` も
そのディレクトリでしか通らない。実体は `claude_usage/sessions.rs` の `session_dirs`（doc が正本）。

- **slug からパスへは戻せない**（`/`・`.`・`-` がどれも `-` になる）ので、逆向きに
  「分かっているパスを slug にする」。読むのは一覧を引いた場所と、`git worktree list` が返す
  worktree（`git/mod.rs` の `worktree_paths`）。**slug の前方一致で探さないこと**（`repo` の
  slug は `repo-old` の slug の前置でもある）
- **再開先を記録の `cwd` から決めない。** パスから slug を作った時点で再開先は決まっている。
  記録の `cwd` には Bash で `cd` したサブディレクトリも混ざるので、最後の行は使えず、
  全行を読むことになる（先頭と末尾だけを読む今の読み方と両立しない）
- **記録は先頭と末尾だけを読む（#476）**（`claude_usage/sessions.rs` の `read_session`）。
  先頭は対話のセッションか（`entrypoint`）とブランチと最初の題（一度だけ書かれる `ai-title`）が
  取れるまで、末尾は新しい題（ターンごとに追記される行）を探して 64KB から窓を倍にしながら
  2MB まで遡る（最後のターンの出力が大きいと、末尾の窓に題の行が無い）
  - **題の優先は `custom-title` → `ai-title` → 本文付きの `last-prompt`**。`custom-title` は
    利用者やスキルが付けた名前で、`claude --resume` のピッカーもこれを出す。どれも後の行で
    上書きする（付け直しとターンごとに追記される）
  - **題を先頭から探さないこと。** 最近の記録は `ai-title` をほとんど持たず、`last-prompt` も
    本文の無い形（`leafUuid` だけ）で書かれる。作業が長く続くセッション（worktree へ移る
    ものが典型）では、題になる行が数 MB 先にしか無い
  - 題になる行がどこにも無い短いセッションは一覧から外れる
- **同じ id は新しいほうだけ出す。** 起動した場所と移動先の両方に同じ名前の記録が残りうる
- 消えた worktree（`prunable`）は `parse_worktrees` が落とすので、そこのセッションは並ばない
  （再開できないものを並べない）
- **git を 1 回起こす**。読むのはメニューを開いたときだけ、という前提（`agent_sessions.rs` の
  doc）の上に乗っている。ポーリングへ移すならここが費用になる
- 設定ディレクトリは一覧を引いた場所で解決したもの 1 つを使う（`config::resolve`。再開のメニューの話で、
  今動いているセッションの一覧は下の #633 の節のとおり複数のアカウントを読む）。worktree
  ごとに `CLAUDE_CONFIG_DIR` を変えている構成は拾わない
- 他の 3 つ（Codex / Copilot / opencode）は対象外（#432 は Claude に絞った）。worktree で
  動かしたセッションが一覧に出るか、再開が場所に依るかは**未確認**

## 今動いているセッションの一覧（#625 / #633）

サイドバーのセッションのパネル（簡易）と、そこから開く詳細のタブ。**判断の正本は 3 つのモジュール
doc**（`agent_live.rs` ＝どの環境とアカウントを読むか、`claude_usage/live.rs` ＝ Claude の出所・
生存の照合・題、`codex_usage/live.rs` ＝ Codex の状態の推し方）と `stores/liveSessions.ts` の `jump` の
doc（飛び先の 3 段）。ここには規範だけ置く。

- **一覧はアカウント（エージェント × 環境 × 設定ディレクトリ）ごとの配列で返る**（#633。
  `agent_live_sessions` → `LiveSessionList[]`）。**先頭は今のプロジェクトのアカウントで、これだけは
  空でも返す。ほかはセッションがあるときだけ返す。** フロントは一覧が 1 つなら見出しを出さない
  （`showHeadings`）。アカウントが 1 つで Codex を使っていなければ #625 と同じ見た目になるのは、
  この 2 つの組み合わせで保っている。片方だけ崩さないこと
- **Claude の出所は設定ディレクトリの `sessions/<pid>.json`**（Claude Code が状態を書き直す。`status` は
  `busy` / `idle` / `waiting`）。**今のプロジェクトのアカウントの解決は `activeRoot` で行う**（使用量と
  同じ。worktree を切り替えたら一覧を捨てて読み直す。`scope`）。使用量の集計（`find_active_sessions`）は
  今のプロジェクトのアカウントのまま（広げたのは一覧だけ）
- **アカウントの候補は 3 つ**（`agent_live.rs` の doc）: 今のプロジェクトの `config::resolve`、hook の
  申告（`agent_hook::declared_config_dirs`。プロジェクトを問わない）、ホーム直下の `.claude*`
  （`agent_hook::candidate_dirs`。hook の登録先の候補と同じ当て推量）。同じディレクトリは 1 つに畳む
  （Windows のパスは大小を区別しない）。候補は環境ごとに 60 秒覚え、申告のファイルが動けば作り直す
  - **登録済みのプロジェクトごとに `config::resolve` を払わない**（WSL では対話ログインシェルを起こす）。
    `.envrc` でホームの外を指すアカウントは、申告が届くまで並ばない
  - **古い申告を時刻で落とさない。** 見出しは「今セッションが動いているか」で出すので、使わなくなった
    アカウントの申告が残っていても見出しは出ない（費用は `sessions/` の `read_dir` 1 回）。消えた
    ディレクトリは実在の確認で落ちる
  - 設定画面でディレクトリを足す逃げ道は作っていない（今の 3 つで拾えない構成の報告が来てから）
- **環境は Windows のホストと WSL の両方**（利用者の要望）。今のプロジェクトの環境に、WSL のプロジェクト
  ならホストを、どちらでも「Pike のターミナルが開いている distro」（`PtyState::open_wsl_distros`）を足す。
  **止まっている distro は読まない**（UNC を読むと起動し、ポーリングで読み続けると止まらなくなる）
  - **`wsl.exe --list --running` に聞く形は採らない。** ポーリングのたびにプロセスを起こすか、答えを
    覚えるあいだに止まった distro を読んで起こすかになる（読むと動いている扱いになるので、次の
    問い合わせも「動いている」と答え、起こし続ける）。代償は、Pike のターミナルを開いていない distro で
    Pike の外から起動したセッションが並ばないこと
  - distro のホームは `wsl_home_cached`（distro につき 1 回 `bash -c`。動いている distro なので起こさない）
  - **生存の照合は環境ごとに別**（Windows のプロセスと各 distro の `/proc` は別の pid 空間）。一覧が
    環境のシェル（`LiveSessionList.shell`）を持ち、照合もそのシェルで行う。**環境ごとにスレッドを分けて
    読む**（`agent_live.rs` の `lists`。UNC 越しの往復が環境の数だけ直列に積み上がらないように）
  - **行は自分の環境のシェルを持ち、照合・ターミナルを開くシェル・再開のディレクトリの問い合わせは
    全部それで行う**（`LiveSessionRow.shell`）。プロジェクトのシェルで代用しない（WSL のセッションを
    Windows のプロジェクトと取り違える）。プロジェクトが同じ環境なら、開くシェルはプロジェクトのもの
    （利用者が選んだシェル）。プロジェクトの無い WSL のディレクトリは UNC にして開く（`lib/paths.ts` の `openablePathForShell`）
- **別のアカウントの Claude のセッションは `CLAUDE_CONFIG_DIR`（表の `AgentDef.configEnv`）を付けて再開する**（`resumeLine`。
  付けないと、開いたターミナルが見ているアカウントで `--resume` を探して見つからない）。値は
  `LiveSessionList.configOverride`（そのシェルから見た形）で、**既定の `~/.claude` には付けない**
  （付けると `.claude.json` の置き場が隣から中へ変わる。今のプロジェクトのアカウントも、申告が `~/.claude`
  を指していれば付けない＝`is_default_dir`）。シェルごとの書き方は `types/tab.ts` の `withEnv`
  - **既知の隙間**: 既定のアカウントのセッションを、シェルの rc が別の `CLAUDE_CONFIG_DIR` を export している
    環境で再開すると、その値を継いで `--resume` が見つからない。変数を外す 1 行（`env -u` / `Remove-Item Env:`）を
    シェルごとに足す手はあるが、報告が来てから
- **既知の隙間（環境）**: Pike のターミナルのうち distro を名指ししないもの（シェル未指定の spawn と tmux の
  spawn。`BusyProbe::Wsl` の `distro: None`）は数えない（名前を引くには `wsl.exe` が要る）。ふつうの WSL の
  タブは distro を名指しして起動するので当たる
- **Codex の出所は rollout**（`~/.codex/sessions/**/rollout-*.jsonl`、`codex_usage/live.rs`）。pid が無いので
  状態は 2 つ: **稼働中**＝`ACTIVE_WINDOW_SECS` 以内に書かれ、かつ最後のターンが閉じていない
  （`task_started` のあとに `task_complete` / `turn_aborted` が無い）、**最近**＝`RECENT_WINDOW_SECS`
  以内の残り（10 件まで）。mtime だけで決めないこと（ターンを終えて入力を待っているセッションが 5 分
  「稼働中」に出る）。走査はポーリングなので日付ディレクトリ 3 つだけ
  - **返答待ちは出さない**: 入力待ちの知らせ（`agent_hook`）は Claude の hook と mod にしか無い。許可の
    確認待ちも rollout からは確かに読めない。サイドバーの件数にも数えない
  - **題は `session_index.jsonl` の `thread_name` → 最初のユーザー発話**。ブランチと版は `session_meta`
    （`git.branch` / `cli_version`）。`name` に当たるものは無い
  - **タブから引けない**（Codex のタブは `agentRun` / `agentSession` を報告しない）。移動は登録済みの
    プロジェクト → ディレクトリへ落ち、Pike のターミナルで動いていても再開の確認が出る
  - 再開は表の `AgentDef.resume`（`codex resume <id>`）。**ストアの `jump` / `reveal` にエージェント固有の
    分岐を書かない**（アカウントを切り替える環境変数は表の `AgentDef.configEnv`、worktree の再開先は
    Rust の `agent_live_session_resume_dir` が Codex の `~/.codex` に null を返すことで吸収している）
  - **`CODEX_HOME` には対応しない**（使用量と再開の一覧も `~/.codex` 固定。揃えて足す）
- **このディレクトリを読む口は `live_records` の 1 つ**。使用量の集計（`find_active_sessions`）も
  ここを通す。読み方や生存の確かめ方を、使用量の側に別に書かないこと
- **ファイルは終わったセッションのぶんも残る。** pid が今も同じプロセスかを `procStart` で確かめる
  （Windows は作成時刻の FILETIME、Linux は `/proc/<pid>/stat` の starttime。手元で一致を実測）。
  **生きているかだけで済ませないこと**（pid は使い回される）。macOS は形式が未確認なので pid だけ
  - **死んでいると分かった記録はファイルの mtime で覚えて読み直さない**（`DeadRecords`）。覚えて
    よいのは確かな答え（`/proc` に無い・開始時刻が違う・その pid のプロセスが無い）だけで、
    問い合わせの失敗（権限・一時的な失敗。`Verdict::Unknown`）と、解析できなかった記録（書き直しの
    途中を読んだかもしれない）は覚えない。覚えると、書き直されないアイドルのセッションが消えたままになる
- **予備のプロセス（`spare`）は読み口で落とす**（一覧にも使用量の `active` にも数えない）
- **WSL の `/proc` は UNC 越しに読む**（ポーリングするので `wsl.exe` を起こさない）。見えない環境
  だけ `alive_pids_wsl` へ落ちる
- **ポーリングは見ているあいだ 5 秒、それ以外は 30 秒**（サイドバーのアイコンの返答待ちの件数の
  ため）。30 秒のほうは常に回し、5 秒のほうを見ているあいだだけ足す（見ているかで張り直すと、
  短い間隔で切り替えるたびに 30 秒を数え直す）。前の取得が返る前の回は飛ばす。どちらもウィンドウが前に出ているあいだだけ（`useFocusPolling`）。ふつうはプロセスを
  起こさない（起こすのは `/proc` が UNC で見えない WSL だけ）ので、ここを `agent_sessions` の
  「開いたときだけ」と揃えなくてよい。**題を読む記録は mtime で
  覚える**（`transcript_title`）。ここをポーリングのたびに読み直す形にしない
  - **#633 で 1 回に読む量はアカウントと環境の数に比例する**が、間隔は据え置いた。1 アカウントぶんは
    `sessions/` の `read_dir` と小さな JSON、生存の照合で、Codex は日付ディレクトリ 3 つの `read_dir` と
    stat（中身は mtime で覚える）。ふつうはプロセスを起こさない。候補のアカウントは 60 秒覚えるので、
    ホームの `read_dir` と `.claude.json` の読みは毎回は払わない
- **飛び先はタブ → 登録済みのプロジェクト → ディレクトリの順**（`jump`）。`cwd` を含むプロジェクトが
  無ければ **git の main worktree から引き直す**（利用者の判断。リポジトリの外の worktree で動く
  セッションを元のプロジェクトへ寄せる）。どれにも当たらなければ `openDirectory`（登録するかは設定）
  - **別のウィンドウのタブは、そのウィンドウ自身に選ばせる**（`REVEAL_EVENT` を全ウィンドウへ送り、
    そのプロジェクトを見せているウィンドウだけが動く）。**送るのは `focusProjectWindow` が真を返した
    とき（ほかのウィンドウが見せているか保持している）だけ**で、偽ならこのウィンドウで `switch` する。
    **このウィンドウが保持しているときは `focusOrSwitch` を使わない**（自分にも切り替えを頼むだけで
    返るので、待てない）。自分のウィンドウが見せているなら送らずに直に呼ぶ（知らせは自分にも届くので、
    両方だと 2 回動く）
  - **セッションのタブは `agentRun.sessionId` → `agentSession.id` の順で引く**（`tabBySession`）。
    後者は mod が動いていないタブや、復元の直後でまだ報告が無いタブを拾う
  - **突き合わせの鍵はエージェント・環境・セッション id の組**（#633。`lib/liveSessions.ts` の
    `liveSessionTabKey`）。一覧はアカウントと環境をまたぐので、id だけだと別の環境の同じ id の行にタブの印が
    付く。**行の `tabId`・チラ見の `tabForSession`・着いたウィンドウの `reveal` は同じ鍵で引く**（片方だけ
    id で引かないこと）。Claude の設定ディレクトリは鍵に入れない（タブは知らない）
  - **環境の比較は WSL の distro の名前の大小を区別しない**（`wsl -d ubuntu` も `Ubuntu` に当たる）。フロントは
    `lib/liveSessions.ts` の `livePlaceKey`、Rust は `types::same_install` の 1 か所ずつに寄せてある（申告の照合
    `matches_project` / `declared_config_dirs` も後者）。パスの比較は大小を区別したまま
  - **同じ会話の行が 2 つ以上あるときは、印は出すがチラ見させない**（`LiveSessionRow.peekable`）。タブは
    Claude の pid を持たないので、そのターミナルで動いているのがどちらのプロセスかを確定できない。タブへ
    移るのは同じ会話なので残す
  - **タブが無ければ、確認のあと再開のタブを開く**（`resumeLine`。`claude --resume <id>` か `codex resume <id>`、
    別のアカウントなら環境変数付き。利用者の判断。そこを含む
    worktree へも切り替える）。**確認を外さないこと**: 一覧に出ている時点でセッションは
    どこかで動いているので、再開すると同じ会話を 2 つのプロセスが持つ
    - **開く場所は記録が最後に書かれた場所**（`agent_live_session_resume_dir`。`cwd` は起動した場所で、
      途中で worktree へ移ったセッションは移動先でしか `--resume` が通らない。決め方は #432 の
      `session_dirs` を流用）。git を起こすので押したときにだけ呼ぶ
    - **待つたびに、まだそのプロジェクトに居るかを確かめる**（確認・worktree の読み込みのあいだに
      切り替えられると、worktree の切り替えやタブが別のプロジェクトに付く）
  - **保持しているだけのウィンドウは、切り替わるまで待つ**（`REVEAL_WAIT_MS`）。Rust はそのウィンドウに
    切り替えを頼むだけで返るので、知らせのほうが先に着きうる。**ほかのウィンドウが見せているなら
    待たない**（`projectWindowList`）。待つと、あとで利用者が自分で切り替えたときに頼まれていない
    確認やタブが出る
  - **右クリックの「そこでターミナルを開く」も同じ経路**（`goTo` の `action: 'terminal'`。着いた
    ウィンドウでシェルだけを開く）。メニューはパネルとタブで 1 つ（`LiveSessionMenu.vue`）で、操作の
    実体はストアに置く（片方の画面にだけ項目を足さない）
  - 受け口はストアにあるので、**ストアはサイドバー（`SideBar.vue` の件数）が作る**。サイドバーを
    持たないウィンドウ（グローバルモード）はプロジェクトも持たないので、受ける必要が無い
- **ターミナルのチラ見（#631）はプロジェクトのプルダウン（#319）と同じポップアップ**（`TerminalPeekPopup.vue`。
  `project.md` の #319 の節）。パネルと詳細のタブは、行のターミナルの印（`tabId` がある行にだけ出る）を
  `TerminalPeekMark.vue` にして置く（印とポップアップを 1 つに持つ。2 つの画面で印を写さない）。
  **行全体をホバー対象にしない**（押そうとして通っただけで出る）
  - **覗けるのはこのウィンドウのタブで動いているものだけ。** 中身は xterm が描いたものを読むので、
    ほかのウィンドウや Pike の外のターミナルのセッションは読めない（ウィンドウごとに JS が別）。
    覗くために Rust へ出力を溜める形にしないこと（`useTerminalPeek.ts` の doc）
  - **タブは取り直すたびにストアの `tabForSession` で引き直す**。ホバーを始めたときに掴んだ行の
    オブジェクトは、一覧が組み直されても差し替わらない（タブを閉じても `tabId` が残る）
  - **`nested` は渡さない**。プルダウンと違って数えられた浮いたものの中に無いので、子 webview が
    ページを重ねているあいだは出さない（Git パネルのコミットのツールチップと同じ扱い。`frontend.md`）

## エージェントの一覧（#275 / #267）

**正本は `src/lib/agents.ts` の `AGENTS`。** 起動ボタン・使用量・入力待ちの通知は同じ
「Pike が知っているエージェント」という一覧を要るので、別々に持たない。対応を増やすときは
この表に 1 行足す。

- **Rust との継ぎ目は `AgentId`**（`agent_usage/mod.rs`）。検出（`agents.rs` の
  `agent_detect`）は bin 名だけで足りるが、使用量（#263）とセッション一覧（#267）は
  記録の置き場と行の形式を Rust 側で知る必要があるので、この id で振り分ける。**分担の
  正本は `src/lib/agents.ts` の doc**（ここに写しを置かない）。起動・再開のコマンド文字列は
  表の側が持ち、Rust は組み立てない
- **種別ごとの違いは真偽のフラグではなく、実体で持つ**（#267）。セッション一覧は
  フロントが `AgentDef.resume`（id を受けて再開コマンドの文字列を返す関数）、Rust が
  `agent_sessions.rs` のアダプタ（id で 4 つの出所へ振り分ける）を持つ。`sessions?: true`
  のような欄にすると「真にすればその名前の下に履歴が出る」という通る嘘になる。**表に 1 行
  足すときは `resume` も書く**（型が要求する）。Rust 側の腕は `AgentId` の `match` が
  網羅性で気付かせる
- **シェルの行に埋まる名前は Rust 側で検証する**（`is_safe_bin_name`）。表の値しか来ない
  前提でも、IPC の引数は誰でも投げられる
- **種別をコマンド文字列の正規表現で当てない。** 字面を見るのはカスタム行に対してだけで、
  **判定は表を引く `commandMentionsAgent` の 1 箇所**に閉じる（各所に正規表現を書くと、
  表に 5 つ目を足したとき片方だけ古くなる）

### 起動行

- **起動行は 1 本のリスト（`agentLaunchers`）で持つ。** 表のエージェント（`kind: 'agent'`）と
  利用者が書いた行（`kind: 'custom'`）が同じ順序に並び、**使える先頭が既定**（ボタン本体で
  走る行、かつメニューの第 1 階層）。残りは「他のエージェント」のサブメニュー
  - **2 本に分けないこと。** 分けると優先順位が 1 か所の `??` にしか残らず、`claude --model opus`
    をボタンにしていた利用者が表の既定に戻され、戻す手段が UI から消える
  - **カスタム行は検出を通さない**（空でなければ使える）。`npx claude` や
    `docker compose exec -T dev claude` のように、bin 名では表せない起動が普通にある
  - **セッション一覧は行ごとに、その行が起動するエージェントのものを出す**（#267）。
    どのエージェントかは表の行なら id、カスタム行なら `commandMentionsAgent` で字面を見る
    （wrapper 越しの起動を落とさないため）。既定の行のぶんは第 1 階層のサブメニュー、
    他のエージェントのぶんは「他のエージェント」の各行のサブメニュー（第 3 階層）で、
    **どれの履歴かはメニューの位置が言う**
  - 旧 2 フィールド（`agentProfiles` / `agentCommands`）は**移行の入力と、同期ファイルへの
    後方互換の書き出しにだけ残る**。`snapshot()` は全量置換なので、書かないと更新して
    いないマシンが publish した瞬間に新しい並びごと消える（`darkMode` と同じ手）
- **昔の既定 2 行（`claude` / `claude --continue`）は 1 回だけ落とす**
  （`dropLegacyAgentDefaults`）。1 文字でも編集していればそれは意図した行なので残し、
  カスタムの起動行として一覧に入る

### 検出（シェルへの問い合わせ）

- **検出できたものだけメニューに出す。** 押しても `command not found` になる項目を並べない。
  `wsl.exe` を余分に起こさないよう、**1 回のシェル起動で全部聞く**。聞き方とキャッシュは
  `src-tauri/src/shell_probe.rs`（`agents.rs` に残るのはコマンドの形と名前の検証だけ）で、
  答えはシェルの導入単位でプロセスに 1 つ持つ（`IssuesState` と同じ形）
- **POSIX 側は対話ログインシェル（`-lic`）で聞く。** nvm / fnm / asdf / mise / Homebrew は
  どれも rc の中で PATH を足すので、非対話の `bash -c` では**ターミナルでは打てるのに
  検出では見つからない**。判定する環境を PTY に合わせる。起こし方の契約
  （`unset HISTFILE`・終了コードを見ない）は `run_login_script` が持つ
  - **`HISTFILE` を unset する理由**：対話シェルは終了時に履歴を書き戻すので、`HISTSIZE` の
    設定次第でプローブがユーザーの `.bash_history` を削りうる
- **同じシェルへの 2 つの問いは 1 本にまとめる。** エージェントの `bin` を探すのと
  `CLAUDE_CONFIG_DIR` を引くのは、どちらも同じ `-lic` に聞ける。**費用のほぼ全部は rc の評価**
  なので、1 回の起動で両方の目印を出させれば半分になる（`shell_probe.rs` の `posix_script`）。
  片方の期限が切れたときは**もう片方も一緒に聞き直す**（ずらすと結局 2 回起きる）
  - 答えはマーカー行（目印 + タブ）で拾う。`.bashrc` がバナーを stdout に出すことがあるので
    行の位置では選ばない。**目印は問いごとに別**（`ENV_MARKER` / `AGENT_MARKER`）
  - 環境変数のプローブは **distro 単位**でキャッシュする（rc ファイル由来なのでプロジェクトでは
    変わらない）。ウィンドウを何枚開いても distro につき 5 分に 1 回
  - **同じキーのプローブは 1 本に畳む**。usage と rate のポーリングは同じ tick で走るので、
    畳まないと期限切れのたびに 2 本が同時にシェルを起動する。**畳むのは probe のロック**
    （`cache::ProbeEntry` の 2 段ロック。#315）で、答えのロックではない（答えのロックで畳むと、
    あるプロジェクトの解決が他のプロジェクトの解決まで止める）
- **TTL は 2 つあり、役割が違う。** Rust の `PROBE_TTL` は**プロセスを起こさない**ため、
  ストアの `ASK_TTL` は**IPC を投げない**ため。永久に覚えると冷えた WSL でタイムアウト
  した 1 回が再起動まで残り、毎回聞き直すとタブを切り替えるたびに IPC が飛ぶ
  （新規ターミナルだけでなく、タスク実行や `docker compose up` のコマンドタブも `pty_spawn`
  を通る）
- **ストアはシェルごとの表で持つ**（1 枠ではなく）。1 枠だと、同じウィンドウで WSL のタブと
  PowerShell のタブを行き来するだけで毎回聞き直し、`launchers` が「どのシェルの答えか」を
  知らないまま入れ替わる。表なら**プロジェクトを切り替えたときに捨てる必要も無い**
- **検出は PTY を起こしたあとと、タブが見えるようになったときに撃って待たない。**
  「検出のためだけに起動時へ `wsl.exe` を足さない」（`os-integration.md`）の例外で、issue
  パネルの `gh` と同じ理由（ボタンを出すかが答えに依存するので、メニューを開くまで
  遅らせられない）。タブが見えたときにも撃つのは、タブが生き続ける＝プロジェクトを
  切り替えても PTY が起こし直されないため（べき等なので毎回呼んでよい）
