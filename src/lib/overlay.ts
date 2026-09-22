/**
 * 手前に浮いているもの（メニュー・ドロップダウン・ツールチップ）の数（#396）。
 *
 * **ブラウザのタブの子 webview は Pike の DOM より手前に描かれる**ので、浮いたものが
 * 開いているあいだは隠さないとその下に埋もれる（`BrowserTab.vue` の `shown`）。確認
 * ダイアログ・QuickOpen・プロジェクトスイッチャー・ショートカット一覧は元から専用の
 * ref を持っていて向こうが直に読むが、**右クリックメニューやプルダウンは開閉の ref が
 * コンポーネントごとにばらばら**で、読みに行く先が無かった。ここが唯一の置き場。
 *
 * **`.popup-surface` を DOM で探す形は採らない。** 規約としては全部のポップアップに
 * 付いているので一見まとめて拾えるが、見張るには `document.body` の subtree に
 * MutationObserver を張ることになる。ターミナルは xterm の DOM レンダラーなので
 * 出力のたびに大量の childList の変化が出て、そのぶんのレコードを作り続けることになる。
 *
 * **数えるのは「自分より前に出るもの」だけ。** 入れ子のサブメニューは、親を開いた時点で
 * 既に数えられているので登録しない（二重に数えても動くが、対応が取れているかを
 * 読み手が確かめられなくなる）。
 */
import { onScopeDispose, ref, watch } from 'vue'

/** 開いているものの数。**直に触らないこと**（`useOverlay` が対で増減する）。 */
const openCount = ref(0)

/**
 * 手前に浮いているものがあるか。
 *
 * **関数にしてあるのは、computed の中から呼んで依存を張らせるため**（`dialogOpen()` と
 * 同じ形）。ref をそのまま公開すると、呼ぶ側が `.value` を書くか書かないかでリアクティブ
 * かどうかが黙って変わる。
 */
export function overlayOpen(): boolean {
  return openCount.value > 0
}

/**
 * 開いているあいだ数える。**コンポーネントの setup で 1 回呼ぶ**（`isOpen` は開閉の
 * ref か、それを返す関数）。
 *
 * 閉じ忘れは起きない: 値が false に戻れば減らし、コンポーネントが消えるときも
 * `onScopeDispose` が減らす（メニューを開いたままプロジェクトを切り替える、など）。
 *
 * **読む ref より後で呼ぶこと。** `immediate` の `watch` なのでその場で 1 回評価し、
 * まだ宣言していない `const` を読むと ReferenceError になる（型検査では出ない）。
 */
export function useOverlay(isOpen: () => boolean): void {
  let counted = false
  const set = (v: boolean) => {
    if (v === counted) return
    counted = v
    openCount.value += v ? 1 : -1
  }
  watch(isOpen, set, { immediate: true })
  onScopeDispose(() => set(false))
}
