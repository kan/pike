<script setup lang="ts">
/**
 * Git パネルの上部に出すエラーの表示（#436）。
 *
 * **原文を地の文に出さない。** git の stderr は長く、狭いパネルでは途中で切れて読めない。
 * 出すのは「エラーが発生しました」と、原因を見分けられたときの概要・直し方だけにして、
 * 原文はコピーとエージェントへの依頼で渡す（見出しのツールチップでも読める）。
 *
 * **勝手に消えない。** 下ろすのは × と、利用者の次の操作だけ（`stores/git.ts` の
 * `clearTransientError` / `clearUnlessAuthPending`）。
 */
import { Bot, Copy, Loader, X } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { injectToTerminal, resolveTargetTerminal } from '../../composables/useTerminalInject'
import { useI18n } from '../../i18n'
import { classifyGitError } from '../../lib/gitErrors'
import { useGitStore } from '../../stores/git'
import { useStatusMessageStore } from '../../stores/statusMessage'

const { t } = useI18n()
const gitStore = useGitStore()

const kind = computed(() => (gitStore.error ? classifyGitError(gitStore.error) : null))

function copyError() {
  const message = gitStore.error
  if (!message) return
  navigator.clipboard
    .writeText(message)
    .then(() => useStatusMessageStore().show({ text: t('common.copied') }))
    .catch(() => {})
}

/** 依頼の前の fetch を待っているあいだ。二重に押させない。 */
const asking = ref(false)

// 送るだけで、表示は下ろさない。エージェントが直し終えるまで、何が起きていたかを
// パネルで読めるほうがよい（直ったあとの操作か × で下りる）。
//
// **送る前にリモートの最新を取り、取れたかどうかを依頼文に添える**（#438。理由は
// `gitStore.fetchForAgent` の doc）。
async function askAgent() {
  const message = gitStore.error
  if (!message || asking.value) return
  // 送り先が無いなら、fetch を待たせずにその場で知らせる（`injectToTerminal` と同じ文面）。
  if (!resolveTargetTerminal()) {
    useStatusMessageStore().show({ text: t('terminal.injectNoTarget'), variant: 'warn' })
    return
  }
  asking.value = true
  try {
    const fetched = await gitStore.fetchForAgent()
    const note = t(fetched ? 'git.errorFixFetched' : 'git.errorFixFetchFailed')
    injectToTerminal(`${t('git.errorFixPrompt', { message })}\n\n${note}`)
  } finally {
    asking.value = false
  }
}
</script>

<template>
  <div v-if="gitStore.error" class="git-error" role="alert" data-testid="git-error">
    <div class="git-error-head">
      <span class="git-error-title" :title="gitStore.error">{{ t('git.errorOccurred') }}</span>
      <button class="git-error-close" :title="t('git.errorDismiss')" @click="gitStore.clearError()">
        <X :size="14" :stroke-width="2" />
      </button>
    </div>
    <template v-if="kind">
      <p class="git-error-summary selectable">{{ t(`git.err.${kind}`) }}</p>
      <p class="git-error-fix selectable">{{ t(`git.errFix.${kind}`) }}</p>
    </template>
    <div class="git-error-actions">
      <!-- 鍵のパスフレーズで直る失敗のときだけ（#386）。伏せ字で受け取って ssh-agent に
           預け、失敗した操作をやり直す。**先に置く**のが普通の直し方で、ターミナルの
           ほうはホスト鍵の確認など「パスフレーズ以外も聞かれる」ときの逃げ道。 -->
      <button v-if="gitStore.canAddKey" class="op-btn" @click="gitStore.addSshKey()">
        {{ t('git.enterPassphrase') }}
      </button>
      <!-- 資格情報の入力が要るときだけ（#384）。バックエンドの git には TTY が
           無いので、ターミナルタブで走らせ直すのが唯一の入力できる場所。 -->
      <button
        v-if="gitStore.authCommand"
        class="op-btn"
        :title="gitStore.authCommand"
        @click="gitStore.runAuthCommand()"
      >
        {{ t('git.runInTerminal') }}
      </button>
      <button class="op-btn" @click="copyError">
        <Copy :size="12" :stroke-width="2" />
        {{ t('git.errorCopy') }}
      </button>
      <button class="op-btn" :disabled="asking" :title="t('git.errorAskAgentHint')" @click="askAgent">
        <Loader v-if="asking" :size="12" :stroke-width="2" class="spin" />
        <Bot v-else :size="12" :stroke-width="2" />
        {{ t('git.errorAskAgent') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.git-error {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 6px;
  padding: 6px 8px;
  border-left: 2px solid var(--danger);
  background: var(--bg-tertiary);
  font-size: 11px;
}

.git-error-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.git-error-title {
  color: var(--danger);
  font-size: 12px;
  font-weight: 600;
}

.git-error-close {
  display: flex;
  flex-shrink: 0;
  padding: 2px;
  border: none;
  border-radius: 3px;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
}

.git-error-close:hover {
  color: var(--text-primary);
}

.git-error-summary,
.git-error-fix {
  margin: 0;
  line-height: 1.5;
}

.git-error-summary {
  color: var(--text-primary);
}

.git-error-fix {
  color: var(--text-secondary);
}

.git-error-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
</style>
