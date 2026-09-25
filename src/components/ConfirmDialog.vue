<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useConfirmDialog } from '../composables/useConfirmDialog'
import { useI18n } from '../i18n'
import { useOverlay } from '../lib/overlay'

const { t } = useI18n()
const {
  visible,
  message,
  mode,
  inputValue,
  inputPlaceholder,
  inputMasked,
  optionLabel,
  optionChecked,
  choices,
  respond,
  choose,
} = useConfirmDialog()
// 手前に浮くものは数える（#396。ブラウザのタブの子 webview を隠すため）。
useOverlay(() => visible.value)
const okBtn = ref<HTMLButtonElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)

watch(visible, (val) => {
  if (val) nextTick(() => (mode.value === 'prompt' ? inputEl : okBtn).value?.focus())
})

function onKeydown(e: KeyboardEvent) {
  // 選択肢のときの Enter は、フォーカスのあるボタン自身に任せる（Tab で移った先を選ぶ）。
  // ここで primary を選ぶと、別のボタンにいても primary になる。
  if (e.key === 'Enter' && mode.value !== 'choice') respond(true)
  if (e.key === 'Escape') respond(false)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="overlay ui-zoom" @click.self="respond(mode === 'info' ? true : false)" @keydown="onKeydown">
      <div class="dialog popup-surface">
        <p class="dialog-message">{{ message }}</p>
        <input
          v-if="mode === 'prompt'"
          ref="inputEl"
          v-model="inputValue"
          class="dialog-input"
          :type="inputMasked ? 'password' : 'text'"
          :placeholder="inputPlaceholder"
          @keydown.enter.stop="respond(true)"
        />
        <label v-if="optionLabel" class="dialog-option">
          <input v-model="optionChecked" type="checkbox" />
          <span>{{ optionLabel }}</span>
        </label>
        <!-- 3 択以上（#408）。primary に最初のフォーカスが入る（Enter と同じもの）。 -->
        <div v-if="mode === 'choice'" class="dialog-actions">
          <button
            v-for="c in choices"
            :key="c.value"
            :ref="(el) => { if (c.primary) okBtn = el as HTMLButtonElement | null }"
            class="btn"
            :class="c.primary ? 'btn-ok' : 'btn-cancel'"
            @click="choose(c.value)"
          >{{ c.label }}</button>
        </div>
        <div v-else class="dialog-actions">
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
  /* メッセージ側が段落を分けていることがある（URL 取得の同意は、後半が「断る理由」
     そのもの）。HTML は改行を潰すので、ここで残す。空白は従来どおり畳まれる。 */
  white-space: pre-line;
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

/* 添えるチェックボックス（#286）。ボタンより先に読ませたいので本文とボタンのあいだ。 */
.dialog-option {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 16px 0;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
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
  color: var(--on-accent);
}

.btn-ok:hover {
  filter: brightness(1.15);
  background: var(--accent);
}
</style>
