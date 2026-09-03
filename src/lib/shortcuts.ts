/**
 * Pike の**アクションの表**（`APP_ACTIONS`、#270）と、それに**キーを割り当てる表**
 * （`keyBindings`、#254 / #261）。2 つに分けてあるのは、パレットに出したい操作のほとんどが
 * キーを持たないため（パネルを開く、git pull など）。
 *
 * - `APP_ACTIONS` … 「Pike にできること」の正本。`AppActionId` はここから導出し、
 *   実装（`useAppActions`）は `Record<AppActionId, …>` なので足し忘れが型エラーになる。
 *   パレット（`QuickOpen` の `>` モード）は `palette` を持つ行を流すだけ
 * - `keyBindings` … キーの正本（プリセットで切り替わる computed、#261）。読む側は 3 つある。
 *
 * - `useKeyboardShortcuts`（window の keydown）が `matchChord` で照合する
 * - `KeyboardShortcuts.vue` と各 UI のツールチップが `actionChord` / `chordsFor` で表記にする
 * - macOS のネイティブメニューのアクセラレータ（`menusRefresh` で Rust へ渡す）
 *
 * 以前はこの 3 つに同じ割り当てがリテラルで書かれていて、型検査も効かなかった。
 * 導入直後に既に 1 件ずれていた（`Mod+Shift+]` を実装は全 OS で受けるのに、
 * 一覧は mac のときだけ出していた）。
 *
 * **`composables/` ではなく `lib/` に置く。** ここはデータと純粋な導出だけで、
 * ストアを触らない。`stores/project.ts` が `menuActions()` を呼ぶので、
 * ストアを import すると循環参照になる。動作の実体は `useAppActions` 側。
 */

import { computed, ref } from 'vue'
import { t } from '../i18n'
import en from '../i18n/en'
import type { MenuAction, SidebarPanel } from '../types/tab'
import { isMacHost } from './host'
import { chordLabel, matchParsedChord, parseChord, toAccelerator } from './keys'

/**
 * パレットでの分類と、その表示名（#270）。VSCode の `View:` `Git:` と同じで、**名前だけでは
 * どの領域の操作か分からないもの**に接頭辞を付けるためにある。
 *
 * 分類の一覧はこの表が正本（`PaletteCategory` を導出する）。別に union を書くと、
 * 分類を足したとき i18n を忘れても気付けない。
 */
const PALETTE_CATEGORY_KEYS = {
  view: 'palette.view',
  git: 'palette.git',
  project: 'palette.project',
  terminal: 'palette.terminal',
  file: 'palette.file',
  help: 'palette.help',
} as const satisfies Record<string, keyof typeof en>

export type PaletteCategory = keyof typeof PALETTE_CATEGORY_KEYS

/**
 * アクション 1 つの定義（#270）。**キーとは別の表**にしてある: パレットに出したい操作の
 * ほとんどはキーを持たない（パネルを開く、git pull など）ので、chord を行にした
 * `keyBindings` では表現できない。
 */
export interface AppActionDef {
  id: string
  /**
   * パレット（`Ctrl+P` の `>` モード）に出す分類。**省略＝出さない**。
   * タブ移動のようにパレットを開いている時点で意味を失うものは付けない。
   */
  palette?: PaletteCategory
  /**
   * 表示名の i18n キー。既定は `shortcuts.{id}`。**辞書のキーに縛ってある**: ただの
   * `string` だと打ち間違いがそのまま通り、`t()` はキー文字列を返すので、パレットに
   * 生キーが出るまで気付けない。
   */
  labelKey?: keyof typeof en
  /** プロジェクトが要る（グローバルモードのウィンドウでは出さない）。 */
  needsProject?: true
  /**
   * このアクションが開くサイドバーパネル。**使えるかの判定に使う**
   * （`composables/usePanelAvailability.ts`。ここでストアを読むと循環するので、
   * この表は「どのパネルか」を言うだけにして、可否は読む側が聞く）。
   */
  panel?: SidebarPanel
}

/**
 * アクションの一覧。**ここが「Pike にできること」の正本**（#270）。
 *
 * 機能を足すときはここに 1 行足す。実装（`useAppActions`）は `Record<AppActionId, …>`
 * なので、足して実装を忘れると型エラーになる。パレットに出すかは `palette` の有無だけで
 * 決まり、一覧を別に持たない（以前は `QuickOpen.vue` に 3 件だけハードコードされていて、
 * 機能を足しても誰も気付かなかった）。
 */
export const APP_ACTIONS = [
  { id: 'quickOpen' },
  { id: 'projectSwitcher', palette: 'project' },
  { id: 'openDirectory', palette: 'project' },
  { id: 'newTerminal', palette: 'terminal' },
  { id: 'fontIncrease', palette: 'view' },
  { id: 'fontDecrease', palette: 'view' },
  { id: 'fontReset', palette: 'view' },
  { id: 'newFile', palette: 'file' },
  { id: 'closeTab', palette: 'file' },
  { id: 'closeWindow', palette: 'view' },
  { id: 'settings', palette: 'view' },
  { id: 'nextTab' },
  { id: 'prevTab' },
  { id: 'manual', palette: 'help' },
  { id: 'shortcuts', palette: 'help', labelKey: 'shortcuts.keyboardShortcuts' },
  { id: 'gitHistory' },
  { id: 'quit', labelKey: 'menu.quit' },
  // --- パネル（#270）。パレットから開ける。キーを持つのは検索だけ（`Mod+Shift+F`、#259）
  { id: 'panelFiles', palette: 'view', labelKey: 'sidebar.files', panel: 'files' },
  { id: 'panelGit', palette: 'view', labelKey: 'sidebar.git', panel: 'git' },
  { id: 'panelSearch', palette: 'view', labelKey: 'sidebar.search', panel: 'search' },
  { id: 'panelDocker', palette: 'view', labelKey: 'sidebar.docker', panel: 'docker' },
  { id: 'panelTasks', palette: 'view', labelKey: 'sidebar.tasks', panel: 'tasks' },
  { id: 'panelOutline', palette: 'view', labelKey: 'sidebar.outline', panel: 'outline' },
  { id: 'panelDiagnostics', palette: 'view', labelKey: 'sidebar.diagnostics', panel: 'diagnostics' },
  { id: 'panelIssues', palette: 'view', labelKey: 'sidebar.issues', panel: 'issues' },
  { id: 'panelProjects', palette: 'view', labelKey: 'sidebar.projects', panel: 'projects' },
  // --- Git
  { id: 'gitPull', palette: 'git', labelKey: 'git.pull', needsProject: true },
  { id: 'gitPush', palette: 'git', labelKey: 'git.push', needsProject: true },
  { id: 'gitRefresh', palette: 'git', labelKey: 'common.refresh', needsProject: true },
  // --- その他
  { id: 'diagnosticsRun', palette: 'view', labelKey: 'diagnostics.run', needsProject: true },
] as const satisfies readonly AppActionDef[]

export type AppActionId = (typeof APP_ACTIONS)[number]['id']

/** パレットに出すアクション（並びは表のまま）。 */
/**
 * パレットに出す行（並びは表のまま）。**表示に要るものは全部ここで作る**: 呼び出し側が
 * id から引き直すと、同じ表を 3 回走査したうえに公開 API が増える。
 */
export function paletteActions(): {
  id: AppActionId
  /** 分類の表示名（バッジ）。 */
  category: string
  label: string
  /** キー（無ければ空文字）。 */
  chord: string
  /** プロジェクトが要る（グローバルモードでは出さない）。 */
  needsProject: boolean
  /** 開くサイドバーパネル（使えるかは `usePanelAvailability` に聞く）。 */
  panel?: SidebarPanel
  /** 絞り込みに使う文字列。表示名と分類の**日本語と英語の両方**を含む。 */
  search: string
}[] {
  return APP_ACTIONS.flatMap((a) => {
    if (!('palette' in a)) return []
    const key = labelKeyOf(a)
    const categoryKey = PALETTE_CATEGORY_KEYS[a.palette]
    return [
      {
        id: a.id,
        category: t(categoryKey),
        label: t(key),
        chord: actionChord(a.id),
        needsProject: 'needsProject' in a,
        panel: 'panel' in a ? a.panel : undefined,
        // **UI 言語に関わらず英語でも引けるようにする**（#270）。コマンドが増えたぶん、
        // `git pull` や `settings` と打って絞れるほうが速い（日本語表示のまま英語で
        // 打つのは、キーボードが英字のときの自然な打ち方でもある）。
        search: [t(key), t(categoryKey), en[key as keyof typeof en], en[categoryKey], a.id]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
      },
    ]
  })
}

function labelKeyOf(def: (typeof APP_ACTIONS)[number]): string {
  return 'labelKey' in def ? def.labelKey : `shortcuts.${def.id}`
}

/**
 * 表の 1 行。**順番に意味がある**（上から照合して最初に一致したものを実行する）。
 */
export interface KeyBinding {
  chords: string[]
  /** 省略＝ブラウザの既定を潰すだけ（実処理は CodeMirror などの別の層が持つ）。 */
  action?: AppActionId
  /** スイッチャー / QuickOpen が開いていても処理する。 */
  always?: true
  /**
   * macOS でこの行が使う chord（#280）。**OS 差はこの 1 つだけで表す。**
   *
   * `Mod`（mac は Cmd、他は Ctrl）は VSCode のように「Ctrl ↔ Cmd の機械的な読み替え」で
   * 出来ているキーマップにしか通用しない。IntelliJ IDEA は Windows / Linux 用と macOS 用に
   * 別のキーマップを配っていて、Go to File が `Ctrl+Shift+N` と `⇧⌘O` のように**キーそのものが
   * 違う**。VSCode 側にも 1 件あり、`nextEditor` は mac だけ `⌘⇧]` を持つ。
   *
   * 空の `chords` と組にすれば「mac だけの割り当て」も書ける（`⌘Q`。Windows / Linux に
   * `Ctrl+Q` を生やす気は無い ―― 押し間違いでアプリごと終了する）。以前はこれを `macOnly`
   * という別のフラグでやっていたが、見ていたのが `useKeyboardShortcuts` だけで、
   * `chordsFor` / `terminalClaims` / `primaryChord` は素通しに読んでいた。**OS の解決は
   * `keyBindings` を組むところで 1 回だけ終わらせる。**
   */
  macChords?: string[]
  /**
   * ターミナルにフォーカスがあっても Pike が先に取る（#224）。
   *
   * 既定はシェル優先で、xterm は PTY へ送るキーで `stopPropagation` まで呼ぶため、
   * 印を付けない限りこの表の chord は**ターミナル上では一度も発火しない**。付けるのは
   * タブの出し入れと文字の大きさだけ。**プリセットごとに chord が変わっても、印は行に
   * 付いているので自動で追従する**（#261。IDEA では `Ctrl+W` がシェルへ戻り、代わりに
   * `Ctrl+F4` と `Alt+←→` を Pike が取る）。
   */
  terminalFirst?: true
  /**
   * `terminalFirst` のうち、全画面 TUI が代替画面を持っているあいだはシェルへ返すもの。
   * `Ctrl+W` は vim のウィンドウ操作の prefix で、奪うと `Ctrl+W s` が打てないうえタブが
   * 閉じる。素のシェル（readline の unix-werase）では Pike 優先のままにするため、判定は
   * キー単位ではなく代替画面の有無で行う。
   */
  altScreenShell?: true
}

/**
 * キーボードショートカットのプリセット（#261）。
 *
 * 任意の再割り当ては、4 つの層（グローバル / CodeMirror / xterm / モーダル）すべてで
 * キーを奪い合う調停を書くことになるので採らない。**こちらで書き切れる組を選ばせる**形に
 * してある。既定の `vscode` は元からある割り当てそのもので、名前を付けただけ。
 */
export const SHORTCUT_PRESETS = ['vscode', 'idea'] as const
export type ShortcutPreset = (typeof SHORTCUT_PRESETS)[number]

/**
 * いま有効なプリセット。**ストアを import しないための ref**（このファイルは
 * `stores/project.ts` から import されるので、逆向きの import は循環になる）。
 * 設定ストアが自分の値を `setShortcutPreset` で流し込む。
 */
const preset = ref<ShortcutPreset>('vscode')

export function setShortcutPreset(next: ShortcutPreset) {
  preset.value = next
}

/**
 * 既定（VSCode 互換）の割り当て。**キーの正本**で、IDEA 互換はこの表への差分として作る。
 */
const VSCODE_BINDINGS: KeyBinding[] = [
  { chords: ['F1'], action: 'manual', always: true },
  { chords: ['Mod+Shift+P'], action: 'projectSwitcher', always: true },
  { chords: ['Mod+P'], action: 'quickOpen', always: true },
  // 実処理は別の層。エディタは CodeMirror、diff タブは自前の window リスナ。
  { chords: ['Mod+S', 'Mod+F', 'Mod+H'] },
  { chords: ['Mod+W'], action: 'closeTab', terminalFirst: true, altScreenShell: true },
  // `altScreenShell` は `Ctrl+W` と同じ理由で付ける。ターミナルは `Ctrl+Shift+W` にも
  // `Ctrl+W` と同じバイト（0x17）を送るので、vim から見ればどちらもウィンドウ操作の prefix。
  { chords: ['Mod+Shift+W'], action: 'closeWindow', terminalFirst: true, altScreenShell: true },
  { chords: ['Mod+N'], action: 'newFile' },
  // `Mod+O` は「開く」の慣習そのまま（mac の ⌘O、Windows の Ctrl+O）。ターミナルへは
  // 返す（readline の operate-and-get-next。`terminalFirst` を付けない）。
  { chords: ['Mod+O'], action: 'openDirectory' },
  // VSCode の新規ターミナルは全 OS で `Ctrl+Shift+\``。**配列で `e.key` が変わる**ので 2 つ
  // 並べる（US は Shift+` が `~`、JIS は `@` の Shift で `` ` `` が出る）。`Mod+T` も残す:
  // Pike はターミナルが主機能で、JIS 配列では `Ctrl+Shift+\`` が明確に打ちにくい。VSCode の
  // `Ctrl+T`（Go to Symbol in Workspace）に当たる機能は Pike に無いので取り合いにならない。
  { chords: ['Mod+T', 'Ctrl+Shift+`', 'Ctrl+Shift+~'], action: 'newTerminal', terminalFirst: true },
  // `Ctrl+Tab` 系は macOS でも Ctrl のまま（`⌘Tab` は OS のアプリ切り替え）。
  // **`⌘⇧]` は mac だけ**（#280）。VSCode の `nextEditor` は mac が `⌘⇧]`、Windows / Linux は
  // `Ctrl+PageDown` で、あちらに `Ctrl+Shift+]` という割り当ては無い。
  {
    chords: ['Ctrl+Tab', 'Ctrl+PageDown'],
    macChords: ['Mod+Shift+]', 'Ctrl+Tab', 'Ctrl+PageDown'],
    action: 'nextTab',
    terminalFirst: true,
  },
  {
    chords: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'],
    macChords: ['Mod+Shift+[', 'Ctrl+Shift+Tab', 'Ctrl+PageUp'],
    action: 'prevTab',
    terminalFirst: true,
  },
  // 全体検索（#259）。VSCode の「Search across files」と同じキーで、IDEA の
  // 「Find in Path」とも一致するのでプリセットで変わらない。
  { chords: ['Mod+Shift+F'], action: 'panelSearch' },
  { chords: ['Mod+K'], action: 'shortcuts' },
  { chords: ['Mod+,'], action: 'settings' },
  // 文字の大きさ（#260）。`Mod+0` は `Mod+1`〜`9`（タブ）と衝突しない。
  //
  // **大きくする側は配列で打ち方が変わる**ので 3 つ並べる。`matchChord` は chord に
  // 書いていない修飾キーが押されていないことを求めるため、`Mod++` だけでは
  // **Shift を押さずに `+` が出る numpad にしか一致しない**。US 配列の `Ctrl+Shift+=`、
  // JIS 配列の `Ctrl+Shift+;` はどちらも「Shift 付きで `+` が出た」なので
  // `Mod+Shift++` が受ける。`Mod+=` は US で Shift 無しに届く刻印。
  { chords: ['Mod+=', 'Mod++', 'Mod+Shift++'], action: 'fontIncrease', terminalFirst: true },
  { chords: ['Mod+-'], action: 'fontDecrease', terminalFirst: true },
  { chords: ['Mod+0'], action: 'fontReset', terminalFirst: true },
  { chords: ['Alt+H'], action: 'gitHistory' },
  // mac だけの `⌘Q`。Windows / Linux では割り当てを持たない（`chords` が空）。
  { chords: [], macChords: ['Mod+Q'], action: 'quit' },
]

/**
 * IDEA 互換で置き換える行（#261 / #280）。**差分だけを書く**: 表を丸ごと複製すると、片方に
 * だけ行を足したときに黙ってずれる。
 *
 * **OS 差は行の中の `macChords` で持つ（#280）。** IDEA は Windows / Linux 用と macOS 用に
 * 別のキーマップを配っていて、その関係は単純な Ctrl → Cmd の読み替えではない。以前は
 * Windows のキーマップだけを見て書いてあったため、mac では 5 件が実際の IDEA と食い違って
 * いた（Go to File・Settings・Close Tab・タブ移動の前後）。**表を OS ごとに 2 つ持つ形は
 * 採らない**: 行を片方にだけ足す事故が起き、しかも症状は mac でしか出ない（CI の macOS
 * ジョブは Rust の cfg を見るためのもので、ここは走らない）。行ごとに両 OS が並んでいれば、
 * 見落としは目で分かる。
 *
 * 入れていないものにも理由がある。`projectSwitcher` と `openDirectory` は IDEA に相当する
 * 既定キーが無く、`newFile` の `Ctrl+N` は IDEA では「Go to Class」だが Pike にクラス検索が
 * 無いので取り合いにならない。
 */
const IDEA_OVERRIDES: Partial<Record<AppActionId, Partial<KeyBinding>>> = {
  // Go to File。`Ctrl+Shift+N` と `⇧⌘O` で、キーそのものが違う。
  quickOpen: { chords: ['Mod+Shift+N'], macChords: ['Mod+Shift+O'] },
  // Settings / Preferences。mac は `⌘,` で、VSCode 互換と同じ値になる。
  settings: { chords: ['Mod+Alt+S'], macChords: ['Mod+,'] },
  // Close Tab。Windows の `Ctrl+W` は IDEA では Extend Selection なのでシェルへ戻り、
  // 代わりに `Ctrl+F4` が閉じる。mac は `⌘W` で VSCode 互換と同じ値。どちらも vim の
  // prefix と衝突しないので `altScreenShell` は外す（mac はそもそも Cmd がターミナルへ
  // 送られないので、外さなくても取り合いは起きない）。
  closeTab: { chords: ['Mod+F4'], macChords: ['Mod+W'], altScreenShell: undefined },
  // Terminal tool window。両 OS とも `Alt+F12`（mac は ⌥F12）。
  newTerminal: { chords: ['Alt+F12'] },
  // Select Next / Previous Tab。Windows は `Alt+←→`、mac は `⇧⌘] / ⇧⌘[`（VSCode 互換と
  // 同じ値）。chord のキー名は `e.key` に合わせる（矢印は `ArrowRight`）。表示は
  // `chordChips` が記号へ読み替える。
  //
  // **Ctrl+Tab / Ctrl+PageUp・Down も残す**。Windows の `Alt+←→` は代替画面の中で矢印を
  // 使う TUI と重なるので、逃げ道を 1 つ残しておく。
  nextTab: {
    chords: ['Alt+ArrowRight', 'Ctrl+Tab', 'Ctrl+PageDown'],
    macChords: ['Mod+Shift+]', 'Ctrl+Tab', 'Ctrl+PageDown'],
  },
  prevTab: {
    chords: ['Alt+ArrowLeft', 'Ctrl+Shift+Tab', 'Ctrl+PageUp'],
    macChords: ['Mod+Shift+[', 'Ctrl+Shift+Tab', 'Ctrl+PageUp'],
  },
}

const IDEA_BINDINGS: KeyBinding[] = VSCODE_BINDINGS.map((b) => {
  const override = b.action ? IDEA_OVERRIDES[b.action] : undefined
  // `macChords` を先に落とすのは、置き換える行の mac 側も override が決めるため。持ち越すと
  // VSCode 側の mac 専用 chord（`⌘⇧]` など）が IDEA の割り当てに紛れ込む。
  return override ? { ...b, macChords: undefined, ...override } : b
})

/**
 * プリセットとホストを決めて、解決済みの割り当てを返す。
 *
 * **OS を知るのはこの関数だけ**（#280）。照合・一覧の表記・macOS のメニュー・ターミナルとの
 * 取り合いは、すべて解決後の `chords` を見る。以前は `macOnly` フラグを
 * `useKeyboardShortcuts` だけが見ていて、ほかの読み手には Windows でも `⌘Q` が見えていた。
 *
 * **`mac` を引数で受けるのは、マニュアルとの照合（`scripts/check-shortcuts.ts`）が 4 通り
 * すべてを必要とするため。** アプリの中から呼ぶときは下の `keyBindings` を使う。
 */
export function bindingsFor(target: ShortcutPreset, mac: boolean): KeyBinding[] {
  const table = target === 'idea' ? IDEA_BINDINGS : VSCODE_BINDINGS
  if (!mac) return table
  return table.map((b) => (b.macChords ? { ...b, chords: b.macChords } : b))
}

/** いま有効な割り当て。読む側はここを通す（定数の表を直接読まない）。 */
export const keyBindings = computed<KeyBinding[]>(() => bindingsFor(preset.value, isMacHost))

/**
 * CodeMirror 層のうち、プリセットで変わるキー（#261）。
 *
 * 置換は CodeMirror のコマンドなので `AppActionId` を持たないが、**キーの出典は 1 つに
 * したい**（実装は `lib/editorSearch.ts`、表示は `KeyboardShortcuts.vue`、それぞれが
 * 別のリテラルを持っていた）。macOS の `⌘H` は Hide Application で CodeMirror に届かない
 * ため、VSCode 互換のときだけ mac で `⌥⌘F` に読み替える（IDEA の `⌘R` は mac でも通る）。
 */
export function editorChordsFor(target: ShortcutPreset, mac: boolean) {
  return { replace: target === 'idea' ? 'Mod+R' : mac ? 'Mod+Alt+F' : 'Mod+H' }
}

export const editorChords = computed(() => editorChordsFor(preset.value, isMacHost))

/** `Mod+1`〜`Mod+9`（n 番目のタブへ）。表に載せない決まりなので、ここで作る。 */
const DIGIT_CHORDS = [...'123456789'].map((d) => `Mod+${d}`)

/**
 * ターミナルにフォーカスがあるとき Pike が取る chord（#224 / #261）。
 *
 * **macOS では `Ctrl` を明示している chord だけ**にする。あちらの Ctrl と Option は
 * readline のもので（`Ctrl+W` は unix-werase、`Option+←→` は単語移動）、Pike の
 * ショートカットは Cmd 側にあるため取り合いが起きない。返さないのはタブ切替の 3 つだけで、
 * xterm がこれらを PTY へ送って `stopPropagation` するため、返すとターミナルに
 * フォーカスがあるあいだタブを切り替える手段が 1 つも無くなる。
 */
const terminalClaims = computed(() => {
  const chords = keyBindings.value.filter((b) => b.terminalFirst).flatMap((b) => b.chords)
  const all = isMacHost ? chords.filter((c) => c.split('+').includes('Ctrl')) : [...chords, ...DIGIT_CHORDS]
  // **分解は候補が変わったときだけ。** 判定は Ctrl / Alt 付きの打鍵ごとに候補を全部試すので、
  // そのたびに chord の文字列を割ると、どれにも一致しないキー（`Ctrl+C` などシェルのもの）が
  // いちばん高くつく。
  return all.map(parseChord)
})

/** そのうち、代替画面のあいだはシェルへ返すもの。 */
const altScreenShellClaims = computed<ReadonlySet<string>>(() => {
  if (isMacHost) return new Set()
  return new Set([...keyBindings.value.filter((b) => b.altScreenShell).flatMap((b) => b.chords), ...DIGIT_CHORDS])
})

/**
 * そのキーを Pike が取るか（`false` ならシェルへ渡す）。ターミナルはこれを聞くだけにして、
 * 判定そのものは割り当ての表と同じ場所に置く。
 */
export function pikeTakesTerminalKey(e: KeyboardEvent, inAltScreen: boolean): boolean {
  const hit = terminalClaims.value.find((c) => matchParsedChord(e, c))
  if (!hit) return false
  return !(inAltScreen && altScreenShellClaims.value.has(hit.chord))
}

/**
 * 修飾キーを持たない chord のキー名。素の打鍵で表を走査しないための門番に使う
 * （`F1` だけ。増えたら自動で拾う）。
 */
export const MODIFIERLESS_KEYS = computed<ReadonlySet<string>>(
  () => new Set(keyBindings.value.flatMap((b) => b.chords).filter((c) => !c.includes('+'))),
)

/**
 * そのアクションのキーを、このホストの表記で 1 つ返す（ツールチップ用）。
 *
 * **UI で `chordLabel('Mod+T')` と直書きしないこと。** 表で割り当てを変えても
 * ツールチップだけ古いキーを出し続け、型検査も鳴らない。CodeMirror 層のキー
 * （`Mod+Z` など、表に無いもの）は従来どおり `chordLabel` に直接渡す。
 */
export function actionChord(id: AppActionId): string {
  const chord = chordsFor(id)[0]
  return chord ? chordLabel(chord) : ''
}

/** そのアクションを起こす chord。表記に使う（先頭が代表）。 */
export function chordsFor(id: AppActionId): string[] {
  return keyBindings.value.filter((b) => b.action === id).flatMap((b) => b.chords)
}

/**
 * そのアクションの代表 chord。**`Mod` を含む最初のもの**を選ぶ。
 * `Ctrl+Tab` のような「macOS でも Ctrl のまま」の chord は、mac のメニューの
 * アクセラレータにはできない（あちらは `⌘` の並びに置くもの）。
 */
export function primaryChord(id: AppActionId): string | null {
  return chordsFor(id).find((c) => c.split('+').some((p) => p.toLowerCase() === 'mod')) ?? null
}

/**
 * macOS のメニューに載せるアクションと、その並び順（#254）。
 *
 * **載せないものがある**。`Mod+K`（ショートカット一覧）と `F1`（マニュアル）は
 * アクセラレータ抜きで載せる: メニューに付けると AppKit が WebView より先に取り、
 * Markdown エディタのリンク挿入（`Mod-k`）が mac だけ死ぬ。`gitHistory` と
 * `selectTabByDigit` は載せない（前者はエディタタブ限定、後者は Window メニューを
 * 9 項目太らせるだけ）。
 */
const MENU_ACTIONS: AppActionId[] = [
  'settings',
  'quit',
  'newTerminal',
  'newFile',
  'openDirectory',
  'closeTab',
  'closeWindow',
  'quickOpen',
  'projectSwitcher',
  'nextTab',
  'prevTab',
  'manual',
  'shortcuts',
]

/**
 * メニューにアクセラレータを付けないアクション。`Mod+K` はメニューに付けると AppKit が
 * WebView より先に取り、Markdown エディタのリンク挿入（`Mod-k`）が mac だけ死ぬ。
 * （`manual` の `F1` は `Mod` を含まないので `primaryChord` が null を返し、ここに要らない。）
 */
const NO_ACCELERATOR: ReadonlySet<AppActionId> = new Set(['shortcuts'])

/**
 * macOS のメニューに渡す項目（`types::MenuAction`）。ラベルは i18n、キーは
 * `keyBindings` から引くので、**Rust 側に写しを持たせない**。
 *
 * **並び順とサブメニューの割り当てはここでは決まらない**。それは AppKit の語彙なので
 * `src-tauri/src/appmenu/mod.rs` の `build_menu` が id を直に引いて決める。
 * 項目を増やすときは**両方**を直すこと（片方だけだと黙って何も出ない）。
 */
export function menuActions(): MenuAction[] {
  return MENU_ACTIONS.map((id) => {
    const chord = NO_ACCELERATOR.has(id) ? null : primaryChord(id)
    return { id, label: menuLabel(id), accelerator: chord ? toAccelerator(chord) : null }
  })
}

/**
 * メニューの項目名。**既定はショートカット一覧と同じ語**を使い、macOS のメニューの作法で
 * 違う語が要るものだけ `menu.*` を持つ（三点リーダは「押すと画面が出る」の合図）。
 * 一覧と別の語彙を丸ごと持つと、同じ操作がメニューと一覧で別の名前で呼ばれる。
 */
const MENU_LABEL_KEYS: Partial<Record<AppActionId, keyof typeof en>> = {
  settings: 'menu.settings',
  quickOpen: 'menu.quickOpen',
  projectSwitcher: 'menu.projectSwitcher',
}

/** メニュー用の上書きが無ければ、パレットや一覧と同じ名前を使う。 */
function menuLabel(id: AppActionId): string {
  const override = MENU_LABEL_KEYS[id]
  if (override) return t(override)
  const def = APP_ACTIONS.find((a) => a.id === id)
  return t(def ? labelKeyOf(def) : `shortcuts.${id}`)
}

/**
 * プロジェクトスイッチャー / QuickOpen が開いていても通すアクション（#254）。
 *
 * **表の `always` から導出する。** キーとメニューで別々の一覧を持っていたころ、
 * `F1`（マニュアル）が既に食い違っていた: キーでは開くのに、macOS の
 * ヘルプ ▸ ユーザーマニュアルからは無視されていた。
 */
export const OVERLAY_ALLOWED_ACTIONS = computed<ReadonlySet<AppActionId>>(
  () => new Set(keyBindings.value.filter((b) => b.always && b.action).map((b) => b.action as AppActionId)),
)
