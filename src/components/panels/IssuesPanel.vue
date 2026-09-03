<script setup lang="ts">
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import { computed, watch } from 'vue'
import { useI18n } from '../../i18n'
import { relativeDate } from '../../lib/paths'
import { projectColorValue } from '../../lib/projectColors'
import { openUrlWithConfirm } from '../../lib/tauri'
import { useIssuesStore } from '../../stores/issues'
import { useProjectStore } from '../../stores/project'
import { useSidebarStore } from '../../stores/sidebar'
import type { IssueSummary } from '../../types/issues'

const { t } = useI18n()
const sidebar = useSidebarStore()
const issuesStore = useIssuesStore()
const projectStore = useProjectStore()

// 取得はパネルを開いたときと明示更新のときだけ（#278）。プロジェクト id をキーに含めるのは
// TasksPanel と同じ理由で、`switchProject` が中身を捨てるため（開いたまま切り替えると、
// 他に誰も取りに行かず空のまま座る）。
//
// **`visible` もキーに入れる。** サイドバーのアイコンは隠れてもこのパネルは残る
// （`activePanel` は localStorage に残るし、パレットからも開ける）ので、条件を見ずに
// 取ると **GitHub でないプロジェクトや `gh` の無い環境で `gh issue list` が走る**。
// 検出は開いたあとに終わることもあるので、真になった時点でも取りに行く。
watch(
  [() => sidebar.activePanel, () => projectStore.currentProject?.id, () => issuesStore.visible],
  ([panel, , visible]) => {
    if (panel === 'issues' && visible) void issuesStore.ensureLoaded()
  },
  { immediate: true },
)

interface IssueRow {
  issue: IssueSummary
  since: string
  /** 行のツールチップ。**`issue.title`（本文の題名）と紛れないよう別の名前にしてある。** */
  tooltip: string
  /** ラベルは**色のドットだけ**で出す。名前はツールチップにまとめてある。 */
  dots: { name: string; style: Record<string, string> }[]
  /** 字下げ（ツリー表示、#278）。フラットでは常に 0。 */
  depth: number
  hasChildren: boolean
  collapsed: boolean
}

/**
 * issue ごとの整形（相対時刻・ツールチップ・ラベル色）。**入力は一覧そのもの**で、絞り込みにも
 * 木の形にも依存させない: 絞り込み欄はこのコンポーネントの `v-model` なので、依存させると
 * 打鍵のたびに全行の日付整形と色の検証をやり直すことになる。ここが再計算されるのは取得した
 * ときと UI 言語を変えたときだけ（`relativeDate` が `t()` を通るので locale には追従する）。
 */
const formatted = computed(() => {
  const map = new Map<number, { since: string; tooltip: string; dots: IssueRow['dots'] }>()
  for (const issue of issuesStore.issues) {
    const since = relativeDate(issue.updatedAt)
    const names = issue.labels.map((l) => l.name).join(', ')
    map.set(issue.number, {
      since,
      // ラベル名はここに畳む。ドットだけでは何のラベルか読めないので、行の情報は
      // ツールチップで揃えて出す。
      tooltip: [`#${issue.number} ${issue.title}`, `${issue.author} · ${since}`, names].filter(Boolean).join('\n'),
      dots: issue.labels.map((l) => ({ name: l.name, style: dotStyle(l.color) })),
    })
  }
  return map
})

/**
 * 描く行。木の形と畳み具合はストアが決め、ここは整形済みの値を貼るだけ。
 *
 * `formatted` は同じ `issues` から作るので、`get` が外れることはない（`!` を使わないのは
 * 型の都合だけで、`?? []` の側は到達しない）。
 */
const rows = computed<IssueRow[]>(() =>
  issuesStore.rows.flatMap(({ issue, depth, hasChildren }) => {
    const f = formatted.value.get(issue.number)
    return f ? [{ ...f, issue, depth, hasChildren, collapsed: issuesStore.collapsed.has(issue.number) }] : []
  }),
)

/**
 * GitHub のラベル色（`#` 無しの 6 桁 hex）。**綴りの検証は `projectColorValue` に任せる**:
 * 任意の CSS 値が style バインドへ届かないようにする規則はあそこが持っていて、写すと
 * 許容する綴りを変えたときに片方だけ古くなる。
 */
function dotStyle(color: string): Record<string, string> {
  return { background: projectColorValue(`#${color}`) ?? 'var(--text-secondary)' }
}

/** 何も出す行が無いときの文言。**判断を 1 箇所にまとめる**（テンプレートに散らすと、
 *  状態を足すときに 3 箇所を見ることになる）。 */
const emptyMessage = computed(() => {
  if (rows.value.length > 0) return null
  if (issuesStore.loading) return t('common.loading')
  // 失敗しているときは黙る。エラー帯の下に「open な issue はありません」を並べると、
  // その帯が防ぐはずだった「0 件との区別が付かない」に半分戻る。
  if (issuesStore.error) return null
  return issuesStore.issues.length === 0 ? t('issues.empty') : t('issues.noMatch')
})

/**
 * 書き込み（コメント・クローズ）は持たないので、ブラウザへ逃がす（#278）。**確認を挟むのは
 * StatusBar のリポジトリリンクや GitPanel のコミットリンクと同じ規約**で、外部 URL を開く
 * 経路は 1 つだけ例外にしない。
 */
function open(issue: IssueSummary) {
  void openUrlWithConfirm(issue.url)
}
</script>

<template>
  <div class="issues-panel" data-testid="issues-panel">
    <!--
      条件を満たさないときは、2 つの条件をそのまま言う。**状態を推測して出し分けない**:
      origin の取得も `gh` の検出も非同期なので、「GitHub ではありません」を先に出すと
      起動直後に一瞬それが見える。この 1 文はどの段階でも正しい。
    -->
    <div v-if="!issuesStore.visible" class="empty">{{ t('issues.unavailable') }}</div>
    <template v-else>
      <input
        v-model="issuesStore.filter"
        class="filter"
        type="text"
        :placeholder="t('issues.filterPlaceholder')"
        spellcheck="false"
      />
      <!--
        未インストール・未認証・権限なしはどれも 0 件になるので、理由を出さないと「issue が
        無い」と見分けが付かない（`ProviderRun.error` と同じ考え方）。2 行目は実行した行。
      -->
      <div v-if="issuesStore.error" class="error-strip">{{ issuesStore.error }}</div>
      <div v-if="emptyMessage" class="empty">{{ emptyMessage }}</div>
      <div
        v-for="row in rows"
        :key="row.issue.number"
        class="issue-item"
        :title="row.tooltip"
        :style="{ paddingLeft: `${12 + row.depth * 12}px` }"
        @click="open(row.issue)"
      >
        <!-- chevron は子を持つ行だけ。持たない行にも枠を残して番号の位置を揃える。 -->
        <span
          v-if="row.hasChildren"
          class="tree-chevron issue-caret"
          @click.stop="issuesStore.toggleCollapsed(row.issue.number)"
        >
          <ChevronRight v-if="row.collapsed" :size="12" :stroke-width="2" />
          <ChevronDown v-else :size="12" :stroke-width="2" />
        </span>
        <span v-else-if="issuesStore.view === 'tree'" class="tree-chevron-space" />
        <span class="issue-number">#{{ row.issue.number }}</span>
        <span class="issue-title">{{ row.issue.title }}</span>
        <span v-for="dot in row.dots" :key="dot.name" class="issue-dot" :style="dot.style" />
        <span class="issue-since">{{ row.since }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.issues-panel {
  padding: 4px 0;
  overflow-y: auto;
  height: 100%;
}

.filter {
  width: calc(100% - 16px);
  margin: 4px 8px 6px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
}

.filter:focus {
  outline: none;
  border-color: var(--accent);
}

/* GitPanel の同名クラスと同じ様式（左に危険色の線、高さは頭を残して切る）。 */
.error-strip {
  margin: 0 8px 6px;
  padding: 4px 6px;
  border-left: 2px solid var(--danger);
  border-radius: 3px;
  background: var(--bg-tertiary);
  color: var(--danger);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 6em;
  overflow: hidden;
}

.empty {
  padding: 12px;
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
}

.issue-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
}

.issue-item:hover {
  background: var(--bg-tertiary);
}

/* 枠と色は共有の `.tree-chevron`（`theme.css`）。ここに残すのは issue パネル固有の
   詰めと、行ではなく chevron だけがクリックの対象だという合図（行はブラウザで開く）。 */
.issue-caret {
  margin-right: -2px;
}

.issue-caret:hover {
  color: var(--text-primary);
}

.issue-number {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-secondary);
}

.issue-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ラベルは色のドットだけ。名前を並べるとタイトルが隠れる（パネルは既定 250px）。 */
.issue-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

/* gap が 6px だと 2 つ目以降が離れて見えるので、ドット同士は詰める。**`:first-of-type` は
   使えない**: 行の子は全部 `span` なので「最初の span」は caret か番号になり、この規則が
   1 つ目のドットにも当たってタイトル側へ食い込む。 */
.issue-dot + .issue-dot {
  margin-left: -3px;
}

.issue-since {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-secondary);
}
</style>
