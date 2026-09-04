import { ref } from 'vue'

/**
 * StatusBar のクリックに応える、アクティブなエディタタブの操作。
 *
 * **1 つのオブジェクトで受け取る。** 位置引数だったころは省略できる末尾が 1 つあり、
 * 登録する 2 箇所（読み込み直後とタブ切替）で渡す数が食い違っていた ―― タブを切り替えて
 * 戻すと「このエンコードで保存」だけ効かない、という形で出る。全部必須にすれば型が守る。
 */
export interface EditorActions {
  changeEncoding: (encoding: string) => void
  changeLineEnding: (le: 'LF' | 'CRLF') => void
  saveWithEncoding: (encoding: string) => void
  /** `null` は自動判定へ戻す。 */
  changeFileType: (key: string | null) => void
}

export interface EditorInfo {
  line: number
  col: number
  encoding: string
  lineEnding: 'LF' | 'CRLF'
  fileType: string
  /** 手動で選んだキー。null なら自動判定（ドロップダウンの選択の印に使う）。 */
  fileTypeKey: string | null
  tabSize: number
  tabId: string
  /**
   * **表示と一緒に持つ。** 別のスロットに分けて登録する形だと、書き手が 2 つになって
   * 所有者がずれる: 読み込みの `await` 中に別のタブへ切り替えると、表示は切り替え先の
   * ものなのに操作だけ後から解決した裏のタブのもの、という状態が作れてしまう（そのタブを
   * 閉じても、破棄済みのタブを指した操作が残る）。1 つにしておけば `update` の 1 経路だけが
   * 書き手になり、`clear` が両方を不可分に落とす。
   */
  actions: EditorActions
}

const current = ref<EditorInfo | null>(null)

export function useEditorInfo() {
  function update(info: EditorInfo) {
    current.value = info
  }

  /**
   * StatusBar の表示を降ろす。**自分が出していたときだけ**（`tabId` を渡した場合）。
   *
   * **watcher の走る順に頼らないこと。** `activeTabId` の watcher は開いているエディタタブ
   * 全部で走り、Vue はそれをマウント順（component uid の昇順）に流す。「去るタブ → 来るタブ」
   * の順ではないので、**先に開いたタブへ戻ると、来たタブが `update()` した後に去るタブが
   * ここへ来る**。所有権を見ないと、そこで消えてしまう（カーソルを動かすまで何も出ない）。
   *
   * 引数なしは「誰のものでも降ろす」（グローバルモードへ移るときに `main.ts` が呼ぶ）。
   * 形は `useOutlineSource.clear` と揃えてある。
   */
  function clear(tabId?: string) {
    if (!tabId || current.value?.tabId === tabId) current.value = null
  }

  function requestEncodingChange(encoding: string) {
    current.value?.actions.changeEncoding(encoding)
  }

  function requestLineEndingChange(le: 'LF' | 'CRLF') {
    current.value?.actions.changeLineEnding(le)
  }

  function requestSaveWithEncoding(encoding: string) {
    current.value?.actions.saveWithEncoding(encoding)
  }

  function requestFileTypeChange(key: string | null) {
    current.value?.actions.changeFileType(key)
  }

  return {
    current,
    update,
    clear,
    requestEncodingChange,
    requestLineEndingChange,
    requestSaveWithEncoding,
    requestFileTypeChange,
  }
}
