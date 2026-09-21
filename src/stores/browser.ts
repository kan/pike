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
   * **行の増減は待たずに書き、タイトルの更新だけ待ってまとめる**（#368）。
   *
   * 待つのは、未読の件数をタイトルに出すページ（Jira やチャット）がタイトルを変え続け、
   * そのたびに最大 500 件を丸ごと書き直すことになるため。一方、行を作る
   * （`recordVisit`）のも消す（`removeVisit` / `clearHistory`）のも**人の操作ぶんしか
   * 頻度が無い**ので、まとめる意味が無い。
   *
   * **この分け方が、他のウィンドウとの取り合いの形を決めている**（`storage` の隣の doc）。
   * 書くのを待っているあいだに相手の一覧を受けると、その待っているぶんは失われる。
   * 待つのをタイトルだけにしておけば、失うのはタイトル 1 つ（次の訪問で入り直す）で
   * 済み、**行そのものは消えない**。
   */
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  /** 行が増えた・減った。待たずに書く（保留があれば捨てる）。 */
  function saveNow() {
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = undefined
    saveJson(STORAGE_KEY, history.value)
  }
  /** タイトルの更新用。まとめて少しあとに書く。 */
  function saveSoon() {
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS)
  }
  window.addEventListener('beforeunload', saveNow)

  /** ページの読み込みが終わった。タイトルはまだ分からないことがある（あとで `setTitle`）。 */
  function recordVisit(url: string, title?: string) {
    const prev = history.value.find((v) => v.url === url)
    const visit = { url, title: title || prev?.title || url, at: new Date().toISOString() }
    history.value = [visit, ...history.value.filter((v) => v.url !== url)].slice(0, HISTORY_MAX)
    saveNow()
  }

  /** ページのタイトルが分かった・変わった。履歴に無い URL には何もしない。 */
  function setTitle(url: string, title: string) {
    const prev = history.value.find((v) => v.url === url)
    if (!prev || prev.title === title) return
    // その 1 行だけを書き換える（配列を作り直すと一覧が丸ごと描き直される）。
    prev.title = title
    saveSoon()
  }

  function removeVisit(url: string) {
    history.value = history.value.filter((v) => v.url !== url)
    saveNow()
  }

  function clearHistory() {
    history.value = []
    saveNow()
  }

  // 他のウィンドウが書いたぶんを拾う。localStorage はウィンドウ間で共有されていて、
  // `storage` イベントは**書いたウィンドウ以外**で発火する。
  // 読み直さず、イベントに載っている値をそのまま使う。
  //
  // **届いた一覧をそのまま採る**（#368）。**和集合にしないこと**: 削除は「その行が
  // 無い」という形でしか届かないので、足し合わせると B で消した行を A が持ち続け、
  // A が次に保存した時点で B にも戻る。
  //
  // 丸ごと採ってよいのは、**待っているのがタイトルの更新だけ**だから（`saveSoon` の
  // 隣の doc）。行を作る・消す操作は待たずに書いてあるので、ここで失われるのは
  // タイトル 1 つだけで済む。待っていたぶんは捨てる（タイマーも止める）:
  // 手元の一覧はもう相手のものに揃っていて、それを書き戻す意味が無い。
  //
  // **クロスウィンドウの状態を足すときの選び方**: マシンごとで、大きく、書いた側が
  // 唯一の権威ではないものは `storage`（ここ）。小さくて書いた側が権威なら
  // `pike://…-changed` の broadcast（`stores/settings.ts`）。履歴は 100KB 級になるので
  // IPC には載せない。
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return
    try {
      const theirs = sanitize(e.newValue ? JSON.parse(e.newValue) : [])
      if (saveTimer !== undefined) clearTimeout(saveTimer)
      saveTimer = undefined
      history.value = theirs
    } catch {
      // 壊れた値は無視して手元の一覧を残す。
    }
  })

  return { history, recordVisit, setTitle, removeVisit, clearHistory }
})
