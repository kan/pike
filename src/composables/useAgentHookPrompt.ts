/**
 * 起動時に 1 度だけ、Claude Code の hook を登録するか聞く（#299）。
 *
 * hook を入れないと、Pike は `CLAUDE_CONFIG_DIR` を**推測**するしかない。設定画面まで
 * 来ない人には気付きようがないので、設定ディレクトリが実在するのに hook がどこにも
 * 入っていないときだけ、こちらから一度だけ提案する。
 *
 * ## 聞く条件
 *
 * - **main ウィンドウだけ**。hook の登録はマシン全体の話で、ウィンドウごとに聞く
 *   ことではない（複数ウィンドウを復元する起動で同じダイアログが並ぶ）
 * - **プロジェクトを開いているとき**。候補はシェルから決まるので、どのシェルの
 *   アカウントを指すかが決まっていないと宛先が選べない
 * - **1 つも登録されていないとき**。1 つでも入っていれば導入は済んでいるので、
 *   アカウントを増やしたぶんは設定画面で足す（毎回聞かれるほうが煩い）
 *
 * ## 聞かない記録
 *
 * 断られたら `pike:agent-hook-declined` に記録して二度と聞かない。**マシンローカル**
 * （同期の対象外）なのは、hook が settings.json というマシン上のファイルへの登録だから。
 * 別のマシンで断ったことは、このマシンで聞かない理由にならない（`pike:link-title-asked`
 * と同じ判断）。
 */

import { t } from '../i18n'
import { agentHookInstallMissing, agentHookStatus } from '../lib/tauri'
import { isMainWindow } from '../lib/window'
import { useProjectStore } from '../stores/project'
import { confirmDialog } from './useConfirmDialog'

const DECLINED_KEY = 'pike:agent-hook-declined'

/**
 * 条件がそろっていれば聞いて、承諾されたら未登録の候補すべてに登録する。
 *
 * **候補は今のプロジェクトのシェルとホストのぶんだけ**（distro の一覧を渡さない）。
 * 全 distro を並べるには `wsl.exe` を起こす必要があり、「検出のためだけに起動時へ
 * `wsl.exe` を足さない」（`.claude/rules/project.md`）に反する。網羅は設定画面の役目で、
 * ここは導入の入口。
 *
 * 失敗は握り潰す（起動時の提案が失敗して困ることは何も無い）。
 */
export async function offerAgentHook(): Promise<void> {
  if (!isMainWindow()) return
  try {
    if (localStorage.getItem(DECLINED_KEY)) return
  } catch {
    // ストレージが使えない環境では「断られていない」として進む。
  }
  const projectStore = useProjectStore()
  if (!projectStore.activeRoot) return

  const status = await agentHookStatus(projectStore.shellForIO, projectStore.activeRoot, [])
  if (status.targets.length === 0 || status.targets.some((t) => t.registered)) return

  const dirs = status.targets.map((target) => `- ${target.configDir}`).join('\n')
  const ok = await confirmDialog(t('settings.agentHookOffer', { dirs }))
  if (!ok) {
    try {
      localStorage.setItem(DECLINED_KEY, '1')
    } catch {}
    return
  }
  await agentHookInstallMissing(projectStore.shellForIO, projectStore.activeRoot, [])
}
