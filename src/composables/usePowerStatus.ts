import { computed, type Ref, ref } from 'vue'
import { type BatteryLike, type PowerView, powerView } from '../lib/statusPower'

/**
 * 電源とバッテリーの状態（#467）。見せ方の規則と出典の選び方は `lib/statusPower.ts`。
 *
 * **状態はモジュールに 1 つで、最初に使われたときに取りに行く。** 表示の部品
 * （`StatusPower.vue`）の中に持たせない: ステータスバーは「出すものがあるか」で組ごと
 * 畳むので、取れているかを部品の外からも読めないと、取れなかったときに空の組と区切り
 * だけが残る。
 *
 * **値はイベントで受ける**（`chargingchange` / `levelchange`）。ポーリングはしない。
 * リスナは外さない（設定を切っても、届くのは電源の抜き差しと残量 1% ごとの変化だけ）。
 */
interface BatteryManager extends BatteryLike, EventTarget {}

const state = ref<BatteryLike | null>(null)
const view = computed(() => (state.value ? powerView(state.value) : null))
let started = false

function start() {
  if (started) return
  started = true
  const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryManager> }).getBattery
  if (!getBattery) return
  getBattery
    .call(navigator)
    .then((battery) => {
      const read = () => {
        state.value = { charging: battery.charging, level: battery.level }
      }
      battery.addEventListener('chargingchange', read)
      battery.addEventListener('levelchange', read)
      read()
    })
    // API があっても拒まれることはある。設定はオンなのに何も出ない理由を、ログに残す。
    .catch((e) => console.warn('navigator.getBattery failed:', e))
}

/** 電源の見せ方。**取れていないあいだと取れなかったときは null**（何も出さない）。 */
export function usePowerStatus(): Readonly<Ref<PowerView | null>> {
  start()
  return view
}
