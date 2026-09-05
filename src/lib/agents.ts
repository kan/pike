/**
 * Pike が知っているコーディングエージェントの表（#275 / #267）。
 *
 * **ここが正本。** 起動ボタン・使用量・入力待ちの通知は、どれも「Pike が知っている
 * エージェント」という同じ一覧を要る。別々に持つと、対応を増やすたびに 3 つの一覧を
 * 揃えることになる（`lib/shortcuts.ts` の `APP_ACTIONS` と同じ「表が正本」の形）。
 *
 * **今のところ Rust 側に写しは無い。** `agent_detect` が受け取るのは「この名前のコマンドが
 * あるか」だけ。ただし**この継ぎ目は起動までしか運べない**: 使用量（#263）はログの置き場と
 * 行の形式、フック駆動の通知（#265 / #299）は設定ディレクトリとフックの書式を Rust 側で
 * 知る必要があり、どちらも bin 名では表せない。そこまで来たら継ぎ目を `AgentId` に上げて、
 * Rust に id の enum を置く（bin はそこにぶら下げる）。**先回りで作らない**のは、実装を
 * 伴わない構造は次のステップで必ず形が変わるため。
 *
 * **エージェントを足すときはここに 1 行足す。** `bin` が PATH にあるかで出し入れが
 * 決まり、無いものはメニューに出ない（押しても `command not found` になる項目を
 * 並べない）。
 *
 * **チャットの欄は作らない。** エージェントはターミナルで動かす方針（#275）なので、
 * 新しいエージェントを足しても `agent-chat` タブは実装しない。
 */

/** 表にあるエージェントの id。使用量（#263）と入力待ち（#265）もこの id で引く。 */
export type AgentId = 'claude' | 'codex' | 'copilot' | 'opencode'

export interface AgentDef {
  id: AgentId
  /**
   * 表示名。**i18n に出さない**（固有名詞なので、`shellProfileLabel` と同じ扱い）。
   */
  label: string
  /**
   * PATH で探す名前。起動コマンドの先頭でもある。**シェルの行に埋まる**ので、
   * Rust 側の `is_safe_bin_name`（英数字と `-_.`）を満たすこと。
   */
  bin: string
  /**
   * 起動メニューに出す行。**先頭が素の起動**（ボタン本体が走らせるもの）、
   * **2 行目が「続きから」**。
   *
   * この並びは契約で、セッションの復元（`resumeCommandFor`）が 2 行目を使う。
   * 3 行目以降を足すのは自由。
   */
  launch: { label: string; command: string }[]
}

/**
 * **過去セッションの一覧（#220）はここに欄を持たない。** 真偽値のフラグを置くと拡張点に
 * 見えるが、実装は Claude 決め打ちで（一覧は `claudeSessionsList`、再開は
 * `claude --resume <id>`、見出しも Claude）、2 つ目に付けると**その名前の下に Claude の
 * セッションが出る**（型は通る）。読み手側は `agentById('claude')` を直に見ていて、
 * Claude 専用であることが型と読みの両方に出る。Codex / Copilot に広げるのは #267 の残りで、
 * 一覧の取得と再開コマンドの組み立てを id で分ける作業から。
 */

export const AGENTS: AgentDef[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    launch: [
      { label: 'Claude Code', command: 'claude' },
      { label: 'Claude Code (continue)', command: 'claude --continue' },
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    launch: [
      { label: 'Codex', command: 'codex' },
      { label: 'Codex (resume)', command: 'codex resume --last' },
    ],
  },
  {
    id: 'copilot',
    label: 'Copilot CLI',
    bin: 'copilot',
    launch: [
      { label: 'Copilot CLI', command: 'copilot' },
      { label: 'Copilot CLI (continue)', command: 'copilot --continue' },
    ],
  },
  {
    id: 'opencode',
    label: 'opencode',
    bin: 'opencode',
    launch: [
      { label: 'opencode', command: 'opencode' },
      { label: 'opencode (continue)', command: 'opencode --continue' },
    ],
  },
]

/**
 * 起動メニューに並べる 1 行（#275）。**シェルプロファイル（#129）と同じく**並べ替えと
 * 目のトグルを設定画面から行う。
 *
 * **表のエージェントと利用者が書いた行を 1 本のリストで持つ。** 以前は 2 本に分かれて
 * いて、どちらが優先かは呼ぶ側の `??` 1 個にあった。そのため `claude --model opus` を
 * ボタンにしていた利用者は、表が入った版で素の `claude` に戻り、**戻す手段が UI から
 * 消えていた**。
 *
 * **並び順がそのまま優先順で、使える先頭が既定。** ボタン本体が走らせるのも、メニューの
 * 第 1 階層に出るのもそれで、残りは「他のエージェント」の下へ入る。順序と既定を別々に持たない
 * のは、2 つの値が食い違う余地を作らないため。
 *
 * - `agent` … 表の行。**PATH に `bin` があるときだけ使える**（押しても `command not found`
 *   になる項目を並べない）。`launch` の行を全部連れてくる
 * - `custom` … 利用者が書いた 1 行。**検出を通さない**: `npx claude` や
 *   `docker compose exec -T dev claude` のように、bin 名では表せない起動が普通にある
 *
 * **`ShellProfile` と違って同期の対象**にする。あちらがマシンローカルなのは distro の
 * 集合がマシンごとに違うからで、こちらは id が固定（表が持つ 4 つ）＋利用者が書いた文字列。
 * どれを既定にしたいかは好みなので、`shortcutPreset` と同じ扱いでよい。別のマシンにその
 * エージェントが無ければ、使える先頭に落ちるだけ。
 */
export type AgentLauncher =
  | { kind: 'agent'; id: AgentId; hidden?: boolean }
  | { kind: 'custom'; label: string; command: string; hidden?: boolean }

/**
 * 昔の「エージェントの並び」（#275 の当初の形）。**移行の入力としてしか使わない**。
 * 同期ファイル越しに古い版の Pike が書くことがあるので、型ごと消せない。
 */
export interface AgentProfile {
  id: AgentId
  hidden?: boolean
}

/** その行が走らせる起動コマンド。エージェントは表の `launch` 全部、カスタムは自分 1 行。 */
export function launcherLines(l: AgentLauncher): { label: string; command: string }[] {
  if (l.kind === 'custom') return [{ label: l.label, command: l.command }]
  return agentById(l.id)?.launch ?? []
}

/** 設定画面の行と、メニューの見出しに出す名前。 */
export function launcherLabel(l: AgentLauncher): string {
  return l.kind === 'custom' ? l.label : (agentById(l.id)?.label ?? l.id)
}

/**
 * この環境で使える行か（`detectedBins` は `stores/agents.ts` が調べた PATH 上の名前）。
 *
 * **カスタム行は空でなければ使える。** 検出を通さないので、書いた本人の意図をそのまま
 * 信じる。空を弾くのは、設定で「行を追加」した直後のまだ何も打っていない行が既定に
 * なってしまうため。
 */
export function isLauncherUsable(l: AgentLauncher, detectedBins: Set<string>): boolean {
  if (l.kind === 'custom') return l.command.trim() !== ''
  const bin = agentById(l.id)?.bin
  return bin !== undefined && detectedBins.has(bin)
}

/**
 * メニューに出す行か。**「既定になりうるか」と同じ問い**で、順に見ていって最初に真になった
 * ものが既定になる。
 *
 * **`!hidden && usable` を呼び出し側で書かないこと。** 起動メニュー（`stores/agents.ts`）と
 * 設定画面の「デフォルト」バッジ（`SettingsTab.vue`）が別々に持つと、条件が 1 つ増えた
 * ときに片方だけ古くなり、**バッジの付いた行とボタンが走らせる行が食い違う**。この issue が
 * 直したのはまさにその形の食い違いだった。
 */
export function isLauncherVisible(l: AgentLauncher, detectedBins: Set<string>): boolean {
  return !l.hidden && isLauncherUsable(l, detectedBins)
}

export function agentById(id: AgentId): AgentDef | undefined {
  return AGENTS.find((a) => a.id === id)
}

/**
 * その起動コマンドの「続きから」版（`launch` の 2 行目）。無ければ `undefined`。
 *
 * **固定タブのセッション復元が使う**（`stores/project.ts`）。以前は `RESUME_MAP` という
 * 別の表が `claude` だけを知っていて、`codex` を固定タブにしていると復元で素の `codex` が
 * 走っていた。表が 2 つあると、エージェントを増やすたびに両方を揃えることになる。
 */
export function resumeCommandFor(command: string): string | undefined {
  return AGENTS.find((a) => a.launch[0]?.command === command)?.launch[1]?.command
}

/**
 * 設定の行がそのエージェントを起動しているように見えるか。
 *
 * **PATH の検出とは別の入口**で、wrapper 越しの起動（`npx claude`、
 * `docker compose exec -T dev claude`、別名のスクリプト）を拾うための緩い判定。
 * 検出だけを条件にすると、そういう使い方をしている利用者からセッション一覧が消える。
 */
export function commandMentionsAgent(command: string, agent: AgentDef): boolean {
  return new RegExp(`(^|[\\\\/\\s])${agent.bin}(\\s|$)`).test(command)
}
