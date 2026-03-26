import { ref } from 'vue'
import en from './en'
import ja from './ja'

type Messages = Record<string, string>

const locales: Record<string, Messages> = { en, ja }
export const locale = ref<string>('en')

export function t(key: string, params?: Record<string, string | number>): string {
  let msg = locales[locale.value]?.[key] ?? locales.en[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replaceAll(`{${k}}`, String(v))
    }
  }
  return msg
}

export function useI18n() {
  return { t, locale }
}
