<script setup lang="ts">
import { Copy, ExternalLink, RefreshCw } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from '../../i18n'
import { type PatchFile, parsePatch, patchFilesByPath } from '../../lib/commitPatch'
import { buildCommitLink } from '../../lib/gitRemote'
import { absoluteDate, relativeDate } from '../../lib/paths'
import { gitCommitPatch } from '../../lib/tauri'
import { useGitStore } from '../../stores/git'
import { useProjectStore } from '../../stores/project'
import { useStatusMessageStore } from '../../stores/statusMessage'
import { useTabStore } from '../../stores/tabs'
import type { CommitTab as CommitTabDef } from '../../types/tab'
import PatchFileRow from '../PatchFileRow.vue'
import PatchSplit from '../PatchSplit.vue'

/**
 * コミット 1 つの中身（#374、#396 で 4 分割に）。Git パネルのグラフ表示で行を押すと開く。
 * 分割と右の差分は `PatchSplit.vue`（作業中の変更のタブ #526 と共有）。
 *
 * **メッセージの 1 行目に見出しの様式を当てない**（#396）。件名と本文は 1 つの文章で、
 * git 自身も 1 行目を特別な書式として扱わない。太く大きくすると、本文の 1 行目だけが
 * 見出しに見える。
 *
 * **読み取り専用。** ファイルの見出しの「左右に並べて見る」は既存の diff タブ（文字単位の
 * 強調つき）を開く。こちらはコミット全体をひと目で読むための場所。
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
/** 右に出しているファイル（パス）。取得のたびに先頭へ戻す。 */
const selectedPath = ref<string | null>(null)
/**
 * 空白の違いを無視して見るか（#453。git の `-w`）。ファイルを選び直しても保つ。タブを
 * 開き直すと戻る。
 */
const ignoreSpace = ref(false)
/**
 * 空白を無視して取り直した差分（パス → ファイル）。初めて切り替えたときに取る。
 *
 * **ファイルの一覧（`files`）とは別に持つ。** `-w` を付けると、空白だけが違うファイルは
 * 出力から丸ごと消える（ヘッダも出ない）。一覧をこちらから作ると、切り替えた瞬間に
 * ファイルが一覧から消え、選んでいたものも見失う。一覧と件数は元の差分のまま、右の行だけを
 * 差し替える。
 */
const spaceFiles = ref<Map<string, PatchFile> | null>(null)

const selected = computed(() => {
  const file = files.value.find((f) => f.path === selectedPath.value) ?? null
  if (!file || !ignoreSpace.value || !spaceFiles.value) return file
  // こちらに居ないファイルは、空白以外に変更が無い。
  return { ...file, lines: spaceFiles.value.get(file.path)?.lines ?? [] }
})

const message = computed(() => tab.value?.message.trim() ?? '')
const subject = computed(() => tab.value?.message.split('\n')[0] ?? '')
const commitLink = computed(() => (tab.value ? buildCommitLink(gitStore.remoteUrl, tab.value.hash) : null))
const totals = computed(() =>
  files.value.reduce((s, f) => ({ added: s.added + f.added, removed: s.removed + f.removed }), {
    added: 0,
    removed: 0,
  }),
)
const dateTitle = computed(() => (tab.value ? absoluteDate(tab.value.date) : ''))

/** 取得は開いたときと更新ボタンのときだけ（コミットの中身は変わらない）。 */
async function load() {
  const def = tab.value
  const project = projectStore.currentProject
  if (!def || !project || loading.value) return
  loading.value = true
  try {
    // 空白を無視した側も、見ているなら一緒に取り直す（見ていなければ次に切り替えたときに
    // 取る）。**2 本を並べて取り、同じところで書く**: 順に取ると、あいだに空白込みの行が
    // 一度描かれてから差し替わる。
    //
    // **そちらの失敗でタブ全体をエラーにしない**（通常の差分は取れている）。見方を戻して
    // 知らせる。戻さないと、ボタンは押された見た目なのに中身は無視していない差分になる。
    const spaced = ignoreSpace.value
      ? fetchSpaceFiles().catch((e: unknown) => {
          statusMessage.show({ text: String(e), variant: 'error', durationMs: 6000 })
          return null
        })
      : null
    const [res, space] = await Promise.all([gitCommitPatch(def.root, project.shell, def.hash, def.parent), spaced])
    files.value = parsePatch(res.patch)
    // 取り直したら先頭のファイルを出す。**ここが `files` を書く唯一の場所**なので、
    // watcher を挟まずに並べて書く（初回も更新ボタンも `load()` を通る）。
    selectedPath.value = files.value[0]?.path ?? null
    truncated.value = res.truncated
    error.value = null
    spaceFiles.value = space
    if (!space) ignoreSpace.value = false
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

/** 空白を無視した差分を取り寄せる（#453。パス → ファイル）。失敗は投げる。 */
async function fetchSpaceFiles(): Promise<Map<string, PatchFile> | null> {
  const def = tab.value
  const project = projectStore.currentProject
  if (!def || !project) return null
  const res = await gitCommitPatch(def.root, project.shell, def.hash, def.parent, true)
  return patchFilesByPath(res.patch)
}

/** 飛んでいる切り替え。二度押しで取得を重ねない。 */
let togglingSpace = false

/**
 * 空白の違いを無視するかを切り替える。**取り寄せてから見方を変える**（先に変えると、
 * 取れるまでのあいだ全ファイルが「空白以外の変更はありません」に見える）。
 */
async function toggleIgnoreSpace() {
  if (togglingSpace) return
  togglingSpace = true
  try {
    if (!ignoreSpace.value && !spaceFiles.value) spaceFiles.value = await fetchSpaceFiles()
    // 取れなかった（タブが無い）なら変えない。戻す側はいつでも通す。
    if (ignoreSpace.value || spaceFiles.value) ignoreSpace.value = !ignoreSpace.value
  } catch (e) {
    statusMessage.show({ text: String(e), variant: 'error', durationMs: 6000 })
  } finally {
    togglingSpace = false
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
  <div class="commit-tab" data-testid="commit-tab">
    <div class="md-toolbar">
      <span class="commit-title">{{ subject }}</span>
      <button class="tool-btn" :title="t('commitTab.refresh')" :disabled="loading" @click="load">
        <RefreshCw :size="14" :class="{ spin: loading }" />
      </button>
      <button
        v-if="commitLink"
        class="tool-btn"
        :title="t('commitTab.openRemote', { label: commitLink.label })"
        @click="tabStore.addBrowserTab(commitLink.url)"
      >
        <ExternalLink :size="14" />
      </button>
    </div>

    <PatchSplit
      v-if="tab"
      :file="selected"
      :ignore-space="ignoreSpace"
      :empty-text="t('commitTab.selectFile')"
      @toggle-ignore-space="toggleIgnoreSpace"
    >
      <!-- 左上：メタとメッセージ。 -->
      <template #head>
        <div class="commit-head selectable">
          <div class="commit-meta">
            <button class="hash" :title="t('commitTab.copyHash')" @click="copyHash">
              <Copy :size="11" />{{ tab.hash.slice(0, 10) }}
            </button>
            <span>{{ tab.author }}</span>
            <span :title="dateTitle">{{ relativeDate(tab.date) }}</span>
            <span v-if="tab.refs" class="refs">{{ tab.refs }}</span>
          </div>
          <pre class="commit-message">{{ message }}</pre>
        </div>
      </template>

      <!-- 左下：変更されたファイルの一覧。 -->
      <template #files>
        <div class="files-head">
          <span>{{ t('commitTab.files') }}</span>
          <template v-if="files.length">
            <span class="file-count">{{ t('commitTab.stats', { files: String(files.length) }) }}</span>
            <span class="add-count">+{{ totals.added }}</span>
            <span class="del-count">-{{ totals.removed }}</span>
          </template>
          <span v-if="!tab.parent" class="note">{{ t('commitTab.rootCommit') }}</span>
        </div>
        <div v-if="error" class="patch-error selectable">{{ error }}</div>
        <div v-else-if="loading && !files.length" class="patch-empty">{{ t('common.loading') }}</div>
        <div v-else-if="!files.length" class="patch-empty">{{ t('commitTab.noChanges') }}</div>
        <PatchFileRow
          v-for="file in files"
          :key="file.path"
          :status="file.status"
          :path="file.path"
          :old-path="file.oldPath"
          :added="file.added"
          :removed="file.removed"
          :selected="file.path === selectedPath"
          @click="selectedPath = file.path"
        />
        <div v-if="truncated" class="patch-empty">{{ t('commitTab.truncated') }}</div>
      </template>
    </PatchSplit>
  </div>
</template>

<style scoped>
.commit-tab {
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

.commit-head {
  padding: 10px 12px;
}

.commit-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
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
  font-family: "PlemolJP Console NF", "Cascadia Code", "Fira Code", monospace;
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

/* **1 行目に見出しの様式を当てない**（#396）。件名と本文は 1 つの文章。 */
.commit-message {
  margin: 8px 0 0;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
