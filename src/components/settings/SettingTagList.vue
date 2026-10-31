<script setup lang="ts">
/**
 * 設定画面の「文字列を 1 つずつ並べる」欄（#531）。並んだタグを × で外し、入力欄の Enter で
 * 足す。空の欄で Backspace を押すと最後のタグを外す。
 *
 * **足すのは Enter だけ**（欄から離れたときには足さない）。打ちかけの文字が、別のウィンドウへ
 * 移っただけで設定に入り、ほかのマシンへ同期されるのを避ける。**変換中の Enter は無視する**
 * （日本語入力の確定で、変換前の読みがタグになる）。**押し続けた Backspace では外さない**
 * （文字を消し終えたあとの連打で、全部のタグが消える）。
 *
 * **区切り文字で分けない。** 値に何を許すか（空白・カンマ）は使う側の都合で、ラベル名のように
 * カンマを含みうるものもある。1 回の入力が 1 つの値になる。
 *
 * **検証は呼び出し側の `normalize` が持つ**（空白の除去・重複の判定など）。ここは足す・外すの
 * 操作だけで、足したあとの一覧を `normalize` に通して返す。結果が変わらなければ何も書かない
 * （配列を差し替えると、設定の保存と他のウィンドウへの配信が走る）。
 */
import { X } from 'lucide-vue-next'
import { ref } from 'vue'
import { useI18n } from '../../i18n'

const props = defineProps<{
  modelValue: string[]
  /** 足したあとの一覧を整える（検証・重複の除去）。 */
  normalize: (list: string[]) => string[]
  placeholderKey: string
  testid?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [string[]] }>()

const { t } = useI18n()
const draft = ref('')

/** 整えた結果が今と違えば書く。書いたかを返す。 */
function commit(next: string[]): boolean {
  const normalized = props.normalize(next)
  if (normalized.join('\n') === props.modelValue.join('\n')) return false
  emit('update:modelValue', normalized)
  return true
}

function onEnter(e: KeyboardEvent) {
  if (e.isComposing) return
  const value = draft.value.trim()
  if (!value) return
  // 足せなかった（重複など）ときは欄を残す。消すと、足されたのか弾かれたのか分からない
  if (commit([...props.modelValue, value])) draft.value = ''
}

function remove(index: number) {
  commit(props.modelValue.filter((_, i) => i !== index))
}

function onBackspace(e: KeyboardEvent) {
  if (e.repeat || e.isComposing) return
  if (draft.value === '' && props.modelValue.length > 0) remove(props.modelValue.length - 1)
}
</script>

<template>
  <div class="tag-list" :data-testid="testid">
    <span v-for="(tag, i) in modelValue" :key="tag" class="tag">
      <span class="tag-name selectable">{{ tag }}</span>
      <button class="tag-remove" :title="t('settings.tagRemove', { name: tag })" @click="remove(i)">
        <X :size="12" :stroke-width="2" />
      </button>
    </span>
    <input
      v-model="draft"
      class="tag-input"
      type="text"
      spellcheck="false"
      :placeholder="t(placeholderKey)"
      @keydown.enter.prevent="onEnter"
      @keydown.backspace="onBackspace"
    />
  </div>
</template>

<style scoped>
.tag-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-primary);
}

.tag-list:focus-within {
  border-color: var(--accent);
}

.tag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 2px 1px 8px;
  border-radius: 10px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: 12px;
}

.tag-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.tag-remove:hover {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}

.tag-input {
  flex: 1;
  min-width: 120px;
  padding: 2px 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
}
</style>
