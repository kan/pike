// Vue SFC のプレビューの開発サーバー探し（#397）。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  devServerCandidates,
  findLocalUrls,
  hasDependency,
  normalizeDevServerUrl,
  previewEntryHtml,
  previewEntryScript,
  previewEntryStem,
  previewMarker,
  readViteConfig,
  VITE_CONFIG_DEFAULTS,
} from '../src/lib/devServer.ts'

describe('normalizeDevServerUrl', () => {
  test('末尾に / を付け、クエリとハッシュを落とす', () => {
    assert.equal(normalizeDevServerUrl('http://localhost:5173'), 'http://localhost:5173/')
    assert.equal(normalizeDevServerUrl(' http://localhost:5173/app?x=1#y '), 'http://localhost:5173/app/')
  })

  test('http(s) 以外と読めないものは null', () => {
    assert.equal(normalizeDevServerUrl('file:///c:/x'), null)
    assert.equal(normalizeDevServerUrl('localhost:5173'), null)
    assert.equal(normalizeDevServerUrl(5173), null)
  })
})

describe('readViteConfig', () => {
  test('server の port と https、外の base を拾う', () => {
    const src = `
      import { defineConfig } from 'vite'
      export default defineConfig({
        base: '/app',
        plugins: [vue()],
        // port: 9999 はコメント
        server: { port: 3000, https: {}, proxy: { '/api': 'http://localhost:8080' } },
        preview: { port: 4000 },
      })`
    assert.deepEqual(readViteConfig(src), { port: 3000, https: true, base: '/app/' })
  })

  test('式は拾わずに既定へ落ちる', () => {
    const src = `export default { base: mode === 'x' ? '/a/' : '/', server: { port: Number(env.PORT), https: false } }`
    assert.deepEqual(readViteConfig(src), VITE_CONFIG_DEFAULTS)
  })

  test('相対の base は開発時には /', () => {
    assert.equal(readViteConfig(`export default { base: './' }`).base, '/')
  })

  test('server の中の入れ子（proxy の URL・hmr の port）を server 直下と取り違えない', () => {
    const src = `export default { server: { hmr: { port: 24678 }, proxy: { '/api': 'https://api.example.com' }, port: 5173 } }`
    assert.deepEqual(readViteConfig(src), { port: 5173, https: false, base: '/' })
  })

  test('設定の直下の server と base だけを見る（test.server やプラグインの base を拾わない）', () => {
    const src = `export default defineConfig({
      plugins: [pages({ base: '/x/' })],
      test: { server: { deps: { inline: ['a'] } } },
      server: { port: 3000 },
      base: '/app/',
    })`
    assert.deepEqual(readViteConfig(src), { port: 3000, https: false, base: '/app/' })
  })

  test('関数の形の設定も読む', () => {
    assert.equal(readViteConfig(`export default defineConfig(({ mode }) => ({ server: { port: 4100 } }))`).port, 4100)
    assert.equal(
      readViteConfig(`export default defineConfig((env) => { return { server: { port: 4200 } } })`).port,
      4200,
    )
  })

  test('preview の port を server のものと取り違えない', () => {
    assert.equal(readViteConfig(`export default { preview: { port: 4000 } }`).port, null)
  })
})

describe('findLocalUrls', () => {
  test('Vite の起動表示（ポートだけ太字）から拾う', () => {
    const out =
      '\r\n  \x1b[32m\x1b[1mVITE\x1b[22m v5.4.0\x1b[39m\r\n\r\n  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5174\x1b[22m/app/\x1b[39m\r\n'
    assert.deepEqual(findLocalUrls(out), ['http://localhost:5174/app/'])
  })

  test('Network の行は拾わない', () => {
    assert.deepEqual(findLocalUrls('  ➜  Network: http://192.168.0.2:5173/\n'), [])
  })
})

describe('devServerCandidates', () => {
  test('ターミナル → 設定ファイル → VIRTUAL_HOST → 公開ポート → 既定の順で、重複を落とす', () => {
    const list = devServerCandidates({
      terminal: ['http://localhost:5174/'],
      config: { port: 5174, https: false, base: '/' },
      virtualHosts: ['sitter.kan.localhost'],
      docker: [
        { privatePort: 5432, publicPort: 5432 },
        { privatePort: 5174, publicPort: 15174 },
      ],
      fallback: 'http://localhost:5173',
    })
    assert.deepEqual(list, [
      { url: 'http://localhost:5174/', source: 'terminal' },
      { url: 'https://sitter.kan.localhost/', source: 'virtualHost' },
      { url: 'http://sitter.kan.localhost/', source: 'virtualHost' },
      { url: 'http://localhost:15174/', source: 'docker' },
      { url: 'http://localhost:5432/', source: 'docker' },
      { url: 'http://localhost:5173/', source: 'default' },
    ])
  })

  test('設定ファイルの scheme と base は Docker の候補にも効く', () => {
    const list = devServerCandidates({
      terminal: [],
      config: { port: null, https: true, base: '/app/' },
      virtualHosts: [],
      docker: [{ privatePort: 5173, publicPort: 8080 }],
      fallback: 'http://localhost:5173/',
    })
    assert.deepEqual(
      list.map((c) => c.url),
      ['https://localhost:5173/app/', 'https://localhost:8080/app/', 'http://localhost:5173/'],
    )
  })
})

describe('入口', () => {
  test('ファイル名は Vite のルートからの相対パスで決まる', () => {
    assert.equal(previewEntryStem('src/components/Foo.vue'), 'src__components__Foo.vue')
    assert.equal(previewEntryStem('src\\App.vue'), 'src__App.vue')
  })

  test('HTML は印を持ち、script を /@id/ 経由で入口からの相対で読む', () => {
    const marker = previewMarker('/p/src/A.vue')
    const html = previewEntryHtml({ title: '<A>.vue', stem: 'src__A.vue', marker })
    assert.ok(html.includes(marker))
    assert.ok(html.includes('src="../../@id/.pike/preview/src__A.vue.js"'))
    assert.doesNotMatch(html, /<title><A>/)
  })

  test('pinia は依存にあるときだけ入れる', () => {
    const withPinia = previewEntryScript({ sfcImport: '../../src/A.vue', pinia: true })
    assert.match(withPinia, /app\.use\(createPinia\(\)\)/)
    assert.match(withPinia, /import Component from "\.\.\/\.\.\/src\/A\.vue"/)
    assert.doesNotMatch(previewEntryScript({ sfcImport: '../../src/A.vue', pinia: false }), /createPinia/)
  })

  test('印は SFC の絶対パスごとに違う', () => {
    assert.match(previewMarker('/a/src/App.vue'), /^pike-preview-[0-9a-f]{8}$/)
    assert.equal(previewMarker('/a/src/App.vue'), previewMarker('/a/src/App.vue'))
    assert.notEqual(previewMarker('/a/src/App.vue'), previewMarker('/b/src/App.vue'))
  })

  test('hasDependency', () => {
    assert.equal(hasDependency('{"dependencies":{"pinia":"^2"}}', 'pinia'), true)
    assert.equal(hasDependency('{"devDependencies":{"vue":"^3"}}', 'pinia'), false)
    assert.equal(hasDependency('not json', 'pinia'), false)
  })
})
