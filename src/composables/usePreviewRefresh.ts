import { computed, onUnmounted, type Ref, watch } from 'vue'
import type { ProjectPlatform } from '../lib/projectPaths'
import { isSameOrUnder, relativeToBase } from '../lib/projectPaths'
import { useProjectStore } from '../stores/project'
import { fsWatcher } from './useFsWatcher'

/**
 * 子 webview のプレビュー（HTML の #399、Vue SFC の #397）を、**ディスクの変化で描き直す**
 * 段取り。何を描き直すか（再読み込み・描画のやり直し）と、どのファイルが効くかだけが
 * 呼び出し側の持ち物で、いつ描き直すかはここにしか書かない。
 *
 * - **見えていないあいだは印だけ付け、見えたときに 1 回描き直す**。続けて来たら畳む
 * - **監視は今の `activeRoot` しか見ない**ので、配信のルートがその範囲に入っていない
 *   （プロジェクトの外のファイル、別プロジェクトへ切り替えて保持しているあいだ、worktree の
 *   切り替え）ときは変更が届かない。そのあいだは保存の側（`onSaved`）から描き直し、範囲へ
 *   戻ったときに 1 回描き直す
 * - **範囲の中では保存の側から描き直さない**: 監視からも同じ保存が来るが、Rust の監視は
 *   最長 1 秒まとめてから送るので、畳めずに 2 回描き直す
 * - **自分の保存も監視から拾う**: `isRecentlySaved` の印は App.vue が消費するもので、ここでは
 *   読まない（`useFsWatcher` の doc）
 */
interface Served {
  root: string
  platform: ProjectPlatform
}

export interface PreviewRefreshOptions<S extends Served> {
  view: { ready: () => boolean; shown: Readonly<Ref<boolean>> }
  /** 配信しているルート。子 webview を作った時点で固定する。まだ無ければ null。 */
  served: Readonly<Ref<S | null>>
  /**
   * 変わったファイル（絶対パス）を先にふるう安い判定（拡張子など）。**監視の通知は一度に
   * 数千件来ることがある**（checkout や生成物）ので、ルートからの相対パスを作る前に落とす。
   */
  accepts?: (path: string) => boolean
  /** ルートからの相対パス（区切りは `/`）のファイルが変わったら描き直すか。省略すれば全部。 */
  affects?: (rel: string, served: S) => boolean
  /** 描き直す。 */
  refresh: () => void
}

export function usePreviewRefresh<S extends Served>(opts: PreviewRefreshOptions<S>) {
  const projectStore = useProjectStore()

  const covered = computed(() => {
    const s = opts.served.value
    const active = projectStore.activeRoot
    if (!s || !active) return false
    return isSameOrUnder(active, s.root, s.platform)
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  let stale = false

  function schedule() {
    if (!opts.view.ready()) return
    if (!opts.view.shown.value) {
      stale = true
      return
    }
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      stale = false
      if (opts.view.ready()) opts.refresh()
    }, 200)
  }

  watch(opts.view.shown, (v) => {
    if (v && stale) schedule()
  })

  watch(covered, (c) => {
    if (!c) stale = true
  })

  /** 保存した直後（`EditorTab` が呼ぶ）。監視の範囲に入っているなら何もしない。 */
  function onSaved() {
    if (!covered.value) schedule()
  }

  const stopWatching = fsWatcher.onFileChange((files) => {
    const s = opts.served.value
    if (!s) return
    const hit = files.some((f) => {
      if (opts.accepts && !opts.accepts(f.path)) return false
      const rel = relativeToBase(s.root, f.path, s.platform)
      return rel !== null && (!opts.affects || opts.affects(rel, s))
    })
    if (hit) schedule()
  })

  onUnmounted(() => {
    stopWatching()
    if (timer !== undefined) clearTimeout(timer)
  })

  return { onSaved }
}
