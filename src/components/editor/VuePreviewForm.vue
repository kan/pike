<script setup lang="ts">
/**
 * Vue SFC のプレビュー（#397）で、マウント時の値を仮に入れるフォーム。欄の組み立てと入力の
 * 読み取りは `lib/vuePreview.ts`、値の保存と描き直しは親の `VuePreview.vue` が持つ。ここは
 * 表示だけで、欄（`v-model:fields`）の `text` を書き換えて `apply` / `clear` / `close` を知らせる。
 */
import { computed } from 'vue'
import { useI18n } from '../../i18n'
import type { InputField } from '../../lib/vuePreview'

/** 欄。入力はここで各欄の `text` に書き込む（親が適用のときに読む）。 */
const fields = defineModel<InputField[]>('fields', { required: true })
defineProps<{
  /** 保存した値があるか（「入れた値を消す」を出す）。 */
  hasValues: boolean
}>()
const emit = defineEmits<{ apply: []; clear: []; close: [] }>()
const { t } = useI18n()

/**
 * 欄の群。composable から受け取った値（`call`）は JSON で意味のある値を与えにくいので、畳んだ
 * `<details>` にまとめる（値を入れてあれば開いておく）。
 */
const groups = computed(() => {
  const calls = fields.value.filter((f) => f.kind === 'call')
  return [
    { key: 'main', fields: fields.value.filter((f) => f.kind !== 'call'), summary: null, open: true },
    {
      key: 'call',
      fields: calls,
      summary: t('vuePreview.fromComposables', { count: calls.length }),
      open: calls.some((f) => f.text),
    },
  ]
})

/** 欄名の下の添え書き：`prop · Boolean · 初期値 false`。 */
function note(f: InputField): string {
  const initial = f.initial === null ? '' : `${t('vuePreview.initialValue')} ${f.initial}`
  return [f.kind === 'prop' ? 'prop' : '', f.types, initial].filter(Boolean).join(' · ')
}
</script>

<template>
  <form class="vue-preview-form" @submit.prevent="emit('apply')">
    <p class="vue-preview-form-hint">{{ t('vuePreview.fillHint') }}</p>
    <template v-for="g in groups" :key="g.key">
      <component :is="g.summary ? 'details' : 'div'" v-if="g.fields.length" :open="g.open" class="vue-preview-group">
        <summary v-if="g.summary">{{ g.summary }}</summary>
        <label v-for="f in g.fields" :key="f.name" class="vue-preview-field">
          <span class="vue-preview-field-name">
            {{ f.name }}
            <small>{{ note(f) }}</small>
          </span>
          <textarea v-model="f.text" rows="1" spellcheck="false" :placeholder="f.initial ?? ''" />
        </label>
      </component>
    </template>
    <div class="vue-preview-form-actions">
      <button type="submit" class="vue-preview-apply accent-btn">{{ t('vuePreview.apply') }}</button>
      <button v-if="hasValues" type="button" class="vue-preview-button" @click="emit('clear')">
        {{ t('vuePreview.clearValues') }}
      </button>
      <button type="button" class="vue-preview-button" @click="emit('close')">{{ t('vuePreview.close') }}</button>
    </div>
  </form>
</template>

<style scoped>
.vue-preview-form {
  max-height: 45%;
  overflow-y: auto;
  padding: 6px 8px;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}

.vue-preview-form-hint {
  margin: 0 0 6px;
  font-size: 11px;
  color: var(--text-secondary);
}

.vue-preview-group summary {
  margin: 4px 0;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
}

.vue-preview-field {
  display: grid;
  grid-template-columns: minmax(8em, 30%) 1fr;
  gap: 8px;
  align-items: start;
  margin-bottom: 4px;
}

.vue-preview-field-name {
  padding-top: 3px;
  overflow-wrap: anywhere;
  font-family: var(--font-mono, monospace);
}

.vue-preview-field-name small {
  display: block;
  color: var(--text-secondary);
  font-size: 10px;
}

.vue-preview-field textarea {
  width: 100%;
  min-height: 22px;
  resize: vertical;
  box-sizing: border-box;
  padding: 2px 4px;
  font: 12px/1.4 var(--font-mono, monospace);
  color: var(--text-primary);
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 3px;
}

.vue-preview-form-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.vue-preview-button,
.vue-preview-apply {
  padding: 2px 10px;
  font: inherit;
}

/* 「適用」の地と文字色は共有の `.accent-btn`（theme.css）。ここは枠付きのボタンだけ */
.vue-preview-button {
  color: var(--text-primary);
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 3px;
  cursor: pointer;
}
</style>
