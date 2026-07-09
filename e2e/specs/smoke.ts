import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const screenshotDir = path.resolve(here, '..', '..', 'artifacts', 'screenshots')

// Phase 0 ゲート: @wdio/tauri-service + embedded provider で Pike を起動し、
// WebView 内の要素を掴んで操作・撮影できることを確認するスモークテスト。
describe('phase0 smoke', () => {
  it('launches Pike and reaches the WebView', async () => {
    const app = await $('#app')
    await app.waitForExist({ timeout: 60_000 })
    await app.waitForDisplayed({ timeout: 60_000 })

    const title = await browser.getTitle()
    console.log(`[smoke] document.title = ${title}`)

    await browser.saveScreenshot(path.join(screenshotDir, 'phase0-smoke.png'))
  })
})
