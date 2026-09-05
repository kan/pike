/**
 * Pike が知っているコーディングエージェントの表（#275 / #267）。
 *
 * **ここが正本。** 起動ボタン・使用量・入力待ちの通知は、どれも「Pike が知っている
 * エージェント」という同じ一覧を要る。別々に持つと、対応を増やすたびに 3 つの一覧を
 * 揃えることになる（`lib/shortcuts.ts` の `APP_ACTIONS` と同じ「表が正本」の形）。
 *
 * **Rust との継ぎ目は `AgentId`。** 検出（`agent_detect`）だけは「この名前のコマンドが
 * あるか」で足りるが、使用量（#263）はログの置き場と行の形式、セッション一覧（#267）は
 * 記録の置き場と対話セッションの選び方を Rust 側で知る必要があり、どちらも bin 名では
 * 表せない。そこで `agent_usage::AgentId` の `match` が 2 つ（使用量とセッション一覧）
 * この id で振り分ける。**表に 1 行足すときは Rust の腕も足す**（`match` の網羅性が
 * 気付かせる）。**起動コマンドと再開コマンドはこちらが正本**で、Rust は文字列を組まない。
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
  /**
   * 過去のセッションを id 指定で再開する行（#267）。
   *
   * **4 つとも書き方が違う**（`claude --resume <id>` / `codex resume <id>` /
   * `copilot --resume <id>` / `opencode --session <id>`）ので、表が持つのは組み立て方
   * そのもの。テンプレート文字列にしないのは、置換の規則をもう 1 つ発明することになるため。
   *
   * **一覧の取得は Rust の `agent_sessions`。** 出所は 4 つとも違う（あちらの doc が正本）。
   * ここに「一覧を出せるか」の真偽値は置かない —— 出せなければ一覧が空になるだけで、
   * メニュー側は同じ扱いでよい。
   */
  resume: (sessionId: string) => string
}

export const AGENTS: AgentDef[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    launch: [
      { label: 'Claude Code', command: 'claude' },
      { label: 'Claude Code (continue)', command: 'claude --continue' },
    ],
    resume: (id) => `claude --resume ${id}`,
  },
  {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    launch: [
      { label: 'Codex', command: 'codex' },
      { label: 'Codex (resume)', command: 'codex resume --last' },
    ],
    resume: (id) => `codex resume ${id}`,
  },
  {
    id: 'copilot',
    label: 'Copilot CLI',
    bin: 'copilot',
    launch: [
      { label: 'Copilot CLI', command: 'copilot' },
      { label: 'Copilot CLI (continue)', command: 'copilot --continue' },
    ],
    resume: (id) => `copilot --resume ${id}`,
  },
  {
    id: 'opencode',
    label: 'opencode',
    bin: 'opencode',
    launch: [
      { label: 'opencode', command: 'opencode' },
      { label: 'opencode (continue)', command: 'opencode --continue' },
    ],
    resume: (id) => `opencode --session ${id}`,
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
  return mentionPattern(agent).test(command)
}

/**
 * `bin` ごとの正規表現。**呼ぶたびにコンパイルしない**（メニューは行ごと・セッション行ごとに
 * この判定を通るので、ホバー中の再描画のたびに数十回コンパイルすることになる）。表の値は
 * 固定なので、種類は `AGENTS` の数しかない。
 */
const MENTION_PATTERNS = new Map<string, RegExp>()

function mentionPattern(agent: AgentDef): RegExp {
  const cached = MENTION_PATTERNS.get(agent.bin)
  if (cached) return cached
  const re = new RegExp(`(^|[\\\\/\\s])${agent.bin}(\\s|$)`)
  MENTION_PATTERNS.set(agent.bin, re)
  return re
}

/**
 * その起動行が動かすエージェント。表の行なら id そのもの、カスタム行なら字面を見る
 * （wrapper 越しに起動している利用者から再開一覧が消えないため）。
 *
 * **`launcher*` の仲間としてここに置く。** 「行 → 意味」を解く関数（`launcherLines` /
 * `launcherLabel` / `isLauncherUsable` / `isLauncherVisible`）が既にこのファイルに揃っている。
 */
export function launcherAgent(l: AgentLauncher | null): AgentDef | null {
  if (!l) return null
  if (l.kind === 'agent') return agentById(l.id) ?? null
  return AGENTS.find((a) => commandMentionsAgent(l.command, a)) ?? null
}
