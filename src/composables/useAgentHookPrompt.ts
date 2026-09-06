/**
 * Claude Code の hook を登録するか、シェルごとに 1 度だけ聞く（#299 / #265）。
 *
 * hook を入れないと、Pike は `CLAUDE_CONFIG_DIR` を**推測**するしかなく（#299）、入力待ちの
 * 知らせも届かない（#265）。設定画面まで来ない人には気付きようがないので、設定ディレクトリが
 * 実在するのに hook が入っていないときだけ、こちらから提案する。
 *
 * ## 聞く条件
 *
 * - **main ウィンドウだけ**。hook の登録はマシン全体の話で、ウィンドウごとに聞くことでは
 *   ない（複数ウィンドウを復元する起動で同じダイアログが並ぶ）
 * - **プロジェクトを開いているとき**。候補はシェルから決まるので、どのシェルのアカウントを
 *   指すかが決まっていないと宛先が選べない
 * - **そのシェル（`installKey`）についてまだ聞いていないとき**
 * - **そのシェルの候補に未登録のものがあるとき**
 *
 * ## シェルごとに聞く（#265 で変えた）
 *
 * 以前は「1 つでも登録済みなら聞かない」「断ったら二度と聞かない」というマシンに 1 つの
 * 判断だった。**それだと片方のプラットフォームしか登録されない**: Windows のプロジェクトで
 * 起動して承諾しても、候補に挙がるのは Windows のホームだけで、WSL のプロジェクトへ
 * 切り替えたときには「もう登録済み」と見なされて何も起きない（実際に踏んだ）。
 *
 * hook は**設定ディレクトリごと**に要り、その置き場はシェルで変わるので、記録も判断も
 * シェル単位にする。切り替えの契機は `App.vue` の watcher。
 *
 * ## 聞いた記録
 *
 * `pike:agent-hook-asked` に `installKey` の配列で持つ。**マシンローカル**（同期の対象外）
 * なのは、hook が settings.json というマシン上のファイルへの登録だから。別のマシンで聞いた
 * ことは、このマシンで聞かない理由にならない（`pike:link-title-asked` と同じ判断）。
 */

import { t } from '../i18n'
import { agentHookInstallMissing, agentHookStatus } from '../lib/tauri'
import { isMainWindow } from '../lib/window'
import { useProjectStore } from '../stores/project'
import { installKey } from '../types/tab'
import { confirmDialog, dialogOpen } from './useConfirmDialog'

const ASKED_KEY = 'pike:agent-hook-asked'
/** 旧「断った」の記録（マシンに 1 つ）。読むのは移行のときだけ。 */
const DECLINED_KEY = 'pike:agent-hook-declined'

/**
 * 条件がそろっていれば聞いて、承諾されたら未登録の候補すべてに登録する。
 *
 * **候補は今のプロジェクトのシェルとホストのぶんだけ**（distro の一覧を渡さない）。全 distro を
 * 並べるには `wsl.exe` を起こす必要があり、「検出のためだけに起動時へ `wsl.exe` を足さない」
 * （`.claude/rules/project.md`）に反する。網羅は設定画面の役目で、ここは導入の入口。
 *
 * 失敗は握り潰す（提案が失敗して困ることは何も無い）。
 */
export async function offerAgentHook(): Promise<void> {
  if (!isMainWindow()) return
  const projectStore = useProjectStore()
  if (!projectStore.activeRoot) return

  const key = installKey(projectStore.shellForIO)
  const asked = migrateDeclined(key, loadAsked())
  // **記録があれば IPC を投げない。** `agentHookStatus` は解決（WSL では対話ログイン
  // シェル）と候補ぶんの `settings.json` 読みを伴うので、プロジェクトを切り替えるたびに
  // 走らせるには重い。
  if (asked.includes(key)) return

  const status = await agentHookStatus(projectStore.shellForIO, projectStore.activeRoot, [])
  if (status.targets.length === 0) return
  // 全部入っているなら聞くことが無い。**記録は残す**（次の切り替えで IPC を投げないため）。
  if (status.targets.every((target) => target.registered)) {
    remember(key)
    return
  }

  // **他のダイアログが開いていたら譲る**（記録もしない）。`confirmDialog` は開く前に
  // 前のものを `dismiss()`＝**偽で解決**するので、割り込むと相手の答えを奪ううえ、
  // 自分も「断られた」ことになって記録される。そうなるとそのシェルは二度と聞かれない。
  // 起こりうるのは、`agentHookStatus` の probe（数秒）のあいだに一時プロジェクトの
  // 「登録しますか」が出たときや、その最中にもう一度プロジェクトを切り替えたとき。
  if (dialogOpen()) return

  const dirs = status.targets.map((target) => `- ${target.configDir}`).join('\n')
  const ok = await confirmDialog(t('settings.agentHookOffer', { dirs }))
  // **答えに関わらず記録する。** 断られたら聞かない、承諾されたら登録済みになるので、
  // どちらでも次はここへ来ない。
  remember(key)
  if (!ok) return
  await agentHookInstallMissing(projectStore.shellForIO, projectStore.activeRoot, [])
}

function loadAsked(): string[] {
  try {
    const raw = localStorage.getItem(ASKED_KEY)
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []
  } catch {
    // ストレージが使えない環境では「まだ聞いていない」として進む。
    return []
  }
}

/**
 * 「聞いた」を記録する。**書く直前に読み直す**（`localStorage` はウィンドウ間で共有
 * なので、手元の配列を書き戻すと、待っているあいだに別のウィンドウが足したキーを消す）。
 */
function remember(key: string) {
  try {
    localStorage.setItem(ASKED_KEY, JSON.stringify([...new Set([...loadAsked(), key])]))
  } catch {}
}

/**
 * 旧「断った」の記録を、**今のシェルについて聞いた**という記録に読み替える（#265）。
 *
 * 断ったのは起動時に開いていたプロジェクトのシェルなので、そのときと同じ状況で聞き直さない
 * ぶんには近い。**別のシェルのぶんは聞き直す**（それがこの変更の目的）。
 */
function migrateDeclined(key: string, asked: string[]): string[] {
  try {
    if (!localStorage.getItem(DECLINED_KEY)) return asked
    localStorage.removeItem(DECLINED_KEY)
  } catch {
    return asked
  }
  remember(key)
  return [...new Set([...asked, key])]
}
