<script setup lang="ts">
import { Info, Loader, Moon, Sun } from 'lucide-vue-next'
import { ref } from 'vue'
import { fsWatcher } from '../../composables/useFsWatcher'
import { useUpdater } from '../../composables/useUpdater'
import { useI18n } from '../../i18n'
import { EDITOR_THEMES } from '../../lib/editorThemes'
import { COLOR_SCHEMES, useSettingsStore } from '../../stores/settings'

const { t } = useI18n()
const settings = useSettingsStore()
settings.loadAvailableFonts()

const updater = useUpdater()

function onFontSizeInput(e: Event) {
  const val = parseInt((e.target as HTMLInputElement).value, 10)
  if (val >= 8 && val <= 32) {
    settings.fontSize = val
  }
}

// Section navigation
const sections = [
  { id: 'appearance', i18nKey: 'settings.appearance' },
  { id: 'terminal', i18nKey: 'settings.terminal' },
  { id: 'editor', i18nKey: 'settings.editor' },
  { id: 'agent', i18nKey: 'settings.agent' },
  { id: 'about', i18nKey: 'settings.about' },
]
const activeSection = ref('appearance')

function scrollToSection(id: string) {
  activeSection.value = id
  const el = document.getElementById(`settings-${id}`)
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function onSettingsScroll(e: Event) {
  const container = e.target as HTMLElement
  const scrollTop = container.scrollTop + 40
  for (let i = sections.length - 1; i >= 0; i--) {
    const el = document.getElementById(`settings-${sections[i].id}`)
    if (el && el.offsetTop <= scrollTop) {
      activeSection.value = sections[i].id
      return
    }
  }
  activeSection.value = sections[0].id
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
  <div class="settings-tab">
    <nav class="settings-nav">
      <button
        v-for="sec in sections"
        :key="sec.id"
        class="nav-item"
        :class="{ active: activeSection === sec.id }"
        @click="scrollToSection(sec.id)"
      >{{ t(sec.i18nKey) }}</button>
    </nav>
    <div class="settings-scroll" @scroll="onSettingsScroll">
      <h2 class="settings-title">{{ t('settings.title') }}</h2>

      <div v-if="fsWatcher.startError.value" class="inotify-banner">
        <Info :size="16" :stroke-width="1.5" />
        <div>
          <span>{{ t('settings.inotifyMissing') }}</span>
          <code>sudo apt install inotify-tools</code>
        </div>
      </div>

      <!-- Appearance -->
      <section id="settings-appearance" class="settings-section">
        <h3 class="section-title">{{ t('settings.appearance') }}</h3>
        <div class="setting-row">
          <label class="setting-label">{{ t('settings.language') }}</label>
          <select class="setting-select" :value="settings.language" @change="settings.language = ($event.target as HTMLSelectElement).value">
            <option value="en">English</option>
            <option value="ja">日本語</option>
          </select>
        </div>
        <div class="setting-row">
          <label class="setting-label">{{ t('settings.mode') }}</label>
          <div class="mode-toggle">
            <button
              class="mode-btn"
              :class="{ active: settings.darkMode }"
              @click="settings.darkMode = true"
              :title="t('settings.darkMode')"
            >
              <Moon :size="16" :stroke-width="1.5" />
              <span>{{ t('settings.darkMode') }}</span>
            </button>
            <button
              class="mode-btn"
              :class="{ active: !settings.darkMode }"
              @click="settings.darkMode = false"
              :title="t('settings.lightMode')"
            >
              <Sun :size="16" :stroke-width="1.5" />
              <span>{{ t('settings.lightMode') }}</span>
            </button>
          </div>
        </div>
      </section>

      <!-- Terminal -->
      <section id="settings-terminal" class="settings-section">
        <h3 class="section-title">{{ t('settings.terminal') }}</h3>

        <div class="setting-row">
          <label class="setting-label">{{ t('settings.font') }}</label>
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
        </div>

        <div class="setting-row">
          <label class="setting-label">{{ t('settings.fontSize') }}</label>
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
        </div>

        <!-- Preview -->
        <div class="setting-row setting-row-block">
          <label class="setting-label">{{ t('settings.preview') }}</label>
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
        </div>

        <div class="setting-row setting-row-block">
          <label class="setting-label">{{ t('settings.colorScheme') }}</label>
          <div class="scheme-grid">
            <button
              v-for="scheme in COLOR_SCHEMES"
              :key="scheme.name"
              class="scheme-card"
              :class="{ active: settings.colorSchemeName === scheme.name }"
              @click="settings.colorSchemeName = scheme.name"
            >
              <div class="scheme-preview" :style="{ background: scheme.background }">
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
        </div>

        <div class="setting-row">
          <label class="setting-label">{{ t('settings.copyOnSelect') }}</label>
          <div class="mode-toggle">
            <button class="mode-btn" :class="{ active: settings.terminalCopyOnSelect }" @click="settings.terminalCopyOnSelect = true">{{ t('common.on') }}</button>
            <button class="mode-btn" :class="{ active: !settings.terminalCopyOnSelect }" @click="settings.terminalCopyOnSelect = false">{{ t('common.off') }}</button>
          </div>
        </div>

        <div class="setting-row">
          <label class="setting-label">{{ t('settings.rightClickPaste') }}</label>
          <div class="mode-toggle">
            <button class="mode-btn" :class="{ active: settings.terminalRightClickPaste }" @click="settings.terminalRightClickPaste = true">{{ t('common.on') }}</button>
            <button class="mode-btn" :class="{ active: !settings.terminalRightClickPaste }" @click="settings.terminalRightClickPaste = false">{{ t('common.off') }}</button>
          </div>
        </div>

        <div class="setting-row">
          <label class="setting-label">{{ t('settings.terminalExitNotification') }}</label>
          <div class="mode-toggle">
            <button class="mode-btn" :class="{ active: settings.terminalExitNotification }" @click="settings.terminalExitNotification = true">{{ t('common.on') }}</button>
            <button class="mode-btn" :class="{ active: !settings.terminalExitNotification }" @click="settings.terminalExitNotification = false">{{ t('common.off') }}</button>
          </div>
        </div>
      </section>

      <!-- Editor -->
      <section id="settings-editor" class="settings-section">
        <h3 class="section-title">{{ t('settings.editor') }}</h3>

        <div class="setting-row setting-row-block">
          <label class="setting-label">{{ t('settings.editorTheme') }}</label>
          <div class="scheme-grid">
            <button
              v-for="theme in EDITOR_THEMES"
              :key="theme.name"
              class="scheme-card"
              :class="{ active: settings.editorThemeName === theme.name }"
              @click="settings.editorThemeName = theme.name"
            >
              <div class="scheme-preview" :style="{ background: theme.background, color: theme.foreground }">
                <span>fn</span>
                <span :style="{ color: theme.accent }">main</span>
                <span>()</span>
              </div>
              <span class="scheme-name">{{ theme.name }}</span>
            </button>
          </div>
        </div>

        <div class="setting-row">
          <label class="setting-label">{{ t('settings.minimap') }}</label>
          <div class="mode-toggle">
            <button class="mode-btn" :class="{ active: settings.editorMinimap }" @click="settings.editorMinimap = true">{{ t('common.on') }}</button>
            <button class="mode-btn" :class="{ active: !settings.editorMinimap }" @click="settings.editorMinimap = false">{{ t('common.off') }}</button>
          </div>
        </div>

        <div class="setting-row">
          <label class="setting-label">{{ t('settings.wordWrap') }}</label>
          <div class="mode-toggle">
            <button class="mode-btn" :class="{ active: settings.editorWordWrap }" @click="settings.editorWordWrap = true">{{ t('common.on') }}</button>
            <button class="mode-btn" :class="{ active: !settings.editorWordWrap }" @click="settings.editorWordWrap = false">{{ t('common.off') }}</button>
          </div>
        </div>

        <div class="setting-row">
          <label class="setting-label">{{ t('settings.tabSize') }}</label>
          <select
            class="setting-select setting-select-narrow"
            :value="settings.editorTabSize"
            @change="settings.editorTabSize = parseInt(($event.target as HTMLSelectElement).value)"
          >
            <option :value="2">2</option>
            <option :value="4">4</option>
            <option :value="8">8</option>
          </select>
        </div>
      </section>

      <!-- Agent -->
      <section id="settings-agent" class="settings-section">
        <h3 class="section-title">{{ t('settings.agent') }}</h3>

        <div class="setting-row">
          <label class="setting-label">{{ t('settings.agentDefault') }}</label>
          <select
            class="setting-select"
            :value="settings.agentDefault"
            @change="settings.agentDefault = ($event.target as HTMLSelectElement).value as any"
          >
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="ask">{{ t('settings.agentAskEachTime') }}</option>
          </select>
        </div>

        <div class="setting-row">
          <label class="setting-label">{{ t('settings.codexNotification') }}</label>
          <div class="mode-toggle">
            <button class="mode-btn" :class="{ active: settings.codexNotification }" @click="settings.codexNotification = true">{{ t('common.on') }}</button>
            <button class="mode-btn" :class="{ active: !settings.codexNotification }" @click="settings.codexNotification = false">{{ t('common.off') }}</button>
          </div>
        </div>
      </section>

      <!-- About / Update -->
      <section id="settings-about" class="settings-section">
        <h3 class="section-title">{{ t('settings.about') }}</h3>
        <div class="setting-row">
          <label class="setting-label">{{ t('settings.version') }}</label>
          <span class="version-value">{{ updater.appVersion.value }}</span>
        </div>
        <div class="setting-row">
          <label class="setting-label">{{ t('settings.checkUpdate') }}</label>
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
        </div>
      </section>
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
  max-width: 680px;
}

.settings-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-active);
  margin: 0 0 24px 0;
}

.settings-section {
  margin-bottom: 28px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
  margin: 0 0 12px 0;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
}

.setting-row-block {
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

.setting-label {
  font-size: 13px;
  color: var(--text-primary);
}

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

.mode-toggle {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
}

.mode-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 14px;
  border: none;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.mode-btn:first-child {
  border-right: 1px solid var(--border);
}

.mode-btn.active {
  background: var(--accent);
  color: var(--text-active);
}

.mode-btn:not(.active):hover {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}

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
</style>
