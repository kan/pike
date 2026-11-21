<script setup lang="ts">
/**
 * 今動いているエージェントのセッションの詳細（#625 / #633）。簡易表示はサイドバーのパネル
 * （`AgentSessionsPanel.vue`）で、こちらはアカウントの見出し（2 つ以上あるときだけ）と状態ごとの
 * 見出しの下に 1 セッション 1 行で、パネルの幅に収まらない欄（ディレクトリ・起動した時刻・pid・版）まで並べる。一覧はパネルと同じストア
 * （`stores/liveSessions.ts`）で、このタブが見えているあいだはストアが自分で短い間隔に切り替える。
 */
import { ArrowRight, RefreshCw } from 'lucide-vue-next'
import { computed, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from '../../i18n'
import { LIVE_STATUS_ICONS } from '../../lib/liveSessionIcons'
import {
  groupLiveSessions,
  LIVE_TAB_ACCOUNT_KEY,
  liveRowKey,
  liveSessionJumpKey,
  liveStatusKey,
  selectedSections,
} from '../../lib/liveSessions'
import { basename, stripTrailingSep } from '../../lib/paths'
import { loadJson, saveJson } from '../../lib/storage'
import { type LiveSessionRow, useLiveSessionsStore } from '../../stores/liveSessions'
import { useProjectStore } from '../../stores/project'
import { useTabStore } from '../../stores/tabs'
import HelpButton from '../HelpButton.vue'
import LiveSessionMenu from '../LiveSessionMenu.vue'
import TerminalPeekMark from '../TerminalPeekMark.vue'

const props = defineProps<{ tabId: string }>()

const { t } = useI18n()
const store = useLiveSessionsStore()
const menu = useTemplateRef<InstanceType<typeof LiveSessionMenu>>('menu')
const projectStore = useProjectStore()
const tabStore = useTabStore()

// 右クリックのメニューは body へ出しているので、タブが隠れたら自分で閉じる（`tabs.md` の
// 「body へ Teleport したものは、隠れたときに自分で畳む」。残るとブラウザのタブも隠れたままになる）。
// チラ見（`TerminalPeekMark`）はここで閉じなくてよい（印が隠れたことを、取り直しのたびに部品が自分で見る）。
watch(
  () => tabStore.isTabVisible(props.tabId),
  (visible) => {
    if (!visible) menu.value?.close()
  },
)

/**
 * 選んでいるアカウント（`liveListKey`。null は「すべて」。#633）。localStorage に置き、次に開いたときも
 * 引き継ぐ（マシンの中だけ）。**一覧から消えたアカウントを選んでいたら「すべて」を出す**が、保存した値は
 * 消さない（そのアカウントでまたセッションが動き出せば戻る）。
 */
const selected = ref<string | null>(loadSelected())
function loadSelected(): string | null {
  const v = loadJson<unknown>(LIVE_TAB_ACCOUNT_KEY, null)
  return typeof v === 'string' ? v : null
}
function selectAccount(key: string | null) {
  selected.value = key
  saveJson(LIVE_TAB_ACCOUNT_KEY, key)
}
/** 出すアカウント。一覧が 1 つなら切り替えを出さないので、全部（＝その 1 つ）。 */
const shownSections = computed(() =>
  store.showHeadings ? selectedSections(store.sections, selected.value) : store.sections,
)
/** 切り替えで選ばれて見えているもの（選んでいたアカウントが消えていれば「すべて」）。 */
const shownKey = computed(() => (store.sections.some((s) => s.key === selected.value) ? selected.value : null))

/**
 * 見出しの横の要約（「返答待ち 1 · 稼働中 2」）。空のグループは言わない。**数えるのは出しているアカウント**
 * （切り替えで 1 つを選んでいれば、そのアカウントだけ）。
 */
const summary = computed(() =>
  groupLiveSessions(shownSections.value.flatMap((s) => s.groups.flatMap((g) => g.sessions)))
    .map((g) => `${t(liveStatusKey(g.status))} ${g.sessions.length}`)
    .join(' · '),
)

/** 1 列目の名前。Claude Code が付けた名前、無ければディレクトリ名。 */
function handle(row: LiveSessionRow): string {
  return row.name ?? basename(stripTrailingSep(row.cwd))
}

/** 1 列目の 2 段目。pid（Codex は持たない）と版。 */
function subline(row: LiveSessionRow): string {
  return [row.pid !== null && `pid ${row.pid}`, row.version && `v${row.version}`].filter(Boolean).join(' · ')
}

/**
 * 最後に取り直した時刻。**相対時刻（「たった今」）にしない**: 描き直すのは取り直したときだけ
 * なので、ウィンドウが後ろにあってポーリングが止まっていると、古い一覧でも「たった今」のまま残る。
 */
function updatedLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** 起動した時刻。日付が今日なら時刻だけ。 */
function startedLabel(ms: number | null): string | null {
  if (!ms) return null
  const d = new Date(ms)
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="agent-sessions">
    <header class="head">
      <h1>{{ t('sidebar.sessions') }}</h1>
      <span v-if="summary" class="summary">{{ summary }}</span>
      <div class="head-actions">
        <span v-if="store.checkedAt" class="updated">
          {{ t('liveSessions.updated', { when: updatedLabel(store.checkedAt) }) }}
        </span>
        <button class="icon-btn" :disabled="store.loading" :title="t('common.refresh')" @click="store.refresh()">
          <RefreshCw :size="14" :stroke-width="2" :class="{ spin: store.loading }" />
        </button>
        <HelpButton page="terminal-and-agents.md#エージェントのセッション一覧" :size="15" />
      </div>
    </header>

    <p v-if="!projectStore.currentProject" class="empty">{{ t('liveSessions.noProject') }}</p>
    <template v-else>
      <p v-if="!store.showHeadings && (store.account || store.configDir)" class="account selectable">
        <span v-if="store.account">{{ store.account }}</span>
        <span v-if="store.configDir" class="mono">{{ store.configDir }}</span>
      </p>

      <!-- アカウントの切り替え（#633。2 つ以上あるときだけ）。「すべて」は見出し付きで全部を並べる。 -->
      <div v-if="store.showHeadings" class="account-switch">
        <button
          :aria-pressed="shownKey === null"
          :class="{ active: shownKey === null }"
          @click="selectAccount(null)"
        >
          {{ t('liveSessions.allAccounts') }}
        </button>
        <button
          v-for="section in store.sections"
          :key="section.key"
          :aria-pressed="shownKey === section.key"
          :class="{ active: shownKey === section.key }"
          :title="section.configDir"
          @click="selectAccount(section.key)"
        >
          <span class="switch-title">{{ section.title }}</span>
          <span v-if="section.waiting > 0" class="switch-waiting">
            <component :is="LIVE_STATUS_ICONS.waiting" :size="12" :stroke-width="2" />{{ section.waiting }}
          </span>
          <span class="switch-count">{{ section.total }}</span>
        </button>
      </div>

      <p v-if="store.sections.length === 0" class="empty">{{ t(store.emptyKey) }}</p>

      <div v-for="section in shownSections" :key="section.key" class="account-section">
        <!-- アカウントの見出し（2 つ以上あるときだけ。#633）。設定ディレクトリも添える。 -->
        <div v-if="store.showHeadings" class="account-head selectable">
          <span class="account-title">{{ section.title }}</span>
          <span class="mono">{{ section.configDir }}</span>
        </div>
        <p v-if="section.groups.length === 0" class="empty" :class="{ compact: store.showHeadings }">
          {{ t(store.emptyKey) }}
        </p>
        <section v-for="group in section.groups" :key="group.status" class="group">
          <h2 class="group-head" :class="group.status">
            <component :is="LIVE_STATUS_ICONS[group.status]" :size="14" :stroke-width="2" />
            <span>{{ t(liveStatusKey(group.status)) }}</span>
            <span class="count">{{ group.sessions.length }}</span>
          </h2>
          <div
            v-for="row in group.sessions"
            :key="liveRowKey(row)"
            class="row"
            :class="{ here: row.here }"
            @contextmenu="menu?.open($event, row)"
          >
            <div class="col-handle">
              <span class="live-state-dot" :class="row.status" />
              <div class="handle-text selectable">
                <div class="handle mono" :title="row.sessionId">{{ handle(row) }}</div>
                <div class="sub mono">{{ subline(row) }}</div>
              </div>
            </div>
            <div class="col-main selectable">
              <!-- 題が無いセッションは、1 列目の名前と同じものを繰り返さない。 -->
              <div v-if="row.title || row.tabId" class="title">
                <!-- ホバーでターミナルの今の表示をチラ見する（#631。パネルと同じ印）。 -->
                <!-- 押すとそのタブへ移る（パネルと違って行そのものは押せないので、印に付ける）。 -->
                <TerminalPeekMark
                  v-if="row.tabId"
                  class="tab-mark"
                  :title="t(liveSessionJumpKey(row))"
                  :peekable="row.peekable"
                  :resolve="() => store.tabForSession(row)"
                  @click="store.jump(row)"
                />
                <span v-if="row.title">{{ row.title }}</span>
              </div>
              <div v-if="row.waitingFor" class="sub wait">
                {{ t('liveSessions.waitingFor', { reason: row.waitingFor }) }}
              </div>
              <div class="sub mono">{{ row.cwd }}</div>
            </div>
            <div class="col-place selectable">
              <div :class="{ muted: !row.project }">{{ row.project?.name ?? t('liveSessions.unregistered') }}</div>
              <div v-if="row.gitBranch" class="sub branch">{{ row.gitBranch }}</div>
            </div>
            <div class="col-time">
              <div>{{ store.since(row.statusSince) ?? '—' }}</div>
              <div v-if="startedLabel(row.startedAt)" class="sub">
                {{ t('liveSessions.startedAt', { when: startedLabel(row.startedAt) ?? '' }) }}
              </div>
            </div>
            <div class="col-jump">
              <button class="jump" :title="t(liveSessionJumpKey(row))" @click="store.jump(row)">
                <span>{{ t('liveSessions.jump') }}</span>
                <ArrowRight :size="13" :stroke-width="2" />
              </button>
            </div>
          </div>
        </section>
      </div>
      <LiveSessionMenu ref="menu" />
    </template>
  </div>
</template>

<style scoped>
.agent-sessions {
  height: 100%;
  overflow-y: auto;
  padding: 18px 24px 28px;
  background: var(--bg-primary);
  color: var(--text-primary);
}

/* 見出しの行。題・要約・右寄せの更新時刻と操作。 */
.head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  max-width: 1100px;
  margin-bottom: 4px;
}

.head h1 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--text-active);
}

.summary {
  font-size: 13px;
  color: var(--text-secondary);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  align-self: center;
}

.updated {
  font-size: 12px;
  color: var(--text-secondary);
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--text-secondary);
  background: none;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.icon-btn:hover:not(:disabled) {
  color: var(--text-active);
  background: var(--bg-tertiary);
}

.icon-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.account {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin: 0 0 18px;
  font-size: 12px;
  color: var(--text-secondary);
}

.mono {
  font-family: var(--font-mono, monospace);
}

.group {
  max-width: 1100px;
}

.group + .group {
  margin-top: 22px;
}

/* アカウントの切り替え（#633）。選んでいるものだけ地を塗る。 */
.account-switch {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-width: 1100px;
  margin: 8px 0 20px;
}

.account-switch button {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 360px;
  padding: 3px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  cursor: pointer;
}

.account-switch button:hover {
  color: var(--text-active);
}

.account-switch button.active {
  color: var(--on-accent);
  background: var(--accent);
  border-color: var(--accent);
}

.switch-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 返答待ちは状態の見出しと同じ緑。選んでいるものの上では読める色に振り替える。 */
.switch-waiting {
  display: flex;
  align-items: center;
  gap: 2px;
  color: var(--success);
}

.account-switch button.active .switch-waiting,
.account-switch button.active .switch-count {
  color: var(--on-accent-muted);
}

/* アカウントの見出し（#633）。状態の見出しより 1 段上。 */
.account-section {
  max-width: 1100px;
}

.account-section + .account-section {
  margin-top: 30px;
}

.account-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--text-secondary);
}

.account-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-active);
}

.empty.compact {
  margin: 0;
}

/* 状態の見出し。パネルと同じアイコン。下の線で行の並びと区切る。 */
.group-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  padding: 0 4px 7px;
  border-bottom: 1px solid var(--border-color);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

/* 返答待ちだけ色を付ける（パネルと同じ）。 */
.group-head.waiting {
  color: var(--success);
}

.group-head .count {
  font-weight: 400;
}

/* 1 セッション 1 行。名前・題と場所・プロジェクト・時間・移動の 5 列。 */
.row {
  display: grid;
  grid-template-columns: minmax(150px, 1.1fr) minmax(0, 3fr) minmax(120px, 1.3fr) 7.5em auto;
  gap: 4px 20px;
  align-items: start;
  padding: 10px 4px;
  border-bottom: 1px solid var(--border-color);
  font-size: 13px;
}

.row:hover {
  background: var(--tab-hover-bg, var(--bg-secondary));
}

/* 今見ているプロジェクトのセッション。パネルと同じく左に印を付ける。 */
.row.here {
  box-shadow: inset 2px 0 0 var(--accent);
}

.col-handle {
  display: flex;
  gap: 8px;
  min-width: 0;
}

/* 状態の点の形と色は `theme.css` の `.live-state-dot`（パネルと共有）。 */
.live-state-dot {
  margin-top: 6px;
  margin-left: 4px;
}

.handle-text,
.col-main,
.col-place {
  min-width: 0;
}

.handle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-active);
}

.title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-active);
  overflow-wrap: anywhere;
}

/* 印の形は `TerminalPeekMark.vue`。押すとタブへ移る（行の「移動」と同じ）。 */
.tab-mark {
  cursor: pointer;
}

.sub {
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.sub.wait {
  color: var(--success);
}

.sub.branch {
  color: var(--accent);
}

.muted {
  color: var(--text-secondary);
}

.col-time {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.jump {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  font-size: 12px;
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}

.jump:hover {
  color: var(--text-active);
  border-color: var(--accent);
}

.empty {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--text-secondary);
}
</style>
