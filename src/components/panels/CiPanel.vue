<script setup lang="ts">
import { Bot, ChevronDown, ChevronRight, CircleCheck, CircleMinus, CircleSlash, CircleX, Loader } from 'lucide-vue-next'
import { computed, ref, useTemplateRef, watch } from 'vue'
import { useAnchoredPopup } from '../../composables/useAnchoredPopup'
import { injectToTerminal } from '../../composables/useTerminalInject'
import { useI18n } from '../../i18n'
import { cancelCiRun, rerunCiRun } from '../../lib/ciActions'
import { ciAgentPrompt } from '../../lib/ciPrompt'
import { openUrlWithConfirm } from '../../lib/openUrl'
import { useOverlay } from '../../lib/overlay'
import { relativeDate } from '../../lib/paths'
import { useCiStore } from '../../stores/ci'
import { useProjectStore } from '../../stores/project'
import { useSidebarStore } from '../../stores/sidebar'
import { useTabStore } from '../../stores/tabs'
import type { CiJob, CiProvider, CiRun, CiState } from '../../types/ci'

const { t } = useI18n()
const sidebar = useSidebarStore()
const ciStore = useCiStore()
const projectStore = useProjectStore()
const tabStore = useTabStore()

// 取得の契機は issue パネルと同じ（開いたとき・プロジェクトを切り替えたとき・使えるように
// なったとき・CI のタブを切り替えたとき）。理由は `IssuesPanel.vue` の同じ watcher が正本。
// 実行中の run があるあいだのポーリングは、ストアが自分で回す。
watch(
  [() => sidebar.activePanel, () => projectStore.currentProject?.id, () => ciStore.visible, () => ciStore.provider],
  ([panel, , visible]) => {
    if (panel === 'ci' && visible) void ciStore.ensureLoaded()
  },
  { immediate: true },
)

/** タブに出す名前。固有名なので訳さない。 */
const PROVIDER_LABEL: Record<CiProvider, string> = { github: 'GitHub Actions', circleci: 'CircleCI' }

/** 状態のアイコンと文言。**色を付けるのは成功と失敗だけ**（ほかは結果ではないので注意を引かない）。 */
const STATE_ICON = {
  running: Loader,
  success: CircleCheck,
  failure: CircleX,
  cancelled: CircleSlash,
  skipped: CircleMinus,
} as const
const STATE_LABEL = {
  running: 'ci.stateRunning',
  success: 'ci.stateSuccess',
  failure: 'ci.stateFailure',
  cancelled: 'ci.stateCancelled',
  skipped: 'ci.stateSkipped',
} as const satisfies Record<CiState, string>

type Row =
  | { kind: 'run'; key: string; run: CiRun; meta: string; tooltip: string; expanded: boolean }
  | { kind: 'job'; key: string; job: CiJob; label: string }
  | { kind: 'note'; key: string; text: string; error: boolean }

/**
 * run ごとの整形（2 段目の文字列とツールチップ）。**入力は一覧そのもの**で、絞り込みにも
 * 開閉にも依存させない（理由は `IssuesPanel.vue` の `formatted`）。
 */
const formatted = computed(() => {
  const map = new Map<string, { meta: string; tooltip: string }>()
  for (const run of ciStore.runs) {
    const since = relativeDate(run.createdAt)
    map.set(run.id, {
      meta: [run.workflow, run.branch, since].filter(Boolean).join(' · '),
      tooltip: [
        run.title,
        [run.workflow, t(STATE_LABEL[run.state])].filter(Boolean).join(' · '),
        [run.branch, run.sha, run.event].filter(Boolean).join(' · '),
        since,
      ]
        .filter(Boolean)
        .join('\n'),
    })
  }
  return map
})

/**
 * job の行の名前。**ワークフローが複数ある run だけ、ワークフロー名を前に付ける**（CircleCI）。
 * 1 本しか無いときは run の 2 段目に同じ名前が出ているので、繰り返さない。
 */
function jobRows(run: CiRun, jobs: CiJob[]): Row[] {
  const grouped = new Set(jobs.map((j) => j.group)).size > 1
  return jobs.map((job) => ({
    kind: 'job',
    key: `${run.id}/${job.id}`,
    job,
    label: grouped && job.group ? `${job.group} / ${job.name}` : job.name,
  }))
}

/** 描く行。開いた run の下に、その job（取得中・失敗・0 件のときは 1 行の注記）を並べる。 */
const rows = computed<Row[]>(() =>
  ciStore.filtered.flatMap((run): Row[] => {
    const f = formatted.value.get(run.id)
    if (!f) return []
    const entry = ciStore.jobsOf(run.id)
    const head: Row = { kind: 'run', key: run.id, run, ...f, expanded: !!entry }
    if (!entry) return [head]
    const note = (text: string, error = false): Row => ({ kind: 'note', key: `${run.id}/note`, text, error })
    // 取り直しに失敗しても、読めていた job は残す（その上に理由を出す）。
    const body = entry.jobs ? jobRows(run, entry.jobs) : []
    if (entry.error) return [head, note(entry.error, true), ...body]
    if (!entry.jobs) return [head, note(t('common.loading'))]
    return body.length > 0 ? [head, ...body] : [head, note(t('ci.noJobs'))]
  }),
)

const emptyMessage = computed(() => {
  if (rows.value.length > 0) return null
  if (ciStore.loading) return t('common.loading')
  // 失敗しているときは黙る（エラー帯の下に「実行はありません」を並べない）。
  if (ciStore.error) return null
  return t(ciStore.runs.length === 0 ? 'ci.empty' : 'ci.noMatch')
})

/**
 * 行のクリックで CI のページをブラウザのタブで開く（issue パネルと同じく確認は挟まない）。
 * **ページを持たない run は行を開く**（CircleCI で、ワークフローがまだ 1 本も無いとき）。
 */
function open(run: CiRun) {
  if (run.url) tabStore.addBrowserTab(run.url)
  else ciStore.toggleExpanded(run)
}

function openJob(job: CiJob) {
  if (job.url) tabStore.addBrowserTab(job.url)
}

/** 「この CI の失敗を調べて直して」をターミナルのエージェントへ送る。文面は `lib/ciPrompt.ts`。 */
function askAgent(run: CiRun) {
  injectToTerminal(ciAgentPrompt(run))
}

/** 同じ文面をクリップボードへ（文字列の流し込みが効かないエージェント向け）。 */
function copyPrompt(run: CiRun) {
  navigator.clipboard.writeText(ciAgentPrompt(run)).catch(() => {})
}

// 行の右クリックメニュー。作りは `IssuesPanel.vue` と同じ（測ってから置く・閉じてから実行）。
const ctxRun = ref<CiRun | null>(null)
useOverlay(() => ctxRun.value !== null)
const { style: ctxStyle, placeAt: placeCtx, reset: resetCtx } = useAnchoredPopup(useTemplateRef<HTMLElement>('ctxEl'))

async function openCtx(e: MouseEvent, run: CiRun) {
  e.preventDefault()
  ctxRun.value = run
  resetCtx()
  await placeCtx({ x: e.clientX, y: e.clientY })
  window.addEventListener('mousedown', closeCtx, { once: true })
}

function closeCtx() {
  ctxRun.value = null
  resetCtx()
}

function runCtx(action: (run: CiRun) => void) {
  const run = ctxRun.value
  closeCtx()
  if (run) action(run)
}

/**
 * メニューに出す操作。**再実行は、渡す id がある run にだけ出す**（実行する側が読むのと同じ
 * 配列なので、「押せるのに対象が無い」が起きない）。実行中の run は再実行できず、終わった run は
 * 中止できない。
 */
const ctxActions = computed(() => {
  const run = ctxRun.value
  if (!run) return null
  const done = run.state !== 'running'
  return {
    rerun: done && run.rerunIds.length > 0,
    rerunFailed: run.state === 'failure' && run.rerunFailedIds.length > 0,
    cancel: !done,
    fix: run.state === 'failure',
  }
})
</script>

<template>
  <div class="ci-panel" data-testid="ci-panel">
    <!-- 条件をそのまま言う（状態を推測して出し分けない。`IssuesPanel.vue` と同じ）。 -->
    <div v-if="!ciStore.visible" class="empty">{{ t('ci.unavailable') }}</div>
    <template v-else>
      <!-- 両方の CI を使うリポジトリだけ、タブで切り替える。 -->
      <div v-if="ciStore.available.length > 1" class="panel-tabs provider-tabs">
        <button
          v-for="p in ciStore.available"
          :key="p"
          class="panel-tab"
          :class="{ active: ciStore.provider === p }"
          :data-testid="`ci-provider-${p}`"
          @click="ciStore.setProvider(p)"
        >
          {{ PROVIDER_LABEL[p] }}
        </button>
      </div>
      <input
        v-model="ciStore.filter"
        class="panel-filter"
        type="text"
        :placeholder="t('ci.filterPlaceholder')"
        spellcheck="false"
      />
      <div v-if="ciStore.error" class="panel-error-strip selectable">{{ ciStore.error }}</div>
      <div v-if="emptyMessage" class="empty">{{ emptyMessage }}</div>
      <template v-for="row in rows" :key="row.key">
        <div
          v-if="row.kind === 'run'"
          class="ci-run"
          :title="row.tooltip"
          @click="open(row.run)"
          @contextmenu="openCtx($event, row.run)"
        >
          <span class="tree-chevron ci-caret" @click.stop="ciStore.toggleExpanded(row.run)">
            <ChevronDown v-if="row.expanded" :size="12" :stroke-width="2" />
            <ChevronRight v-else :size="12" :stroke-width="2" />
          </span>
          <component
            :is="STATE_ICON[row.run.state]"
            class="ci-state"
            :class="[row.run.state, { spin: row.run.state === 'running' }]"
            :size="14"
            :stroke-width="2"
          />
          <div class="ci-text">
            <div class="ci-title">{{ row.run.title }}</div>
            <div class="ci-meta">{{ row.meta }}</div>
          </div>
          <!-- ホバーで出る 🤖 は失敗した run だけ（調べる対象が無い行には出さない）。 -->
          <button
            v-if="row.run.state === 'failure'"
            class="row-action"
            :title="t('ci.askFix')"
            @click.stop="askAgent(row.run)"
          >
            <Bot :size="13" :stroke-width="2" />
          </button>
        </div>
        <div
          v-else-if="row.kind === 'job'"
          class="ci-job"
          :class="{ link: !!row.job.url }"
          :title="`${row.label}\n${t(STATE_LABEL[row.job.state])}`"
          @click="openJob(row.job)"
        >
          <component
            :is="STATE_ICON[row.job.state]"
            class="ci-state"
            :class="[row.job.state, { spin: row.job.state === 'running' }]"
            :size="12"
            :stroke-width="2"
          />
          <span class="ci-job-name">{{ row.label }}</span>
        </div>
        <div v-else class="ci-note" :class="{ error: row.error, selectable: row.error }">{{ row.text }}</div>
      </template>

      <Teleport to="body">
        <div
          v-if="ctxRun && ctxActions"
          ref="ctxEl"
          class="panel-ctx-menu popup-surface"
          :style="ctxStyle"
          @mousedown.stop
        >
          <template v-if="ctxRun.url">
            <button @click="runCtx(open)">{{ t('ci.openBrowserTab') }}</button>
            <!-- 外部ブラウザへ出るので確認を挟む（外部 URL を開く規約、#311）。 -->
            <button @click="runCtx((r) => r.url && openUrlWithConfirm(r.url))">{{ t('ci.openInBrowser') }}</button>
          </template>
          <template v-if="ctxActions.fix">
            <div v-if="ctxRun.url" class="ctx-separator"></div>
            <button @click="runCtx(askAgent)">{{ t('ci.askFix') }}</button>
            <button @click="runCtx(copyPrompt)">{{ t('ci.copyFixPrompt') }}</button>
          </template>
          <!-- 状態を変える操作。どれも確認を挟む（`lib/ciActions.ts`）。 -->
          <div
            v-if="(ctxRun.url || ctxActions.fix) && (ctxActions.rerun || ctxActions.rerunFailed || ctxActions.cancel)"
            class="ctx-separator"
          ></div>
          <button v-if="ctxActions.rerun" :disabled="ciStore.acting" @click="runCtx((r) => rerunCiRun(r, false))">
            {{ t('ci.rerun') }}
          </button>
          <button v-if="ctxActions.rerunFailed" :disabled="ciStore.acting" @click="runCtx((r) => rerunCiRun(r, true))">
            {{ t('ci.rerunFailed') }}
          </button>
          <button v-if="ctxActions.cancel" class="danger" :disabled="ciStore.acting" @click="runCtx(cancelCiRun)">
            {{ t('ci.cancel') }}
          </button>
        </div>
      </Teleport>
    </template>
  </div>
</template>

<style scoped>
/* スクロールはサイドバーの `.panel-content` に任せる（自分で持つと二重になる）。 */
.ci-panel {
  padding: 4px 0;
}

/* issue パネルの `.kind-tabs` と同じ打ち消し（同じ変数で組むこと）。 */
.provider-tabs {
  margin: calc(-1 * var(--panel-pad) - 4px) calc(-1 * var(--panel-scrollbar-size)) 6px calc(-1 * var(--panel-pad));
}

/* 絞り込み欄とエラー帯は共有の `.panel-filter` / `.panel-error-strip`（`theme.css`）。 */

.empty {
  padding: 12px;
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
}

.ci-run {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px 4px 8px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
}

.ci-run:hover,
.ci-job.link:hover {
  background: var(--bg-tertiary);
}

/* 行ではなく chevron だけが開閉の対象だという合図（行はページを開く）。 */
.ci-caret:hover {
  color: var(--text-primary);
}

/* 実行中・中止・スキップは色を付けない（結果ではないので、注意を引く理由が無い）。 */
.ci-state {
  flex-shrink: 0;
  color: var(--text-secondary);
}

.ci-state.success {
  color: var(--success);
}

.ci-state.failure {
  color: var(--danger);
}

/* 2 段（題名と、ワークフロー・ブランチ・時刻）。パネルの幅では 1 段に収まらない。 */
.ci-text {
  flex: 1;
  min-width: 0;
}

.ci-title,
.ci-meta,
.ci-job-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ci-meta {
  font-size: 11px;
  color: var(--text-secondary);
}

.ci-run:hover .row-action {
  opacity: 1;
}

/* job は chevron と状態アイコンのぶん字下げして、run の題名の位置にそろえる。 */
.ci-job {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 12px 2px 46px;
  font-size: 12px;
  color: var(--text-primary);
}

.ci-job.link {
  cursor: pointer;
}

.ci-job-name {
  flex: 1;
  min-width: 0;
}

.ci-note {
  padding: 2px 12px 2px 46px;
  font-size: 11px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

.ci-note.error {
  color: var(--danger);
}
</style>
