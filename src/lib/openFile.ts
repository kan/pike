import { useProjectStore } from '../stores/project'
import { useTabStore } from '../stores/tabs'
import type { ShellType } from '../types/tab'
import { extension, isImageFile, mimeType } from './paths'
import { fsReadFileBase64 } from './tauri'

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
    const shell = opts.shell ?? useProjectStore().currentProject?.shell ?? { kind: 'powershell' }
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
