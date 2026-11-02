<script setup lang="ts">
/**
 * 設定画面の「自前ホストの対応付け」の欄（#541）。1 行が 1 つのホストで、ホスト・サービスの種類・
 * web の URL・表示名を持つ。下の行に入れて「追加」で足し、ゴミ箱で外す。
 *
 * **書くのは確定（`change`）と追加のときだけ**（打鍵ごとに書かない）。打ちかけの値が設定に入り、
 * ほかのウィンドウとマシンへ同期されるのを避ける（worktree の置き場所の欄と同じ）。**変換中の
 * Enter では足さない**（日本語の表示名を確定したところで行が足される）。
 *
 * **値の整え（trim・空の欄を落とす・重複）は `lib/forge.ts` の `sanitizeForgeHosts` だけが持つ。**
 * ここは書き換えた一覧を渡すだけで、結果が変わらなければ何も書かない（配列を差し替えると、保存と
 * 他のウィンドウへの配信が走る）。
 */
import { Trash2 } from 'lucide-vue-next'
import { ref } from 'vue'
import { useI18n } from '../../i18n'
import {
  defaultWebBase,
  FORGE_KINDS,
  type ForgeHost,
  forgeKindLabel,
  isForgeKind,
  normalizeForgeHost,
  normalizeWebBase,
  sameForgeHosts,
  sanitizeForgeHosts,
} from '../../lib/forge'

const props = defineProps<{ modelValue: ForgeHost[] }>()
const emit = defineEmits<{ 'update:modelValue': [ForgeHost[]] }>()

const { t } = useI18n()

/**
 * 受け付けなかった理由（i18n キー）。**黙って捨てない**: `sanitizeForgeHosts` は空のホスト・重複・
 * 不正な web の URL を落とすので、ここで先に見て、入れた値が効いていないことを知らせる。
 */
const rejected = ref<string | null>(null)

/** 受け付けられない値なら理由のキーを返す。`index` は書き換える行（追加なら -1）。 */
function problem(row: Partial<ForgeHost>, index: number): string | null {
  const host = normalizeForgeHost(row.host ?? '')
  if (!host) return 'settings.forgeHostsEmpty'
  if (props.modelValue.some((h, i) => i !== index && h.host === host)) return 'settings.forgeHostsDuplicate'
  if (row.webBase?.trim() && !normalizeWebBase(row.webBase)) return 'settings.forgeHostsBadWebBase'
  return null
}

/** 整えた結果が今と違えば書く。 */
function commit(next: ForgeHost[]): ForgeHost[] {
  const normalized = sanitizeForgeHosts(next)
  rejected.value = null
  if (!sameForgeHosts(normalized, props.modelValue)) emit('update:modelValue', normalized)
  return normalized
}

/**
 * 1 つの欄の確定。受け付けないときは欄を元の値へ戻して理由を出す。受け付けたときも、欄の文字を
 * 整えた値（小文字のホストなど）に置き直す（値が変わらないと `:value` が描き直されないため）。
 */
function update(index: number, field: keyof ForgeHost, el: HTMLInputElement | HTMLSelectElement) {
  const row = { ...props.modelValue[index], [field]: el.value }
  const reason = problem(row, index)
  if (reason) {
    el.value = props.modelValue[index][field] ?? ''
    rejected.value = reason
    return
  }
  const next = commit(props.modelValue.map((h, i) => (i === index ? row : h)))
  el.value = next[index]?.[field] ?? ''
}

function remove(index: number) {
  commit(props.modelValue.filter((_, i) => i !== index))
}

const emptyDraft = (kind = 'github'): Required<ForgeHost> => ({ host: '', kind, webBase: '', name: '' })
const draft = ref(emptyDraft())

/** 足せないときは欄を残して理由を出す。消すと、足されたのか弾かれたのか分からない。 */
function add(e?: KeyboardEvent) {
  if (e?.isComposing || !draft.value.host.trim()) return
  const reason = problem(draft.value, -1)
  if (reason) {
    rejected.value = reason
    return
  }
  commit([...props.modelValue, { ...draft.value }])
  draft.value = emptyDraft(draft.value.kind)
}
</script>

<template>
  <div class="forge-hosts" data-testid="settings-forge-hosts">
    <div class="forge-row forge-head">
      <span>{{ t('settings.forgeHostsHost') }}</span>
      <span>{{ t('settings.forgeHostsKind') }}</span>
      <span>{{ t('settings.forgeHostsWebBase') }}</span>
      <span>{{ t('settings.forgeHostsName') }}</span>
      <span></span>
    </div>
    <!-- key は添字（ホスト名を直すと key が変わって行が作り直され、Tab で次の欄へ移れない）。
         値は `:value` で渡しているので、行を消したあとに古い値が残ることはない。 -->
    <div v-for="(h, i) in modelValue" :key="i" class="forge-row">
      <input
        class="forge-input"
        type="text"
        spellcheck="false"
        :value="h.host"
        @change="update(i, 'host', $event.target as HTMLInputElement)"
      />
      <select class="forge-input" :value="h.kind" @change="update(i, 'kind', $event.target as HTMLSelectElement)">
        <option v-if="!isForgeKind(h.kind)" :value="h.kind">{{ forgeKindLabel(h.kind) }}</option>
        <option v-for="k in FORGE_KINDS" :key="k" :value="k">{{ forgeKindLabel(k) }}</option>
      </select>
      <input
        class="forge-input"
        type="text"
        spellcheck="false"
        :value="h.webBase ?? ''"
        :placeholder="defaultWebBase(h.host)"
        @change="update(i, 'webBase', $event.target as HTMLInputElement)"
      />
      <input
        class="forge-input"
        type="text"
        :value="h.name ?? ''"
        :placeholder="forgeKindLabel(h.kind)"
        @change="update(i, 'name', $event.target as HTMLInputElement)"
      />
      <button class="icon-btn danger" :title="t('common.delete')" @click="remove(i)">
        <Trash2 :size="14" :stroke-width="2" />
      </button>
    </div>
    <div class="forge-row">
      <input
        v-model="draft.host"
        class="forge-input"
        type="text"
        spellcheck="false"
        :placeholder="t('settings.forgeHostsHostPlaceholder')"
        @keydown.enter.prevent="add"
      />
      <select v-model="draft.kind" class="forge-input">
        <option v-for="k in FORGE_KINDS" :key="k" :value="k">{{ forgeKindLabel(k) }}</option>
      </select>
      <input
        v-model="draft.webBase"
        class="forge-input"
        type="text"
        spellcheck="false"
        :placeholder="t('settings.forgeHostsWebBasePlaceholder')"
        @keydown.enter.prevent="add"
      />
      <input
        v-model="draft.name"
        class="forge-input"
        type="text"
        :placeholder="forgeKindLabel(draft.kind)"
        @keydown.enter.prevent="add"
      />
      <button class="setting-btn" :disabled="!draft.host.trim()" @click="add()">{{ t('settings.forgeHostsAdd') }}</button>
    </div>
    <p v-if="rejected" class="forge-rejected selectable">{{ t(rejected) }}</p>
  </div>
</template>

<style scoped>
.forge-hosts {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.forge-row {
  display: grid;
  grid-template-columns: minmax(120px, 1.2fr) minmax(120px, 1fr) minmax(140px, 1.5fr) minmax(100px, 1fr) auto;
  gap: 4px;
  align-items: center;
}

.forge-head {
  color: var(--text-secondary);
  font-size: 12px;
}

.forge-rejected {
  margin: 2px 0 0;
  color: var(--danger);
  font-size: 12px;
}

/* 値は `SiteRuleList.vue` の `.rule-input` とそろえる（設定の入力欄の見た目）。 */
.forge-input {
  min-width: 0;
  padding: 4px 6px;
  background: var(--bg-primary);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: 13px;
  font-family: inherit;
}

.forge-input:focus {
  border-color: var(--accent);
  outline: none;
}

/* **`.icon-btn` は自前で持つ**（scoped は子のルートまでしか届かない。`AllowedHostList.vue` と同じ値）。 */
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
