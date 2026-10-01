---
paths:
  - "src-tauri/src/watcher/**"
  - "src/composables/useFsWatcher.ts"
  - "src/components/WatcherNotice.vue"
  - "src/components/ToolNotice.vue"
  - "src/stores/fileTree.ts"
---

# ファイル監視（File Watcher）実装ルール

実体は `src-tauri/src/watcher/`、`src/composables/useFsWatcher.ts`、`src/stores/fileTree.ts`。
監視を受けるエディタ側（外部変更・自己書き込み）の規則は `editor.md` の「保存の責任」。

## 仕組み
- Windows / macOS プロジェクト: `notify` クレート（v7）で再帰監視（Windows は `ReadDirectoryChangesW` ベース）
- WSL プロジェクト: `wsl.exe inotifywait -m -r` を長寿命サブプロセスとして起動（**`inotify-tools` が必須**）
- イベントバッチ処理: 200ms デバウンス + 1s max wait でフロントに送信
- `IGNORED_DIRS` (.git, node_modules 等) をフィルタ
- `fs_changed` イベントで `changedDirs`（ツリー更新用）+ `changedFiles`（エディタ更新用）を送信
- エディタ外部変更検知: clean タブは自動リロード（見えていないタブは見えたときに。#433）、dirty タブはインライン警告バー（Reload/Overwrite/Dismiss）
- 自己書き込み除外: `markRecentlySaved()` がパスごとに印を置き（2 秒で失効）、`isRecentlySaved` が通知 1 回ぶんで使い切る（理由は `editor.md` の「保存の責任」と `useFsWatcher.ts` の doc）
- ウィンドウ破棄時に全 watcher 停止（`watcher::stop_all`）
- Rust 側は `watcher::WatcherState` を `manage` して持ち、`fs_watch_start` / `fs_watch_stop` コマンドで出し入れする
- **`changedDirs` の受け手は `stores/fileTree.ts` に置く（#303）。** パネルは `v-if` で
  マウントされるので、あちらで購読すると別のパネルを見ているあいだ購読ごと外れる。溜めて
  おく仕組みと、それを `ensureInit` で流す理由は、あのファイルの doc コメントが正本
- **パスの比較は文字列一致**（root か、展開中のディレクトリか）なので、`activeRoot` は
  末尾の区切りを落とした値を配る（`lib/paths.ts` の `stripTrailingSep`）。**逆に、
  正規化済みの `activeRoot` と生の `project.root` を突き合わせないこと**: 末尾に `/` の
  付いた root が実在するので、その比較は永久に false になる（「worktree に居るか」は
  `activeWorktreeRoot` を見る）
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

## 監視が落ちたことを知らせる（#385）
- **WSL の監視が落ちたことは stderr でしか分からない。** 起こすのは `wsl.exe` なので、distro の
  中に `inotifywait` が無くても **spawn は成功する**（子が終了コード 1 と
  `execvpe(inotifywait) failed: …` を残して消えるだけ）。stderr を読み、子が終わったら
  `fs_watch_failed` で知らせる
- 理由は Rust が当てる（`classify_watch_failure`）。`MissingTool` はダイアログで
  インストールを提案し（`askToInstallInotify`。聞くのはシェルの導入単位ごとに 1 度で、
  **他のダイアログが開いていたら譲る・記録は答えのあと**＝`useAgentHookPrompt` と同じ
  作法）、残りはパネルと設定画面の帯に出す
  - **`wsl.exe` が出す綴りは 1 つではない**（#396）。`CreateProcessCommon:818:
    execvpe(inotifywait) failed: …` と `CreateProcessEntryCommon:502: execvpe
    inotifywait failed 2` の両方がある。関数名も括弧の有無も WSL の版で変わるので、
    `execvpe` とコマンド名の同居で見る（括弧まで見ると、後者が `Other` に落ちて生の WSL の
    エラーが帯に出る）
- **理由は enum で持つ**（`WatchFailReason`）。この値は Rust の分類器・TS の union・
  i18n のキー（`watcher.<reason>`）の 3 か所を渡り歩くので、`&'static str` だと 4 つ目を
  足したときにどこも照合してくれない（`translate` は知らないキーをそのまま返すので、
  帯にキー文字列が出る）。serialize は camelCase で、**綴りは Rust 側が正本**
- **提案と実行を分ける**（`installInotify`）。帯のボタンが出ている時点で提案は必ず
  済んでいるので、提案の側へ繋ぐと「聞いたか」の記録に当たって**押しても何も起きない
  ボタン**になる
- **「聞いた」の記録は `lib/storage.ts` の `loadAskedKeys` / `rememberAskedKey`**。
  **書く直前に読み直す**のが共有している理由で、ダイアログを開く前に読んだ配列を
  そのまま書き戻すと、待っているあいだに別のウィンドウが足したキーを消す。鍵は `shellId` ではなく
  **`installKey`**（`useAgentHookPrompt` と同じ単位）
- **理由と文言を別々の ref にしない**（`WatchNotice` の 1 本）。3 か所すべてで対で
  代入・対でクリアされるので、分けると「理由は null なのに文言は前回のまま」という
  表せてはいけない状態が作れる。**案内の文面は computed で引く**（`t()` の結果を ref に
  焼き込むと、UI 言語を切り替えても帯だけ古い言語のまま残る）
- **帯は `components/WatcherNotice.vue` の 1 部品**（ファイルツリーと設定画面で共有。書き写すと
  同じ役目のボタンが 2 つの画面で違う位置に出る）。**状態は props で受けない**（置いた側が
  読み直す形にすると、どの理由でボタンを出すかの判定が置いた数だけ増える）
- **子が死んだら Rust 側が自分で後始末する**（`report_watch_failure` が印を立てて
  `handles` から外す）。フロントは id を落とすだけで `fs_watch_stop` を投げない。投げると
  死んだ PID に `taskkill` を撃つことになり、Windows が再利用していれば無関係な
  プロセスツリーを殺す
- **`--exclude` はイベントを捨てるだけで監視は張る。** `node_modules` も上限
  （`fs.inotify.max_user_watches`）を消費するので、大きなツリーでは `WatchLimit` に来る
- **自分で止めたときは知らせない**（`stop_flag` を見る）。プロジェクトの切り替えや
  ウィンドウの破棄で毎回ダイアログが出てしまう
- **stderr の読み方は `types::drain_stderr`**（`spawn_capped_lines` と共有）。上限で
  読むのをやめるとパイプが閉じて子を殺し、`read_to_string` は不正な UTF-8 で buf を
  空のまま残す。理由はあの関数の doc が正本
- **ネイティブ側（`notify`）の失敗も同じ口から知らせる。** コールバックの `Err`
  （`MaxFilesWatch`、root の消滅や改名のあとの `ReadDirectoryChangesW`）を捨てると、
  Windows / macOS では監視が死んでも誰にも届かない。理由は当てられないので `Other` で、
  `detail` に `notify` の文言を入れる
- **落ちた監視は帯の「再開」で張り直せる（#433）。** `fsWatcher.restart` が `lastTarget`
  （直近の `start` の相手）で `start` をやり直す。Rust 側に足したものは無い（落ちた監視は
  `report_watch_failure` が片付け済みなので、新しく起こすだけでよい）
  - **ボタンを出す理由は `WatcherNotice.vue` の `action` が正本**。`other` と `watchLimit` は
    再開、`missingTool` はインストール、`wslUnc` は出さない（監視は動いている）。帯のボタンは
    1 つなので、理由ごとに 1 つを選ぶ
  - **張り直したら、止まっていたあいだのぶんを取り直す**（`fsWatcher.onRestart`）。何が
    変わったかは分からないので、受け手がそれぞれ全部変わったものとして扱う。主な受け手は 2 つ:
    `stores/fileTree.ts`（展開中のディレクトリを `applyDirChanges` へ流し、畳んであるものは
    キャッシュを捨てる）と `App.vue`（今のプロジェクトのエディタタブに `externalChange`、
    作業ツリーの diff タブに `staleAt`）。**取り直しを省かないこと**: 省くと「監視は動いて
    いる」のに画面が古く、編集中のタブの次の保存が、止まっていたあいだの外部の書き込みを
    黙って上書きする
  - **編集中のタブには、変わっていなくても警告バーが出る**。消せる誤検知のほうを採る
    （自己書き込みの印を 1 回で使い切るのと同じ判断）
  - **消えたファイルは `fsExistingPaths` で先に見分けて `deleted` を立てる。** `modified` だと
    未編集のタブは読み直しに進み、読み直しは無いファイルを空の新規ファイルとして返すので、
    本文と Undo の履歴が消える
  - **監視の出し入れは 1 つずつ順に走らせる**（`useFsWatcher.ts` の `enqueue`）。
    `fsWatchStart` を待つあいだは id がまだ無いので、重なると止める相手を知らないまま
    2 本目を立て、先の 1 本が残る。`restart` は順番が来た時点で監視が動いていれば何もしない
  - **`inotify-tools` を入れた直後の張り直しも同じ道**（`installInotify` の `onExit`）。
    入れるまでのあいだの変更も届いていない
  - HTML / Vue のプレビュー（`usePreviewRefresh`）も `onRestart` を受けて描き直す。受け手を
    足すときは、コンポーネントの寿命のものは返り値で購読を外す（`onFileChange` と同じ）
  - **未編集のタブの読み直しは、見えていなければ見えたときまで遅らせる**（`EditorTab.vue` の
    `reloadWhenShown`。diff タブの `staleFromDisk` と同じ形）。張り直しは開いているタブ全部に
    知らせるので、その場で読むと WSL では 1 枚につき `wsl.exe` が 3 本（stat・cat・`git diff`）
    一度に立つ。**この遅延は普段の外部変更にも効く**（知らせの出所を区別していない）。
    遅らせているあいだに削除の知らせが来たら、読み直しは捨てる
- **Windows の種別で WSL の UNC パスを監視している構成は、静かに何も届かない。**
  `\\wsl.localhost\...` に対する `ReadDirectoryChangesW` は**開始が成功するのに、WSL の
  中からの書き込みを 1 件も受け取らない**（9p 越しでは通知が上がらない。実測済み）。
  エラーが出ないので `inotify-tools` の不在より気付きにくい
  - 判定は**フロントの `unwatchableWslUnc`**（`isWindowsShell` かつ `wslUncToNative` が
    当たる）。Rust に置かないのは、根がプロジェクトの種別で、直し方が「WSL のプロジェクト
    として登録し直す」＝Rust の知らない話だから。材料（シェルと root）は `start()` が持っている
  - **監視は止めない**（Windows 側からの変更は届く）ので、`fs_watch_failed` は通さず
    `wslUnc` の帯を出すだけ。**理由の集合がフロントで 1 つ広い**のはこのため
