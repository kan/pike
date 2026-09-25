<script setup lang="ts">
import { Trash2 } from 'lucide-vue-next'
import { useI18n } from '../../i18n'

/**
 * 承認済みホストの一覧（設定画面）。外部画像（#239）とリンク（#311）の 2 つが使う。
 *
 * **見出しと説明は持たない**。この部品が持つのは「文字列を並べて 1 つずつ消せる」という
 * 振る舞いだけで、承認したことの意味（画像を取ってきて埋め込む / 外部ブラウザへ渡す）は呼ぶ側に
 * 残す。2 つのリストを 1 本に畳まないのと同じ線引き。見出しと説明は呼ぶ側の
 * `settings/SettingItem.vue` が i18n キーで受け取って描く（#314。絞り込みの対象にするため、
 * 文言を持つのは項目の側に寄せた）。
 *
 * 追加の口は持たない。どちらもプレビューのボタンと確認ダイアログのチェックボックスから増える。
 */
defineProps<{ hosts: string[] }>()
defineEmits<{ forget: [host: string] }>()

const { t } = useI18n()
</script>

<template>
  <div v-if="hosts.length > 0" class="setting-list">
    <div v-for="host in hosts" :key="host" class="setting-list-row">
      <span class="setting-list-name">{{ host }}</span>
      <button class="icon-btn danger" :title="t('common.delete')" @click="$emit('forget', host)">
        <Trash2 :size="14" :stroke-width="2" />
      </button>
    </div>
  </div>
  <p v-else class="setting-hint">{{ t('settings.hostsEmpty') }}</p>
</template>

<style scoped>
/* 一覧の器（`.setting-list` / `-row` / `-name`）と空表示（`.setting-hint`）は `theme.css` の
   共有クラス。親の scoped CSS はこの中まで届かないので、ここで使う見た目は共有クラスか
   自前の定義のどちらかになる。**別名で持ち直さないこと**: 以前は `host-*` という自前の
   3 つを持っていて、設定タブ側と同じ形が 2 通りの名前で並んでいた。 */

/* **`.icon-btn` は自前で持つ。** 呼び出し元（`SettingsTab.vue`）にも同名の定義があるが、
   scoped CSS は子コンポーネントのルート要素までしか届かないので、中のボタンには当たらない
   （`panels/ProfileRow.vue` と同じ理由。あちらの doc に、共有へ上げない理由もある）。 */
.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  flex-shrink: 0;
}

.icon-btn:hover:not(:disabled) {
  color: var(--danger);
  background: var(--tab-hover-bg);
}

</style>
