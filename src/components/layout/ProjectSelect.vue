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
import { ChevronDown, FolderOpen, X } from 'lucide-vue-next'
import { computed, onUnmounted, ref } from 'vue'
import { useProjectAccent } from '../../composables/useProjectAccent'
import { useI18n } from '../../i18n'
import { actionChord } from '../../lib/shortcuts'
import { useProjectStore } from '../../stores/project'
import { useTabStore } from '../../stores/tabs'
import ColorDot from '../ColorDot.vue'
import ProjectIcon from '../ProjectIcon.vue'

const { t } = useI18n()
const projectStore = useProjectStore()
const tabStore = useTabStore()
const accent = useProjectAccent()

const open = ref(false)

/**
 * 行き先の一覧（#264 のチップ列と同じ中身）。**並びはタブを持ち始めた順で固定**し、選択で
 * 入れ替えない（押すたびに行き先が動くと狙えない）。一時プロジェクト（#230）は入れない:
 * 切り替えると破棄されるので、この一覧の約束（戻ればそのままある）を満たさない。
 */
const entries = computed(() => {
  const list = [...projectStore.heldProjects]
  // タブがまだ 1 つも無いプロジェクトも「現在地」として出す（並びの末尾）。
  const current = projectStore.currentProject
  if (current && !projectStore.isTransient && !list.some((p) => p.id === current.id)) list.push(current)
  return list
})

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

onUnmounted(() => window.removeEventListener('mousedown', closeMenu))
</script>

<template>
  <div v-if="projectStore.currentProject" class="project-select" :style="barStyle" @mousedown.stop>
    <button class="project-btn" :title="projectStore.currentProject.root" @click="toggle">
      <ProjectIcon :icon="projectStore.currentProject.icon" />
      <span class="project-name">{{ projectStore.currentProject.name }}</span>
      <ChevronDown :size="14" :stroke-width="2" class="chevron" />
    </button>
    <div v-if="open" class="project-menu popup-surface">
      <div
        v-for="entry in entries"
        :key="entry.id"
        class="menu-row"
        :class="{ current: entry.id === projectStore.currentProject.id }"
        :title="entry.root"
        @click="choose(entry.id)"
      >
        <ProjectIcon :icon="entry.icon" />
        <ColorDot :color="entry.color" />
        <span class="row-name">{{ entry.name }}</span>
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
      <div v-if="entries.length > 0" class="menu-divider" />
      <button class="menu-item" @click="openSwitcher">
        <FolderOpen :size="14" :stroke-width="2" />
        <span>{{ t('project.openSwitcher') }}</span>
        <span class="ctx-key">{{ actionChord('projectSwitcher') }}</span>
      </button>
    </div>
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
</style>
