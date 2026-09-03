<script setup lang="ts">
/**
 * タブバーの 1 枚（#305）。
 *
 * **切り出したのは、タブバーが 2 つの入れ物に分かれたから。** 固定タブはスクロールしない
 * 左端の列、残りは横スクロールする列に入る（ブラウザの固定タブと同じ）。同じマークアップを
 * `v-for` 2 つに写すと、バッジやアイコンを足すたびに片方だけ直す事故が起きる。
 *
 * **見た目もここが持つ。** scoped CSS は**子コンポーネントのルート要素までしか届かない**
 * ので、`.tab` だけは親からでも当たるが、中のアイコン・タイトル・✕ には当たらない。
 * タブバー側に置いたままにしたら、そこが素の見た目に戻った。
 *
 * ドラッグ関連のイベントは emit を定義していない。単一ルートなので、親が
 * `@dragstart` などを書けばそのままルート要素へ落ちる。
 */
import { Pin, X } from 'lucide-vue-next'
import { computed } from 'vue'
import { useI18n } from '../../i18n'
import { TAB_KIND_ICONS, tabFileIconSvg } from '../../lib/tabIcons'
import { tabDisplayTitle } from '../../lib/tabTitle'
import type { Tab } from '../../types/tab'

const props = defineProps<{
  tab: Tab
  active: boolean
  dragging: boolean
  /** ドロップ位置の印。掴んでいるタブの相手でなければ null。 */
  dropSide: 'left' | 'right' | null
}>()

const emit = defineEmits<{
  select: []
  close: []
}>()

const { t } = useI18n()

/** `v-if` と `v-html` で 2 回呼ばないための控え。タブバーはタイトルが変わるたびに描き直す。 */
const iconSvg = computed(() => tabFileIconSvg(props.tab))

/**
 * タイトルが実際に切れているときだけ native のツールチップを出す（#198）。ホバーで属性を
 * 付ければ間に合う（ブラウザは自前のホバー遅延が過ぎてから `title` を読む）。
 */
function onTitleHover(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement
  if (el.scrollWidth > el.clientWidth) el.title = el.textContent ?? ''
  else el.removeAttribute('title')
}
</script>

<template>
  <div
    :data-tab-id="tab.id"
    class="tab"
    :class="{
      active,
      dragging,
      'drag-over-left': dropSide === 'left',
      'drag-over-right': dropSide === 'right',
    }"
    draggable="true"
    @click="emit('select')"
    @mousedown.middle.prevent="emit('close')"
  >
    <Pin v-if="tab.pinned" :size="12" :stroke-width="2" class="tab-pin" :title="t('tabs.pinned')" />
    <span v-if="iconSvg" class="row-icon row-icon-svg" v-html="iconSvg" />
    <component
      :is="TAB_KIND_ICONS[tab.kind]"
      v-else-if="TAB_KIND_ICONS[tab.kind]"
      :size="14"
      :stroke-width="1.5"
      class="tab-icon"
    />
    <span class="tab-title" @mouseenter="onTitleHover">{{ tabDisplayTitle(tab) }}</span>
    <span v-if="tab.kind === 'editor' && tab.isNewFile" class="tab-new-badge" :title="t('tabs.newFileBadge')">new</span>
    <span
      v-if="tab.kind === 'terminal' && tab.exitCode != null"
      class="tab-exit-badge"
      :class="{ 'exit-ok': tab.exitCode === 0 }"
      :title="'Exit code: ' + tab.exitCode"
    >{{ tab.exitCode === 0 ? '✓' : tab.exitCode }}</span>
    <span v-else-if="tab.kind === 'terminal' && tab.hasActivity && !active" class="tab-activity-dot" />
    <button v-if="!tab.pinned" class="tab-close" :title="t('tabs.close')" @click.stop="emit('close')">
      <X :size="14" :stroke-width="2" />
    </button>
  </div>
</template>

<style scoped>
.tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px;
  min-width: 80px;
  max-width: 180px;
  height: 100%;
  background: var(--tab-inactive-bg);
  border-right: 1px solid var(--border);
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
  transition: background 0.1s;
  white-space: nowrap;
}

.tab:hover {
  background: var(--tab-hover-bg);
}

.tab.dragging {
  opacity: 0.4;
}

.tab.drag-over-left {
  box-shadow: inset 2px 0 0 0 var(--accent);
}

.tab.drag-over-right {
  box-shadow: inset -2px 0 0 0 var(--accent);
}

.tab.active {
  background: var(--tab-active-bg);
  color: var(--text-active);
  border-bottom: 1px solid var(--tab-active-bg);
  margin-bottom: -1px;
}

.tab-pin {
  color: var(--accent);
  flex-shrink: 0;
}

/* 種別の lucide アイコンだけ控えめにする。**ファイルアイコンにこのクラスを付けないこと**:
   共有の `.row-icon`（`theme.css`）は詳細度で負けるので、薄くしないために
   `.tab-icon.row-icon` のような上書きを足す羽目になる。 */
.tab-icon {
  flex-shrink: 0;
  opacity: 0.7;
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-activity-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
}

.tab-exit-badge {
  font-size: 10px;
  line-height: 1;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--danger);
  color: #fff;
  flex-shrink: 0;
}

.tab-new-badge {
  font-size: 10px;
  line-height: 1;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--git-add);
  color: #fff;
  flex-shrink: 0;
}

.tab-exit-badge.exit-ok {
  background: var(--git-add);
}

/* **幅は最初から確保する**（ホバーで現れると隣がずれる）。 */
.tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-left: auto;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  flex-shrink: 0;
  opacity: 0;
}

.tab:hover .tab-close {
  opacity: 1;
}

.tab-close:hover {
  background: var(--danger);
  color: var(--text-active);
}
</style>
