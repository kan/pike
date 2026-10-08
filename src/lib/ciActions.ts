import { confirmDialog } from '../composables/useConfirmDialog'
import { t } from '../i18n'
import { useCiStore } from '../stores/ci'
import type { CiRun } from '../types/ci'

/**
 * CI パネルの行から実行する、状態を変える操作（#457）: 再実行と中止。**ここが持つのは確認の
 * ダイアログ**で、CLI の実行・失敗の表示・一覧の取り直しは `ciStore.act` が持つ
 * （`lib/issueActions.ts` と `issuesStore.act` の分け方と同じ）。
 *
 * **再実行で渡す id は一覧が返したものをそのまま使う**（`rerunIds` / `rerunFailedIds`）。
 * 単位が CI で違い（GitHub は run、CircleCI はワークフロー）、決めるのは Rust の側。
 */

/** 確認の文面に出す、run の呼び名（題名とブランチ）。 */
function describe(run: CiRun): { title: string; branch: string } {
  return { title: run.title, branch: run.branch }
}

/**
 * run を再実行する。`failedOnly` は失敗した job だけ（成功した job の結果は使い回される）。
 * 対象が無い run（CircleCI で、ワークフローがまだ 1 本も無い）は、メニューが項目を出さない。
 */
export async function rerunCiRun(run: CiRun, failedOnly: boolean): Promise<void> {
  const ids = failedOnly ? run.rerunFailedIds : run.rerunIds
  if (ids.length === 0) return
  await useCiStore().act(async () => {
    const key = failedOnly ? 'ci.rerunFailedConfirm' : 'ci.rerunConfirm'
    return (await confirmDialog(t(key, describe(run)))) ? { action: { type: 'rerun', failedOnly }, ids } : null
  })
}

/** 実行中の run を中止する。途中の job も止まるので確認を挟む。 */
export async function cancelCiRun(run: CiRun): Promise<void> {
  await useCiStore().act(async () =>
    (await confirmDialog(t('ci.cancelConfirm', describe(run)))) ? { action: { type: 'cancel' }, ids: [run.id] } : null,
  )
}
