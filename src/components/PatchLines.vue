<script setup lang="ts">
import type { PatchLine } from '../lib/commitPatch'

/**
 * 統合形式の差分の表 1 枚（`PatchSplit.vue` の右のペイン、#374 / #526）。
 *
 * **コンポーネントに分けてあるのは描き直しを閉じ込めるため。** 表は仮想化していないので、
 * 1 ファイルで数千行の vnode になる。`PatchSplit` の slot（コミットの欄・一覧）は
 * `PatchSplit` の render の中で描かれるので、表が同じ render にあると、コミットメッセージの
 * 打鍵や 10 秒ごとの `git status` のたびに表まで作り直される。子にしておけば、props
 * （`lines` / `side` / `wrap`）が変わらない限り描き直されない。
 */
defineProps<{
  lines: PatchLine[]
  /** 片側だけを出す（新旧を上下に並べた表示の 1 面）。省くと行番号を 2 列出す統合形式。 */
  side?: 'old' | 'new'
  /** 長い行を折り返すか（#453）。折り返さないときは外側が横にスクロールする。 */
  wrap: boolean
}>()
</script>

<template>
  <table class="patch-table" :class="{ nowrap: !wrap }">
    <tbody>
      <tr v-for="(line, i) in lines" :key="i" :class="line.type">
        <td v-if="side !== 'new'" class="num">{{ line.oldNum ?? '' }}</td>
        <td v-if="side !== 'old'" class="num">{{ line.newNum ?? '' }}</td>
        <td class="code">{{ line.text }}</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.patch-table {
  width: 100%;
  border-collapse: collapse;
  font-family: "PlemolJP Console NF", "Cascadia Code", "Fira Code", monospace;
  font-size: 12px;
  line-height: 18px;
}

.num {
  width: 1%;
  min-width: 36px;
  padding: 0 6px;
  text-align: right;
  color: var(--text-secondary);
  opacity: 0.5;
  user-select: none;
  white-space: nowrap;
  vertical-align: top;
}

.code {
  padding: 0 8px;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 折り返さない（#453）。表が最長行の幅まで広がり、外側が横にスクロールする。1 枚の表を
   1 つの領域に描いているだけなので、diff タブのような左右の連動は要らない。 */
.nowrap .code {
  white-space: pre;
  word-break: normal;
}

.add {
  background: rgba(78, 201, 176, 0.1);
}

.del {
  background: rgba(244, 71, 71, 0.1);
}

.hunk {
  background: rgba(0, 122, 204, 0.08);
  color: var(--accent);
}

.note .code {
  color: var(--text-secondary);
  font-style: italic;
}
</style>
