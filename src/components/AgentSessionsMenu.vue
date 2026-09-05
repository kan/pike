<script setup lang="ts">
/**
 * 「最近のセッション」の行と、その中に開くサブメニュー（#267）。
 *
 * **起動メニューの 2 か所で共有する**（既定の起動行の下と、「他のエージェント」の各行の
 * 下）。写すと、表示を変えたときに片方だけ直す事故が起きる（`TabItem.vue` の #305 と
 * 同じ理由）。
 *
 * **開いているかは親が決める**（`open`）。鍵にするのは**メニュー上の位置**であって
 * エージェントの id ではない: 既定が `claude` でカスタム行に `claude --model opus` を
 * 置いている構成だと、id を鍵にすると片方にホバーしただけで両方のサブメニューが開く。
 *
 * **見た目は `theme.css` の `.agent-menu*` を親と共有する。** scoped CSS は子のルート
 * 要素までしか届かないので、ここに写すか共有クラスへ上げるかの二択で、同名の別物が
 * 無いので上げてある（`frontend.md` の「共有クラスへ上げるか、子に書き写すか」）。
 */
import { ChevronLeft } from 'lucide-vue-next'
import { useI18n } from '../i18n'
import type { AgentDef } from '../lib/agents'
import { relativeTime } from '../lib/paths'
import type { AgentSession } from '../types/agentSession'

const props = defineProps<{
  agent: AgentDef
  sessions: AgentSession[]
  loading: boolean
  open: boolean
}>()

const emit = defineEmits<{
  enter: []
  leave: []
  /** 選ばれたセッションの再開コマンド。組み立ては表の `resume` が持つ。 */
  pick: [command: string]
}>()

const { t } = useI18n()

function resumeCommand(session: AgentSession): string {
  return props.agent.resume(session.id)
}
</script>

<template>
  <div class="agent-menu-item agent-menu-sub" @mouseenter="emit('enter')" @mouseleave="emit('leave')">
    <ChevronLeft :size="12" :stroke-width="2" class="agent-menu-caret" />
    <span class="agent-menu-label">{{ t('terminal.recentSessions') }}</span>
    <div v-if="open" class="agent-menu agent-submenu popup-surface">
      <div class="agent-menu-scroll">
        <div v-if="sessions.length === 0" class="agent-menu-note">
          {{ loading ? t('common.loading') : t('terminal.noSessions') }}
        </div>
        <button
          v-for="s in sessions"
          :key="s.id"
          class="agent-menu-item"
          :title="resumeCommand(s)"
          @click="emit('pick', resumeCommand(s))"
        >
          <span class="agent-menu-label">{{ s.title || s.id }}</span>
          <span class="agent-menu-cmd">
            {{ relativeTime(s.modifiedAt) }}<template v-if="s.gitBranch"> · {{ s.gitBranch }}</template>
          </span>
        </button>
      </div>
    </div>
  </div>
</template>
