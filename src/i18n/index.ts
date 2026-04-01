import { ref, computed } from 'vue'
import en from './en'
import ja from './ja'

type Messages = Record<string, string>

const locales: Record<string, Messages> = { en, ja }
export const locale = ref<string>('en')

// Reactive messages: switches when locale changes
const messages = computed<Messages>(() => locales[locale.value] ?? locales.en)

function translate(key: string, params?: Record<string, string | number>): string {
  let msg = messages.value[key] ?? locales.en[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replaceAll(`{${k}}`, String(v))
    }
  }
  return msg
}

// Standalone t for use outside components (e.g. stores)
export { translate as t }

export function useI18n() {
  // Return a wrapper that accesses the computed messages during render,
  // ensuring Vue tracks locale as a dependency of the component's render effect.
  return {
    t: translate,
    locale,
    // Expose messages so templates can depend on it directly if needed
    messages,
  }
}
