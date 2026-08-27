/**
 * Putting pictures into a Markdown document (#241).
 *
 * The three ways in — the toolbar's file dialog, a paste, a drop — all end at
 * the same question: what path should the link hold?
 *
 * Images go next to the document rather than into `.pike/uploads`, where the
 * chat and the terminal put what is dropped on them. That directory carries a
 * `.gitignore` of `*`, and a picture a document points at has to be committed
 * with it. So everything here works off the document's own directory and the
 * shell that reads it, never the project root.
 *
 * A file that is already in the project is linked where it lies, `../` and all:
 * copying it would leave the repository holding the same image twice. Only what
 * comes from outside is copied in, because a link pointing out of the project
 * resolves on this machine alone.
 */

import type { EditorView } from '@codemirror/view'
import type { Ref } from 'vue'
import { t } from '../i18n'
import { resolveDroppedPaths } from '../lib/dropPaths'
import { markdownImage } from '../lib/editorMarkdown'
import {
  basename,
  EMBEDDABLE_IMAGE_EXTS,
  isAbsolutePath,
  isEmbeddableImage,
  pathSep,
  relativeFromDir,
  stem,
  wslNativeToUnc,
  wslUncToNative,
} from '../lib/paths'
import { relativeToBase } from '../lib/projectPaths'
import { fsImportFile, pickOpenFile } from '../lib/tauri'
import { useStatusMessageStore } from '../stores/statusMessage'
import { type ShellType, shellToPlatform } from '../types/tab'
import { getClipboardFiles, isGenericName, saveFileTo, uniqueFilename } from './useImagePaste'

export interface MarkdownImages {
  /** Toolbar: choose a file and write a link to it. */
  insertFromPicker: (view: EditorView) => Promise<void>
  /** Entries for `EditorView.domEventHandlers`. */
  handlers: {
    paste: (event: ClipboardEvent, view: EditorView) => boolean
    drop: (event: DragEvent, view: EditorView) => boolean
  }
}

/**
 * @param docDir directory holding the document, in its shell's own path space
 * @param shell  the shell that can read that directory
 * @param root   project root, or '' in a window that has no project
 */
export function useMarkdownImages(docDir: Ref<string>, shell: Ref<ShellType>, root: Ref<string>): MarkdownImages {
  const statusMessage = useStatusMessageStore()

  const warn = (text: string) => statusMessage.show({ text, variant: 'warn', durationMs: 4000 })
  const failed = (e: unknown) => warn(t('markdown.imageFailed', { error: String(e) }))

  /** Is `path` inside the project (or, without one, under the document)? */
  function isOurs(path: string): boolean {
    const base = root.value || docDir.value
    return relativeToBase(base, path, shellToPlatform(shell.value)) !== null
  }

  /**
   * The same file named the way `shell` can reach it, or null when it cannot.
   *
   * The dialogs are Windows dialogs, so a file inside a WSL project comes back
   * as a UNC path — and only the project's own distro can be named natively.
   */
  function asLocalPath(picked: string): string | null {
    if (shell.value.kind !== 'wsl') return picked
    const unc = wslUncToNative(picked)
    return unc?.distro === shell.value.distro ? unc.path : null
  }

  /** Copy `source` (a Windows path) into the document's directory. */
  async function copyIn(source: string): Promise<string> {
    const name = uniqueFilename(basename(source), 'png')
    const dest = `${docDir.value}${pathSep(shell.value)}${name}`
    const local = asLocalPath(source)
    if (local) {
      await fsImportFile(shell.value, local, dest)
      return name
    }
    // Windows file, WSL destination. Windows can still see the far end by its
    // UNC name, so this stays one copy in Rust — reading the bytes into the
    // webview and writing them back would push the whole image through the IPC
    // bridge twice as base64.
    const reachable = shell.value.kind === 'wsl' ? wslNativeToUnc(shell.value.distro, dest) : dest
    // PowerShell を名指しするのは UNC 越しに WSL の中へ書くためで、ホスト OS の
    // 話ではない。WSL 以外では `asLocalPath` が非 null になりここへ来ない。
    await fsImportFile(shell.value.kind === 'wsl' ? { kind: 'powershell' } : shell.value, source, reachable)
    return name
  }

  /** The path to write in the link for a file that is already on disk. */
  async function linkPathFor(source: string): Promise<string> {
    const local = asLocalPath(source)
    if (local && isOurs(local)) {
      const rel = relativeFromDir(docDir.value, local, pathSep(shell.value))
      if (rel) return rel
    }
    return copyIn(source)
  }

  /** Alt text worth pre-filling: the author's own file name, never ours. */
  function altFor(name: string): string {
    return name && !isGenericName(name) ? stem(name) : ''
  }

  /**
   * Write the images as one change, with the caret on the first alt text.
   *
   * One transaction rather than one per image: it is a single undo step, and
   * inserting them one at a time would write each into the alt text the last
   * one left selected.
   */
  function insertAll(view: EditorView, images: { path: string; alt: string }[]) {
    if (!images.length) return
    const range = view.state.selection.main
    const insert = images.map((i) => markdownImage(i.path, i.alt)).join('\n')
    const at = range.from + '!['.length
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor: at, head: at + images[0].alt.length },
      scrollIntoView: true,
    })
    view.focus()
  }

  function isImageLike(file: File): boolean {
    return file.type.startsWith('image/') || isEmbeddableImage(file.name)
  }

  /** Move the caret to where the pointer let go, so the drop lands there. */
  function caretAtPointer(view: EditorView, event: DragEvent) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos !== null) view.dispatch({ selection: { anchor: pos } })
  }

  /**
   * Save the bytes we hold. Used for the clipboard, which has no path, and as
   * the fallback when a dropped file's real path cannot be recovered.
   */
  async function saveBytes(file: File): Promise<{ path: string; alt: string }> {
    return { path: await saveFileTo(file, shell.value, docDir.value), alt: altFor(file.name) }
  }

  async function insertFromPicker(view: EditorView) {
    if (!docDir.value) {
      warn(t('markdown.imageNeedsSave'))
      return
    }
    const picked = await pickOpenFile([...EMBEDDABLE_IMAGE_EXTS])
    if (!picked) return
    try {
      const path = await linkPathFor(picked)
      insertAll(view, [{ path, alt: stem(path) }])
    } catch (e) {
      failed(e)
    }
  }

  function paste(event: ClipboardEvent, view: EditorView): boolean {
    if (!docDir.value) return false
    const images = getClipboardFiles(event).filter(isImageLike)
    if (!images.length) return false
    event.preventDefault()
    void Promise.all(images.map(saveBytes))
      .then((written) => insertAll(view, written))
      .catch(failed)
    return true
  }

  function drop(event: DragEvent, view: EditorView): boolean {
    if (!docDir.value) return false
    const list = event.dataTransfer?.files
    if (list?.length) {
      const wanted = [...list].map((file, index) => ({ file, index })).filter((e) => isImageLike(e.file))
      if (!wanted.length) return false
      event.preventDefault()
      caretAtPointer(view, event)
      void dropFiles(list, wanted)
        .then((written) => insertAll(view, written))
        .catch(failed)
      return true
    }
    // A path dragged from the file tree. `text/plain` is the only channel the
    // panels share, so check it looks like a path before believing it — plain
    // text reading `foo.png` dragged out of another app is not one.
    const dragged = event.dataTransfer?.getData('text/plain') ?? ''
    if (!isAbsolutePath(dragged) || !isEmbeddableImage(dragged)) return false
    const rel = relativeFromDir(docDir.value, dragged, pathSep(shell.value))
    if (!rel) return false
    event.preventDefault()
    caretAtPointer(view, event)
    insertAll(view, [{ path: rel, alt: stem(rel) }])
    return true
  }

  /**
   * Prefer each dropped file's real path: copying on the far side keeps the
   * image out of the IPC bridge, and a file already in the project is linked
   * instead of duplicated. `resolveDroppedPaths` answers with [] when the host
   * cannot tell us (outside WebView2, or on timeout), and then the bytes we
   * already hold are all there is.
   *
   * The reply is only positional while every file resolved: `drop_paths.rs`
   * skips the ones it cannot read, which shifts everything after them. A short
   * answer would silently link one image under another's name, so a short
   * answer is no answer.
   */
  async function dropFiles(list: FileList, wanted: { file: File; index: number }[]) {
    const resolved = await resolveDroppedPaths(list)
    const paths = resolved.length === list.length ? resolved : []
    return Promise.all(
      wanted.map(async ({ file, index }) => {
        const entry = paths[index]
        if (!entry || entry.isDir) return saveBytes(file)
        const path = await linkPathFor(entry.path)
        return { path, alt: altFor(basename(entry.path)) }
      }),
    )
  }

  return { insertFromPicker, handlers: { paste, drop } }
}
