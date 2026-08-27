/**
 * Turning a pasted URL into `[タイトル](url)` in a Markdown document (#241).
 *
 * **選択範囲があるときは触らない。** `@codemirror/lang-markdown` の `pasteURLAsLink` が
 * `[選択文字](url)` を作る担当で、作者が自分で書いた文字のほうが取得したタイトルより
 * 良い。ここが受け持つのは「カーソルだけの位置に裸の URL を貼った」場合だけ。
 *
 * **無効なときは貼り付けに触らない。** 機能が OFF（かつ提案済み）なら `false` を返して
 * CodeMirror の既定に任せる。以前は常に横取りして自前で挿入し、そのあと非同期に「無効
 * だった」と分かる形だったので、既定 OFF の常用パスが素の貼り付けの再実装になっていた。
 *
 * **URL は先に入れて、タイトルは後から差し替える。** 取得を待ってから挿入すると、
 * 貼り付けたのに数秒何も起きない見た目になる。先に入れておけば、取得に失敗しても
 * 「ただの URL が貼られた」という従来どおりの結果で終わる。undo は 2 段になるが、
 * 1 回戻すと素の URL に戻るので、むしろ扱いやすい。
 *
 * 差し替え位置は {@link pendingField} が追跡する。取得の最中に作者が上の行を編集しても
 * ずれないようにするためで、素朴に「貼った時の from/to」を覚えると別の場所を壊す。
 */

import { type Extension, StateEffect, StateField } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { t } from '../i18n'
import { isHttpUrl, markdownLink } from '../lib/editorMarkdown'
import { loadJson, saveJson } from '../lib/storage'
import { pageTitleFetch } from '../lib/tauri'
import { useSettingsStore } from '../stores/settings'
import { useStatusMessageStore } from '../stores/statusMessage'
import { confirmDialog } from './useConfirmDialog'

/**
 * 有効化を提案したかどうか。**マシンローカル**にする: 設定そのものは同期されるので、
 * 別のマシンで有効にしてあれば聞く必要がそもそも無く、無効のままなら「このマシンでは
 * 一度も聞いていない」が正しい判定になる。
 */
const ASKED_KEY = 'pike:link-title-asked'

/** 空白を含まない、丸ごと 1 本の http(s) URL か。 */
function isBareUrl(text: string): boolean {
  return !/\s/.test(text) && isHttpUrl(text)
}

/** 追跡中の 1 件。`id` は差し替えのときに自分の分を見つけるためだけのもの。 */
interface Pending {
  id: number
  from: number
  to: number
}

const addPending = StateEffect.define<Pending>()
const dropPending = StateEffect.define<number>()

/**
 * 取得待ちの範囲。編集が入るたびに `map` で位置を追従させるので、上の行が伸び縮み
 * しても差し替え先がずれない。
 *
 * **assoc は `from` に +1、`to` に -1**（既定の向きの逆）。境界ちょうどに入った文字を
 * 範囲の**外**に置くための指定で、これを既定のままにすると両端が貪欲になる。貼った直後の
 * カーソルは `to` にあるので、取得を待つあいだに書き続けるという最も自然な操作
 * （`…see https://example.com/x for details`）で打った文字が範囲に入り、差し替え直前の
 * 「まだ URL のままか」の確認に引っかかって、タイトルが黙って入らなくなる。
 *
 * **何も待っていないときは即座に戻る。** この field は Markdown タブに常時入っていて
 * `update` は打鍵のたびに走るが、pending がいるのは貼り付けから取得完了までの数秒だけ。
 * 空配列を毎回 map すると、その都度新しい配列を確保することになる。
 */
const pendingField = StateField.define<Pending[]>({
  create: () => [],
  update(value, tr) {
    const adding = tr.effects.some((e) => e.is(addPending))
    if (value.length === 0 && !adding) return value
    let next = value
    if (tr.docChanged) {
      next = next.map((p) => ({ id: p.id, from: tr.changes.mapPos(p.from, 1), to: tr.changes.mapPos(p.to, -1) }))
    }
    for (const effect of tr.effects) {
      if (effect.is(addPending)) next = [...next, effect.value]
      else if (effect.is(dropPending)) next = next.filter((p) => p.id !== effect.value)
    }
    return next
  },
})

export interface MarkdownLinkPaste {
  /**
   * CM6 拡張。差し替え位置の追跡だけを持つ。
   *
   * **ハンドラと同じ場所（markdown の compartment）へ入れること。** 基本の拡張リストに
   * 置くと、Markdown でないタブや読み取り専用タブ — pending が入りようのないタブ — でも
   * `update` が回り続ける。
   */
  extension: Extension
  /** Entries for `EditorView.domEventHandlers`（`useMarkdownImages` と同じ形）。 */
  handlers: {
    paste: (event: ClipboardEvent, view: EditorView) => boolean
  }
}

export function useMarkdownLinkPaste(): MarkdownLinkPaste {
  const settings = useSettingsStore()
  const statusMessage = useStatusMessageStore()
  let nextId = 0
  /** 提案のダイアログ。開いているあいだは同時の貼り付けがこれを共有する。 */
  let asking: Promise<boolean> | null = null
  /** 取得中の件数。0 になったときだけ表示を消す。 */
  let inFlight = 0

  /** 提案がまだなら、一度だけ聞く。 */
  function askOnce(): Promise<boolean> {
    if (!asking) {
      asking = confirmDialog(t('markdown.linkTitleAsk')).then((ok) => {
        // **記録するのは答えが返ってから**で、開く前ではない。先に書くと、続けて 2 本目を
        // 貼ったときに「もう聞いた」と誤認して無効のまま進み、Escape で閉じた場合は
        // 二度と提案されなくなる。
        saveJson(ASKED_KEY, true)
        if (ok) settings.markdownFetchLinkTitle = true
        asking = null
        return ok
      })
    }
    return asking
  }

  /**
   * 取得中の表示。**件数を数える**のは、StatusBar が 1 つしかないため。先に終わった
   * ぶんが hide すると、まだ動いている取得の最中に「何もしていない」表示になる。
   */
  function startIndicator() {
    inFlight += 1
    statusMessage.show({ text: t('markdown.linkTitleFetching'), variant: 'loading' })
  }

  function endIndicator() {
    inFlight -= 1
    if (inFlight === 0) statusMessage.hide()
  }

  /** `from` から始まる URL を、取得できたタイトルのリンクに差し替える。 */
  async function resolveTitle(view: EditorView, url: string, id: number) {
    let title: string | null = null
    try {
      title = await pageTitleFetch(url)
    } catch {
      // 取れないのは珍しくない（404、HTML でない、社内ホスト）。URL は既に入って
      // いるので、黙ってそのままにする。
    }
    const pending = view.state.field(pendingField, false)?.find((p) => p.id === id)
    view.dispatch({ effects: dropPending.of(id) })
    if (!title || !pending) return
    // 貼ったあとに作者がそこを書き換えていたら、もう作者のテキスト。触らない。
    if (view.state.sliceDoc(pending.from, pending.to) !== url) return
    view.dispatch({ changes: { from: pending.from, to: pending.to, insert: markdownLink(title, url) } })
  }

  /** 文書に入っている `[from, from+url.length)` の URL を追跡対象にして、取得を始める。 */
  function track(view: EditorView, url: string, from: number) {
    const id = nextId++
    view.dispatch({ effects: addPending.of({ id, from, to: from + url.length }) })
    startIndicator()
    void resolveTitle(view, url, id).finally(endIndicator)
  }

  function paste(event: ClipboardEvent, view: EditorView): boolean {
    const data = event.clipboardData
    if (!data || data.files.length > 0) return false
    const { ranges, main } = view.state.selection
    // 選択があるときは lang-markdown の `pasteURLAsLink` の担当。
    //
    // カーソルが複数あるときも見送る: `replaceSelection` は全部の位置に入れるので、
    // main から求めた 1 つの範囲では「どれを差し替えるのか」が決まらない。素の貼り付け
    // として CodeMirror に任せるほうが、間違った場所を書き換えるより良い。
    if (ranges.length !== 1 || !main.empty) return false
    const text = data.getData('text/plain').trim()
    if (!isBareUrl(text)) return false

    const from = main.from
    if (settings.markdownFetchLinkTitle) {
      event.preventDefault()
      view.dispatch(view.state.replaceSelection(text))
      track(view, text, from)
      return true
    }
    // まだ提案していなければ、**素の貼り付けは CodeMirror にさせたうえで**聞く。
    // 横取りしないので、断られた場合も「普通に貼られた」だけで終わり、こちらは
    // 何も後始末しなくてよい。承諾されたら、既に入っている URL をそのまま追跡する。
    if (!loadJson<boolean>(ASKED_KEY, false)) {
      void askOnce().then((ok) => {
        if (ok && view.state.sliceDoc(from, from + text.length) === text) track(view, text, from)
      })
    }
    return false
  }

  return { extension: pendingField, handlers: { paste } }
}
