<script setup lang="ts">
/**
 * 子 webview のプレビュー（HTML の #399、Vue SFC の #397）の器。子 webview を重ねる枠
 * （`host`。中身は空で矩形だけを貸す）、スマートフォンの画面の大きさ、枠の中に出す案内と
 * エラーを持つ。上に帯を差し込むときは slot `bar` を使う。
 *
 * **案内は子 webview が無いか隠れているときにしか見えない**（子 webview は DOM より手前に
 * 描かれる）。描けない理由を見せたいなら、子 webview の中のページに出すこと。
 */
import { useTemplateRef } from 'vue'

defineProps<{
  /** スマートフォンの縦長の画面で見る。枠の大きさを絞るだけで UA は変えない。 */
  mobile?: boolean
  message?: string | null
  /** `message` がエラーか（色を変える）。 */
  error?: boolean
}>()

const host = useTemplateRef<HTMLElement>('host')
defineExpose({ host })
</script>

<template>
  <div class="preview-frame" :class="{ mobile }">
    <slot name="bar" />
    <div class="preview-frame-stage">
      <div ref="host" class="preview-frame-host">
        <div v-if="message" class="preview-frame-message" :class="{ error }">{{ message }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-frame {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.preview-frame-stage {
  flex: 1;
  min-height: 0;
  display: flex;
}

.preview-frame-host {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 大きさはブラウザのタブのスマートフォンの画面（`BrowserTab.vue`）と同じ。 */
.preview-frame.mobile .preview-frame-stage {
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
}

.preview-frame.mobile .preview-frame-host {
  flex: 0 0 auto;
  width: min(390px, 100%);
  height: min(844px, 100%);
  outline: 1px solid var(--border);
}

.preview-frame-message {
  max-width: 28em;
  padding: 0 16px;
  text-align: center;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-secondary);
}

.preview-frame-message.error {
  color: var(--danger);
}
</style>
