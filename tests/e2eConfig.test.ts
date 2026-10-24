// 撮影用ビルドの main ウィンドウが本番と同じであること（#506）。`just test-ts` で走る。
// `tauri.e2e.conf.json` は表示倍率の引数を足すために main ウィンドウの設定を丸ごと写している
// （`app.windows` は配列なので、マージで置き換わる）。本番の設定だけ変えると、撮影用ビルドは
// 黙って別のウィンドウで撮ることになる。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

type WindowConfig = Record<string, unknown>

function mainWindow(file: string): WindowConfig {
  const path = fileURLToPath(new URL(`../src-tauri/${file}`, import.meta.url))
  const config = JSON.parse(readFileSync(path, 'utf8')) as { app: { windows: WindowConfig[] } }
  return config.app.windows[0]
}

test('撮影用の main ウィンドウは、表示倍率の引数を除いて本番と同じ', () => {
  const { additionalBrowserArgs, ...e2e } = mainWindow('tauri.e2e.conf.json')
  assert.deepEqual(e2e, mainWindow('tauri.conf.json'))
  assert.match(String(additionalBrowserArgs), /--force-device-scale-factor=/)
})
