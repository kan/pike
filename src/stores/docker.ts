import { defineStore } from 'pinia'
import { ref } from 'vue'
import { confirmDialog } from '../composables/useConfirmDialog'
import { t } from '../i18n'
import {
  dockerComposeDiscover,
  dockerListContainers,
  dockerPing,
  dockerRestart,
  dockerStart,
  dockerStop,
  dockerTunnelCreate,
  dockerTunnelStop,
} from '../lib/tauri'
import type { ComposeProject, ContainerInfo, TunnelInfo } from '../types/docker'
import { useProjectStore } from './project'
import { useTabStore } from './tabs'

export const useDockerStore = defineStore('docker', () => {
  const connected = ref(false)
  const containers = ref<ContainerInfo[]>([])
  const composeProjects = ref<ComposeProject[]>([])
  const tunnels = ref<TunnelInfo[]>([])
  const tunnelBusy = ref<string[]>([])
  const error = ref<string | null>(null)

  let pollTimer: ReturnType<typeof setInterval> | null = null
  let pollAbort: AbortController | null = null
  const refreshing = ref(false)
  let refreshGuard = false

  async function checkConnection() {
    connected.value = await dockerPing().catch(() => false)
  }

  async function refreshContainers(showProgress = false) {
    if (refreshGuard) return
    refreshGuard = true
    if (showProgress) refreshing.value = true
    const minDelay = showProgress ? new Promise((r) => setTimeout(r, 300)) : null
    try {
      const [r] = await Promise.all([dockerListContainers(), minDelay])
      containers.value = r.containers
      tunnels.value = r.tunnels
      error.value = null
    } catch (e) {
      error.value = String(e)
      if (minDelay) await minDelay
    } finally {
      refreshGuard = false
      refreshing.value = false
    }
  }

  async function refreshComposeProjects() {
    const projectStore = useProjectStore()
    const project = projectStore.currentProject
    if (!project) {
      composeProjects.value = []
      return
    }
    try {
      composeProjects.value = await dockerComposeDiscover(projectStore.activeRoot, project.shell)
    } catch {
      composeProjects.value = []
    }
  }

  async function refreshAll() {
    await checkConnection()
    if (connected.value) {
      await Promise.all([refreshContainers(), refreshComposeProjects()])
    }
  }

  /**
   * Run a compose command in a terminal tab (confirm first) so the user sees
   * the output. The tab starts in the directory that compose file was found in,
   * and the panel's polling picks up the resulting container-state changes.
   */
  async function runCompose(target: ComposeProject, command: string, confirmMsg: string) {
    const project = useProjectStore().currentProject
    if (!project) return
    if (!(await confirmDialog(`${confirmMsg}\n\n${target.file}`))) return
    useTabStore().runCommandTab(command, target.dir, project.shell)
  }

  const composeUp = (target: ComposeProject) => runCompose(target, 'docker compose up -d', t('docker.composeUpConfirm'))
  const composeDown = (target: ComposeProject) =>
    runCompose(target, 'docker compose down', t('docker.composeDownConfirm'))

  async function startContainer(id: string) {
    try {
      await dockerStart(id)
      await refreshContainers()
    } catch (e) {
      error.value = String(e)
    }
  }

  async function stopContainer(id: string) {
    try {
      await dockerStop(id)
      await refreshContainers()
    } catch (e) {
      error.value = String(e)
    }
  }

  async function restartContainer(id: string) {
    try {
      await dockerRestart(id)
      await refreshContainers()
    } catch (e) {
      error.value = String(e)
    }
  }

  async function createTunnel(containerId: string, port: number) {
    tunnelBusy.value = [...tunnelBusy.value, containerId]
    try {
      await dockerTunnelCreate(containerId, port)
      await refreshContainers()
    } catch (e) {
      error.value = String(e)
    } finally {
      tunnelBusy.value = tunnelBusy.value.filter((id) => id !== containerId)
    }
  }

  async function stopTunnel(tunnelId: string) {
    try {
      await dockerTunnelStop(tunnelId)
      await refreshContainers()
    } catch (e) {
      error.value = String(e)
    }
  }

  function startTimer() {
    clearTimer()
    pollTimer = setInterval(refreshContainers, 5000)
  }

  function clearTimer() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function startPolling() {
    stopPolling()
    if (document.hasFocus()) startTimer()
    pollAbort = new AbortController()
    const { signal } = pollAbort
    window.addEventListener(
      'blur',
      () => {
        clearTimer()
      },
      { signal },
    )
    window.addEventListener(
      'focus',
      () => {
        refreshContainers()
        startTimer()
      },
      { signal },
    )
  }

  function stopPolling() {
    clearTimer()
    pollAbort?.abort()
    pollAbort = null
  }

  return {
    connected,
    containers,
    composeProjects,
    tunnels,
    tunnelBusy,
    error,
    refreshing,
    refreshAll,
    refreshContainers,
    refreshComposeProjects,
    startContainer,
    stopContainer,
    restartContainer,
    composeUp,
    composeDown,
    createTunnel,
    stopTunnel,
    startPolling,
    stopPolling,
  }
})
