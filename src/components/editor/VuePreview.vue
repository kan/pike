<script setup lang="ts">
/**
 * Vue SFC のプレビュー（#397）。外部コマンド `vue-preview` が描いた 1 枚の HTML を、HTML の
 * プレビュー（#399）と同じ子 webview の仮想ファイル（`VUE_PREVIEW_ENTRY`）として出す。
 * 置くのは Rust（`vue_preview_render`。HTML は IPC を通らない）。重ねる・隠す・閉じるは
 * `useChildWebview`、いつ描き直すかは `usePreviewRefresh`、器は `PreviewFrame`（どれも
 * `HtmlPreview.vue` と共有）。
 *
 * **描くのは保存したファイル**（vue-preview がディスクから読む）。描き直す契機は、前回の結果の
 * `deps`（子コンポーネント・CSS・fixture・設定）の変化。
 *
 * **描画のルートは SFC からいちばん近い `package.json` のディレクトリ**（vue-preview の
 * `--root` = cwd。node_modules、または依存キャッシュの元になるロックファイルがある場所）。
 * プロジェクトのルートとは限らない（`app/` の下に Vue を置くリポジトリがある）。
 *
 * 描いているあいだも前の結果を出したままにし、上の帯に「描画中」を出す（初回は依存の
 * install で数十秒かかることがある）。警告はその帯に件数を出し、押すと一覧を開く。
 *
 * **マウント時の値を仮に埋めるフォーム**（props や `onMounted` で取るデータ）。欄は vue-preview の
 * `inputs`、入れた値はプロジェクトの `.pike/preview/` に fixture として置き、`--fixture` で渡す
 * （リポジトリには入らない）。置いてあるあいだは SFC の隣の `<name>.preview.json` より優先する。
 */

import { AlertTriangle, LoaderCircle, SlidersHorizontal } from 'lucide-vue-next'
import { computed, ref, useTemplateRef, watch } from 'vue'
import { previewWebviewOptions, useChildWebview } from '../../composables/useChildWebview'
import { usePreviewRefresh } from '../../composables/usePreviewRefresh'
import { useI18n } from '../../i18n'
import { findNearestUpward } from '../../lib/jumpTo/resolveImport'
import { basename, dirname, joinPath, pathSep } from '../../lib/paths'
import { ensurePikeDir, pikeDirPath } from '../../lib/pikeDir'
import type { ProjectPlatform } from '../../lib/projectPaths'
import { relativeToBase } from '../../lib/projectPaths'
import {
  browserHistory,
  fsDelete,
  fsReadFile,
  fsWriteFile,
  previewOpen,
  previewSetFiles,
  type VueRender,
  vuePreviewRender,
} from '../../lib/tauri'
import {
  affectsVuePreview,
  fixtureFromFields,
  type InputField,
  inputFields,
  pikeFixtureName,
  VUE_PREVIEW_ENTRY,
  type VueInputs,
  vuePreviewMessagePage,
} from '../../lib/vuePreview'
import { useProjectStore } from '../../stores/project'
import { useVuePreviewStore } from '../../stores/vuePreview'
import { type ShellType, shellToPlatform } from '../../types/tab'
import PreviewFrame from './PreviewFrame.vue'
import VuePreviewForm from './VuePreviewForm.vue'

const props = defineProps<{
  tabId: string
  path: string
  /** スマートフォンの縦長の画面で見る（`HtmlPreview` と同じ）。 */
  mobile?: boolean
}>()
const { t } = useI18n()
const projectStore = useProjectStore()
const vuePreviewStore = useVuePreviewStore()

const frame = useTemplateRef<{ host: HTMLElement | null }>('frame')
const error = ref<string | null>(null)

/**
 * 描いている SFC。**子 webview を作った時点で固定する**（`HtmlPreview` の `served` と同じ）。
 * `pikeBase` は `.pike/` を置くディレクトリ（今のプロジェクト、無ければ描画のルート）、
 * `fixture` はフォームの値のファイル。
 */
const served = ref<{
  root: string
  platform: ProjectPlatform
  shell: ShellType
  rel: string
  pikeBase: string
  fixture: string
} | null>(null)
type Served = NonNullable<typeof served.value>

/** 前回の結果に効いたファイル（ルートからの相対パス）。 */
let deps: ReadonlySet<string> = new Set()
const warnings = ref<string[]>([])
const showWarnings = ref(false)
const rendering = ref(false)

/** fixture で与えられるもの（前回の結果の `inputs`。古い vue-preview では null）。 */
const inputs = ref<VueInputs | null>(null)
/** フォームで入れた値（`.pike/preview/` に置いたもの）。置いていなければ null。 */
const formValues = ref<Record<string, unknown> | null>(null)
const showForm = ref(false)
const fields = ref<InputField[]>([])
const canFill = computed(() => !!inputs.value && inputs.value.props.length + inputs.value.values.length > 0)

/** fixture（JSON のオブジェクト）を読む。無い・読めない・オブジェクトでないなら null。 */
async function readFixture(shell: ShellType, path: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fsReadFile(shell, path, undefined, { allowMissing: true })
    if (r.isNew) return null
    const value: unknown = JSON.parse(r.content)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const view = useChildWebview({
  ...previewWebviewOptions(props.tabId),
  el: computed(() => frame.value?.host),
  create: async (label, bounds) => {
    const shell = projectStore.shellForIO
    const platform = shellToPlatform(shell)
    const sep = pathSep(shell)
    // 描画のルートは SFC からいちばん近い package.json のディレクトリ（`app/` の下に Vue を
    // 置くリポジトリがある）。探すのは今のプロジェクトのルートまでで、外のファイルは自分の木を
    // 辿る。見つからなければ SFC の隣を渡し、無いことは vue-preview に言わせる。
    const manifest = await findNearestUpward(props.path, projectStore.activeRoot ?? '', sep, shell, ['package.json'])
    const root = dirname(manifest ?? props.path)
    const rel = relativeToBase(root, props.path, platform) ?? basename(props.path)
    const pikeBase = projectStore.activeRoot ?? root
    const fromBase = relativeToBase(pikeBase, props.path, platform) ?? basename(props.path)
    const fixture = joinPath(pikeDirPath(shell, pikeBase, 'preview'), pikeFixtureName(fromBase), sep)
    const page = { path: VUE_PREVIEW_ENTRY, content: vuePreviewMessagePage(t('vuePreview.rendering')) }
    // 入れた値は最初の描画で要るだけなので、子 webview を開くのと並べて読む
    const [values] = await Promise.all([
      readFixture(shell, fixture),
      previewOpen(label, root, shell, VUE_PREVIEW_ENTRY, bounds, [page]),
    ])
    formValues.value = values
    served.value = { root, platform, shell, rel, pikeBase, fixture }
    void render()
  },
  onError: (e) => (error.value = e),
  onReset: () => {
    served.value = null
    deps = new Set()
    warnings.value = []
    inputs.value = null
    showForm.value = false
  },
})

/** Save As で別のファイルになったら作り直す（`HtmlPreview` と同じ理由）。 */
watch(
  () => props.path,
  () => view.recreate(),
)

/**
 * 描いて置き直す。**走っているあいだの要求は 1 回に畳んで、終わってから描き直す**
 * （描画は外部プロセスで 1 秒弱かかる。重ねて起こすと、古い結果が後から届いて勝つ）。
 */
let again = false
async function render() {
  if (rendering.value) {
    again = true
    return
  }
  const s = served.value
  if (!s) return
  rendering.value = true
  try {
    await renderOnce(s)
  } finally {
    rendering.value = false
  }
  // **結果を捨てた回でも見る**: 描いているあいだに作り直すと、新しい子 webview の最初の
  // 要求はここに畳まれている。
  if (again) {
    again = false
    void render()
  }
}

async function renderOnce(s: Served) {
  const label = view.label()
  let result: VueRender | null = null
  let failure: string | null = null
  try {
    const fixture = formValues.value ? s.fixture : null
    result = await vuePreviewRender(s.shell, s.root, s.rel, label, VUE_PREVIEW_ENTRY, fixture)
  } catch (e) {
    failure = String(e)
    // vue-preview が消えたのかもしれない。Rust は「見つかった」をプロセスの寿命ぶん覚えているので、
    // 覚えた答えを捨てて探し直す。無ければ EditorTab がこの欄を入れ方の案内に替える。失敗の
    // 文面（シェルと言語で変わる）では見分けず、失敗した回にだけ 1 本起こす。
    void vuePreviewStore.detect(s.shell, s.root, true)
  }
  // 描いているあいだに作り直した・閉じた: この結果は別の子 webview のもの。
  if (view.disposed() || served.value !== s) return
  // 失敗しても前回の deps と入力の一覧は残す（直して保存したときに描き直せるように）。
  if (result) {
    deps = new Set(result.deps)
    inputs.value = result.inputs
  }
  warnings.value = result?.warnings ?? []
  try {
    if (failure !== null) {
      const page = vuePreviewMessagePage(t('vuePreview.failed'), failure)
      await previewSetFiles(label, [{ path: VUE_PREVIEW_ENTRY, content: page }])
    }
    await browserHistory(label, 'reload')
    error.value = null
  } catch (e) {
    error.value = String(e)
  }
}

/**
 * フォームを開く（開いていれば閉じる）。欄の初期値は、入れた値があればそれ、無ければ SFC の
 * 隣の fixture（vue-preview が使ったもの）。**一覧（`inputs`）が無くても開く**: 入れた値のせいで
 * 描画が失敗し続けると一覧が届かないので、開けないと値を消す手段が無くなる（古い vue-preview も同じ）。
 */
async function toggleForm() {
  if (showForm.value) {
    showForm.value = false
    return
  }
  const s = served.value
  if (!s) return
  const list = inputs.value ?? { props: [], values: [], fixture: null }
  const sibling = list.fixture ? await readFixture(s.shell, joinPath(s.root, list.fixture, pathSep(s.shell))) : null
  fields.value = inputFields(list, formValues.value ?? sibling ?? {})
  showForm.value = true
}

async function applyForm() {
  const s = served.value
  if (!s) return
  const values = fixtureFromFields(fields.value)
  // 全部空なら「消す」と同じ（空の fixture を残すと、隣の fixture が使われなくなる）
  if (Object.keys(values).length === 0) return clearForm()
  try {
    await ensurePikeDir(s.shell, s.pikeBase, 'preview')
    await fsWriteFile(s.shell, s.fixture, `${JSON.stringify(values, null, 2)}\n`)
    formValues.value = values
    error.value = null
  } catch (e) {
    error.value = String(e)
    return
  }
  void render()
}

/** 入れた値を消して、SFC の隣の fixture（無ければプレースホルダ）で描き直す。 */
async function clearForm() {
  const s = served.value
  if (!s) return
  // 置いていなければ消すものが無い（無いファイルの削除は Windows のシェルでは失敗する）
  if (!formValues.value) {
    showForm.value = false
    return
  }
  try {
    await fsDelete(s.shell, s.fixture)
  } catch (e) {
    // 消えていないのに消えたように見せない（次に開いたときに黙って戻ってくる）
    error.value = String(e)
    return
  }
  formValues.value = null
  showForm.value = false
  void render()
}

const { onSaved } = usePreviewRefresh({
  view,
  served,
  affects: (rel, s) => affectsVuePreview(rel, s.rel, deps),
  refresh: () => void render(),
})

const message = computed(() => view.hiddenNotice.value || error.value)

defineExpose({ onSaved })
</script>

<template>
  <PreviewFrame ref="frame" :mobile="mobile" :message="message" :error="!!error">
    <template #bar>
      <div v-if="rendering || warnings.length || canFill || formValues" class="vue-preview-bar">
        <span v-if="rendering" class="vue-preview-status">
          <LoaderCircle :size="12" class="spin" />{{ t('vuePreview.renderingShort') }}
        </span>
        <button v-if="warnings.length" class="vue-preview-link" @click="showWarnings = !showWarnings">
          <AlertTriangle :size="12" />{{ t('vuePreview.warnings', { count: warnings.length }) }}
        </button>
        <span class="vue-preview-spacer" />
        <span v-if="formValues" class="vue-preview-status">{{ t('vuePreview.usingValues') }}</span>
        <button v-if="canFill || formValues" class="vue-preview-link" @click="toggleForm">
          <SlidersHorizontal :size="12" />{{ t('vuePreview.fillValues') }}
        </button>
      </div>
      <ul v-if="showWarnings && warnings.length" class="vue-preview-warning-list">
        <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
      </ul>
      <VuePreviewForm
        v-if="showForm"
        v-model:fields="fields"
        :has-values="!!formValues"
        @apply="applyForm"
        @clear="clearForm"
        @close="showForm = false"
      />
    </template>
  </PreviewFrame>
</template>

<style scoped>
.vue-preview-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 2px 8px;
  font-size: 11px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
}

.vue-preview-spacer {
  flex: 1;
}

.vue-preview-status,
.vue-preview-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.vue-preview-link {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.vue-preview-warning-list {
  margin: 0;
  padding: 4px 8px 4px 24px;
  max-height: 30%;
  overflow-y: auto;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
  user-select: text;
}
</style>
