<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { useI18n } from '../../i18n'
import { PROJECT_COLORS, projectColorValue } from '../../lib/projectColors'

const model = defineModel<string | undefined>()

const { t } = useI18n()
const open = ref(false)

const selected = computed(() => PROJECT_COLORS.find((c) => c.name === model.value))
// A hand-edited config may hold a raw hex instead of a preset name; keep it
// visible (swatch + raw text) so the form doesn't contradict the list/accent
const fallbackValue = computed(() => (model.value && !selected.value ? projectColorValue(model.value) : undefined))

function toggle() {
  if (open.value) {
    closeMenu()
  } else {
    open.value = true
    // Same convention as StatusBar/SideBar menus: arm an outside-mousedown
    // closer on open; the component root stops inside mousedowns
    setTimeout(() => window.addEventListener('mousedown', closeMenu, { once: true }))
  }
}

function closeMenu() {
  open.value = false
  window.removeEventListener('mousedown', closeMenu)
}

function choose(name: string | undefined) {
  model.value = name
  closeMenu()
}

onUnmounted(() => window.removeEventListener('mousedown', closeMenu))
</script>

<template>
  <div class="color-select" @mousedown.stop>
    <button type="button" class="color-btn" @click="toggle">
      <span v-if="selected" class="swatch" :style="{ background: selected.value }"></span>
      <span v-else-if="fallbackValue" class="swatch" :style="{ background: fallbackValue }"></span>
      <span class="color-label">{{
        selected ? t(`projectColor.${selected.name}`) : (fallbackValue ? model : t('projectColor.none'))
      }}</span>
    </button>
    <div v-if="open" class="dropdown">
      <button type="button" class="item" :class="{ active: !model }" @click="choose(undefined)">
        <span class="swatch none"></span>{{ t('projectColor.none') }}
      </button>
      <button
        v-for="c in PROJECT_COLORS"
        :key="c.name"
        type="button"
        class="item"
        :class="{ active: model === c.name }"
        @click="choose(c.name)"
      >
        <span class="swatch" :style="{ background: c.value }"></span>{{ t(`projectColor.${c.name}`) }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.color-select {
  position: relative;
}

.color-btn {
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

.color-btn:focus {
  border-color: var(--accent);
  outline: none;
}

.color-label {
  flex: 1;
}

.swatch {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
}

.swatch.none {
  border: 1px dashed var(--text-secondary);
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
  max-height: 200px;
  overflow-y: auto;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.item:hover {
  background: var(--tab-hover-bg);
}

.item.active {
  background: var(--bg-tertiary);
}
</style>
