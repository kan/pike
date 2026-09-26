// Vue SFC のプレビュー（#397）の純粋な部分。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  affectsVuePreview,
  fixtureFromFields,
  fixtureOf,
  inputFields,
  pikeFixtureName,
  powershellEncoded,
  vuePreviewInstallCommand,
  vuePreviewMessagePage,
} from '../src/lib/vuePreview.ts'

test('入れた値の fixture は、プロジェクトからの相対パスを 1 段の名前にする', () => {
  assert.equal(
    pikeFixtureName('app/src/components/dialog/Holiday.vue'),
    'app__src__components__dialog__Holiday.vue.json',
  )
})

test('フォームの欄は props、値、composable の値の順。今の値を JSON で入れ、今回参照されなかった値も残す', () => {
  const inputs = {
    props: [
      { name: 'modelValue', types: ['Boolean'] },
      { name: 'size', types: ['String'], default: 'md' },
    ],
    values: [
      { name: 't', origin: 'call' as const },
      { name: 'query', default: '' },
    ],
    fixture: null,
  }
  const fields = inputFields(inputs, { modelValue: true, hidden: [1, 2] })
  assert.deepEqual(
    fields.map((f) => [f.name, f.kind, f.types, f.initial, f.text]),
    [
      ['modelValue', 'prop', 'Boolean', null, 'true'],
      ['size', 'prop', 'String', '"md"', ''],
      ['query', 'value', '', '""', ''],
      ['t', 'call', '', null, ''],
      ['hidden', 'value', '', null, '[1,2]'],
    ],
  )
})

test('プロトタイプにある名前（constructor）でも、入れていなければ欄は空', () => {
  const fields = inputFields({ props: [], values: [{ name: 'constructor' }], fixture: null }, {})
  assert.equal(fields[0].text, '')
})

test('欄の入力は JSON として読み、読めなければ文字列にする。空の欄は与えない', () => {
  assert.deepEqual(
    fixtureFromFields([
      { name: 'open', text: 'true' },
      { name: 'rows', text: '[{"id":1}]' },
      { name: 'name', text: '山田 太郎' },
      { name: 'empty', text: '  ' },
    ]),
    { open: true, rows: [{ id: 1 }], name: '山田 太郎' },
  )
})

test('fixture は SFC の隣の <name>.preview.json', () => {
  assert.equal(fixtureOf('src/components/UserTable.vue'), 'src/components/UserTable.preview.json')
})

test('描き直すのは SFC 自身・前回の deps・まだ無い fixture と設定ファイル', () => {
  const entry = 'src/components/UserPage.vue'
  const deps = new Set(['src/components/UserPage.vue', 'src/components/StatusBadge.vue', 'src/styles/main.css'])
  for (const rel of [
    entry,
    'src/components/StatusBadge.vue',
    'src/styles/main.css',
    'src/components/UserPage.preview.json',
    'vue-preview.config.json',
  ]) {
    assert.equal(affectsVuePreview(rel, entry, deps), true, rel)
  }
  for (const rel of ['src/components/Other.vue', 'src/main.ts', 'src/vue-preview.config.json']) {
    assert.equal(affectsVuePreview(rel, entry, deps), false, rel)
  }
})

test('案内のページは本文を HTML として解釈しない', () => {
  const page = vuePreviewMessagePage('失敗', '<script>alert(1)</script> & "x"')
  assert.ok(!page.includes('<script>alert'))
  assert.ok(page.includes('&#60;script&#62;alert(1)&#60;/script&#62; &#38; &#34;x&#34;'))
  assert.ok(!vuePreviewMessagePage('描画中').includes('<pre>'))
})

test('WSL と macOS は bash で ~/.local/bin に入れる（包みの単引用符を中で使わない）', () => {
  for (const shell of [{ kind: 'wsl', distro: 'Ubuntu' }, { kind: 'unix' }] as const) {
    const cmd = vuePreviewInstallCommand(shell)
    assert.ok(cmd.startsWith("bash -c '") && cmd.endsWith("'"))
    assert.equal(cmd.slice("bash -c '".length, -1).includes("'"), false)
    assert.ok(cmd.includes('https://github.com/kan/vue-preview/releases/latest/download/$n'))
    assert.ok(cmd.includes('sha256sum -c') && cmd.includes('shasum -a 256 -c'))
    assert.ok(cmd.includes('install -m 755 "$n" "$HOME/.local/bin/vue-preview"'))
  }
})

test('Windows のシェルは PowerShell の -EncodedCommand で 1 行にする（どのシェルに打っても引用が要らない）', () => {
  /** `-EncodedCommand` の中身（UTF-16LE の base64）を戻す。 */
  const decode = (b64: string) => {
    const bin = atob(b64)
    let s = ''
    for (let i = 0; i < bin.length; i += 2) s += String.fromCharCode(bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8))
    return s
  }
  for (const kind of ['cmd', 'powershell', 'pwsh', 'git-bash'] as const) {
    const cmd = vuePreviewInstallCommand({ kind })
    const encoded = /^powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(cmd)?.[1]
    assert.ok(encoded, cmd)
    const script = decode(encoded)
    assert.ok(script.includes('vue-preview-windows-x64.exe'))
    assert.ok(script.includes('SHA256'))
    assert.ok(script.includes('$env:USERPROFILE, ".local", "bin"'))
  }
  assert.equal(decode(powershellEncoded('a$b')), 'a$b')
})
