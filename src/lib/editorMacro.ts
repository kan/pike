/**
 * キーボードマクロ（#180）。サクラエディタと同じく、エディタでの操作を記録して再生する。
 * `Mod+Shift+M` で記録の開始・停止、`Mod+Shift+L` で再生。
 *
 * **記録するのは「押したキー」と「キーでは表せない入力」だけ**で、結果の差分ではない。
 * 差分を記録すると「カーソルのある場所で同じことをする」にならない（別の行で再生すると、
 * 記録した行を書き換えに行く）。キーなら再生した場所で同じ操作になる。
 *
 * - キー … 再生では `runScopeHandlers` でエディタのキーマップに流す（Enter・Backspace・
 *   矢印・`Mod-z` など、キーマップに載っている操作はそれで同じことが起きる）。どの
 *   キーマップも受けなかった印字できるキーは、打鍵と同じく文字として入れる
 * - 文字列 … IME の確定と貼り付け。どちらもキーから再現できない（IME は `Process`
 *   しか来ず、貼り付けはクリップボードの中身が再生時には変わっている）
 * - 切り取り … 選択範囲を消す。クリップボードへの書き込みは再現しない
 *
 * **記録しないもの**: マウスの操作と検索パネルの中の入力（イベントがエディタの本文に来ない）。
 * サクラの記録も同じ線引き。
 *
 * マクロは 1 つだけで、このマシンの localStorage に残す（他のウィンドウで記録したものは
 * `storage` イベントで取り込む）。記録中かどうかはウィンドウごと。
 */

import { Prec } from '@codemirror/state'
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view'
import { computed, ref } from 'vue'
import { t } from '../i18n'
import { useStatusMessageStore } from '../stores/statusMessage'
import { chordLabel, matchParsedChord, parseChord, toCodeMirrorKey } from './keys'
import { loadJson, saveJson } from './storage'

type MacroStep =
  | { kind: 'key'; key: string; code: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'cut' }

const STORAGE_KEY = 'pike:editor-macro'

/** キーの正本。CodeMirror のキーマップ・ショートカット一覧・案内の文言がここから作る。 */
export const MACRO_CHORDS = { record: 'Mod+Shift+M', play: 'Mod+Shift+L' } as const

/** 記録中か（StatusBar が出す）。 */
export const macroRecording = ref(false)

let steps: MacroStep[] = []

/**
 * 保存済みのマクロ。localStorage の写しで、再生はこれを読む。**別のウィンドウで記録した
 * ものは `storage` イベントで取り込む**（あのイベントは書いたウィンドウ自身には届かない
 * ので、自分の保存は `toggleMacroRecording` が入れる）。
 */
const savedMacro = ref<MacroStep[]>(loadMacro())

/** 再生できるマクロがあるか（ツールバーの再生ボタンを出すか）。 */
export const macroSaved = computed(() => savedMacro.value.length > 0)

let listening = false

/** `storage` の購読は、エディタに拡張を入れた時点で 1 回だけ張る（import しただけでは張らない）。 */
function listenOtherWindows() {
  if (listening) return
  listening = true
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) savedMacro.value = loadMacro()
  })
}

const MACRO_PARSED = [parseChord(MACRO_CHORDS.record), parseChord(MACRO_CHORDS.play)]

function notify(key: string, warn = false) {
  const labels = { record: chordLabel(MACRO_CHORDS.record), play: chordLabel(MACRO_CHORDS.play) }
  useStatusMessageStore().show({ text: t(key, labels), variant: warn ? 'warn' : 'info', durationMs: 2500 })
}

/**
 * 自分の 2 つのキーを記録に入れない。入れると再生のたびに記録が始まり、再生が再帰する。
 * 判定は `MACRO_CHORDS` から作る（キーを変えたとき、ここだけ古いまま残らないように）。
 */
function isMacroKey(e: KeyboardEvent): boolean {
  return MACRO_PARSED.some((c) => matchParsedChord(e, c))
}

function loadMacro(): MacroStep[] {
  const v = loadJson<unknown>(STORAGE_KEY, [])
  return Array.isArray(v) ? (v as MacroStep[]) : []
}

/** 記録を始めるか止める。止めたときに 1 つも操作が無ければ、前のマクロを残す。 */
export function toggleMacroRecording() {
  if (!macroRecording.value) {
    steps = []
    macroRecording.value = true
    notify('macro.started')
    return
  }
  macroRecording.value = false
  if (steps.length === 0) {
    notify('macro.empty', true)
    return
  }
  saveJson(STORAGE_KEY, steps)
  savedMacro.value = steps
  steps = []
  notify('macro.saved')
}

/** 文字を打鍵と同じ経路で入れる（括弧の自動補完などの `inputHandler` も通す）。 */
function insertText(view: EditorView, text: string) {
  const { from, to } = view.state.selection.main
  const tr = () =>
    view.state.update(view.state.replaceSelection(text), { userEvent: 'input.type', scrollIntoView: true })
  if (view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, text, tr))) return
  view.dispatch(tr())
}

/** 切り取りの再生。**選択が空の範囲はカーソルのある行を丸ごと消す**（CodeMirror の `Ctrl+X` と同じ）。 */
function cutSelection(view: EditorView) {
  const { doc } = view.state
  const changes = view.state.selection.ranges.map((r) => {
    if (!r.empty) return { from: r.from, to: r.to }
    const line = doc.lineAt(r.head)
    return { from: line.from, to: Math.min(line.to + 1, doc.length) }
  })
  view.dispatch({ changes, userEvent: 'delete.cut', scrollIntoView: true })
}

/**
 * 記録したマクロを `view` で再生する。記録中は再生しない（記録に再生が混ざる）。
 *
 * **読み取り専用なら何もしない。** `EditorState.readOnly` が止めるのはキーマップ経由の編集
 * だけで、ここが直に投げる `dispatch` は通る。部分読み込み（#362）のように、ビューを作った
 * あとから読み取り専用になるタブもあるので、拡張を入れるかどうかでは守れない。
 */
export function playMacro(view: EditorView) {
  if (view.state.readOnly) return
  if (macroRecording.value) {
    notify('macro.play.recording', true)
    return
  }
  const macro = savedMacro.value
  if (macro.length === 0) {
    notify('macro.play.empty', true)
    return
  }
  for (const s of macro) {
    if (s.kind === 'text') {
      insertText(view, s.text)
    } else if (s.kind === 'cut') {
      cutSelection(view)
    } else {
      const ev = new KeyboardEvent('keydown', {
        key: s.key,
        code: s.code,
        ctrlKey: s.ctrl,
        shiftKey: s.shift,
        altKey: s.alt,
        metaKey: s.meta,
      })
      if (runScopeHandlers(view, ev, 'editor')) continue
      // どのキーマップも受けなかった印字できるキーは、打鍵と同じく文字になる。
      // Ctrl+Alt は Windows の AltGr なので文字として扱う。
      const printable = s.key.length === 1 && !s.meta && (!s.ctrl || s.alt)
      if (printable) insertText(view, s.key)
    }
  }
}

/**
 * エディタに入れる拡張。**記録は observer で行う**（入力を奪わない。記録中も普通に編集できる）。
 * 読み取り専用のタブには入れない（再生しても書けない）。
 */
export function editorMacro() {
  listenOtherWindows()
  return [
    // 検索の `Mod-Shift-l`（同じ文字列をすべて選択）より先に取る。
    Prec.high(
      keymap.of([
        {
          key: toCodeMirrorKey(MACRO_CHORDS.record),
          run: () => {
            toggleMacroRecording()
            return true
          },
        },
        {
          key: toCodeMirrorKey(MACRO_CHORDS.play),
          run: (view) => {
            playMacro(view)
            return true
          },
        },
      ]),
    ),
    EditorView.domEventObservers({
      keydown(e) {
        if (!macroRecording.value || e.isComposing || e.key === 'Process' || isMacroKey(e)) return
        // 修飾キーだけの打鍵は操作ではない。
        if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return
        steps.push({
          kind: 'key',
          key: e.key,
          code: e.code,
          ctrl: e.ctrlKey,
          shift: e.shiftKey,
          alt: e.altKey,
          meta: e.metaKey,
        })
      },
      compositionend(e) {
        if (macroRecording.value && e.data) steps.push({ kind: 'text', text: e.data })
      },
      paste(e) {
        const text = e.clipboardData?.getData('text/plain')
        if (macroRecording.value && text) steps.push({ kind: 'text', text })
      },
      cut() {
        if (macroRecording.value) steps.push({ kind: 'cut' })
      },
    }),
  ]
}
