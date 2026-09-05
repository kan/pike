<script setup lang="ts">
/**
 * 作業領域（#308）。タブバー（`TabBar.vue`）とタブの中身を、1 つまたは 2 つのペインに
 * 分けて置く。
 *
 * **タブの中身は「タブ 1 枚 = `Teleport` 1 つ」で行き先だけを変える。** `to` を差し替えると
 * `moveTeleport` が DOM ノードを移すだけで、コンポーネントは作り直されない。ペインごとに
 * `v-for` を分けると、タブが反対側へ移った瞬間に別の vnode になって `onUnmounted` が走り、
 * xterm の `dispose()` でセッションごと消える（#264 でパークしたタブを生かしている前提が
 * 丸ごと崩れる）。**行き先はセレクタ文字列で指す**: 要素の ref は mount 後にしか埋まらない
 * ので、分割を開いた最初の描画で `v-if` が false になり、そこでも同じ作り直しが起きる。
 *
 * 全タブをマウントしたまま `v-show` で出し分けるのは従来どおり（#264）。違うのは条件で、
 * 分割すると「見えているタブ」は 2 枚になる（`tabStore.isTabVisible`）。
 */

import { computed, defineAsyncComponent, onMounted, ref, useTemplateRef, watch } from 'vue'
import { useDragResize } from '../../composables/useDragResize'
import { useI18n } from '../../i18n'
import { actionChord } from '../../lib/shortcuts'
import { loadJson, saveJson } from '../../lib/storage'
import { useProjectStore } from '../../stores/project'
import { useTabStore } from '../../stores/tabs'
import type { PaneId, Tab } from '../../types/tab'
import { PANES } from '../../types/tab'
import TerminalTab from '../tabs/TerminalTab.vue'
import TabBar from './TabBar.vue'

const DiffTab = defineAsyncComponent(() => import('../tabs/DiffTab.vue'))
const EditorTab = defineAsyncComponent(() => import('../tabs/EditorTab.vue'))
const PreviewTab = defineAsyncComponent(() => import('../tabs/PreviewTab.vue'))
const HistoryTab = defineAsyncComponent(() => import('../tabs/HistoryTab.vue'))
const DockerLogsTab = defineAsyncComponent(() => import('../tabs/DockerLogsTab.vue'))
const SettingsTab = defineAsyncComponent(() => import('../tabs/SettingsTab.vue'))
const AgentStatusTab = defineAsyncComponent(() => import('../tabs/AgentStatusTab.vue'))
const ManualTab = defineAsyncComponent(() => import('../tabs/ManualTab.vue'))
const IssueTab = defineAsyncComponent(() => import('../tabs/IssueTab.vue'))
const PdfTab = defineAsyncComponent(() => import('../tabs/PdfTab.vue'))

/**
 * 種別ごとの中身（#308）。**`Record<Tab['kind'], …>` なので、種別を足したら型エラーで
 * 気付く**（`lib/tabIcons.ts` の `TAB_KIND_ICONS` と同じ形）。以前は種別ごとに 11 個の
 * `v-for` が並んでいて、足し忘れても型は通った。
 */
const TAB_COMPONENTS: Record<Tab['kind'], unknown> = {
  terminal: TerminalTab,
  editor: EditorTab,
  preview: PreviewTab,
  pdf: PdfTab,
  diff: DiffTab,
  history: HistoryTab,
  'docker-logs': DockerLogsTab,
  settings: SettingsTab,
  'agent-status': AgentStatusTab,
  manual: ManualTab,
  issue: IssueTab,
}

const { t } = useI18n()
const tabStore = useTabStore()
const projectStore = useProjectStore()

/** 描くペイン。分割していなければ左だけ。 */
const panes = computed<PaneId[]>(() => (tabStore.split ? [...PANES] : ['left']))

/** Teleport の行き先。ペインの div の id で、`paneOf` が解釈した側を指す。 */
function paneTarget(tab: Tab): string {
  return `#pane-${tabStore.paneOf(tab)}`
}

/**
 * タブの中身を描き始めてよいか。**最初の描画では待つ**: Vue は子を先に作ってから親を
 * DOM へ挿入するので、その時点の `document.querySelector('#pane-left')` は何も見つけ
 * られない（`.tab-pane` ごと、まだ document に繋がっていない）。
 *
 * **待つのはマウントの 1 回だけで、以降は決して false に戻さない。** ここが false に
 * なるとタブが丸ごと unmount され、xterm がセッションごと消える。分割を開いたときの
 * `#pane-right` は、この時点で既に document にあるので待つ必要がない（同じ更新の中で
 * 前方のペインが先に挿入され、`Teleport` は `to` の差し替えとして扱われる＝
 * `moveTeleport` が DOM ノードを移すだけで、コンポーネントは生きたまま）。
 */
const teleportReady = ref(false)
onMounted(() => {
  teleportReady.value = true
})

// 数えるだけなので `tabsIn`（2 本を繋いだ新しい配列を作る）は通さない。
function isPaneEmpty(pane: PaneId): boolean {
  return tabStore.pinnedTabsIn(pane).length + tabStore.unpinnedTabsIn(pane).length === 0
}

/**
 * 分割の比率（#308）。**マシンに依存する見た目**なので `project.json` ではなく
 * localStorage に持つ（`fileTree` の展開状態や `tasks` の折り畳みと同じ扱い）。
 * プロジェクトごとに覚える（画面の使い方はプロジェクトで変わる）。
 */
const SPLIT_MIN = 0.15
const SPLIT_MAX = 0.85
const splitKey = computed(() => `pike:split-ratio:${projectStore.currentProject?.id ?? 'global'}`)
const splitRatio = ref(loadJson<number>(splitKey.value, 0.5))
const rowRef = useTemplateRef<HTMLElement>('rowRef')

// プロジェクトを切り替えたら、そのプロジェクトのぶんを読み直す（キーが変わるだけでは
// 値が付いてこない）。ウィンドウは同じなので、タブと同じく捨てずに差し替える。
watch(splitKey, (key) => {
  splitRatio.value = clampRatio(loadJson<number>(key, 0.5))
})

const splitStyle = computed(() => ({ '--split': `${clampRatio(splitRatio.value) * 100}%` }))

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value))
}

/** 押した時点の比率と、ドラッグ中の確定前の比率（`onEnd` でこれを採る）。 */
let dragStartRatio = 0
let dragRatio = 0

/**
 * 分割線のドラッグ。**動かしているあいだは Vue を通さない**（`DiffTab` の分割線と同じ）:
 * カスタムプロパティ 1 つを書き換えたいだけなのに、`:style` に載せると mousemove ごとに
 * このコンポーネントの render が走り、全タブぶんの vnode を作り直すことになる。
 *
 * 直書きした値を消す必要はない。確定値を `splitRatio` に入れれば、同じ属性へ `:style` が
 * 上書きする（先に消すと、書き戻るまでの 1 フレームだけ元の幅に戻って見える）。
 */
const { start: startSplitDrag } = useDragResize({
  onStart: () => {
    dragStartRatio = clampRatio(splitRatio.value)
    dragRatio = dragStartRatio
  },
  // `onMove` が受け取るのは**押した位置からの差**（`useDragResize` の規約）。
  onMove: (dx) => {
    const width = rowRef.value?.clientWidth ?? 0
    if (width <= 0) return
    dragRatio = clampRatio(dragStartRatio + dx / width)
    rowRef.value?.style.setProperty('--split', `${dragRatio * 100}%`)
  },
  onEnd: () => {
    splitRatio.value = dragRatio
    saveJson(splitKey.value, splitRatio.value)
  },
})

/** ダブルクリックで半々に戻す（`DiffTab` の分割線と同じ操作感）。 */
function resetSplit() {
  splitRatio.value = 0.5
  saveJson(splitKey.value, splitRatio.value)
}
</script>

<template>
  <div class="tab-pane">
    <div ref="rowRef" class="pane-row" :class="{ split: tabStore.split }" :style="splitStyle">
      <!--
        **ペインは 1 つのループで描く**（#308）。左右に書き写すと、足したものを片方だけ
        直す事故が起きる（切り出した直後、空表示の文言が既に左右で食い違っていた）。
      -->
      <template v-for="(pane, i) in panes" :key="pane">
        <!-- 分割線。位置は grid ではなく flex の並びで決まるので、幅を持つ要素として置く。 -->
        <div
          v-if="i > 0"
          class="drag-x-handle pane-splitter"
          data-testid="pane-splitter"
          @mousedown="startSplitDrag"
          @dblclick="resetSplit"
        />
        <!--
          **クリックで打鍵の行き先を渡す**（#308）。`capture` で受けるのは、中身
          （xterm・CodeMirror）が自分のマウス処理を持っているため。ここが唯一の
          「マウスからフォーカスを移す」経路で、キーボード側は `focusOtherPane`。
          **タブバーもこの内側**なので、そこから開いたタブは押した側のペインに入る。
        -->
        <div class="pane" :class="`pane-${pane}`" @mousedown.capture="tabStore.focusPane(pane)">
          <TabBar :pane="pane" />
          <div :id="`pane-${pane}`" class="pane-content">
            <div v-if="isPaneEmpty(pane)" class="empty-state">
              <template v-if="projectStore.currentProject">
                {{ t('app.emptyTerminal', { key: actionChord('newTerminal') }) }}
              </template>
              <template v-else>
                {{ t('app.emptyProject', { key: actionChord('projectSwitcher') }) }}
              </template>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!--
      タブの中身。**この位置には何も描かれない**（`Teleport` は元の場所にコメントノードしか
      残さない）ので、ペインの div より後ろに置いてよい。むしろ後ろでなければならない:
      `to` はパッチの時点で `querySelector` されるので、行き先が先に DOM へ入っている必要がある。
    -->
    <template v-if="teleportReady">
      <template v-for="tab in tabStore.tabs" :key="tab.id">
        <Teleport :to="paneTarget(tab)">
          <component
            :is="TAB_COMPONENTS[tab.kind]"
            :tab-id="tab.id"
            v-show="tabStore.isTabVisible(tab.id)"
          />
        </Teleport>
      </template>
    </template>
  </div>
</template>

<style scoped>
.tab-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow: hidden;
}

.pane-row {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

.pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

/* 分割していないときは左が全部を取る。分割したら `--split` のぶんだけ持ち、右が残りを取る
   （幅を両方に配ると、丸めの差で 1px の隙間が出る）。 */
.pane-left {
  flex: 1;
}

.pane-row.split > .pane-left {
  flex: 0 0 var(--split, 50%);
}

.pane-right {
  flex: 1;
  border-left: 1px solid var(--border);
}

/* カーソルとホバーの見た目は `theme.css` の `.drag-x-handle`（サイドバーの幅と diff の
   分割線で共有）。掴む幅はサイドバーのハンドルと同じ 6px。 */
.pane-splitter {
  flex: 0 0 6px;
}

/* タブの中身の入れ物。ほとんどのタブのルートが `position: absolute; inset: 0` なので、
   ここが containing block になる（分割しても、その計算はペインの中で閉じる）。 */
.pane-content {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-secondary);
  font-size: 14px;
  padding: 0 16px;
  text-align: center;
}
</style>
