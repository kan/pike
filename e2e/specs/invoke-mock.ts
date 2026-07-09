// Phase 0 ゲート第2項目: invoke モックが効くことの確認。
// @wdio/tauri-service の browser.tauri.mock() で Tauri invoke を差し替え、
// フロントからの invoke がモック値を返すことを検証する。これが効けば、
// Git/Docker/ファイルツリー等の invoke 駆動パネルへ決定的データを与えて
// 撮影できる（Phase 1）見込みが立つ。
describe('phase0 invoke mock', () => {
  it('intercepts a Tauri invoke and returns mocked data', async () => {
    // Pike に存在しない任意コマンド名で良い。モックが Rust に到達する前に
    // 横取りするため、実コマンドである必要はない。
    const probe = await browser.tauri.mock('wdio_probe_command')
    await probe.mockResolvedValue({ ok: true, answer: 42 })

    const result = await browser.tauri.execute(({ core }) =>
      core.invoke('wdio_probe_command', { hello: 'world' }),
    )

    console.log(`[invoke-mock] result = ${JSON.stringify(result)}`)
    expect(result).toEqual({ ok: true, answer: 42 })

    await browser.tauri.restoreAllMocks()
  })
})
