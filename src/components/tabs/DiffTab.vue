<script setup lang="ts">
import { computed } from "vue";
import { useTabStore } from "../../stores/tabs";
import type { DiffTab } from "../../types/tab";

const props = defineProps<{ tabId: string }>();
const tabStore = useTabStore();

const tab = computed(() =>
  tabStore.tabs.find((t): t is DiffTab => t.id === props.tabId && t.kind === "diff")
);

interface Segment {
  text: string;
  highlight: boolean;
}

interface DiffSide {
  num: number | null;
  segments: Segment[];
  type: string;
}

interface DiffLine {
  left: DiffSide;
  right: DiffSide;
}

function plain(text: string): Segment[] {
  return [{ text, highlight: false }];
}

// Compute character-level diff between two strings
function charDiff(oldStr: string, newStr: string): { left: Segment[]; right: Segment[] } {
  // Find common prefix
  let prefix = 0;
  while (prefix < oldStr.length && prefix < newStr.length && oldStr[prefix] === newStr[prefix]) {
    prefix++;
  }
  // Find common suffix (not overlapping with prefix)
  let suffixOld = oldStr.length;
  let suffixNew = newStr.length;
  while (suffixOld > prefix && suffixNew > prefix && oldStr[suffixOld - 1] === newStr[suffixNew - 1]) {
    suffixOld--;
    suffixNew--;
  }

  const left: Segment[] = [];
  const right: Segment[] = [];

  if (prefix > 0) {
    left.push({ text: oldStr.slice(0, prefix), highlight: false });
    right.push({ text: newStr.slice(0, prefix), highlight: false });
  }
  const oldMid = oldStr.slice(prefix, suffixOld);
  const newMid = newStr.slice(prefix, suffixNew);
  if (oldMid) left.push({ text: oldMid, highlight: true });
  if (newMid) right.push({ text: newMid, highlight: true });
  if (suffixOld < oldStr.length) {
    left.push({ text: oldStr.slice(suffixOld), highlight: false });
    right.push({ text: newStr.slice(suffixNew), highlight: false });
  }

  return { left: left.length ? left : [{ text: "", highlight: false }],
           right: right.length ? right : [{ text: "", highlight: false }] };
}

const parsedLines = computed((): DiffLine[] => {
  if (!tab.value) return [];
  const lines = tab.value.diff.split("\n");
  const result: DiffLine[] = [];
  let leftNum = 0;
  let rightNum = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        leftNum = parseInt(match[1]) - 1;
        rightNum = parseInt(match[2]) - 1;
      }
      inHunk = true;
      result.push({
        left: { num: null, segments: plain(line), type: "hunk" },
        right: { num: null, segments: plain(""), type: "hunk" },
      });
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith("-")) {
      leftNum++;
      result.push({
        left: { num: leftNum, segments: plain(line.slice(1)), type: "del" },
        right: { num: null, segments: plain(""), type: "empty" },
      });
    } else if (line.startsWith("+")) {
      rightNum++;
      const lastUnpaired = findLastUnpairedDel(result);
      if (lastUnpaired !== -1) {
        // Compute character-level highlight for paired lines
        const oldText = result[lastUnpaired].left.segments.map(s => s.text).join("");
        const newText = line.slice(1);
        const { left: leftSegs, right: rightSegs } = charDiff(oldText, newText);
        result[lastUnpaired].left.segments = leftSegs;
        result[lastUnpaired].right = { num: rightNum, segments: rightSegs, type: "add" };
      } else {
        result.push({
          left: { num: null, segments: plain(""), type: "empty" },
          right: { num: rightNum, segments: plain(line.slice(1)), type: "add" },
        });
      }
    } else if (line.startsWith("\\")) {
      // skip
    } else {
      leftNum++;
      rightNum++;
      result.push({
        left: { num: leftNum, segments: plain(line.slice(1)), type: "ctx" },
        right: { num: rightNum, segments: plain(line.slice(1)), type: "ctx" },
      });
    }
  }

  return result;
});

function findLastUnpairedDel(lines: DiffLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = lines[i];
    if (r.left.type === "del" && r.right.type === "empty") return i;
    if (r.left.type !== "del") break;
  }
  return -1;
}
</script>

<template>
  <div class="diff-tab">
    <div v-if="!tab" class="empty">Diff not found</div>
    <div v-else-if="!parsedLines.length && tab.diff" class="empty">
      {{ tab.diff.includes('Binary files') ? 'Binary file — diff not available' : tab.diff.slice(0, 200) }}
    </div>
    <div v-else-if="!parsedLines.length" class="empty">No changes</div>
    <div v-else class="diff-container">
      <table class="diff-table">
        <tbody>
          <tr v-for="(row, i) in parsedLines" :key="i" class="diff-row">
            <td class="line-num" :class="row.left.type">{{ row.left.num ?? "" }}</td>
            <td class="line-content" :class="row.left.type"><template
              v-for="(seg, j) in row.left.segments" :key="j"
            ><span :class="{ 'hl': seg.highlight }">{{ seg.text }}</span></template></td>
            <td class="line-num" :class="row.right.type">{{ row.right.num ?? "" }}</td>
            <td class="line-content" :class="row.right.type"><template
              v-for="(seg, j) in row.right.segments" :key="j"
            ><span :class="{ 'hl': seg.highlight }">{{ seg.text }}</span></template></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.diff-tab {
  position: absolute;
  inset: 0;
  overflow: auto;
  background: var(--bg-primary);
}

.diff-container {
  min-width: 100%;
}

.diff-table {
  width: 100%;
  border-collapse: collapse;
  font-family: "PlemolJP Console NF", "Cascadia Code", "Fira Code", monospace;
  font-size: 12px;
  line-height: 1.5;
  table-layout: fixed;
}

.diff-row {
  height: 20px;
}

.line-num {
  width: 40px;
  min-width: 40px;
  padding: 0 6px;
  text-align: right;
  color: var(--text-secondary);
  opacity: 0.5;
  user-select: none;
  border-right: 1px solid var(--border);
  font-size: 11px;
}

.line-content {
  padding: 0 8px;
  white-space: pre;
  overflow: hidden;
}

.line-content:nth-child(2) {
  border-right: 1px solid var(--border);
}

.del {
  background: rgba(244, 71, 71, 0.1);
}

.del .hl {
  background: rgba(244, 71, 71, 0.3);
  border-radius: 2px;
}

.add {
  background: rgba(78, 201, 176, 0.1);
}

.add .hl {
  background: rgba(78, 201, 176, 0.3);
  border-radius: 2px;
}

.hunk {
  background: rgba(0, 122, 204, 0.08);
  color: var(--accent);
}

.empty {
  background: var(--bg-secondary);
}

.diff-tab > .empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-secondary);
  font-size: 14px;
}
</style>
