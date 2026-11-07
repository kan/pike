#!/usr/bin/env node
// リリースのアセットの表（#585）。**アセットの名前と性質はここにだけ書く。** Release ワークフローの
// bundle（最終の名前にそろえる）・attest（証明する対象）・upload（そろっているかの検査）と、
// `updater-json.mjs`（latest.json に載せるもの）がこの表を引く。
//
//   node scripts/release-assets.mjs collect <Windows|macOS> <出力先>   バンドラの出力を最終の名前で写す
//   node scripts/release-assets.mjs check <ディレクトリ>               表のアセットがちょうどそろっているか
//   node scripts/release-assets.mjs attest <ディレクトリ>              証明する対象のパスを 1 行ずつ出す
//   node scripts/release-assets.mjs handoff <Windows|macOS> <triple>  build から bundle へ渡すファイルを 1 行ずつ出す
//
// **bundle は handoff の一覧にあるファイルしか受け取らない。** build のジョブは依存のコードを動かすので、
// その出力（artifact）の中身は信用しない。一覧は checkout したリポジトリ（`src/bin/`）と triple から
// 作るので、artifact の中身には左右されない（`tauri.conf.json` などを紛れ込ませて上書きできない）。
//
// 名前は `updater-json.mjs` が読むものと、これまでのリリースのアセットの名前に合わせてある。
// **変えないこと。** バンドラが付ける名前のままでよいものは写すだけで、`Pike.app.tar.gz`（と `.sig`）
// だけを `Pike_X.Y.Z_aarch64.app.tar.gz` にする（以前は tauri-action が付け替えていた）。
// 版は `tauri.conf.json` から取る（タグとの一致は Release の draft ジョブが確かめる）。

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const BUNDLE = 'src-tauri/target/release/bundle'

/**
 * アセットの一覧。`from` はバンドラ（とポータブル版のスクリプト）の出力、`name` はリリースでの名前。
 * `attest` は利用者が手で落とすもの（`.sig` には付けない）、`updater` は latest.json の platforms の
 * キー（並びは tauri-action と同じ。Windows は NSIS を主にする）。
 */
export function releaseAssets(version) {
  const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  const p = conf.productName
  const v = version ?? conf.version
  const win = `${p}_${v}_x64`
  const mac = `${p}_${v}_aarch64`
  return [
    {
      os: 'Windows',
      from: `${BUNDLE}/nsis/${win}-setup.exe`,
      name: `${win}-setup.exe`,
      attest: true,
      updater: ['windows-x86_64', 'windows-x86_64-nsis'],
    },
    { os: 'Windows', from: `${BUNDLE}/nsis/${win}-setup.exe.sig`, name: `${win}-setup.exe.sig` },
    {
      os: 'Windows',
      from: `${BUNDLE}/msi/${win}_en-US.msi`,
      name: `${win}_en-US.msi`,
      attest: true,
      updater: ['windows-x86_64-msi'],
    },
    { os: 'Windows', from: `${BUNDLE}/msi/${win}_en-US.msi.sig`, name: `${win}_en-US.msi.sig` },
    // ポータブル版（#451）。latest.json には載せない。build が作り、handoff で bundle へ渡す（`portable`）
    {
      os: 'Windows',
      from: `artifacts/portable/${win}-portable.zip`,
      name: `${win}-portable.zip`,
      attest: true,
      portable: true,
    },
    // staple したあとの `.dmg`（Release の bundle ジョブが公証して staple する）
    { os: 'macOS', from: `${BUNDLE}/dmg/${mac}.dmg`, name: `${mac}.dmg`, attest: true },
    {
      os: 'macOS',
      from: `${BUNDLE}/macos/${p}.app.tar.gz`,
      name: `${mac}.app.tar.gz`,
      attest: true,
      updater: ['darwin-aarch64', 'darwin-aarch64-app'],
    },
    { os: 'macOS', from: `${BUNDLE}/macos/${p}.app.tar.gz.sig`, name: `${mac}.app.tar.gz.sig` },
  ]
}

/**
 * build から bundle へ渡すファイル（リポジトリのルートからの相対パス）。バンドラは crate の bin を
 * すべて同梱する（`src/bin/` の検証バイナリも）ので全部を渡す。bin は cargo の自動検出と同じく
 * `src/bin/<名前>.rs` と `src/bin/<名前>/main.rs` の両方を拾う。sidecar の rg はバンドラが
 * `binaries/rg-<triple>` から取る。Windows では build が作ったポータブル版の zip も渡す。
 */
export function handoffFiles(os, triple) {
  const ext = os === 'Windows' ? '.exe' : ''
  const binDir = join(root, 'src-tauri/src/bin')
  const bins = readdirSync(binDir, { withFileTypes: true }).flatMap((e) => {
    if (e.isFile() && e.name.endsWith('.rs')) return [e.name.slice(0, -3)]
    if (e.isDirectory() && existsSync(join(binDir, e.name, 'main.rs'))) return [e.name]
    return []
  })
  const files = ['pike', ...bins].map((b) => `src-tauri/target/release/${b}${ext}`)
  files.push(`src-tauri/binaries/rg-${triple}${ext}`)
  files.push(...releaseAssets().filter((a) => a.os === os && a.portable).map((a) => a.from))
  return files
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function main([command, ...args]) {
  const assets = releaseAssets()
  if (command === 'collect') {
    const [os, out] = args
    const mine = assets.filter((a) => a.os === os)
    if (!out || mine.length === 0) fail(`usage: collect <Windows|macOS> <出力先>（受け取った OS: ${os}）`)
    mkdirSync(out, { recursive: true })
    for (const { from, name } of mine) {
      if (!existsSync(join(root, from))) fail(`${from} がありません（バンドラの出力の名前が変わった？）`)
      copyFileSync(join(root, from), join(out, name))
      console.log(`${from} -> ${name}`)
    }
  } else if (command === 'check') {
    const [dir] = args
    if (!dir) fail('usage: check <ディレクトリ>')
    if (!existsSync(dir)) fail(`${dir} がありません（artifact を落とせていない？）`)
    const have = readdirSync(dir).sort()
    const want = assets.map((a) => a.name).sort()
    if (have.join('\n') !== want.join('\n')) {
      fail(`アセットが表と合いません\n  ある: ${have.join(', ')}\n  表:   ${want.join(', ')}`)
    }
    console.log(`ok: ${have.length} 件`)
  } else if (command === 'attest') {
    const [dir] = args
    if (!dir) fail('usage: attest <ディレクトリ>')
    if (!existsSync(dir)) fail(`${dir} がありません（artifact を落とせていない？）`)
    // actions/attest の subject-path に渡すので、OS に依らず `/` でつなぐ
    for (const { name } of assets.filter((a) => a.attest)) console.log(`${dir}/${name}`)
  } else if (command === 'handoff') {
    const [os, triple] = args
    if (!['Windows', 'macOS'].includes(os) || !/^[a-z0-9_]+(-[a-z0-9_]+)+$/.test(triple ?? '')) {
      fail(`usage: handoff <Windows|macOS> <triple>（受け取った値: ${os} ${triple}）`)
    }
    for (const file of handoffFiles(os, triple)) console.log(file)
  } else {
    fail('usage: node scripts/release-assets.mjs <collect|check|attest|handoff> ...')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
}
