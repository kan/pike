/**
 * Pike ごと終了する操作の前に出す確認（#178）。
 *
 * ウィンドウは自分のタブしか知らないが、終了すると**全ウィンドウの PTY が同時に死ぬ**
 * ので、件数は Rust から取る。**Pike ごと終了する経路（ウィンドウの close・macOS の `⌘Q`・
 * セルフアップデート・トレイの「終了」）は、どれもここを通す。**
 */

import { t } from '../i18n'
import { appExit, ptyBusyCount } from '../lib/tauri'
import { confirmDialog } from './useConfirmDialog'

/**
 * `known` は呼び出し側が既に数えた件数（トレイの「終了」は Rust が数えてから頼む）。
 * 省けばここで数える。数える判定は WSL のターミナル 1 枚につき `wsl.exe` を起こすので、
 * 数え終わっているなら 2 回走らせない。
 */
export async function confirmBusyExit(known?: number): Promise<boolean> {
  const running = known ?? (await ptyBusyCount().catch(() => 0))
  return running === 0 || (await confirmDialog(t('confirm.terminalBusyExit', { count: running })))
}

/**
 * 確認を取ってから Pike を終了する。**終了の綴りをここ 1 本にする**ため、
 * 呼び出し側は結果を見ない（断られたら何もしないのが正しい）。
 */
export async function confirmAndExit(known?: number): Promise<void> {
  if (await confirmBusyExit(known)) await appExit().catch(() => {})
}
