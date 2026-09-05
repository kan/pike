<script setup lang="ts">
/**
 * 「並べ替えられて、目のトグルで隠せる一覧」の 1 行。設定画面のシェル一覧（#129）と
 * エージェント一覧（#275）が共有する。
 *
 * **見た目を持つのはここだけ。** 切り出す前はエージェント側がシェル側の
 * `shell-profile-*` という別機能のクラスに乗っていて、シェル欄の scoped CSS を触ると
 * エージェント欄が黙って変わる状態だった。
 *
 * **既定の決め方は持たない**（`isDefault` を受け取るだけ）。シェルは「グローバルモードの
 * 既定シェル」という別の設定から決まり、エージェントは並びの先頭で決まる、と規則が違う。
 * 同じく「隠してよいか」も呼び出し側の判断（シェルはカテゴリごと、エージェントは全体で
 * 最低 1 つ）。
 */

import { ChevronDown, ChevronUp, Eye, EyeOff } from 'lucide-vue-next'
import { useI18n } from '../../i18n'

const { t } = useI18n()

defineProps<{
  label: string
  /** 「デフォルト」バッジを出すか。 */
  isDefault?: boolean
  hidden?: boolean
  /** 隠してよいか（最後の 1 つは隠せない、という規則は呼び出し側が持つ）。 */
  canHide?: boolean
  first?: boolean
  last?: boolean
}>()

defineEmits<{ move: [dir: -1 | 1]; toggle: [] }>()
</script>

<template>
  <div class="profile-row" :class="{ 'profile-hidden': hidden }">
    <div class="profile-reorder">
      <button class="icon-btn" :disabled="first" :title="'↑'" @click="$emit('move', -1)">
        <ChevronUp :size="14" :stroke-width="2" />
      </button>
      <button class="icon-btn" :disabled="last" :title="'↓'" @click="$emit('move', 1)">
        <ChevronDown :size="14" :stroke-width="2" />
      </button>
    </div>
    <slot name="icon" />
    <span class="profile-label">
      {{ label }}
      <span v-if="isDefault" class="profile-default">{{ t('settings.shellProfileDefault') }}</span>
    </span>
    <button
      class="icon-btn"
      :disabled="!hidden && !canHide"
      :title="hidden ? t('settings.shellProfileShow') : t('settings.shellProfileHide')"
      @click="$emit('toggle')"
    >
      <EyeOff v-if="hidden" :size="14" :stroke-width="2" />
      <Eye v-else :size="14" :stroke-width="2" />
    </button>
  </div>
</template>

<style scoped>
/**
 * **`.icon-btn` を自前で持つ。** 呼び出し元（`SettingsTab.vue`）にも同名の定義があるが、
 * scoped CSS は**子コンポーネントのルート要素までしか届かない**ので、中のボタンには
 * 当たらない（切り出した直後、枠付きの大きなボタンになって出た）。
 *
 * **`theme.css` へ上げないこと**: `panels/IconSelect.vue` が同じ名前で別物
 * （幅 100%・枠あり・テキスト付き）を定義しているので、共有にすると名前が衝突する。
 */
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
  color: var(--text-active);
  background: var(--tab-hover-bg);
}

.icon-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

.profile-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.profile-reorder {
  display: flex;
  flex-direction: column;
}

.profile-reorder .icon-btn {
  height: 14px;
}

/* アイコンは slot なので、こちらから当てるには `:deep()` が要る。 */
.profile-row :deep(.profile-icon) {
  flex-shrink: 0;
  color: var(--text-secondary);
}

.profile-label {
  flex: 1;
  font-size: 12px;
  color: var(--text-primary);
}

.profile-hidden .profile-label,
.profile-hidden :deep(.profile-icon) {
  color: var(--text-secondary);
  opacity: 0.6;
}

.profile-default {
  margin-left: 6px;
  padding: 1px 6px;
  font-size: 10px;
  border-radius: 8px;
  background: var(--accent);
  color: var(--text-active);
}
</style>
