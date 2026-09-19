import { defineStore } from 'pinia'
import { ref } from 'vue'
import { loadJson, saveJson } from '../lib/storage'

/**
 * ブラウザのタブの閲覧履歴（#368）。**マシンごと**に持ち、同期しない（見たページの一覧は
 * マシンの持ち物で、ブックマークとは違って他のマシンで欲しいものではない）。
 * ブックマークは同期の対象なので設定のストアにある（`settingsStore.browserBookmarks`）。
 *
 * **同じ URL は 1 件にまとめる**（開き直したら先頭へ上げ、時刻とタイトルを更新する）。
 * ブラウザの履歴のように訪問ごとに行を足すと、同じ Jira のボードが一覧を埋める。
 */

export interface BrowserVisit {
  url: string
  title: string
  /** 最後に開いた時刻（ISO 8601）。 */
  at: string
}

const STORAGE_KEY = 'pike:browser-history'
/** 件数の上限。超えたら古いものから落とす。 */
const HISTORY_MAX = 500
/** 書き込みをまとめる幅（`save` の doc）。 */
const SAVE_DEBOUNCE_MS = 500

function sanitize(v: unknown): BrowserVisit[] {
  if (!Array.isArray(v)) return []
  return v
    .filter(
      (e): e is BrowserVisit => typeof e?.url === 'string' && typeof e?.title === 'string' && typeof e?.at === 'string',
    )
    .slice(0, HISTORY_MAX)
}

export const useBrowserStore = defineStore('browser', () => {
  const history = ref<BrowserVisit[]>(sanitize(loadJson(STORAGE_KEY, [])))

  /**
   * 書き込みは少し待ってまとめる。**1 回の移動で 2 回書く**（読み込みの完了とタイトル）うえ、
   * 未読の件数をタイトルに出すページ（Jira やチャット）はタイトルを変え続けるので、そのたびに
   * 最大 500 件を丸ごと書き直すことになる。閉じるときは待たずに書く。
   */
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  function flush() {
    if (saveTimer === undefined) return
    clearTimeout(saveTimer)
    saveTimer = undefined
    saveJson(STORAGE_KEY, history.value)
  }
  function save() {
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      saveJson(STORAGE_KEY, history.value)
    }, SAVE_DEBOUNCE_MS)
  }
  window.addEventListener('beforeunload', flush)

  /** ページの読み込みが終わった。タイトルはまだ分からないことがある（あとで `setTitle`）。 */
  function recordVisit(url: string, title?: string) {
    const prev = history.value.find((v) => v.url === url)
    const visit = { url, title: title || prev?.title || url, at: new Date().toISOString() }
    history.value = [visit, ...history.value.filter((v) => v.url !== url)].slice(0, HISTORY_MAX)
    save()
  }

  /** ページのタイトルが分かった・変わった。履歴に無い URL には何もしない。 */
  function setTitle(url: string, title: string) {
    const prev = history.value.find((v) => v.url === url)
    if (!prev || prev.title === title) return
    // その 1 行だけを書き換える（配列を作り直すと一覧が丸ごと描き直される）。
    prev.title = title
    save()
  }

  function removeVisit(url: string) {
    history.value = history.value.filter((v) => v.url !== url)
    save()
  }

  function clearHistory() {
    history.value = []
    save()
  }

  // 他のウィンドウが書いたぶんを拾う。localStorage はウィンドウ間で共有されていて、
  // `storage` イベントは**書いたウィンドウ以外**で発火する。
  // 読み直さず、イベントに載っている値をそのまま使う。
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return
    try {
      history.value = sanitize(e.newValue ? JSON.parse(e.newValue) : [])
    } catch {
      // 壊れた値は無視して手元の一覧を残す。
    }
  })

  return { history, recordVisit, setTitle, removeVisit, clearHistory }
})
