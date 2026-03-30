import { ref } from 'vue'

const visible = ref(false)
const message = ref('')
const infoOnly = ref(false)
let resolveFn: (() => void) | null = null
let confirmValue: ((value: boolean) => void) | null = null

function dismiss() {
  if (confirmValue) { confirmValue(false); confirmValue = null }
  if (resolveFn) { resolveFn(); resolveFn = null }
}

export function confirmDialog(msg: string): Promise<boolean> {
  dismiss()
  message.value = msg
  infoOnly.value = false
  visible.value = true
  return new Promise<boolean>((resolve) => {
    confirmValue = resolve
    resolveFn = () => resolve(false)
  })
}

export function infoDialog(msg: string): Promise<void> {
  dismiss()
  message.value = msg
  infoOnly.value = true
  visible.value = true
  return new Promise<void>((resolve) => {
    resolveFn = resolve
  })
}

export function useConfirmDialog() {
  function respond(value: boolean) {
    visible.value = false
    if (confirmValue) { confirmValue(value); confirmValue = null; resolveFn = null }
    else if (resolveFn) { resolveFn(); resolveFn = null }
  }

  return { visible, message, infoOnly, respond }
}
