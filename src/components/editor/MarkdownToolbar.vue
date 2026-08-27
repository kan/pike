<script setup lang="ts">
/**
 * Markdown input assist (#241): the buttons that write Markdown syntax for you.
 *
 * It sits in the Edit / Split / Preview row rather than in a row of its own, so
 * the editor keeps its height. The component owns no editor state — it emits a
 * `ToolbarAction` and `EditorTab` runs it against the view, which is the same
 * path the keyboard shortcuts take.
 *
 * Buttons and menus are tables, not markup: adding one is a line in an array
 * rather than a copied block with four attributes to remember.
 */
import {
  Bold,
  ChevronDown,
  Code,
  Heading,
  Image as ImageIcon,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  SquarePlus,
  Strikethrough,
  TextQuote,
} from 'lucide-vue-next'
import type { Component } from 'vue'
import { computed, nextTick, onUnmounted, ref, useTemplateRef } from 'vue'
import { useI18n } from '../../i18n'
import type { TableSpec, ToolbarAction } from '../../lib/editorMarkdown'
import { chordLabel } from '../../lib/keys'

const emit = defineEmits<{ run: [action: ToolbarAction] }>()

const { t } = useI18n()

interface Button {
  icon: Component
  /** i18n key, also the `v-for` key — every label here is distinct. */
  label: string
  /** Shortcut shown in the tooltip. */
  hint?: string
  action: ToolbarAction
}

interface MenuItem {
  label: string
  /** Insert straight away… */
  action?: ToolbarAction
  /** …or hand the menu over to a form that asks for the shape first. */
  picker?: 'table'
  /** Class for the item's own label, used to preview the heading sizes. */
  cls?: string
}

/** One stretch of the row: a dropdown, or a run of buttons. Rendered in order,
 *  with a rule drawn before each. */
type Segment = { menu: 'heading' | 'block'; icon: Component; label: string; items: MenuItem[] } | { buttons: Button[] }

const INLINE: Button[] = [
  { icon: Bold, label: 'markdown.bold', hint: 'Mod+B', action: { kind: 'inline', mark: '**' } },
  { icon: Italic, label: 'markdown.italic', hint: 'Mod+I', action: { kind: 'inline', mark: '*' } },
  { icon: Strikethrough, label: 'markdown.strikethrough', action: { kind: 'inline', mark: '~~' } },
  { icon: Code, label: 'markdown.code', action: { kind: 'inline', mark: '`' } },
]

const LISTS: Button[] = [
  { icon: List, label: 'markdown.bulletList', action: { kind: 'line', marker: 'bullet' } },
  { icon: ListOrdered, label: 'markdown.orderedList', action: { kind: 'line', marker: 'ordered' } },
  { icon: ListChecks, label: 'markdown.taskList', action: { kind: 'line', marker: 'task' } },
  { icon: TextQuote, label: 'markdown.quote', action: { kind: 'line', marker: 'quote' } },
]

// Menu labels are built here rather than in the template, so they follow the UI
// language like every other label does.
const segments = computed<Segment[]>(() => [
  {
    menu: 'heading',
    icon: Heading,
    label: 'markdown.heading',
    items: [
      ...[1, 2, 3, 4, 5, 6].map((level) => ({
        label: t('markdown.headingLevel', { n: level }),
        cls: `h${level}`,
        action: { kind: 'heading', level } as ToolbarAction,
      })),
      { label: t('markdown.headingNone'), action: { kind: 'heading', level: 0 } },
    ],
  },
  { buttons: INLINE },
  {
    buttons: [
      { icon: Link, label: 'markdown.link', hint: 'Mod+K', action: { kind: 'link' } },
      // EditorTab answers this one: the path depends on where the file lives.
      { icon: ImageIcon, label: 'markdown.image', action: { kind: 'pickImage' } },
    ],
  },
  { buttons: LISTS },
  {
    menu: 'block',
    icon: SquarePlus,
    label: 'markdown.blocks',
    items: [
      { label: t('markdown.codeBlock'), action: { kind: 'block', block: 'code' } },
      { label: t('markdown.table'), picker: 'table' },
      { label: t('markdown.hr'), action: { kind: 'block', block: 'hr' } },
      { label: t('markdown.details'), action: { kind: 'block', block: 'details' } },
      { label: t('markdown.footnote'), action: { kind: 'footnote' } },
    ],
  },
])

const openMenu = ref<'heading' | 'block' | null>(null)
/** Set while the block menu is showing the table form instead of its items. */
const picker = ref<'table' | null>(null)

const TABLE_MAX = 20
const table = ref<TableSpec>({ rows: 2, cols: 3 })
// A `ref` anywhere inside a `v-for` scope is collected into an array — the
// compiler flags the whole block, not just the repeated element.
const rowsInput = useTemplateRef<HTMLInputElement | HTMLInputElement[]>('rowsInput')

/** Typed-in sizes reach here unclamped (and `NaN` when the field is empty). */
function clampSize(n: number): number {
  return Math.min(TABLE_MAX, Math.max(1, Math.round(n) || 1))
}

async function openPicker(kind: 'table') {
  picker.value = kind
  await nextTick()
  const el = rowsInput.value
  const input = Array.isArray(el) ? el[0] : el
  input?.focus()
  input?.select()
}

function insertTable() {
  const spec = { ...table.value, rows: clampSize(table.value.rows), cols: clampSize(table.value.cols) }
  table.value = spec
  run({ kind: 'table', spec })
}

/** Title text with the shortcut appended, the way the rest of the UI writes them. */
function title(label: string, hint?: string): string {
  return hint ? `${t(label)} (${chordLabel(hint)})` : t(label)
}

// Same convention as the other menus: arm an outside-mousedown closer on open,
// and stop inside mousedowns at the component root.
function toggleMenu(menu: 'heading' | 'block') {
  if (openMenu.value === menu) {
    closeMenu()
    return
  }
  openMenu.value = menu
  setTimeout(() => window.addEventListener('mousedown', closeMenu, { once: true }))
}

function closeMenu() {
  openMenu.value = null
  picker.value = null
  window.removeEventListener('mousedown', closeMenu)
}

function run(action: ToolbarAction) {
  closeMenu()
  emit('run', action)
}

onUnmounted(() => window.removeEventListener('mousedown', closeMenu))
</script>

<template>
  <div class="md-toolbar" @mousedown.stop>
    <template v-for="(seg, i) in segments" :key="i">
      <span class="md-sep" />
      <div v-if="'menu' in seg" class="md-menu-wrap">
        <button
          class="md-btn"
          :class="{ active: openMenu === seg.menu }"
          :title="t(seg.label)"
          @mousedown.prevent
          @click="toggleMenu(seg.menu)"
        >
          <component :is="seg.icon" :size="14" :stroke-width="2" />
          <ChevronDown :size="10" :stroke-width="2" />
        </button>
        <div v-if="openMenu === seg.menu" class="md-menu popup-surface">
          <!-- The table asks for its shape first; everything else goes straight in. -->
          <form v-if="picker === 'table'" class="md-form" @submit.prevent="insertTable">
            <label class="md-field">
              <span>{{ t('markdown.tableRows') }}</span>
              <input ref="rowsInput" v-model.number="table.rows" type="number" min="1" :max="TABLE_MAX" />
            </label>
            <label class="md-field">
              <span>{{ t('markdown.tableCols') }}</span>
              <input v-model.number="table.cols" type="number" min="1" :max="TABLE_MAX" />
            </label>
            <button type="submit" class="md-submit">{{ t('markdown.insert') }}</button>
          </form>
          <template v-else>
            <button
              v-for="item in seg.items"
              :key="item.label"
              class="md-menu-item"
              @mousedown.prevent
              @click="item.picker ? openPicker(item.picker) : item.action && run(item.action)"
            >
              <span :class="item.cls">{{ item.label }}</span>
            </button>
          </template>
        </div>
      </div>
      <template v-else>
        <button
          v-for="b in seg.buttons"
          :key="b.label"
          class="md-btn"
          :title="title(b.label, b.hint)"
          @mousedown.prevent
          @click="run(b.action)"
        >
          <component :is="b.icon" :size="14" :stroke-width="2" />
        </button>
      </template>
    </template>
  </div>
</template>

<style scoped>
.md-toolbar {
  display: flex;
  align-items: center;
  gap: 1px;
  /* No clipping here: the menus hang below the row, and any overflow value
     other than `visible` would cut them off at the toolbar's edge. In a narrow
     pane the buttons wrap onto a second line instead, which keeps the help
     button on the row — `.editor-tab` clips, so anything pushed past the right
     edge would be unreachable. */
  min-width: 0;
  flex-wrap: wrap;
}

.md-btn {
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 3px 5px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  flex-shrink: 0;
}

.md-btn:hover,
.md-btn.active {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}

.md-sep {
  width: 1px;
  height: 14px;
  margin: 0 4px;
  background: var(--border);
  flex-shrink: 0;
}

.md-menu-wrap {
  position: relative;
  display: flex;
}

.md-menu {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 2px;
  min-width: 140px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-secondary);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.md-menu-item {
  text-align: left;
  padding: 4px 8px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  border-radius: 3px;
  white-space: nowrap;
}

.md-menu-item:hover {
  background: var(--tab-hover-bg);
}

.md-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px;
  font-size: 12px;
  color: var(--text-primary);
}

.md-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.md-field input {
  width: 56px;
  padding: 2px 4px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
}

.md-submit {
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--accent);
  color: var(--text-active);
  font-size: 12px;
  cursor: pointer;
}

.md-submit:hover {
  filter: brightness(1.1);
}

/* Preview the heading sizes in the menu, so the levels read at a glance. */
.h1 { font-size: 16px; font-weight: 700; }
.h2 { font-size: 15px; font-weight: 700; }
.h3 { font-size: 14px; font-weight: 600; }
.h4 { font-size: 13px; font-weight: 600; }
.h5 { font-size: 12px; font-weight: 600; }
.h6 { font-size: 12px; font-weight: 500; }
</style>
