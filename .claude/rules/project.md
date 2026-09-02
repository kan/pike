# プロジェクト・ウィンドウ・CLI 実装ルール

プロジェクトの設定と同期、ウィンドウの生成と復元、OS 統合（トレイ・ジャンプリスト）、`pike` CLI。
実体は `src-tauri/src/project/`、`src-tauri/src/cli.rs`、`src-tauri/src/wait.rs`、`src-tauri/src/tray/`、`src-tauri/src/jumplist/`、`src-tauri/src/window_geom.rs`、`src/stores/project.ts`。

## プロジェクト管理
- プロジェクト設定は `%APPDATA%/{identifier}/projects/{id}/project.json` に保存（identifier は `tauri.conf.json` の値で、現在は `com.pike.dev`。**`com.tauri.dev` は雛形のままだった頃の残骸**で、古い環境にはそちらのディレクトリが残っている）
- **`last_project.txt` は 1 行 1 ウィンドウ**で `見せていたid <TAB> 保持していたid...`（#264）。起動時は 1 行につき 1 ウィンドウを復元する。タブを持たない古い形式（1 行 1 id）はそのまま「保持なし」として読める
  - **書き込みは全量書き直し**（`write_open_windows`）。以前は `project_add_open` が追記する一方、削除はウィンドウを閉じたときの「今見せているもの」だけだったので、1 つのウィンドウで A → B と切り替えると A の記録が残り、**次の起動で A と B が別々のウィンドウで開いていた**。生きているウィンドウの状態を写せば、その手のずれが起きない
  - 一時プロジェクト（#230）は `project.json` を持たないので、書き出しのフィルタで落ちる（#230 の「同期ファイル等に出さない」を、読み側だけでなく書き側でも守る）
  - **保持ぶんのタブは起動時に作らない**。タブの中身は常にマウントされる＝作った瞬間にその数だけシェルが立ち上がるため。切り替えたときに通常のセッション復元が走る（`switchProject` は「タブが無ければ復元する」なので、そのまま乗る）
  - **`shown` と `held` は `project_for_window` が 1 回で返す**。分けると、フロントが 2 回に分けて読むあいだに自分の `project_set_parked` が同じ entry を上書きし、復元した保持一覧が黙って消える（実際に踏んだ）。1 回で返せば順序の問題自体が無くなる
  - 書き込みは**同じ内容なら書かない**（`last_written_sessions`）。1 回の切り替えで `project_add_open` と保持一覧の通知が続けて来るので、そのままだと同じ内容を 2〜3 回書く。ファイル書き込みのあいだ `window_projects` のロックを握らない（`project_for_window` は UI スレッドで走る同期コマンド）
- プロジェクトは WSL / Windows / macOS ローカル（`unix`）の 3 プラットフォームに対応。一覧の正本は `lib/projectPaths.ts` の `PROJECT_PLATFORMS` で、型も実行時検証もそこから導く（`.claude/rules/platform.md`）
- WSL プロジェクト: ディストロ指定、ルートは WSL パス
- Windows プロジェクト: デフォルトシェル（cmd/PowerShell/Git Bash）選択、ルートは Windows パス
- **プロジェクト切替でタブを捨てない（#264）**: `switchProject` は kill せず、`tabStore.setOwnerProject(id)` で見せる相手を差し替えるだけ。ターミナルのプロセスとエージェントのセッションが生きたまま残る（＝切替時の「実行中ですが良いですか」の確認も不要になった）。初めて開くプロジェクトだけ `lastSession` / `pinnedTabs` から復元する
  - **仕組みは既にあったものに乗っている**: `TabPane` は全タブをマウントしたまま `v-show` で出し分けているので、パークしたタブは「タブバーに出ない非アクティブタブ」でしかない。サイズ 0 での `fit()` 等の既存のガードがそのまま効く
  - **Rust 側にバッファを持って再アタッチする案は採らない**。フルスクリーン TUI（claude / vim）は再描画されないと崩れるので、生バイトを新しい xterm に流し込む形では tmux 相当の画面状態の再構築が要る
  - 所有 id を付けるのは `stores/tabs.ts` の `pushTab` の 1 箇所（作る側は 12 箇所ある）。**シングルトン（設定 / エージェント状態 / マニュアル）は `projectId: null`＝ウィンドウ単位**。プロジェクトに属させると「プロジェクトごとに 1 つ」になり、シングルトンの意味が壊れる。種別の一覧は `types/tab.ts` の `SINGLETON_KINDS` が正本（`lib/tabTitle.ts` と共有）
  - **`tabs`（全部）を直接読んで良いのは 2 つだけ**: id で 1 つ引くとき（タブのコンポーネントは自分の id で引く）と、`TabPane` の**中身**の `v-for`（マウントしたままにするのが目的なので全部要る）。**それ以外は `visibleTabs`**（タブバー・ナビゲーション・`@` モード・ターミナルへの注入・セッションの書き出し・空表示の判定・既定ターミナルの有無・ファイル変更の反映）
    - この分け方は散文では守れない（`.claude/rules/git.md` の `activeRoot` と同じ構図で、**安全なほうに長い名前が付いている**）。実際、初回の実装で `hasPlainTerminal` が `tabs` を見たままで、A を保持したまま B を初めて開くと B に既定ターミナルが作られなかった。新しい消費者を書くときは、まず `visibleTabs` から考える
  - **タブの持ち主が消える経路を塞ぐ**: 一時プロジェクト（#230）から離れるときと、プロジェクトを削除するときは、先に `closeProjectTabs` でタブを手放す（あとに回すと、一覧に出ないのにプロセスを抱えたタブが残る）。一時プロジェクトを登録して id が変わるときは `renameProjectOwner` で付け替える
  - **持っているものを Rust に伝える**（`project_set_parked` → `ProjectState.window_projects`）。ジャンプリスト / トレイ / `pike <dir>` の解決はあちらで行われるので、伝えないと保持中のプロジェクトを開くたびに新しいウィンドウができ、同じリポジトリでエージェントが二重に動く
    - **マップは 1 本**（`WindowProjects { shown, held }`、`held ⊇ {shown}`）。「見せている」と「保持している」を別のマップに割ると、同じ問いに答えが 2 つでき、掃除も書き込みも 2 経路になる。`window_holding` が「どのウィンドウが持っているか」と「それを今見せているか」を 1 回で返し、`focus_project_window_anywhere` は後者で focus と切り替えを分ける
  - 逃げ道は UI に出す（#264 の判断）: プロジェクト一覧とスイッチャーの「保持中」バッジ、`ProjectSelect` のプルダウンとその ✕、パネルの電源ボタン、ウィンドウタイトルの `pike - school (sitter / musql)`
    - **解除の実体は `releaseProject` の 1 つ**（パネルとプルダウンが共有）。**タブがあるときだけ確認する**: 復元待ちのものは動いているプロセスが無いので、「実行中のプロセスも終了します」と聞くのは嘘になる。共有する前は、パネルの解放ボタンが復元待ちのプロジェクトに対して何もしなかった
    - ✕ は現在地以外の行にだけ出す。現在地に出すと「今見ているプロジェクトのタブを全部閉じる」になり、解除とは別の操作になる
  - **一時プロジェクト（#230）はプルダウンの一覧に出さない**。あれは切り替えると破棄されるので、「戻ってきたらそのままある」という一覧の約束を満たさない（出るのに戻れない、という食い違いになる）。**ボタンのラベルには出す**: あちらは「今どこにいるか」で、登録していないディレクトリを開いているときこそ見えていてほしい。「未登録」の印は StatusBar が出しているので、こちらに写しを作らない
    - 一時プロジェクトを一覧に出す形も試したが、行き先ではないのに ✕（保持の解除）が付くという食い違いが出た。**一覧に並ぶのは「保持しているもの」だけ**という不変条件を保つほうが、印で例外を説明するより素直
  - **並びは `heldIds`（順序つきの 1 本）で固定**し、選択でも materialize でも入れ替えない（押すたびに行き先が動くと狙えない）。開いた順に足し、手放すまで残す（タブを 1 つも持たないものも入る。#301）。「まだタブを作っていない」は別のリストではなく `hasTabsFor` の否定で表す（2 本にすると、pending から実体化した瞬間に並びが変わる）。**タイトルだけは現在地が先頭**: タスクバーでは「今どれか」が先に読めるほうが良く、並びを覚えて押す対象でもない
  - **タブが尽きたことを理由にウィンドウを閉じないこと（#301）。** 閉じると保持しているぶんが `last_project.txt` ごと消える。閉じてよいかを決めるのは `App.vue` の `tabs.length` の watcher 1 箇所で、ショートカットの側（`useAppActions` の `closeTab`）は何もしない。理由は `stores/project.ts` の `heldIds` の doc コメントが正本
  - **切替 UI の置き場所はサイドバーのパネルの開閉で変わる（#298）**。開いていればサイドバーの最上部（アイコン列とパネルにまたがる帯）、閉じていればタブバーの左。`components/layout/ProjectSelect.vue` の 1 部品を `SideBar` / `TabPane` が `v-if` で出し分けるだけで、部品側は自分がどちらに居るかを知らない。畳んだサイドバーは 48px しかなく名前が読めないので、そこには置かない。グローバルモードのウィンドウはプロジェクトを持たないため、部品側の `v-if` で何も描かれない
    - 元は保持中のぶんをタブバー左へ**横並び**にしていた（#264）が、保持している数だけ横幅を取ってタブを圧迫した。常に 1 つのボタンに畳んだので、幅は保持数に依存しない
    - サイドバーは**2 列 2 行の grid**。アイコン列が `grid-row: 1 / -1` で上まで通り、帯はその右（`grid-column: 2` / `grid-row: 1`）に入る。パネルの開閉でアイコンの位置が動かないのが要点。flex の行に包み直すとテンプレートを字下げし直すことになるだけで、得るものが同じ
    - **帯は列の幅を決めない**（`width: 0` ＋ `min-width: 100%`）。`auto` の列は max-content で広がるので、素のままだと長いプロジェクト名がパネルより広い列を作り、明示 width を持つ `.panel` の右に死んだ帯が残る（リサイズハンドルもサイドバーの右端から離れる）
- Windows プロジェクトでは「+」ボタン横のドロップダウンでデフォルト以外のシェルも選択可能
- プロジェクトのグループ分け: `ProjectConfig.group?: string` で各プロジェクトの所属グループを保持。グループ一覧と表示順は `%APPDATA%/{identifier}/groups.json` に明示的に永続化（プロジェクト未割当の空グループも保持可能）。`project_groups_list` / `project_groups_save` コマンドで CRUD
- ProjectPanel UI: 未分類プロジェクトはリスト直下にフラット表示（ヘッダーなし）、グループ所属はグループバー配下に折りたたみ可能で配置。「+ グループを追加」ボタンで空グループを作成、グループバーの鉛筆で一括リネーム（所属プロジェクトの `group` も更新）、✕ で削除（所属プロジェクトは ungroup）
- プロジェクトの編集フォームではコンボボックス形式: `<select>` で「グループなし / 既存グループ / + 新規グループ...」、新規選択で text input に切替
- **表示モード（#203）**: `グループ別`（既定）と `最近開いた順` の 2 つ。`最近開いた順` は**グループでまとめずフラット**に並べ（並びはバックエンドの `read_all_projects_sorted` = `lastOpened` 降順）、代わりに行にグループ名バッジを出す。`グループ別` は手動順（後述）→ 名前順。モードは `localStorage` (`pike:project-sort-mode`)、折りたたみ状態は同 `pike:project-group-collapsed` に永続化
- **描画は 1 本の `rows` computed**（`PanelRow` = group ヘッダ or project 行の判別 union）に集約。以前はセクションごとに `ProjectListItem` の束縛を書き写していた。`siblings` はその行にドロップしたときの並び替えスコープ
- **絞り込み（#203）**: パネル上部の常設入力。`lib/paths.ts` の共有 `fuzzyMatch` で name / root / group を対象（`ProjectSwitcher` / `QuickOpen` のローカル複製もこの共有版に統合済み）。グループ別表示では一致 0 件のグループを隠す
- **装飾の役割分担（#203）**: 「このウィンドウで開いているプロジェクト」は**行全体の塗り**で示す（プロジェクトカラーがあればその色、無ければ `--accent`）。グループバーは背景＋枠だけの見出しにした（以前は両方が青い左線で紛らわしかった）。塗りの上の文字色は `lib/projectColors.ts` の `readableTextOn`（相対輝度で黒/白を選ぶ。閾値 0.179 は白背景・黒背景の WCAG コントラストが入れ替わる点）で決め、行内の meta / アイコン / アクションボタンは `color: inherit` にして塗りに追従させる。プリセットは黄色から紫まであるので、白固定でも黒固定でも読めない色が出る
- **ドラッグ&ドロップ（#203）**: `useDragAndDrop` の drag id に `project:{id}` / `group:{name}` の複合キーを載せて種別を判別する（グループ名に `:` を含みうるので先頭の `:` で分割）。挿入位置は TabPane と同じ midpoint 判定の縦版で、`insertAt` は**先に対象を配列から除いてから挿入**するので `from < to` の補正が要らない。行へのドロップ＝並び替え＋その行のグループへ移動、グループバーへのドロップ＝そのグループの末尾へ。**並び替えはグループ別表示かつ絞り込み無しのときだけ**（`recent` は recency 固定、絞り込み中は表示インデックスが実体とずれる）。グループバーへの所属変更は従来どおりグループ別表示なら常に可能
- **手動順（#203）**: `ProjectConfig.order?: number`（TS と Rust の両方に必要。Rust 構造体に無いフィールドは次の全量書き戻しで消える）。スコープはグループ単位（未分類も 1 スコープ）で、並びは `(order ?? MAX) → name`。`reorderProjects(orderedIds, group)` が 0..n-1 を振り直し、**実際に値が変わるプロジェクトだけ**保存する（1 件の保存が `project_update` 全量書き＋全ウィンドウ broadcast のため）。グループ順は `groups.json` の配列順そのものなのでスキーマ変更なし（`reorderGroups`）
- プロジェクトカラー（#121）: `ProjectConfig.color?: string` は**プリセット名**（'red' 等）を保存し、hex は描画時に `lib/projectColors.ts` の `projectColorValue` で解決（パレット調整が config 移行なしで効く。手編集の生 hex `#rrggbb` のみ許容し、`url()` 等の任意 CSS 値は style バインドに到達しない）。プリセット 8 色は musql と同一パレット、name が i18n キー `projectColor.{name}` を兼ねる。選択 UI は `panels/ColorSelect.vue`（スウォッチ付きカスタムドロップダウン。close は他メニューと同じ「open 時に window mousedown を once で張る + ルートで `@mousedown.stop`」方式）で、ProjectPanel の作成・編集フォームと ProjectSwitcher の新規作成モーダルに配置。表示はカラードット共通コンポーネント `ColorDot.vue`（ProjectPanel 一覧・ProjectSwitcher）と、**サイドバーのアイコン列とプロジェクトバーの下地**（#298）。
  - 元は App.vue のウィンドウ左端 3px の縦ラインだったが、#298 で面に広げた。**同じ色の面がちょうどその位置に来る**ので、線を残しても見えない。上端の横ラインは悪目立ちするため左端に置いていた、という経緯もここで解消している
  - **色の導出は `composables/useProjectAccent.ts` の 1 つ**（`{ bg, fg }`）。塗る場所が 2 つあり、しかも隣り合って 1 つの帯に見えるので、片方だけ「未設定のときどうするか」がずれると継ぎ目で色が割れる。**既定色は composable が決めない**: アイコン列（`--bg-secondary`）とプロジェクトバー（`--tab-hover-bg`）で素の下地が違うため、それぞれの CSS の `var(--…, 既定)` に置く
  - **上に載るものは全部読める色に振り替える**（`--icon-strip-fg`）。アイコン・アクティブ印（既定は `--accent` の青で、色の上ではぶつかる）・件数バッジ（地と文字を反転）・マーカー。灰色のままだと黄色や明るい緑の上で沈む
  - **下地は `--surface-alpha` で合成する**（#162）。プロジェクトカラーは生の hex なので、そのまま敷くと透過・アクリルのときにアイコン列とプロジェクトバーだけ不透明な板になる
  - **クロスウィンドウ同期**: `project_update` が書き込み後に `project_updated`（`{ sourceLabel, config }`）を全ウィンドウへ emit、各ウィンドウは自ラベルを除外して `applyExternalUpdate` で in-memory コピー（projects 配列 + currentProject、lastSession はウィンドウローカル保持）を更新。これが無いと flushSession / switchProject の全量書き戻しが他ウィンドウの編集を古いデータで消す（lost update）
- **グループ一覧も同じくブロードキャストする**: `project_groups_save` が `project_groups_updated`（`{ sourceLabel, groups }`）を emit し、各ウィンドウが `applyExternalGroups` で差し替える。グループは `groups.json` という別ファイルにあり、プロジェクトの `project_updated` には乗らない。これが無いと (1) 他ウィンドウのパネルが古いグループ名を出し続け、(2) **同期ファイルへ古いグループ一覧が publish される**。(2) の経路は「main 以外のウィンドウでグループをリネーム → プロジェクト側は `project_updated` で main に伝わり push が発火 → その push が main のメモリにある古い `groups` を書き出す」で、v0.36.1 で実際に踏んだ（エントリの `group` は新しいのに `groups` 配列だけ旧名、という食い違いが出る）
- プロジェクトアイコン（#203）: `ProjectConfig.icon?: string` は**絵文字そのもの**を保存する（カラーと違いテーマ解決が要らないため名前の間接参照はしない）。描画前に `lib/projectIcons.ts` の `projectIconValue` で検証（トリム後 8 code point 以内・`\p{Cc}` を含まない。ZWJ は `Cf` なので 🧑‍💻 のような合字を弾かないこと）。パレットは同ファイルの `PROJECT_ICONS`（日英キーワード付きの厳選セット。絵文字データセットの依存追加はしない）で、検索は共有 `fuzzyMatch`。選択 UI は `panels/IconSelect.vue`（ColorSelect と同じ popup 規約＋`popup-surface`。パレットに無い絵文字は検索欄に貼って Enter で確定できる。検証は**信頼できない自由入力の書き込み時**と**描画時**の 2 箇所だけ。パレット選択は素通し）。表示は `ColorDot.vue` と対になる `ProjectIcon.vue`（ProjectPanel 一覧・ProjectSwitcher）。**ウィンドウタイトルには出さない**: キャプションは DWM が GDI 経路で描くためカラーフォントのレイヤーが使われず、白黒字形（字形が無ければ豆腐）になって読み辛い。色付きにするには `decorations: false` の自作タイトルバーが要る
- **プロジェクトを開く 3 つの入口（#212）**: 同期（#164）で入ってきたプロジェクトは root がこのマシンに無いことがある。未取得チェック（`ensureRootPresent`）を全経路に効かせるため、`stores/project.ts` の公開 API を次の 3 つに絞り、**`switchProject` は非公開にした**（返却オブジェクトから外してある＝素通りする経路を書けない）。**プロジェクトを開く導線を足すときはこの 3 つのどれかを通す**
  - `openProject(id, mode)`: **一覧から選んで開く**経路（ProjectSwitcher の選択、ProjectPanel の行クリックと「新しいウィンドウで開く」）。開く前に確認し、clone 完了後に同じ open を実行する。`mode` は `switch` / `window`（専用ウィンドウ。既に開いていれば Rust 側が focus）/ `focusOrSwitch`（開いていれば focus、無ければ switch）。`focusOrSwitch` の focus はチェックより**前**に試す（ウィンドウが開けている時点で root の存在は確定しているので、probe を待たせる意味がない）
  - `adoptProject(id, opts?)`: **ウィンドウが先にプロジェクトを渡された**経路（App.vue の `windowProjectId` 分岐＝ジャンプリスト / トレイ / 別ウィンドウ、`restoreLastProject` の main、昇格再起動の `useCliOpen`）。ここは開いた後にしか聞けないので、switch → 確認 → clone 完了で switch し直す、を**1 関数にまとめてある**（前半だけ書いて後半を忘れられないようにするため）
  - `placeProject(id, mode)`: チェック無しで配置するだけ。**新規作成専用**（ProjectSwitcher の `onCreateProject`）。これから作るパスに対して「取得できません」と拒否しても意味がないため
  - `ensureRootPresent(id, onCloned)`（非公開）の戻り値＝「今 root がある」。false は開いてはいけない（URL が無いか clone を開始した）。`cloneProject(id, onCloned?)` は onCloned があれば従来の「切り替えますか？」confirm を出さない
  - 判定は**バッチ済みの `missingRoots` を読む**（`checkRoots` は distro ごとに 1 回の `wsl.exe`。パネル / スイッチャーは開くたびに、ストアの watcher は一覧が変わるたびに更新している）。1 プロジェクトだけ個別 probe すると、起動時にウィンドウ数ぶん余分な `wsl.exe` が走り、一覧のバッジと開いたときの判定がずれうる。`checkRoots` は**実行中の probe を join** する（watcher の probe 中に読むと未反映の set を見てしまうため）。force はいつでも再 probe する（clone 直後の判定が clone より前の結果になっては困る）
  - 判定は `checkRoots`（バッジ用の全件プローブ。distro ごとに `wsl.exe` 起動＋`backfillRemotes` の git 往復）ではなく、**当該 root 1 件の `fsDirsExist`**。プロジェクトを開くたびに全件プローブを待たせないため。プローブ失敗は「分からない」なので present 扱いで開かせる（`checkRoots` と同じ規約）
  - 「未取得」バッジは ProjectPanel と ProjectSwitcher の両方に出るので、`theme.css` の共有クラス `.missing-tag`（`.ctx-key` と同じ位置づけ）。行を塗る側は自分の scoped CSS で色を上書きする
  - **ネイティブな WSL パス（`/home/...`）を渡すときは distro のヒントが要る**。`project_transient_create` は `\\wsl.localhost\<distro>\...` の UNC 形からしか distro を読めないので、ヒント無しだと Windows プロジェクトとして組み立てられ、開いたウィンドウが `/home/...` を C ドライブに探しに行く。`stores/project.ts` の `distroHintFor` が「`/` 始まりのパス」かつ「今のプロジェクトが WSL」のときだけ現在の distro を渡す（Windows パスや UNC に渡すとヒントのほうが勝ってしまう）。`openDirectory` / `openDirectoryAsProject` の両方が通る
  - `openDirectoryAsProject(path, mode)` は「登録して開く」。未登録なら `projectTransientCreate` で backend にプラットフォーム / シェル / distro を推測させ、`uniqueProjectId` を通して登録してから `placeProject`（新規作成なので未取得チェックの対象外）。登録済みの root を渡されたら `openProject` に流す。root を渡された時点で存在は確認済み（ディレクトリだと判定してから呼ぶ）
  - `openDirectory(path, mode)`（#230）はこの 3 つの外側にあるが、**一覧から選ぶ経路ではない**（ユーザーがピッカーで指したディレクトリなので、そこに無いなら選べていない）ため未取得チェックの対象外。`placeProject` と同じ位置づけ
- **登録せずに開くディレクトリ（一時プロジェクト、#230）**: `pike <dir>` は未登録のディレクトリに対して `project.json` を書いていたので、中を見たいだけのディレクトリが一覧・`last_project.txt`・ジャンプリスト・同期ファイルに残り、手で消すしか戻す道がなかった。代わりに `src-tauri/src/project/transient.rs` の `TransientState`（id → `ProjectConfig` のメモリ内マップ）に載せる
  - **`window_projects` には登録済みと同じように id を入れる**。これが要点で、ウィンドウの focus・CLI ルーティング・`project_for_window` は「匿名ウィンドウ」という概念を持たなくて済む。特別扱いが要るのは**書き込み側だけ**で、その一覧は `transient.rs` のモジュール doc が正本（`project.json` 系 / `last_project.txt` / 同期・シェルメニュー / ウィンドウ geometry）
  - **`window-geometry.json`（#200）だけは意図的に書く**。`key_for` が `window_projects` を読むので一時プロジェクトも記録され、id をディレクトリ名の slug にしてあるぶん開き直すとサイズが戻る。代償は「この方法で開いたディレクトリごとに 1 エントリ残る」
  - **`project.json` への書き込みガードは `saveProject` に置く**（呼び出し側ではなく）。あそこが `ProjectConfig` をディスクへ書く唯一の場所で、`stores/git.ts` が origin を記録するのに既に通っている。呼び出し側に置くと、残り 8 箇所が同じ無言の失敗を踏みうる
  - **登録するか聞くのは `adoptProject` の中**（App.vue ではなく）。clone の確認（#212）と同じ「adopt → 聞く → 実行」なので、同じ関数に畳んで「前半だけ書いて後半を忘れる」を防ぐ。ただし**await しない**: mount の続き（クロスウィンドウ listener・`beforeunload`・トレイ周り）がダイアログの前で止まる
  - **他のプロジェクトへ切り替えたら、その場でエントリを落とす**（ウィンドウを閉じるときではなく）。残すと `pike <そのディレクトリ>` が、もう表示していないウィンドウを focus し続ける
  - **登録するときは `uniqueProjectId` を通す**。Rust 側は登録済みと他の一時プロジェクトに対しては一意にしているが、**hide 済みの id（#164、localStorage にある）は見えない**。ぶつかったまま書くと、その sync エントリの identity を引き継いでしまう。id が変わっても `projectAddOpen` が `window_projects` を張り直すので focus と CLI ルーティングは繋がったまま
  - フロントは `transientProject` ref に持ち、**`projects` 配列には入れない**。パネル / スイッチャー / ジャンプリスト / 同期 push はすべてあの配列を見ているので、入れないことがそのまま「出て行かない」になる（各所でフラグを見るのではなく）
  - id は**ディレクトリ名の slug**（登録済みと他の一時プロジェクトの両方に対して一意化）。uuid にしないのは、同じディレクトリを開き直したときにウィンドウ geometry（#200）を引き継ぐため
  - **同じディレクトリの 2 回目は既存ウィンドウを focus する**。`project_id_for_root` が登録済み一覧に続けて `TransientState` も引く。エントリはウィンドウの `Destroyed` で落とすので、「一致したのにウィンドウが無い」は起こらない
  - **`OpenFiles` のルーティングも一時プロジェクトを引く**（`project_by_id`）。登録済み一覧だけを見ていると、そのディレクトリ配下のファイルを `pike file.rs` で開いてもサイドバーの無いグローバルウィンドウが出る
  - **開いたときに 1 度だけ登録するか聞く**（`stores/project.ts` の `offerToRegisterDirectory`）。「いいえ」でその root を `pike:transient-roots`（マシンローカル、同期・broadcast の対象外）に記録して次回から聞かない。ProjectSwitcher の「ディレクトリを開く」は選択そのものが答えなので、開くと同時に記録して聞かない
  - **聞くかどうかは設定で変えられる（#286）**: `registerDirectory` = `auto` / `ask`（既定＝従来の挙動）/ `never`。好みなので同期の対象。**粒度が 2 段あるのが要点**で、素の「いいえ」は**そのディレクトリだけ**を `transient-roots` に記録し、ダイアログの「今後は確認しない」にチェックが付いたときだけ**設定そのもの**を書き換える（答えに応じて `auto` / `never`）
  - **`openDirectory` も設定に従う。** 上の「選択そのものが答え」は #286 で撤回した: 設定に「確認する」を置いた以上そちらが優先で、Ctrl+O で開いても聞かれない（＝設定が効かない）という形で実際に出た。聞く判断は `offerToRegisterDirectory` の 1 箇所に寄せてあり、`openDirectory` は switch のときだけそれを呼ぶ（window のときは新しいウィンドウが自分で adopt して聞く）
  - 例外は `EditorTab` のディレクトリ用の 2 択（`alreadyChose`）だけ。あそこは「ディレクトリを開く」と「プロジェクトとして開く」を並べた直後なので、聞き直すと同じことを 2 回聞くことになる。**この経路だけが `transient-roots` に先回りで記録する**
  - チェックボックス付きの確認は `useConfirmDialog` の **`confirmWithOption`**。`confirmDialog` の戻り値は真偽値のまま変えない（呼び出しが 20 箇所以上あり、どれもチェックの状態を要らない）
  - 登録は `registerTransientProject`（ProjectPanel の一時バー）。**id をそのまま使う**ので `window_projects` が指す先が変わらず、focus も CLI ルーティングも繋がったまま
- 同期（#164）との関係: `SyncedProject` に `icon` / `order` を追加。**push はローカルの値をそのまま publish する（同じ id の既存エントリを丸ごと置き換える）**。以前は空欄だけを埋めていたため、ファイルに一度入った値が恒久化し、(1) 後からの改名・色変更・グループ変更が他マシンへ出て行かない、(2) 手元で**消した**フィールドがファイル側に残り、次回起動の pull で復活する、の 2 つが起きていた（実測: `school` のグループがファイル側で `WORK` のまま 3 週間化石化）。代償は「2 台以上なら最後に走ったマシンが勝つ」で、**何も起きない編集より上書きされうる編集を採る**という判断。pull 側は従来どおり既存プロジェクトへの穴埋めのみ（起動時の pull が手元の編集を古い値で潰さないため）。手元に無いプロジェクトのエントリには触らない。グループ順は sync ファイルの `groups` セクションに載せ、pull 側は「リモートの順を採用し、ローカルにしか無いグループを末尾へ」。**新しい共有フィールドは push の watcher キー（`stores/project.ts`）にも足すこと**。入れ忘れると push 自体が発火しない
- **削除の記録は id だけでは足りない（#164）**: 同期ファイルは 1 つのリポジトリに対して複数の id を持ちうる（各マシンが別々に登録すると別 id になる。実測でこのマシンの dotfiles が 4 id）。`HiddenProject` は `root` と `remoteUrl` も持ち、pull は id・解決後の root・正規化した origin の 3 つで照合する。**照合は `pullProjectsFromSync` の中で重複ガード（`localRoots` / `localRemotes`）と並べて組み立てる**: 「同じプロジェクトか」の判定軸を増やしたとき、片方だけ直すと無言で複製か復活が出る。root の比較キーは `lib/projectPaths.ts` の `rootKey`（区切りの正規化＋末尾スラッシュ除去＋小文字化。`relativeToBase` と違い WSL でも大小を無視する＝「同じディレクトリを登録済みか」の判定なので）。id だけを見ていたころは、手元のコピーを削除すると兄弟エントリが「まだ知らないプロジェクト」として作り直され、**古い名前・色/アイコン無しで復活していた**（ユーザーからはプロジェクト設定が巻き戻ったように見える）。origin の比較は `lib/gitRemote.ts` の `normalizeRemoteUrl` を通すこと: 同じリポジトリが `git@host:owner/repo.git` と `https://host/owner/repo` の両方の形でファイルに入るため、生の文字列比較では重複ガードが素通りする。過去に hide した記録には root も origin も無いので、この照合が効くのは今後の削除だけ

- **同一ウィンドウでのプロジェクト切り替えは、パネルの状態を明示的に捨てる**（`switchProject`）。プロジェクト単位のキャッシュを持つストアは `search` / `diagnostics` / `tasks` の 3 つで、どれも取得が重いので**切り替え時は捨てるだけ**にして、次に見た人が読み直す。ファイルツリー・git・docker・todo は自分でプロジェクト id を watch する側なので、ここには出てこない
  - **捨てるだけでは「開きっぱなしのパネル」が直らない**: パネルは `activePanel` が変わったときにしか読み直さないので、開いたまま切り替えると空のまま座り続ける。**パネル側の watcher のキーにプロジェクト id も入れる**（TasksPanel、DiagnosticsPanel）。tasks は実際にこれで前のプロジェクトの一覧を出し続けており、そこから実行すると**前のプロジェクトのディレクトリでコマンドが走っていた**（`group.cwd` が前のもののため）。QuickOpen の `>` モードも同じ一覧を読む
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

## マルチウィンドウ
- ProjectSwitcher の Ctrl+Enter または ProjectPanel の ExternalLink ボタンで新ウィンドウにプロジェクトを開く
- ウィンドウラベルは**不透明な `project-{uuid}`**（`global-{uuid}` と同様）。プロジェクトとの対応は Rust の `ProjectState.window_projects`（label → 現在のプロジェクト id）が**唯一の真実**で、`build_project_window` が生成時に seed し、in-place の `switchProject` ごとに `project_add_open` が更新する（#175）。ラベルから id をパースしない（旧 `project-{id}` 方式・`window_project_id`/`getWindowProjectId` は廃止）。フロントは起動時に `project_for_window` コマンドで自ウィンドウのプロジェクトを取得する。ウィンドウ解決（フォーカス/新規・CLI ルーティング・破棄時の `last_project.txt` 掃除）はすべてこのマップ経由（`find_project_window`）。同一プロジェクトの二重起動は既存ウィンドウをフォーカス（マップで検出）
- Tauri v2 の各ウィンドウは独立 JS コンテキスト → Pinia ストアは自然にウィンドウごとに分離
- PTY/Docker イベントは `app.emit()` で全ウィンドウにブロードキャスト、ルーターが ID でフィルタ
- **特定ウィンドウ宛てイベントの受信は `getCurrentWindow().listen()` を使う**（`@tauri-apps/api/event` の素の `listen()` は使わない）: Rust が `app.emit_to(label, …)` で 1 ウィンドウに送っても、素の `listen()` はデフォルト target が `Any` のため**全ウィンドウで発火**する。`cli_open` のようにルーティング済みの宛先ウィンドウだけで処理したいイベントは、必ず `getCurrentWindow().listen()`（target = 自ラベル）で受ける（過去に `useCliOpen` が素の `listen()` を使い、外部ファイルを開くと全ウィンドウが開こうとしてエラーになった）。全ブロードキャスト＋ID フィルタ方式（PTY/Docker）とは使い分ける
- 全ウィンドウ（main + 子）が `last_project.txt` に自身のプロジェクト ID を登録し、起動時に復元
- **main ウィンドウ close → トレイに常駐（#161、後述「システムトレイ」）**。main は破棄せず hide し、アプリは終了しない。実際の終了はトレイの「終了」（`app.exit`）のみ。子ウィンドウを全部閉じても hidden main が残るためアプリは常駐し続ける（旧: main close＝アプリ終了・`app-should-exit` 自動終了は廃止）。**設定 `closeToTray` が OFF でも main の close が他ウィンドウを道連れにすることは無い**（詳細は「システムトレイ」の #202 の bullet）
- `find_project_window` はマップが一致したウィンドウをそのまま返す（可視判定なし。呼び出し側が `restore_window` する）。以前は非可視のヒットを stale ハンドルとみなして `close()` していたが、ラベルが単発 uuid になり（#175）`Destroyed` がマップを drain する今、非可視で残りうるのは hide 中の main だけで、この GC は main の close 経路に再入して OFF 設定ではアプリ終了を招くだけだった（#202）
- 子ウィンドウ close → `beforeunload` で session 保存 + PTY kill（ベストエフォート）

## ウィンドウ状態永続化
- `tauri-plugin-window-state` でウィンドウサイズ・位置・最大化状態を自動保存・復元。ただし**追跡するのは `main` ラベルだけ**（`with_filter`）
- **プロジェクト単位の geometry（#200）**: プロジェクト/グローバルウィンドウのラベルは起動ごとの UUID（#175）なので、ラベル keyed のプラグインでは永久に復元できず `.window-state.json` に死んだエントリが溜まる（実測 105 件中 104 件が死蔵）。そこで `src-tauri/src/window_geom.rs` が **`window_projects` 経由で「そのウィンドウが今表示しているプロジェクト id」をキー**に `%APPDATA%/{identifier}/window-geometry.json` へ保存する（プロジェクト無しは `global` キー、main も同じ規則で記録するので main で開いていたプロジェクトが子ウィンドウへ移っても size を引き継ぐ）。マシンローカルな情報なので同期対象の `project.json` には入れない
  - 保存契機: 既存の Moved/Resized 500ms デバウンス、`CloseRequested`（デバウンス待ちの取りこぼし防止）、`RunEvent::Exit`（トレイ「終了」は CloseRequested を経ずに破棄されるため）、`save_all_window_state`（updater の relaunch 前）
  - **単位は物理ピクセルで統一する**: 記録元の `inner_size()` / `outer_position()` は物理ピクセルだが、`WebviewWindowBuilder` の `inner_size` / `position` は**論理ピクセル**（tauri の doc comment。tao 側も `to_physical(target_monitor.scale_factor())` で変換する）。ビルダーに渡すと 150% ディスプレイでは幅も位置も 1.5 倍になり、開くたびに右下へ膨らんでいく（v0.33.0〜v0.34.0 の不具合）。そのため `window_geom::restore` は **build 後**に `set_position` / `set_size` へ物理ピクセルのまま渡す（`tauri-plugin-window-state` の `restore_state` と同じ手順）。既定サイズから復元サイズへ飛ぶのが見えないよう、`build_window` は `.visible(false)` で生成し restore 後に `show()` する
  - 適用順は **位置 → サイズ → 最大化**。スケール factor の違うディスプレイへ移すと Windows がウィンドウをリサイズするため位置が先。最大化はビルダーではなく最後に呼ぶ（復元矩形の上で最大化すると、解除したときそこへ戻る）
  - 位置は保存時の矩形がいずれかのモニタと重なる場合のみ適用（ディスプレイを外したときに画面外へ行かない）。最大化/最小化中は「戻る先の矩形」を上書きしないようフラグだけ更新
  - 旧バージョンが残した死蔵エントリは `prune_plugin_state` が起動時に掃除する。**プラグイン登録より前**に走らせる必要がある（プラグインはファイルをメモリへ読み込み、保存ごとにキャッシュ全体を書き戻すため後から消しても復活する）。`AppHandle` がまだ無いので `%APPDATA%/{identifier}` を手組みする（Windows の `app_config_dir` と同一）
- サイドバーの展開状態（activePanel）と幅は `localStorage` で永続化

## ウィンドウ背景透過（#162）
設定「外観」の 不透明 / 透過 / アクリル と不透明度スライダーで、ウィンドウ背景を半透明にする。ウィンドウは常に transparent 生成し、実際の透け方は `window_set_backdrop` が実行時に切り替える。

- **不透明モードは本当に不透明に戻す**: tao の `transparent` フラグ自体は後から変えられないが、その実体は「空リージョンの `DwmEnableBlurBehindWindow`（= per-pixel alpha 化）」なので**解除はできる**。`window_set_backdrop` は不透明モードで (1) `DwmEnableBlurBehindWindow(fEnable=false)` で per-pixel alpha を切り、(2) WebView2 の既定背景をテーマ色（α=255）に戻す。これをしないと、設定が既定の「不透明」でも全ユーザーが透過合成パスに乗り続ける。WebView2 は **α=0 だけを透過**として扱い、それ以外の α は 255 に丸める仕様なので、透過モードでは `Color(0,0,0,0)` を渡す
- **テーマ色の受け渡し**: 不透明時の下地色は App.vue が `getComputedStyle` で `--bg-primary-rgb`（`"30 30 30"` 形式）を読んで引数で渡す。`theme.css` を単一の真実に保つため。ダーク/ライト切替でも呼び直す必要があるので、watch のキーは `windowBackdrop` と `darkMode`。ただし**色を使うのは不透明モードだけ**なので、透過/アクリルのままテーマだけ変わったときは早期 return する。**不透明度スライダーも native 呼び出しの契機に入れない**（α は CSS しか使わないうえ、ドラッグ中に毎フレーム IPC が飛ぶ）。`data-theme` の差し替え後に読むため `nextTick` を挟む
- **mount 前の下地**: `window_set_backdrop` はフロントの mount 後にしか走らないので、それまでの数フレームは生成時点の背景色がそのまま見える。既定の不透明モードでデスクトップが透けないよう、`build_window` の `.background_color(...)` と `tauri.conf.json` の `backgroundColor`（main ウィンドウ）にダークの下地色を置いてある。Rust 側の定数は `DARK_SURFACE_RGB` で、`theme.css` のダーク `--bg-primary-rgb` と手動同期（parse 失敗時のフォールバックも兼ねる）。なお per-pixel alpha 自体は生成時に外せない（builder にフラグが無い）ので、mount までのごく短い間だけ透過ウィンドウのままである点は残る
- **DWM 呼び出しは main スレッドで**: `window_set_backdrop` は tokio ワーカーで走るので、DWM / window-vibrancy の呼び出しは `run_on_main_thread` に載せる（ウィンドウ属性の変更はそのウィンドウの所有スレッドで行う）。なお `hwnd()` が返すのは tauri 側の windows 0.61 の `HWND` で、直接依存の 0.62 とは別型なので生ポインタ経由で渡し直す
- **アクリルの注意**: Win11 22621+ の `apply_acrylic` は `DWMWA_SYSTEMBACKDROP_TYPE`（TRANSIENTWINDOW）を使う。window-vibrancy 自身がドラッグ・リサイズが重くなる旨を警告しているので、体感の重さの報告が出たらまずここを疑う
- **アクリルは非アクティブのあいだ外す（#277）**: Win11 22621+ の `DWMWA_SYSTEMBACKDROP_TYPE` は、DWM が**非アクティブのウィンドウではマテリアルを描かず、代わりに不透明のフォールバックをウィンドウの裏に塗る**。per-pixel alpha は効いたままなのに何も透けなくなるので、「アクリルにすると非アクティブのとき透過が効かない」という形で出る（window-vibrancy #139 は OS の挙動として not planned でクローズ。Windows Terminal にも同じ報告が並ぶ）。そこで `WindowEvent::Focused` でマテリアルを付け外しし、非アクティブのあいだは `transparent` モードと同じ素の透過に落とす（ぼかしは消えるが透けたままになる）
  - **設定はプロセスに 1 つの `ACRYLIC_BACKDROP` に写す**（`CLOSE_TO_TRAY` と同じ手口）。`window_set_backdrop` はステートレスで、フロントは設定が変わったときにしか呼ばないので、focus 側から読む先が要る。**ウィンドウごとに持たなくてよい**: `windowBackdrop` は `pike:settings` にあり、全ウィンドウが同じ値をブロードキャストで共有する
  - **`window_set_backdrop` 自身も focus を見る**。テーマ切替などで非アクティブのまま呼ばれることがあり、素直に載せるとそこから次の focus まで不透明に戻る
  - **`clear_mica`（旧ビルドの後始末）は設定を変えた経路にだけ置く**。DWMSBT では `clear_acrylic` と同じ属性書き込みなので、focus のたびに撃つと同じ値を 2 回書くだけになる
  - **`clear_acrylic` は per-pixel alpha を触らない**。透過を殺しているのはあくまで DWM のフォールバックなので、外す側で `set_per_pixel_alpha` に手を出さないこと
  - **外れているあいだは alpha を不透明側へ寄せる**（`stores/settings.ts` の `ACRYLIC_FALLBACK_LIFT`＝0.4。不透明度 40% なら 64% になる）。アクリルは背後をぼかして薄めるので、素の透過に落ちると同じ不透明度でもずっと透けて見える。実効値は**store の `surfaceAlpha` が唯一の出典**で、透過する側はそこだけを読む。以前は App.vue と `TerminalTab` が `windowOpacity` から別々に組み立てていたので、この持ち上げを片方にだけ書くと画面の中で濃さが割れる
  - ターミナルの下地も同じ理由で store に上げた（`terminalSurfaceBg`）。**`xtermTheme` と対で置く**: あちらが xterm 側を透明にして、こちらが唯一の色を塗る、で 1 つの規則になっている。全ターミナルで同じ値なのでタブごとに組み立てる意味も無い（保持中のタブも生きているので #264 以降は枚数が増える）
  - **focus はフロントも Rust と同じ信号で見る**（`lib/window.ts` の `windowFocused` ＝ `onFocusChanged`）。`document.hasFocus()` はタイトルバーだけをクリックしたときに webview へフォーカスが入らずネイティブ側とずれるので、alpha の持ち上げとマテリアルの付け外しのタイミングが食い違う
  - **アクリルでなければ focus のハンドラは何もしない**。既定は不透明モードなので、素通しにすると全ウィンドウの focus / blur ごとに dwmapi を叩くことになる。外す仕事は設定を変えた経路が済ませている
  - **Win11 22621 より前では、そもそもこの問題が起きない**（window-vibrancy が `SetWindowCompositionAttribute` の経路に落ち、非アクティブでもぼかしが残る）。そこでは Pike が余計にマテリアルを外すことになるが、README がサポート対象を Windows 11 と macOS に絞っているので分岐は足していない
- **合成の仕組み**: `theme.css` の背景変数は `rgb(<成分> / var(--surface-alpha))` で合成する。`--surface-alpha` は App.vue が backdrop 設定から算出して `documentElement` に書き込む 1 変数で、これだけで全サーフェスが一括で半透明になる。基盤レイヤーは `#app` の 1 枚だけ（html/body/#app で重ね塗りすると不透明度が掛け算になる）
- **xterm を載せるタブには `.xterm-surface` を付ける**: xterm.css が `.xterm-viewport` に不透明の黒を焼き込んでいる（OS-X のスクロールバー対策）ので、打ち消さないと下地の色が隠れる。規則は `theme.css` に 1 本置いてあり、`TerminalTab` と `DockerLogsTab` が同じクラスと `opaque` の出し分けを共有する。色は store の `terminalSurfaceBg`、`allowTransparency` も backdrop に追従させること（Docker ログタブは 3 つとも欠けていて、backdrop を有効にするとそこだけ不透明のままだった）
- **浮遊サーフェスは不透明**: コンテキストメニュー・ドロップダウン・ダイアログ・ツールチップは透けると読み辛いので `.popup-surface` クラスをルート要素に付ける。**新しいポップアップを追加したら必ず付けること**（付け忘れは backdrop を有効にしたときだけ再現するので、既定の不透明モードでは気付けない）
- **なぜクラスで `--bg-*` を再宣言するのか**: カスタムプロパティの `var()` は**宣言した要素**（`:root`）で置換が確定し、子孫は合成済みの色を継承する。よって子孫で `--surface-alpha` だけ上書きしても効かない。`.popup-surface` はポップアップが実際に塗る 4 変数（`--bg-primary/secondary/tertiary`・`--tab-hover-bg`）を再宣言して、置換をその要素で起こす。背景変数を増やすときは `*-rgb` 側とこのブロックの同期に注意
- **ポップアップの色味**: 素のテーマ色だとアクリル上で黒浮きするため、`--popup-lift-color`（dark=白 / light=黒）を `--popup-lift`（= `(1 - --surface-alpha) × 10%`）だけ `color-mix` で混ぜ、周囲が背景の透けで持ち上がったぶんを不透明色で模倣する。係数 10 は目視調整値
- ターミナルは xterm 背景を透明にしラッパー 1 層でティント（`xtermTheme`）、エディタは CodeMirror の透過 Compartment で背景を透明化する

## グローバルモード（#123）
- プロジェクト非依存・サイドバー無しのウィンドウ。ラベル prefix `global-`（Rust `GLOBAL_PREFIX` / front `isGlobalWindow()`、旧 `secondary-` を置換）
- **ウィンドウラベル prefix を追加・変更したら `src-tauri/capabilities/default.json` の `windows` も更新すること**。ここはラベルのホワイトリストで、漏れると新ウィンドウで IPC（invoke / listen / set_title 等）が全部 permission エラーになり、App.vue の onMounted が途中で落ちてタブが一切開かない（DevTools コンソールの `not allowed on window "..."` が症状）
- App.vue の `globalMode` ref が制御: SideBar / ProjectSwitcher / QuickOpen を非表示、プロジェクト復元をスキップ、**全タブを閉じるとウィンドウも close**（`tabs.length` の watch、prev>0 → 0 のみ）
- 発動経路は 3 つ:
  1. **エディタ**: `--wait` と、プロジェクトウィンドウに一致しないファイル引数（`global-` ウィンドウ生成 + pending）。**コールドスタートのファイル引数**（「プログラムから開く」等）は main ウィンドウが `peekInitialCliAction()` で openFiles を検知して globalMode に入る（`last_project.txt` は消費しないので次回の素の起動で全プロジェクト復元される）
  2. **ターミナル**: 起動済みで引数なし `pike` → `CliAction::OpenTerminal { cwd, shell: Option<ShellConfig> }`（`cli::terminal_action_for_cwd`: cwd が WSL UNC ならその distro の WSL を `Some` で指定、それ以外は `shell=None`＝「指定なし」。#125）。フロント `useCliOpen` が `None` の時は Settings の `globalShell` で開き、`globalShell` が WSL なら Windows の cwd を捨てて WSL ホーム開始（`--cd ~`）、Windows シェルなら cwd 引き継ぎ。従来の「既存ウィンドウにフォーカス」挙動を置換（Windows Terminal 代替）
  3. **OpenDirectory の ad-hoc 作成失敗フォールバック**（ターミナルタブ）
- **WSL パスの UNC 化**: プロジェクト無しウィンドウのファイル I/O は Windows 側（`shellForIO` fallback = powershell）で走るため、WSL native パスは `CliFileTarget.distro` ヒントから `\\wsl.localhost\{distro}\...` に組み立てて開く（front `tabPathFor` ↔ Rust `wait_tab_path` が同期必須: --wait の解放照合はタブの path で行われる）
- CLI で開くファイルは拡張子ルーティング（画像→PreviewTab / pdf→PdfTab / 他→EditorTab、`useCliOpen.openFileTarget`）。PdfTab は shell fallback（powershell）でプロジェクト無しでも表示可
- **ターミナルの「+」**: グローバルモードでは Settings の `globalShell`（`ShellType`、既定 powershell）で起動。この設定はマシンの WSL distro に依存するため **`pike:sync-path` と同じマシンローカル扱い**: 独立キー `pike:global-shell` に保存し、同期ファイル・クロスウィンドウ broadcast の対象外（`sanitizeGlobalShell` で破損値ガード）。▾ ドロップダウンの内容は **シェルプロファイル**（後述 #129）駆動。アイコンは `lib/shellIcons.ts` の `SHELL_KIND_ICONS`（TabPane と SettingsTab で共有）。distro 検出はメニュー初回オープン時に lazy
- **シェルプロファイル（#129）**: ターミナル追加の ▾ プルダウンと各シェル選択肢の並び順・表示/非表示を管理。`ShellProfile { id, shell, hidden? }` の配列を `stores/settings.ts` が `pike:shell-profiles` キーにマシンローカル永続化（globalShell と同じく**同期ファイルの対象外**）。ただし**クロスウィンドウ broadcast はする**（`pike://shell-profiles-changed`、#240）: マシンローカルでも同じマシンのウィンドウ同士では揃っている必要がある。ジャンプリストとトレイはプロセスに 1 つの資源で、どのウィンドウからでも張り直されるため、起動時のコピーを持ったままのウィンドウが「別のウィンドウが検出した WSL の distro が無い」「今隠したシェルがまだ居る」一覧を publish してしまう。**publish の直前に localStorage を読み直す形は採らない**（同じ変更で走る永続化 watcher と読みが競合する）。`syncShellProfiles(distros)` が `detect_wsl_distros` 結果と照合（新規 distro は先頭に追加・消えた distro は除去・既存の順序と hidden は維持。**空検出は過渡状態とみなし reconcile skip** = カスタマイズ消失防止）。`windowsShellOptions(currentKind?)` / `visibleWslDistros(detected, currentDistro?)` が hidden 除外の選択肢を返す（現在値は hidden でも残す）。`defaultWindowsShellKind()` は作成フォームの既定（powershell 優先）。`ensureVisiblePerCategory` で WSL/Windows 各カテゴリ最低 1 つは可視を保証（UI の `canHideShellProfile` と二重ガード）。既定シェルは ▾ で hidden でも一覧に残す。UI は SettingsTab「シェル一覧」（↑↓・目トグル・デフォルトバッジ）
- **PowerShell 7（pwsh、#127）**: Windows PowerShell 5（`ShellConfig::Powershell`）と併存する独立シェル種別 `ShellConfig::Pwsh` / `ShellType {kind:'pwsh'}`。`pty/mod.rs` の `find_pwsh()` が PATH → `C:\Program Files\PowerShell\7\pwsh.exe` → bare `pwsh.exe`（Store 版の実行エイリアス対策）の順で解決。`cls`/`;`/`$LASTEXITCODE` の PowerShell 系分岐は front `isPowershellFamily(kind)` で powershell/pwsh 共通化
- **ProjectSwitcher（Ctrl+Shift+P）はグローバルモードでも使用可**。選択・新規作成は常に `openProjectWindow`（グローバルウィンドウ自身はプロジェクトレスを維持、`selectProject`）。グローバルウィンドウは起動時に projects を読まないため showSwitcher の watch で lazy load。QuickOpen（Ctrl+P）は非表示のまま
- **バイナリ安全装置**: `fs_read_file` の自動判定時に先頭 8KB の NUL バイトで Err を返す（EditorTab がエラー表示）。UTF-16 BOM は先に BOM 判定してテキスト扱い、UTF-8 BOM は従来どおり素通し（保存ラウンドトリップ維持）。StatusBar からの明示エンコード指定はガードなし（escape hatch）

## pike CLI
- バイナリ名 `pike.exe`（`Cargo.toml` `[[bin]] name = "pike"`）
- `tauri-plugin-single-instance` で二重起動を防止、引数を既存インスタンスに転送
- `pike file.rs:42` → ファイルを開いてジャンプ、`pike open <file>` も同様。**複数ファイル引数対応**（`CliAction::OpenFiles { files: Vec<CliFileTarget{path,line,distro}> }`、pike.exe へのドラッグ&ドロップ / エクスプローラー「プログラムから開く」経由）
- `pike .` / `pike <dir>` → ディレクトリに一致するプロジェクトに切替（ディレクトリは**先頭引数のみ**有効）
- マッチしない場合は**一時プロジェクト**として開き、ウィンドウが登録するか 1 度だけ聞く（#230。以前は `project.json` を書く ad-hoc プロジェクトを黙って作っていた）
- **存在しない root もプロジェクト起動として扱う（#212）**: `resolve_path_arg` はファイルシステムにしか聞けないので、未 clone のプロジェクト root（や WSL 停止中の root）は `is_dir=false` で `OpenFiles` になり、ディレクトリを開くエディタタブができていた。ジャンプリスト（#160）が渡すのは正にこの root なので、`lib.rs` の `as_project_dir` が**単独・行番号なしのパス引数が登録済み root と一致したら `OpenDirectory` に読み替える**（`project_for_root` は `normalize_path` 比較）。これで通常のプロジェクトルーティングに乗り、開いたウィンドウが clone を提案できる
- **コールドスタートでプロジェクトを開く（#212）**: 従来、Pike 停止中の `pike <dir>` は初期アクションを main に渡すだけで、フロントは `restoreLastProject` にフォールバックしていた（＝ジャンプリストから起動しても前回セッションが開く）。setup で root が登録済みプロジェクトに一致したら `project::set_window_project(state, "main", id)` で **`window_projects` を seed** し、フロントは既存の `project_for_window` 経路でそのプロジェクトに切り替わる（`window_projects` への書き込みはこの関数に一本化。`build_project_window` / `project_add_open` も同じ入口）。`last_project.txt` のクリアは**フロント側**（App.vue の `isMainWindow()` 分岐）で行う: この起動は前回セッションの復元ではなく、`project_add_open` が直後に自分を書き戻す。クリアしないと前回分が積み上がって次の素の起動で全部開く。`restoreLastProject` も同じ `projectSetLast([])` を呼ぶので、クリアの所有者はフロント 1 箇所に揃う
- ファイル引数のルーティング: `--from-window` 発ウィンドウ → **全ファイルを含む**プロジェクトウィンドウ → グローバルウィンドウの順（`CliState.pending` でアクションを転送）
- 既存エディタタブがある場合はフォーカス＋リロード（`reloadRequested` タイムスタンプ）
- **NSIS インストーラフック**（`src-tauri/nsis/hooks.nsi`、`tauri.conf.json` の `bundle.windows.nsis.installerHooks`）: POSTINSTALL でユーザー PATH に `$INSTDIR` を冪等追加（#146。REG_EXPAND_SZ 維持・updater の再インストールでも重複しない）と、**エクスプローラー「プログラムから開く」候補登録**（`SHCTX\Software\Classes\Applications\pike.exe` に `FriendlyAppName` + `shell\open\command`。SupportedTypes 非設定 = 全拡張子の「別のアプリを選択」一覧に出る。既定の関連付けは変更しない）。PREUNINSTALL で両方を削除。MSI インストーラにはこのフックは無い（NSIS 推奨の理由の 1 つ）

## `pike --wait`（GIT_EDITOR 連携）
- `src-tauri/src/wait.rs`。`GIT_EDITOR="pike.exe --wait"` でコミットメッセージ編集に対応
- 二次インスタンスが WM_COPYDATA（single-instance プラグインの規約）でファイルパスを既存ウィンドウに転送、`WaitState` で wait_id ↔ (パス, ウィンドウラベル) を管理
- エディタタブを閉じると待機中プロセスが解放され、ウィンドウも自動で閉じる。ウィンドウ破棄時の abort は**そのウィンドウが所有する wait のみ**（グローバルターミナルウィンドウの開閉が無関係な GIT_EDITOR 待機を解放しないため）
- **ファイル引数なしの `--wait`**（素の `pike --wait` や directory 引数）は待機対象が無いため、abort イベントで即座に CLI を解放してから通常のアクション処理に回す（解放しないと CLI が永遠にブロックする）

## Windows ジャンプリスト（タスクバー右クリック、#160）
- タスクバーのピン留め / 実行中ボタンを右クリックしたときのメニュー（ジャンプリスト）に独自項目を差し込む。`src-tauri/src/jumplist/mod.rs`（Windows 専用、`ICustomDestinationList` COM API）
- 構成: (1) Tasks カテゴリ＝**シェルごとのターミナル起動**（#240。表示中のシェル 1 つにつき 1 項目で、タイトルはシェル名、`pike.exe --terminal "--shell=<id>"`、作業ディレクトリ=`%USERPROFILE%`）。ジャンプリストはサブメニューを持てないので平並びにする（Windows Terminal のプロファイル一覧と同じ形）、(2) 独自カテゴリ「プロジェクト」→ 登録プロジェクトを **`last_opened` 降順**で最大 `MAX_PROJECTS`=10 件。選ぶと `pike.exe <root>`（single-instance の `OpenDirectory` ルーティングを再利用＝既存ウィンドウならフォーカス、無ければ新規＋セッション復元）、(3) `AppendKnownCategory(KDC_RECENT)` で既定の「最近開いたファイル」を復元（カスタムリストを構築すると明示追加しない限り消えるため）
- **WSL プロジェクトのパス引数**: root がネイティブパス（`/home/...`）なので、CLI で解釈できる UNC 形 `\\wsl.localhost\<distro>\...`（`open_arg_for`）に変換して渡す。`cli::resolve_path_arg` が native へ戻して `OpenDirectory` のマッチに使う（WSL 停止中は canonicalize 失敗で file 扱いに劣化するが実害小）
- **タイトルは VT_LPWSTR**: `IPropertyStore` の `PKEY_Title` に手組み PROPVARIANT（`CoTaskMemAlloc` した文字列、Drop の `PropVariantClear` が解放）を入れる。crate の `From<&str>` は **VT_BSTR** になりジャンプリストのタイトルとして表示されないため
- **COM スレッド（main に載せてはいけない）**: shell オブジェクトは STA なので専用スレッドが要る。**構築は `jumplist` という常駐スレッド**（`worker()` が lazy 起動、起動時に `CoInitializeEx(COINIT_APARTMENTTHREADED)` して以後初期化しっぱなし、ジョブは channel 送信で投げっぱなし）で行う。**`run_on_main_thread` に載せるとアプリ全体がハングする**: `AppendKnownCategory(KDC_RECENT)` と `CommitList` はシェルの最近使った項目を解決するため AppResolver と LINKINFO/MPR を引き込み、Pike が WSL プロジェクトに渡す `\\wsl.localhost\<distro>\...` の UNC 解決で数十秒ブロックしうる。その間 UI スレッドが止まり Windows に AppHangB1 で強制終了された（v0.27.0 / v0.28.0 で実測。WER の LoadedModule に `appresolver.dll` / `LINKINFO.dll` / `MPR.dll` / `ntshrui.dll` が並ぶのが指紋）。溜まったジョブは `try_iter().last()` で最新だけ処理する（複数ウィンドウが同じ変更で一斉に呼ぶため）
- **AppUserModelID**: 明示設定せず exe パス由来の暗黙 ID に載せる（インストーラのショートカット・実行プロセス・カスタムリストが同一 ID になり整合。dev ビルドと本番は exe パスが違うので自然に分離）
- **シェル一覧はフロントから渡す**（#240）: `pike:shell-profiles` は localStorage にありマシンローカルなので Rust からは読めない。`menus_refresh` の引数 `shells: Vec<MenuShell>`（`{ id, label }`）で受け、Rust は表示と引数の組み立てだけを行う。`id` はフロントの `shellId` と同じ表記（`wsl:<distro>` / `cmd` / `powershell` / `pwsh` / `git-bash`）で、**戻す側は `types::shell_from_id` の 1 箇所**（CLI の `--shell=` とトレイの `tray:new-terminal:<id>` が同じ関数を通る）。信頼できない入力の入口なので distro は文字種を絞って検証する
- **WSL シェルを指定したときの cwd は落とす**（`cli::terminal_cwd_for`）: ジャンプリストのリンクは作業ディレクトリが `%USERPROFILE%` なので、そのまま渡すと distro の中で意味を持たない Windows パスで開こうとする。UNC 形（`\\wsl.localhost\<distro>\...`）なら native へ直し、別の distro のものなら捨てる。フロント側の globalShell 経路（`useCliOpen`）が前からやっているのと同じ判断を、明示指定の経路でも Rust 側で 1 回だけ行う
- **WSL のエントリはディストロ検出のあとに出る**: `syncShellProfiles` はターミナル追加の ▾ を初めて開いたときに走る。検出前は Windows のシェルだけが並ぶが、プロファイルは永続化されるので次回以降は起動直後から出る（検出のためだけに起動時へ `wsl.exe` を足さない）
- **更新契機**: `stores/project.ts` の **`watch`（`projects` の id/name/root/lastOpened ＋ `locale` ＋ `settings.menuShells` をキー化）** → `menusRefresh(locale, shells)` コマンド（jump list と tray を 1 コマンドで更新。Rust 側でプロジェクト一覧を 1 回だけ読んで両者に渡す＝二重ディスク読み回避）。起動時のロード・プロジェクト追加/削除/編集・切替（recency）・UI 言語切替を 1 箇所でカバーする。**session flush（`lastSession` 書き換え）は同一オブジェクトを触るが、Vue のプロパティ単位トラッキングでキーのゲッターが再評価されず発火しない**（`currentProject` は `projects` の要素と同一参照なので naive な deep watch だと flush ごとに発火してしまう点に注意）。加えて Rust 側が **署名（exe＋lang＋各項目の title/args＋シェル一覧）を比較して不変なら CommitList をスキップ**するので二重に過剰再構築を防ぐ。ラベルは Rust からフロント i18n を読めないため locale を引数で受け 2 文字列だけ言語別に持つ
- ユーザーが「一覧から削除」した項目は `BeginList` の removed 配列（引数で照合）で除外し、`AppendCategory` 失敗時も Tasks/Recent は生かす

## システムトレイ（タスクトレイ、#161）
- `src-tauri/src/tray/mod.rs`（`tauri` の `tray-icon` feature）。トレイに常駐し、ウィンドウを閉じても復帰できる。`tray/mod.rs` は presentation（アイコン・メニュー・ツールチップ構築）に徹し、メニューの動作は lib.rs の `pub(crate) fn tray_menu_action` / `toggle_main_window` に委譲（ウィンドウ生成/フォーカスの private ヘルパーが lib.rs 側にあるため）
- **クローズ動作 = トレイ常駐（設定で切替）**: main の `CloseRequested` は常に `prevent_close`（生の破棄は async ランタイムを落とし他ウィンドウの Codex cleanup が panic するため必ず防ぐ）した上で、**設定 `closeToTray`（既定 ON）で分岐**。ON → `hide` + `main-minimized-to-tray` emit（session/PTY/ポーリングは生かしたまま、トレイから復帰、実終了はトレイ「終了」の `app.exit(0)` のみ）。OFF → 次の bullet の分岐で終了する（Destroyed の Codex cleanup は `try_current()` ガードで runtime 消失時も panic しない）。設定はフロントの localStorage にあり Rust から読めないので、プロセスグローバルな `static CLOSE_TO_TRAY: AtomicBool`（既定 true）を `tray_set_close_to_tray` コマンドで同期（App.vue の `watch(settingsStore.closeToTray, immediate)`、**main ウィンドウのみ**。他ウィンドウでの切替はクロスウィンドウ設定ブロードキャストで main のストアに伝播し main の watch が発火する）。旧 `app-should-exit` 自動終了・`window-hide-requested` でのポーリング停止は廃止
- **closeToTray OFF でも close は他ウィンドウを道連れにしない（#202）**: main の close は、他ウィンドウが残っていれば hide + `static MAIN_CLOSED_HIDDEN`（既定 false）を立てる + `main-window-hidden` emit（フロントは session 保存のみ。トレイ常駐ではないのでトレイヒントは出さない）、main が最後なら `main-exit-requested` → フロント確認 → `app_exit`。要点は**「論理的に閉じた main」をアプリを生かす対象に数えない**こと。判定は `close_would_quit(app, label)`（`label` 以外に生きたウィンドウが残るか。`MAIN_CLOSED_HIDDEN` が立った main は数えない）に集約し、`CloseRequested` / `Destroyed`（最後の 1 つが閉じたら cleanup 後に `app.exit(0)`）/ `window_close_quits_app`（フロントの close 確認をアプリ全体の busy 件数に切替）が共有する。破棄できない main の代用が hide なので、フラグの上げ下げは `hide_main_window(app, logically_closed)` と `restore_window`（トレイ左クリック・「表示」・プロジェクトフォーカス・CLI の `emit_action_to`）の対に集約し、`tray_set_close_to_tray(true)` も下ろす。**main を hide / 再表示する経路を足すときは必ずこの 2 つを通す**（自前で show すると論理的に閉じたままになり、次のウィンドウ close で見えている main ごと終了する）。#21 / #53 の「main を閉じると全ウィンドウが道連れ」はこの分岐が無かったための再発
- **左クリック**: `toggle_main_window`（表示中かつフォーカス時は hide、それ以外は show+unminimize+focus）。`show_menu_on_left_click(false)` でメニューは右クリック専用
- **右クリックメニュー**（`build_menu`、id 規約 `tray:show` / `tray:new-terminal:{shellId}` / `tray:switcher` / `tray:quit` / `tray:proj:{id}`）: 表示 / 新しいターミナルウィンドウ（**シェルごとのサブメニュー**、#240。`create_global_window`+OpenTerminal に `shell` を載せる。パースできない id は近そうなシェルで代用せず何も開かない。シェル一覧が空のときだけ従来の単独項目 `tray:new-terminal` に落ちる＝`tray::build` が起動時に空で作るため。ジャンプリストのほうは `menus_refresh` 以外から呼ばれないので、この分岐を持たない）/ 最近のプロジェクト（サブメニュー、`read_all_projects_sorted` 最大 8 件、選ぶと該当ウィンドウ focus か `build_window`）/ プロジェクトを開く…（main を show して `tray-open-switcher` を emit_to→スイッチャー表示）/ 終了
- **更新契機**: jump list と共通の `menus_refresh` コマンド（前述）が `tray::refresh(app, lang, &projects, &shells)` を呼び `app.tray_by_id("main").set_menu` で作り直す。プロジェクト一覧は menus_refresh が 1 回だけ読んで jump list と共有。起動時の `tray::build` はサブメニュー空（静的項目のみ）で作り、mount 後の menus_refresh が一覧つきに差し替える。ラベルは locale 引数で言語別（Rust からフロント i18n は読めない）
- **使用量ツールチップ**: main の StatusBar だけが（トレイは 1 プロセス 1 リソースなので）usage を整形して `traySetTooltip` で push。Claude 5h レート（アカウント単位なので代表値）優先、無ければトークン総量、無ければ空文字。**フロントが渡すのは usage の要約だけ**で、先頭のアプリ名（開発版の `[DEBUG]` 目印を含む）は `tray::set_tooltip` が付ける。hide 中もポーリングを止めないので畳んだ状態でも更新される
- **初回ヒント**: 初めて閉じたとき `resolveNotifier`（`lib/notify.ts`）で OS 通知（`localStorage['pike:tray-hint-shown']` で 1 回のみ）。ウィンドウが消えたと勘違いさせないため
- アイコンは `app.default_window_icon()` を流用（追加の image feature 不要）

