<script setup lang="ts">
/**
 * 「今どのプロジェクトを見ているか」の表示と、保持しているプロジェクトへの切替（#298）。
 *
 * **置き場所はサイドバーのパネルの開閉で変わる。** 開いていればサイドバーの最上部
 * （アイコン列とパネルにまたがる帯）、閉じていればタブバーの左。どちらも `SideBar.vue` /
 * `TabPane.vue` が `v-if` で出し分けるだけで、この部品は自分がどちらに居るかを知らない。
 * 畳んだサイドバーは 48px しかなく名前が読めないので、そこには置かない。
 *
 * #264 のチップ列（タブバー左に保持中のぶんを横並び）の置き換え。あれは保持している数だけ
 * 横幅を取ってタブを圧迫していたので、常に 1 つのボタンに畳んでプルダウンへ移した。
 */
import { ChevronDown, FolderOpen, Terminal, X } from 'lucide-vue-next'
import { computed, onUnmounted, ref, useTemplateRef } from 'vue'
import { useAnchoredPopup } from '../../composables/useAnchoredPopup'
import { useProjectAccent } from '../../composables/useProjectAccent'
import { peekTerminal, terminalLastOutputAt } from '../../composables/useTerminalPeek'
import { useI18n } from '../../i18n'
import { relativeTime } from '../../lib/paths'
import { actionChord } from '../../lib/shortcuts'
import { useProjectStore } from '../../stores/project'
import { useSettingsStore } from '../../stores/settings'
import { useTabStore } from '../../stores/tabs'
import ColorDot from '../ColorDot.vue'
import ProjectIcon from '../ProjectIcon.vue'

const { t } = useI18n()
const projectStore = useProjectStore()
const settingsStore = useSettingsStore()
const tabStore = useTabStore()
const accent = useProjectAccent()

const open = ref(false)

/**
 * 入力待ちのエージェントを抱えた、**保持中の**プロジェクト（#265）。今見ているものを
 * 数えないのは、そのぶんはタブの印が言っていて、ここに出しても行き先が今いる場所に
 * なるため。「保持中（＝今は見せていない）」の定義はストアの `parkedProjectIds` が持つ。
 *
 * 出典は `tabStore.awaitingProjectIds`（タブの印の集約）なので、切り替えて中を見れば
 * 勝手に下りる。ここで消す処理は持たない。
 */
const awaitingIds = computed(
  () => new Set(projectStore.parkedProjectIds.filter((id) => tabStore.awaitingProjectIds.has(id))),
)

// 行き先の一覧はストアの `heldProjects` をそのまま出す（並びも、一時プロジェクトを
// 入れない理由も、あちらの `heldIds` の doc が正本）。以前ここにあった「現在地を末尾に
// 足す」フォールバックは、タブを 1 つも持たないプロジェクトも保持に載るようになった
// ぶん要らなくなった（#301）。

/**
 * バーの下地。**プロジェクトカラーを設定していればそれを敷く**（サイドバーのアイコン列と
 * 同じ色なので、展開しているあいだ 2 つで 1 つの帯に見える）。未設定なら `--tab-hover-bg`:
 * サイドバー（`--bg-secondary`）ともタブバー（`--bg-tertiary`）とも違う 1 段だけ持ち上げた
 * 面で、どちらに置いても周囲から浮く（既定値は CSS 側）。
 *
 * ホバーは `--popup-lift-color`（ダークは白 / ライトは黒）を少し混ぜる。色を上書きせず
 * 混ぜるだけなので、プリセットの黄色から紫までどの下地でも同じ向きに変化する。
 */
const barStyle = computed(() =>
  accent.bg.value ? { '--project-bar-bg': accent.bg.value, '--project-bar-fg': accent.fg.value } : {},
)

function toggle() {
  if (open.value) {
    closeMenu()
  } else {
    // **先に他のポップアップを閉じる。** この帯は常に見えているので、歯車メニューや
    // StatusBar のドロップダウンを開いたまま押されうる。ルートで内側の mousedown を
    // 止める（下）ぶん、それらの「外側の mousedown で閉じる」が発火しないため、合成した
    // mousedown を 1 回投げて肩代わりする（`main.ts` の `closeOverlays` と同じ手）。
    window.dispatchEvent(new MouseEvent('mousedown'))
    open.value = true
    // 他のメニュー（ColorSelect / SideBar の歯車 / StatusBar）と同じ規約: 開いたときに
    // window の mousedown を once で張り、ルート要素が内側の mousedown を止める。
    setTimeout(() => window.addEventListener('mousedown', closeMenu, { once: true }))
  }
}

function closeMenu() {
  open.value = false
  window.removeEventListener('mousedown', closeMenu)
  // **チラ見も一緒に閉じる（#319）。** アイコンは一覧の中にあるので、ホバーしたまま
  // 閉じると**アンカーごと消えて `mouseleave` が来ない**（消えたノードへの配送は
  // ブラウザ任せ）。放っておくとポップアップが浮いたまま残り（`pointer-events: none`
  // なので押して消せない）、500ms のポーリングも回り続ける。
  stopPeek()
}

function choose(id: string) {
  closeMenu()
  if (id === projectStore.currentProject?.id) return
  void projectStore.openProject(id, 'switch')
}

function release(id: string) {
  closeMenu()
  void projectStore.releaseProject(id)
}

function openSwitcher() {
  closeMenu()
  projectStore.toggleSwitcher()
}

// --- ターミナルのチラ見（#319） ---

/** 出す行数。プルダウンの横に出すので、画面を圧迫せずに「何をしているか」が読める長さ。 */
const PEEK_LINES = 15
/** ホバー中の取り直し。`snapshot` は 15 行の `translateToString` なので軽い。 */
const PEEK_INTERVAL_MS = 500

/**
 * ターミナルを持つプロジェクト（アイコンを出すかの判定）。
 *
 * **行の `v-if` から `terminalForProject` を呼ばないこと。** あれは `tabs`（パーク中も
 * 含む全部）を舐めるので、行ごとに O(タブ数)。しかもテンプレートの関数呼び出しは
 * 再描画のたびに走るので、**下のポーリングが 500ms ごとに全行ぶんの走査を起こす**。
 * computed なら `tabs` が変わったときだけ組み直せばよく、行あたりは `has` の 1 回で済む。
 */
const projectsWithTerminal = computed(() => {
  const ids = new Set<string>()
  for (const tab of tabStore.tabs) {
    if (tab.kind === 'terminal' && tab.projectId) ids.add(tab.projectId)
  }
  return ids
})

const peekEl = useTemplateRef<HTMLElement>('peekEl')
const peek = useAnchoredPopup(peekEl)
/** チラ見しているプロジェクト。null なら出していない。 */
const peekFor = ref<string | null>(null)
/**
 * 見せている中身。**行と時刻を 1 つに持つ**（常に一緒に書き換わり、一緒に読まれる）。
 *
 * 時刻は文字列で持つ。`relativeTime` の結果を computed に置くと、元の値が変わらない
 * 限り再計算されず、**時間が経っても「たった今」のまま固まる**。
 */
const peekContent = ref<{ lines: string[]; age: string | null }>({ lines: [], age: null })
let peekTimer: ReturnType<typeof setInterval> | null = null

function refreshPeek() {
  const projectId = peekFor.value
  const tabId = projectId ? tabStore.terminalForProject(projectId) : null
  if (!tabId) {
    peekContent.value = { lines: [], age: null }
    return
  }
  const at = terminalLastOutputAt(tabId)
  peekContent.value = { lines: peekTerminal(tabId, PEEK_LINES), age: at ? relativeTime(at) : null }
}

async function startPeek(projectId: string, event: MouseEvent) {
  const anchor = (event.currentTarget as HTMLElement).getBoundingClientRect()
  peekFor.value = projectId
  refreshPeek()
  if (peekTimer) clearInterval(peekTimer)
  peekTimer = setInterval(refreshPeek, PEEK_INTERVAL_MS)
  // **横に出す**（`placeBesideAnchor`）。上下に出すと一覧そのものに重なって、どの行の
  // ものか分からなくなる。
  await peek.placeBeside(anchor)
}

function stopPeek() {
  peekFor.value = null
  peek.reset()
  if (peekTimer) {
    clearInterval(peekTimer)
    peekTimer = null
  }
}

onUnmounted(() => {
  window.removeEventListener('mousedown', closeMenu)
  if (peekTimer) clearInterval(peekTimer)
})
</script>

<template>
  <div v-if="projectStore.currentProject" class="project-select" :style="barStyle" @mousedown.stop>
    <button class="project-btn" :title="projectStore.currentProject.root" @click="toggle">
      <ProjectIcon :icon="projectStore.currentProject.icon" />
      <span class="project-name">{{ projectStore.currentProject.name }}</span>
      <!-- 入力待ちの印（#265）は `▾` に重ねる。押せば行き先の一覧が出るので、印と
           そこへ行く手段が同じ場所にある。 -->
      <span class="chevron-wrap">
        <ChevronDown :size="14" :stroke-width="2" class="chevron" />
        <span v-if="awaitingIds.size > 0" class="awaiting-dot" :title="t('agent.awaitingProject')" />
      </span>
    </button>
    <div v-if="open" class="project-menu popup-surface">
      <div
        v-for="entry in projectStore.heldProjects"
        :key="entry.id"
        class="menu-row"
        :class="{ current: entry.id === projectStore.currentProject.id }"
        :title="entry.root"
        @click="choose(entry.id)"
      >
        <ProjectIcon :icon="entry.icon" />
        <ColorDot :color="entry.color" />
        <span class="row-name">{{ entry.name }}</span>
        <span v-if="awaitingIds.has(entry.id)" class="awaiting-dot" :title="t('agent.awaitingProject')" />
        <!--
          ターミナルのチラ見（#319）。**アイコンだけをホバー対象にする**: 行全体だと、
          切り替えようとして通っただけでポップアップが出る。押したときは行と同じ
          （そのプロジェクトへ切り替える）なので、クリックは止めない。
        -->
        <span
          v-if="projectsWithTerminal.has(entry.id)"
          class="row-peek"
          :title="t('project.peek')"
          @mouseenter="startPeek(entry.id, $event)"
          @mouseleave="stopPeek"
        >
          <Terminal :size="12" :stroke-width="2" />
        </span>
        <!--
          解除は現在地以外だけ（#264）。現在地に出すと「今見ているプロジェクトのタブを
          全部閉じる」になり、保持の解除とは別の操作になる。

          **「保持中」の印は出さない**: この一覧はそもそも保持しているものしか並ばないので、
          全行に同じ印が付くだけになる。
        -->
        <button
          v-if="entry.id !== projectStore.currentProject.id"
          class="row-close"
          :title="tabStore.hasTabsFor(entry.id) ? t('project.release') : t('project.forget')"
          @click.stop="release(entry.id)"
        >
          <X :size="12" :stroke-width="2" />
        </button>
      </div>
      <!-- 区切るものが無いとき（起動直後に一時プロジェクトだけ、など）は線を出さない。 -->
      <div v-if="projectStore.heldProjects.length > 0" class="menu-divider" />
      <button class="menu-item" @click="openSwitcher">
        <FolderOpen :size="14" :stroke-width="2" />
        <span>{{ t('project.openSwitcher') }}</span>
        <span class="ctx-key">{{ actionChord('projectSwitcher') }}</span>
      </button>
    </div>
    <!--
      チラ見のポップアップ（#319）。**`body` へ出す。** この部品は `SideBar` / `TabBar` の
      `.ui-zoom` の中に置かれ、UI のフォントサイズを既定から変えると `zoom` が 1 でなくなる。
      そうすると `position: fixed` の基準がその祖先になり、`left` / `top` も測った矩形も
      倍率ぶんずれる（`TabBar.vue` の管理者メニューが「.ui-zoom の外に置く」としているのと
      同じ罠）。`pointer-events: none` なのは、マウスがアイコンの上にあるあいだだけ出るため。

      **`Teleport` はルート要素の中に置く。** 外に出すとテンプレートのルートが 2 つになり、
      親（`SideBar` / `TabBar`）が渡している `class` と `style` が自動継承されなくなる。
      描く先は body のままなので、置き場所を中にしても目的は変わらない。
    -->
    <Teleport to="body">
      <div v-if="peekFor" ref="peekEl" class="peek-popup popup-surface" :style="peek.style.value">
        <div v-if="peekContent.age" class="peek-head">{{ peekContent.age }}</div>
        <!--
          **ターミナルと同じフォントで描く**（設定画面のプレビューと同じ形）。既定の
          `monospace` のままだと、罫線・ブロック文字・全角の幅が xterm と揃わず、
          TUI の画面が崩れて出る。
        -->
        <pre
          v-if="peekContent.lines.length > 0"
          class="peek-body"
          :style="{ fontFamily: settingsStore.fontFamily }"
        >{{ peekContent.lines.join('\n') }}</pre>
        <div v-else class="peek-empty">{{ t('project.peekEmpty') }}</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.project-select {
  position: relative;
  min-width: 0;
  /* プロジェクトカラーが無いときの下地。サイドバー（`--bg-secondary`）ともタブバー
     （`--bg-tertiary`）とも違う 1 段持ち上げた面なので、どちらに置いても周囲から浮く。
     **不透明な値を持つ**: 透過（#162）の合成は下の `.project-btn` が 1 回だけ行うので、
     ここで `--tab-hover-bg`（合成済み）を入れると alpha が二重にかかる。 */
  --project-bar-bg: rgb(var(--tab-hover-bg-rgb));
  --project-bar-fg: var(--text-primary);
}

/* **高さと文字はタブに揃える**（`--tabbar-height`・12px）。タブバーに置いたときに隣の
   タブと 1 行に並び、サイドバーに置いたときもタブバーと同じ高さの帯になる。 */
.project-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  height: var(--tabbar-height);
  padding: 0 10px;
  border: none;
  /* 周囲と同じく `--surface-alpha` で合成する（#162）。ここだけ不透明に塗ると、透過や
     アクリルのときにバーだけ板になる。 */
  background: color-mix(in srgb, var(--project-bar-bg) calc(var(--surface-alpha) * 100%), transparent);
  color: var(--project-bar-fg);
  font-size: 12px;
  cursor: pointer;
}

/* 下地を差し替えず `--popup-lift-color`（ダークは白 / ライトは黒）を混ぜる。プリセットの
   黄色から紫までどの色の上でも同じ向きに変化する。 */
.project-btn:hover {
  background: color-mix(
    in srgb,
    color-mix(in srgb, var(--project-bar-bg) 88%, var(--popup-lift-color)) calc(var(--surface-alpha) * 100%),
    transparent
  );
}

.project-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

/* 下地がプロジェクトカラーのときは名前と同じ色にする（灰のままだと黄色や明るい緑の上で
   コントラストが落ちる）。 */
.chevron {
  flex-shrink: 0;
  color: var(--project-bar-fg);
  opacity: 0.7;
}

/* `▾` の右上に重ねる（#265）。**枠を下地の色で描く**ので、プロジェクトカラーの上でも
   矢印と溶け合わずに読める。 */
.chevron-wrap {
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.chevron-wrap .awaiting-dot {
  position: absolute;
  top: -1px;
  right: -3px;
  border: 1px solid var(--project-bar-bg);
}

.awaiting-dot {
  flex-shrink: 0;
  box-sizing: content-box;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
}

.project-menu {
  position: absolute;
  top: 100%;
  left: 0;
  /* ボタンの幅いっぱいに開き、狭いときだけ 220px まで広がる（中身が折り返さない下限）。
     上限を置くのは、パネルを広げたときにメニューだけが間延びしないため。 */
  min-width: max(100%, 220px);
  max-width: 360px;
  margin-top: 2px;
  padding: 4px 0;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  z-index: 1000;
}

/* **`box-sizing` を明示する。** このリポジトリはグローバルなリセットを置いていないので、
   `<div>` の行は `content-box` のままで `width: 100%` に padding が上乗せされ、右へ 20px
   はみ出す（`<button>` の行は UA 既定が border-box なのではみ出さず、行によって幅が違う
   という形で出る）。 */
.menu-row,
.menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  width: 100%;
  padding: 5px 10px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}

.menu-row:hover,
.menu-item:hover {
  background: var(--tab-hover-bg);
}

.menu-row.current {
  background: var(--tab-active-bg);
}

.row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 押せる大きさを確保する（アイコン 12px のままだと当たり判定が小さい）。**行の右端に
   貼り付けない**: `.row-name` の `flex: 1` で右へ寄るので、行の padding のぶんだけ内側に入る。 */
.row-close {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.row-close:hover {
  background: var(--danger);
  color: var(--text-active);
}

.menu-divider {
  height: 1px;
  margin: 4px 0;
  background: var(--border);
}

/* --- ターミナルのチラ見（#319） --- */

.row-peek {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  color: var(--text-secondary);
}

.row-peek:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.peek-popup {
  position: fixed;
  z-index: 1001; /* プルダウン（1000）の上 */
  max-width: 60vw;
  padding: 4px 0;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  /* マウスはアイコンの上にあるあいだだけ出るので、この矩形は当たり判定を持たない。 */
  pointer-events: none;
}

.peek-head {
  padding: 0 8px 2px;
  color: var(--text-secondary);
  font-size: 11px;
}

.peek-body {
  margin: 0;
  padding: 0 8px;
  /* font-family はターミナルの設定から流し込む（テンプレート側） */
  font-size: 11px;
  line-height: 1.35;
  white-space: pre;
  overflow: hidden;
  color: var(--text-primary);
}

.peek-empty {
  padding: 0 8px;
  color: var(--text-secondary);
  font-size: 11px;
  font-style: italic;
}
</style>
