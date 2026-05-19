<script setup lang="ts">
import { X } from 'lucide-vue-next'
import { nextTick, ref } from 'vue'
import { useI18n } from '../../i18n'

const NEW_GROUP_TOKEN = '__new__'

defineProps<{
  modelValue: string | undefined
  groups: readonly string[]
}>()
const emit = defineEmits<{
  'update:modelValue': [value: string | undefined]
}>()

const { t } = useI18n()

const mode = ref<'select' | 'new'>('select')
const newValue = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

async function onSelectChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value
  if (v === NEW_GROUP_TOKEN) {
    mode.value = 'new'
    newValue.value = ''
    emit('update:modelValue', undefined)
    await nextTick()
    inputRef.value?.focus()
  } else {
    emit('update:modelValue', v || undefined)
  }
}

function onNewInput(e: Event) {
  const v = (e.target as HTMLInputElement).value
  newValue.value = v
  emit('update:modelValue', v.trim() || undefined)
}

function backToSelect() {
  mode.value = 'select'
  newValue.value = ''
  emit('update:modelValue', undefined)
}
</script>

<template>
  <div class="group-combo">
    <select v-if="mode === 'select'" :value="modelValue ?? ''" @change="onSelectChange">
      <option value="">{{ t('project.groupSelectNone') }}</option>
      <option v-for="g in groups" :key="g" :value="g">{{ g }}</option>
      <option :value="NEW_GROUP_TOKEN">{{ t('project.groupSelectNew') }}</option>
    </select>
    <div v-else class="combo-new">
      <input
        ref="inputRef"
        :value="newValue"
        :placeholder="t('project.groupNewPlaceholder')"
        @input="onNewInput"
      />
      <button type="button" class="combo-cancel" @click="backToSelect">
        <X :size="12" :stroke-width="2" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.group-combo {
  display: flex;
}

.group-combo select,
.combo-new input {
  padding: 4px 8px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  border-radius: 3px;
  outline: none;
}

.group-combo select {
  flex: 1;
}

.group-combo select:focus,
.combo-new input:focus {
  border-color: var(--accent);
}

.combo-new {
  display: flex;
  gap: 4px;
  flex: 1;
}

.combo-new input {
  flex: 1;
  min-width: 0;
}

.combo-cancel {
  width: 24px;
  padding: 0;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.combo-cancel:hover {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}
</style>
