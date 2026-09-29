#!/usr/bin/env node
// 配布物に入る依存のライセンス一覧（クレジット）を作る（#420）。About の画面が読む。
//
//   node scripts/gen-credits.mjs          # src/assets/credits.json を作り直す
//   node scripts/gen-credits.mjs --check  # 一覧が lockfile と合っているかだけ見る（just check）
//
// **生成物は commit する**（gocredits と同じ考え方）。ビルドのたびに作ると、ビルドが
// cargo のレジストリと node_modules の中身に依存する。依存を変えたら作り直して一緒に
// commit する。忘れると `--check` が落ちる。
//
// 集める範囲:
// - Rust: リリースするターゲット（`release.yml` の Windows と macOS arm64）の、Pike から
//   通常の依存でたどれるクレート。build-dependencies と dev-dependencies は配布物に
//   入らないので含めない
// - npm: package-lock.json で `dev` でないもの（Vite がバンドルする側）
// - サイドカー: ripgrep（`scripts/download-rg.sh` が取るバイナリ）
//
// ライセンスの本文は各パッケージの LICENSE / COPYING / NOTICE などのファイルから読み、
// 同じ本文は 1 つにまとめる（MIT と Apache-2.0 の同文が大半を占める）。**本文を同梱して
// いないパッケージ**（objc2 系や webview2-com など）は、ライセンス名から SPDX の標準文を
// 引いて補い、著作者名を添える（`standard`）。cargo-about と同じ扱い。
// `--check` は本文を読まない。名前と版の集合だけを比べるので、ネットワークは要らない。

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = 'src/assets/credits.json'
const RUST_TARGETS = ['x86_64-pc-windows-msvc', 'aarch64-apple-darwin']
/** 標準文の取得元。版を固定して、作り直しても本文が揺れないようにする。 */
const SPDX_TEXT = 'https://raw.githubusercontent.com/spdx/license-list-data/v3.29.0/text'
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense|copyright)([-._].*)?$/i
/** ライセンス欄が空のパッケージに載せる名前（本文のほうで確かめてもらう）。 */
const UNKNOWN_LICENSE = 'see license text'

const check = process.argv.includes('--check')

// --- Rust ---------------------------------------------------------------------

/** ターゲットごとに `cargo metadata` を引く。並列に走らせる（`just check` のたびに走るので）。 */
async function rustPackages() {
  const metas = await Promise.all(
    RUST_TARGETS.map((target) =>
      promisify(execFile)('cargo', ['metadata', '--format-version', '1', '--locked', '--filter-platform', target], {
        cwd: join(root, 'src-tauri'),
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      }),
    ),
  )
  const found = new Map()
  for (const { stdout } of metas) {
    const meta = JSON.parse(stdout)
    const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]))
    const packages = new Map(meta.packages.map((p) => [p.id, p]))
    const seen = new Set()
    const stack = [meta.resolve.root]
    while (stack.length) {
      const id = stack.pop()
      if (seen.has(id)) continue
      seen.add(id)
      for (const dep of nodes.get(id).deps) {
        // `kind` が null なのが通常の依存（"build" / "dev" は配布物に入らない）。
        if (dep.dep_kinds.some((k) => k.kind === null)) stack.push(dep.pkg)
      }
    }
    for (const id of seen) {
      const p = packages.get(id)
      // `source` が無いのはワークスペースの中（Pike 自身）。
      if (!p.source) continue
      found.set(`${p.name}@${p.version}`, {
        name: p.name,
        version: p.version,
        license: p.license ?? UNKNOWN_LICENSE,
        source: 'rust',
        url: p.repository ?? `https://crates.io/crates/${p.name}`,
        dir: dirname(p.manifest_path),
        licenseFile: p.license_file,
        authors: p.authors.join(', '),
      })
    }
  }
  return [...found.values()]
}

// --- npm ----------------------------------------------------------------------

function npmPackages() {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  const found = new Map()
  for (const [path, entry] of Object.entries(lock.packages)) {
    // 空のキーはルート（Pike 自身）。
    if (!path || entry.dev || entry.devOptional || entry.link) continue
    const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
    const dir = join(root, path)
    // `--check` は名前と版しか見ない（どちらも lockfile にある）ので、中身を読まない。
    const manifest = join(dir, 'package.json')
    const pkg = !check && existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : {}
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
    found.set(`${name}@${entry.version}`, {
      name,
      version: entry.version,
      license: licenseName(entry.license ?? pkg.license),
      source: 'npm',
      url: normalizeRepoUrl(repo) ?? `https://www.npmjs.com/package/${name}`,
      dir,
      authors: typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? ''),
    })
  }
  return [...found.values()]
}

function licenseName(license) {
  return typeof license === 'string' ? license : (license?.type ?? UNKNOWN_LICENSE)
}

/**
 * `git+https://…/x.git`・`git@github.com:o/r.git`・`github:o/r`（npm の短縮形）を、ブラウザで
 * 開ける形にする。直せないものはそのまま返し、About の側がリンクにしない。
 */
function normalizeRepoUrl(url) {
  if (!url) return null
  if (/^github:/.test(url)) return `https://github.com/${url.slice('github:'.length)}`
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url}`
  return url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/i, '')
}

// --- サイドカー -----------------------------------------------------------------

function ripgrep() {
  const script = readFileSync(join(root, 'scripts/download-rg.sh'), 'utf8')
  const version = script.match(/^VERSION="([^"]+)"/m)?.[1]
  if (!version) throw new Error('scripts/download-rg.sh から ripgrep の版を読めない')
  return {
    name: 'ripgrep',
    version,
    license: 'Unlicense OR MIT',
    source: 'binary',
    url: 'https://github.com/BurntSushi/ripgrep',
    remote: ['LICENSE-MIT', 'UNLICENSE'].map(
      (f) => `https://raw.githubusercontent.com/BurntSushi/ripgrep/${version}/${f}`,
    ),
  }
}

// --- 本文 ---------------------------------------------------------------------

function normalizeText(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()
}

function localTexts(pkg) {
  const files = new Set()
  if (pkg.licenseFile) files.add(join(pkg.dir, pkg.licenseFile))
  if (existsSync(pkg.dir)) {
    for (const f of readdirSync(pkg.dir).sort()) {
      const path = join(pkg.dir, f)
      if (LICENSE_FILE.test(f) && statSync(path).isFile()) files.add(path)
    }
  }
  return [...files].filter(existsSync).map((f) => normalizeText(readFileSync(f, 'utf8')))
}

const fetched = new Map()

/**
 * `optional` なら 404 を「無い」として飛ばす。SPDX の標準文を引くときに使う: ライセンス欄は
 * SPDX の ID とは限らない（`SEE LICENSE IN …` など）ので、無いものは `missing` に回して報告する。
 */
async function remoteTexts(urls, { optional = false } = {}) {
  const texts = []
  for (const url of urls) {
    if (!fetched.has(url)) {
      const res = await fetch(url)
      if (!res.ok && !(optional && res.status === 404)) throw new Error(`${url}: ${res.status}`)
      fetched.set(url, res.ok ? normalizeText(await res.text()) : null)
    }
    const text = fetched.get(url)
    if (text) texts.push(text)
  }
  return texts
}

/** `MIT OR Apache-2.0` / `MIT/Apache-2.0`（古い書き方）から SPDX の識別子を取り出す。 */
function spdxIds(expr) {
  return [
    ...new Set(
      expr
        .split(/\s+(?:OR|AND)\s+|\/|[()]/)
        .map((s) => s.replace(/\s+WITH\s+.*$/, '').trim())
        .filter(Boolean),
    ),
  ]
}

// --- 実行 ---------------------------------------------------------------------

const key = (p) => `${p.source}:${p.name}@${p.version}`
const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.source.localeCompare(b.source)
const all = [...(await rustPackages()), ...npmPackages(), ripgrep()].sort(byName)

if (check) {
  const current = existsSync(join(root, OUT)) ? JSON.parse(readFileSync(join(root, OUT), 'utf8')) : { packages: [] }
  const want = new Set(all.map(key))
  const have = new Set(current.packages.map(key))
  const added = [...want].filter((k) => !have.has(k))
  const removed = [...have].filter((k) => !want.has(k))
  if (added.length || removed.length) {
    for (const k of added) console.error(`  + ${k}`)
    for (const k of removed) console.error(`  - ${k}`)
    console.error(`クレジット: ${OUT} が依存と合っていない。\`just credits\` で作り直して commit する`)
    process.exit(1)
  }
  console.log('クレジット: 問題なし')
} else {
  // 本文 → 添字。挿入順がそのまま `texts` の並びになる。
  const index = new Map()
  const intern = (text) => {
    if (!index.has(text)) index.set(text, index.size)
    return index.get(text)
  }
  const packages = []
  const missing = []
  for (const p of all) {
    let found = p.remote ? await remoteTexts(p.remote) : localTexts(p)
    const standard = found.length === 0
    if (standard) {
      const ids = spdxIds(p.license)
      found = await remoteTexts(
        ids.map((id) => `${SPDX_TEXT}/${encodeURIComponent(id)}.txt`),
        { optional: true },
      )
      if (found.length === 0) missing.push(key(p))
    }
    packages.push({
      name: p.name,
      version: p.version,
      license: p.license,
      source: p.source,
      url: p.url,
      texts: found.map(intern),
      // 標準文は著作権者の行を持たないので、パッケージの著作者を添える。
      ...(standard && { standard: true, authors: p.authors || undefined }),
    })
  }
  writeFileSync(join(root, OUT), `${JSON.stringify({ packages, texts: [...index.keys()] })}\n`)
  console.log(`クレジット: ${packages.length} 件（本文 ${index.size} 種）を ${OUT} に書いた`)
  if (missing.length) {
    console.log(`本文を用意できず、ライセンス名だけを載せたもの（${missing.length} 件）:`)
    for (const k of missing) console.log(`  ${k}`)
  }
}
