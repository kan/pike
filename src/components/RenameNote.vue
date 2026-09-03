<script setup lang="ts">
/**
 * 「名前が変わった」ことの見出し（#306）。
 *
 * **リネームは差分の本文に出ない。** `rename from/to` は `diff --git` の直後のヘッダにしか
 * 無く、内容が変わっていなければ hunk が 1 つも出ない。差分の有無に関わらず上に出す。
 *
 * コミットの差分を描くのは diff タブと履歴タブの 2 つで、どちらも同じ見出しが要る。
 */
import { ArrowRight } from 'lucide-vue-next'

defineProps<{ from: string; to: string }>()
</script>

<template>
  <div class="rename-note">
    <span class="rename-from">{{ from }}</span>
    <ArrowRight :size="13" :stroke-width="2" />
    <span>{{ to }}</span>
  </div>
</template>

<style scoped>
.rename-note {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 12px;
  font-family: "PlemolJP Console NF", "Cascadia Code", "Fira Code", monospace;
}

/* **省略は名前の側に置く。** `text-overflow` は flex コンテナには効かず、flex アイテムは
   min-content より縮まないので、親で `overflow: hidden` だけ指定すると深いパスのときに
   矢印と新しい名前が切り落とされ、**古い名前だけが残る**という最悪の見え方になる。 */
.rename-note > span {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.rename-note > svg {
  flex-shrink: 0;
}

.rename-from {
  color: var(--text-secondary);
}
</style>
