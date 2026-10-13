<script setup lang="ts">
/**
 * プロジェクトを別のウィンドウへ移すときの、行き先のメニュー（#469）。開閉は
 * `composables/useMoveProjectMenu.ts`、移動の段取りは `stores/project.ts` の `moveProject`。
 *
 * 並べるのは**プロジェクトを見せている他のウィンドウ**と「新しいウィンドウ」。ウィンドウは
 * 名前を持たないので、見せているプロジェクトの名前で呼ぶ（タスクバーのタイトルと同じ）。
 * 一覧は開くたびに Rust へ聞く（ウィンドウの増減はこのウィンドウからは見えない）。
 */
import { ExternalLink } from 'lucide-vue-next'
import { computed, nextTick, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { useAnchoredPopup } from '../composables/useAnchoredPopup'
import { useMoveProjectMenu } from '../composables/useMoveProjectMenu'
import { useI18n } from '../i18n'
import { useOverlay } from '../lib/overlay'
import { type ProjectWindow, projectWindowList } from '../lib/tauri'
import { useProjectStore } from '../stores/project'
import ColorDot from './ColorDot.vue'
import ProjectIcon from './ProjectIcon.vue'

const { t } = useI18n()
const projectStore = useProjectStore()
const { state, close } = useMoveProjectMenu()

const menuEl = useTemplateRef<HTMLElement>('menuEl')
const popup = useAnchoredPopup(menuEl)
const windows = ref<ProjectWindow[]>([])
/** 一覧が届いたか。届くまで描かない（空のメニューが一瞬出て、あとから行が増えるのを避ける）。 */
const ready = ref(false)
// 手前に浮くものは数える（#396。ブラウザのタブの子 webview を隠すため）。
useOverlay(() => state.value !== null)

const projectName = computed(() => {
  const id = state.value?.projectId
  return id ? (projectStore.findProject(id)?.name ?? id) : ''
})

/** 行に出す、そのウィンドウが見せているプロジェクト。一覧に無い id はそのまま名前にする。 */
function shownProject(win: ProjectWindow) {
  return projectStore.findProject(win.shown)
}

watch(state, async (opened) => {
  window.removeEventListener('mousedown', close)
  popup.reset()
  ready.value = false
  if (!opened) return
  windows.value = await projectWindowList().catch(() => [])
  // 聞いているあいだに閉じられた / 別のプロジェクトで開き直された。
  if (state.value !== opened) return
  ready.value = true
  await nextTick()
  const size = menuEl.value?.getBoundingClientRect()
  if (!size) return
  if (opened.anchor) await popup.placeNear(opened.anchor)
  else await popup.placeAt({ x: (window.innerWidth - size.width) / 2, y: window.innerHeight * 0.2 })
  // 他のメニューと同じ規約: 開いたあとに window の mousedown を once で張り、ルートが
  // 内側の mousedown を止める。
  window.addEventListener('mousedown', close, { once: true })
  // パレットから開いた人はキーボードで選ぶので、最初の行へフォーカスを渡す。
  menuEl.value?.querySelector('button')?.focus()
})

function move(target: string | null) {
  const id = state.value?.projectId
  close()
  if (id) void projectStore.moveProject(id, target)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
    return
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  e.preventDefault()
  const buttons = [...(menuEl.value?.querySelectorAll('button') ?? [])]
  if (buttons.length === 0) return
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const step = e.key === 'ArrowDown' ? 1 : -1
  buttons[(at + step + buttons.length) % buttons.length].focus()
}

onUnmounted(() => window.removeEventListener('mousedown', close))
</script>

<template>
  <!-- `body` へ出す（`ProjectSelect.vue` のチラ見と同じ理由: `.ui-zoom` の中だと
       `position: fixed` の基準がずれる）。 -->
  <Teleport to="body">
    <div
      v-if="state && ready"
      ref="menuEl"
      class="panel-ctx-menu popup-surface move-menu"
      :style="popup.style.value"
      @mousedown.stop
      @keydown="onKeydown"
    >
      <div class="move-title">{{ t('project.moveMenuTitle', { name: projectName }) }}</div>
      <button v-for="win in windows" :key="win.label" class="move-row" @click="move(win.label)">
        <ProjectIcon :icon="shownProject(win)?.icon" />
        <ColorDot :color="shownProject(win)?.color" />
        <span class="move-name">{{ shownProject(win)?.name ?? win.shown }}</span>
        <!-- 保持しているぶん。ウィンドウを見分ける手がかりで、行き先はウィンドウそのもの。 -->
        <span v-if="win.held.length > 0" class="move-more">{{ t('project.moveWindowMore', { n: win.held.length }) }}</span>
      </button>
      <div v-if="windows.length > 0" class="ctx-separator"></div>
      <button class="move-row" @click="move(null)">
        <ExternalLink :size="12" :stroke-width="2" />
        <span class="move-name">{{ t('project.moveNewWindow') }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.move-menu {
  min-width: 200px;
  max-width: 360px;
}

.move-title {
  padding: 4px 12px 6px;
  color: var(--text-secondary);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 器（`.panel-ctx-menu button`）は `display: block` なので、アイコンを並べる行だけ flex にする。 */
.move-menu .move-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  white-space: nowrap;
}

/* キーボードで選んでいる行。ホバーと同じ見た目にする（器の `:hover` と対）。 */
.move-menu .move-row:focus-visible {
  outline: none;
  background: var(--accent);
  color: var(--on-accent);
}

.move-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.move-more {
  flex-shrink: 0;
  opacity: 0.7;
  font-size: 11px;
}
</style>
