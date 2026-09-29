<script setup lang="ts">
/**
 * 更新の確認と適用のボタン、その結果（#420）。設定画面の「バージョン情報」と About が共有する。
 * 状態は `useUpdater` のモジュール単位のものなので、どちらで押しても両方の表示がそろう。
 */
import { Loader } from 'lucide-vue-next'
import { useUpdater } from '../../composables/useUpdater'
import { useI18n } from '../../i18n'

const { t } = useI18n()
const updater = useUpdater()
</script>

<template>
  <div class="setting-actions">
    <button v-if="updater.state.value === 'available'" class="setting-btn setting-btn-primary" @click="updater.downloadAndInstall">
      {{ t('settings.updateAndRestart') }}
    </button>
    <!-- 「更新あり」のときも出す。見つけた版より新しいリリースが出ていることがある（#414） -->
    <button v-if="!updater.busy.value" class="setting-btn" @click="updater.checkForUpdate">{{ t('settings.checkUpdate') }}</button>
    <button v-else class="setting-btn" disabled>
      <Loader :size="14" :stroke-width="2" class="spin" />
      {{ t(updater.state.value === 'checking' ? 'settings.checking' : 'settings.downloading') }}
    </button>
    <span v-if="updater.state.value === 'available'" class="setting-result">
      {{ t('settings.updateAvailable', { version: updater.updateVersion.value }) }}
    </span>
    <span v-else-if="updater.state.value === 'upToDate'" class="setting-result setting-result-ok">
      {{ t('settings.upToDate') }}
    </span>
    <span v-else-if="updater.state.value === 'error'" class="setting-result setting-result-err">
      {{ t('settings.updateError') }}{{ updater.errorMessage.value ? ': ' + updater.errorMessage.value : '' }}
    </span>
  </div>
</template>
