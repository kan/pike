import { ref } from 'vue'

/** About（#420）の開閉。ショートカット一覧（`useShortcutsModal`）と同じくモジュール単位で 1 つ。 */
const visible = ref(false)

export function useAboutModal() {
  return {
    visible,
    open: () => {
      visible.value = true
    },
  }
}
