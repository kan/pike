<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue'
import { useI18n } from '../../i18n'
import { projectIconValue, searchProjectIcons } from '../../lib/projectIcons'

const model = defineModel<string | undefined>()

const { t } = useI18n()
const open = ref(false)
const query = ref('')
const searchEl = ref<HTMLInputElement>()

const current = computed(() => projectIconValue(model.value))
const matches = computed(() => searchProjectIcons(query.value))

async function toggle() {
  if (open.value) {
    closeMenu()
    return
  }
  open.value = true
  query.value = ''
  // Same convention as ColorSelect: arm an outside-mousedown closer on open;
  // the component root stops inside mousedowns.
  setTimeout(() => window.addEventListener('mousedown', closeMenu, { once: true }))
  await nextTick()
  searchEl.value?.focus()
}

function closeMenu() {
  open.value = false
  window.removeEventListener('mousedown', closeMenu)
}

function choose(icon: string | undefined) {
  model.value = icon
  closeMenu()
}

/** Free text: anything the palette doesn't carry can still be pasted in. This
 *  is the only untrusted input here, so it is the only one validated on write —
 *  rendering validates too, for configs edited by hand. */
function chooseTyped() {
  const typed = projectIconValue(query.value)
  if (typed) choose(typed)
}

onUnmounted(() => window.removeEventListener('mousedown', closeMenu))
</script>

<template>
  <div class="icon-select" @mousedown.stop>
    <button type="button" class="icon-btn" @click="toggle">
      <span class="preview" :class="{ none: !current }">{{ current ?? '–' }}</span>
      <span class="icon-label">{{ current ? t('project.icon') : t('project.iconNone') }}</span>
    </button>
    <div v-if="open" class="dropdown popup-surface">
      <div class="search-row">
        <input
          ref="searchEl"
          v-model="query"
          class="search"
          :placeholder="t('project.iconSearch')"
          @keydown.enter.prevent="chooseTyped"
          @keydown.escape.prevent="closeMenu"
        />
        <button type="button" class="clear-btn" @click="choose(undefined)">{{ t('project.iconNone') }}</button>
      </div>
      <div class="grid">
        <button
          v-for="icon in matches"
          :key="icon.char"
          type="button"
          class="cell"
          :class="{ active: current === icon.char }"
          :title="icon.keywords.join(', ')"
          @click="choose(icon.char)"
        >
          {{ icon.char }}
        </button>
      </div>
      <div v-if="matches.length === 0" class="empty">{{ t('project.iconNoMatch') }}</div>
    </div>
  </div>
</template>

<style scoped>
.icon-select {
  position: relative;
}

.icon-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  border-radius: 3px;
  cursor: pointer;
  text-align: left;
}

.icon-btn:focus {
  border-color: var(--accent);
  outline: none;
}

.preview {
  width: 16px;
  text-align: center;
  flex-shrink: 0;
}

.preview.none {
  color: var(--text-secondary);
}

.icon-label {
  flex: 1;
}

.dropdown {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  z-index: 10;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 3px;
  box-shadow: 0 4px 12px var(--shadow-color);
}

.search-row {
  display: flex;
  gap: 4px;
  padding: 4px;
  border-bottom: 1px solid var(--border);
}

.search {
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  border-radius: 3px;
  outline: none;
}

.search:focus {
  border-color: var(--accent);
}

.clear-btn {
  padding: 3px 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
}

.clear-btn:hover {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(26px, 1fr));
  gap: 2px;
  padding: 4px;
  max-height: 180px;
  overflow-y: auto;
}

.cell {
  aspect-ratio: 1;
  border: none;
  background: transparent;
  font-size: 15px;
  line-height: 1;
  border-radius: 3px;
  cursor: pointer;
}

.cell:hover {
  background: var(--tab-hover-bg);
}

.cell.active {
  background: var(--bg-tertiary);
  outline: 1px solid var(--accent);
}

.empty {
  padding: 6px 8px;
  font-size: 11px;
  color: var(--text-secondary);
}
</style>
