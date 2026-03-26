import { ref } from 'vue'

const visible = ref(false)

export function useShortcutsModal() {
  function toggle() {
    visible.value = !visible.value
  }
  return { visible, toggle }
}
