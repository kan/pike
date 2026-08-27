/**
 * Pike ごと終了する操作の前に出す確認（#178）。
 *
 * ウィンドウは自分のタブしか知らないが、終了すると**全ウィンドウの PTY が同時に死ぬ**
 * ので、件数は Rust から取る。呼ぶのは main ウィンドウの close（`main-exit-requested`）、
 * 最後のウィンドウの close、macOS の `⌘Q`（#254）の 3 つ。
 */

import { t } from '../i18n'
import { appExit, ptyBusyCount } from '../lib/tauri'
import { confirmDialog } from './useConfirmDialog'

export async function confirmBusyExit(): Promise<boolean> {
  const running = await ptyBusyCount().catch(() => 0)
  return running === 0 || (await confirmDialog(t('confirm.terminalBusyExit', { count: running })))
}

/**
 * 確認を取ってから Pike を終了する。**終了の綴りをここ 1 本にする**ため、
 * 呼び出し側は結果を見ない（断られたら何もしないのが正しい）。
 */
export async function confirmAndExit(): Promise<void> {
  if (await confirmBusyExit()) await appExit().catch(() => {})
}
