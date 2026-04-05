<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useConfirmDialog } from '../composables/useConfirmDialog'
import { useI18n } from '../i18n'

const { t } = useI18n()
const { visible, message, mode, inputValue, inputPlaceholder, respond } = useConfirmDialog()
const okBtn = ref<HTMLButtonElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)

watch(visible, (val) => {
  if (val) nextTick(() => (mode.value === 'prompt' ? inputEl : okBtn).value?.focus())
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') respond(true)
  if (e.key === 'Escape') respond(false)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="overlay" @click.self="respond(mode === 'info' ? true : false)" @keydown="onKeydown">
      <div class="dialog">
        <p class="dialog-message">{{ message }}</p>
        <input
          v-if="mode === 'prompt'"
          ref="inputEl"
          v-model="inputValue"
          class="dialog-input"
          :placeholder="inputPlaceholder"
          @keydown.enter.stop="respond(true)"
        />
        <div class="dialog-actions">
          <button v-if="mode !== 'info'" class="btn btn-cancel" @click="respond(false)">{{ t('common.cancel') }}</button>
          <button ref="okBtn" class="btn btn-ok" @click="respond(true)">{{ t('common.ok') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.dialog {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 20px 24px;
  min-width: 320px;
  max-width: 480px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.dialog-message {
  margin: 0 0 16px 0;
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}

.dialog-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  margin-bottom: 12px;
  background: var(--bg-primary);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
}

.dialog-input:focus {
  border-color: var(--accent);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.btn {
  padding: 5px 16px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.btn:hover {
  background: var(--tab-hover-bg);
}

.btn:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}

.btn-ok {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.btn-ok:hover {
  filter: brightness(1.15);
  background: var(--accent);
}
</style>
