import { Monitor, Moon, Sun } from 'lucide-vue-next'
import type { Component } from 'vue'
import type { ThemeMode } from '../stores/settings'

/**
 * テーマのモードの見せ方（#310 / #407）。**アイコンと文言の出典はここ 1 つ**で、設定画面の
 * セグメントトグルとステータスバーのボタンが読む。散文で「同じ語を使う」と約束して各所に
 * 表を写すと、モードを足したときやアイコンを替えたときに 2 か所で食い違う。
 *
 * 並びは `THEME_MODES` が持つ（ステータスバーのボタンはその順に巡る）ので、ここは対応表だけ。
 */
export const THEME_MODE_VIEW: Record<ThemeMode, { icon: Component; labelKey: string }> = {
  dark: { icon: Moon, labelKey: 'settings.darkMode' },
  light: { icon: Sun, labelKey: 'settings.lightMode' },
  system: { icon: Monitor, labelKey: 'settings.systemMode' },
}
