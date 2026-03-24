import { ref } from 'vue'

const visible = ref(false)
const message = ref('')
let resolveFn: ((value: boolean) => void) | null = null

export function confirmDialog(msg: string): Promise<boolean> {
  if (resolveFn) {
    resolveFn(false)
    resolveFn = null
  }
  message.value = msg
  visible.value = true
  return new Promise<boolean>((resolve) => {
    resolveFn = resolve
  })
}

export function useConfirmDialog() {
  function respond(value: boolean) {
    visible.value = false
    resolveFn?.(value)
    resolveFn = null
  }

  return { visible, message, respond }
}
