import { ref } from 'vue'

type Mode = 'confirm' | 'info' | 'prompt'

const visible = ref(false)
const message = ref('')
const mode = ref<Mode>('confirm')
const inputValue = ref('')
const inputPlaceholder = ref('')
let resolveFn: (() => void) | null = null
let confirmValue: ((value: boolean) => void) | null = null
let promptValue: ((value: string | null) => void) | null = null

function dismiss() {
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

export function confirmDialog(msg: string): Promise<boolean> {
  dismiss()
  message.value = msg
  mode.value = 'confirm'
  visible.value = true
  return new Promise<boolean>((resolve) => {
    confirmValue = resolve
  })
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

  return { visible, message, mode, inputValue, inputPlaceholder, respond }
}
