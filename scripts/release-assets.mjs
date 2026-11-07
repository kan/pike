#!/usr/bin/env node
// リリースのアセットの表（#585）。**アセットの名前と性質はここにだけ書く。** Release ワークフローの
// bundle（最終の名前にそろえる）・attest（証明する対象）・upload（そろっているかの検査）と、
// `updater-json.mjs`（latest.json に載せるもの）がこの表を引く。
//
//   node scripts/release-assets.mjs collect <Windows|macOS> <出力先>   バンドラの出力を最終の名前で写す
//   node scripts/release-assets.mjs check <ディレクトリ>               表のアセットがちょうどそろっているか
//   node scripts/release-assets.mjs attest <ディレクトリ>              証明する対象のパスを 1 行ずつ出す
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
    // ポータブル版（#451）。latest.json には載せない
    { os: 'Windows', from: `artifacts/portable/${win}-portable.zip`, name: `${win}-portable.zip`, attest: true },
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
    const have = readdirSync(dir).sort()
    const want = assets.map((a) => a.name).sort()
    if (have.join('\n') !== want.join('\n')) {
      fail(`アセットが表と合いません\n  ある: ${have.join(', ')}\n  表:   ${want.join(', ')}`)
    }
    console.log(`ok: ${have.length} 件`)
  } else if (command === 'attest') {
    const [dir] = args
    if (!dir) fail('usage: attest <ディレクトリ>')
    // actions/attest の subject-path に渡すので、OS に依らず `/` でつなぐ
    for (const { name } of assets.filter((a) => a.attest)) console.log(`${dir}/${name}`)
  } else {
    fail('usage: node scripts/release-assets.mjs <collect|check|attest> ...')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
}
