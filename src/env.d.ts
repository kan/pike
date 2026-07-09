/// <reference types="vite/client" />

// E2E 撮影ビルド (issue #142) でのみ true になる vite define 定数。
declare const __PIKE_E2E__: boolean

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<object, object, unknown>
  export default component
}
