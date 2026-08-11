<script setup lang="ts">
import { Cable, ExternalLink, Play, RefreshCw, ScrollText, Square, Terminal, Unplug } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { promptDialog } from '../../composables/useConfirmDialog'
import { useI18n } from '../../i18n'
import { basename, joinPath, normalizeSep, pathSep } from '../../lib/paths'
import { dockerContainerPorts, dockerDetectShell, openUrl } from '../../lib/tauri'
import { useDockerStore } from '../../stores/docker'
import { useProjectStore } from '../../stores/project'
import { useSidebarStore } from '../../stores/sidebar'
import { useTabStore } from '../../stores/tabs'
import type { ComposeProject } from '../../types/docker'

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

/** Path comparison for the working-dir label: separators and case can differ. */
function samePath(a: string | null, b: string): boolean {
  return !!a && normalizeSep(a).replace(/\/+$/, '').toLowerCase() === normalizeSep(b).replace(/\/+$/, '').toLowerCase()
}

// Each compose file with its services already resolved to containers, so the
// template reads one value per row. Two compose files can declare the same
// service name, so a container only counts for the file it was started from:
// `composeWorkingDir` is Compose's own record of that, and the derived project
// name is the fallback for containers from older Compose versions.
const groups = computed(() =>
  dockerStore.composeProjects.map((proj) => ({
    ...proj,
    rows: proj.services.map((svc) => ({
      name: svc.name,
      container: dockerStore.containers.find(
        (c) =>
          c.composeService === svc.name &&
          (c.composeWorkingDir ? samePath(c.composeWorkingDir, proj.dir) : c.composeProject === proj.name),
      ),
    })),
  })),
)

/** Open the compose file itself, like the task panel's group heading (#159). */
function openComposeFile(proj: ComposeProject) {
  const shell = projectStore.currentProject?.shell
  tabStore.addEditorTab({ path: joinPath(proj.dir, basename(proj.file), pathSep(shell)) })
}

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
  const shown = new Set(groups.value.flatMap((g) => g.rows.map((r) => r.container?.id)))
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
      <div v-if="!dockerStore.composeProjects.length" class="empty">
        {{ t('docker.noCompose') }}
      </div>

      <div v-for="proj in groups" :key="proj.file" class="section">
        <div class="section-header group-header">
          <button class="g-file" :title="t('docker.openComposeFile')" @click="openComposeFile(proj)">
            {{ proj.file }}
          </button>
          <div class="c-actions always">
            <button :title="t('docker.composeUp')" @click="dockerStore.composeUp(proj)">
              <Play :size="12" :stroke-width="2" />
            </button>
            <button :title="t('docker.composeDown')" @click="dockerStore.composeDown(proj)">
              <Square :size="12" :stroke-width="2" />
            </button>
          </div>
        </div>
        <template v-for="row in proj.rows" :key="row.name">
          <div class="container-item">
            <span class="state-dot" :style="{ background: stateColor(row.container?.state ?? '') }"></span>
            <span class="c-name">{{ row.name }}</span>
            <span class="c-status">{{ row.container?.status ?? t('docker.notCreated') }}</span>
            <div class="c-actions">
              <template v-if="row.container">
                <button
                  v-if="row.container.state !== 'running'"
                  :title="t('docker.start')"
                  @click="dockerStore.startContainer(row.container.id)"
                ><Play :size="12" :stroke-width="2" /></button>
                <button
                  v-if="row.container.state === 'running'"
                  :title="t('docker.stop')"
                  @click="dockerStore.stopContainer(row.container.id)"
                ><Square :size="12" :stroke-width="2" /></button>
                <button
                  :title="t('docker.restart')"
                  @click="dockerStore.restartContainer(row.container.id)"
                ><RefreshCw :size="12" :stroke-width="2" /></button>
                <button
                  :title="t('docker.logs')"
                  @click="openLogs(row.container.id, row.name)"
                ><ScrollText :size="12" :stroke-width="2" /></button>
                <button
                  v-if="row.container.state === 'running'"
                  :title="t('docker.shell')"
                  @click="openShell(row.container.id, row.name)"
                ><Terminal :size="12" :stroke-width="2" /></button>
                <button
                  v-if="row.container.state === 'running'"
                  :disabled="dockerStore.tunnelBusy.includes(row.container.id)"
                  :title="t('docker.forward')"
                  @click="forwardPort(row.container.id)"
                ><Cable :size="12" :stroke-width="2" /></button>
              </template>
            </div>
          </div>
          <div v-for="tun in tunnelsFor(row.container?.id)" :key="tun.tunnelId" class="tunnel-item">
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

.group-header {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* A path, so it keeps its own casing — unlike the uppercased section labels. */
.g-file {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0;
  border: none;
  background: transparent;
  text-align: left;
  text-transform: none;
  letter-spacing: normal;
  font-family: monospace;
  font-size: inherit;
  color: inherit;
  cursor: pointer;
}

.g-file:hover {
  color: var(--accent);
  text-decoration: underline;
}

/* compose up/down stay visible: they were always-on in the sidebar header. */
.c-actions.always {
  opacity: 1;
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
