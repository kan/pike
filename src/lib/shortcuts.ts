/**
 * Pike の**アクションの表**（`APP_ACTIONS`、#270）と、それに**キーを割り当てる表**
 * （`KEY_BINDINGS`、#254）。2 つに分けてあるのは、パレットに出したい操作のほとんどが
 * キーを持たないため（パネルを開く、git pull など）。
 *
 * - `APP_ACTIONS` … 「Pike にできること」の正本。`AppActionId` はここから導出し、
 *   実装（`useAppActions`）は `Record<AppActionId, …>` なので足し忘れが型エラーになる。
 *   パレット（`QuickOpen` の `>` モード）は `palette` を持つ行を流すだけ
 * - `KEY_BINDINGS` … キーの正本。読む側は 3 つある。
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

import { t } from '../i18n'
import en from '../i18n/en'
import type { MenuAction } from '../types/tab'
import { chordLabel, toAccelerator } from './keys'

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
 * `KEY_BINDINGS` では表現できない。
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
  { id: 'newTerminal', palette: 'terminal' },
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
  // --- パネル（#270）。キーは持たず、パレットからだけ開ける
  { id: 'panelFiles', palette: 'view', labelKey: 'sidebar.files' },
  { id: 'panelGit', palette: 'view', labelKey: 'sidebar.git' },
  { id: 'panelSearch', palette: 'view', labelKey: 'sidebar.search' },
  { id: 'panelDocker', palette: 'view', labelKey: 'sidebar.docker' },
  { id: 'panelTasks', palette: 'view', labelKey: 'sidebar.tasks' },
  { id: 'panelTodo', palette: 'view', labelKey: 'sidebar.todo' },
  { id: 'panelOutline', palette: 'view', labelKey: 'sidebar.outline' },
  { id: 'panelDiagnostics', palette: 'view', labelKey: 'sidebar.diagnostics' },
  { id: 'panelProjects', palette: 'view', labelKey: 'sidebar.projects' },
  // --- Git
  { id: 'gitPull', palette: 'git', labelKey: 'git.pull', needsProject: true },
  { id: 'gitPush', palette: 'git', labelKey: 'git.push', needsProject: true },
  { id: 'gitRefresh', palette: 'git', labelKey: 'common.refresh', needsProject: true },
  // --- その他
  { id: 'diagnosticsRun', palette: 'view', labelKey: 'diagnostics.run', needsProject: true },
  { id: 'agentClaude', palette: 'terminal', labelKey: 'palette.agentClaude' },
  { id: 'agentCodex', palette: 'terminal', labelKey: 'palette.agentCodex' },
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
   * macOS だけの割り当て。`⌘Q` は mac の作法で、Windows / Linux に `Ctrl+Q` を
   * 生やす気は無い（押し間違いでアプリごと終了する）。表に載せるのは、macOS の
   * メニューのアクセラレータをここから引くため。
   */
  macOnly?: true
}

export const KEY_BINDINGS: KeyBinding[] = [
  { chords: ['F1'], action: 'manual', always: true },
  { chords: ['Mod+Shift+P'], action: 'projectSwitcher', always: true },
  { chords: ['Mod+P'], action: 'quickOpen', always: true },
  // 実処理は別の層。エディタは CodeMirror、diff タブは自前の window リスナ。
  { chords: ['Mod+S', 'Mod+F', 'Mod+H'] },
  { chords: ['Mod+W'], action: 'closeTab' },
  { chords: ['Mod+Shift+W'], action: 'closeWindow' },
  { chords: ['Mod+N'], action: 'newFile' },
  { chords: ['Mod+T'], action: 'newTerminal' },
  // `Ctrl+Tab` 系は macOS でも Ctrl のまま（`⌘Tab` は OS のアプリ切り替え）。
  { chords: ['Mod+Shift+]', 'Ctrl+Tab', 'Ctrl+PageDown'], action: 'nextTab' },
  { chords: ['Mod+Shift+[', 'Ctrl+Shift+Tab', 'Ctrl+PageUp'], action: 'prevTab' },
  { chords: ['Mod+K'], action: 'shortcuts' },
  { chords: ['Mod+,'], action: 'settings' },
  { chords: ['Alt+H'], action: 'gitHistory' },
  { chords: ['Mod+Q'], action: 'quit', macOnly: true },
]

/**
 * 修飾キーを持たない chord のキー名。素の打鍵で表を走査しないための門番に使う
 * （`F1` だけ。増えたら自動で拾う）。
 */
export const MODIFIERLESS_KEYS: ReadonlySet<string> = new Set(
  KEY_BINDINGS.flatMap((b) => b.chords).filter((c) => !c.includes('+')),
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
  return KEY_BINDINGS.filter((b) => b.action === id).flatMap((b) => b.chords)
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
 * `KEY_BINDINGS` から引くので、**Rust 側に写しを持たせない**。
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
export const OVERLAY_ALLOWED_ACTIONS: ReadonlySet<AppActionId> = new Set(
  KEY_BINDINGS.filter((b) => b.always && b.action).map((b) => b.action as AppActionId),
)
