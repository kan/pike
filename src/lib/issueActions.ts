import {
  choiceDialog,
  choiceWithOption,
  confirmDialog,
  type DialogChoice,
  dialogOpen,
  infoDialog,
} from '../composables/useConfirmDialog'
import { t } from '../i18n'
import { useIssuesStore } from '../stores/issues'
import type { CheckState, CloseReason, IssueAction, IssueKind, IssueSummary, MergeMethod } from '../types/issues'
import { indexIssues } from './issueTree'
import { issuesMergeMethods } from './tauri'

/**
 * issue パネルの行から実行する、状態を変える操作（#450）: PR のマージとクローズ、issue の
 * クローズ。**ここが持つのは確認のダイアログ**で、`gh` の実行・失敗の表示・一覧の取り直しは
 * `issuesStore.act` が持つ（取得の状態と同じ場所で、プロジェクトの切り替えと突き合わせるため）。
 */

/** キャンセルのボタン。選択ダイアログは Escape でも閉じるが、ボタンが無いと断り方が見えない。 */
const CANCEL = 'cancel'

const METHOD_LABEL = {
  merge: 'issues.mergeMethodMerge',
  squash: 'issues.mergeMethodSquash',
  rebase: 'issues.mergeMethodRebase',
} as const satisfies Record<MergeMethod, string>

/** マージの確認に足す、CI の状態の注意。成功しているときは何も言わない。 */
const CHECK_WARNING: Record<CheckState, string | null> = {
  success: null,
  failure: 'issues.mergeWarnChecksFailure',
  pending: 'issues.mergeWarnChecksPending',
}

/**
 * リポジトリで許可されているマージの方式。**リポジトリごとに 1 回だけ聞く**（`gh` の起動 1 回
 * ぶん、確認が出るのが遅れる。dependabot の PR を続けてマージするときに毎回払わない）。
 * 設定を変えられて古くなっても、`gh pr merge` が断るので、失敗したら捨てて聞き直す。
 */
const methodsByRepo = new Map<string, MergeMethod[]>()

/** 本文と注意を、空行を挟んで 1 つの文面にする（ダイアログは改行を残す）。 */
function withWarnings(message: string, warnings: (string | null | false)[]): string {
  return [message, ...warnings.filter((w): w is string => !!w)].join('\n\n')
}

/**
 * 決定のボタンを右端に置く並び（`useCopyOnSelect` と同じ向き）: キャンセル、残り、既定の順。
 * `list` の先頭を既定（Enter で選ばれ、最初にフォーカスが入る）にする。
 */
function withCancel<T extends string>(list: DialogChoice<T>[]): DialogChoice<T | typeof CANCEL>[] {
  const [first, ...rest] = list
  return [{ value: CANCEL, label: t('common.cancel') }, ...rest.reverse(), { ...first, primary: true }]
}

/**
 * PR をマージする。**方式はリポジトリで許可されているものだけを並べる**（許可されていない
 * 方式を選ばせて `gh` に断らせない）。ブランチの削除はチェックで選ぶ（既定はオフ。
 * `--delete-branch` は手元のブランチも消す）。
 *
 * **draft と CI の状態は止めずに知らせる**: マージできるかを決めるのはリポジトリの保護規則で、
 * 一覧からは分からない（コンフリクトも同じ）。断られたら `gh` の文面が出る。
 */
export async function mergePullRequest(pr: IssueSummary): Promise<void> {
  const repo = pr.url.replace(/\/pull\/\d+$/, '')
  const outcome = await useIssuesStore().act('pr', pr, async (shell, root) => {
    let methods = methodsByRepo.get(repo)
    if (!methods) {
      methods = await issuesMergeMethods(shell, root, pr.url)
      methodsByRepo.set(repo, methods)
      // 往復のあいだに別のダイアログが開いていたら譲る（`askOnce` と同じ扱い）。割り込むと
      // 相手の答えを奪ううえ、押そうとしていたボタンの位置にマージのボタンが出る。
      if (dialogOpen()) return null
    }
    if (methods.length === 0) {
      methodsByRepo.delete(repo)
      await infoDialog(t('issues.mergeNoMethod'))
      return null
    }
    const checkWarning = pr.checks && CHECK_WARNING[pr.checks]
    const { value, checked } = await choiceWithOption(
      withWarnings(t('issues.mergeConfirm', { number: pr.number, title: pr.title }), [
        pr.draft && t('issues.mergeWarnDraft'),
        checkWarning && t(checkWarning),
      ]),
      withCancel(methods.map((m) => ({ value: m, label: t(METHOD_LABEL[m]) }))),
      t('issues.mergeDeleteBranch'),
    )
    if (!value || value === CANCEL) return null
    return { type: 'merge', method: value, deleteBranch: checked }
  })
  if (outcome === 'failed') methodsByRepo.delete(repo)
}

/**
 * issue か PR をクローズする。issue は理由（完了 / 対応しない）をボタンで選び、PR は確認だけ。
 * コメントは付けない（残したいときは GitHub のページで書く）。
 */
export async function closeIssueOrPr(kind: IssueKind, item: IssueSummary): Promise<void> {
  await useIssuesStore().act(kind, item, () => (kind === 'pr' ? askClosePr(item) : askCloseIssue(item)))
}

async function askClosePr(pr: IssueSummary): Promise<IssueAction | null> {
  const ok = await confirmDialog(t('issues.closeConfirmPull', { number: pr.number, title: pr.title }))
  return ok ? { type: 'closePr' } : null
}

async function askCloseIssue(issue: IssueSummary): Promise<IssueAction | null> {
  // 子が open のまま親を閉じても GitHub は止めないので、こちらも止めずに件数だけ言う。
  // 数えるのは木に出ている子（輪の扱いを含めて `indexIssues` に任せる）。
  const issues = useIssuesStore().issues
  const { parentOf } = indexIssues(issues)
  const children = issues.filter((i) => parentOf(i) === issue.number).length
  const reason = await choiceDialog(
    withWarnings(t('issues.closeConfirmIssue', { number: issue.number, title: issue.title }), [
      children > 0 && t('issues.closeWarnChildren', { count: children }),
    ]),
    withCancel<CloseReason>([
      { value: 'completed', label: t('issues.closeCompleted') },
      { value: 'notPlanned', label: t('issues.closeNotPlanned') },
    ]),
  )
  return reason && reason !== CANCEL ? { type: 'closeIssue', reason } : null
}
