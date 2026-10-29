<script setup lang="ts">
import { gitStatusColor } from '../lib/paths'

/**
 * 変更されたファイルの一覧の 1 行（コミットタブと作業中の変更のタブ #526 が共有）。状態の
 * 文字・パス（リネームなら元の名前も）・行数を出し、右端に操作のボタンを置ける（slot）。
 *
 * **ボタンは選んでいる行とホバーした行にだけ出す**（Git パネルの `.file-action` と同じ）。
 */
defineProps<{
  status: string
  path: string
  oldPath?: string | null
  /** 行数。差分がまだ無い（未追跡で取っていない）ときは省く。 */
  added?: number
  removed?: number
  selected: boolean
  /** 押したときの説明（コンフリクトの行の「ファイルを開いて解消」など）。 */
  title?: string
  /** 危ない状態のパスを赤で出す（コンフリクト）。 */
  danger?: boolean
}>()
</script>

<template>
  <!-- 中に操作のボタンを置くので `<button>` にはできない（入れ子にできない）。キーでも選べるよう
       tabindex と Enter を持たせる。 -->
  <div
    class="file-row"
    :class="{ selected }"
    :title="title"
    tabindex="0"
    role="button"
    @keydown.enter.self="($event.currentTarget as HTMLElement).click()"
  >
    <span class="file-status" :style="{ color: gitStatusColor(status) }">{{ status }}</span>
    <span class="file-path" :class="{ danger }" :title="title ? undefined : path">
      <template v-if="oldPath">{{ oldPath }} → </template>{{ path }}
    </span>
    <template v-if="added != null">
      <span class="add-count">+{{ added }}</span>
      <span class="del-count">-{{ removed ?? 0 }}</span>
    </template>
    <span v-if="$slots.default" class="row-actions" @click.stop><slot /></span>
  </div>
</template>

<style scoped>
.file-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 12px;
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}

.file-row:hover {
  background: var(--tab-hover-bg);
}

.file-row.selected {
  background: var(--accent);
  color: var(--on-accent);
}

/* 塗りの上では、状態とファイル名以外も読める色にそろえる（`--text-active` は地の色を
   見ないので、ライトテーマの青地で沈む）。 */
.file-row.selected .add-count,
.file-row.selected .del-count {
  color: var(--on-accent-muted);
}

.file-status {
  font-family: "PlemolJP Console NF", "Cascadia Code", "Fira Code", monospace;
  font-weight: 600;
  width: 12px;
  flex-shrink: 0;
}

.file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-path.danger {
  color: var(--danger);
}

.add-count {
  color: var(--git-add);
  font-size: 11px;
}

.del-count {
  color: var(--git-delete);
  font-size: 11px;
}

.row-actions {
  display: none;
  align-items: center;
  gap: 2px;
}

.file-row:hover .row-actions,
.file-row.selected .row-actions {
  display: inline-flex;
}

.row-actions :deep(button) {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border: none;
  border-radius: 2px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.row-actions :deep(button:hover) {
  background: var(--tab-hover-bg);
}
</style>
