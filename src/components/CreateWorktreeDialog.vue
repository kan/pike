<script setup lang="ts">
/**
 * worktree の作成ダイアログ（#478）。名前とベースブランチを聞き、作成・切り替え・ターミナルを
 * 開くところまでを流す。段取りの実体は `stores/worktree.ts` の `createWorktree`。
 *
 * - **名前がそのままブランチ名**で、ディレクトリ名は `/` を `-` に置き換えたもの
 *   （`lib/worktreeCreate.ts`）。作成先は設定から決まるので、ここでは見せるだけ
 * - **ベースの既定は今いるブランチ**（worktree を切り替えているあいだはその worktree のもの。
 *   detached なら HEAD の commit）。リモートのブランチは検索したときだけ並べる（利用者の判断。
 *   一覧が長くなりすぎる）
 * - 開閉は `worktreeStore.createDialogOpen`（入口がステータスバーとパレットの 2 つ）
 */
import { Loader2 } from 'lucide-vue-next'
import { computed, nextTick, ref, watch } from 'vue'
import { useAppActions } from '../composables/useAppActions'
import { useI18n } from '../i18n'
import { useOverlay } from '../lib/overlay'
import { useGitStore } from '../stores/git'
import { useProjectStore } from '../stores/project'
import { useStatusMessageStore } from '../stores/statusMessage'
import { useWorktreeStore } from '../stores/worktree'
import type { GitWorktreeAdded } from '../types/git'

const { t } = useI18n()
const worktreeStore = useWorktreeStore()
const gitStore = useGitStore()
const projectStore = useProjectStore()
const actions = useAppActions()
// 手前に浮くものは数える（#396。ブラウザのタブの子 webview を隠すため）。
useOverlay(() => worktreeStore.createDialogOpen)

const name = ref('')
const base = ref('')
const baseQuery = ref('')
const busy = ref(false)
const error = ref('')
const nameInput = ref<HTMLInputElement | null>(null)

/** 今いるブランチ。porcelain v2 は detached を `(detached)` と書くので、そのときは commit。 */
function currentBase(): string {
  const status = gitStore.status
  if (!status) return ''
  return status.branch === '(detached)' ? status.head : status.branch
}

watch(
  () => worktreeStore.createDialogOpen,
  (open) => {
    if (!open) return
    name.value = ''
    baseQuery.value = ''
    error.value = ''
    busy.value = false
    base.value = currentBase()
    // 一覧はキャッシュの refs ですぐ出し、リモートの更新は待たない（ブランチ切替と同じ）。
    void gitStore.loadBranches().then(() => gitStore.refreshRemoteBranches())
    nextTick(() => nameInput.value?.focus())
  },
)

// 開いたままプロジェクトを切り替えたら閉じる。ベースとブランチの一覧は開いたときの
// リポジトリのもので、残すと切り替え先に前のリポジトリのブランチ名で作ろうとする。
// 作成中（`busy`）はストアが「替わっていたら切り替えない」で受けるので、ここでは触らない。
watch(
  () => projectStore.currentProject?.id,
  () => {
    if (!busy.value) worktreeStore.createDialogOpen = false
  },
)

const trimmedName = computed(() => name.value.trim())
const plannedPath = computed(() => (trimmedName.value ? worktreeStore.plannedPath(trimmedName.value)?.path : null))
/** 手元で分かる重なりは打ったそばから出す（最終的な判定は Rust）。 */
const nameTaken = computed(() => gitStore.branches.includes(trimmedName.value))
const canSubmit = computed(() => !busy.value && !!trimmedName.value && !!base.value && !nameTaken.value)

const query = computed(() => baseQuery.value.trim().toLowerCase())
const matching = (list: string[]) => list.filter((b) => b.toLowerCase().includes(query.value))
const localCandidates = computed(() => (query.value ? matching(gitStore.branches) : gitStore.branches))
const remoteCandidates = computed(() => (query.value ? matching(gitStore.remoteBranches) : []))

function close() {
  if (busy.value) return
  worktreeStore.createDialogOpen = false
}

/** Rust が綴りで返す 2 つの重なりは i18n の文言に直す。他は git の文言のまま。 */
function describeError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  if (message === 'branch-exists') return t('worktree.branchExists', { name: trimmedName.value })
  if (message === 'path-exists') return t('worktree.pathExists', { path: plannedPath.value ?? '' })
  return message
}

/** 知らせに並べる失敗の名前の数。WSL の `cp` が走らなかったときは全部が失敗で返る。 */
const MAX_FAILED_NAMES = 5

function report(created: string, result: GitWorktreeAdded) {
  const status = useStatusMessageStore()
  const problems: string[] = []
  if (result.failed.length > 0) {
    const shown = result.failed.slice(0, MAX_FAILED_NAMES).join(', ')
    const names = result.failed.length > MAX_FAILED_NAMES ? `${shown}, …` : shown
    problems.push(t('worktree.copyFailed', { name: created, count: result.failed.length, names }))
  }
  if (result.warnings.length > 0) {
    problems.push(t('worktree.createWarning', { name: created, message: result.warnings.join(' / ') }))
  }
  if (problems.length > 0) {
    status.show({ text: problems.join(' / '), variant: 'warn', durationMs: 8000 })
  } else if (result.copied > 0) {
    status.show({ text: t('worktree.createdWithCopies', { name: created, count: result.copied }), variant: 'success' })
  } else {
    status.show({ text: t('worktree.created', { name: created }), variant: 'success' })
  }
}

async function submit() {
  if (!canSubmit.value) return
  const created = trimmedName.value
  busy.value = true
  error.value = ''
  try {
    const { added, switched } = await worktreeStore.createWorktree(created, base.value)
    worktreeStore.createDialogOpen = false
    // 新しいターミナルの cwd は `activeRoot` に追従する（#269）。切り替えたあとに開けば
    // worktree のルートで開く。切り替えなかった（作っているあいだにプロジェクトが替わった）
    // ときは開かない: 開くと別のプロジェクトのタブ列に、関係の無いターミナルができる。
    if (switched) actions.openTerminal()
    report(created, added)
  } catch (e) {
    error.value = describeError(e)
  } finally {
    busy.value = false
  }
}

/** 名前の欄の Enter。IME の変換を確定する Enter（`isComposing`）では送らない。 */
function onNameEnter(e: KeyboardEvent) {
  if (!e.isComposing) void submit()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="worktreeStore.createDialogOpen" class="modal-overlay ui-zoom" @mousedown.self="close" @keydown="onKeydown">
      <div class="modal-panel create-panel popup-surface" data-testid="create-worktree-dialog">
        <div class="modal-header">
          <span class="modal-title">{{ t('worktree.createTitle') }}</span>
        </div>

        <div class="create-body">
          <label class="field-label" for="worktree-name">{{ t('worktree.createName') }}</label>
          <input
            id="worktree-name"
            ref="nameInput"
            v-model="name"
            class="dialog-input"
            type="text"
            spellcheck="false"
            placeholder="feature/login"
            :disabled="busy"
            @keydown.enter.stop="onNameEnter"
          />
          <p class="field-hint">{{ t('worktree.createNameHint') }}</p>
          <p v-if="nameTaken" class="field-error">{{ t('worktree.branchExists', { name: trimmedName }) }}</p>

          <div class="field-label">
            {{ t('worktree.createBase') }}
            <span class="base-value selectable">{{ base }}</span>
          </div>
          <input
            v-model="baseQuery"
            class="dialog-input"
            type="text"
            spellcheck="false"
            :placeholder="t('worktree.createBaseSearch')"
            :disabled="busy"
          />
          <div class="branch-list">
            <button
              v-for="b in localCandidates"
              :key="b"
              type="button"
              class="branch-option"
              :class="{ current: b === base }"
              :disabled="busy"
              @click="base = b"
            >{{ b }}</button>
            <template v-if="remoteCandidates.length">
              <div class="branch-section">{{ t('git.remoteBranches') }}</div>
              <button
                v-for="b in remoteCandidates"
                :key="b"
                type="button"
                class="branch-option remote-option"
                :class="{ current: b === base }"
                :disabled="busy"
                @click="base = b"
              >{{ b }}</button>
            </template>
            <div v-if="!localCandidates.length && !remoteCandidates.length" class="branch-empty">
              {{ t('git.noBranches') }}
            </div>
          </div>

          <div class="field-label">{{ t('worktree.createPath') }}</div>
          <p class="path-preview selectable">{{ plannedPath ?? '—' }}</p>

          <p v-if="error" class="field-error selectable">{{ error }}</p>

          <div class="dialog-actions">
            <span v-if="busy" class="busy"><Loader2 :size="14" class="spin" />{{ t('worktree.creating') }}</span>
            <button class="dialog-btn" :disabled="busy" @click="close">{{ t('common.cancel') }}</button>
            <button class="dialog-btn dialog-btn-ok" :disabled="!canSubmit" @click="submit">
              {{ t('worktree.createSubmit') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.create-panel {
  width: 440px;
  max-width: calc(100vw - 32px);
}

.create-body {
  padding: 4px 16px 16px;
}

.field-label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 10px 0 4px;
  font-size: 12px;
  color: var(--text-secondary);
}

.base-value,
.path-preview {
  color: var(--text-primary);
  font-family: 'Cascadia Code', 'Fira Code', monospace;
}

.field-hint {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--text-secondary);
}

.field-error {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--danger);
  word-break: break-word;
}

.branch-list {
  margin-top: 4px;
  max-height: 160px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-primary);
}

.branch-option {
  display: block;
  width: 100%;
  padding: 4px 8px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.branch-option:hover {
  background: var(--tab-hover-bg);
}

.branch-option.current {
  background: var(--accent);
  color: var(--on-accent);
}

.branch-option.remote-option:not(.current) {
  color: var(--text-secondary);
}

.branch-section {
  padding: 6px 8px 2px;
  font-size: 11px;
  color: var(--text-secondary);
}

.branch-empty {
  padding: 6px 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.path-preview {
  margin: 0;
  font-size: 12px;
  word-break: break-all;
}

.dialog-actions {
  margin-top: 18px;
}

.busy {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: auto;
  font-size: 12px;
  color: var(--text-secondary);
}
</style>
