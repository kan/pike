import { emit, listen } from '@tauri-apps/api/event'
import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, nextTick, ref, watch } from 'vue'
import { locale } from '../i18n'
import { buildFontFamily, buildUiFontFamily, extractFontName } from '../lib/fontDetection'
import { loadJson, saveJson } from '../lib/storage'
import { fontListAll, fontListMonospace, settingsSyncRead, settingsSyncWrite } from '../lib/tauri'
import { windowLabel } from '../lib/window'
import {
  type ShellProfile,
  type ShellType,
  shellId,
  shellProfileLabel,
  shellToType,
  WINDOWS_SHELLS,
  type WindowsShellKind,
} from '../types/tab'

export interface TerminalColorScheme {
  name: string
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export const COLOR_SCHEMES: TerminalColorScheme[] = [
  {
    name: 'Default Dark',
    background: '#1e1e1e',
    foreground: '#cccccc',
    cursor: '#cccccc',
    selectionBackground: '#264f78',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#e5e5e5',
  },
  {
    name: 'Solarized Dark',
    background: '#002b36',
    foreground: '#839496',
    cursor: '#839496',
    selectionBackground: '#073642',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#586e75',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
  {
    name: 'Solarized Light',
    background: '#fdf6e3',
    foreground: '#657b83',
    cursor: '#657b83',
    selectionBackground: '#eee8d5',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#586e75',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
  {
    name: 'Monokai',
    background: '#272822',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    selectionBackground: '#49483e',
    black: '#272822',
    red: '#f92672',
    green: '#a6e22e',
    yellow: '#f4bf75',
    blue: '#66d9ef',
    magenta: '#ae81ff',
    cyan: '#a1efe4',
    white: '#f8f8f2',
    brightBlack: '#75715e',
    brightRed: '#f92672',
    brightGreen: '#a6e22e',
    brightYellow: '#f4bf75',
    brightBlue: '#66d9ef',
    brightMagenta: '#ae81ff',
    brightCyan: '#a1efe4',
    brightWhite: '#f9f8f5',
  },
  {
    name: 'Dracula',
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    selectionBackground: '#44475a',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
  {
    name: 'Nord',
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    selectionBackground: '#434c5e',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
]

const STORAGE_KEY = 'pike:settings'
// The external sync-file path is itself environment-specific (the Dropbox
// folder differs per PC), so it is stored separately and never written into the
// synced payload.
const SYNC_PATH_KEY = 'pike:sync-path'
// The global-mode default shell references this machine's WSL distros, so it
// is likewise machine-local: stored under its own key, excluded from the
// synced payload and the cross-window broadcast.
const GLOBAL_SHELL_KEY = 'pike:global-shell'
// Shell profile list (#129: dropdown order / visibility) also references this
// machine's WSL distros — same machine-local treatment as GLOBAL_SHELL_KEY.
const SHELL_PROFILES_KEY = 'pike:shell-profiles'
// Debounce window for mirroring settings changes out to the sync file.
const SYNC_WRITE_DEBOUNCE_MS = 1500
// Cross-window settings sync: broadcast changes so every open Pike window stays
// in sync (new windows already read the shared localStorage at startup).
const SETTINGS_CHANGED_EVENT = 'pike://settings-changed'
const BROADCAST_DEBOUNCE_MS = 150
// Base UI font size that maps to 100% (zoom = 1). The whole UI chrome is scaled
// proportionally via CSS `zoom`, so changing the size never breaks the layout.
export const UI_FONT_BASE = 13
export const UI_FONT_SIZE_MIN = 9
export const UI_FONT_SIZE_MAX = 20

export type AgentDefault = 'claude-code' | 'codex' | 'ask'

/** A one-click command the terminal can inject (e.g. `claude --continue`). */
export interface AgentCommand {
  label: string
  command: string
}

/** A reusable instruction snippet injected (as text, not submitted) into the terminal. */
export interface AgentPrompt {
  label: string
  text: string
}

interface PersistedSettings {
  fontFamily: string
  fontSize: number
  editorFontName: string
  editorFontSize: number
  uiFontFamily: string
  uiFontSize: number
  colorSchemeName: string
  darkMode: boolean
  editorThemeName: string
  editorMinimap: boolean
  editorWordWrap: boolean
  editorTabSize: number
  previewSmoothScroll: boolean
  terminalCopyOnSelect: boolean
  terminalRightClickPaste: boolean
  inlineSmallTextFiles: boolean
  inlineSmallTextThreshold: number
  language: string
  terminalExitNotification: boolean
  codexNotification: boolean
  agentDefault: AgentDefault
  agentCommands: AgentCommand[]
  agentPrompts: AgentPrompt[]
}

// Font-size slider bounds (terminal + editor); UI font size uses UI_FONT_SIZE_*.
const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 32

function clampSize(n: unknown, min: number, max: number, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function cleanName(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback
}

/**
 * Guard against corrupt persisted/synced values (wrong types, out-of-range):
 * clamp font sizes into range — a bad `uiFontSize` like 0 would otherwise zoom
 * the whole UI to invisible and divide-by-zero in the sidebar resize — and fall
 * back empty/non-string font names.
 */
function sanitize(s: PersistedSettings): PersistedSettings {
  const d = defaults()
  return {
    ...s,
    fontFamily: cleanName(s.fontFamily, d.fontFamily),
    fontSize: clampSize(s.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, d.fontSize),
    editorFontName: cleanName(s.editorFontName, d.editorFontName),
    editorFontSize: clampSize(s.editorFontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, d.editorFontSize),
    // uiFontFamily '' is valid (= System Default), so it is intentionally not coerced.
    uiFontSize: clampSize(s.uiFontSize, UI_FONT_SIZE_MIN, UI_FONT_SIZE_MAX, d.uiFontSize),
  }
}

function loadSettings(): PersistedSettings {
  return sanitize({ ...defaults(), ...loadJson<Partial<PersistedSettings>>(STORAGE_KEY, {}) })
}

/** Parse a persisted ShellType, or null when the value is corrupt. */
function sanitizeShell(v: unknown): ShellType | null {
  if (v && typeof v === 'object' && 'kind' in v) {
    const s = v as ShellType
    if (s.kind === 'wsl') {
      if (typeof s.distro === 'string' && s.distro) return { kind: 'wsl', distro: s.distro }
    } else if (s.kind === 'cmd' || s.kind === 'powershell' || s.kind === 'pwsh' || s.kind === 'git-bash') {
      return { kind: s.kind }
    }
  }
  return null
}

/** Guard the machine-local global shell against corrupt persisted values. */
function sanitizeGlobalShell(v: unknown): ShellType {
  return sanitizeShell(v) ?? { kind: 'powershell' }
}

function defaultShellProfiles(): ShellProfile[] {
  // WSL distros are appended by syncShellProfiles once detection runs.
  return WINDOWS_SHELLS.map((s) => ({ id: s.kind, shell: shellToType(s.kind) }))
}

/** Guard the machine-local shell profile list against corrupt persisted values. */
function sanitizeShellProfiles(v: unknown): ShellProfile[] {
  if (!Array.isArray(v)) return defaultShellProfiles()
  const out: ShellProfile[] = []
  const seen = new Set<string>()
  for (const item of v) {
    if (!item || typeof item !== 'object') continue
    const shell = sanitizeShell((item as { shell?: unknown }).shell)
    if (!shell) continue
    const id = shellId(shell)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, shell, hidden: (item as { hidden?: unknown }).hidden === true })
  }
  // Recover builtin Windows shells lost to corruption so they stay manageable.
  for (const s of WINDOWS_SHELLS) {
    if (!seen.has(s.kind)) out.push({ id: s.kind, shell: shellToType(s.kind) })
  }
  return ensureVisiblePerCategory(out)
}

/**
 * Safety net for the "cannot hide everything" rule the Settings UI enforces:
 * each present category (WSL / Windows) keeps at least one visible entry, so
 * the dropdown can never end up empty after corrupt/hand-edited storage.
 */
function ensureVisiblePerCategory(list: ShellProfile[]): ShellProfile[] {
  for (const isWsl of [true, false]) {
    const category = list.filter((p) => (p.shell.kind === 'wsl') === isWsl)
    if (category.length > 0 && category.every((p) => p.hidden)) {
      category[0].hidden = false
    }
  }
  return list
}

function defaults(): PersistedSettings {
  return {
    fontFamily: "'PlemolJP Console NF', 'Cascadia Code', 'Fira Code', monospace",
    fontSize: 14,
    editorFontName: 'PlemolJP Console NF',
    editorFontSize: 14,
    uiFontFamily: '',
    uiFontSize: UI_FONT_BASE,
    colorSchemeName: 'Default Dark',
    darkMode: true,
    editorThemeName: 'One Dark',
    editorMinimap: true,
    editorWordWrap: false,
    editorTabSize: 4,
    previewSmoothScroll: true,
    terminalCopyOnSelect: true,
    terminalRightClickPaste: true,
    inlineSmallTextFiles: false,
    inlineSmallTextThreshold: 4096,
    language: 'en',
    terminalExitNotification: true,
    codexNotification: true,
    agentDefault: 'claude-code' as AgentDefault,
    agentCommands: [
      { label: 'Claude', command: 'claude' },
      { label: 'Claude (continue)', command: 'claude --continue' },
    ],
    agentPrompts: [
      { label: '続けて', text: 'はい、続けてください' },
      { label: '説明', text: '上のコードが何をしているか説明して。' },
      { label: 'エラー修正', text: '上のエラーを修正して。' },
    ],
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const saved = loadSettings()

  const fontFamily = ref(saved.fontFamily)
  const fontSize = ref(saved.fontSize)
  const editorFontName = ref(saved.editorFontName)
  const editorFontSize = ref(saved.editorFontSize)
  const uiFontFamily = ref(saved.uiFontFamily)
  const uiFontSize = ref(saved.uiFontSize)
  const colorSchemeName = ref(saved.colorSchemeName)
  const darkMode = ref(saved.darkMode)
  const editorThemeName = ref(saved.editorThemeName)
  const editorMinimap = ref(saved.editorMinimap)
  const editorWordWrap = ref(saved.editorWordWrap)
  const editorTabSize = ref(saved.editorTabSize)
  const previewSmoothScroll = ref(saved.previewSmoothScroll)
  const terminalCopyOnSelect = ref(saved.terminalCopyOnSelect)
  const terminalRightClickPaste = ref(saved.terminalRightClickPaste)
  const inlineSmallTextFiles = ref(saved.inlineSmallTextFiles)
  const inlineSmallTextThreshold = ref(saved.inlineSmallTextThreshold)
  const language = ref(saved.language)
  const terminalExitNotification = ref(saved.terminalExitNotification)
  const codexNotification = ref(saved.codexNotification)
  const agentDefault = ref<AgentDefault>(saved.agentDefault)
  const agentCommands = ref<AgentCommand[]>(saved.agentCommands)
  const agentPrompts = ref<AgentPrompt[]>(saved.agentPrompts)

  // Machine-local (references this PC's WSL distros — never synced/broadcast).
  const globalShell = ref<ShellType>(sanitizeGlobalShell(loadJson<unknown>(GLOBAL_SHELL_KEY, null)))
  watch(globalShell, (v) => saveJson(GLOBAL_SHELL_KEY, v), { deep: true })

  // Shell profiles (#129): dropdown order / visibility. Machine-local like
  // globalShell. WSL entries are reconciled against detection results by
  // syncShellProfiles (callers that run detect_wsl_distros invoke it).
  const shellProfiles = ref<ShellProfile[]>(sanitizeShellProfiles(loadJson<unknown>(SHELL_PROFILES_KEY, null)))
  watch(shellProfiles, (v) => saveJson(SHELL_PROFILES_KEY, v), { deep: true })

  /**
   * Reconcile the profile list with the detected WSL distros: new distros are
   * prepended (WSL first — the primary environment in global mode), stale WSL
   * entries are dropped, missing builtin Windows shells are appended. Order and
   * hidden flags of surviving entries are preserved.
   */
  function syncShellProfiles(distros: string[]) {
    const detected = new Set(distros.map((d) => `wsl:${d}`))
    const kept = shellProfiles.value.filter((p) => p.shell.kind !== 'wsl' || detected.has(p.id))
    const have = new Set(kept.map((p) => p.id))
    const newWsl: ShellProfile[] = distros
      .filter((d) => !have.has(`wsl:${d}`))
      .map((d) => ({ id: `wsl:${d}`, shell: { kind: 'wsl', distro: d } }))
    const newWin: ShellProfile[] = WINDOWS_SHELLS.filter((s) => !have.has(s.kind)).map((s) => ({
      id: s.kind,
      shell: shellToType(s.kind),
    }))
    if (newWsl.length || newWin.length || kept.length !== shellProfiles.value.length) {
      shellProfiles.value = [...newWsl, ...kept, ...newWin]
    }
    // Dropping stale WSL entries can leave a category all-hidden — re-apply
    // the "at least one visible per category" rule.
    ensureVisiblePerCategory(shellProfiles.value)
  }

  /**
   * Windows-shell dropdown options (#129): profile order, hidden excluded.
   * `currentKind` stays listed so a form never loses its saved selection.
   */
  function windowsShellOptions(currentKind?: WindowsShellKind): { kind: WindowsShellKind; label: string }[] {
    return shellProfiles.value
      .filter((p) => p.shell.kind !== 'wsl' && (!p.hidden || p.shell.kind === currentKind))
      .map((p) => ({ kind: p.shell.kind as WindowsShellKind, label: shellProfileLabel(p.shell) }))
  }

  /**
   * Filter detected WSL distros by profile visibility (#129). Distros without
   * a profile entry (detection newer than the last sync) pass through, and
   * `currentDistro` stays listed so a form never loses its saved selection.
   */
  function visibleWslDistros(detected: readonly string[], currentDistro?: string): string[] {
    const hidden = new Set(shellProfiles.value.filter((p) => p.hidden).map((p) => p.id))
    return detected.filter((d) => d === currentDistro || !hidden.has(`wsl:${d}`))
  }

  // Sync language setting with i18n locale
  locale.value = saved.language
  watch(language, (v) => {
    locale.value = v
  })

  // Detected monospace fonts on this system (loaded on demand from Rust).
  // Shared by the terminal and the editor font pickers (both are code surfaces).
  const availableFonts = ref<string[]>([...new Set([extractFontName(saved.fontFamily), saved.editorFontName])])
  let fontsLoaded = false

  function loadAvailableFonts() {
    if (fontsLoaded) return
    fontsLoaded = true
    fontListMonospace()
      .then((fonts) => {
        // Keep any currently-selected font (terminal or editor) visible even if
        // the monospace heuristic didn't detect it.
        const extras: string[] = []
        for (const name of [extractFontName(fontFamily.value), editorFontName.value]) {
          if (name !== 'monospace' && !fonts.includes(name) && !extras.includes(name)) {
            extras.push(name)
          }
        }
        availableFonts.value = [...extras, ...fonts]
      })
      .catch(() => {
        /* fallback: keep current font */
      })
  }

  // All installed font families (for the UI/app font picker), loaded on demand.
  const availableUiFonts = ref<string[]>(saved.uiFontFamily ? [saved.uiFontFamily] : [])
  let uiFontsLoaded = false

  function loadAvailableUiFonts() {
    if (uiFontsLoaded) return
    uiFontsLoaded = true
    fontListAll()
      .then((fonts) => {
        availableUiFonts.value = fonts
        const current = uiFontFamily.value
        if (current && !fonts.includes(current)) {
          availableUiFonts.value = [current, ...fonts]
        }
      })
      .catch(() => {
        /* fallback: keep current font */
      })
  }

  /** CSS font-family value for the UI font ('' → system default stack). */
  const uiFontFamilyCss = computed(() => buildUiFontFamily(uiFontFamily.value))

  /** Chrome zoom factor (1 = 100%). Mirrors the `--ui-zoom` CSS variable. */
  const uiZoom = computed(() => uiFontSize.value / UI_FONT_BASE)

  /** Apply the UI font + size (as a chrome-wide zoom) to the document root. */
  function applyUiAppearance() {
    const root = document.documentElement
    root.style.setProperty('--app-font-family', uiFontFamilyCss.value)
    root.style.setProperty('--ui-zoom', String(uiZoom.value))
  }

  // Current font name extracted from fontFamily string
  const fontName = computed(() => extractFontName(fontFamily.value))

  function setFontByName(name: string) {
    fontFamily.value = buildFontFamily(name)
  }

  const colorScheme = computed(() => COLOR_SCHEMES.find((s) => s.name === colorSchemeName.value) ?? COLOR_SCHEMES[0])

  const xtermTheme = computed(() => {
    const { name, ...theme } = colorScheme.value
    return theme
  })

  /** Snapshot the persistable (environment-independent) settings. */
  function snapshot(): PersistedSettings {
    return {
      fontFamily: fontFamily.value,
      fontSize: fontSize.value,
      editorFontName: editorFontName.value,
      editorFontSize: editorFontSize.value,
      uiFontFamily: uiFontFamily.value,
      uiFontSize: uiFontSize.value,
      colorSchemeName: colorSchemeName.value,
      darkMode: darkMode.value,
      editorThemeName: editorThemeName.value,
      editorMinimap: editorMinimap.value,
      editorWordWrap: editorWordWrap.value,
      editorTabSize: editorTabSize.value,
      previewSmoothScroll: previewSmoothScroll.value,
      terminalCopyOnSelect: terminalCopyOnSelect.value,
      terminalRightClickPaste: terminalRightClickPaste.value,
      inlineSmallTextFiles: inlineSmallTextFiles.value,
      inlineSmallTextThreshold: inlineSmallTextThreshold.value,
      language: language.value,
      terminalExitNotification: terminalExitNotification.value,
      codexNotification: codexNotification.value,
      agentDefault: agentDefault.value,
      agentCommands: agentCommands.value,
      agentPrompts: agentPrompts.value,
    }
  }

  function persist() {
    saveJson(STORAGE_KEY, snapshot())
  }

  /** Apply a settings payload (from the sync file) onto the live refs. */
  function applySettings(s: PersistedSettings) {
    fontFamily.value = s.fontFamily
    fontSize.value = s.fontSize
    editorFontName.value = s.editorFontName
    editorFontSize.value = s.editorFontSize
    uiFontFamily.value = s.uiFontFamily
    uiFontSize.value = s.uiFontSize
    colorSchemeName.value = s.colorSchemeName
    darkMode.value = s.darkMode
    editorThemeName.value = s.editorThemeName
    editorMinimap.value = s.editorMinimap
    editorWordWrap.value = s.editorWordWrap
    editorTabSize.value = s.editorTabSize
    previewSmoothScroll.value = s.previewSmoothScroll
    terminalCopyOnSelect.value = s.terminalCopyOnSelect
    terminalRightClickPaste.value = s.terminalRightClickPaste
    inlineSmallTextFiles.value = s.inlineSmallTextFiles
    inlineSmallTextThreshold.value = s.inlineSmallTextThreshold
    language.value = s.language
    terminalExitNotification.value = s.terminalExitNotification
    codexNotification.value = s.codexNotification
    agentDefault.value = s.agentDefault
    agentCommands.value = s.agentCommands
    agentPrompts.value = s.agentPrompts
  }

  // --- External settings-sync file ---------------------------------------
  // Pike has no built-in sync service; instead it mirrors `snapshot()` to a
  // JSON file at a user-chosen host path (point it at Dropbox/OneDrive/git).
  const syncFilePath = ref(loadJson<string>(SYNC_PATH_KEY, ''))
  // 'idle' | 'saved' | 'loaded' | 'error'
  const syncStatus = ref<'idle' | 'saved' | 'loaded' | 'error'>('idle')
  const syncMessage = ref('')
  let importing = false
  let syncWriteTimer: ReturnType<typeof setTimeout> | null = null
  // True while applying a snapshot received from another window — suppresses
  // re-persisting to the sync file and re-broadcasting (avoids feedback loops).
  let applyingRemote = false
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null

  watch(syncFilePath, (v) => saveJson(SYNC_PATH_KEY, v))

  /** Write the current settings out to the sync file. */
  async function exportToSyncFile(): Promise<boolean> {
    if (!syncFilePath.value) return false
    try {
      await settingsSyncWrite(syncFilePath.value, JSON.stringify(snapshot(), null, 2))
      syncStatus.value = 'saved'
      syncMessage.value = ''
      return true
    } catch (e) {
      syncStatus.value = 'error'
      syncMessage.value = String(e)
      return false
    }
  }

  /** Load settings from the sync file and apply them. */
  async function importFromSyncFile(): Promise<boolean> {
    if (!syncFilePath.value) return false
    try {
      const raw = await settingsSyncRead(syncFilePath.value)
      const parsed = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('invalid settings file')
      }
      importing = true
      applySettings(sanitize({ ...defaults(), ...(parsed as Partial<PersistedSettings>) }))
      await nextTick() // let change-watchers flush while writes are suppressed
      importing = false
      persist() // mirror the imported settings into localStorage
      syncStatus.value = 'loaded'
      syncMessage.value = ''
      return true
    } catch (e) {
      importing = false
      syncStatus.value = 'error'
      syncMessage.value = String(e)
      return false
    }
  }

  function scheduleSyncWrite() {
    if (!syncFilePath.value || importing || applyingRemote) return
    if (syncWriteTimer) clearTimeout(syncWriteTimer)
    syncWriteTimer = setTimeout(() => {
      syncWriteTimer = null
      void exportToSyncFile()
    }, SYNC_WRITE_DEBOUNCE_MS)
  }

  // Broadcast the current settings to every other open Pike window (debounced).
  function scheduleBroadcast() {
    if (importing || applyingRemote) return
    if (broadcastTimer) clearTimeout(broadcastTimer)
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null
      void emit(SETTINGS_CHANGED_EVENT, { from: windowLabel, payload: snapshot() })
    }, BROADCAST_DEBOUNCE_MS)
  }

  // Apply a snapshot pushed from another window without echoing it back out.
  async function applyRemoteSettings(payload: PersistedSettings) {
    applyingRemote = true
    applySettings(sanitize({ ...defaults(), ...payload }))
    await nextTick() // let change-watchers flush while writes/broadcast are suppressed
    applyingRemote = false
    persist() // mirror into this window's localStorage too
  }

  listen<{ from: string; payload: PersistedSettings }>(SETTINGS_CHANGED_EVENT, (event) => {
    if (event.payload.from === windowLabel) return // ignore our own broadcast
    void applyRemoteSettings(event.payload.payload)
  })

  function onSettingsChanged() {
    persist()
    scheduleSyncWrite()
    scheduleBroadcast()
  }

  function applyDarkMode() {
    document.documentElement.setAttribute('data-theme', darkMode.value ? 'dark' : 'light')
  }

  watch(
    [
      fontFamily,
      fontSize,
      editorFontName,
      editorFontSize,
      uiFontFamily,
      uiFontSize,
      colorSchemeName,
      darkMode,
      editorThemeName,
      editorMinimap,
      editorWordWrap,
      editorTabSize,
      previewSmoothScroll,
      terminalCopyOnSelect,
      terminalRightClickPaste,
      inlineSmallTextFiles,
      inlineSmallTextThreshold,
      language,
      terminalExitNotification,
      codexNotification,
      agentDefault,
    ],
    onSettingsChanged,
  )
  // agentCommands / agentPrompts are arrays — deep-watch so in-place edits persist too.
  watch(agentCommands, onSettingsChanged, { deep: true })
  watch(agentPrompts, onSettingsChanged, { deep: true })
  watch(darkMode, applyDarkMode, { immediate: true })
  watch([uiFontFamily, uiFontSize], applyUiAppearance, { immediate: true })

  // On startup, pull the latest settings from the sync file (if configured).
  if (syncFilePath.value) void importFromSyncFile()

  return {
    fontFamily,
    fontName,
    fontSize,
    editorFontName,
    editorFontSize,
    uiFontFamily,
    uiFontSize,
    uiFontFamilyCss,
    uiZoom,
    availableUiFonts,
    loadAvailableUiFonts,
    colorSchemeName,
    colorScheme,
    darkMode,
    editorThemeName,
    editorMinimap,
    editorWordWrap,
    editorTabSize,
    previewSmoothScroll,
    xtermTheme,
    terminalCopyOnSelect,
    terminalRightClickPaste,
    inlineSmallTextFiles,
    inlineSmallTextThreshold,
    language,
    terminalExitNotification,
    codexNotification,
    agentDefault,
    agentCommands,
    agentPrompts,
    globalShell,
    shellProfiles,
    syncShellProfiles,
    windowsShellOptions,
    visibleWslDistros,
    availableFonts,
    loadAvailableFonts,
    setFontByName,
    syncFilePath,
    syncStatus,
    syncMessage,
    exportToSyncFile,
    importFromSyncFile,
  }
})

// Make the store HMR-friendly: without this, editing this file during `vite dev`
// hot-swaps the module but Pinia keeps the *old* store instance, so newly-added
// state (e.g. editorFontName) reads as undefined and writes go nowhere until a
// full reload. acceptHMRUpdate swaps the running store in place instead.
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSettingsStore, import.meta.hot))
}
