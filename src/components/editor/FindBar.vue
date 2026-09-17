<script setup lang="ts">
/**
 * タブの右上に浮く検索バー（#176 の diff タブ、#360 のプレビュー、ターミナル）。
 *
 * **持つのは見た目と入力の作法だけ**（Enter / Shift+Enter で移動、Escape で閉じる）。何を
 * 数えてどこへ動かすかは置いた側が決める: diff は行と欄の表を、プレビューは描画済みの DOM を
 * 相手にするので、一致の求め方が共有できない。エディタの検索パネル（`lib/editorSearch.ts`）は
 * CodeMirror の panel として DOM を組むので、これとは別物のまま。
 */
import { CaseSensitive, ChevronDown, ChevronUp, X } from 'lucide-vue-next'
import { computed, onMounted, useTemplateRef } from 'vue'
import { useI18n } from '../../i18n'
import { matchChord } from '../../lib/keys'

const props = defineProps<{
  /** 現在の一致（0 始まり）。分からなければ -1。 */
  current: number
  total: number
  /** 上限で数えるのをやめたか（件数に `+` を付ける）。 */
  truncated?: boolean
}>()
const query = defineModel<string>('query', { required: true })
const caseSensitive = defineModel<boolean>('caseSensitive', { required: true })
const emit = defineEmits<{ step: [delta: number]; close: [] }>()

const { t } = useI18n()
const input = useTemplateRef<HTMLInputElement>('input')

const info = computed(() => {
  if (!query.value) return ''
  if (props.total === 0) return t('search.noResults')
  const count = `${props.total}${props.truncated ? '+' : ''}`
  // 位置が分からない（ターミナルの検索は上限を超えると現在位置を返さない）。
  return props.current < 0 ? count : `${props.current + 1} / ${count}`
})

function onKeydown(e: KeyboardEvent) {
  // 入力欄の中で押し直したら選び直すだけ。止めないと WebView のページ内検索に届きうる。
  if (matchChord(e, 'Mod+F')) {
    e.preventDefault()
    focus()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    emit('step', e.shiftKey ? -1 : 1)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

/** 開いたまま `Ctrl+F` をもう一度押したときに呼ぶ（開いた直後は `onMounted` が済ませる）。 */
function focus() {
  input.value?.focus()
  input.value?.select()
}

onMounted(focus)

defineExpose({ focus })
</script>

<template>
  <div class="find-bar popup-surface">
    <input
      ref="input"
      v-model="query"
      class="find-field"
      type="text"
      spellcheck="false"
      :placeholder="t('search.placeholder')"
      @keydown="onKeydown"
    />
    <button
      class="find-btn"
      :class="{ active: caseSensitive }"
      :title="t('search.matchCase')"
      @click="caseSensitive = !caseSensitive"
    >
      <CaseSensitive :size="14" :stroke-width="2" />
    </button>
    <span class="find-info">{{ info }}</span>
    <button class="find-btn" :title="t('search.prevMatch')" @click="emit('step', -1)"><ChevronUp :size="14" :stroke-width="2" /></button>
    <button class="find-btn" :title="t('search.nextMatch')" @click="emit('step', 1)"><ChevronDown :size="14" :stroke-width="2" /></button>
    <button class="find-btn" :title="t('search.close')" @click="emit('close')"><X :size="14" :stroke-width="2" /></button>
  </div>
</template>

<style scoped>
.find-bar {
  position: absolute;
  top: 8px;
  right: 16px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.find-field {
  width: 180px;
  padding: 3px 6px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
}

.find-field:focus {
  border-color: var(--accent);
}

.find-info {
  min-width: 56px;
  padding: 0 4px;
  color: var(--text-secondary);
  font-size: 11px;
  text-align: center;
  white-space: nowrap;
}

.find-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
}

.find-btn:hover {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}

.find-btn.active {
  background: var(--accent);
  color: #fff;
}
</style>
