<script setup lang="ts">
/**
 * タブの種別のアイコン 1 つ（#400）。タブバーの 1 枚（`TabItem`）と、溢れたときの一覧
 * （`TabBar`）が共有する。
 *
 * 選び方は「ファイルのアイコン → サイトのアイコン（ブラウザのタブ）→ 種別の lucide」の順。
 * **2 か所に書き写さないこと**: サイトのアイコンの段を足したときに実際に写しが 2 つでき、
 * 寸法の CSS まで二重になった。
 *
 * 置いた側の class はどの形にも付く（ルートが 1 つなので素直に落ちる）。lucide にだけ
 * 付けたいもの（タブバーの薄い種別アイコン）は `kindClass` で渡す。
 */
import { computed } from 'vue'
import { TAB_KIND_ICONS, tabFileIconSvg, tabImageIcon } from '../../lib/tabIcons'
import type { Tab } from '../../types/tab'

const props = defineProps<{ tab: Tab; kindClass?: string }>()

/** `v-if` と `v-html` で 2 回呼ばないための控え。 */
const svg = computed(() => tabFileIconSvg(props.tab))
const img = computed(() => tabImageIcon(props.tab))
</script>

<template>
  <span v-if="svg" class="row-icon row-icon-svg" v-html="svg" />
  <img v-else-if="img" :src="img" alt="" class="row-icon tab-favicon" />
  <component
    :is="TAB_KIND_ICONS[tab.kind]"
    v-else-if="TAB_KIND_ICONS[tab.kind]"
    :size="14"
    :stroke-width="1.5"
    :class="kindClass"
  />
</template>

<style scoped>
/* サイトのアイコン。サイズの違う画像（apple-touch-icon は 180px）も枠に収める。 */
.tab-favicon {
  width: 14px;
  height: 14px;
  object-fit: contain;
}
</style>
