import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ContainerInfo, ComposeService } from '../types/docker'
import {
  dockerPing,
  dockerComposeServices,
  dockerListContainers,
  dockerStart,
  dockerStop,
  dockerRestart,
} from '../lib/tauri'
import { useProjectStore } from './project'

export const useDockerStore = defineStore('docker', () => {
  const connected = ref(false)
  const containers = ref<ContainerInfo[]>([])
  const composeServices = ref<ComposeService[]>([])
  const error = ref<string | null>(null)

  let pollTimer: ReturnType<typeof setInterval> | null = null
  const refreshing = ref(false)
  let refreshGuard = false

  async function checkConnection() {
    connected.value = await dockerPing().catch(() => false)
  }

  async function refreshContainers(showProgress = false) {
    if (refreshGuard) return
    refreshGuard = true
    if (showProgress) refreshing.value = true
    const minDelay = showProgress ? new Promise(r => setTimeout(r, 300)) : null
    try {
      const [c] = await Promise.all([dockerListContainers(), minDelay])
      containers.value = c
      error.value = null
    } catch (e) {
      error.value = String(e)
      if (minDelay) await minDelay
    } finally {
      refreshGuard = false
      refreshing.value = false
    }
  }

  async function refreshComposeServices() {
    const project = useProjectStore().currentProject
    if (!project) {
      composeServices.value = []
      return
    }
    try {
      composeServices.value = await dockerComposeServices(project.root, project.shell)
    } catch {
      composeServices.value = []
    }
  }

  async function refreshAll() {
    await checkConnection()
    if (connected.value) {
      await Promise.all([refreshContainers(), refreshComposeServices()])
    }
  }

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

  function startPolling() {
    stopPolling()
    pollTimer = setInterval(refreshContainers, 5000)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  return {
    connected,
    containers,
    composeServices,
    error,
    refreshing,
    refreshAll,
    refreshContainers,
    startContainer,
    stopContainer,
    restartContainer,
    startPolling,
    stopPolling,
  }
})
