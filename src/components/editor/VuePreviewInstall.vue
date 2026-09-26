<script setup lang="ts">
/**
 * vue-preview が入っていないシェルで、.vue の Preview の欄に出す案内（#397）。入れる 1 行は
 * `lib/vuePreview.ts` の `vuePreviewInstallCommand`、流して探し直すのは `stores/vuePreview.ts`
 * の `install`。ここは表示だけ。
 */
import { computed } from 'vue'
import { useI18n } from '../../i18n'
import { openUrlWithConfirm } from '../../lib/openUrl'
import { VUE_PREVIEW_RELEASES, vuePreviewInstallDir } from '../../lib/vuePreview'
import { useVuePreviewStore } from '../../stores/vuePreview'
import type { ShellType } from '../../types/tab'

const props = defineProps<{
  shell: ShellType
  /** ターミナルのタブを開く場所（プロジェクトのルート、無ければファイルの隣）。 */
  root: string
}>()
const { t } = useI18n()
const store = useVuePreviewStore()

const installing = computed(() => store.isInstalling(props.shell))
const dir = computed(() => vuePreviewInstallDir(props.shell))
</script>

<template>
  <div class="vue-preview-install">
    <p class="vue-preview-install-title">{{ t('vuePreview.missing') }}</p>
    <p>{{ t('vuePreview.installHint', { dir }) }}</p>
    <div class="vue-preview-install-actions">
      <button class="accent-btn" :disabled="installing" @click="store.install(shell, root)">
        {{ installing ? t('vuePreview.installing') : t('vuePreview.install') }}
      </button>
      <button class="link-btn" @click="openUrlWithConfirm(VUE_PREVIEW_RELEASES)">{{ t('vuePreview.releases') }}</button>
    </div>
  </div>
</template>

<style scoped>
.vue-preview-install {
  padding: 24px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
  overflow-y: auto;
}

.vue-preview-install p {
  margin: 0 0 10px;
}

.vue-preview-install-title {
  color: var(--text-primary);
  font-weight: 600;
}

.vue-preview-install-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 14px 0;
}

.vue-preview-install-actions .accent-btn {
  padding: 5px 14px;
  font-size: 13px;
}

.vue-preview-install-actions .accent-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.link-btn {
  border: none;
  background: none;
  padding: 0;
  color: var(--accent);
  font-size: 12px;
  cursor: pointer;
}

.link-btn:hover {
  text-decoration: underline;
}
</style>
