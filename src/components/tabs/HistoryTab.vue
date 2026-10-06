<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useDiffWrap } from '../../composables/useDiffWrap'
import { useI18n } from '../../i18n'
import { isBinaryDiff, parseDiff, parseRename } from '../../lib/diffParser'
import { formatLineRange } from '../../lib/format'
import { commitTooltip, relativeDate } from '../../lib/paths'
import { gitDiffCommit, gitLogFile, gitLogFileLines } from '../../lib/tauri'
import { useProjectStore } from '../../stores/project'
import { useTabStore } from '../../stores/tabs'
import type { GitLogEntry } from '../../types/git'
import type { HistoryTab } from '../../types/tab'
import WrapToggle from '../editor/WrapToggle.vue'
import IgnoreSpaceToggle from '../IgnoreSpaceToggle.vue'
import RenameNote from '../RenameNote.vue'

const { t } = useI18n()

const props = defineProps<{ tabId: string }>()
const tabStore = useTabStore()
const projectStore = useProjectStore()

const tab = computed(() => tabStore.tabs.find((t): t is HistoryTab => t.id === props.tabId && t.kind === 'history'))

const entries = ref<GitLogEntry[]>([])
const loading = ref(true)
const selectedHash = ref<string | null>(null)
const diffText = ref('')
const diffLoading = ref(false)
const searchQuery = ref('')

const filteredEntries = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return entries.value
  return entries.value.filter((e) => {
    return e.hash.toLowerCase().includes(q) || e.message.toLowerCase().includes(q) || e.author.toLowerCase().includes(q)
  })
})

const lineRangeLabel = computed(() => {
  const range = tab.value?.lineRange
  return range ? formatLineRange(range) : ''
})

const countLabel = computed(() => {
  const total = entries.value.length
  if (!searchQuery.value.trim()) return t('history.count', { total: String(total) })
  return t('history.countFiltered', { filtered: String(filteredEntries.value.length), total: String(total) })
})

const diffLines = computed(() => parseDiff(diffText.value))

/** diff タブと同じく、名前が変わったことはヘッダから拾って上に出す（#306）。 */
const renamed = computed(() => parseRename(diffText.value))

const copiedHash = ref<string | null>(null)

function copyHash(hash: string) {
  navigator.clipboard.writeText(hash)
  copiedHash.value = hash
  setTimeout(() => {
    copiedHash.value = null
  }, 1500)
}

/**
 * 空白の違いを無視して見るか（#453。git の `-w`）。**コミットを選び直しても保つ**: 履歴を
 * 順にたどるあいだ、選ぶたびに押し直すことになる。タブを開き直すと戻る。
 */
const ignoreSpace = ref(false)
const { wrapOn, toggleWrap } = useDiffWrap()
/** 取得が失敗して、`diffText` に入っているのが差分ではなくエラーの文面のとき。 */
const diffFailed = ref(false)
/** 飛んでいる取得のうち、最後のものだけを採る（切り替えと選び直しが重なる）。 */
let diffSeq = 0

async function selectCommit(hash: string) {
  const project = projectStore.currentProject
  if (!project || !tab.value) return
  const seq = ++diffSeq
  selectedHash.value = hash
  diffLoading.value = true
  let text: string
  let failed = false
  try {
    // **基準はこのタブの root**（#321）。`activeRoot` を読むと、worktree を切り替えたあとに
    // コミットを選んだとき、別の worktree の差分が同じ題名で出る。
    text = await gitDiffCommit(tab.value.root, project.shell, hash, tab.value.filePath, ignoreSpace.value)
  } catch (e) {
    text = String(e)
    failed = true
  }
  if (seq !== diffSeq) return
  diffText.value = text
  diffFailed.value = failed
  diffLoading.value = false
}

/** 選んでいるコミットの差分を、切り替えた見方で取り直す。 */
function toggleIgnoreSpace() {
  ignoreSpace.value = !ignoreSpace.value
  if (selectedHash.value) void selectCommit(selectedHash.value)
}

/**
 * 空白を無視した結果、出す行が無くなったか。**リネームより先に見る**（空白だけが違う
 * リネームは `-w` でヘッダだけになり、「内容は同じです」と出すと嘘になる。diff タブの
 * `emptyState` と同じ順）。**バイナリはその前に外す**（あちらも先に見る）: 行を持たない
 * だけで、空白以外が同じとは言えない。
 */
const onlySpaceChanged = computed(
  () => ignoreSpace.value && !diffFailed.value && diffLines.value.length === 0 && !isBinaryDiff(diffText.value),
)

onMounted(async () => {
  const project = projectStore.currentProject
  if (!project || !tab.value) return
  try {
    const range = tab.value.lineRange
    if (range) {
      entries.value = await gitLogFileLines(
        tab.value.root,
        project.shell,
        tab.value.filePath,
        range.start,
        range.end,
        200,
      )
    } else {
      entries.value = await gitLogFile(tab.value.root, project.shell, tab.value.filePath, 200)
    }
  } catch {
    entries.value = []
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="history-tab">
    <div v-if="!tab" class="status">{{ t('history.notFound') }}</div>
    <template v-else>
      <div class="history-header">
        <span v-if="lineRangeLabel" class="range-badge">{{ lineRangeLabel }}</span>
        <input
          v-model="searchQuery"
          class="search-input"
          type="text"
          :placeholder="t('history.searchPlaceholder')"
        />
        <span class="count">{{ countLabel }}</span>
      </div>
      <!-- Top: commit list -->
      <div class="commit-list">
        <div v-if="loading" class="status">{{ t('common.loading') }}</div>
        <div v-else-if="!entries.length" class="status">{{ t('history.noHistory') }}</div>
        <div v-else-if="!filteredEntries.length" class="status">{{ t('history.noMatch') }}</div>
        <div
          v-for="entry in filteredEntries"
          :key="entry.hash"
          class="commit-row"
          :class="{ selected: entry.hash === selectedHash }"
          :title="commitTooltip(entry)"
          @click="selectCommit(entry.hash)"
        >
          <span class="c-hash" :title="copiedHash === entry.hash ? t('common.copied') : 'Click to copy'" @click.stop="copyHash(entry.hash)">{{ copiedHash === entry.hash ? t('common.copied') : entry.hash.slice(0, 7) }}</span>
          <span class="c-msg">{{ entry.message.split('\n')[0] }}</span>
          <span class="c-author">{{ entry.author }}</span>
          <span class="c-date">{{ relativeDate(entry.date) }}</span>
        </div>
      </div>

      <!--
        Bottom: diff view。**スクロールする領域（`.diff-area`）の外に 1 枚かぶせる**: 見方の
        ボタン（#453）をスクロール領域の中に置くと、差分と一緒に流れていく。
      -->
      <div class="diff-pane">
      <!-- 差分の見方。コミットを選ぶ前から押せる（次に選ぶものから効く）。 -->
      <div class="hover-toolbar" :class="{ prominent: ignoreSpace }">
        <IgnoreSpaceToggle :on="ignoreSpace" @toggle="toggleIgnoreSpace" />
        <WrapToggle :on="wrapOn" @toggle="toggleWrap" />
      </div>
      <div class="diff-area">
        <div v-if="!selectedHash" class="status">{{ t('history.selectCommit') }}</div>
        <div v-else-if="diffLoading" class="status">{{ t('history.loadingDiff') }}</div>
        <template v-else>
          <RenameNote v-if="renamed" :from="renamed.from" :to="renamed.to" />
          <div v-if="onlySpaceChanged" class="status">{{ t('diff.noChangesBesidesSpace') }}</div>
          <div v-else-if="!diffLines.length && renamed" class="status">{{ t('diff.renameOnly') }}</div>
          <div v-else-if="!diffLines.length && diffText" class="status">{{ diffText.slice(0, 200) }}</div>
          <table v-else class="diff-table" :class="{ wrap: wrapOn }">
            <tbody>
              <tr v-for="(row, i) in diffLines" :key="i" class="diff-row">
                <td class="line-num" :class="row.left.type">{{ row.left.num ?? "" }}</td>
                <td class="line-content" :class="row.left.type">{{ row.left.segments[0]?.text ?? '' }}</td>
                <td class="line-num" :class="row.right.type">{{ row.right.num ?? "" }}</td>
                <td class="line-content" :class="row.right.type">{{ row.right.segments[0]?.text ?? '' }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.history-tab {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-primary);
}

.history-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  flex: 0 0 auto;
}

.range-badge {
  font-family: monospace;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  background: var(--accent);
  color: var(--on-accent);
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  min-width: 0;
  background: var(--bg-primary);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 3px 8px;
  font-size: 12px;
  outline: none;
}

.search-input:focus {
  border-color: var(--accent);
}

.count {
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.commit-list {
  flex: 0 0 40%;
  overflow-y: auto;
  border-bottom: 2px solid var(--border);
}

.commit-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
}

.commit-row:hover {
  background: var(--tab-hover-bg);
}

.commit-row.selected {
  background: var(--bg-tertiary);
}

.c-hash {
  font-family: monospace;
  font-size: 11px;
  color: var(--accent);
  flex-shrink: 0;
  width: 56px;
  cursor: pointer;
  border-radius: 2px;
}

.c-hash:hover {
  background: var(--accent);
  color: var(--on-accent);
}

.c-msg {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.c-author {
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.c-date {
  font-size: 10px;
  color: var(--text-secondary);
  flex-shrink: 0;
  width: 60px;
  text-align: right;
}

/* 下半分の入れ物。重ねるボタン（`.hover-toolbar`）の位置の基準で、ここをなぞると濃くなる。 */
.diff-pane {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.diff-area {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.status {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 60px;
  color: var(--text-secondary);
  font-size: 13px;
}

.diff-table {
  width: 100%;
  border-collapse: collapse;
  font-family: "PlemolJP Console NF", "Cascadia Code", "Fira Code", monospace;
  font-size: 12px;
  line-height: 1.5;
  table-layout: fixed;
}

.diff-row { height: 20px; }

.line-num {
  width: 40px;
  min-width: 40px;
  padding: 0 6px;
  text-align: right;
  color: var(--text-secondary);
  opacity: 0.5;
  user-select: none;
  border-right: 1px solid var(--border);
  font-size: 11px;
}

.line-content {
  padding: 0 8px;
  white-space: pre;
  overflow: hidden;
}

/* 折り返し（#453）。OFF のあいだ、欄からはみ出す行は切れる（左右の欄を持つ表なので、
   横にスクロールさせると右の欄が画面の外へ出る。`git-diff.md` の #297）。 */
.diff-table.wrap .line-content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.line-content:nth-child(2) { border-right: 1px solid var(--border); }

.del { background: rgba(244, 71, 71, 0.1); }
.add { background: rgba(78, 201, 176, 0.1); }
.hunk { background: rgba(0, 122, 204, 0.08); color: var(--accent); }
.empty { background: var(--bg-secondary); }
</style>
