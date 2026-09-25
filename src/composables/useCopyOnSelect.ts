/**
 * 選択した文字列をクリップボードへ写す（`terminalCopyOnSelectMode`）。xterm を載せる 2 つの
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
import { COPY_ON_SELECT_OPTIONS } from '../lib/copyOnSelect'
import { useSettingsStore } from '../stores/settings'
import { choiceDialog } from './useConfirmDialog'

/** xterm の `onSelectionChange` から呼ぶ。`read` が空文字を返すのは「選択が消えた」。 */
export function copyOnSelect(read: () => string) {
  const settings = useSettingsStore()
  if (settings.terminalCopyOnSelectMode === 'off') return
  const text = read()
  if (!text) return
  if (settings.terminalCopyOnSelectMode === 'always') {
    void write(text)
    return
  }
  void ask(settings, text)
}

/**
 * 選択のたびに聞く（#408。`ask` のとき）。その場で「常にコピー」「毎回確認」「OFF」から選べ、
 * 選んだものが設定になる。「毎回確認」は今回はコピーして、次もまた聞く。
 *
 * **選ばずに閉じたら（Escape・オーバーレイ・別のダイアログに置き換わった）今回はコピーせず、
 * 設定も変えない。** クリップボードを黙って上書きしないほうが安全側。
 *
 * **二重に開く心配は要らない**: ダイアログのオーバーレイが画面を覆うので、開いているあいだ
 * 新しいマウス選択は始まらない（Pike は xterm の `selectAll` 等も呼ばない）。
 */
async function ask(settings: ReturnType<typeof useSettingsStore>, text: string) {
  // 設定画面の逆順（「常にコピー」を決定のボタンとして右端に置く）。
  const choice = await choiceDialog(
    t('confirm.copyOnSelect'),
    [...COPY_ON_SELECT_OPTIONS].reverse().map((o) => ({
      value: o.value,
      label: t(o.labelKey),
      primary: o.value === 'always',
    })),
  )
  if (!choice) return
  settings.terminalCopyOnSelectMode = choice
  // ボタンを押したクリックが gesture になるので、ここで書ける。
  if (choice !== 'off') await write(text)
}

async function write(text: string) {
  try {
    await navigator.clipboard.writeText(text.replace(/\r\n/g, '\n'))
  } catch {
    // 書けない環境（gesture の外、クリップボードの権限なし）では知らせる相手が居ない。
  }
}
