# エージェント実装ルール

トークン使用量の集計。
実体は `src-tauri/src/claude_usage/`、`src-tauri/src/codex_usage/`。

**エージェントはターミナルで動かす（#275）。** 独自 UI で会話を進める `agent-chat` タブと、その裏の
統一エージェント API（Codex app-server / ACP の runtime、`src-tauri/src/agent/` と
`src-tauri/src/codex/`）は削除した。運用ではターミナルタブで agent CLI を直接動かして支障が無く、
独自 UI を保つ価値が薄いという判断。**新しいエージェントを足すときもチャットは実装しない**。

この削除で下の 2 つが単純になっている。

- **使用量の出所が 1 つになった**。以前は Codex だけ「active な agent-chat のセッションを優先し、
  無ければ CLI のログ解析に落ちる」の二本立てだった
- **入力待ちの検出は出力のパターン一致に一本化される**（#265）。runtime がターンの終了や承認待ちを
  知っている経路が無くなったため

## トークン使用量表示（Claude usage）
- `src-tauri/src/claude_usage/` が `~/.claude` 配下のログを解析し、セッションのトークン使用量を集計
- StatusBar のエージェント項目は**メーターアイコン＋ 5h / 週間の 2 つの利用率**（`25% / 5%`）。クリックで開くドロップダウンに Claude と Codex を並べ、モデル別の枠を含む内訳はエージェント状態タブへ
- **間接 Codex（CLI）usage**: Claude の codex スキルや `codex` を呼ぶスクリプト等、Pike の agent runtime を経由しない Codex も `src-tauri/src/codex_usage/` が `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` を解析して集計。`session_meta.cwd` を `project_root` と突き合わせ、`token_count` イベントの `total_token_usage`（累計）と `rate_limits.used_percent` を取得。pid が無いため**動作中判定はファイル mtime（直近 `ACTIVE_WINDOW_SECS`=300 秒、長いターンでもチラつかない幅）**。day-dir は session 開始日のフォルダに書かれるため最新 `SCAN_DAY_DIRS`=14 日分を走査（数字名の日付ディレクトリのみ。stat→mtime フィルタなので負荷は軽い）。未来 mtime（WSL/Windows 時計ズレ）は age 0=fresh 扱い。コストは**モデル別に集計**し cached を割引単価で計算（`input_tokens` は cached を含む）。表示は Claude と共通のエージェント項目（#226）。`gpt-5*-codex` は単価未登録のため費用は出さず利用率%を主指標とする
- **Claude レート制限（#117）**: `src-tauri/src/claude_usage/rate.rs` が `claude -p "/usage"` を `run_shell_line` で実行し、`Current <label>: N% used · resets <when>` 行をパース（5h セッション枠・週間枠・モデル別枠）。ラベル→`kind`（session/weekAll/other）の分類はパーサ隣の `window_kind` で行い、フロントは CLI 文言を文字列一致しない（session 枠が無ければチップの%表示自体を出さない）。CLI は起動に 10 秒超かかり時々ハングするため、**プロセス内キャッシュ（キーは wsl:distro / windows のインストール単位）+ fetch 直列化 Mutex + 90 秒タイムアウト**。試行間隔は `CacheEntry.last_attempt` で管理し、**active セッション中と失敗後リトライは 5 分（`TTL_ACTIVE`）、idle 中も 1 時間ごと（`TTL_IDLE`）に再取得**（別プロジェクトのセッションや 5h/週間枠の時間リセットで idle 中も値が動くため。sessionActive はプロジェクトスコープ、キャッシュはアカウントスコープという不一致を TTL_IDLE が緩和）。失敗時は前回値を保持するが **`STALE_KEEP_MAX`=2h を超えた古いデータは破棄**（CLI が恒久的に壊れたら表示を消す）。`fetched_at` はデータ取得時刻としてドロップダウンに表示。stdin は `null_device()` でクローズ（headless claude が stdin 待ちで 3 秒固まるため）。結果の `active` フィールドは usage-store ファクトリ契約（`{ active: boolean }`）に合わせた命名。手動更新は `createUsageStore` の `refreshUsage(force)` 経由（IPC 1 回）
- **複数アカウント（`CLAUDE_CONFIG_DIR`、#225）**: Claude Code はこの環境変数で `~/.claude` の位置ごと差し替える。空ディレクトリを指して起動して確かめたところ、`projects/` も `sessions/` も `.claude.json` もそこへ移るので、**集計・セッション一覧・レート取得の 3 つとも** `claude_usage/config.rs` の `resolve` を通す。検出の順と `.envrc` を評価しない理由はそのファイルの doc コメントが正本。issue の表題にある `CLAUDE_CONFIG_PATH` という変数は存在しない
  - **claude を起動する側には明示的に渡す**（`rate.rs` の `/usage`）。`bash -c`（非対話・非ログイン）で起動するので、渡さないと既定の `~/.claude` のアカウントで動き、ステータスバーが別アカウントの残量を出す
  - **WSL では `Command::env` が効かない**（`wsl.exe` という Windows プロセスにしか付かず distro の中へ渡らない）。bash に渡す行の頭で代入する。シェル別のクォート（bash の `VAR=v cmd` と cmd の `set "VAR=v" && cmd`）は `types.rs` の `run_shell_line_env` に集約してある。呼び出し側で前置を組み立てると、シェルの振り分けが変わったとき黙って壊れる
  - 環境変数のプローブは **distro 単位**でキャッシュする（rc ファイル由来なのでプロジェクトでは変わらない）。プロジェクトごとに違う入力は `.envrc` だけで、これは UNC 越しにただのファイルとして読めるので spawn が要らない。ウィンドウを何枚開いても distro につき 5 分に 1 回
  - **ロックはプローブ中も持ったまま**にする。usage と rate のポーリングは同じ tick で走るので、手放すと期限切れのたびに 2 本が同時にシェルを起動する
  - **プローブの先頭で `HISTFILE` を unset する**。対話シェル（`-lic`。`.bashrc` の export を拾うために必要）は終了時に履歴を書き戻すので、`HISTSIZE` の設定次第でプローブがユーザーの `.bash_history` を削りうる
  - マーカー行（`PIKEENV` + タブ）で拾う。`.bashrc` がバナーを stdout に出すことがあるので行の位置では選ばない（このマシンの `.bashrc` は実際に `git status` の結果を出す）
  - **実在を確認できたディレクトリだけ採用する**。読めない値を `native_override` に残すと、`claude` を起動する側がそれを export して別の場所を作らせてしまう。確認できなければ検出そのものを無かったことにして既定へ落ちる
  - Windows シェルは Pike のプロセス環境を見る（cmd / Git Bash は起動時に継承するので同じ値）。**PowerShell のプロファイルの中だけで設定した場合は拾えない**
  - **`.claude.json` の場所は 2 通り**。`CLAUDE_CONFIG_DIR` を設定していればその中、**既定では `~/.claude` の中ではなく隣**の `~/.claude.json`（Windows・WSL の実機で確認）。設定ディレクトリの中を先に見て、無ければ親を見る。中だけを見ていたころは、上書きしていない環境でアカウントが常に空だった
  - アカウント（`.claude.json` の `oauthAccount`）は **`resolve` の中で一緒に読む**。あのファイルは Claude Code のカウンタ置き場でもあって数十 KB あり、稼働中は数十秒ごとに mtime が変わるので、mtime キーのキャッシュだと 30 秒ポーリングのたびに UNC 越しに全文を読む。中身が変わるのはログインし直したときだけなので TTL に相乗りさせる
  - **検出に失敗しても黙って既定に落ちる**（`.bashrc` が `exec tmux` する、`.envrc` が `$(…)` を使う等）。プロジェクト単位の設定欄は作っていないので、そこが唯一の逃げ道は StatusBar のアカウント行になる。「思っていたのと違うメールアドレスが出ている」で気付ける形にはしてある
- cwd↔root 一致判定（`cwd_matches_root`）と WSL ホーム解決（`wsl_home_subdir_cached`）は `types.rs` の共通ヘルパーで、`claude_usage` / `codex_usage` が共有
- **エージェント状態タブ（#226）**: `tabs/AgentStatusTab.vue`（設定タブと同じシングルトン）。Claude と Codex を縦に並べ、アカウント・利用率（帯グラフ）・モデル別トークンを出す。導線は歯車メニューと StatusBar のドロップダウンの「詳細」の 2 つ。**StatusBar のドロップダウンは要約だけ**（アカウント・トークン合計・5h 枠）にして、内訳はこちらへ寄せた
  - **導出は `composables/useAgentUsage.ts` に集約**（どちらの Codex を優先するか、何をアカウント有りとみなすか、枠を帯に落とす変換）。2 つの画面に同じ computed を置いていたときは、「アカウント有り」の判定が既に食い違っていた。表示整形（ラベル・リセット時刻の日本語化・80/90% の色分け）は `lib/usageFormat.ts`。手動更新のスピナーは `createUsageStore` が公開する `refreshing`（両方の画面から同じ更新を駆動するため、コンポーネントのローカル ref では足りない）
  - **Codex は集計の窓と `active` を分ける**。`ACTIVE_WINDOW_SECS`=5 分は「今動いているか」で、集計は `RECENT_WINDOW_SECS`=24 時間。分ける前は 5 分前に終わった作業が状態画面から丸ごと消えていた（Claude の plugin 経由で使った直後でも「記録はありません」）。窓を広げたぶん `parse_session_cached` が mtime でキャッシュする（終わったロールアウトは変わらないので読み直す必要がない。キーにプロジェクトを含めないので、ウィンドウを何枚開いても 1 回しか読まない。掃除は**走査結果ではなく古さ**で行う（キャッシュはプロセス共有なので、片方のプロジェクトの走査結果で retain すると、シェルの違うもう片方のエントリを毎回全部落としてしまう））
  - **Codex のアカウントは `~/.codex/auth.json` の `tokens.id_token`（JWT）から読む**。メールアドレスは `email`、プランは `https://api.openai.com/auth` 内の `chatgpt_plan_type`。**署名は検証しない**（自分のマシンの自分の情報を表示するだけで、認証の判断には使わない）。取り出すのは 2 クレームだけで、トークン自体は外に出さない
  - **Claude のプランは `seatTier` に無いことがある**。個人のサブスクリプションでは null で、Team / Enterprise の席にしか入らない（実機で確認）。`organizationRateLimitTier` → `organizationType` の順に落とし、情報を持たない `default_` の接頭辞だけ外す。値そのものは加工しない（将来増える等級を勝手に読み替えると誤った名前を出す）
- フロント: ポーリング基盤は `stores/usageStore.ts` の `createUsageStore(id, fetcher)` ファクトリに集約（全フィールド deep 比較で rate%・cached 等も再描画。`refreshUsage(force)` で fetcher に force を伝搬）。`stores/claudeUsage.ts` / `stores/codexUsage.ts` / `stores/claudeRate.ts` は薄いラッパー（claudeRate の fetcher は claudeUsage の active を `sessionActive` として渡す）。型は `types/claudeUsage.ts` / `types/codexUsage.ts`、整形は `lib/format.ts` の `formatTokens` / `formatCost`。StatusBar は Claude と Codex を**1 項目に統合**し、ドロップダウンの中で節に分ける（#226。分けていたころは Codex 側が active のときしか出ず、状態タブと食い違っていた）。ヘッドラインは `useAgentUsage` の `headlineMeters`（Claude の 5h＋週間、Claude が枠を持たなければ Codex の primary＋secondary）。**2 つの数字は片方のエージェントから揃って取る**（並べた数字にどちらの枠か書く余地がないため、混ぜない）。ドロップダウンは 5h＋週間の `claudeSummaryMeters` / `codexMeters`、状態タブはモデル別を含む全枠の `claudeMeters`

## TODO パネルと `pike todo` の廃止（#278）

TODO パネル（`.pike/todo.md` のチェックリスト、#139・#163）と、それを端末から操作する
`pike todo` サブコマンド、`plugins/` のエージェント向けスキルは削除した。**エージェントが
自分のタスク管理を内蔵するようになり、別の置き場を用意する意味が薄れた**という判断で、
チャットを外した #275 と同じ流れ。

- **新しいエージェントを足すときも、この種のタスク置き場は作らない**
- ユーザーの `.pike/todo.md` は消さない（ただのファイルなので、そのまま残って読める）
- 空いたパネルの枠には issue パネルが入った（#278。詳細は `editor.md` の「issue パネル」）

