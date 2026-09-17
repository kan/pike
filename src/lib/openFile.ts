import { confirmDialog } from '../composables/useConfirmDialog'
import { t } from '../i18n'
import { useProjectStore } from '../stores/project'
import { useTabStore } from '../stores/tabs'
import type { ShellType } from '../types/tab'
import { basename, extension, isImageFile, mimeType } from './paths'
import { fsOpenInExplorer, fsReadFileBase64 } from './tauri'

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
 * ファイルを関連付けられたアプリで開く（#362）。**入口はここ 1 つ**（ファイルツリーの右クリックと、
 * 大きすぎるファイルの画面）。実行形式に当たる拡張子だけ、押した人に確かめてから渡す。
 */
export async function openWithDefaultApp(shell: ShellType, path: string): Promise<void> {
  if (EXECUTABLE_EXTENSIONS.has(extension(path))) {
    if (!(await confirmDialog(t('confirm.runExecutable', { name: basename(path) })))) return
  }
  await fsOpenInExplorer(shell, path).catch(() => {})
}
