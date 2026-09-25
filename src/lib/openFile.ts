import { confirmDialog, infoDialog } from '../composables/useConfirmDialog'
import { t } from '../i18n'
import { useProjectStore } from '../stores/project'
import { useTabStore } from '../stores/tabs'
import type { ShellType } from '../types/tab'
import {
  basename,
  extension,
  isAbsolutePath,
  isImageFile,
  joinPath,
  mimeType,
  pathSep,
  pickedPathForShell,
} from './paths'
import { fsOpenInExplorer, fsReadFileBase64, pickOpenFile } from './tauri'

/**
 * Open a path in the tab kind that matches its extension: images go to the
 * viewer, PDFs to the PDF tab, everything else to the editor (which handles
 * Markdown / SVG / CSV / Mermaid / JSON previews itself).
 *
 * This is the single place that decides the tab kind. It used to live in
 * FileTreePanel and useCliOpen only, so every other entry point (Git panel,
 * command palette, …) opened images in the editor and hit the binary guard.
 */
export async function openPathInTab(opts: {
  path: string
  line?: number
  /** Shell for file I/O. Defaults to the current project's, then PowerShell —
   *  project-less windows read through the Windows side, as EditorTab does. */
  shell?: ShellType
}): Promise<void> {
  const tabStore = useTabStore()
  const { path } = opts

  if (isImageFile(path)) {
    const shell = opts.shell ?? useProjectStore().shellForIO
    try {
      const base64 = await fsReadFileBase64(shell, path)
      tabStore.addPreviewTab({ path, dataUrl: `data:${mimeType(path)};base64,${base64}` })
      return
    } catch {
      // Unreadable image — fall through to the editor, which reports the error.
    }
  }
  if (extension(path) === 'pdf') {
    tabStore.addPdfTab({ path })
    return
  }
  tabStore.addEditorTab({ path, initialLine: opts.line })
}

/**
 * ファイルのダイアログで選んだファイルを開く（#410。タブバーの「+」のメニュー）。プロジェクトの
 * 外のファイルも開ける。初期位置は今のプロジェクトのルート。
 *
 * 読むのは今のプロジェクトのシェル（エディタのタブはタブごとのシェルを持たない）なので、
 * 選んだパスをそのシェルの形に直す（`pickedPathForShell`）。直せないもの（WSL のプロジェクトで
 * 別の distro のファイルを選んだなど）は、開かずにそう知らせる。
 */
export async function pickAndOpenFile(): Promise<void> {
  const projectStore = useProjectStore()
  let picked: string | null
  try {
    picked = await pickOpenFile([], projectStore.pickerStartDir())
  } catch (e) {
    await infoDialog(t('tabs.openFileFailed', { error: String(e) }))
    return
  }
  if (!picked) return
  const shell = projectStore.shellForIO
  const path = pickedPathForShell(picked, shell)
  if (!path) {
    await infoDialog(t('tabs.openFileUnreachable', { path: picked }))
    return
  }
  await openPathInTab({ path, shell })
}

/**
 * 「開く」が「実行する」になる拡張子（#362）。OS の関連付けで開くと、これらはプログラムとして
 * 走る（Windows の `explorer.exe` はスクリプトもショートカットもそのまま起動する）。信用しきって
 * いないリポジトリを clone したあとに押す操作なので、黙って走らせない。
 */
const EXECUTABLE_EXTENSIONS = new Set([
  ...['exe', 'com', 'bat', 'cmd', 'msi', 'msc', 'scr', 'pif', 'cpl', 'lnk', 'url', 'reg', 'hta', 'jar'],
  ...['ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'application', 'appref-ms'],
  ...['app', 'command', 'sh', 'tool', 'pkg', 'terminal', 'workflow'],
])

/**
 * 出力や検索結果に出てきたパスを絶対パスにする。相対パスはプロジェクト（worktree）の
 * ルート（`activeRoot`）から解決する。プロジェクトが無ければ null。
 *
 * **解決の規則はここ 1 つ**（#376）。ターミナルのリンク、エディタのタグジャンプ、検索の
 * 結果が同じものを使う（それぞれが書いていたころは、判定と連結の書き方が 3 通りあった）。
 */
export function projectPath(path: string): string | null {
  const projectStore = useProjectStore()
  const project = projectStore.currentProject
  if (!project) return null
  return isAbsolutePath(path) ? path : joinPath(projectStore.activeRoot, path, pathSep(project.shell))
}

/** `projectPath` で解決して、その行を開く。 */
export async function openProjectPath(path: string, line?: number): Promise<void> {
  const full = projectPath(path)
  const shell = useProjectStore().currentProject?.shell
  if (full) await openPathInTab({ path: full, line, shell })
}

/**
 * ファイルを関連付けられたアプリで開く（#362）。**入口はここ 1 つ**（ファイルツリーの右クリックと、
 * 大きすぎるファイルの画面）。実行形式に当たる拡張子だけ、押した人に確かめてから渡す。
 */
export async function openWithDefaultApp(shell: ShellType, path: string): Promise<void> {
  if (EXECUTABLE_EXTENSIONS.has(extension(path))) {
    if (!(await confirmDialog(t('confirm.runExecutable', { name: basename(path) })))) return
  }
  await fsOpenInExplorer(shell, path).catch(() => {})
}
