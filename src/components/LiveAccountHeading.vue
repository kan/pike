<script setup lang="ts">
/**
 * 今動いているセッションの一覧のアカウントの見出し（#633）。パネルの見出し・詳細のタブの見出し・
 * 切り替えのボタンが共有する。組み立ては `lib/liveSessions.ts` の `liveListHeading`。
 *
 * **エージェントと環境はアイコンで出す**（横幅を取らないため）。アイコンには読み上げ用の `aria-label` を
 * 付ける。マウスを合わせたときの説明（`title`）は**置いた側が自分の器に付ける**（見出しの全文
 * `heading.label` と設定ディレクトリ。ここで付けると器の `title` を内側で上書きし、数の部分と食い違う）。
 * アカウントを見分ける部分（メールアドレス、設定ディレクトリの名前）と、WSL の distro が 2 つ以上あるときの
 * distro の名前は文字のまま。
 */
import type { Component } from 'vue'
import { AGENT_ICONS } from '../lib/agentIcons'
import { WindowsSquares, WSL_LOGOS } from '../lib/brandIcons'
import type { LiveListHeading } from '../lib/liveSessions'
import { SHELL_KIND_ICONS } from '../lib/shellIcons'

defineProps<{
  heading: LiveListHeading
  /** アイコンの大きさ（px）。 */
  size?: number
}>()

/**
 * 環境のアイコン。WSL は distro のロゴ（知らない distro は Tux。`wslLogoOf` → `WSL_LOGOS`）、Windows は 4 つの四角、
 * ホスト（macOS / Linux）はシェルのアイコン（`SHELL_KIND_ICONS.unix`。ホストは 1 つしか出ないので見分けは要らない）。
 */
function placeIcon(place: NonNullable<LiveListHeading['place']>): Component {
  if (place.kind === 'wsl') return WSL_LOGOS[place.logo]
  return place.kind === 'windows' ? WindowsSquares : SHELL_KIND_ICONS.unix
}
</script>

<template>
  <span class="live-account">
    <component
      :is="AGENT_ICONS[heading.agent]"
      class="live-account-icon"
      :size="size ?? 12"
      :stroke-width="2"
      role="img"
      :aria-label="heading.agentLabel"
    />
    <template v-if="heading.place">
      <component
        :is="placeIcon(heading.place)"
        class="live-account-icon"
        :size="size ?? 12"
        :stroke-width="2"
        role="img"
        :aria-label="heading.place.label"
      />
      <span v-if="heading.place.kind === 'wsl' && heading.place.showDistro" class="live-account-distro">
        {{ heading.place.distro }}
      </span>
    </template>
    <span class="live-account-who">{{ heading.who }}</span>
  </span>
</template>

<style scoped>
.live-account {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.live-account-icon {
  flex-shrink: 0;
}

/* distro の名前（WSL が 2 つ以上あるときだけ）。アイコンの続きとして小さく出す。 */
.live-account-distro {
  flex-shrink: 0;
  font-size: 0.9em;
  opacity: 0.8;
}

.live-account-who {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
