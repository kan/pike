import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

// tauri build --debug --no-bundle -c src-tauri/tauri.e2e.conf.json で生成される
// e2e 専用 identifier (com.pike.e2e) のバイナリ。
const application = path.join(repoRoot, 'src-tauri', 'target', 'debug', 'pike.exe')

const screenshotDir = path.join(repoRoot, 'artifacts', 'screenshots')
fs.mkdirSync(screenshotDir, { recursive: true })

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: [path.join(here, 'specs', '**', '*.ts')],
  maxInstances: 1,

  capabilities: [
    {
      browserName: 'tauri',
      // @ts-expect-error tauri:options は @wdio/tauri-service の独自ケイパビリティ
      'tauri:options': {
        application,
      },
    },
  ],

  services: [['@wdio/tauri-service', { driverProvider: 'embedded' }]],

  framework: 'mocha',
  reporters: ['spec'],
  logLevel: 'info',
  mochaOpts: {
    ui: 'bdd',
    timeout: 120_000,
  },
}
