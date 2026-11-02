// エディタの行をホスティングサービスで開く / リンクをコピーする（#540）。右クリックのメニューと
// パレットが同じ `shareFileLink` を呼ぶ。URL の形は `forge.ts` の `buildFileLink`、git の
// 情報は Rust の `git_file_link_info`。
//
// - **既定は SHA の permalink。** ブランチ名で作ると、後でブランチが進んだときに別の行を指す
// - **HEAD が未 push なら確認して、ブランチ名で開くかを選ばせる。** Pike からは push しない
//   （push は Git パネルの操作で、リンクを開くついでに履歴を外へ出さない）
// - **コピーのときも同じ確認を通す**（貼った先で 404 になるのを防ぐ）
// - 行のずれを diff から補正することはしない。ずれうることを確認の文で言うだけにする
import { choiceDialog, confirmDialog, infoDialog } from '../composables/useConfirmDialog'
import { t } from '../i18n'
import { useStatusMessageStore } from '../stores/statusMessage'
import { useTabStore } from '../stores/tabs'
import type { FileLinkInfo } from '../types/git'
import type { ShellType } from '../types/tab'
import { buildFileLink, parseForge } from './forge'
import { isMarkdownPath } from './paths'
import { gitFileLinkInfo } from './tauri'

export type FileLinkMode = 'open' | 'copy'

export interface FileLinkRequest {
  shell: ShellType
  /** シェルの作法の絶対パス（タブの `path`）。 */
  path: string
  range: { start: number; end: number } | null
  /** エディタに未保存の変更があるか（保存済みのファイルと行がずれうる）。 */
  unsaved: boolean
}

/** メニューに出す名前（「{service} で開く」）。対応していない origin なら `null` で、項目を出さない。 */
export function fileLinkService(remoteUrl: string | null): string | null {
  return parseForge(remoteUrl)?.label ?? null
}

export async function shareFileLink(mode: FileLinkMode, req: FileLinkRequest): Promise<void> {
  let info: FileLinkInfo
  try {
    info = await gitFileLinkInfo(req.shell, req.path)
  } catch (e) {
    return infoDialog(t('fileLink.failed', { error: String(e) }))
  }
  if (!info.path) return infoDialog(t('fileLink.untracked'))
  const service = fileLinkService(info.remoteUrl)
  if (!service) return infoDialog(t('fileLink.unknownRemote'))
  // `path` があれば HEAD の木から引けている（`ls-tree HEAD`）ので、`head` も必ずある。
  if (!info.head) return

  const dirty = info.dirty || req.unsaved
  let commit = info.head
  let branch: string | undefined
  if (info.headPushed) {
    if (dirty && !(await confirmDialog(`${t('fileLink.dirty')}\n\n${t(`fileLink.proceed.${mode}`)}`))) return
  } else if (info.branch && info.branchCommit) {
    // 未 push のコミットで足したファイルは、リモートのブランチにも無い（開いても 404）。
    if (!info.branchHasFile) return infoDialog(t('fileLink.notOnBranch', { branch: info.branch }))
    const msg = [t('fileLink.unpushed', { branch: info.branch }), dirty && t('fileLink.dirty')]
      .filter(Boolean)
      .join('\n\n')
    const choice = await choiceDialog(msg, [
      { value: 'cancel', label: t('common.cancel') },
      { value: 'branch', label: t(`fileLink.useBranch.${mode}`), primary: true },
    ])
    if (choice !== 'branch') return
    commit = info.branchCommit
    branch = info.branch
  } else {
    return infoDialog(t('fileLink.unpublished'))
  }

  const link = buildFileLink(info.remoteUrl, {
    commit,
    branch,
    path: info.path,
    range: req.range,
    markdown: isMarkdownPath(info.path),
  })
  if (!link) return
  if (mode === 'open') {
    useTabStore().addBrowserTab(link.url)
    return
  }
  try {
    await navigator.clipboard.writeText(link.url)
    useStatusMessageStore().show({ text: t('fileLink.copied', { service }), variant: 'success' })
  } catch (e) {
    await infoDialog(t('fileLink.failed', { error: String(e) }))
  }
}
