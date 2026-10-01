<script setup lang="ts">
/**
 * ファイル監視についての帯（#385）。見た目は `ToolNotice`。
 *
 * **2 か所（ファイルツリーのパネルと設定画面）で同じものを出す**ので 1 部品にしてある。
 *
 * **状態は props で受けない。** 監視はウィンドウに 1 つなので、置いた側が
 * `fsWatcher` から読み直して渡す形にすると、「どの理由でボタンを出すか」の判定が置いた
 * 数だけ増える。ここが唯一の読み手。
 */
import { computed } from 'vue'
import { fsWatcher } from '../composables/useFsWatcher'
import { useI18n } from '../i18n'
import ToolNotice from './ToolNotice.vue'

defineProps<{
  /** 設定画面の帯（アイコン付きの箱）。省略するとパネルの細い帯になる。 */
  boxed?: boolean
}>()

const { t } = useI18n()

/**
 * 帯のボタン。**理由ごとに、押して直りうるものを 1 つだけ出す。**
 *
 * - `missingTool` … 入れる（入ったら張り直すところまで `installInotify` が持つ）
 * - `other` / `watchLimit` … 張り直す（#433）。負荷などで落ちた監視は、同じ相手でもう一度
 *   起こせば戻る。上限は上げてからでないと同じ理由でまた落ちるが、上げたあとに押す
 *   場所が要るので出す
 * - `wslUnc` … 出さない。監視は動いていて、直すのはプロジェクトの種別
 */
const action = computed(() => {
  switch (fsWatcher.notice.value?.reason) {
    case 'missingTool':
      return { label: t('watcher.installTitle'), run: fsWatcher.installInotify }
    case 'other':
    case 'watchLimit':
      return { label: t('watcher.restart'), run: fsWatcher.restart }
    default:
      return null
  }
})
</script>

<template>
  <ToolNotice
    v-if="fsWatcher.noticeText.value"
    :text="fsWatcher.noticeText.value"
    :detail="fsWatcher.notice.value?.detail"
    :action-label="action?.label ?? ''"
    :boxed="boxed"
    @action="action?.run()"
  />
</template>
