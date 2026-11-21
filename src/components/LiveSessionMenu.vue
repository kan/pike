<script setup lang="ts">
/**
 * 今動いているエージェント（Claude Code / Codex）のセッションの右クリックメニュー（#625 / #633）。サイドバーのパネル
 * （`AgentSessionsPanel.vue`）と詳細のタブ（`AgentSessionsTab.vue`）が同じものを使う。
 * 作りは issue パネルの右クリックと同じ（測ってから置く・閉じてから実行。`IssuesPanel.vue`）。
 * 操作の実体はストア（`stores/liveSessions.ts`）にあり、ここは並べて呼ぶだけ。
 */
import { ref, useTemplateRef } from 'vue'
import { useAnchoredPopup } from '../composables/useAnchoredPopup'
import { useI18n } from '../i18n'
import { useOverlay } from '../lib/overlay'
import { type LiveSessionRow, useLiveSessionsStore } from '../stores/liveSessions'

const { t } = useI18n()
const store = useLiveSessionsStore()

const row = ref<LiveSessionRow | null>(null)
useOverlay(() => row.value !== null)
const { style, placeAt, reset } = useAnchoredPopup(useTemplateRef<HTMLElement>('menuEl'))

async function open(e: MouseEvent, target: LiveSessionRow) {
  e.preventDefault()
  row.value = target
  reset()
  await placeAt({ x: e.clientX, y: e.clientY })
  window.addEventListener('mousedown', close, { once: true })
}

function close() {
  row.value = null
  reset()
}

function run(action: (target: LiveSessionRow) => unknown) {
  const target = row.value
  close()
  if (target) void action(target)
}

defineExpose({ open, close })
</script>

<template>
  <Teleport to="body">
    <div v-if="row" ref="menuEl" class="panel-ctx-menu popup-surface" :style="style" @mousedown.stop>
      <button @click="run(store.jump)">{{ t('liveSessions.menuJump') }}</button>
      <button @click="run(store.openInNewWindow)">{{ t('liveSessions.menuNewWindow') }}</button>
      <button @click="run(store.openTerminalAt)">{{ t('liveSessions.menuTerminal') }}</button>
      <div class="ctx-separator"></div>
      <button @click="run(store.copySessionId)">{{ t('liveSessions.menuCopyId') }}</button>
      <button @click="run(store.copyResumeCommand)">{{ t('liveSessions.menuCopyResume') }}</button>
      <button @click="run(store.copyCwd)">{{ t('liveSessions.menuCopyCwd') }}</button>
    </div>
  </Teleport>
</template>
