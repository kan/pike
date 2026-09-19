<script setup lang="ts">
/**
 * ドメインごとの JS と CSS の差し込みルールの一覧（設定画面、#368 の段階 3）。
 *
 * 行は設定のストアの配列を **v-model で直に書き換える**（定型プロンプトの一覧と同じ）。
 * ストアが deep で見ているので、保存・同期・他のウィンドウへの反映はそちらが持つ。
 * 開いているブラウザのタブは、CSS はその場で、JS は作り直しの帯から反映する（`BrowserTab.vue`）。
 *
 * 見出しと説明は持たない（`AllowedHostList.vue` と同じく、呼ぶ側の `SettingItem` が描く）。
 */
import { Plus, Trash2 } from 'lucide-vue-next'
import { confirmDialog } from '../../composables/useConfirmDialog'
import { useI18n } from '../../i18n'
import { type SiteRule, useSettingsStore } from '../../stores/settings'

const { t } = useI18n()
const settings = useSettingsStore()

async function remove(rule: SiteRule) {
  const name = rule.name || rule.domains || t('settings.siteRuleUnnamed')
  if (await confirmDialog(t('settings.siteRuleDeleteConfirm', { name }))) settings.removeSiteRule(rule.id)
}
</script>

<template>
  <div class="rule-list">
    <p v-if="settings.browserSiteRules.length === 0" class="setting-hint">{{ t('settings.siteRulesEmpty') }}</p>
    <div v-for="rule in settings.browserSiteRules" :key="rule.id" class="rule" :class="{ disabled: !rule.enabled }">
      <div class="rule-head">
        <label class="rule-enabled" :title="t('settings.siteRuleEnabled')">
          <input v-model="rule.enabled" type="checkbox" />
        </label>
        <input v-model="rule.name" class="rule-input name" :placeholder="t('settings.siteRuleName')" />
        <button class="icon-btn danger" :title="t('common.delete')" @click="remove(rule)">
          <Trash2 :size="14" :stroke-width="2" />
        </button>
      </div>
      <input
        v-model="rule.domains"
        class="rule-input"
        spellcheck="false"
        :placeholder="t('settings.siteRuleDomains')"
      />
      <textarea
        v-model="rule.js"
        class="rule-input code"
        rows="5"
        spellcheck="false"
        :placeholder="t('settings.siteRuleJs')"
      />
      <textarea
        v-model="rule.css"
        class="rule-input code"
        rows="4"
        spellcheck="false"
        :placeholder="t('settings.siteRuleCss')"
      />
    </div>
    <button class="add-btn" @click="settings.addSiteRule()">
      <Plus :size="14" :stroke-width="2" /> {{ t('settings.addSiteRule') }}
    </button>
  </div>
</template>

<style scoped>
/* 親（`SettingsTab.vue`）の scoped CSS はこの中まで届かないので、見た目は自前で持つ
   （`AllowedHostList.vue` と同じ理由）。 */
.rule-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rule {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
}

.rule.disabled {
  opacity: 0.6;
}

.rule-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.rule-enabled {
  display: flex;
  align-items: center;
  cursor: pointer;
}

.rule-input {
  width: 100%;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
}

.rule-input.name {
  flex: 1;
  min-width: 0;
}

.rule-input:focus {
  outline: none;
  border-color: var(--accent);
}

/* 以下の値は設定画面の他の一覧（`SettingsTab.vue` の定型プロンプトの一覧）にそろえてある。
   あちらのクラスは scoped なので、ここへは届かない。 */
.rule-input.code {
  resize: vertical;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  white-space: pre;
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 3px;
  cursor: pointer;
  flex-shrink: 0;
}

.icon-btn:hover {
  background: var(--tab-hover-bg);
}

.icon-btn.danger:hover {
  color: var(--danger);
}

.add-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  align-self: flex-start;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}

.add-btn:hover {
  background: var(--tab-hover-bg);
  border-color: var(--accent);
}
</style>
