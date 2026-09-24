---
paths:
  - "src-tauri/src/agent_hook.rs"
  - "src-tauri/src/toast/**"
  - "src-tauri/src/claude_usage/config.rs"
  - "src/lib/notify.ts"
  - "src/composables/useAgentNotice.ts"
  - "src/composables/useAgentHookPrompt.ts"
  - "src/components/layout/ProjectSelect.vue"
---

# エージェントの hook とアカウントの解決

Claude Code の hook から Pike へ届く 2 つのもの（入力待ちの知らせ #265 と、アカウントの申告 #299）と、
`CLAUDE_CONFIG_DIR` の解決（#225）。エージェントの一覧は `agent.md`、使用量は `agent-usage.md`。

## 入力待ちの知らせ（#265）

Claude Code の `Notification` / `Stop` hook を登録し、**そのターミナルを持つウィンドウへ届けて**
タスクバーを点滅させ、タブとプロジェクトにドットを出す。デスクトップ通知（#318）も並べて出す。
実体は `src-tauri/src/agent_hook.rs`、`src/composables/useAgentNotice.ts`、
`src/components/layout/ProjectSelect.vue`。

**判断の実体は 2 つの doc コメントが正本**（`agent_hook.rs` のモジュール doc ＝経路と登録、
`useAgentNotice.ts` ＝受け取ったあとの扱い）。ここに写しを置くと必ず片方が古くなるので、
方針だけ残す。

- **受け口は #299 と同じ 1 つ**（`pike agent-hook`）。違いは `--event=` が付くかどうかで、
  付いていれば通知、無ければアカウントの申告。**契機はコマンド行に書く**: `Notification` の
  stdin には 12 個ある matcher のどれで発火したかが入らない（あるのは `message` の文言だけ）
  - **鳴らし分けたい単位で matcher を割る**（#338）。契機がコマンド行にある以上、`Notification`
    を「答えないと進まない」（`waiting`）と「待たせているだけ」（`idle`＝`idle_prompt`）に
    分けるには行を 2 本にするしかない。後者は既定で鳴らさない（設定は `agentNotifyIdle`。
    判断の実体は `stores/settings.ts` の宣言の隣が正本）
  - **matcher を割る改訂では、古い行を作り直す**（`is_stale_group`）。`matches_spec` は
    契機しか見ないので、両方の matcher を持つ古い版の行はそのまま「登録済み」と読まれ、
    新しい `idle` の行と二重に発火する（しかも片方は新しい設定を素通りする）。**掃除は
    `ensure_hook` の中**なので、登録ボタンでも `agent_hook_install_missing` でも直る
  - **表を変えたら `useAgentHookPrompt` の `ASKED_KEY` の版も上げる。** 掃除の入口が
    登録の操作しか無い一方、あの記録は「シェルごとに一度きり」なので、上げないと
    **既に承諾している人（＝ほぼ全員）に移行が届かない**。上げても、聞かれるのは
    未登録と判定される人だけ
- **配送は WM_COPYDATA**（`wait::send_notice_to_first_instance`）。#299 がこれを避けた理由
  （受け側がメインスレッドで、解決のロックを待つあいだ UI が止まりうる）は、ロックを取らない
  配送には当てはまらない。**WSL の中からでも届く**（interop で起動された `pike.exe` は
  Windows プロセス）。**非 Windows には配送手段が無いので、通知の hook はそこでは登録しない**
  （`HookSpec::windows_only`）
  - **宛先は開発版とインストール版の両方を探す**（`types::app_identifiers`、#333）。hook の
    コマンド行はビルドで分けない（申告の置き場と同じく共有する）ので、**どちらの exe が
    hook として走るかは登録した側で決まる一方、そのターミナルを持つ Pike はもう一方で
    ありうる**。自分のビルドだけを探すと、緩い一致（`matches_spec`）と噛み合って、一方の
    設定画面が他方の行を「登録済み」と出し、解除すると相手の行を消す
  - **誤配は起きない**（届け先は pty id の uuid なので、そのタブを持たないインスタンスは
    黙って捨てる）。**CLI の転送（`send_to_first_instance`）は自分のビルドだけ**: あちらは
    二重起動した自分の argv を本体へ渡す経路で、相手へ渡すと頼んでいない側でファイルが開く
- **hook の本文（`message` / `last_assistant_message`）は運ばない。** payload が `|` 区切り
  なのと、文言は UI 言語に従うべきものだという 2 つの理由（`AgentNotice` の doc）
- **どのエージェントかも送り側が名乗る**（`--agent=`。契機と同じく登録するコマンド行に書く）。
  受け側で定数を差し込むと、2 つ目のエージェントが hook を持った日や、利用者が別の
  ラッパーからこのサブコマンドを呼んだ日に、**黙って「Claude Code」という嘘の表示名**を
  出す。型は `AgentId`（`agent.md` の「Rust との継ぎ目」）
- **「登録済み」は 3 つ揃って初めて。** `SessionStart` だけを見ると、通知の 2 つが永久に入らない
  まま「登録済み」と出る。既存の登録は登録ボタン 1 回で足りないぶんだけ足される
  （`ensure_hook` は既にある行を動かさない）
- **hook の登録は通知の設定（`agentNotify`）で変えない。** 登録は #299 のアカウントの申告にも
  要るもので、設定を切り替えるたびに他人も読むファイルを書き換えることになる
- **印はタブが持ち（`awaitingInput`）、プロジェクト単位のドットはその集約**
  （`tabStore.awaitingProjectIds`）。消す処理を別に持たないので、消え残りが出ない。タブの印は
  そのタブを選んだ時点で下りる（`hasActivity` と同じ契機）
- **`hasActivity` に相乗りさせない。** あちらはベル由来の「何か出力があった」で、こちらは
  「答えるまで進まない」。意味が違うので色も分ける（`--success` の緑）
- **見えているものには何もしない。** ウィンドウがアクティブ（`windowFocused`）で、かつタブが
  描かれている（`isTabVisible`）なら、プロンプトは既に目の前にある

### デスクトップ通知（#318）

- **タスクバーの点滅と並べる。排他にしない**: トーストを見逃してもタスクバーには残っていて
  ほしい。通知だけ設定で切れる（`desktopNotify`。何を知らせるかの `agentNotify` とは別の軸）
- **判断の実体は `src-tauri/src/toast/mod.rs` の doc が正本**（AUMID とショートカット、
  プロセス AUMID を触らない理由、通知を保持しない理由）。ここに写しを置かない
  - トーストが出るにはスタートメニューのショートカットに AppUserModelID が要る（無いと
    バナーも出ず通知センターへ直行し、クリックも返らない）。Pike 自身がショートカットを用意する
  - **ショートカットに明示 AUMID を書いても、タスクバーのグループ化とジャンプリストは
    変わらない**（#318 で実機確認）。プロセス側の AUMID（`SetCurrentProcessExplicitAppUserModelID`）
    を設定していないためで、`os-integration.md` の「AUMID は明示設定しない」はそのまま保たれる
  - **開発版のショートカット（`Pike (dev).lnk`）は押しても使えない。** AUMID の登録専用で、
    デバッグビルドは `devUrl`（Vite）を読み、コンソールを隠す `windows_subsystem` も
    release にしか付かない
- **押されたことはプロトコルで受ける**（#334。`toast/activation.rs` の doc が正本）。
  通知センターへ移ったあとのクリックはインプロセスの `Activated` を通らないので、
  **経路をプロトコルに一本化する**（ショートカットに CLSID を書いた時点で、画面上の
  トーストもそちら側になる）。スキームはビルドで分ける（`pike:` / `pike-dev:`）
  - **行き先は 3 段に落ちる**（`lib.rs` の `try_handle_activation`）。タブが生きて
    いればそこへ、無ければそのプロジェクトのウィンドウを前へ、それも無ければ
    プロジェクトを開く。**通知は数時間後に押されうる**ので、タブが残っていないのは
    むしろ普通の側。だから通知そのものに pty とプロジェクトの両方を載せる
  - **Pike が走っていないときのクリックも同じ形**（Windows が `pike://` で起こす）。
    そのときは pty が無いので `CliAction::FocusProject` を積むだけにして、**前回の
    セッションを普通に復元してから**そのプロジェクトへ行く（App.vue）。
    **`window_projects` に seed しないこと**: フロントが復元を飛ばし、
    `project_add_open` の全量書き直しで前回開いていた他のウィンドウの記録が消える。
    `pike <dir>` では許されるが、通知のクリックは受け身の操作
  - **「同じ形」だが調停者は別**（#340）。走行中は Rust（`try_handle_activation` →
    `focus_or_build_project_window`）、コールドスタートはフロント（`restoreLastProject` の
    `focus`）で、**順序を持つのは後者だけ**（復元で開く子ウィンドウが出そろってから前に
    出す）。**通知の行き先を増やすときは 2 つとも見ること**
- **公式プラグインではクリックを受けられない**（`tauri-plugin-notification` の desktop 実装は
  `notify_rust` へ投げっぱなしで、クリックを受ける口が無い。`onAction` はモバイル専用。
  WebView2 の Web Notification も `granted` のままクリックがページへ返らない）
- `lib/notify.ts` は**押させない知らせ専用のまま**（トレイのヒントが使う）。**トレイの
  ヒント通知（#161）のクリックはいまも効いていない**が、これは同じ経路に載せ替えれば直る

## Claude のアカウントの解決（`CLAUDE_CONFIG_DIR`、#225）

Claude Code はこの環境変数で `~/.claude` の位置ごと差し替える（`projects/` も `sessions/` も
`.claude.json` もそこへ移る）ので、**集計・セッション一覧・レート取得の 3 つとも**
`claude_usage/config.rs` の `resolve` を通す。検出の順と `.envrc` を評価しない理由はそのファイルの
doc コメントが正本。issue の表題にある `CLAUDE_CONFIG_PATH` という変数は存在しない。

- **解決の順は「hook の申告 → `.envrc` → シェルの環境変数 → 既定」**（#299）。先頭だけが**実際に
  走った claude が見ていた場所**で、残りは起動前の予測。予測では取りこぼす構成が実在する
  （`claude` の起動ラッパーがシェル関数で `CLAUDE_CONFIG_DIR` を被せる運用では、`.envrc` にも
  シェルの環境変数にも現れない）
- **実在を確認できたディレクトリだけ採用する**。読めない値を `native_override` に残すと、
  `claude` を起動する側がそれを export して別の場所を作らせてしまう。確認できなければ検出
  そのものを無かったことにして既定へ落ちる
- Windows シェルは Pike のプロセス環境を見る（cmd / Git Bash は起動時に継承するので同じ値）。
  **PowerShell のプロファイルの中だけで設定した場合は拾えない**
- **検出に失敗しても黙って既定に落ちる**（`.bashrc` が `exec tmux` する、`.envrc` が `$(…)` を
  使う等）。プロジェクト単位の設定欄は作っていないので、気付ける場所は StatusBar のアカウント
  行（思っていたのと違うメールアドレスが出る）
- **`.claude.json` の場所は 2 通り**。`CLAUDE_CONFIG_DIR` を設定していればその中、**既定では
  `~/.claude` の中ではなく隣**の `~/.claude.json`（Windows・WSL の実機で確認）。設定
  ディレクトリの中を先に見て、無ければ親を見る
- アカウント（`.claude.json` の `oauthAccount`）は **`resolve` の中で一緒に読む**。あのファイルは
  Claude Code のカウンタ置き場でもあって数十 KB あり、稼働中は数十秒ごとに mtime が変わるので、
  mtime キーのキャッシュだと 30 秒ポーリングのたびに UNC 越しに全文を読む。中身が変わるのは
  ログインし直したときだけなので TTL に相乗りさせる
- 問い方とキャッシュは `shell_probe.rs`（エージェント検出と同じ `-lic` に相乗りする。`agent.md` の
  「同じシェルへの 2 つの問いは 1 本にまとめる」）。プロジェクトごとに違う入力は `.envrc` だけで、
  UNC 越しにただのファイルとして読めるので spawn が要らない
- コマンドは 3 つとも **`spawn_blocking` に逃がす**（`rust.md`）。`resolve` は WSL では対話
  ログインシェルを起こし（最長 10 秒、しかもロックを握ったまま）、候補の列挙は UNC 越しの
  `read_dir`、登録はファイル I/O

### hook による申告（#299）

- **申告の仕組みは `src-tauri/src/agent_hook.rs` の doc が正本**（受け口の形・`SessionStart` の
  作法）。要点だけ: Claude Code の `SessionStart` hook が `pike agent-hook` を起動し、stdin の
  JSON の `transcript_path` から設定ディレクトリが確定する
- **走っている Pike へ知らせる経路は持たない。** 申告はファイルに書くだけで、反映は `resolve` の
  キャッシュが**そのファイルの mtime を見る**ことで起きる（`declarations_mtime`）。IPC で
  「捨てろ」と伝える形は、受け側がメインスレッドなので解決のロック（プローブ中も保持、最長
  30 秒）を待つあいだ UI が止まりうるうえ、WM_COPYDATA が Windows にしか無いぶん非 Windows
  だけ遅れ、申告 1 件で全プロジェクトの解決を捨てることになる。**入力の更新時刻を見れば
  3 つとも起きない**
- **申告の置き場はビルドで分けない**（`STORE_IDENTIFIER`）。申告は Pike のアプリ状態ではなく
  「この cwd はこの設定ディレクトリを使っている」という**利用者の環境についての観測**なので、
  開発版とインストール版で 1 本を共有する。分けると、`settings.json` に 2 行並べるための厳しい
  一致判定と、開発ビルド専用のコマンド行という特別扱いが要る
- **申告のキーには `install_key` も入れる**（`Declaration::install`）。cwd だけだと、distro を
  2 つ持っていて両方に同じパスがあるときに片方の申告がもう片方へ返る。hook プロセスは自分が
  どの distro から呼ばれたかを知らない（`WSL_DISTRO_NAME` は `WSLENV` に載らない）ので、
  **登録するときにコマンド行へ書いておく**（`--install-key=`）
- **`transcript_path` の分解に `Path` を使わない**。区切りの解釈はターゲット依存で、macOS では
  `\` がただの文字になる。Windows で走る Pike には WSL の `/home/...` と Windows の
  `C:\Users\...` の両方が届くので、両方を区切りとして扱う
- **捨てる口が要る**（`forget_declarations`）。申告は `.envrc` とシェルの環境変数より優先される
  ので、hook を入れていないアカウントへ起動ラッパーを切り替えると、**古い申告がそのプロジェクトを
  恒久的に古いアカウントへ縛る**。設定画面のゴミ箱と、hook を外したときの後始末がここを通る

### hook の登録先と `settings.json` の書き換え

- **登録先は 1 つではない。** 設定画面は**ホーム直下の設定ディレクトリらしいものを全部並べて**、
  それぞれに登録できるようにする（`candidate_dirs`）。解決結果だけを宛先にすると、まだ申告が
  届いていないあいだは既定の `~/.claude` しか出ず、実際に使っている別の設定ディレクトリへ
  hook が入らないまま「登録済み」に見える＝申告が永久に届かない
- **候補はプロジェクトのシェルに絞らない**（`shells_for_targets`）。hook はアカウントごとに持つ
  もので、そこはマシン全体の話。Windows のプロジェクトを開いているからといって WSL の
  `~/.claude` を隠すと、**WSL で claude を使っている人が登録できない**。distro の一覧はフロントが
  渡す（設定タブが既に検出しているものを使い回し、Rust 側で `wsl.exe` を増やさない）。宛先ごとに
  シェルが違うので、`HookTarget` は `install_key` と `command` を持ち、install / uninstall は
  それを受ける
- **`settings.json` は Claude Code 自身も書き戻すファイル**なので、`hooks.SessionStart` に 1 グループ
  足すだけにする。`serde_json` の `preserve_order` を有効にしてあるのは、触っていないキーまで
  並び替えて返さないため
- **`settings.json` は symlink でありうる**（dotfiles から配る構成、#320）。ここを踏むと**利用者の
  設定が hook だけの内容に置き換わる**ので、読み書きは次を守る:
  - **UNC 越しに触らない。** `\\wsl.localhost` から見た WSL の symlink はリパースポイントで、
    Windows API は追従できず `NotFound` を返す。**読みも書きも distro の中で行う**
    （`fs::read_text` と `fs::write_bytes_atomic`。対になるので両方 `fs` に置く）。候補の列挙
    （`read_dir`）だけは UNC のままなので、リンクを辿る述語を使わない: 中身の有無は `exists()`
    ではなく `symlink_metadata()`、ディレクトリかの判定は `DirEntry::file_type()`（辿らない）
    ではなく `metadata()`（辿る）で見る。**後者が効くのはホスト側だけ**で、`~/.claude` ごと
    symlink にした WSL の構成は UNC の限界でどのみち中を読めない
  - **存在の判定に `-e` だけを使わない。** あれもリンクを辿るので、リンク先がまだ無い symlink
    （dotfiles を展開していないマシン）を「無い」と言う。そこで書くと、解決した先＝dotfiles の
    中に hook だけのファイルを作る。`[ -e p ] || [ -L p ]` で「リンクはある」ほうへ落とし、
    `cat` の失敗として `Err` にする
  - **書き込みは元のモードを引き継ぐ**（`chmod --reference` / `set_permissions`）。tmp + `mv` は
    新しい inode を被せるので、0600 の設定が umask 次第で 0644 に緩む（`env` に鍵を置く人が
    いる）うえ、リンク先が dotfiles なら登録のたびに mode の差分が出る。一時ファイルの後始末も
    `mv` の失敗だけでなく `trap ... EXIT` で見る（`cat` が途中で落ちると `.tmp` が残る）
  - **「読めなかった」を「無い」と混ぜない。** 無ければ `None`（新規作成してよい）、読めなければ
    `Err`（**書かない**）。混ぜると、読めないファイルを空とみなして丸ごと上書きする
  - **`rename` の前にリンクを辿る**（`fs::write_bytes_atomic`）。素朴な「一時ファイル ＋
    `rename`」は symlink そのものを置き換える。同じ理由で `agent_hook::write_atomic`（申告の
    置き場専用）を利用者のファイルに使わない
  - 壊れ方は静かで、書き込みは成功しているのに読めないので設定画面は「未登録」のまま、という
    形で出る。`agent_hook_install_missing` は「1 つでも書ければ成功」なので、承諾したあとに
    未登録が残ったら**フロントが知らせる**（`useAgentHookPrompt`）
  - **同じ盲点が `claude_usage::config` の読みに残っている**（既知の制約）。`.claude.json`
    （アカウント）と `CLAUDE_CONFIG_DIR` の実在確認（`is_dir`）は UNC 越しの `std::fs` のままなので、
    そこを symlink で配っている構成ではアカウントが空になるか、既定の `~/.claude` に落ちる。
    `.claude.json` は Claude Code が数十秒ごとに書き換えるカウンタ置き場なので symlink で配る
    動機が薄く、直すなら `resolve` ごと distro の中へ移すことになる
- **開発ビルドは hook のコマンドに自分自身の絶対パスを書く**（`hook_command`）。PATH の
  `pike.exe` はインストール版なので、そのままでは開発中の変更を確かめられない
  - **Windows 向けの綴りではバックスラッシュを残さないこと。** hook を走らせるシェルは Claude Code
    が選び、Windows の既定は Git Bash。そこへ `C:\Users\...` を裸で渡すと `\` がエスケープとして
    食われ、`command not found` になる。スラッシュに直せば Windows API がそのまま解決する。
    **常に引用符で囲むのも駄目**で、PowerShell は引用符で始まる行を文字列式として評価する
    （実行には `&` が要る）
  - **開発版で通知を試したら、あとでインストール版から登録し直す**（#339）。デバッグビルドの exe は
    `windows_subsystem = "windows"` を持たない（`main.rs` は `not(debug_assertions)` のときだけ
    付ける）ので、**hook として起動されるたびにコンソールが一瞬出る**。登録し直せば 4 行とも
    `pike.exe` に揃う（`ensure_hook` は綴りの違う行にも手が届く）
- **登録済みの判定は緩く**（`has_hook`。コマンド行にサブコマンドを含むか）。置き場を共有して
  いるので 1 行あれば足り、**綴りが違う行にも手が届く**（パス表記を直した版から古い行を消せる。
  完全一致だと、直した瞬間に「未登録」へ化けて古い行が UI から消せなくなる）
- **外す口も持つ**（`remove_hook`）。開発版が書くのは `target/debug` の絶対パスなので、ビルドを
  消すと死んだ行になり、`SessionStart` のたびに Claude Code のトランスクリプトへエラーが出る。
  利用者が置いた別の hook は残す。空になった入れ物（`"SessionStart": []` / `"hooks": {}`）は
  畳んで、足す前の形に戻す
  - **空にしたグループだけを落とす**（`retain_mut` の中で判定）。「1 つでも消したなら空の
    グループを全部落とす」だと、元から `"hooks": []` だった利用者のグループまで消える
  - **`Map::remove` を使わないこと。** `preserve_order` の下では `swap_remove` で、末尾のキーが
    削除位置へ動く＝あの feature を入れた理由を自分で壊す。`shift_remove` を使う
    （`preserve_order` を外すとコンパイルエラーになるので、意図が型で守られる）
- **シェルごとに 1 度だけ提案する**（`composables/useAgentHookPrompt.ts`）。設定画面まで来ない
  人は、推測が外れていることに気付きようがない。聞く条件と「聞いた記録」の置き場は、あの
  ファイルの doc が正本。要点は 4 つ: **main ウィンドウだけ**（マシン全体の話なので、復元で開く
  各ウィンドウが聞くことではない）、**そのシェルの候補に未登録があるとき**、**そのシェルに
  ついてまだ聞いていないとき**、**候補は今のシェルとホストのぶんだけ**（全 distro を並べると
  起動時に `wsl.exe` が要る＝`os-integration.md` の規約に反する）
  - **「マシンに 1 つ」の判断にしないこと。** 「1 つでも登録済みなら聞かない」「断ったら二度と
    聞かない」だと、Windows のプロジェクトで承諾しても WSL 側には何も入らないまま「登録済み」と
    見なされる。hook は設定ディレクトリごとに要り、その置き場はシェルで変わるので、記録も判断も
    シェル単位（`types/tab.ts` の `installKey`）にする
  - **契機はプロジェクトの切り替え**（`App.vue` の watcher）。記録があれば IPC を投げずに戻るので、
    切り替えのたびに `agentHookStatus`（解決 ＋ 候補ぶんの `settings.json` 読み）を払わずに済む
