import { getCurrentWindow } from '@tauri-apps/api/window'
import { ref } from 'vue'

/** Label of the current window. Opaque: 'main', 'project-<uuid>', 'global-<uuid>'.
 *  The project a 'project-' window shows comes from the backend window_projects
 *  map (via projectForWindow), not from parsing this label. */
export const windowLabel = getCurrentWindow().label

/**
 * このウィンドウがアクティブか。**フォーカスを見たいものはここを読む。**
 *
 * 元は Rust の `WindowEvent::Focused` で、アクリルを付け外しする判断（#277）と
 * **同じ信号**。`document.hasFocus()` を見ないのは、タイトルバーだけをクリックして
 * ウィンドウがアクティブになったとき（webview にフォーカスが入らない）にネイティブ側と
 * ずれるため。ウィンドウに 1 つで足りるので購読もモジュールで 1 回だけ行う。
 *
 * アクティブなあいだだけポーリングしたいだけなら、直接 watch せず
 * `composables/useFocusPolling.ts` を使う（4 ストアが同じ形を持っている）。
 *
 * ネイティブの signal にしたことで、**トレイやタスクバーから復帰したときにも
 * ポーリングが再開する**（`restore_window` の経路は webview にフォーカスが入る保証が
 * なく、以前はページ内をクリックするまで 4 つとも止まったままで、ブランチと使用量が
 * 古いまま座っていた）。代償は、タイトルバーだけをクリックしてアクティブにした状態でも
 * ポーリングが回り続けること（WSL プロジェクトなら `wsl.exe` が 10 秒 / 15 秒ごと）。
 */
// 初回の onFocusChanged が届くまでの起動値。ウィンドウは `.visible(false)` で作って
// あとから show するので、ここは「たぶんこう」以上の意味を持たない。
export const windowFocused = ref(document.hasFocus())
void getCurrentWindow().onFocusChanged(({ payload }) => {
  windowFocused.value = payload
})

/**
 * WebView のカラースキーム（`prefers-color-scheme`）を app のテーマに追従させる。
 * Windows では Tauri の `set_theme` が WebView2 の PreferredColorScheme を設定するため、
 * これでマニュアルプレビューの `<picture>` 等が OS ではなく Pike のテーマに従う。
 * null でシステム追従（既定）に戻す。失敗は無害（機能低下のみ）。
 */
export async function setWebviewTheme(theme: 'light' | 'dark' | null): Promise<void> {
  const pin = theme !== null
  // 生成直後のウィンドウは既に追従状態（`tauri.conf.json` にも `build_window` にもテーマの
  // 指定は無い）。既定が追従なので、これが無いと**全ウィンドウが起動のたびに no-op の
  // IPC を 2 往復**払う。
  if (!pin && !themePinned) return
  themePinned = pin
  try {
    await getCurrentWindow().setTheme(theme)
    // pin を外したら OS の値を読み直す。**この 2 つは必ず対で動かす**（呼び出し側の手順に
    // しないこと）: pin のあいだ `systemDark` の更新を捨てているので、繋ぎ忘れると
    // 「明示モードから追従へ戻した直後だけ、古い明暗で数十 ms 描かれる」という一過性の
    // 症状になり、型でも拾えない。
    if (!pin) systemDark.value = (await getCurrentWindow().theme()) === 'dark'
  } catch (e) {
    console.error('[window] setTheme failed:', e)
  }
}

/**
 * OS のテーマ（#310）。**システム追従モードのときだけ意味を持つ。**
 *
 * **`setTheme(null)` と対で使うこと。** 明示的に `'dark'` / `'light'` を渡したウィンドウには、
 * 以後 OS 側の変更が届かない（`onThemeChanged` が発火しなくなる）。追従するあいだは `null` を
 * 渡して、監視を Tauri 自身に委ねる必要がある。
 *
 * ウィンドウごとに購読する（ストアは各ウィンドウに 1 つ）。**解決結果を配らない**のが方針で、
 * ウィンドウ間で共有するのは「どのモードか」だけ。
 *
 * **初期値は `matchMedia` から同期で取る。** `theme()` は IPC の往復ぶん遅れるので、既定が
 * 追従で OS がダークの環境では、起動のたびにライトの 1 フレームが挟まる（ストアは mount の
 * 同期処理の中で作られ、テーマの適用が `immediate` で走る）。この時点ではまだ `setTheme` を
 * 呼んでいないので、webview の `prefers-color-scheme` は OS の値そのもの。
 */
export const systemDark = ref(window.matchMedia('(prefers-color-scheme: dark)').matches)

/**
 * 明示的なテーマを pin しているか。**このモジュールの外へ出さない。**
 *
 * **`onThemeChanged` は OS 側の変更だけでなく、自分が呼んだ `setTheme` でも発火する。**
 * これを見ないと、OS がダークの環境で「ライト」を選んだ瞬間に `systemDark` が false へ
 * 汚染される（`systemDark` が持つべきなのは「OS のテーマ」で、「このウィンドウの実効
 * テーマ」ではない）。汚染すると、追従へ戻した瞬間に**pin していた側の明暗で 1 度描かれて
 * から**正しい値に飛ぶ。読み直し（`setWebviewTheme` の中）が直すのはそのあとなので、
 * フラグを外すとちらつきが必ず出る。
 *
 * **OS のテーマを別経路で聞く形は採れない。** Tauri の JS API に独立した情報源は無く、
 * `matchMedia` も `theme()` も自分の `setTheme` に汚染される（だから `systemDark` の初期値は
 * 「まだ `setTheme` を呼んでいない」時点でだけ `matchMedia` を使える）。この判断の記録は
 * `.claude/rules/frontend.md` にある。
 */
let themePinned = false

void getCurrentWindow().onThemeChanged(({ payload }) => {
  if (themePinned) return
  systemDark.value = payload === 'dark'
})

export function isMainWindow(): boolean {
  return windowLabel === 'main'
}

/** Project-independent global-mode window (sidebar-less editor/terminal).
 *  Must match GLOBAL_PREFIX in src-tauri/src/lib.rs. */
export function isGlobalWindow(): boolean {
  return windowLabel.startsWith('global-')
}

/** Reactive global-mode flag. `global-` windows always start in it; the main
 *  window enters it on cold start with file args (App.vue sets it). UI that
 *  is project-bound (sidebar, switcher, status bar project label) hides on it. */
export const globalMode = ref(isGlobalWindow())

/** Whether this Pike process runs elevated (Windows administrator). Static per
 *  process; App.vue resolves it once at startup via `is_elevated`. Drives the
 *  admin indicator (status bar shield, window title). */
export const elevated = ref(false)

/** Transient window whose session must not be persisted. Set for the elevated
 *  admin project window (#138): it runs in a separate process sharing the same
 *  project config, so saving its lean single-terminal session would clobber the
 *  real session written by the non-elevated instance. */
export const ephemeralWindow = ref(false)
