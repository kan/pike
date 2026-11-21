<script setup lang="ts">
/**
 * ターミナルのチラ見のポップアップ（#319 / #631）。プロジェクトのプルダウン（`ProjectSelect.vue`）と
 * セッションの一覧の印（`TerminalPeekMark.vue`）が同じものを使う。
 * 中身を読む口は `composables/useTerminalPeek.ts`（判断の正本はそちらの doc）。
 *
 * 呼ぶ側はアイコンの `mouseenter` で `show`、`mouseleave` で `hide` を呼ぶ。**どのタブを覗くかは
 * 関数で渡す**: ホバーしているあいだに対象が変わりうる（プロジェクトで最後に選んでいたターミナル、
 * ポーリングで作り直されるセッションの行）ので、取り直すたびに引き直す。
 */
import { computed, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { useAnchoredPopup } from '../composables/useAnchoredPopup'
import { childWebviewShown } from '../composables/useChildWebview'
import { peekTerminal, type TerminalPeekHandle, terminalLastOutputAt } from '../composables/useTerminalPeek'
import { useI18n } from '../i18n'
import { relativeTime } from '../lib/paths'
import { useSettingsStore } from '../stores/settings'

const props = defineProps<{
  /**
   * 手前に浮くものの数（`lib/overlay.ts`）に数えられたポップアップ（プルダウン）の中から出すときは真。
   * そのあいだ子 webview（ブラウザのタブ・プレビュー）は隠れているので、いつでも出してよい。
   *
   * 偽（セッションの一覧）のときは、**子 webview がページを重ねているあいだ出さない**。
   * アイコンをなぞるだけで出入りするので、Git パネルのコミットのツールチップと同じ扱いにする
   * （`frontend.md` の「手前に浮くものの数」。`useOverlay` に登録すると、なぞるたびにページが
   * 出入りして点滅する）。
   */
  nested?: boolean
}>()

const { t } = useI18n()
const settingsStore = useSettingsStore()

/** 出す行数。一覧の横に出すので、画面を圧迫せずに「何をしているか」が読める長さ。 */
const PEEK_LINES = 15
/** ホバー中の取り直し。`snapshot` は 15 行の `translateToString` なので軽い。 */
const PEEK_INTERVAL_MS = 500

const peekEl = useTemplateRef<HTMLElement>('peekEl')
const popup = useAnchoredPopup(peekEl)
/** 覗いているタブを引く関数。null なら出していない。 */
const resolver = ref<(() => string | null) | null>(null)
/** ホバーしているアイコン。消えたか隠れたかを取り直しのたびに確かめる。 */
let anchorEl: HTMLElement | null = null
const shown = computed(() => resolver.value !== null && (props.nested || !childWebviewShown()))

/**
 * 見せている中身。**行と時刻を 1 つに持つ**（常に一緒に書き換わり、一緒に読まれる）。
 *
 * 時刻は文字列で持つ。`relativeTime` の結果を computed に置くと、元の値が変わらない
 * 限り再計算されず、**時間が経っても「たった今」のまま固まる**。
 */
const content = ref<{ lines: string[]; age: string | null }>({ lines: [], age: null })
let timer: ReturnType<typeof setInterval> | null = null

function refresh() {
  // **アンカーが消えた・隠れたら閉じる。** そのときは `mouseleave` が来ない（消えたノードへの
  // 配送はブラウザ任せ）。行がポーリングで一覧から外れる、タブやパネルがショートカットで
  // 切り替わる、などで起きる。放っておくと浮いたまま残る（`pointer-events: none` なので
  // 押して消せない）。
  if (!anchorEl?.isConnected || anchorEl.getClientRects().length === 0) {
    hide()
    return
  }
  // 出していないあいだ（子 webview がページを重ねている）は中身を読まない。
  if (!shown.value) return
  const tabId = resolver.value?.() ?? null
  if (!tabId) {
    content.value = { lines: [], age: null }
    return
  }
  const at = terminalLastOutputAt(tabId)
  content.value = { lines: peekTerminal(tabId, PEEK_LINES), age: at ? relativeTime(at) : null }
}

async function show(resolve: () => string | null, anchor: HTMLElement) {
  anchorEl = anchor
  resolver.value = resolve
  refresh()
  if (timer) clearInterval(timer)
  timer = setInterval(refresh, PEEK_INTERVAL_MS)
  await place()
}

/**
 * **横に出す**（`placeBesideAnchor`）。上下に出すと一覧そのものに重なって、どの行の
 * ものか分からなくなる。出していないあいだは測れないので何もしない（下の watch が出した時点で置く）。
 */
async function place() {
  if (anchorEl && shown.value) await popup.placeBeside(anchorEl.getBoundingClientRect())
}

// ホバーの途中で子 webview が退いたら、その時点で中身を読んで置く（`show` のときは測れなかった）。
watch(shown, (now, before) => {
  if (now && !before && resolver.value) {
    refresh()
    void place()
  }
})

function hide() {
  resolver.value = null
  anchorEl = null
  popup.reset()
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

onUnmounted(hide)

defineExpose<TerminalPeekHandle>({ show, hide })
</script>

<template>
  <!--
    **`body` へ出す。** 呼ぶ側は `SideBar` / `TabBar` の `.ui-zoom` の中に置かれうる。UI のフォント
    サイズを既定から変えると `zoom` が 1 でなくなり、`position: fixed` の基準がその祖先になって
    `left` / `top` も測った矩形も倍率ぶんずれる（`TabBar.vue` の管理者メニューが「.ui-zoom の外に
    置く」としているのと同じ罠）。`pointer-events: none` なのは、マウスがアイコンの上にあるあいだ
    だけ出るため。
  -->
  <Teleport to="body">
    <div v-if="shown" ref="peekEl" class="peek-popup popup-surface" :style="popup.style.value">
      <div v-if="content.age" class="peek-head">{{ content.age }}</div>
      <!--
        **ターミナルと同じフォントで描く**（設定画面のプレビューと同じ形）。既定の
        `monospace` のままだと、罫線・ブロック文字・全角の幅が xterm と揃わず、
        TUI の画面が崩れて出る。
      -->
      <pre
        v-if="content.lines.length > 0"
        class="peek-body"
        :style="{ fontFamily: settingsStore.fontFamily }"
      >{{ content.lines.join('\n') }}</pre>
      <div v-else class="peek-empty">{{ t('project.peekEmpty') }}</div>
    </div>
  </Teleport>
</template>

<style scoped>
.peek-popup {
  position: fixed;
  z-index: 1001; /* プルダウン（1000）の上 */
  max-width: 60vw;
  padding: 4px 0;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  /* マウスはアイコンの上にあるあいだだけ出るので、この矩形は当たり判定を持たない。 */
  pointer-events: none;
}

.peek-head {
  padding: 0 8px 2px;
  color: var(--text-secondary);
  font-size: 11px;
}

.peek-body {
  margin: 0;
  padding: 0 8px;
  /* font-family はターミナルの設定から流し込む（テンプレート側） */
  font-size: 11px;
  line-height: 1.35;
  white-space: pre;
  overflow: hidden;
  color: var(--text-primary);
}

.peek-empty {
  padding: 0 8px;
  color: var(--text-secondary);
  font-size: 11px;
  font-style: italic;
}
</style>
