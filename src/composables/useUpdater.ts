import { getVersion } from '@tauri-apps/api/app'
import { relaunch } from '@tauri-apps/plugin-process'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { computed, markRaw, type Raw, ref } from 'vue'
import { saveAllWindowState } from '../lib/tauri'
import { useProjectStore } from '../stores/project'
import { confirmBusyExit } from './useBusyExit'

type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'upToDate' | 'error'

/** 起動後の自動チェックの間隔。起動しっぱなしでも新しいリリースに追従する（#414） */
const BACKGROUND_CHECK_INTERVAL_MS = 60 * 60 * 1000

const state = ref<UpdateState>('idle')
const pendingUpdate = ref<Raw<Update> | null>(null)
const updateVersion = computed(() => pendingUpdate.value?.version ?? '')
const appVersion = ref('')
const errorMessage = ref('')

let backgroundStarted = false
let versionLoaded = false
let inflight: Promise<Update | null> | null = null
/**
 * `pendingUpdate` を適用しようとしている。確認ダイアログを出した時点から立てる。
 * このあいだは差し替えない（閉じるとダウンロードが壊れるし、ダイアログで見せた版と
 * 違う版を入れることにもなる）
 */
let installing = false

export const hasUpdate = computed(() => state.value === 'available')
/** 確認中・ダウンロード中。表示はその操作が持っているので、ほかから書き換えない */
const busy = computed(() => state.value === 'checking' || state.value === 'downloading')

/**
 * `latest.json` を取り直す。同時に走っている確認があればそれに相乗りする。
 *
 * **結果は毎回置き換える**（#414）。一度「更新あり」になったあとも取り直さないと、
 * さらに新しいリリースが出ても最初に見つけた版のまま固定される。
 */
function fetchLatest(): Promise<Update | null> {
  if (installing) return Promise.resolve(pendingUpdate.value)
  inflight ??= check()
    .then((update) => {
      // 取得中に適用が始まった
      if (installing) {
        update?.close().catch(() => {})
        return pendingUpdate.value
      }
      // 古い Update は Rust 側のリソースを握っているので手放す
      pendingUpdate.value?.close().catch(() => {})
      pendingUpdate.value = update ? markRaw(update) : null
      return update
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function useUpdater() {
  if (!versionLoaded) {
    versionLoaded = true
    getVersion().then((v) => (appVersion.value = v))
  }

  /** 確認し直して、結果の状態を返す。ダウンロード中は何もせず `'downloading'` を返す */
  async function checkForUpdate(): Promise<UpdateState> {
    if (state.value === 'downloading') return state.value
    state.value = 'checking'
    try {
      state.value = (await fetchLatest()) ? 'available' : 'upToDate'
    } catch (e) {
      errorMessage.value = String(e)
      // 先に見つけてある更新は有効なので、取り直しに失敗しても適用できるままにする
      state.value = pendingUpdate.value ? 'available' : 'error'
    }
    return state.value
  }

  async function downloadAndInstall() {
    const update = pendingUpdate.value
    if (!update || installing) return
    installing = true
    // 更新は Pike ごと終了して再起動するので、ウィンドウを閉じるときと同じ確認を取る（#178）。
    // **ダウンロードより前に聞く**: Windows のインストーラは適用した時点でアプリを終わらせるので、
    // 後から聞く機会が無い。断られたら更新は始めない（「更新あり」の状態のまま）。
    if (!(await confirmBusyExit())) {
      installing = false
      return
    }
    state.value = 'downloading'
    try {
      await update.downloadAndInstall()
      // relaunch() bypasses beforeunload, so save state explicitly
      await useProjectStore().saveSessionNow()
      await saveAllWindowState().catch(() => {})
      await relaunch()
    } catch (e) {
      installing = false
      errorMessage.value = String(e)
      state.value = 'error'
    }
  }

  /** 起動時と、その後 1 時間ごとに黙って確認する。失敗は表示を変えない（手動の確認で見せる） */
  function startBackgroundCheck() {
    if (backgroundStarted) return
    backgroundStarted = true
    const run = () => {
      if (busy.value) return
      fetchLatest()
        .then((update) => {
          // 取得中に手動の確認や適用が始まったら、表示はそちらに任せる
          if (busy.value) return
          if (update) state.value = 'available'
          else if (state.value === 'available') state.value = 'idle'
        })
        .catch(() => {})
    }
    run()
    setInterval(run, BACKGROUND_CHECK_INTERVAL_MS)
  }

  return {
    state,
    busy,
    appVersion,
    updateVersion,
    errorMessage,
    hasUpdate,
    checkForUpdate,
    downloadAndInstall,
    startBackgroundCheck,
  }
}
