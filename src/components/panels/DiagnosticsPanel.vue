<script setup lang="ts">
import { Bot, CircleAlert, TriangleAlert } from 'lucide-vue-next'
import { onMounted } from 'vue'
import { injectToTerminal } from '../../composables/useTerminalInject'
import { useI18n } from '../../i18n'
import { basename, isAbsolutePath, pathSep } from '../../lib/paths'
import { useDiagnosticsStore } from '../../stores/diagnostics'
import { useProjectStore } from '../../stores/project'
import { useTabStore } from '../../stores/tabs'
import type { Diagnostic } from '../../types/diagnostics'

const { t } = useI18n()
const diagStore = useDiagnosticsStore()
const projectStore = useProjectStore()
const tabStore = useTabStore()

function openDiagnostic(d: Diagnostic) {
  const project = projectStore.currentProject
  if (!project) return
  const fullPath = isAbsolutePath(d.file) ? d.file : projectStore.activeRoot + pathSep(project.shell) + d.file
  tabStore.addEditorTab({ path: fullPath, initialLine: d.line })
}

// Inject a fix request for this diagnostic into the terminal agent.
function askAgentFix(d: Diagnostic) {
  const loc = `${d.file}:${d.line}:${d.column}`
  injectToTerminal(t('diagnostics.fixPrompt', { loc, source: d.source, message: d.message }))
}

const fileName = basename

function fileDir(path: string): string {
  const name = basename(path)
  return path.length > name.length ? path.slice(0, path.length - name.length - 1) : ''
}

onMounted(() => {
  if (!diagStore.lastRunAt && !diagStore.running) diagStore.run()
})
</script>

<template>
  <div class="diag-panel">
    <div v-if="diagStore.running" class="status">{{ t('diagnostics.running') }}</div>
    <div v-else-if="diagStore.error" class="status error">{{ diagStore.error }}</div>
    <div v-else-if="!diagStore.total && diagStore.lastRunAt" class="status">
      {{ t('diagnostics.noProblems') }}
    </div>
    <div v-else-if="!diagStore.lastRunAt" class="status">{{ t('diagnostics.idle') }}</div>

    <div
      v-for="prov in diagStore.providers.filter((p) => !p.ok)"
      :key="`err-${prov.name}-${prov.dir}`"
      class="provider-error"
      :title="prov.error ?? ''"
    >
      {{ prov.name }}<span v-if="prov.dir"> ({{ prov.dir }})</span>: {{ t('diagnostics.providerFailed') }}
    </div>

    <div v-for="group in diagStore.grouped" :key="group.source" class="lang-group">
      <div class="lang-header">
        <span class="lang-name">{{ group.source }}</span>
        <span class="lang-counts">
          <span v-if="group.errorCount" class="count error">{{ group.errorCount }}</span>
          <span v-if="group.warningCount" class="count warning">{{ group.warningCount }}</span>
        </span>
      </div>

      <div v-for="fg in group.files" :key="fg.file" class="file-group">
        <div class="file-header" :title="fg.file" @click="openDiagnostic(fg.diagnostics[0])">
          <span class="file-name">{{ fileName(fg.file) }}</span>
          <span v-if="fileDir(fg.file)" class="file-dir">{{ fileDir(fg.file) }}</span>
        </div>
        <div
          v-for="(d, i) in fg.diagnostics"
          :key="i"
          class="diag-row"
          @click="openDiagnostic(d)"
        >
          <CircleAlert v-if="d.severity === 'error'" :size="13" class="sev error" />
          <TriangleAlert v-else :size="13" class="sev warning" />
          <span class="diag-msg">{{ d.message }}</span>
          <span class="diag-loc">{{ d.line }}:{{ d.column }}</span>
          <button class="diag-action" :title="t('diagnostics.askFix')" @click.stop="askAgentFix(d)">
            <Bot :size="13" :stroke-width="2" />
          </button>
        </div>
      </div>
    </div>

    <div v-if="diagStore.truncated" class="status truncated">{{ t('diagnostics.truncated') }}</div>
  </div>
</template>

<style scoped>
.diag-panel {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.status {
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
  padding: 8px 0;
}

.status.error {
  color: var(--danger);
}

.status.truncated {
  font-size: 11px;
  padding: 4px 0;
}

.provider-error {
  font-size: 11px;
  color: var(--danger);
  padding: 2px 4px;
}

.lang-group {
  margin-bottom: 6px;
}

.lang-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
  padding: 4px 2px 2px;
}

.lang-counts {
  display: flex;
  gap: 6px;
}

.count {
  font-weight: 700;
}

.count.error {
  color: var(--danger);
}

.count.warning {
  color: #d7a000;
}

.file-group {
  margin-bottom: 2px;
}

.file-header {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: 3px;
  overflow: hidden;
}

.file-header:hover {
  background: var(--tab-hover-bg);
}

.file-name {
  font-size: 12px;
  color: var(--accent);
  white-space: nowrap;
}

.file-dir {
  font-size: 10px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.diag-row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 4px 2px 10px;
  cursor: pointer;
  border-radius: 3px;
}

.diag-row:hover {
  background: var(--tab-hover-bg);
}

.sev {
  flex-shrink: 0;
}

.sev.error {
  color: var(--danger);
}

.sev.warning {
  color: #d7a000;
}

.diag-msg {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.diag-loc {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-secondary);
}

.diag-action {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  opacity: 0;
}

.diag-row:hover .diag-action {
  opacity: 1;
}

.diag-action:hover {
  background: var(--accent);
  color: var(--text-active);
}
</style>
