<script setup lang="ts">
/**
 * 今動いているエージェントのセッションの簡易表示（#625 / #633）。アカウントの見出し（2 つ以上
 * あるときだけ）の下に、返答待ち・稼働中・アイドル・最近の順に分けて並べ、行を押すとそのセッションの
 * 居る場所へ飛ぶ（`liveSessions.jump`）。詳細は専用のタブ（`AgentSessionsTab.vue`）。
 */
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-vue-next'
import { onUnmounted, ref, useTemplateRef } from 'vue'
import { useI18n } from '../../i18n'
import { LIVE_STATUS_ICONS } from '../../lib/liveSessionIcons'
import {
  asKeyList,
  LIVE_COLLAPSED_KEY,
  liveRowKey,
  liveSessionJumpKey,
  liveSessionLabel,
  liveStatusKey,
  withCollapsedKey,
} from '../../lib/liveSessions'
import { basename, stripTrailingSep } from '../../lib/paths'
import { loadJson, saveJson } from '../../lib/storage'
import { type LiveSessionRow, useLiveSessionsStore } from '../../stores/liveSessions'
import { useProjectStore } from '../../stores/project'
import { useTabStore } from '../../stores/tabs'
import LiveSessionMenu from '../LiveSessionMenu.vue'
import TerminalPeekMark from '../TerminalPeekMark.vue'

const { t } = useI18n()
const store = useLiveSessionsStore()
const menu = useTemplateRef<InstanceType<typeof LiveSessionMenu>>('menu')
const projectStore = useProjectStore()
const tabStore = useTabStore()

/**
 * 折り畳んだアカウント（`liveListKey`。#633）。localStorage に置き、マシンの中だけで覚える（設定ディレクトリの
 * パスを含む鍵なので、同期しても他のマシンでは当たらない）。**書く直前に読み直す**: 別のウィンドウの
 * パネルが畳んだぶんを、このウィンドウの古い写しで消さない（`storage.ts` の `rememberAskedKey` と同じ理由）。
 */
const collapsed = ref<string[]>(asKeyList(loadJson<unknown>(LIVE_COLLAPSED_KEY, [])))
const isCollapsed = (key: string) => collapsed.value.includes(key)
function toggleCollapsed(key: string) {
  const next = withCollapsedKey(asKeyList(loadJson<unknown>(LIVE_COLLAPSED_KEY, [])), key, !isCollapsed(key))
  saveJson(LIVE_COLLAPSED_KEY, next)
  collapsed.value = next
}
// 別のウィンドウで畳んだ・開いたぶんも写す（`storage` は書いたウィンドウ以外に届く）。写さないと、
// 次にここで押したとき、その変化が押していない見出しにまとめて現れる。
function onStorage(e: StorageEvent) {
  if (e.key === LIVE_COLLAPSED_KEY) collapsed.value = asKeyList(loadJson<unknown>(LIVE_COLLAPSED_KEY, []))
}
window.addEventListener('storage', onStorage)
onUnmounted(() => window.removeEventListener('storage', onStorage))

/** 2 段目。どのプロジェクトか（無ければディレクトリ名）・ブランチ・今の状態になってからの時間。 */
function meta(row: LiveSessionRow): string {
  const place = row.project?.name ?? basename(stripTrailingSep(row.cwd))
  return [place, row.gitBranch, store.since(row.statusSince)].filter(Boolean).join(' · ')
}

function tooltip(row: LiveSessionRow): string {
  return [
    liveSessionLabel(row),
    row.name,
    row.cwd,
    row.waitingFor && t('liveSessions.waitingFor', { reason: row.waitingFor }),
    t(liveSessionJumpKey(row)),
  ]
    .filter(Boolean)
    .join('\n')
}
</script>

<template>
  <div class="sessions-panel" data-testid="sessions-panel">
    <div v-if="!projectStore.currentProject" class="empty">{{ t('liveSessions.noProject') }}</div>
    <template v-else>
      <div class="sessions-head">
        <!-- アカウントの見出しを出すときは、名前はそちらが言う（空の枠はボタンを右へ寄せるため残す）。 -->
        <span class="account" :title="store.showHeadings ? undefined : (store.configDir ?? '')">
          <template v-if="!store.showHeadings">{{ store.account ?? store.configDir ?? '' }}</template>
        </span>
        <button class="detail-btn" data-testid="sessions-open-tab" @click="tabStore.addAgentSessionsTab()">
          <ExternalLink :size="12" :stroke-width="2" />
          <span>{{ t('liveSessions.details') }}</span>
        </button>
      </div>
      <div v-if="store.sections.length === 0" class="empty">{{ t(store.emptyKey) }}</div>
      <div v-for="section in store.sections" :key="section.key" class="account-section">
        <!-- アカウントの見出し。押すと中身を開閉する（#633。畳んでも件数と返答待ちの数は見える）。 -->
        <button
          v-if="store.showHeadings"
          class="account-head"
          :title="section.configDir"
          :aria-expanded="!isCollapsed(section.key)"
          @click="toggleCollapsed(section.key)"
        >
          <component :is="isCollapsed(section.key) ? ChevronRight : ChevronDown" :size="12" :stroke-width="2" />
          <span class="account-title">{{ section.title }}</span>
          <span v-if="section.waiting > 0" class="account-waiting" :title="t('liveSessions.waiting')">
            <component :is="LIVE_STATUS_ICONS.waiting" :size="11" :stroke-width="2" />
            {{ section.waiting }}
          </span>
          <span class="count">{{ section.total }}</span>
        </button>
        <template v-if="!store.showHeadings || !isCollapsed(section.key)">
          <div v-if="section.groups.length === 0" class="empty" :class="{ compact: store.showHeadings }">
            {{ t(store.emptyKey) }}
          </div>
          <section v-for="group in section.groups" :key="group.status" class="group">
            <div class="group-head" :class="group.status">
              <component :is="LIVE_STATUS_ICONS[group.status]" :size="13" :stroke-width="2" />
              <span>{{ t(liveStatusKey(group.status)) }}</span>
              <span class="count">{{ group.sessions.length }}</span>
            </div>
            <div
              v-for="row in group.sessions"
              :key="liveRowKey(row)"
              class="session-row"
              :class="{ here: row.here }"
              :title="tooltip(row)"
              @click="store.jump(row)"
              @contextmenu="menu?.open($event, row)"
            >
              <span class="live-state-dot" :class="row.status" />
              <div class="session-text">
                <div class="session-title">{{ liveSessionLabel(row) }}</div>
                <div class="session-meta">{{ meta(row) }}</div>
                <div v-if="row.waitingFor" class="session-wait">{{ row.waitingFor }}</div>
              </div>
              <!--
                このウィンドウのターミナルで動いているもの。押すとそのタブへ移る（行と同じ）。
                ホバーするとターミナルの今の表示をチラ見する（#631）。
              -->
              <TerminalPeekMark
                v-if="row.tabId"
                class="row-mark"
                :peekable="row.peekable"
                :resolve="() => store.tabForSession(row)"
              />
            </div>
          </section>
        </template>
      </div>
      <LiveSessionMenu ref="menu" />
    </template>
  </div>
</template>

<style scoped>
/* スクロールはサイドバーの `.panel-content` に任せる（自分で持つと二重になる）。 */
.sessions-panel {
  padding: 4px 0;
}

.empty {
  padding: 12px;
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
}

.sessions-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 6px 12px;
  font-size: 11px;
  color: var(--text-secondary);
}

.account {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  font-size: 11px;
  color: var(--text-secondary);
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
}

.detail-btn:hover {
  color: var(--text-active);
}

.group + .group {
  margin-top: 6px;
}

.empty.compact {
  padding: 2px 12px 6px;
  text-align: left;
}

.account-section + .account-section {
  margin-top: 10px;
}

/* アカウントの見出し（#633）。状態の見出しより 1 段上なので、線で区切って強めに出す。 */
/* 押すと開閉する（ボタンの既定の見た目を外して、見出しとして描く）。 */
.account-head {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 4px 12px 4px 8px;
  background: none;
  border: none;
  border-top: 1px solid var(--border-color);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.account-head:hover {
  background: var(--bg-tertiary);
}

.account-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 畳んでいても返答待ちが分かるように、状態の見出しと同じ緑で出す。 */
.account-waiting {
  display: flex;
  align-items: center;
  gap: 2px;
  color: var(--success);
}

.account-head .count {
  font-weight: 400;
  color: var(--text-secondary);
}

.group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
}

/* 返答待ちだけ色を付ける（手を出さないと進まないもの）。入力待ちの知らせ（#265）と同じ緑。 */
.group-head.waiting {
  color: var(--success);
}

.group-head .count {
  margin-left: auto;
  font-weight: 400;
}

.session-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 12px 4px 14px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
}

.session-row:hover {
  background: var(--bg-tertiary);
}

/* 今見ているプロジェクトのセッション。行を塗らず、左に印を付けるだけにする。 */
.session-row.here {
  box-shadow: inset 2px 0 0 var(--accent);
}

/* 状態の点の形と色は `theme.css` の `.live-state-dot`（詳細のタブと共有）。 */
.live-state-dot {
  margin-top: 6px;
}

.session-text {
  flex: 1;
  min-width: 0;
}

.session-title,
.session-meta,
.session-wait {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-meta,
.session-wait {
  font-size: 11px;
  color: var(--text-secondary);
}

.session-wait {
  color: var(--success);
}

/* 印の形は `TerminalPeekMark.vue`。ここは行の中の位置だけ。 */
.row-mark {
  margin-top: 1px;
}
</style>
