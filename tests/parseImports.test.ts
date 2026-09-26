// 自動登録コンポーネントの components.d.ts の読み取り（#406）。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { findComponentDeclaration } from '../src/lib/jumpTo/parseImports.ts'

describe('findComponentDeclaration', () => {
  test('unplugin-vue-components の形式', () => {
    const dts = `
declare module 'vue' {
  export interface GlobalComponents {
    HelloWorld: typeof import('./src/components/HelloWorld.vue')['default']
    RouterLink: typeof import('vue-router')['RouterLink']
  }
}`
    assert.equal(findComponentDeclaration(dts, 'HelloWorld'), './src/components/HelloWorld.vue')
    assert.equal(findComponentDeclaration(dts, 'RouterLink'), 'vue-router')
    assert.equal(findComponentDeclaration(dts, 'Missing'), null)
  })

  test('Nuxt 3 の形式（名前がクォートされ、Lazy はジェネリクスに包まれる）', () => {
    const dts = `
interface _GlobalComponents {
  'AppHeader': typeof import("../components/AppHeader.vue")['default']
  'LazyAppHeader': LazyComponent<typeof import("../components/AppHeader.vue")['default']>
}
export const AppHeader: typeof import("../components/AppHeader.vue")['default']`
    assert.equal(findComponentDeclaration(dts, 'AppHeader'), '../components/AppHeader.vue')
    assert.equal(findComponentDeclaration(dts, 'LazyAppHeader'), '../components/AppHeader.vue')
  })

  test('Nuxt 2 の形式（export const）', () => {
    const dts = `export const Logo: typeof import("../components/Logo.vue")['default']`
    assert.equal(findComponentDeclaration(dts, 'Logo'), '../components/Logo.vue')
  })

  test('同じ名前が重なれば最初のものを採る', () => {
    const dts = `A: typeof import('./first.vue')['default']\nA: typeof import('./second.vue')['default']`
    assert.equal(findComponentDeclaration(dts, 'A'), './first.vue')
  })
})
