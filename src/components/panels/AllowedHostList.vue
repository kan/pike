<script setup lang="ts">
import { Trash2 } from 'lucide-vue-next'
import { useI18n } from '../../i18n'

/**
 * 承認済みホストの一覧（設定画面）。外部画像（#239）とリンク（#311）の 2 つが使う。
 *
 * **見出しと説明は props で受ける**。この部品が持つのは「文字列を並べて 1 つずつ消せる」という
 * 振る舞いだけで、承認したことの意味（画像を取ってきて埋め込む / 外部ブラウザへ渡す）は呼ぶ側に
 * 残す。2 つのリストを 1 本に畳まないのと同じ線引き。
 *
 * 追加の口は持たない。どちらもプレビューのボタンと確認ダイアログのチェックボックスから増える。
 */
defineProps<{ label: string; hint: string; hosts: string[] }>()
defineEmits<{ forget: [host: string] }>()

const { t } = useI18n()
</script>

<template>
  <div class="setting-row setting-row-block">
    <label class="setting-label">{{ label }}</label>
    <p class="setting-hint">{{ hint }}</p>
    <div v-if="hosts.length > 0" class="host-list">
      <div v-for="host in hosts" :key="host" class="host-row">
        <span class="host-name">{{ host }}</span>
        <button class="icon-btn danger" :title="t('common.delete')" @click="$emit('forget', host)">
          <Trash2 :size="14" :stroke-width="2" />
        </button>
      </div>
    </div>
    <p v-else class="setting-hint">{{ t('settings.hostsEmpty') }}</p>
  </div>
</template>

<style scoped>
.host-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.host-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.host-name {
  flex: 1;
  font-size: 12px;
  color: var(--text-primary);
}
</style>
