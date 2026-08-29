<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useShortcutsModal } from '../composables/useShortcutsModal'
import { useI18n } from '../i18n'
import { isMacHost } from '../lib/host'
import { chordChips } from '../lib/keys'
import { chordsFor } from '../lib/shortcuts'

const { t } = useI18n()
const { visible } = useShortcutsModal()
const panelRef = ref<HTMLDivElement>()

watch(visible, (show) => {
  if (show) nextTick(() => panelRef.value?.focus())
})

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    visible.value = false
  }
}

interface ShortcutSection {
  title: string
  /** `keys` is a list of interchangeable chords; the row renders `/` between
   *  them and a `<kbd>` per part (see `chordChips` for how a chord splits). */
  items: { keys: string[]; label: string }[]
}

/**
 * 表記は `Mod+` で書く。**`Ctrl+` と直接書いてよいのは、mac でも Ctrl のままの
 * キーだけ**（`Ctrl+Tab` 等）。`chordChips` が mac では `⌘` に読み替える。
 *
 * **グローバル層のキーはリテラルで書かない。** `chordsFor(id)` で
 * `lib/shortcuts.ts` の表（`KEY_BINDINGS`）から引く。あちらが割り当ての正本で、
 * 実装・この一覧・macOS のメニューが同じ文字列を見る（#254）。リテラルのままだった
 * ころは、実装が全 OS で受ける `Mod+Shift+]` を一覧が mac だけに出していた。
 * 他の層（CodeMirror・xterm・画像ビューワ）はここに表を持たないのでリテラルのまま。
 */

const sections = computed<ShortcutSection[]>(() => [
  {
    title: t('shortcuts.general'),
    items: [
      { keys: chordsFor('quickOpen'), label: t('shortcuts.quickOpen') },
      { keys: chordsFor('projectSwitcher'), label: t('shortcuts.projectSwitcher') },
      { keys: ['Mod+Enter'], label: t('shortcuts.openInNewWindow') },
      { keys: chordsFor('shortcuts'), label: t('shortcuts.keyboardShortcuts') },
      { keys: chordsFor('settings'), label: t('shortcuts.settings') },
      { keys: chordsFor('manual'), label: t('shortcuts.manual') },
      { keys: ['Esc'], label: t('shortcuts.closeOverlay') },
    ],
  },
  {
    title: t('shortcuts.tabs'),
    items: [
      { keys: chordsFor('newFile'), label: t('shortcuts.newFile') },
      { keys: chordsFor('openDirectory'), label: t('shortcuts.openDirectory') },
      { keys: chordsFor('fontIncrease'), label: t('shortcuts.fontIncrease') },
      { keys: chordsFor('fontDecrease'), label: t('shortcuts.fontDecrease') },
      { keys: chordsFor('fontReset'), label: t('shortcuts.fontReset') },
      { keys: chordsFor('newTerminal'), label: t('shortcuts.newTerminal') },
      { keys: chordsFor('closeTab'), label: t('shortcuts.closeTab') },
      { keys: chordsFor('closeWindow'), label: t('shortcuts.closeWindow') },
      { keys: ['Mod+1'], label: t('shortcuts.selectTabN') },
      { keys: ['Mod+9'], label: t('shortcuts.selectLastTab') },
      // `Ctrl+Tab` 系は mac でも Ctrl のまま（Cmd+Tab は OS のアプリ切り替え）。
      // `keys` は「相互に置き換え可能な chord の並び」なので、同じ動作は 1 行に畳む。
      { keys: chordsFor('nextTab'), label: t('shortcuts.nextTab') },
      { keys: chordsFor('prevTab'), label: t('shortcuts.prevTab') },
    ],
  },
  {
    title: t('shortcuts.editor'),
    items: [
      { keys: ['Mod+S'], label: t('shortcuts.save') },
      { keys: ['Mod+Z'], label: t('shortcuts.undo') },
      { keys: ['Mod+Shift+Z', 'Mod+Y'], label: t('shortcuts.redo') },
      { keys: ['Mod+F'], label: t('shortcuts.find') },
      // mac の ⌘H は Hide Application なので、置換は ⌥⌘F（mac の慣習）。
      { keys: [isMacHost ? 'Mod+Alt+F' : 'Mod+H'], label: t('shortcuts.findReplace') },
      { keys: ['F3', 'Shift+F3'], label: t('shortcuts.findNextPrev') },
      { keys: ['Mod+D'], label: t('shortcuts.selectNextMatch') },
      { keys: ['Mod+/'], label: t('shortcuts.toggleComment') },
      { keys: ['Alt+↑', 'Alt+↓'], label: t('shortcuts.moveLine') },
      { keys: ['Tab', 'Shift+Tab'], label: t('shortcuts.indent') },
      { keys: ['Mod+Click'], label: t('shortcuts.jumpToDefinition') },
      { keys: ['F12'], label: t('shortcuts.jumpToDefinition') },
      { keys: chordsFor('gitHistory'), label: t('shortcuts.gitHistory') },
    ],
  },
  {
    title: t('shortcuts.markdown'),
    items: [
      { keys: ['Mod+B'], label: t('markdown.bold') },
      { keys: ['Mod+I'], label: t('markdown.italic') },
      { keys: ['Mod+K'], label: t('shortcuts.mdLink') },
      { keys: ['Enter'], label: t('shortcuts.mdListContinue') },
    ],
  },
  {
    title: t('shortcuts.terminal'),
    items: [
      { keys: [t('shortcuts.selectText')], label: t('shortcuts.selectCopy') },
      { keys: [t('shortcuts.rightClick')], label: t('shortcuts.rightClickPaste') },
      {
        keys: isMacHost ? ['Mod+V'] : ['Ctrl+V', 'Ctrl+Shift+V'],
        label: t('shortcuts.paste'),
      },
      {
        keys: [t('shortcuts.ctrlLetter')],
        // mac の Ctrl+英字はすべてシェルのもの。Windows / Linux はタブ操作の
        // キーだけ Pike が先に取る（`PIKE_FIRST_CTRL_KEYS`）。
        label: isMacHost ? t('shortcuts.shellFirstMac') : t('shortcuts.shellFirst'),
      },
    ],
  },
  {
    title: t('shortcuts.imagePreview'),
    items: [
      { keys: ['+', '-'], label: t('shortcuts.zoom') },
      { keys: ['0'], label: t('shortcuts.zoomReset') },
      { keys: ['f'], label: t('shortcuts.zoomFit') },
      { keys: ['r', 'Shift+R'], label: t('shortcuts.rotate') },
    ],
  },
])
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="shortcuts-overlay ui-zoom"
      @mousedown.self="visible = false"
      @keydown="onKeyDown"
    >
      <div ref="panelRef" class="shortcuts-panel popup-surface" tabindex="-1">
        <div class="shortcuts-header">
          <span class="shortcuts-title">{{ t('shortcuts.title') }}</span>
          <button class="close-btn" @click="visible = false">&times;</button>
        </div>
        <div class="shortcuts-body">
          <div v-for="section in sections" :key="section.title" class="shortcut-section">
            <h4 class="section-title">{{ section.title }}</h4>
            <div v-for="item in section.items" :key="item.keys.join('+')" class="shortcut-row">
              <span class="shortcut-label">{{ item.label }}</span>
              <span class="shortcut-keys">
                <template v-for="(chord, ci) in item.keys" :key="ci">
                  <span v-if="ci > 0" class="shortcut-or">/</span>
                  <kbd v-for="(part, i) in chordChips(chord)" :key="i">{{ part }}</kbd>
                </template>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.shortcuts-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  justify-content: center;
  padding-top: 60px;
}

.shortcuts-panel {
  width: 480px;
  max-height: 520px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  align-self: flex-start;
  outline: none;
}

.shortcuts-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.shortcuts-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-active);
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 18px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.close-btn:hover {
  color: var(--text-active);
}

.shortcuts-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 16px 16px;
}

.shortcut-section {
  margin-bottom: 12px;
}

.shortcut-section:last-child {
  margin-bottom: 0;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-secondary);
  margin: 0 0 6px;
  letter-spacing: 0.5px;
}

.shortcut-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
}

.shortcut-label {
  font-size: 13px;
  color: var(--text-primary);
}

.shortcut-keys {
  display: flex;
  align-items: center;
  gap: 3px;
}

/* Separates interchangeable chords, so the chips stay one-key-per-box. */
.shortcut-or {
  font-size: 11px;
  color: var(--text-secondary);
  padding: 0 1px;
}

kbd {
  display: inline-block;
  padding: 2px 6px;
  font-size: 11px;
  font-family: inherit;
  color: var(--text-primary);
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 3px;
  line-height: 1.4;
}
</style>
