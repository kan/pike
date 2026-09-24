---
paths:
  - "src-tauri/src/project/**"
  - "src/stores/project.ts"
  - "src/stores/tabs.ts"
  - "src/types/project.ts"
  - "src/lib/project*.ts"
  - "src/components/ProjectSwitcher.vue"
  - "src/components/ColorDot.vue"
  - "src/components/ProjectIcon.vue"
  - "src/components/panels/Project*.vue"
  - "src/components/panels/GroupComboBox.vue"
  - "src/components/panels/ColorSelect.vue"
  - "src/components/panels/IconSelect.vue"
  - "src/components/layout/ProjectSelect.vue"
  - "src/composables/useTerminalPeek.ts"
  - "src/composables/useProjectAccent.ts"
---

# プロジェクト実装ルール

プロジェクトの登録・設定・切り替え・保持、一時プロジェクト、セッション永続化。
実体は `src-tauri/src/project/` と `src/stores/project.ts`。関連する規則は別ファイルにある:
設定とプロジェクト一覧の同期は `sync.md`、ウィンドウの生成・永続化・背景透過は `window.md`、
グローバルモード・`pike` CLI・ジャンプリスト・トレイは `os-integration.md`。

## 登録の UI（#373）

**登録で聞くのはディレクトリ 1 つだけ。** 入口は「ディレクトリを登録」（プロジェクト
パネルの上と、スイッチャーのフッター）で、どちらも `pickFolder` →
`openDirectoryAsProject` を呼ぶ。名前はディレクトリ名、プラットフォーム・distro・シェルは
backend の推測、色とアイコンは未設定。

- **フォームを復活させないこと。** ルートを決めればプラットフォーム・distro・シェルは推測
  できる（「ディレクトリを開く」#230 の経路が推測している）。フォームにすると、1 手で
  終わることを 7 項目で聞くことになる
- **細かい設定は登録のときに聞かない。** 名前・色・アイコン・グループ・シェルは、
  プロジェクトパネルの行の鉛筆（`ProjectListItem.vue` の編集フォーム）で直す。登録の直後に
  そこを開くこともしない（付けない人に閉じる手間が増える）。代わりに登録したことを
  ステータスバーに 1 回出す（`notifyRegistered`）
- **ルートを手で打つ欄は持たない。** まだ存在しないディレクトリを登録する使い方は持たない。
  作るなら選択ダイアログの「新しいフォルダー」を使う
- **ターミナルの cwd で欄を埋める仕掛けは置かない。** 開いただけで「今見ているターミナル」の
  cwd が入ると、登録したいディレクトリとは限らない値が黙って入る。代わりに**押したときだけ**
  動く入口を 3 つ置いてある: ターミナルタブの右クリック、ステータスバーの「未登録」バッジ、
  パレットの `registerTerminalCwd`
  - **どのターミナルかは `resolveTargetTerminal`**（`useTerminalInject`）。右クリックだけは
    そのタブが相手。各所で選び直すと、流し込みと登録で別のタブを相手にしうる
  - **`pty_get_cwd` は「Pike が扱える形」で返す**（#373）。Git Bash は OSC 7 で MSYS の
    パスを名乗る（`/c/Users/x`）ので、`types.rs` の `msys_to_windows` で直してから返す。
    **変換を呼び出し側に置かないこと**: 消費者は登録とエージェントのセッション一覧の
    2 つで、どちらも綴りが合わないと黙って壊れる（前者は Windows が解決できない root を
    作り、後者は一覧が常に空になる）。**しかも形式はセッションの途中で変わる**（spawn 時の
    cwd は Windows のパスで、最初のプロンプトで MSYS に入れ替わる）ので、見分けを消費者に
    やらせると必ず片方が落ちる。名前を付けられない場所（`/usr/bin`）は `None`
  - **ステータスバーの「未登録」バッジは別物**。あれが登録するのは**ウィンドウが開いて
    いるディレクトリ**（`registerTransientProject`）で、ターミナルの現在地ではない。
    `cd` したあとは 2 つが食い違う
  - **バッジだけは確認を挟む**（`StatusBar.vue` の `registerTransient`）。名乗っているのが
    状態（「未登録」）であって操作ではないので、押した先が `project.json` への書き込みだと
    読み取れない。**確認を `registerTransientProject` の中へ置かないこと**: 「プロジェクトに
    登録」と名乗っているパネルの帯のボタンにも付く
- **スイッチャーに「登録」は置かない**。あそこの「ディレクトリを開く」は**登録するかを
  設定（`registerDirectory`）に従って決める**ので、開いたあとでも登録するか選べる（#230）。
  必ず登録する入口はプロジェクトパネルの「ディレクトリを登録」1 つ

## プロジェクト管理
- プロジェクト設定は `%APPDATA%/{identifier}/projects/{id}/project.json` に保存（identifier は `tauri.conf.json` の値で、現在は `com.pike.dev`。古い環境に残る `com.tauri.dev` のディレクトリは雛形の名残で、使っていない）
- **`last_project.txt` は 1 行 1 ウィンドウ**で `見せていたid <TAB> 保持していたid...`（#264）。起動時は 1 行につき 1 ウィンドウを復元する。タブを持たない古い形式（1 行 1 id）はそのまま「保持なし」として読める
  - **書き込みは全量書き直し**（`write_open_windows`）。追記と部分的な削除で保とうとすると、1 つのウィンドウで A → B と切り替えたとき A の記録が残り、次の起動で A と B が別々のウィンドウで開く。生きているウィンドウの状態を写せば、その手のずれが起きない
  - 一時プロジェクト（#230）は `project.json` を持たないので、書き出しのフィルタで落ちる（#230 の「同期ファイル等に出さない」を、読み側だけでなく書き側でも守る）
  - **保持ぶんのタブは起動時に作らない**。タブの中身は常にマウントされる＝作った瞬間にその数だけシェルが立ち上がるため。切り替えたときに通常のセッション復元が走る（`switchProject` は「タブが無ければ復元する」なので、そのまま乗る）
  - **`shown` と `held` は `project_for_window` が 1 回で返す**。分けると、フロントが 2 回に分けて読むあいだに自分の `project_set_parked` が同じ entry を上書きし、復元した保持一覧が黙って消える。1 回で返せば順序の問題自体が無くなる
  - 書き込みは**同じ内容なら書かない**（`last_written_sessions`）。1 回の切り替えで `project_add_open` と保持一覧の通知が続けて来るので、そのままだと同じ内容を 2〜3 回書く。ファイル書き込みのあいだ `window_projects` のロックを握らない（`project_for_window` は UI スレッドで走る同期コマンド）
- プロジェクトは WSL / Windows / macOS ローカル（`unix`）の 3 プラットフォームに対応。一覧の正本は `lib/projectPaths.ts` の `PROJECT_PLATFORMS` で、型も実行時検証もそこから導く（`.claude/rules/platform.md`）
- WSL プロジェクト: ディストロ指定、ルートは WSL パス
- Windows プロジェクト: デフォルトシェル（cmd/PowerShell/Git Bash）選択、ルートは Windows パス
- **プロジェクト切替でタブを捨てない（#264）**: `switchProject` は kill せず、`tabStore.setOwnerProject(id)` で見せる相手を差し替えるだけ。ターミナルのプロセスとエージェントのセッションが生きたまま残る（切替時の「実行中ですが良いですか」の確認も要らない）。初めて開くプロジェクトだけ `lastSession` / `pinnedTabs` から復元する
  - **仕組みは既にあったものに乗っている**: `TabPane` は全タブをマウントしたまま `v-show` で出し分けているので、パークしたタブは「タブバーに出ない非アクティブタブ」でしかない。サイズ 0 での `fit()` 等の既存のガードがそのまま効く
  - **Rust 側にバッファを持って再アタッチする案は採らない**。フルスクリーン TUI（claude / vim）は再描画されないと崩れるので、生バイトを新しい xterm に流し込む形では tmux 相当の画面状態の再構築が要る
  - 所有 id を付けるのは `stores/tabs.ts` の `pushTab` の 1 箇所（作る側は 12 箇所ある）。**シングルトン（設定 / エージェント状態 / マニュアル）は `projectId: null`＝ウィンドウ単位**。プロジェクトに属させると「プロジェクトごとに 1 つ」になり、シングルトンの意味が壊れる。種別の一覧は `types/tab.ts` の `SINGLETON_KINDS` が正本（`lib/tabTitle.ts` と共有）
  - **`tabs`（全部）を直接読んで良いのは 2 つだけ**: id で 1 つ引くとき（タブのコンポーネントは自分の id で引く）と、`TabPane` の**中身**の `v-for`（マウントしたままにするのが目的なので全部要る）。**それ以外は `visibleTabs`**（タブバー・ナビゲーション・`@` モード・ターミナルへの注入・セッションの書き出し・空表示の判定・既定ターミナルの有無・ファイル変更の反映）
    - この分け方は散文では守れない（`.claude/rules/git.md` の `activeRoot` と同じ構図で、**安全なほうに長い名前が付いている**）。取り違えると、A を保持したまま B を初めて開いたとき B に既定ターミナルが作られない、のような形で出る。新しい消費者を書くときは、まず `visibleTabs` から考える
  - **タブの持ち主が消える経路を塞ぐ**: 一時プロジェクト（#230）から離れるときと、プロジェクトを削除するときは、先に `closeProjectTabs` でタブを手放す（あとに回すと、一覧に出ないのにプロセスを抱えたタブが残る）。一時プロジェクトを登録して id が変わるときは `renameProjectOwner` で付け替える
  - **持っているものを Rust に伝える**（`project_set_parked` → `ProjectState.window_projects`）。ジャンプリスト / トレイ / `pike <dir>` の解決はあちらで行われるので、伝えないと保持中のプロジェクトを開くたびに新しいウィンドウができ、同じリポジトリでエージェントが二重に動く
    - **マップは 1 本**（`WindowProjects { shown, held }`、`held ⊇ {shown}`）。「見せている」と「保持している」を別のマップに割ると、同じ問いに答えが 2 つでき、掃除も書き込みも 2 経路になる。`window_holding` が「どのウィンドウが持っているか」と「それを今見せているか」を 1 回で返し、`focus_project_window_anywhere` は後者で focus と切り替えを分ける
  - 逃げ道は UI に出す（#264 の判断）: プロジェクト一覧とスイッチャーの「保持中」バッジ、`ProjectSelect` のプルダウンとその ✕、パネルの電源ボタン
    - **ウィンドウタイトルには出さない（#305）。** 保持が増えるほど長くなり、タスクバーで煩い。タイトルは今見せているプロジェクトだけにする
    - **解除の実体は `releaseProject` の 1 つ**（パネルとプルダウンが共有）。**タブがあるときだけ確認する**: 復元待ちのものは動いているプロセスが無いので、「実行中のプロセスも終了します」と聞くのは嘘になる
    - ✕ は現在地以外の行にだけ出す。現在地に出すと「今見ているプロジェクトのタブを全部閉じる」になり、解除とは別の操作になる
  - **一時プロジェクト（#230）はプルダウンの一覧に出さない**。あれは切り替えると破棄されるので、「戻ってきたらそのままある」という一覧の約束を満たさない（出るのに戻れない、という食い違いになる）。出すと、行き先ではないのに ✕（保持の解除）が付く。**一覧に並ぶのは「保持しているもの」だけ**という不変条件を保つ。**ボタンのラベルには出す**: あちらは「今どこにいるか」で、登録していないディレクトリを開いているときこそ見えていてほしい。「未登録」の印は StatusBar が出しているので、こちらに写しを作らない
  - **並びは `heldIds`（順序つきの 1 本）で固定**し、選択でも materialize でも入れ替えない（押すたびに行き先が動くと狙えない）。開いた順に足し、手放すまで残す（タブを 1 つも持たないものも入る。#301）。「まだタブを作っていない」は別のリストではなく `hasTabsFor` の否定で表す（2 本にすると、pending から実体化した瞬間に並びが変わる）。**タイトルだけは現在地が先頭**: タスクバーでは「今どれか」が先に読めるほうが良く、並びを覚えて押す対象でもない
  - **タブが尽きたことを理由にウィンドウを閉じないこと（#301）。** 閉じると保持しているぶんが `last_project.txt` ごと消える。閉じてよいかを決めるのは `App.vue` の `tabs.length` の watcher 1 箇所で、ショートカットの側（`useAppActions` の `closeTab`）は何もしない。理由は `stores/project.ts` の `heldIds` の doc コメントが正本
  - **切替 UI の置き場所はサイドバーのパネルの開閉で変わる（#298）**。開いていればサイドバーの最上部（アイコン列とパネルにまたがる帯）、閉じていればタブバーの左。`components/layout/ProjectSelect.vue` の 1 部品を `SideBar` / `TabPane` が `v-if` で出し分けるだけで、部品側は自分がどちらに居るかを知らない。畳んだサイドバーは 48px しかなく名前が読めないので、そこには置かない。グローバルモードのウィンドウはプロジェクトを持たないため、部品側の `v-if` で何も描かれない
    - 保持中のプロジェクトは常に 1 つのボタンに畳む。横並びにすると保持している数だけ横幅を取ってタブを圧迫する
    - サイドバーは**2 列 2 行の grid**。アイコン列が `grid-row: 1 / -1` で上まで通り、帯はその右（`grid-column: 2` / `grid-row: 1`）に入る。パネルの開閉でアイコンの位置が動かないのが要点。flex の行に包み直しても得るものは同じで、テンプレートを字下げし直すだけになる
    - **帯は列の幅を決めない**（`width: 0` ＋ `min-width: 100%`）。`auto` の列は max-content で広がるので、素のままだと長いプロジェクト名がパネルより広い列を作り、明示 width を持つ `.panel` の右に死んだ帯が残る（リサイズハンドルもサイドバーの右端から離れる）
  - **プルダウンの行からターミナルをチラ見できる（#319）**。**判断の実体は `composables/useTerminalPeek.ts` の doc が正本**（なぜ Rust に溜めないか、`useOutlineSource` と形を分ける理由、時刻を reactive にしない理由）。ここに写しを置かない
    - `TabPane` が `tabs`（全部）をマウントしたままなので、保持中のプロジェクトの xterm も出力を受け続けている（#264）。足りないのは**外から読む口**だけ
    - **アイコンだけをホバー対象にする。** 行全体だと、切り替えようとして通っただけでポップアップが出る
    - **横に出す**（`placeBesideAnchor`）。上下だと一覧そのものに重なって、どの行のものか分からなくなる
    - **フォントはターミナルの設定から流し込む**（`settingsStore.fontFamily`）。既定の `monospace` のままだと、罫線・ブロック文字・全角の幅が xterm と揃わず TUI の画面が崩れる
    - 対象は `tabStore.terminalForProject`＝**そのプロジェクトで最後に選んでいたターミナル**。`lastTerminalId`（注入先。フォーカス基準）とは別の問いなので、値を分けて持つ
- Windows プロジェクトでは「+」ボタン横のドロップダウンでデフォルト以外のシェルも選択可能
- プロジェクトのグループ分け: `ProjectConfig.group?: string` で各プロジェクトの所属グループを保持。グループ一覧と表示順は `%APPDATA%/{identifier}/groups.json` に明示的に永続化（プロジェクト未割当の空グループも保持可能）。`project_groups_list` / `project_groups_save` コマンドで CRUD
- ProjectPanel UI: 未分類プロジェクトはリスト直下にフラット表示（ヘッダーなし）、グループ所属はグループバー配下に折りたたみ可能で配置。「+ グループを追加」ボタンで空グループを作成、グループバーの鉛筆で一括リネーム（所属プロジェクトの `group` も更新）、✕ で削除（所属プロジェクトは ungroup）
- プロジェクトの編集フォームではコンボボックス形式: `<select>` で「グループなし / 既存グループ / + 新規グループ...」、新規選択で text input に切替
- **表示モード（#203）**: `グループ別`（既定）と `最近開いた順` の 2 つ。`最近開いた順` は**グループでまとめずフラット**に並べ（並びはストアの `recentProjects`。スイッチャーと共有する）、代わりに行にグループ名バッジを出す。`グループ別` は手動順（後述）→ 名前順。モードは `localStorage` (`pike:project-sort-mode`)、折りたたみ状態は同 `pike:project-group-collapsed` に永続化
- **描画は 1 本の `rows` computed**（`PanelRow` = group ヘッダ or project 行の判別 union）に集約する。`siblings` はその行にドロップしたときの並び替えスコープ
- **絞り込み（#203）**: パネル上部の常設入力。`lib/paths.ts` の共有 `fuzzyMatch` で name / root / group を対象（`ProjectSwitcher` / `QuickOpen` もこれを使う。ローカルに複製しない）。グループ別表示では一致 0 件のグループを隠す
- **装飾の役割分担（#203）**: 「このウィンドウで開いているプロジェクト」は**行全体の塗り**で示す（プロジェクトカラーがあればその色、無ければ `--accent`）。グループバーは背景＋枠だけの見出しにする（開いているプロジェクトの印と紛れないように）。塗りの上の文字色は `lib/projectColors.ts` の `readableTextOn`（相対輝度で黒/白を選ぶ。閾値 0.179 は白背景・黒背景の WCAG コントラストが入れ替わる点）で決め、行内の meta / アイコン / アクションボタンは `color: inherit` にして塗りに追従させる。プリセットは黄色から紫まであるので、白固定でも黒固定でも読めない色が出る
- **ドラッグ&ドロップ（#203）**: `useDragAndDrop` の drag id に `project:{id}` / `group:{name}` の複合キーを載せて種別を判別する（グループ名に `:` を含みうるので先頭の `:` で分割）。挿入位置は TabPane と同じ midpoint 判定の縦版で、`insertAt` は**先に対象を配列から除いてから挿入**するので `from < to` の補正が要らない。行へのドロップ＝並び替え＋その行のグループへ移動、グループバーへのドロップ＝そのグループの末尾へ。**並び替えはグループ別表示かつ絞り込み無しのときだけ**（`recent` は recency 固定、絞り込み中は表示インデックスが実体とずれる）。グループバーへの所属変更はグループ別表示なら常に可能
- **手動順（#203）**: `ProjectConfig.order?: number`（TS と Rust の両方に必要。Rust 構造体に無いフィールドは次の全量書き戻しで消える）。スコープはグループ単位（未分類も 1 スコープ）で、並びは `(order ?? MAX) → name`。`reorderProjects(orderedIds, group)` が 0..n-1 を振り直し、**実際に値が変わるプロジェクトだけ**保存する（1 件の保存が `project_update` 全量書き＋全ウィンドウ broadcast のため）。グループ順は `groups.json` の配列順そのものなのでスキーマ変更なし（`reorderGroups`）
- プロジェクトカラー（#121）: `ProjectConfig.color?: string` は**プリセット名**（'red' 等）を保存し、hex は描画時に `lib/projectColors.ts` の `projectColorValue` で解決（パレット調整が config 移行なしで効く。手編集の生 hex `#rrggbb` のみ許容し、`url()` 等の任意 CSS 値は style バインドに到達しない）。プリセット 8 色は musql と同一パレット、name が i18n キー `projectColor.{name}` を兼ねる。選択 UI は `panels/ColorSelect.vue`（スウォッチ付きカスタムドロップダウン。close は他メニューと同じ「open 時に window mousedown を once で張る + ルートで `@mousedown.stop`」方式）で、ProjectPanel の作成・編集フォームと ProjectSwitcher の新規作成モーダルに配置。表示はカラードット共通コンポーネント `ColorDot.vue`（ProjectPanel 一覧・ProjectSwitcher）と、**サイドバーのアイコン列とプロジェクトバーの下地**（#298）
  - ウィンドウ左端に色の線は置かない。同じ色の面がちょうどその位置に来るので、線を足しても見えない
  - **色の導出は `composables/useProjectAccent.ts` の 1 つ**（`{ bg, fg }`）。塗る場所が 2 つあり、しかも隣り合って 1 つの帯に見えるので、片方だけ「未設定のときどうするか」がずれると継ぎ目で色が割れる。**既定色は composable が決めない**: アイコン列（`--bg-secondary`）とプロジェクトバー（`--tab-hover-bg`）で素の下地が違うため、それぞれの CSS の `var(--…, 既定)` に置く
  - **上に載るものは全部読める色に振り替える**（`--icon-strip-fg`）。アイコン・アクティブ印（既定は `--accent` の青で、色の上ではぶつかる）・件数バッジ（地と文字を反転）・マーカー。灰色のままだと黄色や明るい緑の上で沈む
  - **下地は `--surface-alpha` で合成する**（#162）。プロジェクトカラーは生の hex なので、そのまま敷くと透過・アクリルのときにアイコン列とプロジェクトバーだけ不透明な板になる
  - **クロスウィンドウ同期**: `project_update` が書き込み後に `project_updated`（`{ sourceLabel, config }`）を全ウィンドウへ emit、各ウィンドウは自ラベルを除外して `applyExternalUpdate` で in-memory コピー（projects 配列 + currentProject、lastSession はウィンドウローカル保持）を更新。これが無いと flushSession / switchProject の全量書き戻しが他ウィンドウの編集を古いデータで消す（lost update）
- **グループ一覧も同じくブロードキャストする**: `project_groups_save` が `project_groups_updated`（`{ sourceLabel, groups }`）を emit し、各ウィンドウが `applyExternalGroups` で差し替える。グループは `groups.json` という別ファイルにあり、プロジェクトの `project_updated` には乗らない。これが無いと (1) 他ウィンドウのパネルが古いグループ名を出し続け、(2) **同期ファイルへ古いグループ一覧が publish される**。(2) の経路は「main 以外のウィンドウでグループをリネーム → プロジェクト側は `project_updated` で main に伝わり push が発火 → その push が main のメモリにある古い `groups` を書き出す」で、エントリの `group` は新しいのに `groups` 配列だけ旧名、という食い違いになる
- プロジェクトアイコン（#203）: `ProjectConfig.icon?: string` は**絵文字そのもの**を保存する（カラーと違いテーマ解決が要らないため名前の間接参照はしない）。描画前に `lib/projectIcons.ts` の `projectIconValue` で検証（トリム後 8 code point 以内・`\p{Cc}` を含まない。ZWJ は `Cf` なので 🧑‍💻 のような合字を弾かないこと）。パレットは同ファイルの `PROJECT_ICONS`（日英キーワード付きの厳選セット。絵文字データセットの依存追加はしない）で、検索は共有 `fuzzyMatch`。選択 UI は `panels/IconSelect.vue`（ColorSelect と同じ popup 規約＋`popup-surface`。パレットに無い絵文字は検索欄に貼って Enter で確定できる。検証は**信頼できない自由入力の書き込み時**と**描画時**の 2 箇所だけ。パレット選択は素通し）。表示は `ColorDot.vue` と対になる `ProjectIcon.vue`（ProjectPanel 一覧・ProjectSwitcher）。**ウィンドウタイトルには出さない**: キャプションは DWM が GDI 経路で描くためカラーフォントのレイヤーが使われず、白黒字形（字形が無ければ豆腐）になって読み辛い。色付きにするには `decorations: false` の自作タイトルバーが要る
- **プロジェクトを開く 3 つの入口（#212）**: 同期（#164）で入ってきたプロジェクトは root がこのマシンに無いことがある。未取得チェック（`ensureRootPresent`）を全経路に効かせるため、`stores/project.ts` の公開 API を次の 3 つに絞り、**`switchProject` は非公開にした**（返却オブジェクトから外してある＝素通りする経路を書けない）。**プロジェクトを開く導線を足すときはこの 3 つのどれかを通す**
  - `openProject(id, mode)`: **一覧から選んで開く**経路（ProjectSwitcher の選択、ProjectPanel の行クリックと「新しいウィンドウで開く」）。開く前に確認し、clone 完了後に同じ open を実行する。`mode` は `switch` / `window`（専用ウィンドウ。既に開いていれば Rust 側が focus）/ `focusOrSwitch`（開いていれば focus、無ければ switch）。`focusOrSwitch` の focus はチェックより**前**に試す（ウィンドウが開けている時点で root の存在は確定しているので、probe を待たせる意味がない）
  - `adoptProject(id, opts?)`: **ウィンドウが先にプロジェクトを渡された**経路（App.vue の `windowProjectId` 分岐＝ジャンプリスト / トレイ / 別ウィンドウ、`restoreLastProject` の main、昇格再起動の `useCliOpen`）。ここは開いた後にしか聞けないので、switch → 確認 → clone 完了で switch し直す、を**1 関数にまとめてある**（前半だけ書いて後半を忘れられないようにするため）
  - `placeProject(id, mode)`: チェック無しで配置するだけ。**登録した直後に開く専用**（`openDirectoryAsProject` と `registerTransientProject` が通る）。root は登録の直前に確認済みなので、「取得できません」と拒否しても意味がないため
  - `ensureRootPresent(id, onCloned)`（非公開）の戻り値＝「今 root がある」。false は開いてはいけない（URL が無いか clone を開始した）。`cloneProject(id, onCloned?)` は onCloned があれば「切り替えますか？」の確認を出さない
  - 判定は**バッチ済みの `missingRoots` を読む**（`checkRoots` は distro ごとに 1 回の `wsl.exe`。パネル / スイッチャーは開くたびに、ストアの watcher は一覧が変わるたびに更新している）。1 プロジェクトだけ個別 probe すると、起動時にウィンドウ数ぶん余分な `wsl.exe` が走り、一覧のバッジと開いたときの判定がずれうる。`checkRoots` は**実行中の probe を join** する（watcher の probe 中に読むと未反映の set を見てしまうため）。force はいつでも再 probe する（clone 直後の判定が clone より前の結果になっては困る）。プローブ失敗は「分からない」なので present 扱いで開かせる
  - 「未取得」バッジは ProjectPanel と ProjectSwitcher の両方に出るので、`theme.css` の共有クラス `.missing-tag`（`.ctx-key` と同じ位置づけ）。行を塗る側は自分の scoped CSS で色を上書きする
  - **ネイティブな WSL パス（`/home/...`）を渡すときは distro のヒントが要る**。`project_transient_create` は `\\wsl.localhost\<distro>\...` の UNC 形からしか distro を読めないので、ヒント無しだと Windows プロジェクトとして組み立てられ、開いたウィンドウが `/home/...` を C ドライブに探しに行く。`stores/project.ts` の `distroHintFor` が「`/` 始まりのパス」かつ「今のプロジェクトが WSL」のときだけ現在の distro を渡す（Windows パスや UNC に渡すとヒントのほうが勝ってしまう）。`openDirectory` / `openDirectoryAsProject` の両方が通る
    - **シェルを渡せる**（#373）。ターミナルの cwd から登録する経路はそのタブのシェルを知っているので、そちらを優先する。ウィンドウの今のプロジェクトだけを見ると、**グローバルモードの WSL ターミナル**（プロジェクトが無い）で distro を取りこぼす
  - `openDirectoryAsProject(path, mode, from?)` は「登録して開く」で、**登録の唯一の入口**（#373）。未登録なら `projectTransientCreate` で backend にプラットフォーム / シェル / distro を推測させ、`uniqueProjectId` を通して登録してから `placeProject`（未取得チェックの対象外）。登録済みの root を渡されたら `openProject` に流す。root を渡された時点で存在は確認済み（ディレクトリだと判定してから呼ぶ）
    - **そのウィンドウが登録せずに開いている root なら `registerTransientProject` へ渡す**（#373）。`projectForRoot` は登録済みの一覧しか見ない（`transientProject` は意図的に外してある）ので、ここを通さないと同じ root で 2 つ目の id が生まれ、`placeProject` の切り替えが「一時プロジェクトから離れる」枝に入って**今開いているタブを全部閉じる**（右クリックしたターミナルごと消える）
  - `openDirectory(path, mode)`（#230）はこの 3 つの外側にあるが、**一覧から選ぶ経路ではない**（ユーザーがピッカーで指したディレクトリなので、そこに無いなら選べていない）ため未取得チェックの対象外。`placeProject` と同じ位置づけ
- **登録せずに開くディレクトリ（一時プロジェクト、#230）**: 中を見たいだけのディレクトリに `project.json` を書くと、一覧・`last_project.txt`・ジャンプリスト・同期ファイルに残り、手で消すしか戻す道がない。代わりに `src-tauri/src/project/transient.rs` の `TransientState`（id → `ProjectConfig` のメモリ内マップ）に載せる
  - **`window_projects` には登録済みと同じように id を入れる**。これが要点で、ウィンドウの focus・CLI ルーティング・`project_for_window` は「匿名ウィンドウ」という概念を持たなくて済む。特別扱いが要るのは**書き込み側だけ**で、その一覧は `transient.rs` のモジュール doc が正本（`project.json` 系 / `last_project.txt` / 同期・シェルメニュー / ウィンドウ geometry）
  - **`window-geometry.json`（#200）だけは意図的に書く**。`key_for` が `window_projects` を読むので一時プロジェクトも記録され、id をディレクトリ名の slug にしてあるぶん開き直すとサイズが戻る。代償は「この方法で開いたディレクトリごとに 1 エントリ残る」
  - **`project.json` への書き込みガードは `saveProject` に置く**（呼び出し側ではなく）。あそこが `ProjectConfig` をディスクへ書く唯一の場所で、`stores/git.ts` が origin を記録するのに既に通っている。呼び出し側に置くと、他の呼び出し側が同じ無言の失敗を踏みうる
  - **登録するか聞くのは `adoptProject` の中**（App.vue ではなく）。clone の確認（#212）と同じ「adopt → 聞く → 実行」なので、同じ関数に畳んで「前半だけ書いて後半を忘れる」を防ぐ。ただし**await しない**: mount の続き（クロスウィンドウ listener・`beforeunload`・トレイ周り）がダイアログの前で止まる
  - **他のプロジェクトへ切り替えたら、その場でエントリを落とす**（ウィンドウを閉じるときではなく）。残すと `pike <そのディレクトリ>` が、もう表示していないウィンドウを focus し続ける
  - **登録するときは `uniqueProjectId` を通す**。Rust 側は登録済みと他の一時プロジェクトに対しては一意にしているが、**hide 済みの id（#164、localStorage にある）は見えない**。ぶつかったまま書くと、その sync エントリの identity を引き継いでしまう。id が変わっても `projectAddOpen` が `window_projects` を張り直すので focus と CLI ルーティングは繋がったまま
  - フロントは `transientProject` ref に持ち、**`projects` 配列には入れない**。パネル / スイッチャー / ジャンプリスト / 同期 push はすべてあの配列を見ているので、入れないことがそのまま「出て行かない」になる（各所でフラグを見るのではなく）
  - id は**ディレクトリ名の slug**（登録済みと他の一時プロジェクトの両方に対して一意化）。uuid にしないのは、同じディレクトリを開き直したときにウィンドウ geometry（#200）を引き継ぐため
  - **同じディレクトリの 2 回目は既存ウィンドウを focus する**。`project_id_for_root` が登録済み一覧に続けて `TransientState` も引く。エントリはウィンドウの `Destroyed` で落とすので、「一致したのにウィンドウが無い」は起こらない
  - **`OpenFiles` のルーティングも一時プロジェクトを引く**（`project_root_for_id`。逆向きは `project_id_for_root`）。登録済み一覧だけを見ていると、そのディレクトリ配下のファイルを `pike file.rs` で開いてもサイドバーの無いグローバルウィンドウが出る
  - **開いたときに 1 度だけ登録するか聞く**（`stores/project.ts` の `offerToRegisterDirectory`）。「いいえ」でその root を `pike:transient-roots`（マシンローカル、同期・broadcast の対象外）に記録して次回から聞かない
  - **聞くかどうかは設定で変えられる（#286）**: `registerDirectory` = `auto` / `ask`（既定）/ `never`。好みなので同期の対象。**粒度が 2 段あるのが要点**で、素の「いいえ」は**そのディレクトリだけ**を `transient-roots` に記録し、ダイアログの「今後は確認しない」にチェックが付いたときだけ**設定そのもの**を書き換える（答えに応じて `auto` / `never`）。チェックボックス付きの確認は `confirmWithOption`
  - **`openDirectory`（ProjectSwitcher・Ctrl+O）も設定に従う。** 開く操作を「登録するかの答え」とみなして聞かずに済ませると、設定の「確認する」が効かなくなる。聞く判断は `offerToRegisterDirectory` の 1 箇所に寄せてあり、`openDirectory` は switch のときだけそれを呼ぶ（window のときは新しいウィンドウが自分で adopt して聞く）
  - 例外は `EditorTab` のディレクトリ用の 2 択（`alreadyChose`）だけ。あそこは「ディレクトリを開く」と「プロジェクトとして開く」を並べた直後なので、聞き直すと同じことを 2 回聞くことになる。**この経路だけが `transient-roots` に先回りで記録する**
  - 登録は `registerTransientProject`（ProjectPanel の一時バー）。**id をそのまま使う**ので `window_projects` が指す先が変わらず、focus も CLI ルーティングも繋がったまま
- **同一ウィンドウでのプロジェクト切り替えは、パネルの状態を明示的に捨てる**（`switchProject`）。プロジェクト単位のキャッシュを持つストアは `search` / `diagnostics` / `tasks` の 3 つで、どれも取得が重いので**切り替え時は捨てるだけ**にして、次に見た人が読み直す。ファイルツリー・git・docker は自分でプロジェクト id を watch する側なので、ここには出てこない
  - **捨てるだけでは「開きっぱなしのパネル」が直らない**: パネルは `activePanel` が変わったときにしか読み直さないので、開いたまま切り替えると空のまま座り続ける。**パネル側の watcher のキーにプロジェクト id も入れる**（TasksPanel、DiagnosticsPanel）。入れないと、tasks は前のプロジェクトの一覧を出し続け、そこから実行すると**前のプロジェクトのディレクトリでコマンドが走る**（`group.cwd` が前のもののため）。QuickOpen の `>` モードも同じ一覧を読む
  - **git の status は切り替え時に 1 回取る**（`startPolling`）。10 秒ポーリングに任せると、StatusBar がその間だけ前のプロジェクトのブランチと ahead/behind を出す。worktree 一覧と usage は元から startPolling の中で 1 回取っている

## セッション永続化
- タブの並び順・アクティブタブ・種別を `ProjectConfig.lastSession` に保存
- Pinia `$subscribe` でタブ変更を検知 → 1秒デバウンスで `project.json` に書き出し
- `beforeunload` で即時保存（best-effort、async なので保証なし）
- プロジェクト復元時: `lastSession` があればそこから復元、なければ `pinnedTabs` にフォールバック
- AI エージェントのセッション復帰は各ツールの resume 機能に委譲（`RESUME_MAP` で `claude` → `claude --continue` に変換）
- tmux はオプション機能として `pty_spawn_tmux` コマンドで利用可能（必須ではない）
- タブのドラッグ&ドロップ入れ替え（HTML5 Drag and Drop API、box-shadow でドロップ位置表示）
- タブコンテキストメニュー: Pin/Unpin、Close、Close Others、Close to the Right、Close Saved、Close All
  - ファイル系タブ（editor/preview/diff/history）では Copy Path、エディタタブでは Git History も表示
  - バルク操作は pinned タブをスキップ、未保存エディタがある場合は一括確認ダイアログ
