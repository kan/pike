import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { buildFontFamily, extractFontName } from '../lib/fontDetection'
import { fontListMonospace } from '../lib/tauri'

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

const STORAGE_KEY = 'hearth:settings'

interface PersistedSettings {
  fontFamily: string
  fontSize: number
  colorSchemeName: string
  darkMode: boolean
  sshCommand: string
}

function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...defaults(), ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return defaults()
}

function defaults(): PersistedSettings {
  return {
    fontFamily: "'PlemolJP Console NF', 'Cascadia Code', 'Fira Code', monospace",
    fontSize: 14,
    colorSchemeName: 'Default Dark',
    darkMode: true,
    sshCommand: '',
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const saved = loadSettings()

  const fontFamily = ref(saved.fontFamily)
  const fontSize = ref(saved.fontSize)
  const colorSchemeName = ref(saved.colorSchemeName)
  const darkMode = ref(saved.darkMode)
  const sshCommand = ref(saved.sshCommand)

  // Detected monospace fonts on this system (loaded on demand from Rust)
  const availableFonts = ref<string[]>([extractFontName(saved.fontFamily)])
  let fontsLoaded = false

  function loadAvailableFonts() {
    if (fontsLoaded) return
    fontsLoaded = true
    fontListMonospace().then((fonts) => {
      availableFonts.value = fonts
      const current = extractFontName(fontFamily.value)
      if (current !== 'monospace' && !fonts.includes(current)) {
        availableFonts.value = [current, ...fonts]
      }
    }).catch(() => { /* fallback: keep current font */ })
  }

  // Current font name extracted from fontFamily string
  const fontName = computed(() => extractFontName(fontFamily.value))

  function setFontByName(name: string) {
    fontFamily.value = buildFontFamily(name)
  }

  const colorScheme = computed(() =>
    COLOR_SCHEMES.find((s) => s.name === colorSchemeName.value) ?? COLOR_SCHEMES[0]
  )

  const xtermTheme = computed(() => {
    const { name, ...theme } = colorScheme.value
    return theme
  })

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      fontFamily: fontFamily.value,
      fontSize: fontSize.value,
      colorSchemeName: colorSchemeName.value,
      darkMode: darkMode.value,
      sshCommand: sshCommand.value,
    }))
  }

  function applyDarkMode() {
    document.documentElement.setAttribute('data-theme', darkMode.value ? 'dark' : 'light')
  }

  watch([fontFamily, fontSize, colorSchemeName, darkMode, sshCommand], persist)
  watch(darkMode, applyDarkMode, { immediate: true })

  return {
    fontFamily,
    fontName,
    fontSize,
    colorSchemeName,
    colorScheme,
    darkMode,
    sshCommand,
    xtermTheme,
    availableFonts,
    loadAvailableFonts,
    setFontByName,
  }
})
