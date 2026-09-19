<script setup lang="ts">
import { ChevronDown, ChevronRight, Columns2, Copy, ExternalLink, RefreshCw } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from '../../i18n'
import { type PatchFile, parsePatch } from '../../lib/commitPatch'
import { buildCommitLink } from '../../lib/gitRemote'
import { openUrlWithConfirm } from '../../lib/openUrl'
import { gitStatusColor, relativeDate } from '../../lib/paths'
import { gitCommitPatch, gitDiffCommit } from '../../lib/tauri'
import { useGitStore } from '../../stores/git'
import { useProjectStore } from '../../stores/project'
import { useStatusMessageStore } from '../../stores/statusMessage'
import { useTabStore } from '../../stores/tabs'
import type { CommitTab as CommitTabDef } from '../../types/tab'

/**
 * コミット 1 つの中身（#374）。上にメッセージ全文と作者・日時、下に全ファイルの差分を
 * 統合形式で縦に並べる。Git パネルのグラフ表示で行を押すと開く。
 *
 * **読み取り専用。** ファイルの見出しの「左右に並べて見る」は既存の diff タブ（1 ファイル
 * ぶん・文字単位の強調つき）を開く。こちらはコミット全体をひと目で読むための場所。
 */
const { t } = useI18n()
const props = defineProps<{ tabId: string }>()
const tabStore = useTabStore()
const projectStore = useProjectStore()
const gitStore = useGitStore()
const statusMessage = useStatusMessageStore()

const tab = computed(() => tabStore.tabs.find((x): x is CommitTabDef => x.id === props.tabId && x.kind === 'commit'))

const files = ref<PatchFile[]>([])
const truncated = ref(false)
const error = ref<string | null>(null)
const loading = ref(false)
/** 畳んでいるファイル（パス）。大きいファイルは最初から畳む。 */
const collapsed = ref(new Set<string>())
/** これより行の多いファイルは最初から畳む（全部を開くと数千行の DOM を一度に作る）。 */
const COLLAPSE_LINES = 400

const subject = computed(() => tab.value?.message.split('\n')[0] ?? '')
const body = computed(() => tab.value?.message.split('\n').slice(1).join('\n').trim() ?? '')
const commitLink = computed(() => (tab.value ? buildCommitLink(gitStore.remoteUrl, tab.value.hash) : null))
const totals = computed(() =>
  files.value.reduce((s, f) => ({ added: s.added + f.added, removed: s.removed + f.removed }), {
    added: 0,
    removed: 0,
  }),
)
const absoluteDate = computed(() => (tab.value ? new Date(tab.value.date).toLocaleString() : ''))

/** 取得は開いたときと更新ボタンのときだけ（コミットの中身は変わらない）。 */
async function load() {
  const def = tab.value
  const project = projectStore.currentProject
  if (!def || !project || loading.value) return
  loading.value = true
  try {
    const res = await gitCommitPatch(def.root, project.shell, def.hash, def.parent)
    files.value = parsePatch(res.patch)
    truncated.value = res.truncated
    collapsed.value = new Set(files.value.filter((f) => f.lines.length > COLLAPSE_LINES).map((f) => f.path))
    error.value = null
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

function toggle(path: string) {
  const next = new Set(collapsed.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  collapsed.value = next
}

/** 1 ファイルを既存の diff タブ（左右分割）で開く。取得は Git パネルと同じ経路。 */
async function openSideBySide(file: PatchFile) {
  const def = tab.value
  const project = projectStore.currentProject
  if (!def || !project) return
  try {
    const diff = await gitDiffCommit(def.root, project.shell, def.hash, file.path)
    tabStore.addDiffTab({ filePath: file.path, root: def.root, diff, commitHash: def.hash })
  } catch (e) {
    statusMessage.show({ text: String(e), variant: 'error', durationMs: 6000 })
  }
}

async function copyHash() {
  if (!tab.value) return
  try {
    await navigator.clipboard.writeText(tab.value.hash)
    statusMessage.show({ text: t('commitTab.hashCopied'), durationMs: 2000 })
  } catch (e) {
    statusMessage.show({ text: String(e), variant: 'error', durationMs: 6000 })
  }
}

onMounted(load)
</script>

<template>
  <div class="commit-tab">
    <div class="md-toolbar">
      <span class="commit-title">{{ subject }}</span>
      <button class="tool-btn" :title="t('commitTab.refresh')" :disabled="loading" @click="load">
        <RefreshCw :size="14" :class="{ spin: loading }" />
      </button>
      <button
        v-if="commitLink"
        class="tool-btn"
        :title="t('commitTab.openRemote', { label: commitLink.label })"
        @click="openUrlWithConfirm(commitLink.url)"
      >
        <ExternalLink :size="14" />
      </button>
    </div>

    <div v-if="tab" class="commit-scroll">
      <div class="commit-head">
        <div class="commit-meta">
          <button class="hash" :title="t('commitTab.copyHash')" @click="copyHash">
            <Copy :size="11" />{{ tab.hash.slice(0, 10) }}
          </button>
          <span>{{ tab.author }}</span>
          <span :title="absoluteDate">{{ relativeDate(tab.date) }}</span>
          <span v-if="tab.refs" class="refs">{{ tab.refs }}</span>
        </div>
        <div class="commit-subject">{{ subject }}</div>
        <pre v-if="body" class="commit-body">{{ body }}</pre>
        <div v-if="files.length" class="commit-stats">
          {{ t('commitTab.stats', { files: String(files.length) }) }}
          <span class="add-count">+{{ totals.added }}</span>
          <span class="del-count">-{{ totals.removed }}</span>
          <span v-if="!tab.parent" class="note">{{ t('commitTab.rootCommit') }}</span>
        </div>
      </div>

      <div v-if="error" class="commit-error">{{ error }}</div>
      <div v-else-if="loading && !files.length" class="commit-empty">{{ t('common.loading') }}</div>
      <div v-else-if="!files.length" class="commit-empty">{{ t('commitTab.noChanges') }}</div>

      <section v-for="file in files" :key="file.path" class="patch-file">
        <div class="file-head" @click="toggle(file.path)">
          <ChevronRight v-if="collapsed.has(file.path)" :size="14" />
          <ChevronDown v-else :size="14" />
          <span class="file-status" :style="{ color: gitStatusColor(file.status) }">{{ file.status }}</span>
          <span class="file-path" :title="file.path">
            <template v-if="file.oldPath">{{ file.oldPath }} → </template>{{ file.path }}
          </span>
          <span class="add-count">+{{ file.added }}</span>
          <span class="del-count">-{{ file.removed }}</span>
          <button
            v-if="file.status !== 'D' && !file.binary"
            class="tool-btn"
            :title="t('commitTab.sideBySide')"
            @click.stop="openSideBySide(file)"
          >
            <Columns2 :size="13" />
          </button>
        </div>
        <template v-if="!collapsed.has(file.path)">
          <div v-if="file.binary" class="patch-note">{{ t('commitTab.binary') }}</div>
          <div v-else-if="!file.lines.length" class="patch-note">{{ t('commitTab.noContentChange') }}</div>
          <table v-else class="patch-table">
            <tbody>
              <tr v-for="(line, i) in file.lines" :key="i" :class="line.type">
                <td class="num">{{ line.oldNum ?? '' }}</td>
                <td class="num">{{ line.newNum ?? '' }}</td>
                <td class="code">{{ line.text }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </section>

      <div v-if="truncated" class="commit-empty">{{ t('commitTab.truncated') }}</div>
    </div>
  </div>
</template>

<style scoped>
.commit-tab {
  --patch-font: "PlemolJP Console NF", "Cascadia Code", "Fira Code", monospace;
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
}

.commit-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-secondary);
}

.commit-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 16px 24px;
}

.commit-head {
  margin-bottom: 12px;
}

.commit-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--text-secondary);
}

.hash {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--patch-font);
  font-size: 11px;
  cursor: pointer;
}

.hash:hover {
  color: var(--text-primary);
  background: var(--tab-hover-bg);
}

.refs {
  font-size: 10px;
  font-weight: 600;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--accent);
  color: var(--on-accent);
}

.commit-subject {
  margin-top: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-active);
  word-break: break-word;
}

.commit-body {
  margin: 8px 0 0;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

.commit-stats {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-secondary);
}

.add-count {
  color: var(--git-add);
  font-size: 11px;
}

.del-count {
  color: var(--git-delete);
  font-size: 11px;
}

.note {
  font-style: italic;
}

.commit-error {
  color: var(--danger);
  font-size: 12px;
  white-space: pre-wrap;
}

.commit-empty {
  color: var(--text-secondary);
  font-size: 12px;
  padding: 12px 0;
}

.patch-file {
  border: 1px solid var(--border);
  border-radius: 4px;
  margin-bottom: 10px;
  overflow: hidden;
}

.file-head {
  position: sticky;
  top: -12px;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  cursor: pointer;
}

.file-status {
  font-family: var(--patch-font);
  font-weight: 600;
  width: 12px;
  flex-shrink: 0;
}

.file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.patch-note {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-secondary);
}

.patch-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--patch-font);
  font-size: 12px;
  line-height: 18px;
}

.num {
  width: 1%;
  min-width: 36px;
  padding: 0 6px;
  text-align: right;
  color: var(--text-secondary);
  opacity: 0.5;
  user-select: none;
  white-space: nowrap;
  vertical-align: top;
}

.code {
  padding: 0 8px;
  white-space: pre-wrap;
  word-break: break-all;
}

.add {
  background: rgba(78, 201, 176, 0.1);
}

.del {
  background: rgba(244, 71, 71, 0.1);
}

.hunk {
  background: rgba(0, 122, 204, 0.08);
  color: var(--accent);
}

.note .code {
  color: var(--text-secondary);
  font-style: italic;
}
</style>
