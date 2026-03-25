<script setup lang="ts">
import { useSettingsStore, COLOR_SCHEMES } from "../../stores/settings";
import { Sun, Moon } from "lucide-vue-next";

const settings = useSettingsStore();
settings.loadAvailableFonts();

function onFontSizeInput(e: Event) {
  const val = parseInt((e.target as HTMLInputElement).value, 10);
  if (val >= 8 && val <= 32) {
    settings.fontSize = val;
  }
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
];
</script>

<template>
  <div class="settings-tab">
    <div class="settings-scroll">
      <h2 class="settings-title">Settings</h2>

      <!-- Appearance -->
      <section class="settings-section">
        <h3 class="section-title">Appearance</h3>
        <div class="setting-row">
          <label class="setting-label">Mode</label>
          <div class="mode-toggle">
            <button
              class="mode-btn"
              :class="{ active: settings.darkMode }"
              @click="settings.darkMode = true"
              title="Dark Mode"
            >
              <Moon :size="16" :stroke-width="1.5" />
              <span>Dark</span>
            </button>
            <button
              class="mode-btn"
              :class="{ active: !settings.darkMode }"
              @click="settings.darkMode = false"
              title="Light Mode"
            >
              <Sun :size="16" :stroke-width="1.5" />
              <span>Light</span>
            </button>
          </div>
        </div>
      </section>

      <!-- Terminal -->
      <section class="settings-section">
        <h3 class="section-title">Terminal</h3>

        <div class="setting-row">
          <label class="setting-label">Font</label>
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
          <label class="setting-label">Font Size</label>
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
          <label class="setting-label">Preview</label>
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
          <label class="setting-label">Color Scheme</label>
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
      </section>

      <!-- Git -->
      <section class="settings-section">
        <h3 class="section-title">Git</h3>
        <div class="setting-row setting-row-block">
          <label class="setting-label">SSH Command</label>
          <input
            type="text"
            class="setting-input"
            :value="settings.sshCommand"
            @change="settings.sshCommand = ($event.target as HTMLInputElement).value.trim()"
            placeholder="e.g. C:/Windows/System32/OpenSSH/ssh.exe"
          />
          <span class="setting-hint">
            Git push/pull で使用する SSH コマンド。空欄の場合は git config の設定を使用します。
          </span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings-tab {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.settings-scroll {
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

.setting-input {
  width: 100%;
  padding: 6px 8px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 12px;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  box-sizing: border-box;
}

.setting-input:focus {
  outline: none;
  border-color: var(--accent);
}

.setting-hint {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.4;
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
</style>
