// Pike が同梱する Claude Code の mod（#437）。Pike のターミナルで動く claude から、
// アカウントの申告・入力待ちの知らせ・レート制限を Pike へ渡す。
//
// **渡し方は `pike agent-hook` を起こすだけ**（`settings.json` に登録する hook と同じ受け口。
// 受け側の正本は `src-tauri/src/agent_hook.rs`）。この mod が持つのは「いつ、何を付けて
// 起こすか」だけで、申告の置き場も配送も Rust の側にある。
//
// **Pike のターミナルの外では何もしない**（`PIKE_PTY_ID` と `PIKE_HOOK_EXE` が無い）。
// 利用者がこのフォルダを別の場所から読み込ませても、起こす相手が居ない。
//
// **セッションを待たせない。** `pike` の起動は待たずに `next(e)` へ進む（失敗も握り潰す）。
// 例外は目印の環境変数を立てるところだけで、あれは同じイベントの settings hook より先に
// 立っていなければ意味が無い。
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

async function pikeOf($: EngineInterface): Promise<Pike | undefined> {
  const exe = await $.env.get('PIKE_HOOK_EXE')
  const pty = await $.env.get('PIKE_PTY_ID')
  if (!exe || !pty) return undefined
  return { exe, installKey: (await $.env.get('PIKE_INSTALL_KEY')) ?? '' }
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

export const register: Register = (on) => {
  on('classic.SessionStart', async ($, e, next) => {
    const pike = await pikeOf($)
    if (!pike) return next(e)
    // **この mod が動いている目印。** `settings.json` に登録済みの同じ hook は、これを見て
    // 何もせずに終わる（二重の通知を防ぐ）。`next(e)` がその hook を走らせるので、先に立てる。
    await $.env.set('PIKE_AGENT_MOD', '1')
    transcriptPath = e.transcript_path
    void report($, pike, [], { transcript_path: e.transcript_path, cwd: e.cwd })
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    const event = NOTICE_EVENTS[e.notification_type]
    const pike = event ? await pikeOf($) : undefined
    if (pike) void report($, pike, [`--event=${event}`], {})
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    transcriptPath = e.transcript_path
    const pike = await pikeOf($)
    if (pike) void report($, pike, ['--event=done'], {})
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
