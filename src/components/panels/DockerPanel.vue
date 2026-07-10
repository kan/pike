<script setup lang="ts">
import { Cable, ExternalLink, Play, RefreshCw, ScrollText, Square, Terminal, Unplug } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { promptDialog } from '../../composables/useConfirmDialog'
import { useI18n } from '../../i18n'
import { dockerContainerPorts, dockerDetectShell, openUrl } from '../../lib/tauri'
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

// Docker Compose derives project name from directory: lowercase, strip non-alphanumeric
const composeProjectName = computed(() => {
  const root = projectStore.activeRoot
  if (!root) return ''
  const dir = root.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() ?? ''
  return dir.toLowerCase().replace(/[^a-z0-9]/g, '')
})

// Match compose services to their containers (filter by project name)
const serviceContainers = computed(() => {
  const project = composeProjectName.value
  const result: Record<string, (typeof dockerStore.containers)[0] | undefined> = {}
  for (const svc of dockerStore.composeServices) {
    result[svc.name] = dockerStore.containers.find(
      (c) => c.composeService === svc.name && (!project || c.composeProject === project),
    )
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

function tunnelsFor(containerId: string | undefined) {
  if (!containerId) return []
  return dockerStore.tunnels.filter((t) => t.targetId === containerId)
}

// Tunnels whose target no longer matches a listed service container
// (target recreated/removed, or non-compose target): still running and
// holding a local port, so they need a visible stop affordance.
const orphanTunnels = computed(() => {
  const shown = new Set<string>()
  for (const c of Object.values(serviceContainers.value)) {
    if (c) shown.add(c.id)
  }
  return dockerStore.tunnels.filter((t) => !shown.has(t.targetId))
})

async function forwardPort(containerId: string) {
  const ports = await dockerContainerPorts(containerId).catch(() => [] as number[])
  const input = await promptDialog(t('docker.forwardPrompt'), ports[0]?.toString() ?? '', ports.join(', '))
  if (input === null) return
  const port = Number.parseInt(input.trim(), 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    dockerStore.error = t('docker.invalidPort')
    return
  }
  await dockerStore.createTunnel(containerId, port)
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
  <div class="docker-panel" data-testid="docker-panel">
    <div v-if="!dockerStore.connected" class="empty">
      {{ t('docker.notReachable') }}
    </div>

    <template v-else>
      <div v-if="!dockerStore.composeServices.length" class="empty">
        {{ t('docker.noCompose') }}
      </div>

      <div v-else class="section">
        <div class="section-header">{{ t('docker.services') }}</div>
        <template v-for="svc in dockerStore.composeServices" :key="svc.name">
          <div class="container-item">
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
                <button
                  v-if="serviceContainers[svc.name]!.state === 'running'"
                  :disabled="dockerStore.tunnelBusy.includes(serviceContainers[svc.name]!.id)"
                  :title="t('docker.forward')"
                  @click="forwardPort(serviceContainers[svc.name]!.id)"
                ><Cable :size="12" :stroke-width="2" /></button>
              </template>
            </div>
          </div>
          <div
            v-for="tun in tunnelsFor(serviceContainers[svc.name]?.id)"
            :key="tun.tunnelId"
            class="tunnel-item"
          >
            <Cable :size="10" class="t-icon" />
            <span class="t-addr">127.0.0.1:{{ tun.localPort }} &rarr; {{ tun.targetPort }}</span>
            <div class="c-actions">
              <button
                :title="t('docker.openBrowser')"
                @click="openUrl(`http://127.0.0.1:${tun.localPort}/`)"
              ><ExternalLink :size="12" :stroke-width="2" /></button>
              <button
                :title="t('docker.stopForward')"
                @click="dockerStore.stopTunnel(tun.tunnelId)"
              ><Unplug :size="12" :stroke-width="2" /></button>
            </div>
          </div>
        </template>
      </div>

      <div v-if="orphanTunnels.length" class="section">
        <div class="section-header">{{ t('docker.orphanTunnels') }}</div>
        <div v-for="tun in orphanTunnels" :key="tun.tunnelId" class="tunnel-item">
          <Cable :size="10" class="t-icon" />
          <span class="t-addr">127.0.0.1:{{ tun.localPort }} &rarr; {{ tun.targetPort }}</span>
          <div class="c-actions">
            <button
              :title="t('docker.openBrowser')"
              @click="openUrl(`http://127.0.0.1:${tun.localPort}/`)"
            ><ExternalLink :size="12" :stroke-width="2" /></button>
            <button
              :title="t('docker.stopForward')"
              @click="dockerStore.stopTunnel(tun.tunnelId)"
            ><Unplug :size="12" :stroke-width="2" /></button>
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

.tunnel-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px 2px 18px;
  border-radius: 3px;
  font-size: 11px;
  color: var(--text-secondary);
}

.tunnel-item:hover {
  background: var(--tab-hover-bg);
}

.tunnel-item:hover .c-actions {
  opacity: 1;
}

.t-icon {
  flex-shrink: 0;
}

.t-addr {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: monospace;
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
