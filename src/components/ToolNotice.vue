<script setup lang="ts">
/**
 * 足りないツールについての帯（文面と、入れれば直るときのボタン）。**見た目だけを持つ。**
 * どの理由で出すか・ボタンで何をするかは置いた側が決める（ファイル監視は `WatcherNotice`、
 * ripgrep は検索パネル）。
 *
 * **1 部品にしてあるのは、写すと見た目がずれるから。** `WatcherNotice` を 2 か所に
 * 書き写していたころは、`display: block` の 1 行だけが片方に付いていて、同じ役目の
 * ボタンが 2 つの画面で違う位置に出ていた。ripgrep の帯を足したときも、写した時点で
 * 余白と並べ方が抜けていた。
 */
import { Info } from 'lucide-vue-next'

defineProps<{
  text: string
  /** ツールチップに出す詳細。 */
  detail?: string | null
  /** ボタンの文言。空ならボタンを出さない（入れても直らないとき）。 */
  actionLabel?: string
  /** 設定画面の帯（アイコン付きの箱）。省略するとパネルの細い帯になる。 */
  boxed?: boolean
}>()

defineEmits<{ action: [] }>()
</script>

<template>
  <div class="tool-notice" :class="{ boxed }" :title="detail ?? undefined">
    <Info v-if="boxed" :size="16" :stroke-width="1.5" />
    <div class="notice-body">
      <span>{{ text }}</span>
      <button v-if="actionLabel" class="notice-btn" @click="$emit('action')">
        {{ actionLabel }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.tool-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  margin-bottom: 8px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 4px;
}

/* 設定画面のぶん。パネルの細い帯より目立たせる（探して来る場所ではないため）。 */
.tool-notice.boxed {
  padding: 10px 12px;
  margin-bottom: 20px;
  font-size: 12px;
  color: var(--text-primary);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  border-radius: 6px;
}

.tool-notice :deep(svg) {
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--accent);
}

.notice-btn {
  /* `.notice-body` は素のブロックなので `align-self` は効かない。次の行に左寄せで
     置くために、自分でブロックにする。 */
  display: block;
  margin-top: 6px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 11px;
  cursor: pointer;
}

.notice-btn:hover {
  /* `filter: brightness()` にしないこと。ライトテーマの `--bg-secondary` はほぼ白なので
     ほとんど変化しない（`.editor-toggle` / `.tool-btn` が同じ理由でこの変数を使う）。 */
  background: var(--tab-hover-bg);
}
</style>
