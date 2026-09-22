<script setup lang="ts">
import { FolderOpen, Globe } from 'lucide-vue-next'
import { computed, nextTick, ref, watch } from 'vue'
import { useAppActions } from '../composables/useAppActions'
import { useI18n } from '../i18n'
import { chordLabel, hasMod } from '../lib/keys'
import { useOverlay } from '../lib/overlay'
import { fuzzyMatch } from '../lib/paths'
import { openGlobalWindow } from '../lib/tauri'
import { globalMode } from '../lib/window'
import { useProjectStore } from '../stores/project'
import { useSettingsStore } from '../stores/settings'
import { useTabStore } from '../stores/tabs'
import ColorDot from './ColorDot.vue'
import ProjectIcon from './ProjectIcon.vue'

const { t } = useI18n()
const projectStore = useProjectStore()
// 手前に浮くものは数える（#396。ブラウザのタブの子 webview を隠すため）。
useOverlay(() => projectStore.showSwitcher)
const settings = useSettingsStore()

/**
 * フォルダを選んで開く（#373。実体は `useAppActions`）。**登録するかは設定
 * （`registerDirectory`）に従う**ので（#230）、ここに「登録する」ボタンは置かない。
 *
 * 以前はここに 7 項目の新規作成フォームがあったが、ルートを決めればプラットフォーム・
 * distro・シェルは推測できるので落とした。登録だけを頼む入口はプロジェクトパネル。
 */
const { openDirectory: onOpenDirectory } = useAppActions()

function enterGlobalMode() {
  projectStore.showSwitcher = false
  if (!globalMode.value && !projectStore.currentProject) {
    // Cold-start quick feed (project-less, non-global window): turn THIS window
    // into global mode. Start with one terminal on the configured global shell,
    // mirroring how a dedicated global terminal window opens.
    globalMode.value = true
    useTabStore().addTerminalTab({ shell: settings.globalShell })
  } else {
    // Opened over an active project, or already a global window: flipping in
    // place would drop the project context, so open a separate global window
    // and leave this one untouched.
    openGlobalWindow()
  }
}

// --- Search mode ---
const query = ref('')
/**
 * 選んでいるプロジェクト。**index ではなく id で持つ**（#354）。並びが最近開いた順に
 * なったので、**開いているあいだに一覧が並び替わる**ことがある（別のウィンドウが
 * プロジェクトを切り替えると `lastOpened` の更新が broadcast で届く）。index で持つと、
 * そのとき選択が別のプロジェクトへずれる。`null` は「まだ選んでいない」。
 */
const selectedId = ref<string | null>(null)
const inputRef = ref<HTMLInputElement>()

/**
 * 保持中のプロジェクト（#264）。**先頭に固定して印を出す**: 切り替えのコストが下がったぶん、
 * 行き先を選ぶコストが目立つようになる。2〜3 件の行き来に 40 件の一覧を探させない。
 */
const parkedIds = computed(() => new Set(projectStore.parkedProjectIds))

/**
 * 出す順は**最近開いた順**（#354）。絞り込みでもその順のままにする（fuzzy の得点で
 * 並べ替えない: 打つほど並びが変わると、位置で覚えて押せない）。
 */
const filtered = computed(() => {
  const q = query.value.trim()
  const list = q ? projectStore.recentProjects.filter((p) => fuzzyMatch(p.name, q)) : projectStore.recentProjects
  if (parkedIds.value.size === 0) return list
  // 絞り込み中も並べ替える（保持中を探しているときほど、先頭に居てほしい）。
  // `sort` は安定なので、保持中どうし・それ以外どうしは最近開いた順のまま。
  return [...list].sort((a, b) => Number(parkedIds.value.has(b.id)) - Number(parkedIds.value.has(a.id)))
})

/**
 * 描画と移動のための位置。**まだ選んでいない（`null`）ときと、選んだものが一覧から
 * 消えたときの既定も、ここが唯一の出典**（#354）。
 *
 * 既定は**今いるプロジェクトを飛ばした先頭**。最近開いた順では先頭が現在地になるので、
 * そのまま Enter を押しても何も起きない行（`openProject` が弾く）を既定にしてしまう。
 * Alt+Tab と同じで、既定の行き先は**1 つ前**。
 */
const selectedIdx = computed(() => {
  const list = filtered.value
  const i = list.findIndex((p) => p.id === selectedId.value)
  if (i !== -1) return i
  const next = list.findIndex((p) => p.id !== projectStore.currentProject?.id)
  return next === -1 ? 0 : next
})

/** Open the picked project: global-mode windows stay project-less, so the
 *  project always goes to its own window there. */
function selectProject(id: string, newWindow: boolean) {
  projectStore.showSwitcher = false
  // 今いるプロジェクトを選んだときに何もしないのは `openProject` の持ち物（#354）。
  projectStore.openProject(id, newWindow || globalMode.value ? 'window' : 'switch')
}

// --- Lifecycle ---
watch(query, () => {
  selectedId.value = null
})

watch(
  () => projectStore.showSwitcher,
  (show) => {
    if (show) {
      // Global-mode windows skip project restore at startup, so the list may
      // not be loaded yet when the switcher is first opened there.
      if (projectStore.projects.length === 0) projectStore.loadProjects()
      // Mark the ones this machine has no copy of, like the project panel does.
      projectStore.checkRoots().catch(() => {})
      query.value = ''
      selectedId.value = null
      nextTick(() => inputRef.value?.focus())
    }
  },
)

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    projectStore.showSwitcher = false
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    // 端は「添字が外れる」ことで自然に止まる（境界を手で書くと上下で二重に持つ）。
    const next = filtered.value[selectedIdx.value + (e.key === 'ArrowDown' ? 1 : -1)]
    if (next) selectedId.value = next.id
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    const selected = filtered.value[selectedIdx.value]
    if (selected) {
      // 新しいウィンドウで開く。修飾キーは mac だけ Cmd（`lib/keys.ts`）。
      selectProject(selected.id, hasMod(e))
    }
    return
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="projectStore.showSwitcher" class="switcher-overlay ui-zoom" @mousedown.self="projectStore.showSwitcher = false">
      <div class="switcher popup-surface" data-testid="project-switcher">
        <input
          ref="inputRef"
          v-model="query"
          class="switcher-input"
          :placeholder="t('projectSwitcher.placeholder')"
          @keydown="onKeyDown"
        />

        <!-- Project list -->
        <div class="switcher-list">
          <div
            v-for="(project, i) in filtered"
            :key="project.id"
            class="switcher-item"
            :class="{ selected: i === selectedIdx, active: project.id === projectStore.currentProject?.id }"
            @click="selectProject(project.id, false)"
            @mouseenter="selectedId = project.id"
          >
            <span class="item-name">
              <ProjectIcon :icon="project.icon" /><ColorDot :color="project.color" />{{ project.name }}
            </span>
            <span v-if="projectStore.missingRoots.has(project.id)" class="missing-tag" :title="t('project.missingHint')">
              {{ t('project.missing') }}
            </span>
            <span v-else-if="parkedIds.has(project.id)" class="parked-tag" :title="t('project.parkedHint')">
              {{ t('project.parked') }}
            </span>
            <span class="item-root">{{ project.root }}</span>
          </div>
          <div v-if="filtered.length === 0 && query" class="switcher-empty">
            {{ t('projectSwitcher.noMatch') }}
          </div>
        </div>

        <div class="switcher-footer">
          <div class="footer-hints">
            <span v-if="globalMode" class="hint">{{ t('projectSwitcher.enterOpenWindow') }}</span>
            <template v-else>
              <span class="hint">{{ t('projectSwitcher.enterSwitch') }}</span>
              <span class="hint">{{ t('projectSwitcher.ctrlEnterWindow', { key: chordLabel('Mod+Enter') }) }}</span>
            </template>
          </div>
          <div class="footer-buttons">
            <button class="footer-btn" @click="enterGlobalMode">
              <Globe :size="14" :stroke-width="2" />{{ t('projectSwitcher.openGlobal') }}
            </button>
            <button class="footer-btn" data-testid="switcher-open-directory" @click="onOpenDirectory">
              <FolderOpen :size="14" :stroke-width="2" />{{ t('projectSwitcher.openDirectory') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.switcher-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  justify-content: center;
  padding-top: 80px;
}

.switcher {
  width: 480px;
  max-height: 420px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  align-self: flex-start;
}

.switcher-input {
  padding: 10px 14px;
  border: none;
  border-bottom: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-active);
  font-size: 14px;
  outline: none;
}

.switcher-input::placeholder {
  color: var(--text-secondary);
}

.switcher-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.switcher-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  cursor: pointer;
}

.switcher-item.selected {
  background: var(--accent);
}

.switcher-item.active .item-name::after {
  content: " *";
  color: var(--accent);
}

.switcher-item.selected.active .item-name::after {
  color: var(--on-accent);
}

.item-name {
  font-size: 13px;
  color: var(--text-primary);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.switcher-item.selected .item-name {
  color: var(--on-accent);
}

.switcher-item.selected .missing-tag,
.switcher-item.selected .parked-tag {
  color: var(--on-accent);
}

.item-root {
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.switcher-item.selected .item-root {
  color: var(--on-accent-muted);
}

.switcher-empty {
  padding: 16px 14px;
  color: var(--text-secondary);
  font-size: 13px;
  text-align: center;
}

.switcher-footer {
  border-top: 1px solid var(--border);
  padding: 6px;
}

.footer-hints {
  display: flex;
  gap: 12px;
  padding: 2px 8px 4px;
}

.hint {
  font-size: 11px;
  color: var(--text-secondary);
}

.footer-buttons {
  display: flex;
  gap: 6px;
  /* The labels do not fit one row at every UI zoom, and a label broken mid-word
     reads worse than a second row. */
  flex-wrap: wrap;
}

.footer-btn {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  white-space: nowrap;
  padding: 8px;
  border: 1px dashed var(--border);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
}

.footer-btn:hover {
  color: var(--text-active);
  border-color: var(--accent);
  background: var(--bg-tertiary);
}

</style>
