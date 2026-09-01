import { ref } from 'vue'

type Mode = 'confirm' | 'info' | 'prompt'

const visible = ref(false)
const message = ref('')
const mode = ref<Mode>('confirm')
const inputValue = ref('')
const inputPlaceholder = ref('')
/** 添えるチェックボックスの文言。空なら出さない。 */
const optionLabel = ref('')
const optionChecked = ref(false)
let resolveFn: (() => void) | null = null
let confirmValue: ((value: boolean) => void) | null = null
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
    confirmValue(false)
    confirmValue = null
  }
  if (promptValue) {
    promptValue(null)
    promptValue = null
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
export async function confirmWithOption(msg: string, label: string): Promise<{ ok: boolean; checked: boolean }> {
  dismiss()
  message.value = msg
  mode.value = 'confirm'
  optionLabel.value = label
  visible.value = true
  const ok = await new Promise<boolean>((resolve) => {
    confirmValue = resolve
  })
  return { ok, checked: optionChecked.value }
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
  dismiss()
  message.value = msg
  mode.value = 'prompt'
  inputValue.value = defaultValue
  inputPlaceholder.value = placeholder
  visible.value = true
  return new Promise<string | null>((resolve) => {
    promptValue = resolve
  })
}

export function useConfirmDialog() {
  function respond(value: boolean) {
    visible.value = false
    if (mode.value === 'prompt') {
      if (promptValue) {
        promptValue(value ? inputValue.value : null)
        promptValue = null
        resolveFn = null
      }
    } else if (confirmValue) {
      confirmValue(value)
      confirmValue = null
      resolveFn = null
    } else if (resolveFn) {
      resolveFn()
      resolveFn = null
    }
  }

  return { visible, message, mode, inputValue, inputPlaceholder, optionLabel, optionChecked, respond }
}
