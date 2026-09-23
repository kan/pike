import { ref } from 'vue'
import { loadAskedKeys, rememberAskedKey } from '../lib/storage'

type Mode = 'confirm' | 'info' | 'prompt'

const visible = ref(false)
const message = ref('')
const mode = ref<Mode>('confirm')
const inputValue = ref('')
const inputPlaceholder = ref('')
/**
 * 入力を伏せ字にするか（#386 の鍵のパスフレーズ）。
 *
 * **`mode` を 4 つ目に増やさない。** 聞き方も答えの運び方も `prompt` と同じで、違うのは
 * `<input>` の `type` 1 つ。増やすと `respond` の分岐が両方を同じに扱う羽目になる。
 */
const inputMasked = ref(false)
/** 添えるチェックボックスの文言。空なら出さない。 */
const optionLabel = ref('')
const optionChecked = ref(false)
let resolveFn: (() => void) | null = null
/**
 * 確認の答え（#342）。**「いいえ」と「答える前に別のダイアログへ置き換わった」を分ける。**
 * `dismiss()` は待っているものを false で解決するので、真偽値 1 つだと呼び出し側が
 * 見分けられず、**見てもいないダイアログを「いいえ」と読んでしまう**（初回だけ聞いて
 * 設定を切り替える `useCopyOnSelect` では、それが「二度と聞かれないまま OFF」になる）。
 *
 * **モジュールの変数 1 つでは分けられない**: `dismiss()` が解決した直後、待ち手の
 * 継続が走るより前に、次のダイアログを開く側が同期でその変数を書き換える。答えと一緒に
 * 運ぶ必要がある。
 */
type ConfirmResult = { ok: boolean; displaced: boolean }
let confirmValue: ((value: ConfirmResult) => void) | null = null
let promptValue: ((value: string | null) => void) | null = null

function dismiss() {
  // **チェックボックスは先に落とす**（#286）。ここは「答えないまま別のダイアログに
  // 置き換わった」経路で、`confirmWithOption` の待ち手は `await` の後に
  // `optionChecked` を読む。残したままだと、チェックを入れて考えているあいだに
  // 別のダイアログが開いただけで「今後は確認しない」を選んだことになる。
  // 文言も落とす: これを消すのが `confirmDialog` だけだと、次に開いた
  // `infoDialog` / `promptDialog` に無関係なチェックボックスが付いて残る。
  optionLabel.value = ''
  optionChecked.value = false
  if (confirmValue) {
    confirmValue({ ok: false, displaced: true })
    confirmValue = null
  }
  if (promptValue) {
    promptValue(null)
    promptValue = null
    forgetSecret()
  }
  if (resolveFn) {
    resolveFn()
    resolveFn = null
  }
}

/**
 * ダイアログが開いているか（#276）。
 *
 * 人に何かを聞いているあいだ、勝手に動く処理（自動保存）を止めるための門番。
 * 「未保存の変更を破棄しますか」は答えを待つあいだ当のコンポーネントが生きているので、
 * これが無いと破棄したはずの内容がその裏で書き込まれる。
 */
export function dialogOpen(): boolean {
  return visible.value
}

/**
 * チェックボックスを 1 つ添えた確認（#286 の「今後は確認しない」）。文言が空なら
 * チェックボックスは出ないので、素の確認もここを通す。
 *
 * **`confirmDialog` の戻り値は真偽値のまま変えない。** 呼び出しが 20 箇所以上あり、そのどれも
 * チェックの状態を必要としていない。真偽値 1 つで済む問いのほうが多いままにしておく。
 */
export async function confirmWithOption(
  msg: string,
  label: string,
): Promise<{ ok: boolean; checked: boolean; displaced: boolean }> {
  dismiss()
  message.value = msg
  mode.value = 'confirm'
  optionLabel.value = label
  visible.value = true
  const { ok, displaced } = await new Promise<ConfirmResult>((resolve) => {
    confirmValue = resolve
  })
  return { ok, checked: optionChecked.value, displaced }
}

/**
 * 「一度だけ聞く」提案（ツールの導入や hook の登録）。`storageKey` の記録に `key` があれば
 * 聞かない。返り値は答え、**`null` は聞けなかった**（記録済み・他のダイアログが開いている・
 * 答える前に置き換えられた）。
 *
 * **段取りをここに 1 つだけ置く**（inotify-tools・hook の登録・ripgrep が使う）。写していた
 * ころは、置き換えられたとき（`displaced`、#342）に記録しない扱いが 1 つにしか無く、残りは
 * 答えを聞いていないのに「断った」として封じ、二度と聞かなくなっていた。
 * - **他のダイアログが開いていたら譲る**（記録もしない）。割り込むと相手の答えを奪う
 * - **記録は答えのあと**。先に書くと、割り込まれたときに見ないまま封じられる
 */
export async function askOnce(storageKey: string, key: string, msg: string): Promise<boolean | null> {
  if (loadAskedKeys(storageKey).includes(key) || dialogOpen()) return null
  const { ok, displaced } = await confirmWithOption(msg, '')
  if (displaced) return null
  rememberAskedKey(storageKey, key)
  return ok
}

export async function confirmDialog(msg: string): Promise<boolean> {
  return (await confirmWithOption(msg, '')).ok
}

export function infoDialog(msg: string): Promise<void> {
  dismiss()
  message.value = msg
  mode.value = 'info'
  visible.value = true
  return new Promise<void>((resolve) => {
    resolveFn = resolve
  })
}

export function promptDialog(msg: string, defaultValue = '', placeholder = ''): Promise<string | null> {
  return ask(msg, defaultValue, placeholder, false)
}

/**
 * 伏せ字で 1 つ聞く（#386 の鍵のパスフレーズ）。
 *
 * **答えを返したら `inputValue` から消す**（`forgetSecret`）。ここに残ると、次に
 * `promptDialog` を開いた人の入力欄へ秘密が既定値として出る。**Pike は秘密を覚えない**と
 * いうのがこの機能の前提なので、器のほうにも残さない。
 */
export function secretDialog(msg: string, placeholder = ''): Promise<string | null> {
  return ask(msg, '', placeholder, true)
}

function ask(msg: string, defaultValue: string, placeholder: string, masked: boolean): Promise<string | null> {
  dismiss()
  message.value = msg
  mode.value = 'prompt'
  inputValue.value = defaultValue
  inputPlaceholder.value = placeholder
  inputMasked.value = masked
  visible.value = true
  return new Promise<string | null>((resolve) => {
    promptValue = resolve
  })
}

/**
 * 伏せ字で聞いた答えを入力欄から消す。**同期で呼ぶこと**（`dismiss` と `respond`）。
 *
 * `await` の後ろ（`finally`）に置くと 1 マイクロタスク遅れるので、**次に開いた
 * ダイアログが同期で書いた既定値を消す**（`promptDialog` に既定値を渡す呼び出しは
 * 5 つある）。答えは解決の引数として既に渡っているので、ここで消して困る人は居ない。
 */
function forgetSecret() {
  if (inputMasked.value) inputValue.value = ''
}

export function useConfirmDialog() {
  function respond(value: boolean) {
    visible.value = false
    if (mode.value === 'prompt') {
      if (promptValue) {
        promptValue(value ? inputValue.value : null)
        promptValue = null
        resolveFn = null
        forgetSecret()
      }
    } else if (confirmValue) {
      confirmValue({ ok: value, displaced: false })
      confirmValue = null
      resolveFn = null
    } else if (resolveFn) {
      resolveFn()
      resolveFn = null
    }
  }

  return {
    visible,
    message,
    mode,
    inputValue,
    inputPlaceholder,
    inputMasked,
    optionLabel,
    optionChecked,
    respond,
  }
}
