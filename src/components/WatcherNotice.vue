<script setup lang="ts">
/**
 * ファイル監視についての帯（#385）。
 *
 * **2 か所（ファイルツリーのパネルと設定画面）で同じものを出す**ので 1 部品にしてある。
 * 書き写していたころは、`display: block` の 1 行だけが片方に付いていて、同じ役目の
 * ボタンが 2 つの画面で違う位置に出ていた。
 *
 * **状態は props で受けない。** 監視はウィンドウに 1 つなので、置いた側が
 * `fsWatcher` から読み直して渡す形にすると、「どの理由でボタンを出すか」の判定が置いた
 * 数だけ増える。ここが唯一の読み手。
 */
import { Info } from 'lucide-vue-next'
import { fsWatcher } from '../composables/useFsWatcher'
import { useI18n } from '../i18n'

defineProps<{
  /** 設定画面の帯（アイコン付きの箱）。省略するとパネルの細い帯になる。 */
  boxed?: boolean
}>()

const { t } = useI18n()
</script>

<template>
  <div
    v-if="fsWatcher.noticeText.value"
    class="watcher-notice"
    :class="{ boxed }"
    :title="fsWatcher.notice.value?.detail"
  >
    <Info v-if="boxed" :size="16" :stroke-width="1.5" />
    <div class="notice-body">
      <span>{{ fsWatcher.noticeText.value }}</span>
      <!-- 導線を出すのは、入れれば直るときだけ。 -->
      <button
        v-if="fsWatcher.notice.value?.reason === 'missingTool'"
        class="notice-btn"
        @click="fsWatcher.installInotify()"
      >
        {{ t('watcher.installTitle') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.watcher-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  margin-bottom: 8px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 4px;
}

/* 設定画面のぶん。パネルの細い帯より目立たせる（探して来る場所ではないため）。 */
.watcher-notice.boxed {
  padding: 10px 12px;
  margin-bottom: 20px;
  font-size: 12px;
  color: var(--text-primary);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  border-radius: 6px;
}

.watcher-notice :deep(svg) {
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--accent);
}

.notice-btn {
  /* `.notice-body` は素のブロックなので `align-self` は効かない。次の行に左寄せで
     置くために、自分でブロックにする。 */
  display: block;
  margin-top: 6px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 11px;
  cursor: pointer;
}

.notice-btn:hover {
  /* `filter: brightness()` にしないこと。ライトテーマの `--bg-secondary` はほぼ白なので
     ほとんど変化しない（`.editor-toggle` / `.tool-btn` が同じ理由でこの変数を使う）。 */
  background: var(--tab-hover-bg);
}
</style>
