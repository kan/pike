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
import { fsWatcher } from '../composables/useFsWatcher'
import { useI18n } from '../i18n'
import ToolNotice from './ToolNotice.vue'

defineProps<{
  /** 設定画面の帯（アイコン付きの箱）。省略するとパネルの細い帯になる。 */
  boxed?: boolean
}>()

const { t } = useI18n()
</script>

<template>
  <!-- 導線を出すのは、入れれば直るときだけ。 -->
  <ToolNotice
    v-if="fsWatcher.noticeText.value"
    :text="fsWatcher.noticeText.value"
    :detail="fsWatcher.notice.value?.detail"
    :action-label="fsWatcher.notice.value?.reason === 'missingTool' ? t('watcher.installTitle') : ''"
    :boxed="boxed"
    @action="fsWatcher.installInotify()"
  />
</template>
