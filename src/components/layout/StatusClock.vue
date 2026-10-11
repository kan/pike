<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { locale } from '../../i18n'
import { formatStatusClock, formatStatusTooltip } from '../../lib/statusClock'
import { windowFocused } from '../../lib/window'
import { useSettingsStore } from '../../stores/settings'

/**
 * ステータスバーの右端の日付と時刻。タスクバーを自動的に隠して使うと OS の時計が
 * 見えなくなるので、その代わりに出す（設定の `statusBarDate` / `statusBarTime`。既定は
 * どちらも出さない）。表記の規則は `lib/statusClock.ts`。
 *
 * **`StatusBar.vue` に直に書かず、部品に分けてある。** あちらは桁と行番号を描いている
 * 都合で打鍵のたびに再描画されるので、整形をその中に置くとそのたびに走る。逆に、
 * こちらの 1 分ごとの更新であちらを丸ごと描き直すことも無い。
 */
const settings = useSettingsStore()
const label = ref('')
const title = ref('')

/**
 * 次の分の変わり目に合わせて張り直す。**`setInterval` にしない**: スリープからの復帰や
 * 隠れているあいだの間引きでずれたとき、ずれたまま 1 分ごとに回り続ける。毎回いまの
 * 時刻から残りを数え直せば、遅れて鳴っても次で揃う。
 *
 * **見えていないあいだも止めない。** 止めると、戻ったことを `visibilitychange` と
 * フォーカスだけで知ることになり、どちらも来ない戻り方（トレイから `show` されただけ）で
 * 古い時刻のまま止まる。時計が嘘を言うほうが、1 分に 1 回の起床より高くつく。
 *
 * 日付しか出していないときも 1 分ごとに回す（日付の変わり目まで待つ形に分けるほどの
 * 費用ではない）。
 */
let timer: ReturnType<typeof setTimeout> | undefined
function tick() {
  clearTimeout(timer)
  const now = new Date()
  label.value = formatStatusClock(settings.statusBarDate, settings.statusBarTime, now, locale.value)
  title.value = formatStatusTooltip(now, locale.value)
  timer = setTimeout(tick, 60_000 - (now.getTime() % 60_000))
}
// 表記か言語を変えたら、その場で描き直す。
watch([() => settings.statusBarDate, () => settings.statusBarTime, locale], tick, { immediate: true })

// 戻ってきたときはその場で合わせる（隠れているあいだや非アクティブのあいだは、タイマーが
// 間引かれて遅れることがある）。
document.addEventListener('visibilitychange', tick)
watch(windowFocused, (focused) => {
  if (focused) tick()
})

onUnmounted(() => {
  clearTimeout(timer)
  document.removeEventListener('visibilitychange', tick)
})
</script>

<template>
  <span class="status-clock" :title="title">{{ label }}</span>
</template>

<style scoped>
/* 分が変わっても幅が動かないようにする（左隣の項目が揺れる）。 */
.status-clock {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
</style>
