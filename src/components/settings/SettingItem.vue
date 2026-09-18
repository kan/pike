<script setup lang="ts">
/**
 * 設定画面の 1 項目（#314）。**項目名と説明文を i18n キーで受け、自分で描く**ので、
 * 絞り込みの対象になる文言と画面に出る文言が同じものになる（別の表を持たない理由は
 * `useSettingsSearch` の doc）。
 *
 * 形は 1 つで、**項目名・説明文・操作を上から縦に並べる**（#365。VS Code の設定画面と同じ）。
 * 以前は既定が「項目名の右端に操作」だったので、幅の広い画面では名前と操作のあいだが
 * 大きく空き、どの操作がどの項目のものか目で追えなかった。
 *
 * 操作は既定で中身の幅に置く（選択肢のボタンや select が行幅まで伸びないように）。
 * 一覧・配色の並び・パスの入力欄のように幅いっぱいに広げたいものは `wide` を付ける。
 * **CSS で要素の種類を並べて判定しないこと**: 項目を足すたびに漏れる。
 *
 * `data-testid` のような属性はフォールスルーでルートへ落ちるので、プロップにしない。
 */
import { computed, inject, provide } from 'vue'
import {
  SETTINGS_ADD_KEYS,
  SETTINGS_GROUP,
  SETTINGS_SECTION,
  useSettingsSearch,
} from '../../composables/useSettingsSearch'
import { useI18n } from '../../i18n'
import HighlightText from './HighlightText.vue'

const props = defineProps<{
  labelKey: string
  hintKey?: string
  /**
   * 絞り込みに当てたい追加の i18n キー。**この項目が自分で描く文言のためのもの**で、
   * 子（`SettingToggle`）が描く選択肢のラベルはあちらが `addKeys` で載せる。
   */
  termKeys?: string[]
  /** 操作を行幅いっぱいに広げる（一覧・並び・入力欄）。 */
  wide?: boolean
}>()

const { t } = useI18n()
const search = useSettingsSearch()
const section = inject(SETTINGS_SECTION, '')
const group = inject(SETTINGS_GROUP, null)

// **キーは setup で 1 回だけ読む。** どの項目も props はテンプレートのリテラルで、
// 登録の入れ替えが要る場面が無い。
const entry = {
  section,
  group,
  keys: [props.labelKey, ...(props.hintKey ? [props.hintKey] : []), ...(props.termKeys ?? [])],
}
search.addItem(entry)
provide(SETTINGS_ADD_KEYS, (keys: string[]) => search.addKeys(entry, keys))

const visible = computed(() => search.itemVisible(entry))
</script>

<template>
  <div v-show="visible" class="setting-block" :class="{ wide }">
    <div class="setting-head">
      <label class="setting-label"><HighlightText :text="t(labelKey)" /></label>
      <p v-if="hintKey" class="setting-hint"><HighlightText :text="t(hintKey)" /></p>
    </div>
    <slot />
  </div>
</template>

<style scoped>
/* **scoped のままでよい**: 描くのはこのファイルだけで、スロットに渡る中身
   （`.mode-toggle` 等）は呼び出し側の scoped CSS が当てる。`.setting-label` /
   `.setting-hint` は `theme.css` にある（`.setting-hint` は切り出した部品
   `panels/AllowedHostList.vue` も使う）。 */
.setting-block {
  display: flex;
  flex-direction: column;
  /* 選択肢のボタン（`.mode-toggle`）が行幅まで伸びないように、左に寄せて中身の幅で置く。 */
  align-items: flex-start;
  gap: 8px;
  padding: 8px 0;
}

.setting-block.wide {
  align-items: stretch;
}

/* 名前と説明はひとかたまりに見せ、操作とのあいだより詰める。 */
.setting-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
