<script setup lang="ts">
import { AlertTriangle, Shield, Terminal } from 'lucide-vue-next'
import { computed } from 'vue'
import { useI18n } from '../../i18n'
import type { ApprovalDecision } from '../../lib/tauri'
import { useCodexStore } from '../../stores/codex'

const { t } = useI18n()
const codex = useCodexStore()

const show = computed(() => codex.pendingCommandApproval !== null || codex.pendingFileApproval !== null)

const sandboxTrusted = computed(() => {
  const req = codex.pendingCommandApproval ?? codex.pendingFileApproval
  return req?.sandboxTrusted !== false
})

async function respond(decision: ApprovalDecision) {
  const req = codex.pendingCommandApproval ?? codex.pendingFileApproval
  if (!req) return
  await codex.respondApproval(req.requestId, decision)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="approval-overlay" @click="respond('cancel')">
      <div class="approval-dialog" @click.stop>
        <!-- Sandbox warning for Windows -->
        <div v-if="!sandboxTrusted" class="sandbox-warning">
          <AlertTriangle :size="14" :stroke-width="2" />
          <span>{{ t('codex.sandboxWarning') }}</span>
        </div>

        <!-- Command Approval -->
        <template v-if="codex.pendingCommandApproval">
          <div class="approval-header">
            <Terminal :size="18" :stroke-width="2" />
            <span>{{ t('codex.approvalCommand') }}</span>
          </div>
          <div class="approval-env">{{ codex.pendingCommandApproval.environment }}</div>
          <div class="approval-command">
            <code>{{ codex.pendingCommandApproval.command ?? '(unknown command)' }}</code>
          </div>
          <div v-if="codex.pendingCommandApproval.cwd" class="approval-cwd">
            {{ t('codex.cwd') }}: {{ codex.pendingCommandApproval.cwd }}
          </div>
        </template>

        <!-- File Change Approval -->
        <template v-else-if="codex.pendingFileApproval">
          <div class="approval-header">
            <Shield :size="18" :stroke-width="2" />
            <span>{{ t('codex.approvalFile') }}</span>
          </div>
          <div class="approval-env">{{ codex.pendingFileApproval.environment }}</div>
          <div v-if="codex.pendingFileApproval.reason" class="approval-reason">
            {{ codex.pendingFileApproval.reason }}
          </div>
        </template>

        <div class="approval-actions">
          <button class="btn approval-accept" @click="respond('accept')">
            {{ t('codex.accept') }}
          </button>
          <button class="btn approval-session" @click="respond('acceptForSession')">
            {{ t('codex.acceptForSession') }}
          </button>
          <button class="btn approval-decline" @click="respond('decline')">
            {{ t('codex.decline') }}
          </button>
          <button class="btn approval-cancel" @click="respond('cancel')">
            {{ t('codex.cancel') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.approval-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.approval-dialog {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  max-width: 500px;
  width: 90%;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}

.sandbox-warning {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  margin-bottom: 12px;
  background: rgba(229, 192, 123, 0.15);
  border: 1px solid rgba(229, 192, 123, 0.4);
  border-radius: 4px;
  font-size: 11px;
  color: #e5c07b;
}

.approval-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 12px;
  color: var(--text-primary);
}

.approval-env {
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 8px;
  padding: 2px 6px;
  background: var(--bg-tertiary);
  border-radius: 4px;
  display: inline-block;
}

.approval-command {
  background: var(--bg-tertiary);
  padding: 8px 12px;
  border-radius: 6px;
  margin-bottom: 8px;
  font-size: 13px;
  overflow-x: auto;
}

.approval-command code {
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-all;
}

.approval-cwd {
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.approval-reason {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.approval-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.btn {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.btn:hover {
  background: var(--bg-tertiary);
}

.approval-accept {
  background: var(--accent);
  color: var(--bg-primary);
  border-color: var(--accent);
}

.approval-accept:hover {
  opacity: 0.9;
}

.approval-session {
  background: var(--bg-tertiary);
}

.approval-decline {
  color: var(--text-secondary);
}

.approval-cancel {
  color: var(--danger, #e06c75);
  border-color: var(--danger, #e06c75);
}
</style>
