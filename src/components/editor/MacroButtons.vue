<script setup lang="ts">
/**
 * キーボードマクロの記録・再生ボタン（#180）。`WrapToggle.vue` と同じく、排他表示の
 * 2 つのヘッダに同じものを置くために切り出してある。
 *
 * **`mousedown` を止めてフォーカスを奪わない。** 記録はエディタに届いた打鍵を拾うので、
 * ボタンにフォーカスが移ると、記録を始めた直後の打鍵がエディタにもマクロにも入らない。
 * 押したあとにエディタへ戻すのは呼び出し側（どのビューかを知っているのはあちら）。
 */
import { Circle, Play, Square } from 'lucide-vue-next'
import { useI18n } from '../../i18n'
import { MACRO_CHORDS, macroRecording, macroSaved } from '../../lib/editorMacro'
import { chordLabel } from '../../lib/keys'

const emit = defineEmits<{ toggle: []; play: [] }>()

const { t } = useI18n()
</script>

<template>
  <button
    class="editor-toggle"
    :class="{ recording: macroRecording }"
    :title="`${macroRecording ? t('macro.stopButton') : t('macro.recordButton')} (${chordLabel(MACRO_CHORDS.record)})`"
    data-testid="macro-record"
    @mousedown.prevent
    @click="emit('toggle')"
  >
    <Square v-if="macroRecording" :size="12" :stroke-width="0" fill="currentColor" />
    <Circle v-else :size="12" :stroke-width="2" />
  </button>
  <!-- 再生ボタンは、再生できるマクロがあるときだけ出す。記録中は押せない（記録に混ざる）。 -->
  <button
    v-if="macroSaved"
    class="editor-toggle"
    :disabled="macroRecording"
    :title="`${t('macro.playButton')} (${chordLabel(MACRO_CHORDS.play)})`"
    data-testid="macro-play"
    @mousedown.prevent
    @click="emit('play')"
  >
    <Play :size="14" :stroke-width="2" />
  </button>
</template>

<style scoped>
.editor-toggle.recording {
  color: var(--danger);
}
</style>
