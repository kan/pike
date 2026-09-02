import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { fsWatcher } from '../composables/useFsWatcher'
import { pathSep } from '../lib/paths'
import { loadJson, saveJson } from '../lib/storage'
import type { FsEntry } from '../lib/tauri'
import { fsListDir } from '../lib/tauri'
import { useGitStore } from './git'
import { useProjectStore } from './project'
import { useSidebarStore } from './sidebar'

export const useFileTreeStore = defineStore('fileTree', () => {
  const tree = ref<Record<string, FsEntry[]>>({})
  const expanded = ref<Set<string>>(new Set())
  const loading = ref<Set<string>>(new Set())
  const scrollTop = ref(0)
  const selectedPath = ref<string | null>(null)

  let currentProjectId: string | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null

  function storageKey(projectId: string): string {
    return `pike:fileTree:expanded:${projectId}`
  }

  function saveExpanded() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      const pid = currentProjectId
      if (!pid) return
      // **`IGNORED_DIRS` の中は覚えない（#303）。** 開けるようにはしたが、覚えると
      // 次にプロジェクトを開くたびに `initTree` がそこを読み直す（`node_modules` 直下は
      // 数千エントリ、WSL なら 1 ディレクトリにつき `wsl.exe` 1 本）。「なるべく重く
      // ならないように」という要件に対して、セッション限りの展開が釣り合う。
      saveJson(
        storageKey(pid),
        [...expanded.value].filter((p) => !isUnderIgnored(p)),
      )
    }, 500)
  }

  function loadSavedExpanded(projectId: string): string[] {
    const parsed = loadJson<unknown>(storageKey(projectId), [])
    return Array.isArray(parsed) ? (parsed as string[]) : []
  }

  function sep(): string {
    return pathSep(useProjectStore().currentProject?.shell)
  }

  /**
   * `path` かその祖先が `IGNORED_DIRS` のディレクトリか（#303）。
   *
   * **判定はフロントで持つ**: 「`<root>/node_modules`」と「たまたま `node_modules` という
   * 名前のディレクトリの下に置いたプロジェクト」を区別できるのは root を知っている側だけで、
   * パスのセグメントを見るだけの述語を Rust に置くと後者で誤爆する（`C:\dist\myproj` など）。
   * 名前の一覧を写さずに済むよう、Rust が付けた `FsEntry.ignored` を親の listing から引く。
   *
   * 親は必ず先に読まれている（ツリーは上から開く）ので、tree にあるものだけで答えが出る。
   */
  function isUnderIgnored(path: string): boolean {
    const root = useProjectStore().activeRoot
    const s = sep()
    let current = path
    while (current.length > root.length && current.startsWith(root)) {
      const idx = current.lastIndexOf(s)
      if (idx < 0) break
      const parent = current.slice(0, idx)
      const name = current.slice(idx + s.length)
      if (tree.value[parent]?.some((e) => e.name === name && e.isDir && e.ignored)) return true
      current = parent
    }
    return false
  }

  async function loadDir(path: string) {
    if (loading.value.has(path)) return
    const project = useProjectStore().currentProject
    if (!project) return
    loading.value.add(path)
    try {
      // git リポジトリのときのみ gitignore を参照する（非 git での無駄な git 実行を避ける）。
      // `IGNORED_DIRS` の中も見ない: 丸ごと ignore される前提で色を分ける意味が無いうえ、
      // `node_modules` 直下は名前を全部並べると `git check-ignore` のコマンドラインが
      // Windows の上限（32KB）に近づく。
      const isGitRepo = useGitStore().status !== null && !isUnderIgnored(path)
      tree.value[path] = await fsListDir(project.shell, path, isGitRepo)
    } catch {
      tree.value[path] = []
    } finally {
      loading.value.delete(path)
    }
  }

  // git status は非同期取得なので、ツリーの初回ロード（復元で展開済みの dir を含む）が
  // status 到着より先だと checkGitignore=false で gitignore フラグが付かない。status が
  // 利用可能になった時点（null→非null）で既読の全ディレクトリを再取得して反映する。
  watch(
    () => useGitStore().status !== null,
    (isRepo) => {
      if (!isRepo) return
      for (const path of Object.keys(tree.value)) void loadDir(path)
    },
  )

  function initTree() {
    const projectStore = useProjectStore()
    tree.value = {}
    expanded.value.clear()
    staleDirs.clear()
    scrollTop.value = 0
    selectedPath.value = null
    const project = projectStore.currentProject
    const root = projectStore.activeRoot
    currentProjectId = project?.id ?? null
    if (!root) return

    const saved = currentProjectId ? loadSavedExpanded(currentProjectId) : []
    const s = pathSep(project?.shell)

    expanded.value.add(root)
    for (const path of saved) {
      if (path.startsWith(root + s) || path === root) {
        expanded.value.add(path)
      }
    }

    // Load all expanded directories concurrently
    for (const dir of expanded.value) {
      loadDir(dir)
    }
  }

  /**
   * パネルが見えるようになったときの入口（`FileTreePanel` の `onMounted`）。
   *
   * **溜めておいた変更を流すのもここ（#303）。** `activePanel` を別に watch すると、
   * 「パネルが開いた」という 1 つの事実に反応する場所が 2 つになり、しかもストア側の
   * watch がパネルの `onMounted` より先に走るぶん、順序が暗黙の契約になる。ここなら
   * プロジェクトが変わっていれば `initTree`（＝全部読み直し）に落ちるので、溜めたぶんが
   * どのプロジェクトのものかを別に覚えなくてよい。
   */
  function ensureInit() {
    const projectStore = useProjectStore()
    const pid = projectStore.currentProject?.id ?? null
    if (pid !== currentProjectId) {
      initTree()
      return
    }
    const root = projectStore.activeRoot
    if (root && !tree.value[root]) {
      initTree()
      return
    }
    flushStaleDirs()
  }

  function invalidateDir(path: string) {
    if (path in tree.value && !expanded.value.has(path)) {
      delete tree.value[path]
    }
  }

  /**
   * ファイル監視の受け手（#303）。
   *
   * **購読はここに置く。** 以前は `FileTreePanel` が持っていたが、あのパネルは `v-if` で
   * マウントされるので、**別のパネルを見ているあいだ・サイドバーを畳んでいるあいだは
   * 購読ごと外れて**変更がどこにも届かなかった。戻ってきても `ensureInit` はキャッシュが
   * あれば何もしないため、更新ボタンを押すまで古いツリーが残る（「反映されることもある」
   * の正体はパネルを開いたままだったかどうか）。ストアはウィンドウの寿命なので切れない。
   *
   * ただし**見ていないあいだは読み直さず溜める**。パネルを閉じたままビルドを回しても
   * IPC が増えないようにするため。溜めるのは展開中のディレクトリだけなので、Set の
   * 大きさは `expanded` を超えない。
   */
  const staleDirs = new Set<string>()

  /** ツリーに出ている（＝読み直す価値がある）ディレクトリか。 */
  function isLiveDir(dir: string, root: string): boolean {
    return dir === root || expanded.value.has(dir)
  }

  function applyDirChanges(dirs: string[]) {
    const root = useProjectStore().activeRoot
    if (!root) return
    const visible = useSidebarStore().activePanel === 'files'
    for (const dir of dirs) {
      if (!isLiveDir(dir, root)) {
        // 畳んであるディレクトリはキャッシュを捨てるだけでよい（開くときに読み直す）
        invalidateDir(dir)
      } else if (visible) {
        void loadDir(dir)
      } else {
        staleDirs.add(dir)
      }
    }
  }

  function flushStaleDirs() {
    if (staleDirs.size === 0) return
    const root = useProjectStore().activeRoot
    // root がまだ決まっていないだけなら、捨てずに次の機会へ回す
    if (!root) return
    const dirs = [...staleDirs]
    staleDirs.clear()
    // 溜めているあいだに畳まれたディレクトリは読み直さない
    for (const dir of dirs) {
      if (isLiveDir(dir, root)) void loadDir(dir)
    }
  }

  fsWatcher.onDirChange(applyDirChanges)

  function invalidateCollapsed() {
    for (const path of Object.keys(tree.value)) {
      if (!expanded.value.has(path)) {
        delete tree.value[path]
      }
    }
  }

  async function revealFile(filePath: string): Promise<boolean> {
    const root = useProjectStore().activeRoot
    if (!root) return false

    const s = sep()
    if (!filePath.startsWith(root + s) && filePath !== root) return false

    const relative = filePath.slice(root.length + s.length)
    const parts = relative.split(s)
    const dirs: string[] = [root]
    let current = root
    for (let i = 0; i < parts.length - 1; i++) {
      current = current + s + parts[i]
      dirs.push(current)
    }

    for (const dir of dirs) {
      // **`IGNORED_DIRS` の中には追従しない（#303）。** 行をクリックすれば開けるように
      // したが、開くかどうかを決めるのは人であって、ここではない。定義ジャンプは JS の
      // 依存を `node_modules` の中に解決するし、ターミナルに出たパスのクリックも同じ所へ
      // 着く。自動で開くと、仮想化していないツリーに数千行が一度に描かれる。
      // 親は 1 つ前の周回で読み込み済みなので、この時点で答えが出る。
      if (isUnderIgnored(dir)) return false
      if (!expanded.value.has(dir)) {
        expanded.value.add(dir)
      }
      if (!tree.value[dir]) {
        await loadDir(dir)
      }
    }

    selectedPath.value = filePath
    saveExpanded()
    return true
  }

  return {
    tree,
    expanded,
    loading,
    scrollTop,
    selectedPath,
    loadDir,
    initTree,
    ensureInit,
    revealFile,
    invalidateDir,
    invalidateCollapsed,
    saveExpanded,
  }
})
