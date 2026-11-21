<script setup lang="ts">
/**
 * DB ビューワ（#632）の接続のダイアログ。DB パネルの「新しい接続…」と、自動でつなげなかったとき
 * （パスワードが要る・接続先が違う）と、DB タブの「接続先を変える」から出る。
 *
 * 状態と接続の段取りは `stores/db.ts`（`dialog` / `setRoute` / `submitDialog`）。ここは欄を描くだけ。
 * **接続のフォームはここ 1 つ**（DB タブの中には置かない。2 か所にあると片方だけ直す事故が起きる）。
 */
import { Database, LoaderCircle } from 'lucide-vue-next'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from '../i18n'
import { defaultPort, ENGINE_LABELS } from '../lib/dbViewer'
import { useOverlay } from '../lib/overlay'
import { SHELL_ROUTE, useDbStore } from '../stores/db'
import type { DbEngine } from '../types/db'
import { shellProfileLabel } from '../types/tab'

const { t } = useI18n()
const db = useDbStore()

const open = computed(() => db.dialog !== null)
// 手前に浮くものは数える（#396。ブラウザのタブの子 webview を隠すため）。
useOverlay(() => open.value)

const busy = computed(() => db.connecting !== null)
const isContainer = computed(() => !!db.dialog && db.dialog.route !== SHELL_ROUTE)
const engines = Object.entries(ENGINE_LABELS) as [DbEngine, string][]

const firstInput = ref<HTMLSelectElement | null>(null)
watch(open, (v) => {
  if (v) void nextTick(() => firstInput.value?.focus())
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && !busy.value) db.closeDialog()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="db.dialog" class="modal-overlay ui-zoom" @mousedown.self="!busy && db.closeDialog()" @keydown="onKeydown">
      <form class="modal-panel db-dialog popup-surface" data-testid="db-connect-dialog" @submit.prevent="db.submitDialog()">
        <div class="modal-header">
          <span class="modal-title"><Database :size="14" :stroke-width="2" />{{ t('db.connectTitle') }}</span>
        </div>
        <div class="db-body">
          <label class="db-field">
            <span>{{ t('db.source') }}</span>
            <select
              ref="firstInput"
              class="dialog-input"
              :value="db.dialog.route"
              :disabled="busy"
              @change="db.setRoute(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="c in db.dbContainers" :key="c.id" :value="c.id">
                {{ t('db.sourceContainer', { name: c.name }) }}
              </option>
              <option :value="SHELL_ROUTE">{{ t('db.sourceShell', { shell: shellProfileLabel(db.dialog.shell) }) }}</option>
            </select>
          </label>
          <label class="db-field">
            <span>{{ t('db.engine') }}</span>
            <select v-model="db.dialog.form.engine" class="dialog-input" :disabled="busy || isContainer">
              <option v-for="[value, label] in engines" :key="value" :value="value">{{ label }}</option>
            </select>
          </label>
          <template v-if="!isContainer">
            <label class="db-field">
              <span>{{ t('db.host') }}</span>
              <input v-model="db.dialog.form.host" class="dialog-input" type="text" spellcheck="false" placeholder="127.0.0.1" :disabled="busy" />
            </label>
            <label class="db-field">
              <span>{{ t('db.port') }}</span>
              <input
                v-model="db.dialog.form.port"
                class="dialog-input"
                type="text"
                inputmode="numeric"
                :placeholder="String(defaultPort(db.dialog.form.engine))"
                :disabled="busy"
              />
            </label>
          </template>
          <label class="db-field">
            <span>{{ t('db.user') }}</span>
            <input v-model="db.dialog.form.user" class="dialog-input" type="text" spellcheck="false" autocomplete="off" :disabled="busy" />
          </label>
          <label class="db-field">
            <span>{{ t('db.password') }}</span>
            <input
              v-model="db.dialog.form.password"
              class="dialog-input"
              type="password"
              autocomplete="off"
              :placeholder="isContainer && db.dialog.containerHasPassword ? t('db.passwordFromContainer') : ''"
              :disabled="busy"
            />
          </label>
          <label class="db-field">
            <span>{{ t('db.database') }}</span>
            <!-- つながったが DB を選んでいなかったときは、見られる DB を候補に出す（`judgeProbe`）。
                 選択欄にしないのは、一覧に出さないシステムの DB も打ち込めるようにするため。 -->
            <input
              v-model="db.dialog.form.database"
              class="dialog-input"
              type="text"
              spellcheck="false"
              list="db-connect-database-choices"
              data-testid="db-connect-database"
              :placeholder="db.dialog.databaseChoices.length ? t('db.pickDatabase') : ''"
              :disabled="busy"
            />
            <datalist id="db-connect-database-choices">
              <option v-for="name in db.dialog.databaseChoices" :key="name" :value="name" />
            </datalist>
          </label>
          <p class="db-hint">{{ t('db.passwordNotSaved') }}</p>
          <p v-if="db.dialog.error" class="db-error selectable">{{ db.dialog.error }}</p>
          <div class="dialog-actions">
            <button type="button" class="dialog-btn" :disabled="busy" @click="db.closeDialog()">{{ t('common.cancel') }}</button>
            <button type="submit" class="dialog-btn dialog-btn-ok" :disabled="busy">
              <LoaderCircle v-if="busy" class="spin" :size="12" :stroke-width="2" />
              {{ t('db.connect') }}
            </button>
          </div>
        </div>
      </form>
    </div>
  </Teleport>
</template>

<style scoped>
.db-dialog {
  width: 460px;
  max-width: calc(100vw - 32px);
}

.modal-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.db-body {
  padding: 4px 16px 16px;
}

.db-field {
  display: grid;
  grid-template-columns: 110px 1fr;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.db-hint {
  margin: 10px 0 0;
  font-size: 11px;
  color: var(--text-secondary);
}

/* 接続のエラーは長く（クライアントの stderr）、改行を含むので、`CreateWorktreeDialog` の
   `.field-error` と同じ色で、折り返して出す。 */
.db-error {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--danger);
  white-space: pre-wrap;
  word-break: break-word;
}

.dialog-btn-ok {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
</style>
