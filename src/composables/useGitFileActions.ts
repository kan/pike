import { t } from '../i18n'
import { openPathInTab } from '../lib/openFile'
import { repoPath } from '../lib/paths'
import { fsDelete } from '../lib/tauri'
import { useGitStore } from '../stores/git'
import { useProjectStore } from '../stores/project'
import type { GitFileChange } from '../types/git'
import { confirmDialog } from './useConfirmDialog'

/**
 * 変更の一覧の行から押す、ファイル 1 つぶんの操作（Git パネルと作業中の変更のタブ #526 が共有）。
 *
 * **分岐はここにしか置かない**（`.claude/rules/git.md` の #309）。untracked の破棄が
 * `git checkout` ではなくファイル削除になること、ステージ済みの新規追加を外すときの確認、
 * リネームの両方の名前を外すこと（#306、`unstageFiles` の中）は、どれもこの関数が持つ。
 * 置き場を増やすと同じ分岐が散る。
 */
export function useGitFileActions() {
  const gitStore = useGitStore()
  const projectStore = useProjectStore()

  /** 組み立ての規則と、`null` を返す理由は `lib/paths.ts` の `repoPath` の doc が正本。 */
  function workingPath(path: string): string | null {
    return repoPath(projectStore.activeRoot, path, projectStore.currentProject?.shell)
  }

  async function discardFile(file: GitFileChange) {
    if (!(await confirmDialog(t('git.discardConfirm', { path: file.path })))) return
    if (file.status === '?') {
      const shell = projectStore.currentProject?.shell
      const full = workingPath(file.path)
      if (!shell || !full) return
      await fsDelete(shell, full)
      await gitStore.refreshStatus()
    } else {
      await gitStore.discardChanges([file.path])
    }
  }

  async function unstageFile(file: GitFileChange) {
    if (file.status === 'A') {
      if (!(await confirmDialog(t('git.unstageNewConfirm', { path: file.path })))) return
      const shell = projectStore.currentProject?.shell
      const full = workingPath(file.path)
      if (shell && full) {
        await gitStore.unstageFiles([file])
        await fsDelete(shell, full).catch(() => {})
        await gitStore.refreshStatus()
      }
    } else {
      await gitStore.unstageFiles([file])
    }
  }

  /**
   * 作業ツリーのファイルを開く。コンフリクトの行の行き先でもある（マーカーはエディタで、
   * 手で、または領域ごとのボタンで解消する。#223）。
   */
  async function openWorkingFile(path: string) {
    const full = workingPath(path)
    if (full) await openPathInTab({ path: full })
  }

  return { workingPath, openWorkingFile, discardFile, unstageFile }
}
