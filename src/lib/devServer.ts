/**
 * Vue SFC のプレビュー（#397）で、プロジェクトの Vite 開発サーバーを探す部分のうち、
 * I/O を持たない純粋なロジック。探して開くのは `components/editor/VuePreview.vue`。
 *
 * **Pike は SFC をコンパイルしない。** 入口の HTML（`previewEntryHtml`）を Vite のルートの
 * `.pike/preview/` に書き、開発サーバーにそれを配らせる。alias・プラグイン・CSS・子
 * コンポーネントの解決は、全部プロジェクトの Vite が持っている。
 *
 * **開発サーバーの URL は決め打ちしない。** 候補を次の順に並べ（`devServerCandidates`）、
 * 呼び出し側が入口を取りに行って（`preview_dev_probe`）最初に応えたものを使う。入口は
 * Pike がそのプロジェクトの下に書いたファイルなので、別のプロジェクトの Vite や Vite 以外の
 * サーバーは取りに行った時点で落ちる。ポートだけを見る形より取り違えが無い。
 *
 * 1. ターミナルに出た `Local:` の URL（Vite が実際に掴んだポート。5173 が埋まっていると
 *    5174 へずれる。`base` も付いて出る）
 * 2. `vite.config.*` の `server.port` / `server.https` / `base` から組み立てた URL（ホスト）
 * 3. 動いている compose のコンテナの `VIRTUAL_HOST`（リバースプロキシの名前）と公開ポート（Docker）
 * 4. 設定の既定の URL
 *
 * 「自分の入口か」は `/@vite/client` と入口に埋めた印（`previewMarker`）の両方で見る。
 */

import type { PublishedPort } from '../types/docker'
import { extractBalanced, splitTopLevel, stripCommentsForScan } from './jsScan'
import { escapeHtml } from './text'

/** Vite 自身が探す順の設定ファイル名。 */
export const VITE_CONFIG_NAMES = [
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'vite.config.cjs',
  'vite.config.mts',
  'vite.config.cts',
] as const

/** Vite の既定のポート。 */
const VITE_DEFAULT_PORT = 5173

/** 設定の既定値。 */
export const DEFAULT_DEV_SERVER_URL = `http://localhost:${VITE_DEFAULT_PORT}/`

/** 入口を書く場所（Vite のルートからの相対パス）。`.pike/` の扱いは `lib/pikeDir.ts`。 */
export const PREVIEW_DIR = '.pike/preview'

/**
 * 入口に埋める印。取りに行った応答にこれが無ければ、自分の入口ではない。
 *
 * **Vite は無い `.html` にも 200 を返す**（`appType: 'spa'` の既定で、`index.html` へ落とす）。
 * `/@vite/client` の有無だけでは、別のプロジェクトの Vite が応えたのと区別できない。SFC の
 * 絶対パスから作るので、同じ相対パスの SFC を 2 つのプロジェクトで開いても食い違う。
 */
export function previewMarker(sfcPath: string): string {
  // FNV-1a（32 bit）。暗号的な強さは要らず、同期で決まればよい。
  let h = 0x811c9dc5
  for (let i = 0; i < sfcPath.length; i++) {
    h ^= sfcPath.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `pike-preview-${h.toString(16).padStart(8, '0')}`
}

/**
 * 開発サーバーの URL を正規化する（http(s) だけ、末尾は `/`）。読めなければ null。
 * **末尾の `/` を必ず付ける**: 入口の相対パスを `new URL` で足すので、無いと `base` の
 * 最後の段が置き換わる。
 */
export function normalizeDevServerUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null
  let url: URL
  try {
    url = new URL(v.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}

/** `vite.config.*` から拾えた値。拾えなかったものは Vite の既定になる。 */
export interface ViteConfigHints {
  port: number | null
  https: boolean
  /** 開発時の `base`（`/` で始まり `/` で終わる）。 */
  base: string
}

export const VITE_CONFIG_DEFAULTS: ViteConfigHints = { port: null, https: false, base: '/' }

/**
 * オブジェクトの中身（`{` と `}` の内側）を、**その階層の**キーと値（生の文字列）に分ける。
 * 入れ子の中は分けないので、`proxy: { '/api': 'https://…' }` の `https` や `hmr: { port: 24678 }`
 * の `port`、`test: { server: … }` の `server` を、目当ての階層のキーと取り違えない。
 * 省略記法（`{ port }`）とスプレッドは拾わない。同じキーは先に書いたほうを採る。
 */
function entries(body: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const seg of splitTopLevel(body, ',')) {
    const m = /^\s*(?:(['"`])([\w$-]+)\1|([\w$]+))\s*:([\s\S]*)$/.exec(seg)
    if (!m) continue
    const key = m[2] ?? m[3]
    if (!out.has(key)) out.set(key, m[4].trim())
  }
  return out
}

/**
 * 設定のオブジェクトの中身。`defineConfig({…})`・`export default {…}`・関数の形
 * （`defineConfig(({ mode }) => ({…}))` と `=> { return {…} }`）を読む。変数に入れてから
 * 渡す形（`defineConfig(config)`）は見つけられず null。
 */
function configBody(src: string): string | null {
  const head = /defineConfig\s*\(/.exec(src) ?? /export\s+default\b/.exec(src)
  if (!head) return null
  let open = src.indexOf('{', head.index + head[0].length)
  // 関数の引数の分割代入（`({ mode }) =>`）と `return` を読み飛ばす。深追いはしない。
  for (let hop = 0; hop < 3 && open >= 0; hop++) {
    const body = extractBalanced(src, open + 1, '{')
    if (body === null) return null
    const close = open + 1 + body.length
    if (/^\s*\)?\s*=>/.test(src.slice(close + 1))) {
      open = src.indexOf('{', close + 1)
      continue
    }
    const ret = /^\s*return\s*\{/.exec(body)
    if (ret) {
      open = open + 1 + ret.index + ret[0].length - 1
      continue
    }
    return body
  }
  return null
}

/** 文字列リテラルの中身（式なら null）。 */
function stringLiteral(raw: string | undefined): string | null {
  const m = raw ? /^(['"`])([^'"`]*)\1$/.exec(raw) : null
  return m ? m[2] : null
}

/**
 * `vite.config.*` の本文から、開発サーバーの URL を組むのに要る値を拾う。
 *
 * **JS として評価しない**（設定ファイルは任意のコードで、Pike は Node を持たない）。拾うのは
 * 設定のオブジェクトの直下の `server`（その直下の `port` / `https`）と `base` を、リテラルで
 * 書いたものだけ。`port: Number(process.env.PORT)` のような式は拾えずに既定へ落ちる。
 * そういう構成でもターミナルの `Local:` か Docker の候補で当たる。
 */
export function readViteConfig(text: string): ViteConfigHints {
  const hints: ViteConfigHints = { ...VITE_CONFIG_DEFAULTS }
  const body = configBody(stripCommentsForScan(text))
  if (body === null) return hints
  const top = entries(body)

  const serverRaw = top.get('server')
  const serverBody = serverRaw?.startsWith('{') ? extractBalanced(serverRaw, 1, '{') : null
  if (serverBody !== null) {
    const server = entries(serverBody)
    const port = Number(server.get('port'))
    if (Number.isInteger(port) && port > 0 && port < 65536) hints.port = port
    // `https: false` と `https: undefined` 以外は https にする（`https: {}` や証明書の指定。
    // `basicSsl()` のプラグインは `server.https` に書かないので拾えない）。
    const https = server.get('https')
    if (https !== undefined && https !== 'false' && https !== 'undefined') hints.https = true
  }

  const base = stringLiteral(top.get('base'))
  if (base !== null) hints.base = devBase(base)
  return hints
}

/**
 * 開発時に効く `base`。`./` や空（相対の base）は開発時には `/` として扱われ、完全な URL は
 * そのパスだけが効く（Vite の `resolveBaseUrl`）。
 */
function devBase(raw: string): string {
  let path = raw
  if (/^https?:\/\//.test(raw)) {
    try {
      path = new URL(raw).pathname
    } catch {
      return '/'
    }
  }
  if (!path.startsWith('/')) return '/'
  return path.endsWith('/') ? path : `${path}/`
}

/** ANSI のエスケープシーケンス（CSI と OSC）。Vite はポート番号だけを太字にする。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC を落とすための正規表現
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/**
 * ターミナルの出力から、開発サーバーの起動表示の `Local:` の URL を拾う。Vite は
 * `➜  Local:   http://localhost:5173/`（ポートだけ太字）を出す。**Vite に限らない**
 * （Next.js や Nuxt も同じ形を出す）が、入口を取りに行った時点で落ちるので構わない。
 */
export function findLocalUrls(output: string): string[] {
  const text = output.replace(ANSI, '')
  const out: string[] = []
  for (const m of text.matchAll(/\bLocal:\s+(https?:\/\/[^\s'"<>]+)/g)) {
    const url = normalizeDevServerUrl(m[1])
    if (url && !out.includes(url)) out.push(url)
  }
  return out
}

type DevServerSource = 'terminal' | 'config' | 'virtualHost' | 'docker' | 'default'

export interface DevServerCandidate {
  /** 開発サーバーのベース URL（`base` 込み、末尾は `/`）。 */
  url: string
  source: DevServerSource
}

/**
 * 試す順に候補を並べる（順の理由はファイル冒頭）。同じ URL は先に出たほうだけを残す。
 *
 * Docker は 2 通りある。
 *
 * - **`VIRTUAL_HOST`**（nginx-proxy や roji のようなリバースプロキシに渡す名前）を先に試す。
 *   compose で動かす構成は、ポートを公開せずプロキシの名前だけで出していることが多い。
 *   プロキシは 443 で受けることが多いので https を先に、http を後に置く（http は https へ
 *   リダイレクトされることがあり、確認はリダイレクトを追わない）。`base` は付ける
 * - **公開ポート**。コンテナ側のポートが Vite のポート（設定に無ければ既定の 5173）と一致する
 *   ものを先に置く。一致しないものも捨てない（`vite --port` をコマンドで渡している構成がある）。
 *   公開ポートは `localhost` で届く（Docker Desktop も WSL の dockerd も転送する）
 */
export function devServerCandidates(opts: {
  terminal: readonly string[]
  config: ViteConfigHints
  virtualHosts: readonly string[]
  docker: readonly PublishedPort[]
  fallback: string
}): DevServerCandidate[] {
  const hints = opts.config
  const scheme = hints.https ? 'https' : 'http'
  const vitePort = hints.port ?? VITE_DEFAULT_PORT
  const at = (port: number) => `${scheme}://localhost:${port}${hints.base}`

  const list: DevServerCandidate[] = []
  const push = (url: string | null, source: DevServerSource) => {
    if (url && !list.some((c) => c.url === url)) list.push({ url, source })
  }
  for (const url of opts.terminal) push(normalizeDevServerUrl(url), 'terminal')
  push(at(vitePort), 'config')
  for (const host of opts.virtualHosts) {
    for (const s of ['https', 'http']) push(normalizeDevServerUrl(`${s}://${host}${hints.base}`), 'virtualHost')
  }
  const docker = [...opts.docker].sort(
    (a, b) => Number(b.privatePort === vitePort) - Number(a.privatePort === vitePort),
  )
  for (const p of docker) push(at(p.publicPort), 'docker')
  push(normalizeDevServerUrl(opts.fallback), 'default')
  return list
}

/**
 * 入口のファイル名の幹（`.html` と `.js` を付けて 2 つ書く）。SFC ごとに決まった名前にする
 * （開き直しても増えない）。Vite のルートからの相対パスの区切りを `__` に置き換えるだけで、
 * 人が見て何の入口か分かる。
 */
export function previewEntryStem(relFromViteRoot: string): string {
  return relFromViteRoot.replace(/[\\/]+/g, '__')
}

/**
 * 入口の HTML。印と、mount する script（`previewEntryScript`）を読む 1 行だけを持つ。
 *
 * **script は inline にせず、`/@id/` 経由で読む。** inline の module script は、Vite が
 * `X.html?html-proxy&index=0.js` という別の要求にして配るが、`/.pike/…` への `text/html` 以外の
 * 要求は、アプリの `proxy` 設定（`/` を丸ごと API サーバーへ回し、`/src/` などだけを
 * 素通しする構成）に取られて 404 になる。`/@id/` は Vite が自分の内部のモジュールに使う
 * 接頭辞で、そういう設定でも素通しされる（されないと Vite 自身が動かない）。Vite は
 * `/@id/` の後ろを Vite のルートからの id として解決する。
 *
 * パスは入口からの相対にする（`base` が付いても `<base>/@id/…` になる）。
 */
export function previewEntryHtml(opts: {
  title: string
  /** 入口のファイル名の幹（`previewEntryStem`）。 */
  stem: string
  /** `previewMarker` の値。 */
  marker: string
}): string {
  const title = escapeHtml(opts.title)
  const script = escapeHtml(`../../@id/${PREVIEW_DIR}/${encodeURIComponent(opts.stem)}.js`)
  return [
    '<!doctype html>',
    '<!-- Pike が Vue SFC のプレビューのために書いたファイル（消してよい） -->',
    '<html>',
    '<head>',
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `<meta name="pike-preview" content="${opts.marker}" />`,
    `<title>${title}</title>`,
    '</head>',
    '<body>',
    '<div id="app"></div>',
    `<script type="module" src="${script}"></script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/**
 * 入口の script。SFC を import して mount するだけ。
 *
 * - **import は script からの相対パス**にする（Vite が `/src/…` などに書き換える）
 * - `pinia` を依存に持つプロジェクトでは `createPinia()` を入れる（ストアを使う SFC が
 *   「active Pinia が無い」で落ちるのを防ぐ）。依存に無いものを import すると Vite が
 *   入口ごと 500 を返すので、有無は呼び出し側が `package.json` で確かめる
 * - props は与えない（Storybook の story に当たる仕組みは持たない）
 */
export function previewEntryScript(opts: { sfcImport: string; pinia: boolean }): string {
  return [
    '// Pike が Vue SFC のプレビューのために書いたファイル（消してよい）',
    "import { createApp } from 'vue'",
    ...(opts.pinia ? ["import { createPinia } from 'pinia'"] : []),
    `import Component from ${JSON.stringify(opts.sfcImport)}`,
    'const app = createApp(Component)',
    ...(opts.pinia ? ['app.use(createPinia())'] : []),
    "app.mount('#app')",
    '',
  ].join('\n')
}

/** `package.json` の依存に `name` があるか（読めなければ false）。 */
export function hasDependency(packageJson: string, name: string): boolean {
  try {
    const pkg = JSON.parse(packageJson) as Record<string, unknown>
    return ['dependencies', 'devDependencies', 'peerDependencies'].some((k) => {
      const deps = pkg[k]
      return typeof deps === 'object' && deps !== null && name in deps
    })
  } catch {
    return false
  }
}
