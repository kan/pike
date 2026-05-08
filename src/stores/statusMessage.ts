/**
 * Transient status messages displayed in the StatusBar.
 *
 * Used by features like "go to definition" to surface progress / outcome
 * without disrupting the editor flow. Messages auto-dismiss after a
 * configurable duration; "loading" messages stay until replaced or hidden.
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'

export type StatusMessageVariant = 'info' | 'success' | 'warn' | 'error' | 'loading'

export const useStatusMessageStore = defineStore('statusMessage', () => {
  // `text` and `visible` are kept separate so <Transition> can fade out
  // without flashing empty content during the leave animation.
  const text = ref('')
  const variant = ref<StatusMessageVariant>('info')
  const visible = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null

  function clearTimer() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function show(opts: { text: string; variant?: StatusMessageVariant; durationMs?: number }) {
    clearTimer()
    text.value = opts.text
    variant.value = opts.variant ?? 'info'
    visible.value = true
    // Loading messages persist until explicitly replaced or hidden.
    const duration = opts.durationMs ?? 2500
    if (opts.variant !== 'loading' && duration > 0) {
      timer = setTimeout(() => {
        visible.value = false
      }, duration)
    }
  }

  function hide() {
    clearTimer()
    visible.value = false
  }

  return { text, variant, visible, show, hide }
})
