/**
 * ターミナルの「選択時にコピー」の値（#408）。設定（`stores/settings.ts`）と同期ファイルの
 * 読み込み（`lib/syncFormat.ts`）が共有する。**ストアを import しない**（同期のテストが
 * このファイルを直に読む）。
 *
 * `ask` は選択のたびに聞き、その場で 3 つのどれにするかを選べる（`useCopyOnSelect`）。
 * **既定は `ask`**: 黙って書くと、利用者がクリップボードに置いていたものが最初の選択で消える。
 */
export const COPY_ON_SELECT_MODES = ['always', 'ask', 'off'] as const
export type CopyOnSelectMode = (typeof COPY_ON_SELECT_MODES)[number]

/** 設定画面の並び。確認のダイアログはこの逆順で出す（決定のボタンを右端に置くため）。 */
export const COPY_ON_SELECT_OPTIONS: { value: CopyOnSelectMode; labelKey: string }[] = [
  { value: 'always', labelKey: 'settings.copyOnSelectAlways' },
  { value: 'ask', labelKey: 'settings.copyOnSelectAsk' },
  { value: 'off', labelKey: 'settings.copyOnSelectOff' },
]

export function sanitizeCopyOnSelectMode(v: unknown): CopyOnSelectMode {
  return COPY_ON_SELECT_MODES.includes(v as CopyOnSelectMode) ? (v as CopyOnSelectMode) : 'ask'
}

/**
 * 真偽値だったころ（#342）の「初回の確認をしたか」の記録。**マシンローカル**で、もう読み手は
 * 設定の移行（`withCopyOnSelectMode`）だけ。
 */
export const LEGACY_COPY_ON_SELECT_ASKED_KEY = 'pike:copy-on-select-asked'

/** 古い版が読む真偽値（`terminalCopyOnSelect`）。`ask` は「コピーする（初回だけ聞く）」と読ませる。 */
export const copyOnSelectEnabled = (mode: CopyOnSelectMode): boolean => mode !== 'off'

/**
 * 古い版の真偽値を 3 値に読み替える。**`true` は「初回の確認に承諾した」か「まだ聞かれて
 * いない」かのどちらか**（既定が `true` だった）で、見分けられるのは、このマシンで聞いたか
 * （`asked`）を知っているときだけ。知らなければ `ask` に倒す（「常に」を選んだとは言えないので、
 * 聞くほうが安全側）。
 */
export const legacyCopyOnSelectMode = (on: boolean, asked: boolean): CopyOnSelectMode =>
  !on ? 'off' : asked ? 'always' : 'ask'
