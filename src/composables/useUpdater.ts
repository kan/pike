import { ref, computed } from 'vue'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { getVersion } from '@tauri-apps/api/app'

type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'upToDate' | 'error'

const state = ref<UpdateState>('idle')
const pendingUpdate = ref<Update | null>(null)
const updateVersion = ref('')
const appVersion = ref('')
const errorMessage = ref('')

let initialCheckDone = false
let versionLoaded = false

export const hasUpdate = computed(() => state.value === 'available')

export function useUpdater() {
  if (!versionLoaded) {
    versionLoaded = true
    getVersion().then((v) => (appVersion.value = v))
  }

  async function checkForUpdate() {
    state.value = 'checking'
    try {
      const update = await check()
      if (update) {
        pendingUpdate.value = update
        updateVersion.value = update.version
        state.value = 'available'
      } else {
        state.value = 'upToDate'
      }
    } catch (e) {
      errorMessage.value = String(e)
      state.value = 'error'
    }
  }

  async function downloadAndInstall() {
    if (!pendingUpdate.value) return
    state.value = 'downloading'
    try {
      await pendingUpdate.value.downloadAndInstall()
      await relaunch()
    } catch (e) {
      errorMessage.value = String(e)
      state.value = 'error'
    }
  }

  function checkOnceInBackground() {
    if (initialCheckDone) return
    initialCheckDone = true
    check()
      .then((update) => {
        if (update) {
          pendingUpdate.value = update
          updateVersion.value = update.version
          state.value = 'available'
        }
      })
      .catch(() => {})
  }

  return {
    state,
    appVersion,
    updateVersion,
    errorMessage,
    hasUpdate,
    checkForUpdate,
    downloadAndInstall,
    checkOnceInBackground,
  }
}
