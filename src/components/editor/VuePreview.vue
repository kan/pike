<script setup lang="ts">
/**
 * Vue SFC のプレビュー（#397）。エディタの Preview / Split に、HTML のプレビュー（#399、
 * `HtmlPreview.vue`）と同じ子 webview を重ね、**プロジェクトの Vite 開発サーバーが配る入口**
 * を開く。重ねる・隠す・閉じるは `useChildWebview`、子 webview を作るのは Rust の
 * `preview_dev_open`。
 *
 * **Pike は SFC をコンパイルしない。** 入口の HTML を Vite のルートの `.pike/preview/` に書き、
 * 開発サーバーを探して（候補の順と、取りに行って確かめる理由は `lib/devServer.ts`）、応えた
 * ものの URL を開く。保存したときの描き直しは Vite の HMR が受け持つので、`HtmlPreview` と
 * 違って保存も監視も見ない。
 *
 * **Vite のルートは、SFC から上へ辿って最初に `vite.config.*` があるディレクトリ**（プロジェクトの
 * ルートまで）。モノレポで `frontend/` の下に Vite がある構成もここで拾う。`vite.config` の
 * `root` を変えている構成は対象外（入口の URL がずれて、取りに行った時点で落ちる）。
 *
 * **入口は閉じても消さない。** SFC ごとに決まった名前なので、増えるのはプレビューした SFC の
 * 数までで、開き直せば上書きされる。`.pike/` には `.gitignore` があり、Vite の依存の走査も
 * ドットで始まるディレクトリを見ない。消す形は、同じ SFC を別のタブや**別のウィンドウ**
 * （件数を数える表がウィンドウごとに分かれる）で開いているときに、残ったほうのページを
 * SPA のフォールバック（`index.html`）へ落とす。閉じてすぐ開き直したときも、消す指示と
 * 書く指示が前後して入口が消えたまま残りうる。
 */

import { computed, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useChildWebview } from '../../composables/useChildWebview'
import { devServerUrls } from '../../composables/useDevServerUrls'
import { useI18n } from '../../i18n'
import {
  type DevServerCandidate,
  devServerCandidates,
  hasDependency,
  PREVIEW_DIR,
  previewEntryHtml,
  previewEntryScript,
  previewEntryStem,
  previewMarker,
  readViteConfig,
  VITE_CONFIG_NAMES,
  type ViteConfigHints,
} from '../../lib/devServer'
import { findNearestUpward } from '../../lib/jumpTo/resolveImport'
import { basename, dirname, pathSep } from '../../lib/paths'
import { ensurePikeDir } from '../../lib/pikeDir'
import { isSameOrUnder, type ProjectPlatform, relativeToBase } from '../../lib/projectPaths'
import {
  type DevProbe,
  dockerListContainers,
  dockerVirtualHosts,
  fsReadFile,
  fsWriteFile,
  previewDevOpen,
  previewDevProbe,
} from '../../lib/tauri'
import { useProjectStore } from '../../stores/project'
import { useSettingsStore } from '../../stores/settings'
import { useSidebarStore } from '../../stores/sidebar'
import { useTabStore } from '../../stores/tabs'
import { shellToPlatform } from '../../types/tab'

const props = defineProps<{
  tabId: string
  path: string
  /** スマートフォンの縦長の画面で見る（`HtmlPreview` と同じ）。 */
  mobile?: boolean
}>()
const { t } = useI18n()
const tabStore = useTabStore()
const projectStore = useProjectStore()
const settings = useSettingsStore()
const sidebar = useSidebarStore()

const hostRef = useTemplateRef<HTMLElement>('hostRef')
const error = ref<string | null>(null)

/** 試した候補と、その結果（見つからなかったときに並べて見せる）。 */
interface Tried extends DevServerCandidate {
  result: DevProbe
}

type State =
  | { kind: 'searching' }
  | { kind: 'ready'; url: string }
  /** Vite のルートが見つからない（`vite.config.*` が無い）。 */
  | { kind: 'noVite' }
  /** 入口は書けたが、どの候補も応えなかった。 */
  | { kind: 'noServer'; tried: Tried[] }
  | { kind: 'failed'; message: string }
const state = shallowRef<State>({ kind: 'searching' })

/** 開いている入口の URL（`ready` のときだけ）。 */
const pageUrl = computed(() => (state.value.kind === 'ready' ? state.value.url : null))

/** 入口を書き終えた SFC の情報。ターミナル起因の探し直しでは fs を読み直さずにこれを使う。 */
interface Prepared {
  path: string
  platform: ProjectPlatform
  viteRoot: string
  hints: ViteConfigHints
  /** 入口の Vite のルートからの URL（`.pike/preview/…`）。 */
  entryRel: string
  marker: string
}
const prepared = shallowRef<Prepared | null>(null)

/** 2 つのディレクトリが同じか、どちらかがもう一方の下にあるか。 */
function related(a: string, b: string, platform: ProjectPlatform): boolean {
  return isSameOrUnder(a, b, platform) || isSameOrUnder(b, a, platform)
}

/**
 * Vite のルートを探し、設定を読み、入口を書く。WSL では読み書きのたびに `wsl.exe` が起きる
 * ので、探し直しのたびには呼ばない（`resolve` の `fresh`）。
 */
async function prepare(): Promise<Prepared | null> {
  const shell = projectStore.shellForIO
  const platform = shellToPlatform(shell)
  const sep = pathSep(shell)
  // プロジェクトの外のファイルは、プロジェクトのルートで止めずにファイル自身の木を上へ辿る
  // （`findNearestUpward` が判断する）。
  const config = await findNearestUpward(props.path, projectStore.activeRoot, sep, shell, VITE_CONFIG_NAMES)
  if (!config) return null
  const viteRoot = dirname(config)
  const rel = relativeToBase(viteRoot, props.path, platform)
  if (rel === null) throw new Error(`not under ${viteRoot}`)
  const stem = previewEntryStem(rel)
  const marker = previewMarker(props.path)
  const [configText, pkg, dir] = await Promise.all([
    fsReadFile(shell, config).then((r) => r.content),
    fsReadFile(shell, `${viteRoot}${sep}package.json`, undefined, { allowMissing: true }).then((r) => r.content),
    ensurePikeDir(shell, viteRoot, 'preview'),
  ])
  const files: [string, string][] = [
    [`${stem}.html`, previewEntryHtml({ title: basename(props.path), stem, marker })],
    // 入口は `.pike/preview/` の 2 段下にある。
    [`${stem}.js`, previewEntryScript({ sfcImport: `../../${rel}`, pinia: hasDependency(pkg, 'pinia') })],
  ]
  // 中身が同じなら書かない（書くと Vite がそのページを読み直す）。
  await Promise.all(
    files.map(async ([name, content]) => {
      const path = `${dir}${sep}${name}`
      const current = await fsReadFile(shell, path, undefined, { allowMissing: true }).catch(() => null)
      if (current?.content !== content) await fsWriteFile(shell, path, content)
    }),
  )
  return {
    path: props.path,
    platform,
    viteRoot,
    hints: readViteConfig(configText),
    entryRel: `${PREVIEW_DIR}/${encodeURIComponent(stem)}.html`,
    marker,
  }
}

/** ターミナルに出た URL のうち、この Vite のルートに関係するもの（新しい順）。 */
function terminalUrls(p: Prepared): string[] {
  return devServerUrls
    .list()
    .filter((c) => related(c.cwd, p.viteRoot, p.platform))
    .map((c) => c.url)
}

/** 最後の探索で使ったターミナルの URL（同じなら探し直さない）。 */
let usedTerminal = ''

/** 探し直しのたびに増やす（遅れて戻った古い探索を捨てる）。 */
let generation = 0

/**
 * 開発サーバーを探して開く。`fresh` が false なら、同じ SFC について書いた入口と読んだ設定を
 * 使い回す（ターミナルに新しい `Local:` が出たとき）。
 */
async function resolve(fresh = true) {
  const gen = ++generation
  const stale = () => gen !== generation || view.disposed()
  if (state.value.kind !== 'ready') state.value = { kind: 'searching' }
  // Docker の一覧は fs と関係ないので先に投げておく。
  const containers = dockerListContainers()
    .then((r) => r.containers)
    .catch(() => [])
  try {
    const p = fresh || prepared.value?.path !== props.path ? await prepare() : prepared.value
    if (stale()) return
    prepared.value = p
    if (!p) {
      settle({ kind: 'noVite' })
      return
    }
    const terminal = terminalUrls(p)
    usedTerminal = terminal.join(' ')

    /** 候補の URL ごとに 1 回だけ取りに行く（投げた時点から並んで走る）。 */
    const probes = new Map<string, Promise<Tried>>()
    const probe = (c: DevServerCandidate) => {
      let pending = probes.get(c.url)
      if (!pending) {
        const url = new URL(p.entryRel, c.url).toString()
        pending = previewDevProbe(url, p.marker)
          .catch((): DevProbe => 'unreachable')
          .then((result) => ({ ...c, url, result }))
        probes.set(c.url, pending)
      }
      return pending
    }
    /**
     * 並べて取りに行き（応えないポートの待ち時間を重ねない）、順に見ていく。前の候補が
     * 全部決まった時点で応えたものがあれば、後ろを待たずに開く。
     */
    const tried: Tried[] = []
    const walk = async (list: DevServerCandidate[]): Promise<'more' | 'done'> => {
      list.forEach(probe)
      for (const c of list) {
        const t = await probe(c)
        if (stale()) return 'done'
        if (t.result === 'ready') {
          settle({ kind: 'ready', url: t.url })
          return 'done'
        }
        tried.push(t)
      }
      return 'more'
    }

    // **Docker を待たずに**、Docker に関係しない前半（ターミナルと設定）を先に見る。Docker が
    // 止まっていると、接続を諦めるまで数秒かかることがある。
    const head = devServerCandidates({ terminal, config: p.hints, virtualHosts: [], docker: [], fallback: '' })
    if ((await walk(head)) === 'done') return

    // この Vite のルートに関係する compose のコンテナ（Docker に繋がらなければ空で、以下は何もしない）。
    const ours = (await containers).filter(
      (c) => c.state === 'running' && c.composeWorkingDir && related(c.composeWorkingDir, p.viteRoot, p.platform),
    )
    const virtualHosts = ours.length ? await dockerVirtualHosts(ours.map((c) => c.id)).catch(() => []) : []
    if (stale()) return
    const all = devServerCandidates({
      terminal,
      config: p.hints,
      virtualHosts,
      docker: ours.flatMap((c) => c.ports),
      fallback: settings.devServerUrl,
    })
    // 並べる規則が同じなので、先頭は `head` と一致する。残りだけを見る。
    if ((await walk(all.slice(head.length))) === 'done') return
    settle({ kind: 'noServer', tried })
  } catch (e) {
    if (!stale()) settle({ kind: 'failed', message: String(e) })
  }
}

/**
 * 探した結果を反映する。開いている URL が変わるときだけ子 webview を作り直す（同じなら
 * そのまま。探し直しは新しい `Local:` が出るたびに走るので、毎回作り直すとちらつく）。
 * `recreate` はどの状態からでも効く（作っている途中なら作り終えてから、開くものが無ければ
 * 閉じるだけ）。
 */
function settle(next: State) {
  const before = pageUrl.value
  state.value = next
  if (pageUrl.value !== before) view.recreate()
}

const view = useChildWebview({
  el: hostRef,
  visible: () => tabStore.isTabVisible(props.tabId),
  // `browser-` の下に置く: 位置合わせ・閉じるはブラウザのタブのコマンドを使う。
  newLabel: () => `browser-preview-${crypto.randomUUID()}`,
  canCreate: () => pageUrl.value !== null,
  create: async (label, bounds) => {
    const url = pageUrl.value
    if (!url) throw new Error('no dev server')
    await previewDevOpen(label, url, bounds)
  },
  handlers: {
    // ページの中のリンク（Rust がブラウザのタブへ振り替えたもの）。
    onNewTab: (url) => {
      const tab = tabStore.tabs.find((x) => x.id === props.tabId)
      tabStore.addBrowserTab(url, { forceNew: true, pane: tab ? tabStore.paneOf(tab) : undefined })
    },
  },
  onError: (e) => (error.value = e),
})

void resolve()

// Save As で別のファイルになったら入口から作り直す。
watch(
  () => props.path,
  () => void resolve(),
)

/**
 * この Vite のルートに関係するターミナルに新しい `Local:` が出たら探し直す（開発サーバーを
 * 起動した・別のポートで立ち上げ直した）。見つかっていなければ、これで自然に見つかる。
 * 入口と設定は使い回す。**関係の無いプロジェクトのサーバーでは起きない**。
 */
watch(
  () => (prepared.value ? terminalUrls(prepared.value).join(' ') : ''),
  (urls) => {
    if (urls !== usedTerminal) void resolve(false)
  },
)

function openTasks() {
  sidebar.openPanel('tasks')
}

/** 隠している理由を先に出す（`HtmlPreview` と同じ）。 */
const notice = computed(() => view.hiddenNotice.value || error.value)
</script>

<template>
  <!-- 子 webview を重ねるのは `.vue-preview-frame`。中身は空で、矩形だけを貸す（案内だけを置く）。 -->
  <div class="vue-preview" :class="{ mobile }">
    <div ref="hostRef" class="vue-preview-frame">
      <template v-if="state.kind === 'ready'">
        <div v-if="notice" class="vue-preview-message" :class="{ error: !!error }">{{ notice }}</div>
      </template>
      <div v-else-if="state.kind === 'searching'" class="vue-preview-message">{{ t('vuePreview.searching') }}</div>
      <div v-else class="vue-preview-message">
        <p v-if="state.kind === 'noVite'">{{ t('vuePreview.noVite') }}</p>
        <template v-else-if="state.kind === 'noServer'">
          <p>{{ t('vuePreview.noServer') }}</p>
          <ul class="vue-preview-tried">
            <li v-for="c in state.tried" :key="c.url">
              <code>{{ c.url }}</code>
              <span class="vue-preview-source">{{ t(`vuePreview.source.${c.source}`) }}</span>
              <span>{{ t(`vuePreview.probe.${c.result}`) }}</span>
            </li>
          </ul>
        </template>
        <p v-else-if="state.kind === 'failed'" class="error">{{ state.message }}</p>
        <div class="vue-preview-actions">
          <button type="button" class="vue-preview-btn" @click="resolve()">{{ t('vuePreview.retry') }}</button>
          <button v-if="state.kind === 'noServer'" type="button" class="vue-preview-btn" @click="openTasks">
            {{ t('vuePreview.openTasks') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vue-preview {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}

.vue-preview-frame {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 大きさはブラウザのタブのスマートフォンの画面（`BrowserTab.vue`）と同じ。 */
.vue-preview.mobile {
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
}

.vue-preview.mobile .vue-preview-frame {
  flex: 0 0 auto;
  width: min(390px, 100%);
  height: min(844px, 100%);
  outline: 1px solid var(--border);
}

.vue-preview-message {
  max-width: 36em;
  padding: 0 16px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-secondary);
}

.vue-preview-message p {
  margin: 0 0 8px;
}

.vue-preview-message .error,
.vue-preview-message.error {
  color: var(--danger);
}

.vue-preview-tried {
  margin: 0 0 12px;
  padding-left: 1.2em;
}

.vue-preview-tried code {
  font-family: var(--font-mono, monospace);
  color: var(--text-primary);
}

.vue-preview-source {
  margin: 0 6px;
  opacity: 0.8;
}

.vue-preview-actions {
  display: flex;
  gap: 8px;
}

.vue-preview-btn {
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
}

.vue-preview-btn:hover {
  border-color: var(--accent);
}
</style>
