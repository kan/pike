<script setup lang="ts">
import { Play, RefreshCw, ScrollText, Square, Terminal } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from '../../i18n'
import { dockerDetectShell } from '../../lib/tauri'
import { useDockerStore } from '../../stores/docker'
import { useProjectStore } from '../../stores/project'
import { useSidebarStore } from '../../stores/sidebar'
import { useTabStore } from '../../stores/tabs'

const { t } = useI18n()

const dockerStore = useDockerStore()
const tabStore = useTabStore()
const projectStore = useProjectStore()
const sidebar = useSidebarStore()

function stateColor(state: string): string {
  switch (state) {
    case 'running':
      return 'var(--git-add)'
    case 'exited':
      return 'var(--text-secondary)'
    case 'restarting':
      return 'var(--git-modify)'
    case 'paused':
      return 'var(--git-modify)'
    default:
      return 'var(--text-secondary)'
  }
}

// Match compose services to their containers
const serviceContainers = computed(() => {
  const result: Record<string, (typeof dockerStore.containers)[0] | undefined> = {}
  for (const svc of dockerStore.composeServices) {
    result[svc.name] = dockerStore.containers.find((c) => c.composeService === svc.name)
  }
  return result
})

function openLogs(containerId: string, containerName: string) {
  tabStore.addDockerLogsTab({ containerId, containerName })
}

async function openShell(containerId: string, containerName: string) {
  try {
    const shell = await dockerDetectShell(containerId)
    const project = projectStore.currentProject
    tabStore.addTerminalTab({
      title: `${containerName} shell`,
      shell: project?.shell,
      autoStart: `docker exec -it ${containerId} ${shell}`,
    })
  } catch (e) {
    dockerStore.error = String(e)
  }
}

function refreshIfActive() {
  if (sidebar.activePanel === 'docker') {
    dockerStore.refreshAll()
    dockerStore.startPolling()
  } else {
    dockerStore.stopPolling()
  }
}

watch(() => sidebar.activePanel, refreshIfActive)
watch(
  () => projectStore.currentProject?.id,
  () => {
    if (sidebar.activePanel === 'docker') dockerStore.refreshAll()
  },
)

onMounted(refreshIfActive)
onUnmounted(() => dockerStore.stopPolling())
</script>

<template>
  <div class="docker-panel">
    <div v-if="!dockerStore.connected" class="empty">
      {{ t('docker.notReachable') }}
    </div>

    <template v-else>
      <div v-if="!dockerStore.composeServices.length" class="empty">
        {{ t('docker.noCompose') }}
      </div>

      <div v-else class="section">
        <div class="section-header">{{ t('docker.services') }}</div>
        <div
          v-for="svc in dockerStore.composeServices"
          :key="svc.name"
          class="container-item"
        >
          <span
            class="state-dot"
            :style="{ background: stateColor(serviceContainers[svc.name]?.state ?? '') }"
          ></span>
          <span class="c-name">{{ svc.name }}</span>
          <span class="c-status">{{ serviceContainers[svc.name]?.status ?? t('docker.notCreated') }}</span>
          <div class="c-actions">
            <template v-if="serviceContainers[svc.name]">
              <button
                v-if="serviceContainers[svc.name]!.state !== 'running'"
                :title="t('docker.start')"
                @click="dockerStore.startContainer(serviceContainers[svc.name]!.id)"
              ><Play :size="12" :stroke-width="2" /></button>
              <button
                v-if="serviceContainers[svc.name]!.state === 'running'"
                :title="t('docker.stop')"
                @click="dockerStore.stopContainer(serviceContainers[svc.name]!.id)"
              ><Square :size="12" :stroke-width="2" /></button>
              <button
                :title="t('docker.restart')"
                @click="dockerStore.restartContainer(serviceContainers[svc.name]!.id)"
              ><RefreshCw :size="12" :stroke-width="2" /></button>
              <button
                :title="t('docker.logs')"
                @click="openLogs(serviceContainers[svc.name]!.id, svc.name)"
              ><ScrollText :size="12" :stroke-width="2" /></button>
              <button
                v-if="serviceContainers[svc.name]!.state === 'running'"
                :title="t('docker.shell')"
                @click="openShell(serviceContainers[svc.name]!.id, svc.name)"
              ><Terminal :size="12" :stroke-width="2" /></button>
            </template>
          </div>
        </div>
      </div>

      <div v-if="dockerStore.error" class="error-msg">{{ dockerStore.error }}</div>
    </template>
  </div>
</template>

<style scoped>
.docker-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section {
  display: flex;
  flex-direction: column;
}

.section-header {
  padding: 4px 0;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-secondary);
}

.container-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px;
  border-radius: 3px;
  font-size: 12px;
}

.container-item:hover {
  background: var(--tab-hover-bg);
}

.state-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.c-name {
  color: var(--text-primary);
  font-weight: 500;
  flex-shrink: 0;
}

.c-status {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-secondary);
}

.c-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
}

.container-item:hover .c-actions {
  opacity: 1;
}

.c-actions button {
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.c-actions button:hover {
  background: var(--accent);
  color: var(--text-active);
}

.empty {
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
  padding: 16px 0;
}

.error-msg {
  color: var(--danger);
  font-size: 11px;
  padding: 4px;
}
</style>
