<script setup lang="ts">
import {
  Bot,
  ChevronDown,
  ChevronUp,
  Eye,
  Info,
  Loader,
  Monitor,
  Moon,
  Plus,
  Search,
  SquareTerminal,
  Sun,
  Trash2,
  X,
} from 'lucide-vue-next'
import { type Component, computed, ref, useTemplateRef, watch } from 'vue'
import { confirmDialog } from '../../composables/useConfirmDialog'
import { fsWatcher } from '../../composables/useFsWatcher'
import { provideSettingsSearch } from '../../composables/useSettingsSearch'
import { useUpdater } from '../../composables/useUpdater'
import { useI18n } from '../../i18n'
import { AGENTS, type AgentLauncher, isLauncherVisible, launcherLabel } from '../../lib/agents'
import { EDITOR_THEMES } from '../../lib/editorThemes'
import { buildFontFamily } from '../../lib/fontDetection'
import { isWindowsHost } from '../../lib/host'
import { SHELL_KIND_ICONS } from '../../lib/shellIcons'
import type { ShortcutPreset } from '../../lib/shortcuts'
import {
  type AgentHookStatus,
  type AgentHookTarget,
  agentHookForget,
  agentHookInstall,
  agentHookStatus,
  agentHookUninstall,
  detectWslDistros,
  pickFolder,
  pickSaveFile,
} from '../../lib/tauri'
import { useProjectStore } from '../../stores/project'
import {
  type AgentNotifyMode,
  AUTO_SAVE_DELAY_DEFAULT,
  AUTO_SAVE_DELAY_MAX,
  AUTO_SAVE_DELAY_MIN,
  AUTO_THEME,
  type AutoSave,
  COLOR_SCHEMES,
  clampSize,
  type DiffWordWrap,
  type RegisterDirectoryMode,
  type ThemeMode,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  useSettingsStore,
  WINDOW_OPACITY_MAX,
  WINDOW_OPACITY_MIN,
  type WindowBackdrop,
} from '../../stores/settings'
import { useTabStore } from '../../stores/tabs'
import { isWindowsShell, type ShellProfile, shellFromId, shellId, shellProfileLabel } from '../../types/tab'
import AllowedHostList from '../panels/AllowedHostList.vue'
import ProfileRow from '../panels/ProfileRow.vue'
import SettingGroup from '../settings/SettingGroup.vue'
import SettingItem from '../settings/SettingItem.vue'
import SettingSection from '../settings/SettingSection.vue'
import SettingToggle from '../settings/SettingToggle.vue'

// 他のタブと同じく `tab-id` を受ける（`TabPane` が全タブに渡している）。hook の一覧を
// 取り直す契機を「見えているとき」に絞るのに要る。
const props = defineProps<{ tabId: string }>()

const { t } = useI18n()
const settings = useSettingsStore()
const tabStore = useTabStore()

/** 待ち時間の入力を範囲に丸める。空欄や数字でない入力は既定値に戻す。 */
function clampAutoSaveDelay(raw: string): number {
  // 丸めは `clampSize`（`sanitize` が保存済みの値に使うもの）と同じものを通す。
  // `Number('')` は 0 なので、空欄は先に「数値でない」側へ寄せる。
  const n = raw.trim() === '' ? Number.NaN : Math.round(Number(raw))
  return clampSize(n, AUTO_SAVE_DELAY_MIN, AUTO_SAVE_DELAY_MAX, AUTO_SAVE_DELAY_DEFAULT)
}
const projectStore = useProjectStore()
settings.loadAvailableFonts()
settings.loadAvailableUiFonts()

/**
 * 選択肢の並び（`SettingToggle` に渡す）。**型を書いておくと、値の綴りを間違えた時点で
 * コンパイルエラーになる**（設定側の union と突き合わされる）。ラベルのキーは
 * `SettingToggle` が検索語としても登録するので、ここが唯一の出典。
 */
const ON_OFF: { value: boolean; labelKey: string }[] = [
  { value: true, labelKey: 'common.on' },
  { value: false, labelKey: 'common.off' },
]
const SHORTCUT_PRESET_OPTIONS: { value: ShortcutPreset; labelKey: string }[] = [
  { value: 'vscode', labelKey: 'settings.shortcutPresetVscode' },
  { value: 'idea', labelKey: 'settings.shortcutPresetIdea' },
]
const REGISTER_DIRECTORY_OPTIONS: { value: RegisterDirectoryMode; labelKey: string }[] = [
  { value: 'auto', labelKey: 'settings.registerDirectoryAuto' },
  { value: 'ask', labelKey: 'settings.registerDirectoryAsk' },
  { value: 'never', labelKey: 'settings.registerDirectoryNever' },
]
const THEME_MODE_OPTIONS: { value: ThemeMode; labelKey: string; icon: Component }[] = [
  { value: 'dark', labelKey: 'settings.darkMode', icon: Moon },
  { value: 'light', labelKey: 'settings.lightMode', icon: Sun },
  { value: 'system', labelKey: 'settings.systemMode', icon: Monitor },
]
// 背景透過（issue #162）: none / transparent / acrylic のセグメントトグル。
const BACKDROP_OPTIONS: { value: WindowBackdrop; labelKey: string }[] = [
  { value: 'none', labelKey: 'settings.backdropNone' },
  { value: 'transparent', labelKey: 'settings.backdropTransparent' },
  { value: 'acrylic', labelKey: 'settings.backdropAcrylic' },
]
const AGENT_NOTIFY_OPTIONS: { value: AgentNotifyMode; labelKey: string }[] = [
  { value: 'off', labelKey: 'common.off' },
  { value: 'waiting', labelKey: 'settings.agentNotifyWaiting' },
  { value: 'all', labelKey: 'settings.agentNotifyAll' },
]
const AUTO_SAVE_OPTIONS: { value: AutoSave; labelKey: string }[] = [
  { value: 'off', labelKey: 'common.off' },
  { value: 'onFocusChange', labelKey: 'settings.autoSaveOnFocusChange' },
  { value: 'afterDelay', labelKey: 'settings.autoSaveAfterDelay' },
]
const DIFF_WORD_WRAP_OPTIONS: { value: DiffWordWrap; labelKey: string }[] = [
  { value: 'auto', labelKey: 'common.auto' },
  { value: 'on', labelKey: 'common.on' },
  { value: 'off', labelKey: 'common.off' },
]

// Auto（モード追従）カードのプレビューは、いま darkMode で解決される既定テーマを映す。
const autoScheme = computed(
  () => COLOR_SCHEMES.find((s) => s.name === settings.autoColorSchemeName) ?? COLOR_SCHEMES[0],
)
const autoEditorTheme = computed(
  () => EDITOR_THEMES.find((t) => t.name === settings.autoEditorThemeName) ?? EDITOR_THEMES[0],
)

// --- Global-mode default shell ------------------------------------------
// Reconcile the shell profile list (#129) with fresh WSL detection results;
// the default-shell options below are driven by the profile list.
// Also drives the WSL distro select for the project base (#164).
const distros = ref<string[]>([])
detectWslDistros()
  .then((d) => {
    distros.value = d
    settings.syncShellProfiles(d)
  })
  .catch(() => {})

// --- Shell profiles (#129) -----------------------------------------------
const defaultShellId = computed(() => shellId(settings.globalShell))

/** 一覧の 1 つを上下に動かす。この画面に 4 つある「↑↓」が共有する。 */
function moveInList<T>(list: T[], index: number, dir: -1 | 1) {
  const to = index + dir
  if (to < 0 || to >= list.length) return
  const moved = list[index]
  list[index] = list[to]
  list[to] = moved
}

/**
 * The last visible shell of a category (WSL / Windows) cannot be hidden, so
 * each side always keeps at least one dropdown entry.
 */
function canHideShellProfile(p: ShellProfile): boolean {
  const windows = isWindowsShell(p.shell)
  return settings.shellProfiles.filter((q) => !q.hidden && isWindowsShell(q.shell) === windows).length > 1
}

function toggleShellProfileHidden(index: number) {
  const p = settings.shellProfiles[index]
  if (!p.hidden && !canHideShellProfile(p)) return
  p.hidden = !p.hidden
}

/** 設定画面が「入っている」とみなすエージェント（理由は `defaultLauncherIndex` の doc）。 */
const ALL_AGENT_BINS = new Set(AGENTS.map((a) => a.bin))

/**
 * 「デフォルト」バッジを付ける起動行（#275）。**隠していない先頭**。
 * **`i === 0` にしないこと**: 先頭を隠している設定では、実際に起動するものと
 * バッジが食い違う。
 *
 * **「表のエージェントは全部入っている」前提で決める。** 実際の検出（`stores/agents.ts` の
 * `launchers`）はシェルごとの答えで、設定画面はどのターミナルのものでもないので、混ぜると
 * 開いていたタブ次第でバッジが動く。入っていなければ実際の既定は次の行に落ちる —— その旨は
 * 説明文に書いてある。
 *
 * **述語そのものは起動メニューと共有する**（`isLauncherVisible`）。シェルに依らない条件
 * （コマンドが空のカスタム行）まで自前で書き直すと、「行を追加」した直後の空行を先頭に
 * 上げたときに、起動ボタンが走らせない行へバッジが付く。
 */
const defaultLauncherIndex = computed(() =>
  settings.agentLaunchers.findIndex((l) => isLauncherVisible(l, ALL_AGENT_BINS)),
)

/**
 * 最後の 1 つは隠せない（起動ボタンが出せなくなる）。
 *
 * **数えるのは `isLauncherVisible`**（`!hidden` ではない）。空のカスタム行はメニューに
 * 出ないので、`!hidden` で数えると「行を追加してから表の 4 行を全部隠す」で起動ボタンが
 * 消える。バッジ（`defaultLauncherIndex`）と同じ述語を見る。
 */
function canHideLauncher(index: number): boolean {
  return settings.agentLaunchers.filter((l, i) => isLauncherVisible(l, ALL_AGENT_BINS) || i === index).length > 1
}

function toggleLauncherHidden(index: number) {
  const l = settings.agentLaunchers[index]
  if (!l.hidden && !canHideLauncher(index)) return
  l.hidden = !l.hidden
}

/**
 * 1 行ぶんの束縛（#305 の `tabBind` と同じ形）。行の形が 2 つ（表のエージェント /
 * 利用者が書いたコマンド）あってスロットの中身だけが違うので、**束縛を書き写さない**。
 */
function launcherRowBind(l: AgentLauncher, i: number) {
  return {
    label: launcherLabel(l),
    isDefault: i === defaultLauncherIndex.value,
    hidden: l.hidden,
    canHide: canHideLauncher(i),
    first: i === 0,
    last: i === settings.agentLaunchers.length - 1,
    onMove: (dir: -1 | 1) => moveInList(settings.agentLaunchers, i, dir),
    onToggle: () => toggleLauncherHidden(i),
  }
}

// Options follow the profile list (order included) and exclude hidden shells.
// The current selection stays listed even when hidden or no longer detected,
// so the select never shows a value it doesn't contain.
const globalShellOptions = computed<{ value: string; label: string }[]>(() => {
  const currentId = defaultShellId.value
  const opts = settings.shellProfiles
    .filter((p) => !p.hidden || p.id === currentId)
    .map((p) => ({ value: p.id, label: shellProfileLabel(p.shell) }))
  if (!opts.some((o) => o.value === currentId)) {
    opts.unshift({ value: currentId, label: shellProfileLabel(settings.globalShell) })
  }
  return opts
})

const globalShellValue = computed(() => shellId(settings.globalShell))

function onGlobalShellChange(e: Event) {
  // 復元は shellFromId の 1 箇所に寄せる（`shellToType` は Windows シェルしか知らず、
  // macOS の `unix` を渡すと undefined になる）。読めない値は現状維持。
  const shell = shellFromId((e.target as HTMLSelectElement).value)
  if (shell) settings.globalShell = shell
}

// CSS font-family for the editor preview swatch (built from the editor font name).
const editorFontFamily = computed(() => buildFontFamily(settings.editorFontName))

const updater = useUpdater()

async function browseSyncFile() {
  const path = await pickSaveFile('pike-settings.json')
  if (path) settings.syncFilePath = path
}

// The buttons cover both halves of the file: the UI settings (last write wins)
// and the project list (#164, merged by id). Projects go second on export so
// they see a freshly written file, and first on import so a newly created
// project is in place before the settings apply.
async function exportAll() {
  await settings.exportToSyncFile()
  await projectStore.pushProjectsToSync().catch(() => {})
}

async function importAll() {
  const pulled = await projectStore.pullProjectsFromSync().catch(() => null)
  await settings.importFromSyncFile()
  if (pulled) {
    settings.syncMessage = t('settings.syncPullSummary', {
      entries: pulled.entries,
      created: pulled.created,
      skipped: pulled.hidden + pulled.unresolvable,
    })
  }
}

/** Un-hide, then pull: the project was deleted from disk when it was hidden, so
 *  it only reappears once the sync file's entry recreates it — which only works
 *  if it ever reached the file (it needs a base-relative path) and if this
 *  machine can resolve that path back. Say so when it doesn't. */
async function restoreProject(id: string) {
  settings.unhideProject(id)
  const pulled = await projectStore.pullProjectsFromSync().catch(() => null)
  if (projectStore.projects.some((p) => p.id === id)) {
    settings.syncStatus = 'loaded'
    settings.syncMessage = ''
    return
  }
  settings.syncStatus = 'error'
  settings.syncMessage = pulled && pulled.unresolvable > 0 ? t('settings.restoreNoBase') : t('settings.restoreNoEntry')
}

/**
 * ホスト側のプロジェクト base（#164）のキーとラベル。Windows ホストなら `windows`、
 * macOS / Linux なら `unix`。**この 1 つで欄・プレースホルダ・ピッカーの書き込み先が
 * 決まる**ので、同じ markup を `v-if` / `v-else` で 2 回書かずに済む。
 */
const hostBase = isWindowsHost
  ? { key: 'windows' as const, label: 'Windows', placeholder: 'C:\\Users\\me\\src' }
  : { key: 'unix' as const, label: t('settings.projectBaseLocal'), placeholder: '/Users/me/src' }

/** WSL の base だけは手入力: フォルダ選択が返すのは Windows のパスで、
 *  WSL の base は distro の native パスである必要がある。 */
async function browseProjectBase() {
  const folder = await pickFolder()
  if (folder) settings.projectBase[hostBase.key] = folder
}

function onFontSizeInput(e: Event) {
  const val = parseInt((e.target as HTMLInputElement).value, 10)
  if (val >= 8 && val <= 32) {
    settings.fontSize = val
  }
}

function onEditorFontSizeInput(e: Event) {
  const val = parseInt((e.target as HTMLInputElement).value, 10)
  if (val >= 8 && val <= 32) {
    settings.editorFontSize = val
  }
}

// The UI font size zooms the whole chrome, which shifts this settings pane as it
// changes. To keep dragging smooth, track a draft for the live label and only
// commit (re-zoom) when the user releases the slider.
const uiFontSizeDraft = ref(settings.uiFontSize)
watch(
  () => settings.uiFontSize,
  (v) => {
    uiFontSizeDraft.value = v
  },
)

function onUiFontSizeInput(e: Event) {
  const val = parseInt((e.target as HTMLInputElement).value, 10)
  if (val >= UI_FONT_SIZE_MIN && val <= UI_FONT_SIZE_MAX) {
    uiFontSizeDraft.value = val
  }
}

function onUiFontSizeCommit() {
  settings.uiFontSize = uiFontSizeDraft.value
}

/** 利用者が書く起動行を足す。**表のエージェントは足せない / 消せない**（隠すだけ）。 */
function addCustomLauncher() {
  settings.agentLaunchers.push({ kind: 'custom', label: '', command: '' })
}

function removeCustomLauncher(index: number) {
  settings.agentLaunchers.splice(index, 1)
}

function addAgentPrompt() {
  settings.agentPrompts.push({ label: '', text: '' })
}

function removeAgentPrompt(index: number) {
  settings.agentPrompts.splice(index, 1)
}

function moveAgentPrompt(index: number, dir: -1 | 1) {
  moveInList(settings.agentPrompts, index, dir)
}

// Claude Code の hook（#299）。**プロジェクトのシェルと root で解決する**ので、
// プロジェクトを持たないウィンドウでは何も出さない（どの設定ディレクトリの
// settings.json に書くかが決まらない）。
const hookStatus = ref<AgentHookStatus | null>(null)
const hookBusy = ref(false)
const hookError = ref<string | null>(null)

/** hook の 4 つの操作が共有する包み（走っているあいだボタンを止め、失敗を出す）。 */
async function runHook(call: () => Promise<AgentHookStatus>) {
  if (hookBusy.value) return
  hookBusy.value = true
  hookError.value = null
  try {
    hookStatus.value = await call()
  } catch (e) {
    hookError.value = String(e)
  } finally {
    hookBusy.value = false
  }
}

function loadHookStatus() {
  if (!projectStore.activeRoot) {
    hookStatus.value = null
    return
  }
  runHook(() => agentHookStatus(projectStore.shellForIO, projectStore.activeRoot, distros.value))
}

// **見えているあいだのプロジェクト切替で取り直す。** 設定タブは `projectId: null` の
// シングルトンで（#264）切り替えても生き続けるので、開いたまま切り替えると一覧も
// `active` も `declared` も前のプロジェクトのものになる。その状態で登録を押すと、Rust
// 側は新しいシェルと root で候補を作り直すので `unknown config dir` で落ちる。
//
// **可視性をキーに含めるのが要点**: 含めないと、一度開いたら以後セッション中ずっと、
// 見てもいない設定タブのために切替のたびに WSL ホームの UNC 走査が走る（`activeRoot` は
// worktree の切替でも動く）。
watch(
  () =>
    [
      tabStore.isTabVisible(props.tabId),
      projectStore.activeRoot,
      shellId(projectStore.shellForIO),
      // distro の検出は非同期なので、届いたら WSL のぶんを足して取り直す。
      distros.value.join(','),
    ].join('|'),
  () => {
    if (tabStore.isTabVisible(props.tabId)) loadHookStatus()
  },
  { immediate: true },
)

/**
 * hook を足す / 外す。**どちらも利用者の設定ファイルを書き換える**ので、対象の
 * ファイルとコマンド行を見せてから確認する。
 */
async function editHook(target: AgentHookTarget, remove: boolean) {
  if (hookBusy.value) return
  const key = remove ? 'settings.agentHookConfirmRemove' : 'settings.agentHookConfirm'
  const ok = await confirmDialog(t(key, { path: target.settingsPath, command: target.command }))
  if (!ok) return
  const write = remove ? agentHookUninstall : agentHookInstall
  runHook(() => write(projectStore.shellForIO, projectStore.activeRoot, distros.value, target))
}

/**
 * 受け取った申告を捨てる。**逃げ道として要る**: 申告は `.envrc` とシェルの環境変数より
 * 優先されるので、hook を入れていないアカウントへ起動ラッパーを切り替えると、古い申告が
 * そのプロジェクトを恒久的に古いアカウントへ縛る。
 */
function forgetHook() {
  runHook(() => agentHookForget(projectStore.shellForIO, projectStore.activeRoot, distros.value))
}

// --- 節の一覧と絞り込み（#314）-------------------------------------------
/**
 * 節の一覧。**左のナビと各節の props の両方がここを読む**（`SECTIONS.general` を
 * `v-bind` する）ので、見出しとマニュアルの飛び先を 2 箇所に書かずに済む。名前で引くので、
 * テンプレート側の綴り間違いは `vue-tsc` が拾う。並びは「よく触るものを上へ」。
 */
const SECTIONS = {
  general: { id: 'general', titleKey: 'settings.general', help: 'settings.md#全般' },
  appearance: { id: 'appearance', titleKey: 'settings.appearance', help: 'settings.md#外観' },
  terminal: { id: 'terminal', titleKey: 'settings.terminal', help: 'settings.md#ターミナル' },
  agent: { id: 'agent', titleKey: 'settings.agent', help: 'settings.md#エージェント' },
  editor: { id: 'editor', titleKey: 'settings.editor', help: 'settings.md#エディタ' },
  external: { id: 'external', titleKey: 'settings.external', help: 'settings.md#外部との通信' },
  sync: { id: 'sync', titleKey: 'settings.sync', help: 'settings.md#設定の同期' },
  about: { id: 'about', titleKey: 'settings.about', help: 'settings.md#バージョン情報' },
}
const sections = Object.values(SECTIONS)

const search = provideSettingsSearch()
const query = search.query
const hasResults = search.hasResults
const sectionVisible = search.sectionVisible

const activeSection = ref(sections[0].id)
const scroller = useTemplateRef<HTMLElement>('scroller')

// 絞り込むと下のほうの節が消えるので、そのままだと空白を見ることになる。
watch(query, () => {
  if (scroller.value) scroller.value.scrollTop = 0
})

function scrollToSection(id: string) {
  activeSection.value = id
  const el = document.getElementById(`settings-${id}`)
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function onSettingsScroll(e: Event) {
  // Use viewport rects (not offsetTop) so the active-section detection stays
  // correct when the content is scaled via the UI-font zoom.
  const container = e.target as HTMLElement
  const threshold = container.getBoundingClientRect().top + 40
  const shown = sections.filter((s) => sectionVisible(s.id))
  for (let i = shown.length - 1; i >= 0; i--) {
    // 絞り込みで消えた節は `v-show` で残るが、矩形が 0 になるので必ず先頭に見える。
    const el = document.getElementById(`settings-${shown[i].id}`)
    if (el && el.getBoundingClientRect().top <= threshold) {
      activeSection.value = shown[i].id
      return
    }
  }
  activeSection.value = shown[0]?.id ?? sections[0].id
}

const PREVIEW_LINES = [
  { prompt: '$ ', cmd: 'git status', promptColor: 'green' },
  { text: 'On branch main', color: 'foreground' },
  { text: 'Changes not staged for commit:', color: 'yellow' },
  { text: '  modified:   src/App.vue', color: 'red' },
  { text: '  modified:   src/main.ts', color: 'red' },
  { text: 'Untracked files:', color: 'yellow' },
  { text: '  src/new-file.ts', color: 'magenta' },
  { prompt: '$ ', cmd: 'echo "Hello, World!"', promptColor: 'green' },
  { text: 'Hello, World!', color: 'cyan' },
  { prompt: '$ ', cmd: '', promptColor: 'green', cursor: true },
]
</script>

<template>
  <div class="settings-tab" data-testid="settings-screen">
    <nav class="settings-nav ui-zoom">
      <button
        v-for="sec in sections"
        v-show="sectionVisible(sec.id)"
        :key="sec.id"
        class="nav-item"
        :class="{ active: activeSection === sec.id }"
        @click="scrollToSection(sec.id)"
      >{{ t(sec.titleKey) }}</button>
    </nav>
    <div ref="scroller" class="settings-scroll" @scroll="onSettingsScroll">
      <div class="settings-zoom ui-zoom">
      <div class="settings-head">
        <h2 class="settings-title">{{ t('settings.title') }}</h2>
        <div class="filter-row search-box">
          <Search :size="12" :stroke-width="2" class="filter-icon" />
          <input
            v-model="query"
            class="filter-input"
            type="search"
            spellcheck="false"
            :placeholder="t('settings.searchPlaceholder')"
            @keydown.escape.prevent="query = ''"
          />
          <button v-if="query" class="icon-btn" :title="t('common.clear')" @click="query = ''">
            <X :size="12" :stroke-width="2" />
          </button>
        </div>
      </div>

      <div v-if="fsWatcher.startError.value" class="inotify-banner">
        <Info :size="16" :stroke-width="1.5" />
        <div>
          <span>{{ t('settings.inotifyMissing') }}</span>
          <code>sudo apt install inotify-tools</code>
        </div>
      </div>

      <p v-if="!hasResults" class="setting-hint no-results">{{ t('settings.searchNoResults') }}</p>

      <!-- General -->
      <SettingSection v-bind="SECTIONS.general">
        <SettingItem label-key="settings.language">
          <select class="setting-select" :value="settings.language" @change="settings.language = ($event.target as HTMLSelectElement).value">
            <option value="en">English</option>
            <option value="ja">日本語</option>
          </select>
        </SettingItem>

        <!-- キーの割り当ては 4 つの層に分かれているので、任意の再割り当てではなく
             こちらで書き切れる組を選ばせる（#261）。 -->
        <SettingItem label-key="settings.shortcutPreset" hint-key="settings.shortcutPresetHint">
          <SettingToggle v-model="settings.shortcutPreset" :options="SHORTCUT_PRESET_OPTIONS" />
        </SettingItem>

        <!-- 未登録のディレクトリを開いたときの扱い（#286）。確認ダイアログの
             「今後は確認しない」もここを書き換える。 -->
        <SettingItem label-key="settings.registerDirectory" hint-key="settings.registerDirectoryHint">
          <SettingToggle v-model="settings.registerDirectory" :options="REGISTER_DIRECTORY_OPTIONS" />
        </SettingItem>

        <SettingItem label-key="settings.closeToTray" hint-key="settings.closeToTrayHint">
          <SettingToggle v-model="settings.closeToTray" :options="ON_OFF" />
        </SettingItem>
      </SettingSection>

      <!-- Appearance -->
      <SettingSection v-bind="SECTIONS.appearance">
        <SettingItem label-key="settings.mode">
          <SettingToggle v-model="settings.themeMode" :options="THEME_MODE_OPTIONS" />
        </SettingItem>

        <!-- Window background transparency (issue #162).
             Windows 限定: macOS はウィンドウを透過で生成できないので（lib.rs）、
             選ばせても下地が透けず UI が黒く潰れるだけになる。値の側も
             sanitizeBackdrop が 'none' に潰している。 -->
        <SettingItem v-if="isWindowsHost" label-key="settings.backdrop" hint-key="settings.backdropHint">
          <SettingToggle v-model="settings.windowBackdrop" :options="BACKDROP_OPTIONS" />
        </SettingItem>
        <SettingItem
          v-if="isWindowsHost && settings.windowBackdrop !== 'none'"
          label-key="settings.windowOpacity"
        >
          <div class="font-size-control">
            <input
              type="range"
              :min="WINDOW_OPACITY_MIN"
              :max="WINDOW_OPACITY_MAX"
              step="0.05"
              v-model.number="settings.windowOpacity"
              class="setting-range"
            />
            <span class="font-size-value">{{ Math.round(settings.windowOpacity * 100) }}%</span>
          </div>
        </SettingItem>

        <SettingItem label-key="settings.uiFont">
          <select class="setting-select" v-model="settings.uiFontFamily">
            <option value="">{{ t('settings.uiFontDefault') }}</option>
            <option v-for="font in settings.availableUiFonts" :key="font" :value="font">{{ font }}</option>
          </select>
        </SettingItem>
        <SettingItem label-key="settings.uiFontSize" hint-key="settings.uiFontHint">
          <div class="font-size-control">
            <input
              type="range"
              :min="UI_FONT_SIZE_MIN"
              :max="UI_FONT_SIZE_MAX"
              :value="uiFontSizeDraft"
              @input="onUiFontSizeInput"
              @change="onUiFontSizeCommit"
              class="setting-range"
            />
            <span class="font-size-value" :style="{ fontSize: uiFontSizeDraft + 'px' }">{{ uiFontSizeDraft }}px</span>
          </div>
        </SettingItem>
      </SettingSection>

      <!-- Terminal -->
      <SettingSection v-bind="SECTIONS.terminal">
        <SettingGroup title-key="settings.groupDisplay">
          <SettingItem label-key="settings.font">
            <select
              class="setting-select"
              :value="settings.fontName"
              @change="settings.setFontByName(($event.target as HTMLSelectElement).value)"
            >
              <option
                v-for="font in settings.availableFonts"
                :key="font"
                :value="font"
              >{{ font }}</option>
            </select>
          </SettingItem>

          <SettingItem label-key="settings.fontSize">
            <div class="font-size-control">
              <input
                type="range"
                min="8"
                max="32"
                :value="settings.fontSize"
                @input="onFontSizeInput"
                class="setting-range"
              />
              <span class="font-size-value">{{ settings.fontSize }}px</span>
            </div>
          </SettingItem>

          <SettingItem label-key="settings.colorScheme" :term-keys="['settings.themeAuto']" block>
            <div class="scheme-grid">
              <button
                class="scheme-card"
                :class="{ active: settings.colorSchemeName === AUTO_THEME }"
                @click="settings.colorSchemeName = AUTO_THEME"
              >
                <div class="scheme-preview" :style="{ background: autoScheme.background, fontFamily: settings.fontFamily }">
                  <span :style="{ color: autoScheme.foreground }">abc</span>
                  <span :style="{ color: autoScheme.red }">err</span>
                  <span :style="{ color: autoScheme.green }">ok</span>
                  <span :style="{ color: autoScheme.yellow }">wrn</span>
                  <span :style="{ color: autoScheme.blue }">inf</span>
                  <span :style="{ color: autoScheme.magenta }">dbg</span>
                  <span :style="{ color: autoScheme.cyan }">url</span>
                </div>
                <span class="scheme-name">{{ t('settings.themeAuto') }}</span>
              </button>
              <button
                v-for="scheme in COLOR_SCHEMES"
                :key="scheme.name"
                class="scheme-card"
                :class="{ active: settings.colorSchemeName === scheme.name }"
                @click="settings.colorSchemeName = scheme.name"
              >
                <div class="scheme-preview" :style="{ background: scheme.background, fontFamily: settings.fontFamily }">
                  <span :style="{ color: scheme.foreground }">abc</span>
                  <span :style="{ color: scheme.red }">err</span>
                  <span :style="{ color: scheme.green }">ok</span>
                  <span :style="{ color: scheme.yellow }">wrn</span>
                  <span :style="{ color: scheme.blue }">inf</span>
                  <span :style="{ color: scheme.magenta }">dbg</span>
                  <span :style="{ color: scheme.cyan }">url</span>
                </div>
                <span class="scheme-name">{{ scheme.name }}</span>
              </button>
            </div>
          </SettingItem>

          <SettingItem label-key="settings.preview" block>
            <div
              class="terminal-preview"
              :style="{
                background: settings.colorScheme.background,
                fontFamily: settings.fontFamily,
                fontSize: settings.fontSize + 'px',
              }"
            >
              <div v-for="(line, i) in PREVIEW_LINES" :key="i" class="preview-line">
                <template v-if="line.prompt">
                  <span :style="{ color: settings.colorScheme[line.promptColor as keyof typeof settings.colorScheme] }">{{ line.prompt }}</span>
                  <span :style="{ color: settings.colorScheme.foreground }">{{ line.cmd }}</span>
                  <span v-if="line.cursor" class="preview-cursor" :style="{ background: settings.colorScheme.cursor }" />
                </template>
                <template v-else>
                  <span :style="{ color: settings.colorScheme[line.color as keyof typeof settings.colorScheme] }">{{ line.text }}</span>
                </template>
              </div>
            </div>
          </SettingItem>
        </SettingGroup>

        <SettingGroup title-key="settings.groupBehavior">
          <SettingItem label-key="settings.copyOnSelect">
            <SettingToggle v-model="settings.terminalCopyOnSelect" :options="ON_OFF" />
          </SettingItem>

          <SettingItem label-key="settings.rightClickPaste">
            <SettingToggle v-model="settings.terminalRightClickPaste" :options="ON_OFF" />
          </SettingItem>
        </SettingGroup>

        <SettingGroup title-key="settings.groupShell">
          <SettingItem label-key="settings.globalShell" hint-key="settings.globalShellHint">
            <select class="setting-select" :value="globalShellValue" @change="onGlobalShellChange">
              <option v-for="opt in globalShellOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </SettingItem>

          <SettingItem
            label-key="settings.shellProfiles"
            hint-key="settings.shellProfilesHint"
            data-testid="settings-shells"
            block
          >
            <div class="setting-list">
              <ProfileRow
                v-for="(p, i) in settings.shellProfiles"
                :key="p.id"
                :label="shellProfileLabel(p.shell)"
                :is-default="p.id === defaultShellId"
                :hidden="p.hidden"
                :can-hide="canHideShellProfile(p)"
                :first="i === 0"
                :last="i === settings.shellProfiles.length - 1"
                @move="(dir) => moveInList(settings.shellProfiles, i, dir)"
                @toggle="toggleShellProfileHidden(i)"
              >
                <template #icon>
                  <component :is="SHELL_KIND_ICONS[p.shell.kind]" :size="14" :stroke-width="1.5" class="profile-icon" />
                </template>
              </ProfileRow>
            </div>
          </SettingItem>
        </SettingGroup>
      </SettingSection>

      <!-- Agents (#275)。ターミナルで動かすものなので Terminal の直後に置く。 -->
      <SettingSection v-bind="SECTIONS.agent">
        <SettingGroup title-key="settings.groupLaunch">
          <!--
            起動行の 1 本のリスト（#275）。表のエージェントと利用者が書いた行が同じ順序に
            並び、**使える先頭が既定**。行の形は 2 つあるが、違うのはスロットの中身だけなので
            `ProfileRow` は 1 つに保ち、束縛も `launcherRowBind` の 1 つを `v-bind` する
            （#305 の `tabBind` と同じ理由）。
          -->
          <SettingItem
            label-key="settings.agentLaunchers"
            hint-key="settings.agentLaunchersHint"
            data-testid="settings-agents"
            block
          >
            <div class="setting-list">
              <ProfileRow
                v-for="(l, i) in settings.agentLaunchers"
                :key="i"
                v-bind="launcherRowBind(l, i)"
              >
                <template #icon>
                  <component
                    :is="l.kind === 'custom' ? SquareTerminal : Bot"
                    :size="14"
                    :stroke-width="1.5"
                    class="profile-icon"
                  />
                </template>
                <template v-if="l.kind === 'custom'">
                  <input v-model="l.label" class="agent-cmd-input label" :placeholder="t('settings.agentCommandLabel')" />
                  <input v-model="l.command" class="agent-cmd-input cmd" :placeholder="t('settings.agentCommandCommand')" />
                </template>
                <template v-if="l.kind === 'custom'" #actions>
                  <button class="icon-btn danger" :title="t('common.delete')" @click="removeCustomLauncher(i)">
                    <Trash2 :size="14" :stroke-width="2" />
                  </button>
                </template>
              </ProfileRow>
            </div>
            <button class="add-cmd-btn" @click="addCustomLauncher">
              <Plus :size="14" :stroke-width="2" /> {{ t('settings.addAgentLauncher') }}
            </button>
          </SettingItem>

          <SettingItem label-key="settings.agentPrompts" hint-key="settings.agentPromptsHint" block>
            <div class="setting-list">
              <div v-for="(p, i) in settings.agentPrompts" :key="i" class="setting-list-row prompt-row">
                <div class="agent-cmd-reorder">
                  <button class="icon-btn" :disabled="i === 0" :title="'↑'" @click="moveAgentPrompt(i, -1)">
                    <ChevronUp :size="14" :stroke-width="2" />
                  </button>
                  <button class="icon-btn" :disabled="i === settings.agentPrompts.length - 1" :title="'↓'" @click="moveAgentPrompt(i, 1)">
                    <ChevronDown :size="14" :stroke-width="2" />
                  </button>
                </div>
                <input v-model="p.label" class="agent-cmd-input label" :placeholder="t('settings.agentPromptLabel')" />
                <textarea v-model="p.text" class="agent-cmd-input prompt-text" rows="2" :placeholder="t('settings.agentPromptText')" />
                <button class="icon-btn danger" :title="t('common.delete')" @click="removeAgentPrompt(i)">
                  <Trash2 :size="14" :stroke-width="2" />
                </button>
              </div>
            </div>
            <button class="add-cmd-btn" @click="addAgentPrompt">
              <Plus :size="14" :stroke-width="2" /> {{ t('settings.addAgentPrompt') }}
            </button>
          </SettingItem>
        </SettingGroup>

        <SettingGroup title-key="settings.groupIntegration">
          <!--
            Claude Code の hook（#299）。**「登録済み」と「申告が届いた」は別に出す**:
            settings.json に書いてあることは、そのマシンで実際に claude が Pike を
            呼べていることを意味しない（PATH に pike.exe が無い、等）。効いているかを
            言うのは申告のほうなので、両方を並べる。
          -->
          <SettingItem label-key="settings.agentHook" hint-key="settings.agentHookHint" block>
            <p v-if="!projectStore.activeRoot" class="setting-hint">{{ t('settings.agentHookNoProject') }}</p>
            <template v-else-if="hookStatus">
              <div class="setting-list">
                <div
                  v-for="target in hookStatus.targets"
                  :key="`${target.installKey}:${target.configDir}`"
                  class="setting-list-row"
                >
                  <code class="setting-list-name hook-dir">{{ target.configDir }}</code>
                  <span v-if="target.active" class="hook-badge">{{ t('settings.agentHookActive') }}</span>
                  <span v-if="target.registered" class="setting-hint hook-done" :title="target.command">{{ t('settings.agentHookRegistered') }}</span>
                  <button v-else class="add-cmd-btn" :disabled="hookBusy" :title="target.command" @click="editHook(target, false)">
                    <Plus :size="14" :stroke-width="2" /> {{ t('settings.agentHookInstall') }}
                  </button>
                  <!--
                    削除は `hasAny`（1 本でもあるか）で出す。`registered`（全部揃っているか）
                    だと、#299 の版が書いた 1 本だけのファイルは「未登録」なので、**一度
                    登録し直さないと消せない**（理由は Rust 側の `HookTarget::has_any`）。
                  -->
                  <button v-if="target.hasAny" class="icon-btn danger" :disabled="hookBusy" :title="t('settings.agentHookRemove')" @click="editHook(target, true)">
                    <Trash2 :size="14" :stroke-width="2" />
                  </button>
                </div>
              </div>
              <p v-if="hookStatus.targets.length === 0" class="setting-hint">{{ t('settings.agentHookNoTarget') }}</p>
              <p class="setting-hint hook-declared">
                <span>
                  {{ t('settings.agentHookDeclared') }}:
                  <code v-if="hookStatus.declared">{{ hookStatus.declared }}</code>
                  <template v-else>{{ t('settings.agentHookPending') }}</template>
                </span>
                <button
                  v-if="hookStatus.declared"
                  class="icon-btn"
                  :disabled="hookBusy"
                  :title="t('settings.agentHookForget')"
                  @click="forgetHook"
                >
                  <Trash2 :size="14" :stroke-width="2" />
                </button>
              </p>
            </template>
            <p v-if="hookError" class="setting-hint hook-error">{{ hookError }}</p>
          </SettingItem>

          <!--
            入力待ちの通知（#265）。**hook の下に置く**: 届くのは hook を登録した
            アカウントのぶんだけなので、上の項目がこの設定の前提になっている。
          -->
          <SettingItem label-key="settings.agentNotify" hint-key="settings.agentNotifyHint">
            <SettingToggle v-model="settings.agentNotify" :options="AGENT_NOTIFY_OPTIONS" />
          </SettingItem>
        </SettingGroup>
      </SettingSection>

      <!-- Editor -->
      <SettingSection v-bind="SECTIONS.editor">
        <SettingGroup title-key="settings.groupDisplay">
          <SettingItem label-key="settings.editorFont">
            <select class="setting-select" v-model="settings.editorFontName">
              <option v-for="font in settings.availableFonts" :key="font" :value="font">{{ font }}</option>
            </select>
          </SettingItem>

          <SettingItem label-key="settings.editorFontSize">
            <div class="font-size-control">
              <input
                type="range"
                min="8"
                max="32"
                :value="settings.editorFontSize"
                @input="onEditorFontSizeInput"
                class="setting-range"
              />
              <span class="font-size-value">{{ settings.editorFontSize }}px</span>
            </div>
          </SettingItem>

          <SettingItem label-key="settings.editorTheme" :term-keys="['settings.themeAuto']" block>
            <div class="scheme-grid">
              <button
                class="scheme-card"
                :class="{ active: settings.editorThemeName === AUTO_THEME }"
                @click="settings.editorThemeName = AUTO_THEME"
              >
                <div class="scheme-preview" :style="{ background: autoEditorTheme.background, color: autoEditorTheme.foreground, fontFamily: editorFontFamily }">
                  <span>fn</span>
                  <span :style="{ color: autoEditorTheme.accent }">main</span>
                  <span>()</span>
                </div>
                <span class="scheme-name">{{ t('settings.themeAuto') }}</span>
              </button>
              <button
                v-for="theme in EDITOR_THEMES"
                :key="theme.name"
                class="scheme-card"
                :class="{ active: settings.editorThemeName === theme.name }"
                @click="settings.editorThemeName = theme.name"
              >
                <div class="scheme-preview" :style="{ background: theme.background, color: theme.foreground, fontFamily: editorFontFamily }">
                  <span>fn</span>
                  <span :style="{ color: theme.accent }">main</span>
                  <span>()</span>
                </div>
                <span class="scheme-name">{{ theme.name }}</span>
              </button>
            </div>
          </SettingItem>

          <SettingItem label-key="settings.minimap">
            <SettingToggle v-model="settings.editorMinimap" :options="ON_OFF" />
          </SettingItem>

          <SettingItem label-key="settings.wordWrap" hint-key="settings.wordWrapHint">
            <SettingToggle v-model="settings.editorWordWrap" :options="ON_OFF" />
          </SettingItem>

          <SettingItem label-key="settings.tabSize">
            <select
              class="setting-select setting-select-narrow"
              :value="settings.editorTabSize"
              @change="settings.editorTabSize = parseInt(($event.target as HTMLSelectElement).value)"
            >
              <option :value="2">2</option>
              <option :value="4">4</option>
              <option :value="8">8</option>
            </select>
          </SettingItem>
        </SettingGroup>

        <SettingGroup title-key="settings.groupSave">
          <!-- 保存の主体は人のまま。これは Ctrl+S の押し忘れを代行する設定（#262 / #276）。 -->
          <SettingItem label-key="settings.autoSave" hint-key="settings.autoSaveHint">
            <SettingToggle v-model="settings.autoSave" :options="AUTO_SAVE_OPTIONS" />
          </SettingItem>

          <SettingItem v-if="settings.autoSave === 'afterDelay'" label-key="settings.autoSaveDelay">
            <!-- `v-model.number` にしないこと。あれは打鍵のたびに書き込むので、値を消して
                 打ち直すあいだ 0ms（＝1 文字ごとにファイル書き込み）になる。`:min` / `:max`
                 はブラウザの検証にしか効かないので、確定時に自分で丸める。 -->
            <input
              :value="settings.autoSaveDelay"
              type="number"
              :min="AUTO_SAVE_DELAY_MIN"
              :max="AUTO_SAVE_DELAY_MAX"
              step="100"
              class="number-input"
              @change="settings.autoSaveDelay = clampAutoSaveDelay(($event.target as HTMLInputElement).value)"
            />
          </SettingItem>
        </SettingGroup>

        <SettingGroup title-key="settings.groupDiffPreview">
          <SettingItem label-key="settings.diffWordWrap" hint-key="settings.diffWordWrapHint">
            <SettingToggle v-model="settings.diffWordWrap" :options="DIFF_WORD_WRAP_OPTIONS" />
          </SettingItem>

          <SettingItem label-key="settings.previewSmoothScroll">
            <SettingToggle v-model="settings.previewSmoothScroll" :options="ON_OFF" />
          </SettingItem>
        </SettingGroup>
      </SettingSection>

      <!-- 外部との通信（#314）。**エディタから切り出してある**: 3 つとも「Pike が外の
           ホストへ出て行く / 出て行かない」の設定で、どこで使う機能かより、そちらの軸で
           探されるため。 -->
      <SettingSection v-bind="SECTIONS.external">
        <!-- 外部通信を伴う唯一の編集機能なので、何が起きるかを hint に書いておく（#241）。 -->
        <SettingItem label-key="settings.fetchLinkTitle" hint-key="settings.fetchLinkTitleHint">
          <SettingToggle v-model="settings.markdownFetchLinkTitle" :options="ON_OFF" />
        </SettingItem>

        <SettingItem label-key="settings.imageHosts" hint-key="settings.imageHostsHint" block>
          <AllowedHostList :hosts="settings.allowedImageHosts" @forget="settings.forgetImageHost" />
        </SettingItem>

        <SettingItem label-key="settings.urlHosts" hint-key="settings.urlHostsHint" block>
          <AllowedHostList :hosts="settings.allowedUrlHosts" @forget="settings.forgetUrlHost" />
        </SettingItem>
      </SettingSection>

      <!-- Settings Sync -->
      <SettingSection v-bind="SECTIONS.sync">
        <SettingItem label-key="settings.syncFilePath" hint-key="settings.syncHint" block>
          <div class="sync-path-row">
            <input
              v-model="settings.syncFilePath"
              class="agent-cmd-input sync-path-input"
              type="text"
              spellcheck="false"
              :placeholder="t('settings.syncFilePathPlaceholder')"
            />
            <button type="button" class="detect-btn" @click="browseSyncFile">
              {{ t('project.browse') }}
            </button>
          </div>
          <div class="sync-actions">
            <button class="update-btn" :disabled="!settings.syncFilePath" @click="exportAll">
              {{ t('settings.syncExport') }}
            </button>
            <button class="update-btn" :disabled="!settings.syncFilePath" @click="importAll">
              {{ t('settings.syncImport') }}
            </button>
            <span v-if="settings.syncStatus === 'saved'" class="update-info update-ok">{{ t('settings.syncSaved') }}</span>
            <span v-else-if="settings.syncStatus === 'loaded'" class="update-info update-ok">{{ t('settings.syncLoaded') }}</span>
            <span v-else-if="settings.syncStatus === 'error'" class="update-info update-err">
              {{ t('settings.syncError') }}{{ settings.syncMessage ? ': ' + settings.syncMessage : '' }}
            </span>
          </div>
        </SettingItem>

        <SettingItem label-key="settings.projectBase" hint-key="settings.projectBaseHint" block>
          <!-- base はプラットフォームごとに要る。macOS / Linux のプロジェクトは
               platform='unix' なので、この欄が無いと 1 件も同期対象にならない。
               ホスト側の欄は `hostBase` が 1 つに畳んでいる（Windows か Unix か）。 -->
          <div class="sync-path-row">
            <span class="base-label">{{ hostBase.label }}</span>
            <input
              v-model="settings.projectBase[hostBase.key]"
              class="agent-cmd-input sync-path-input"
              type="text"
              spellcheck="false"
              :placeholder="hostBase.placeholder"
            />
            <button type="button" class="detect-btn" @click="browseProjectBase">
              {{ t('project.browse') }}
            </button>
          </div>
          <!-- WSL の base は Windows ホストにしか無い。 -->
          <div v-if="isWindowsHost" class="sync-path-row">
            <span class="base-label">WSL</span>
            <input
              v-model="settings.projectBase.wsl"
              class="agent-cmd-input sync-path-input"
              type="text"
              spellcheck="false"
              placeholder="/home/me/src"
            />
            <select v-model="settings.projectBase.wslDistro" class="base-distro">
              <option value="">{{ t('settings.projectBaseNoDistro') }}</option>
              <option v-for="d in distros" :key="d" :value="d">{{ d }}</option>
            </select>
          </div>
          <p v-if="settings.syncFilePath && projectStore.unsyncableProjects.length > 0" class="setting-hint">
            {{ t('settings.projectBaseOutside', { count: projectStore.unsyncableProjects.length }) }}
          </p>
        </SettingItem>

        <SettingItem
          v-if="settings.hiddenProjects.length > 0"
          label-key="settings.hiddenProjects"
          hint-key="settings.hiddenProjectsHint"
          block
        >
          <div class="setting-list">
            <div v-for="p in settings.hiddenProjects" :key="p.id" class="setting-list-row">
              <span class="setting-list-name">{{ p.name }}</span>
              <button class="icon-btn" :title="t('settings.hiddenProjectsRestore')" @click="restoreProject(p.id)">
                <Eye :size="14" :stroke-width="2" />
              </button>
            </div>
          </div>
        </SettingItem>
      </SettingSection>

      <!-- About / Update -->
      <SettingSection v-bind="SECTIONS.about">
        <SettingItem label-key="settings.version">
          <span class="version-value">{{ updater.appVersion.value }}</span>
        </SettingItem>
        <SettingItem label-key="settings.checkUpdate">
          <div class="update-actions">
            <button
              v-if="updater.state.value === 'idle' || updater.state.value === 'upToDate' || updater.state.value === 'error'"
              class="update-btn"
              @click="updater.checkForUpdate"
            >{{ t('settings.checkUpdate') }}</button>
            <button v-else-if="updater.state.value === 'checking'" class="update-btn" disabled>
              <Loader :size="14" :stroke-width="2" class="spin" />
              {{ t('settings.checking') }}
            </button>
            <button v-else-if="updater.state.value === 'available'" class="update-btn update-btn-primary" @click="updater.downloadAndInstall">
              {{ t('settings.updateAndRestart') }}
            </button>
            <button v-else-if="updater.state.value === 'downloading'" class="update-btn" disabled>
              <Loader :size="14" :stroke-width="2" class="spin" />
              {{ t('settings.downloading') }}
            </button>
            <span v-if="updater.state.value === 'available'" class="update-info">
              {{ t('settings.updateAvailable', { version: updater.updateVersion.value }) }}
            </span>
            <span v-else-if="updater.state.value === 'upToDate'" class="update-info update-ok">
              {{ t('settings.upToDate') }}
            </span>
            <span v-else-if="updater.state.value === 'error'" class="update-info update-err">
              {{ t('settings.updateError') }}{{ updater.errorMessage.value ? ': ' + updater.errorMessage.value : '' }}
            </span>
          </div>
        </SettingItem>
      </SettingSection>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-tab {
  position: absolute;
  inset: 0;
  display: flex;
  overflow: hidden;
  background: var(--bg-primary);
  color: var(--text-primary);
  /* Always show the settings screen itself in the system font, so it stays a
     stable, legible reference no matter which UI font the user picks. */
  font-family: system-ui, -apple-system, sans-serif;
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 24px 0 24px 16px;
  width: 120px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
}

.nav-item {
  display: block;
  padding: 6px 12px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-align: left;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.nav-item:hover {
  color: var(--text-primary);
  background: var(--bg-tertiary);
}

.nav-item.active {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.settings-scroll {
  flex: 1;
  height: 100%;
  overflow-y: auto;
  padding: 24px 32px;
}

/* 見出しと絞り込みの入力欄（#314）。**sticky にしていない**: 透過・アクリル（#162）の
   ときは下地も透けるので、スクロールする本文が見出しの裏に重なって読めなくなる。 */
.settings-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}

.settings-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-active);
  margin: 0;
}

/* 見た目は `theme.css` の `.filter-row` / `.filter-icon` / `.filter-input`（プロジェクト
   パネルの絞り込みと共有）。ここで足すのは幅の取り方だけ。 */
.search-box {
  flex: 1;
  max-width: 320px;
}

/* WebView が付ける検索欄の ✕ は自前のボタンと二重になる。 */
.search-box input::-webkit-search-cancel-button {
  display: none;
}

.no-results {
  margin-bottom: 16px;
}

/* 1 項目ぶんの器（`.setting-block` / `.setting-row`）は `settings/SettingItem.vue` が持つ。
   `.setting-label` / `.setting-hint` は `theme.css`（切り出した部品と共有）。 */

.setting-select {
  padding: 4px 8px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 12px;
  font-family: inherit;
  min-width: 200px;
}

.setting-select:focus {
  outline: none;
  border-color: var(--accent);
}

.setting-select-narrow {
  min-width: 70px;
}

.number-input {
  padding: 4px 8px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 12px;
  font-family: inherit;
  width: 120px;
}

.number-input:focus {
  outline: none;
  border-color: var(--accent);
}

.font-size-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.setting-range {
  width: 140px;
  accent-color: var(--accent);
}

.font-size-value {
  font-size: 12px;
  color: var(--text-secondary);
  min-width: 36px;
  text-align: right;
}

/* 選択肢の並び（`.mode-toggle` / `.mode-btn`）は `settings/SettingToggle.vue` が描く。 */

/* Terminal Preview */
.terminal-preview {
  width: 100%;
  padding: 12px 14px;
  border-radius: 6px;
  border: 1px solid var(--border);
  line-height: 1.4;
  overflow: hidden;
  box-sizing: border-box;
}

.preview-line {
  white-space: pre;
  min-height: 1.4em;
}

.preview-cursor {
  display: inline-block;
  width: 0.6em;
  height: 1.1em;
  vertical-align: text-bottom;
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% { opacity: 0; }
}

/* Color Scheme Grid */
.scheme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
  width: 100%;
}

.scheme-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border: 2px solid var(--border);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  transition: border-color 0.15s;
}

.scheme-card:hover {
  border-color: var(--text-secondary);
}

.scheme-card.active {
  border-color: var(--accent);
}

.scheme-preview {
  display: flex;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 4px;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
}

.scheme-name {
  font-size: 11px;
  color: var(--text-secondary);
  text-align: center;
  padding: 2px 0;
}

.scheme-card.active .scheme-name {
  color: var(--accent);
  font-weight: 600;
}

/* About / Update */
.version-value {
  font-size: 13px;
  color: var(--text-secondary);
  font-family: 'Cascadia Code', 'Fira Code', monospace;
}

.update-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.update-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 14px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.update-btn:hover:not(:disabled) {
  background: var(--tab-hover-bg);
}

.update-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.update-btn-primary {
  background: var(--accent);
  color: var(--text-active);
  border-color: var(--accent);
}

.update-btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

.update-info {
  font-size: 12px;
  color: var(--text-secondary);
}

.update-ok {
  color: #4caf50;
}

.update-err {
  color: #f44336;
}

.spin {
  animation: spin 1s linear infinite;
}

/* inotify banner */
.inotify-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 20px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-primary);
  line-height: 1.5;
}

.inotify-banner :deep(svg) {
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--accent);
}

.inotify-banner code {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--accent);
  font-family: 'Cascadia Code', 'Fira Code', monospace;
}

/* 設定画面の「縦に並ぶ行の一覧」の共通の形。シェル一覧・エージェント一覧・起動コマンド・
   定型プロンプト・非表示のプロジェクトが共有する。**`agent-cmd-*` という名前だった**が、
   5 つのうち 4 つはエージェントのコマンドではないうえ、#275 でシェル一覧を
   `panels/ProfileRow.vue` へ出したときに、同じ形を別名（`shell-row` / `shell-name`）で
   使っていた非表示プロジェクトの一覧だけが定義を失って崩れた。 */
.setting-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.setting-list-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.setting-list-name {
  flex: 1;
  font-size: 12px;
  color: var(--text-primary);
}

/* 並べ替えと目のトグルを持つ行（シェル一覧・エージェント一覧）の見た目は
   `panels/ProfileRow.vue` が持つ。 */

.agent-cmd-reorder {
  display: flex;
  flex-direction: column;
}

.agent-cmd-reorder .icon-btn {
  height: 14px;
}

.agent-cmd-input {
  padding: 5px 8px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  border-radius: 3px;
  outline: none;
}

.agent-cmd-input:focus {
  border-color: var(--accent);
}

.agent-cmd-input.label {
  flex: 0 0 130px;
  min-width: 0;
}

.sync-path-row {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.sync-path-input {
  flex: 1;
  min-width: 0;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
}

/* Platform label in front of each project-base input (#164). */
.base-label {
  width: 56px;
  flex-shrink: 0;
  align-self: center;
  font-size: 11px;
  color: var(--text-secondary);
}

.base-distro {
  flex-shrink: 0;
  padding: 4px 6px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  border-radius: 3px;
}

.detect-btn {
  padding: 4px 10px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  border-radius: 3px;
  white-space: nowrap;
  flex-shrink: 0;
}

.detect-btn:hover {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}

.sync-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.agent-cmd-input.cmd {
  flex: 1;
  min-width: 0;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
}

/* Prompt rows hold a multi-line textarea — align controls to the top. */
.prompt-row {
  align-items: flex-start;
}

.agent-cmd-input.prompt-text {
  flex: 1;
  min-width: 0;
  resize: vertical;
  font-family: inherit;
  line-height: 1.4;
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  flex-shrink: 0;
}

.icon-btn:hover:not(:disabled) {
  color: var(--text-active);
  background: var(--tab-hover-bg);
}

.icon-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

.icon-btn.danger:hover:not(:disabled) {
  color: var(--danger);
}

.add-cmd-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  align-self: flex-start;
  padding: 5px 10px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  border-radius: 3px;
  cursor: pointer;
}

.add-cmd-btn:hover {
  background: var(--tab-hover-bg);
  border-color: var(--accent);
}

.add-cmd-btn:disabled {
  opacity: 0.5;
  cursor: default;
  border-color: var(--border);
  background: transparent;
}

/* hook の登録先（#299）。パスは長いので折り返す。 */
.hook-dir {
  word-break: break-all;
  font-family: var(--font-mono, monospace);
}

.hook-badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--accent);
  color: var(--bg-primary);
  font-size: 11px;
}

/* 色と寸法は共有の `.setting-hint`（theme.css）。ここは縮ませない指定だけ。 */
.hook-done {
  flex: 0 0 auto;
}

.hook-declared {
  display: flex;
  align-items: center;
  gap: 6px;
}

.hook-error {
  color: var(--danger);
}
</style>
