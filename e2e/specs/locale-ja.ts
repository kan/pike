import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const shotDir = path.resolve(here, '..', '..', 'artifacts', 'screenshots')

// Phase 0 追加確認: 日本語ロケールで文字化け（tofu/mojibake）せず撮影できるか。
// settings store は起動時に localStorage `pike:settings` の language を読んで
// i18n locale に反映するため、ja を書いてリロードしてから撮影する。
describe('phase0 japanese locale', () => {
  it('renders Japanese without mojibake', async () => {
    await $('#app').waitForExist({ timeout: 30_000 })

    await browser.execute(() => {
      const raw = localStorage.getItem('pike:settings')
      const s = raw ? JSON.parse(raw) : {}
      s.language = 'ja'
      localStorage.setItem('pike:settings', JSON.stringify(s))
    })
    await browser.refresh()

    await $('#app').waitForExist({ timeout: 30_000 })
    await $('#app').waitForDisplayed({ timeout: 30_000 })

    // 日本語文字列が実際に DOM に載っていることを確認（ロケール反映の担保）。
    // 文字化けの最終判定は保存画像の目視で行う。
    const bodyText = await $('body').getText()
    console.log(`[locale-ja] sample = ${JSON.stringify(bodyText.replace(/\s+/g, ' ').slice(0, 160))}`)
    const hasJapanese = /[぀-ヿ一-龯]/.test(bodyText)
    expect(hasJapanese).toBe(true)

    await browser.saveScreenshot(path.join(shotDir, 'phase0-ja.png'))
  })
})
