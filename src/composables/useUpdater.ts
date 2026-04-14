import { getVersion } from '@tauri-apps/api/app'
import { relaunch } from '@tauri-apps/plugin-process'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { computed, markRaw, type Raw, ref } from 'vue'
import { saveAllWindowState } from '../lib/tauri'
import { useProjectStore } from '../stores/project'

type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'upToDate' | 'error'

const state = ref<UpdateState>('idle')
const pendingUpdate = ref<Raw<Update> | null>(null)
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
        pendingUpdate.value = markRaw(update)
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
      // relaunch() bypasses beforeunload, so save state explicitly
      await useProjectStore().saveSessionNow()
      await saveAllWindowState().catch(() => {})
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
          pendingUpdate.value = markRaw(update)
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
