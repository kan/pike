// Pike が同梱する Claude Code の mod（#437）。Pike のターミナルで動く claude から、
// アカウントの申告・入力待ちの知らせ・レート制限・ターミナルごとの状態を Pike へ渡す。
//
// **渡し方は `pike agent-hook` を起こすだけ**（`settings.json` に登録する hook と同じ受け口。
// 受け側の正本は `src-tauri/src/agent_hook.rs`）。この mod が持つのは「いつ、何を付けて
// 起こすか」だけで、申告の置き場も配送も Rust の側にある。
//
// **Pike のターミナルの外では何もしない**（`PIKE_PTY_ID` と `PIKE_HOOK_EXE` が無い）。
// 利用者がこのフォルダを別の場所から読み込ませても、起こす相手が居ない。
//
// **セッションを待たせない。** `pike` の起動は待たずに `next(e)` へ進む（失敗も握り潰す）。
// 例外は 2 つ。目印の環境変数を立てるところ（同じイベントの settings hook より先に
// 立っていなければ意味が無い）と、セッションの終わり（待たないと、起こす前にプロセスが
// 終わる）。
import type { EngineInterface, Register } from 'claude-code'

/** レートの報告の最短間隔。ターンのたびにプロセスを起こさない。 */
const USAGE_INTERVAL_MS = 60_000
/** 枠が動いたときの最短間隔。動くたびに送ると、応答のたびにプロセスが立つ。 */
const USAGE_CHANGED_MS = 15_000

/** `Notification` の種類 → Pike の契機（`agent_hook.rs` の `NoticeKind`）。載っていない種類は知らせない。 */
const NOTICE_EVENTS: Record<string, string> = {
  permission_prompt: 'waiting',
  agent_needs_input: 'waiting',
  elicitation_dialog: 'waiting',
  idle_prompt: 'idle',
}

type Pike = { exe: string; installKey: string }

/**
 * `session.measure` は記録の場所（どのアカウントかの手がかり）を持たないので、classic の
 * イベントで見たものを覚えておく。
 *
 * **`SessionStart` だけで覚えない。** mod は読み直されることがあり（Pike の更新が
 * このファイルを書き換える）、そのときモジュールの変数は初期化される。`Stop` は
 * ターンのたびに `session.measure` の直前に来るので、そこで拾い直せば報告は止まらない。
 */
let transcriptPath: string | undefined
let lastUsageAt = 0

/** 読めた結果は覚える。どれも Pike が PTY の環境に置いた値で、セッションの途中で変わらない。 */
let pikeCache: Pike | undefined

async function pikeOf($: EngineInterface): Promise<Pike | undefined> {
  if (pikeCache) return pikeCache
  const exe = await $.env.get('PIKE_HOOK_EXE')
  const pty = await $.env.get('PIKE_PTY_ID')
  if (!exe || !pty) return undefined
  pikeCache = { exe, installKey: (await $.env.get('PIKE_INSTALL_KEY')) ?? '' }
  return pikeCache
}

/** `pike agent-hook` を起こす。**待たない**（呼び出し側は `void` で捨てる）。 */
async function report($: EngineInterface, pike: Pike, flags: string[], payload: unknown): Promise<void> {
  const argv = [pike.exe, 'agent-hook', '--via=mod', `--install-key=${pike.installKey}`, '--agent=claude', ...flags]
  try {
    await $.process.run(argv, { stdin: JSON.stringify(payload), timeoutMs: 10_000 })
  } catch {
    // Pike が居ない・起こせない。セッションには関係が無い。
  }
}

/**
 * 状態の報告（`--state=`）を、起きた順に 1 本ずつ送るための列。
 *
 * **報告は 1 件ごとに別のプロセス**なので、並べて起こすと Pike に届く順が入れ替わる
 * （終わったセッションに「待機中」が後から届いて一覧に残る、中断したターンの「実行中」が
 * 「待機中」の後に届いて印が回り続ける）。前の 1 本が終わってから次を起こす。
 */
let stateQueue: Promise<void> = Promise.resolve()

function enqueue(task: () => Promise<void>): Promise<void> {
  stateQueue = stateQueue.then(task)
  return stateQueue
}

/** 許可の確認を出したまま答えを待っているか。答えのあとに「実行中」へ戻すために覚える。 */
let awaitingPermission = false

/**
 * 許可の確認に答えが出たら「実行中」へ戻す。**待っていなければ何もしない**（ツールの
 * たびに呼ばれるので、プロセスを起こすのは確認を出していたときだけ）。
 */
async function reportResumed($: EngineInterface): Promise<void> {
  if (awaitingPermission) await reportRunning($)
}

/** ターンが走っていることを知らせる（始まったときと、確認に答えが出たとき）。 */
async function reportRunning($: EngineInterface): Promise<void> {
  awaitingPermission = false
  const pike = await pikeOf($)
  if (pike) void enqueue(() => report($, pike, ['--state=running'], {}))
}

/**
 * ターンが終わったことを、コンテキストの埋まり具合を添えて知らせる。
 *
 * **`session.measure` を待たずにここで読む。** あちらは値が動いたときにしか来ないので、
 * 応答の前に中断したターンでは来ず、タブが「実行中」のまま残る。
 */
async function reportIdle($: EngineInterface, pike: Pike): Promise<void> {
  const flags = ['--state=idle']
  try {
    const { context } = await $.session.usage()
    // 最初の応答より前（始めたばかり・圧縮の直後）は `tokens` が無い。
    if (context.tokens !== undefined) flags.push(`--context=${context.tokens}/${context.window}`)
  } catch {
    // 読めなくても、終わったことは知らせる。
  }
  await report($, pike, flags, {})
}

export const register: Register = (on) => {
  on('classic.SessionStart', async ($, e, next) => {
    const pike = await pikeOf($)
    if (!pike) return next(e)
    // **この mod が動いている目印。** `settings.json` に登録済みの同じ hook は、これを見て
    // 何もせずに終わる（二重の通知を防ぐ）。`next(e)` がその hook を走らせるので、先に立てる。
    await $.env.set('PIKE_AGENT_MOD', '1')
    transcriptPath = e.transcript_path
    // 申告（stdin）と、このターミナルでセッションが始まったことを 1 回で渡す。
    const flags = ['--state=session', `--session=${e.session_id}`]
    void enqueue(() => report($, pike, flags, { transcript_path: e.transcript_path, cwd: e.cwd }))
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    const event = NOTICE_EVENTS[e.notification_type]
    // 許可の確認は `PermissionRequest` で知らせ済み。答えを待っているあいだに来る
    // 同じ確認の `permission_prompt` では、プロセスを起こさない。
    const known = awaitingPermission && e.notification_type === 'permission_prompt'
    const pike = event && !known ? await pikeOf($) : undefined
    if (pike) void report($, pike, [`--event=${event}`], {})
    return next(e)
  })

  // 許可の確認が出た時点で知らせる。`Notification` の `permission_prompt` は同じ確認の
  // 約 6 秒後に来る（実測）ので、そちらだけだと知らせが遅れる。
  //
  // 状態（`--state=waiting`）も同じ 1 回で渡す。知らせは「まだ見ていない」あいだだけの
  // 印で、状態は答えるまで続く（`agent_hook.rs` の `StateKind::Waiting`）。
  on('classic.PermissionRequest', async ($, e, next) => {
    const pike = await pikeOf($)
    if (pike) {
      awaitingPermission = true
      void enqueue(() => report($, pike, ['--state=waiting', '--event=waiting'], {}))
    }
    return next(e)
  })

  // 確認に答えが出た（ツールが走った・失敗した・断られた）。ターンはまだ続いている。
  on('classic.PostToolUse', async ($, e, next) => (await reportResumed($), next(e)))
  on('classic.PostToolUseFailure', async ($, e, next) => (await reportResumed($), next(e)))
  on('classic.PermissionDenied', async ($, e, next) => (await reportResumed($), next(e)))

  on('classic.Stop', async ($, e, next) => {
    transcriptPath = e.transcript_path
    const pike = await pikeOf($)
    if (pike) void report($, pike, ['--event=done'], {})
    return next(e)
  })

  // 実行中かどうか。サブエージェントは `turn.start` を出さないので、来るのは本線だけ。
  on('turn.start', async ($, e, next) => (await reportRunning($), next(e)))

  on('turn.complete', async ($, e, next) => {
    // サブエージェントの終わりは本線の終わりではない。
    if (e.agentId !== undefined) return next(e)
    const pike = await pikeOf($)
    awaitingPermission = false
    if (pike) void enqueue(() => reportIdle($, pike))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const pike = await pikeOf($)
    // 列の後ろに並べて待つ。先に送ると、まだ列にいるターンの終わりが後から届く。
    if (pike) await enqueue(() => report($, pike, ['--state=ended'], {}))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    // 枠が動いたときは早めに、そうでなければ間隔を空けて送る（「まだこの値」という鮮度のため）。
    const since = Date.now() - lastUsageAt
    const due = since >= (e.changed.includes('rateLimits') ? USAGE_CHANGED_MS : USAGE_INTERVAL_MS)
    if (due && transcriptPath && e.rateLimits.length > 0) {
      const pike = await pikeOf($)
      if (pike) {
        lastUsageAt = Date.now()
        void report($, pike, ['--usage'], { transcript_path: transcriptPath, rate_limits: e.rateLimits })
      }
    }
    return next(e)
  })
}
