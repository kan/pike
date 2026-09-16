/**
 * 選択した文字列をクリップボードへ写す（`terminalCopyOnSelect`）。xterm を載せる 2 つの
 * タブ（ターミナルと Docker ログ）が共有する。
 *
 * **`onSelectionChange` の中で書くこと。mouseup まで持ち越してはいけない。** xterm が
 * この出来事を出すのは `SelectionService` の mouseup の腕からで（mousemove は一度も
 * 出さない）、つまりここは既に document の mouseup を配送している最中＝ user gesture の
 * 中にいる。ここで `document` へ mouseup のリスナを足しても、**その回には呼ばれない**
 * （DOM はイベントが対象へ届いた時点でリスナ一覧を複製する）ので、コピーが 1 操作ぶん
 * 遅れ、**次の無関係なクリックで古い選択がクリップボードを上書きする**。#342 で一度
 * そう書いてレビューで見つかった。
 *
 * **選択の文字列は関数で受ける。** `Terminal.getSelection()` はキャッシュを持たず、選択の
 * 行数ぶんの文字列を毎回組み立てる。設定が OFF の人にそれを払わせないよう、判定を通って
 * から読む。
 */
import { t } from '../i18n'
import { loadJson, saveJson } from '../lib/storage'
import { useSettingsStore } from '../stores/settings'
import { confirmWithOption } from './useConfirmDialog'

/**
 * 初回の確認を出したかどうか（#342）。**マシンローカル**（同期の対象外）で、
 * `pike:link-title-asked` と同じ扱い。設定そのもの（`terminalCopyOnSelect`）は同期するが、
 * 「聞いたか」はこのマシンでの出来事なので配らない。
 */
const ASKED_KEY = 'pike:copy-on-select-asked'

/** xterm の `onSelectionChange` から呼ぶ。`read` が空文字を返すのは「選択が消えた」。 */
export function copyOnSelect(read: () => string) {
  const settings = useSettingsStore()
  if (!settings.terminalCopyOnSelect) return
  const text = read()
  if (!text) return
  if (loadJson<boolean>(ASKED_KEY, false)) {
    void write(text)
    return
  }
  void askOnce(settings, text)
}

/**
 * 初回だけ聞いてから書く（#342）。既定が ON なので、黙って書くと利用者がクリップボードに
 * 置いていたものが最初の選択で消える。
 *
 * **承諾されたこの 1 回ぶんは macOS で書けないことがある**（ダイアログを待つあいだに
 * gesture が切れる）。次の選択からは上の経路＝ gesture の中に戻るので、この 1 回のために
 * 「先に書いてから聞く」へ倒すことはしない（それでは聞く意味が無い）。
 *
 * **二重に開く心配は要らない**: ダイアログのオーバーレイが画面を覆うので、開いているあいだ
 * 新しいマウス選択は始まらない（Pike は xterm の `selectAll` 等も呼ばない）。
 */
async function askOnce(settings: ReturnType<typeof useSettingsStore>, text: string) {
  const { ok, displaced } = await confirmWithOption(t('confirm.copyOnSelect'), '')
  // 答える前に別のダイアログへ置き換わったぶんは、聞かなかったことにする（次の選択でまた聞く）。
  if (displaced) return
  // **記録するのは答えが返ってから**（`useMarkdownLinkPaste` と同じ）。先に書くと、
  // 閉じられたときに「もう聞いた」と誤認して二度と聞かなくなる。
  saveJson(ASKED_KEY, true)
  // 閉じられた（Escape / オーバーレイ）ときも「いいえ」に倒す。クリップボードを黙って
  // 上書きしないほうが安全側で、設定画面からいつでも戻せる。
  if (!ok) {
    settings.terminalCopyOnSelect = false
    return
  }
  await write(text)
}

async function write(text: string) {
  try {
    await navigator.clipboard.writeText(text.replace(/\r\n/g, '\n'))
  } catch {
    // 書けない環境（gesture の外、クリップボードの権限なし）では知らせる相手が居ない。
  }
}
