---
paths:
  - "src-tauri/src/agent_usage/**"
  - "src-tauri/src/claude_usage/mod.rs"
  - "src-tauri/src/claude_usage/rate.rs"
  - "src-tauri/src/codex_usage/**"
  - "src/lib/usageFormat.ts"
  - "src/stores/agentUsage.ts"
  - "src/stores/usageStore.ts"
  - "src/types/agentUsage.ts"
  - "src/composables/useAgentUsage.ts"
  - "src/components/tabs/AgentStatusTab.vue"
  - "src/components/RateMeters.vue"
  - "src/components/layout/StatusBar.vue"
---

# エージェントの使用量

トークン使用量・レート制限・ログイン切れの集計と、その表示（StatusBar とエージェント状態タブ）。
エージェントの一覧は `agent.md`、`CLAUDE_CONFIG_DIR` の解決と hook は `agent-hook.md`。

## 表示

- StatusBar のエージェント項目は**メーターアイコン＋ 5h / 週間の 2 つの利用率**（`25% / 5%`）。
  全エージェントを**1 項目に統合**し、クリックで開くドロップダウンに**使っているエージェントを
  順に**並べる（#263。種別の分岐は無い）。**ドロップダウンは要約だけ**（アカウント・トークン
  合計・5h 枠）にして、モデル別の枠を含む内訳はエージェント状態タブへ寄せる
  - ヘッドラインは `useAgentUsage` の `headline`（**利用率を出せる先頭のエージェント**の 5h＋
    週間）。**2 つの数字は片方のエージェントから揃って取る**（並べた数字にどちらの枠か書く余地が
    ないため、混ぜない）
- **エージェント状態タブ（#226 / #263）**: `tabs/AgentStatusTab.vue`（設定タブと同じシングルトン）。
  **記録のあるエージェントをカードにして並べる**（1 つのマークアップを回すだけで、種別の分岐は
  無い）。出るのはアダプタが返したものだけで、**4 つで揃わない**（Copilot にトークンは無く、
  opencode に利用率は無い）ので、無い節は出さない。導線は歯車メニューと StatusBar の
  ドロップダウンの「詳細」の 2 つ
- **導出は `composables/useAgentUsage.ts` に集約**（何をアカウント有りとみなすか、枠を帯に落とす
  変換、ログインの知らせを出すか）。2 つの画面に同じ computed を置くと判定が食い違う。表示整形
  （ラベル・リセット時刻の日本語化・80/90% の色分け）は `lib/usageFormat.ts`、トークンと費用は
  `lib/format.ts` の `formatTokens` / `formatCost`
- ポーリング基盤は `stores/usageStore.ts` の `createUsageStore(id, fetcher)` ファクトリに集約
  （全フィールド deep 比較で rate%・cached 等も再描画。`refreshUsage(force)` で fetcher に force を
  伝搬）。**ストアは表 1 行につき 1 本**（`stores/agentUsage.ts` が `AGENTS` から作る）。型は
  `types/agentUsage.ts`。手動更新のスピナーは `createUsageStore` が公開する `refreshing`（両方の
  画面から同じ更新を駆動するため、コンポーネントのローカル ref では足りない）
- cwd↔root 一致判定（`cwd_matches_root`）と WSL ホーム解決（`wsl_home_subdir_cached`）は
  `types.rs` の共通ヘルパーで、`claude_usage` / `codex_usage` が共有

## Claude

- `src-tauri/src/claude_usage/` が設定ディレクトリ配下のログを解析し、セッションのトークン使用量を
  集計する（設定ディレクトリの解決は `agent-hook.md`）
- **Claude のプランは `seatTier` に無いことがある**。個人のサブスクリプションでは null で、
  Team / Enterprise の席にしか入らない（実機で確認）。`organizationRateLimitTier` →
  `organizationType` の順に落とし、情報を持たない `default_` の接頭辞だけ外す。値そのものは
  加工しない（将来増える等級を勝手に読み替えると誤った名前を出す）

### レート制限（#117）

`src-tauri/src/claude_usage/rate.rs` が `claude -p "/usage"` を `run_shell_line` で実行し、
`Current <label>: N% used · resets <when>` 行をパースする（5h セッション枠・週間枠・モデル別枠）。

- ラベル→`kind`（session/weekAll/other）の分類はパーサ隣の `window_kind` で行い、フロントは
  CLI 文言を文字列一致しない（session 枠が無ければチップの%表示自体を出さない）
- CLI は起動に 10 秒超かかり時々ハングするため、**プロセス内キャッシュ（キーは wsl:distro /
  windows のインストール単位）+ fetch 直列化 Mutex + 90 秒タイムアウト**（`CLI_TIMEOUT`）
- 試行間隔は `CacheEntry.last_attempt` で管理し、**active セッション中と失敗後リトライは 5 分
  （`TTL_ACTIVE`）、idle 中も 1 時間ごと（`TTL_IDLE`）に再取得**。別プロジェクトのセッションや
  5h/週間枠の時間リセットで idle 中も値が動くため（sessionActive はプロジェクトスコープ、
  キャッシュはアカウントスコープという不一致を `TTL_IDLE` が緩和する）
- 失敗時は前回値を保持するが **`STALE_KEEP_MAX`=2h を超えた古いデータは破棄**（CLI が恒久的に
  壊れたら表示を消す）。`fetched_at` はデータ取得時刻としてドロップダウンに表示
- stdin は `null_device()` でクローズ（headless claude が stdin 待ちで 3 秒固まるため）
- 結果の `active` フィールドは usage-store ファクトリ契約（`{ active: boolean }`）に合わせた命名。
  手動更新は `createUsageStore` の `refreshUsage(force)` 経由（IPC 1 回）
- **claude を起動する側には `CLAUDE_CONFIG_DIR` を明示的に渡す**。`bash -c`（非対話・非ログイン）
  で起動するので、渡さないと既定の `~/.claude` のアカウントで動き、ステータスバーが別アカウントの
  残量を出す
  - **WSL では `Command::env` が効かない**（`wsl.exe` という Windows プロセスにしか付かず distro の
    中へ渡らない）。bash に渡す行の頭で代入する。シェル別のクォート（bash の `VAR=v cmd` と cmd の
    `set "VAR=v" && cmd`）は `types.rs` の `run_shell_line_env` に集約してある。呼び出し側で前置を
    組み立てると、シェルの振り分けが変わったとき黙って壊れる

### ログイン切れ（#381）

`ClaudeRateLimits.login_required` → `AgentUsage.login_required` で運ぶ。**検出のためにプロセスを
増やさない**（`/usage` は元から定期的に走っている）。

- **確かな印は `.claude.json` から `oauthAccount` が消えていること**（`config::ClaudeConfig` の
  `logged_out`）。`/logout` はこのキーを消す。**`account` が `None` であることを印にしてはいけない**:
  ファイルを読めなかったときも `None` になるので、UNC 越しに読めない構成（symlink で配った設定
  ディレクトリ）で「要ログイン」を出し続ける。`read_account` が「読めなかった」と「アカウントが
  無い」を分けて返すのはこのため
- **一番確かな印は `claude auth status --json` の `loggedIn`**（`run_auth_status`）。`/usage` より
  桁違いに軽く（この開発機で Windows 0.28 秒 / WSL 0.71 秒、`claude -p "/usage"` は 3.8 秒）、帯が
  取れなかったときだけ起こす。`--json` は既定だが明示する（`--text` もあるので、既定が変わった
  ときに黙ってパースが外れないように）
- **CLI の文言（`asks_for_login`）は最後の手段**。**2.1.278 では未ログインでも終了コード 0 で
  `Total cost: $0.00…` の要約だけを出し、`/login` に触れない**（Windows と WSL の両方で実測）。
  文言に頼り切ると検出が丸ごと効かなくなる
- **ログアウトが分かっているのに残量を出しているキャッシュは、TTL を待たずに捨てる**
  （`needs_fetch`）。`/logout` の直後のキャッシュは「ログイン済みで残量あり」なので、待つと最長
  1 時間そのまま出る
- **ログインを求められたら古い値に戻さない**（`STALE_KEEP_MAX` の据え置きを飛ばす）。出し続けると
  切れていることが見えない
- **拾えるのは「ログアウト」と「資格情報が手元で無効」まで**。`~/.claude/.credentials.json` は
  `expiresAt`（アクセストークン、1 時間程度）と `refreshTokenExpiresAt` を持ち、`claude auth status`
  はそれを見て答える。**サーバー側で明示的に取り消された状態だけは、呼び出して 401 が返るまで
  分からない**（`claude auth status` にサーバーへ問い合わせる口は無い）
- ボタンが走らせるコマンドは表の `AgentDef.login`（`claude auth login`）。**シェルと cwd は新規
  ターミナルと同じ `terminalPlace`**: `CLAUDE_CONFIG_DIR` を被せる起動ラッパーを使っていても、
  手で打つのと同じアカウントに入る（Pike が解決した設定ディレクトリを前置する形は採らない。
  シェルごとの引用が要るうえ、ラッパーの判断と二重になる）。終わったら `refreshUsage(true)` で
  取り直す

## Codex

`src-tauri/src/codex_usage/` が `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` を解析して集計する
（Claude の codex スキルや `codex` を呼ぶスクリプト経由の使用も、ここに現れる）。

- `session_meta.cwd` を `project_root` と突き合わせ、`token_count` イベントの `total_token_usage`
  （累計）と `rate_limits.used_percent` を取得する
- pid が無いため**動作中判定はファイル mtime**（直近 `ACTIVE_WINDOW_SECS`=300 秒。長いターンでも
  チラつかない幅）。**集計の窓は別で `RECENT_WINDOW_SECS`=24 時間**（5 分に揃えると、少し前に
  終わった作業が状態画面から丸ごと消える）
- 窓を広げたぶん `parse_session_cached` が mtime でキャッシュする（終わったロールアウトは変わらない
  ので読み直さない。キーにプロジェクトを含めないので、ウィンドウを何枚開いても 1 回しか読まない）。
  **掃除は走査結果ではなく古さで行う**（キャッシュはプロセス共有なので、片方のプロジェクトの走査
  結果で retain すると、シェルの違うもう片方のエントリを毎回全部落とす）
- day-dir は session 開始日のフォルダに書かれるため最新 `SCAN_DAY_DIRS`=14 日分を走査（数字名の
  日付ディレクトリのみ。stat→mtime フィルタなので負荷は軽い）。未来 mtime（WSL/Windows 時計
  ズレ）は age 0=fresh 扱い
- コストは**モデル別に集計**し cached を割引単価で計算（`input_tokens` は cached を含む）。
  `gpt-5*-codex` は単価未登録のため費用は出さず利用率%を主指標とする
- **Codex のアカウントは `~/.codex/auth.json` の `tokens.id_token`（JWT）から読む**。メール
  アドレスは `email`、プランは `https://api.openai.com/auth` 内の `chatgpt_plan_type`。**署名は
  検証しない**（自分のマシンの自分の情報を表示するだけで、認証の判断には使わない）。取り出すのは
  2 クレームだけで、トークン自体は外に出さない
