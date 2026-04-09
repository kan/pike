<script setup lang="ts">
import DOMPurify from 'dompurify'
import {
  AlertTriangle,
  Bot,
  FileEdit,
  Loader,
  LogIn,
  LogOut,
  Send,
  Square,
  Terminal as TerminalIcon,
} from 'lucide-vue-next'
import { Marked } from 'marked'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from '../../i18n'
import { useCodexStore } from '../../stores/codex'
import { useProjectStore } from '../../stores/project'
import { useTabStore } from '../../stores/tabs'
import ApprovalDialog from '../codex/ApprovalDialog.vue'

const { t } = useI18n()
const codex = useCodexStore()
const projectStore = useProjectStore()
const tabStore = useTabStore()

const input = ref('')
const messageListRef = ref<HTMLDivElement | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)
const userScrolledUp = ref(false)

const marked = new Marked()

const isAuthenticated = computed(() => codex.authState.status === 'authenticated')
const isConnected = computed(() => codex.connected)

// Memoized markdown rendering — avoids re-parsing unchanged segments on every reactive update
const mdCache = new Map<string, string>()
function renderMarkdown(text: string): string {
  if (!text) return ''
  const cached = mdCache.get(text)
  if (cached) return cached
  const html = DOMPurify.sanitize(marked.parse(text) as string)
  // Only cache completed (non-streaming) text to avoid unbounded growth
  if (text.length > 0 && text.length < 50000) mdCache.set(text, html)
  return html
}

async function ensureConnected() {
  if (codex.connected) return
  const project = projectStore.currentProject
  if (!project) return
  await codex.startSession(project.shell, project.root)
}

async function submit() {
  const text = input.value.trim()
  if (!text || codex.isGenerating) return
  input.value = ''
  await ensureConnected()
  userScrolledUp.value = false
  await codex.submitTurn(text)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submit()
  }
}

function onScroll() {
  const el = messageListRef.value
  if (!el) return
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  userScrolledUp.value = !atBottom
}

function scrollToBottom() {
  if (userScrolledUp.value) return
  nextTick(() => {
    const el = messageListRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

watch(() => codex.messages.length, scrollToBottom)
watch(() => {
  const last = codex.messages[codex.messages.length - 1]
  return last?.text?.length ?? 0
}, scrollToBottom)

onMounted(async () => {
  await ensureConnected()
  inputRef.value?.focus()
})
</script>

<template>
  <div class="codex-chat-wrapper">
    <!-- Connecting -->
    <div v-if="!isConnected" class="auth-panel">
      <Loader :size="32" :stroke-width="2" class="spin" />
      <p>{{ t('codex.connecting') }}</p>
    </div>

    <!-- Main Chat UI -->
    <template v-else>
      <!-- Auth bar -->
      <div v-if="!isAuthenticated" class="auth-bar">
        <span>{{ t('codex.notSignedIn') }}</span>
        <button class="btn-sm" @click="codex.login()">
          <LogIn :size="14" :stroke-width="2" />
          {{ t('codex.signIn') }}
        </button>
      </div>
      <div v-else class="auth-bar auth-bar-ok">
        <span>{{ codex.authState.status === 'authenticated' ? (codex.authState as { email: string | null }).email ?? 'ChatGPT' : '' }}</span>
        <button class="btn-sm btn-ghost" @click="codex.logout()">
          <LogOut :size="14" :stroke-width="2" />
        </button>
      </div>

      <!-- Version warning -->
      <div v-if="codex.versionWarning" class="version-warning">
        <AlertTriangle :size="14" :stroke-width="2" />
        <span>{{ codex.versionWarning }}</span>
      </div>

      <!-- Messages -->
      <div class="message-list" ref="messageListRef" @scroll="onScroll">
        <div v-if="codex.messages.length === 0" class="empty-chat">
          <Bot :size="32" :stroke-width="1" />
          <p>{{ t('codex.emptyChat') }}</p>
        </div>
        <div
          v-for="msg in codex.messages"
          :key="msg.id"
          class="message"
          :class="msg.role"
        >
          <div v-if="msg.role === 'user'" class="msg-user">{{ msg.text }}</div>
          <div v-else class="msg-agent">
            <!-- Segments: text and items in chronological order -->
            <template v-for="(seg, si) in msg.segments" :key="si">
              <!-- Text segment -->
              <div v-if="seg.kind === 'text'" class="msg-text" v-html="renderMarkdown(seg.text)" />

              <!-- Item segment -->
              <template v-else-if="seg.kind === 'item'">
                <div class="msg-item">
                  <template v-if="seg.item.type === 'commandExecution'">
                    <div class="item-command">
                      <Loader v-if="!seg.item.completed" :size="12" :stroke-width="2" class="spin item-icon" />
                      <TerminalIcon v-else :size="12" :stroke-width="2" class="item-icon" />
                      <code>{{ seg.item.data.command ?? 'Running command...' }}</code>
                      <span v-if="seg.item.completed && seg.item.data.exitCode != null" class="item-exit" :class="{ ok: seg.item.data.exitCode === 0 }">
                        {{ seg.item.data.exitCode === 0 ? '✓' : `exit ${seg.item.data.exitCode}` }}
                      </span>
                    </div>
                  </template>
                  <template v-else-if="seg.item.type === 'fileChange'">
                    <div class="item-command">
                      <Loader v-if="!seg.item.completed" :size="12" :stroke-width="2" class="spin item-icon" />
                      <FileEdit v-else :size="12" :stroke-width="2" class="item-icon" />
                      <span>{{ t('codex.fileChange') }}</span>
                    </div>
                  </template>
                </div>
              </template>
            </template>

            <!-- Thinking indicator (no segments yet) -->
            <div v-if="!msg.completed && msg.segments.length === 0" class="msg-thinking">
              <Loader :size="14" :stroke-width="2" class="spin" />
              <span>{{ t('codex.thinking') }}</span>
            </div>
            <!-- Processing spinner at the end while still generating -->
            <div v-else-if="!msg.completed" class="msg-thinking">
              <Loader :size="14" :stroke-width="2" class="spin" />
            </div>
          </div>
        </div>
      </div>

      <!-- Input -->
      <div class="input-area">
        <textarea
          ref="inputRef"
          v-model="input"
          :placeholder="t('codex.inputPlaceholder')"
          :disabled="!isAuthenticated"
          rows="1"
          @keydown="onKeydown"
        />
        <button
          v-if="codex.isGenerating"
          class="btn-send btn-stop"
          :title="t('codex.stop')"
          @click="codex.interruptTurn()"
        >
          <Square :size="16" :stroke-width="2" />
        </button>
        <button
          v-else
          class="btn-send"
          :disabled="!input.trim() || !isAuthenticated"
          :title="t('codex.send')"
          @click="submit()"
        >
          <Send :size="16" :stroke-width="2" />
        </button>
      </div>
    </template>

    <!-- Approval Dialogs -->
    <ApprovalDialog />
  </div>
</template>

<style scoped>
.codex-chat-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);
}

.auth-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 100%;
  color: var(--text-secondary);
}

.auth-icon {
  opacity: 0.5;
}

.auth-desc {
  max-width: 300px;
  text-align: center;
  font-size: 13px;
  line-height: 1.5;
}

.btn-primary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--accent);
  color: var(--bg-primary);
  border: none;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
}

.btn-primary:hover {
  opacity: 0.9;
}

.auth-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-secondary);
}

.auth-bar-ok {
  color: var(--text-primary);
}

.btn-sm {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: var(--accent);
  color: var(--bg-primary);
  border: none;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
}

.btn-ghost {
  background: transparent;
  color: var(--text-secondary);
}

.btn-ghost:hover {
  color: var(--text-primary);
}

.version-warning {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: rgba(229, 192, 123, 0.15);
  border-bottom: 1px solid rgba(229, 192, 123, 0.3);
  font-size: 12px;
  color: #e5c07b;
}

.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.empty-chat {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  color: var(--text-secondary);
  opacity: 0.5;
}

.message {
  margin-bottom: 12px;
}

.msg-user {
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg-agent {
  font-size: 13px;
}

.msg-text {
  line-height: 1.6;
  word-break: break-word;
}

.msg-text :deep(pre) {
  background: var(--bg-tertiary);
  padding: 8px 12px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 12px;
}

.msg-text :deep(code) {
  background: var(--bg-tertiary);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
}

.msg-text :deep(pre code) {
  background: none;
  padding: 0;
}

.msg-text :deep(p) {
  margin: 0 0 8px;
}

.msg-text :deep(p:last-child) {
  margin-bottom: 0;
}

.msg-thinking {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.msg-item {
  margin: 4px 0;
}

.item-command {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--bg-tertiary);
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}

.item-command code {
  color: var(--text-primary);
  font-size: 11px;
}

.item-icon {
  flex-shrink: 0;
}

.item-exit {
  margin-left: auto;
  font-size: 11px;
  color: var(--danger, #e06c75);
}

.item-exit.ok {
  color: var(--success, #98c379);
}

.input-area {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
}

.input-area textarea {
  flex: 1;
  resize: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  font-family: inherit;
  background: var(--bg-primary);
  color: var(--text-primary);
  outline: none;
  min-height: 36px;
  max-height: 120px;
}

.input-area textarea:focus {
  border-color: var(--accent);
}

.btn-send {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 6px;
  background: var(--accent);
  color: var(--bg-primary);
  cursor: pointer;
  flex-shrink: 0;
}

.btn-send:disabled {
  opacity: 0.3;
  cursor: default;
}

.btn-stop {
  background: var(--danger, #e06c75);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
