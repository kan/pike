#!/usr/bin/env node
// リリースのドラフトから updater の latest.json を組み立てる（Release ワークフローの合流ジョブ、#505）。
//
//   node scripts/updater-json.mjs <release-id> <出力先>
//
// 両 OS の成果物がそろったドラフトから 1 回で組み立て、書き出す前に各 URL の実ファイルの署名を
// tauri.conf.json の公開鍵で検証する。中身の形は tauri-action v1 の出力（`updaterJsonPreferNsis: true`）
// に合わせてある。理由は `.claude/rules/build.md` の「CI/CD」。
//
// gh の認証（CI では GH_TOKEN）を使う。リポジトリは GITHUB_REPOSITORY、無ければ kan/pike。

import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const [releaseId, outPath] = process.argv.slice(2)
const repo = process.env.GITHUB_REPOSITORY || 'kan/pike'

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (!/^\d+$/.test(releaseId ?? '') || !outPath) {
  fail('usage: node scripts/updater-json.mjs <release-id> <出力先>')
}

/** gh api の応答を Buffer で返す（アセットの本体はバイナリなので文字列にしない）。 */
function ghApi(path, accept) {
  const headers = accept ? ['-H', `Accept: ${accept}`] : []
  return execFileSync('gh', ['api', ...headers, path], { maxBuffer: 1024 * 1024 * 1024 })
}

const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const release = JSON.parse(ghApi(`repos/${repo}/releases/${releaseId}`))
const { assets } = release

const version = release.tag_name.replace(/^v/, '')
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`タグ名がバージョンの形ではありません: ${release.tag_name}`)

// updater が落とす成果物と、それを指す platforms のキー。キーの並びは tauri-action と同じ。
// Windows は NSIS を主にする（`windows-x86_64` は setup.exe を指す）。
const product = conf.productName
const updaters = [
  { name: `${product}_${version}_x64-setup.exe`, keys: ['windows-x86_64', 'windows-x86_64-nsis'] },
  { name: `${product}_${version}_x64_en-US.msi`, keys: ['windows-x86_64-msi'] },
  {
    name: `${product}_${version}_aarch64.app.tar.gz`,
    keys: ['darwin-aarch64', 'darwin-aarch64-app'],
  },
]

/** minisign の鍵や署名の本体（base64 の行）をバイト列にする。`.sig` と pubkey はどちらも全体が base64。 */
function minisignLines(base64) {
  return Buffer.from(base64, 'base64').toString('utf8').split('\n')
}

const [, pubLine] = minisignLines(conf.plugins.updater.pubkey)
const pub = Buffer.from(pubLine, 'base64') // "Ed" 2 バイト + 鍵 ID 8 バイト + 公開鍵 32 バイト
const pubKeyId = pub.subarray(2, 10)
const publicKey = createPublicKey({
  // Ed25519 の生の公開鍵に SPKI の DER の頭を付ける
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub.subarray(10)]),
  format: 'der',
  type: 'spki',
})

/** tauri の updater と同じ検証をする（minisign。本体の署名と trusted comment の署名の 2 つ）。 */
function checkSignature(name, file, signature) {
  const [, sigLine, trustedLine, globalLine] = minisignLines(signature)
  const sig = Buffer.from(sigLine, 'base64') // アルゴリズム 2 バイト + 鍵 ID 8 バイト + 署名 64 バイト
  const algorithm = sig.subarray(0, 2).toString('latin1')
  if (!sig.subarray(2, 10).equals(pubKeyId)) fail(`${name}: 署名の鍵 ID が公開鍵と違います`)
  // "ED" は本体の BLAKE2b-512 に署名する方式（tauri の既定）、"Ed" は本体そのものに署名する方式
  const message = algorithm === 'ED' ? createHash('blake2b512').update(file).digest() : file
  if (!verify(null, message, publicKey, sig.subarray(10))) fail(`${name}: 署名が本体と合いません`)

  const trusted = trustedLine.replace(/^trusted comment: /, '')
  const global = Buffer.from(globalLine, 'base64')
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted)]), publicKey, global)) {
    fail(`${name}: trusted comment の署名が合いません`)
  }
  // 古いビルドの .sig が残っていても通らないように、署名した時点のバージョンも見る
  if (!trusted.split('\t').includes(`version:${version}`)) {
    fail(`${name}: 署名のバージョンが ${version} ではありません（${trusted}）`)
  }
}

function findAsset(name) {
  return assets.find((asset) => asset.name === name) ?? fail(`${name} がドラフトにありません`)
}

const platforms = {}
for (const { name, keys } of updaters) {
  const asset = findAsset(name)
  const signature = ghApi(findAsset(`${name}.sig`).url, 'application/octet-stream')
    .toString('utf8')
    .trim()
  checkSignature(name, ghApi(asset.url, 'application/octet-stream'), signature)
  // tauri-action と同じく API のアセット URL を使う（updater は octet-stream を付けて取りに来る）
  for (const key of keys) platforms[key] = { signature, url: asset.url }
  console.log(`ok: ${name} -> ${keys.join(', ')}`)
}

const latest = {
  version,
  // ドラフトの本文（draft ジョブが release-notes.mjs で CHANGELOG の節から作ったもの）
  notes: release.body ?? '',
  pub_date: new Date().toISOString(),
  platforms,
}
writeFileSync(outPath, JSON.stringify(latest, null, 2))
console.log(`wrote ${outPath}`)
