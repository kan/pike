<script setup lang="ts">
import DOMPurify from 'dompurify'
import { ArrowUp, Home, Moon, RefreshCw, Sun } from 'lucide-vue-next'
import { marked } from 'marked'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from '../../i18n'
import {
  DEFAULT_REF,
  fetchManual,
  getManualRef,
  isInManual,
  isMarkdownPage,
  MANUAL_INDEX,
  manualBlobUrl,
  manualRawUrl,
  resolveManualPath,
} from '../../lib/manual'
import { createHeadingSlugger } from '../../lib/slug'
import { openUrlWithConfirm } from '../../lib/tauri'
import { useSettingsStore } from '../../stores/settings'
import { useTabStore } from '../../stores/tabs'
import type { ManualTab } from '../../types/tab'

const props = defineProps<{ tabId: string }>()
const { t } = useI18n()
const tabStore = useTabStore()
const settingsStore = useSettingsStore()

const tab = computed(() => tabStore.tabs.find((t): t is ManualTab => t.id === props.tabId && t.kind === 'manual'))
const page = computed(() => tab.value?.page ?? MANUAL_INDEX)

const html = ref('')
const loading = ref(false)
const error = ref('')
const containerRef = ref<HTMLDivElement>()
const scrolled = ref(false)
const backStack = ref<string[]>([])
/** Path of the page currently rendered (without the `#anchor` part). */
const loadedPath = ref('')
/** The ref (version tag or `main`) the manual is served from. */
const manualRef = ref('')
/** A version-tag ref (`vX.Y.Z`) means the manual matches the app; `main` is the
 *  latest/dev fallback. */
// Pinned = served from a version tag rather than the `main` fallback.
const manualRefPinned = computed(() => manualRef.value !== '' && manualRef.value !== DEFAULT_REF)

/**
 * マニュアルだけのダーク/ライト切替。app の darkMode とは独立に、このタブの表示テーマを
 * 切り替える。初期値は app のテーマに合わせ、以降はトグルで固定（app 側の変更には追従しない）。
 * chrome はコンテナの data-theme（theme.css の属性セレクタが部分木へ適用）で、画像は
 * <picture> を manualDark に応じて light/dark の <img> に畳んで切り替える。
 */
const manualDark = ref(settingsStore.darkMode)

function toggleManualTheme() {
  manualDark.value = !manualDark.value
}

function scrollBehavior(): ScrollBehavior {
  return settingsStore.previewSmoothScroll ? 'smooth' : 'auto'
}

/** Split a path from its fragment, which stays raw and keeps its leading `#`. */
function splitHash(p: string): [string, string] {
  const i = p.indexOf('#')
  return i === -1 ? [p, ''] : [p.slice(0, i), p.slice(i)]
}

/** Split a `page` value into its path and (decoded) `#anchor`. */
function splitPage(p: string): [string, string] {
  const [path, fragment] = splitHash(p)
  const anchor = fragment.slice(1)
  try {
    return [path, decodeURIComponent(anchor)]
  } catch {
    return [path, anchor]
  }
}

/** Tear down any image-load listeners wired up by the previous anchor scroll. */
let cancelAnchorReflow: (() => void) | null = null

function scrollToAnchor(id: string) {
  cancelAnchorReflow?.()
  cancelAnchorReflow = null

  const c = containerRef.value
  if (!c) return
  const target = () => c.querySelector(`#${CSS.escape(id)}`)
  target()?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' })

  // Images above the anchor are fetched from GitHub and still have zero height at
  // this point; once they load the page reflows and pushes the heading away from
  // where we just scrolled. Re-snap to the target as each pending image settles.
  const pending = Array.from(c.querySelectorAll('img')).filter((img) => !img.complete)
  if (pending.length === 0) return
  let remaining = pending.length
  const onSettle = () => {
    target()?.scrollIntoView({ block: 'start' })
    if (--remaining === 0) cancelAnchorReflow?.()
  }
  for (const img of pending) {
    img.addEventListener('load', onSettle)
    img.addEventListener('error', onSettle)
  }
  cancelAnchorReflow = () => {
    for (const img of pending) {
      img.removeEventListener('load', onSettle)
      img.removeEventListener('error', onSettle)
    }
    cancelAnchorReflow = null
  }
}

async function render(path: string, force = false) {
  loading.value = true
  error.value = ''
  try {
    const md = await fetchManual(path, force)
    manualRef.value = await getManualRef() // resolved by fetchManual; memoized
    if (splitPage(page.value)[0] !== path) return // navigated away while fetching
    html.value = DOMPurify.sanitize(marked.parse(md) as string)
    await nextTick()
    postProcess(path)
    setTitle(path)
    loadedPath.value = path
  } catch (e) {
    error.value = String(e)
    html.value = ''
  } finally {
    loading.value = false
  }
}

function resolveImgUrl(p: string, rel: string): string {
  return /^(?:https?:|data:)/i.test(rel) ? rel : manualRawUrl(resolveManualPath(p, rel))
}

function postProcess(p: string) {
  const c = containerRef.value
  if (!c) return
  // Heading ids for in-page anchors.
  const slug = createHeadingSlugger()
  for (const h of c.querySelectorAll('h1, h2, h3, h4, h5, h6')) h.id = slug(h.textContent ?? '')
  // light/dark 切替の <picture> を、両テーマの URL を持つ 1 枚の <img> に畳む。
  // <source media="...light..."> が light、フォールバック <img src> が dark。manualDark で src を選ぶ。
  for (const pic of c.querySelectorAll('picture')) {
    const lightRel = pic.querySelector('source[media*="light"]')?.getAttribute('srcset') ?? ''
    const inner = pic.querySelector('img')
    const darkRel = inner?.getAttribute('src') ?? ''
    const img = document.createElement('img')
    img.alt = inner?.getAttribute('alt') ?? ''
    img.dataset.light = resolveImgUrl(p, lightRel || darkRel)
    img.dataset.dark = resolveImgUrl(p, darkRel)
    img.src = manualDark.value ? img.dataset.dark : img.dataset.light
    pic.replaceWith(img)
  }
  // 残りの相対 <img>（単一テーマ）を raw GitHub URL へ解決する（picture 由来は絶対 URL なのでスキップ）。
  for (const img of c.querySelectorAll('img')) {
    const src = img.getAttribute('src')
    if (src && !/^(?:https?:|data:)/i.test(src)) img.src = manualRawUrl(resolveManualPath(p, src))
  }
}

/** manualDark に応じて light/dark 画像を差し替える（再フェッチ不要）。 */
function applyManualTheme() {
  const c = containerRef.value
  if (!c) return
  for (const img of c.querySelectorAll<HTMLImageElement>('img[data-dark]')) {
    const url = manualDark.value ? img.dataset.dark : img.dataset.light
    if (url) img.src = url
  }
}

watch(manualDark, applyManualTheme)

function setTitle(path: string) {
  if (!tab.value) return
  const h1 = containerRef.value?.querySelector('h1')?.textContent?.trim()
  tab.value.title = h1 || path.split('/').pop() || 'Manual'
}

function navigate(to: string) {
  if (!tab.value || to === page.value) return
  backStack.value.push(page.value)
  tab.value.page = to
}

function goBack() {
  const prev = backStack.value.pop()
  if (prev && tab.value) tab.value.page = prev
}

function goHome() {
  navigate(MANUAL_INDEX)
}

/** Reload the current page, bypassing the cache (re-fetch from GitHub). */
function reload() {
  void render(splitPage(page.value)[0], true)
}

function onClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a')
  if (!a) return
  const href = a.getAttribute('href')
  if (!href) return
  e.preventDefault()

  if (/^https?:/i.test(href)) {
    void openUrlWithConfirm(href)
    return
  }
  if (href.startsWith('#')) {
    const [, id] = splitPage(href)
    if (id) scrollToAnchor(id)
    return
  }
  // Relative link → another manual page (navigate), or somewhere else in the repo
  // (hand to the browser: github.com for Markdown, the raw file otherwise).
  //
  // Split the fragment off first: `isMarkdownPage` matches the extension at the very
  // end, so a `settings.md#エディタ` link would fail it and open as raw text in a
  // browser. `navigate` takes the `page#anchor` form and decodes the anchor itself,
  // so the fragment passes through untouched.
  const [target, fragment] = splitHash(href)
  const resolved = resolveManualPath(page.value, target)
  const md = isMarkdownPage(resolved)
  if (md && isInManual(resolved)) navigate(resolved + fragment)
  else void openUrlWithConfirm(md ? manualBlobUrl(resolved) : manualRawUrl(resolved))
}

function onScroll() {
  if (containerRef.value) scrolled.value = containerRef.value.scrollTop > 300
}

function scrollToTop() {
  containerRef.value?.scrollTo({ top: 0, behavior: scrollBehavior() })
}

watch(
  page,
  async (p) => {
    const [path, anchor] = splitPage(p)
    if (path !== loadedPath.value) await render(path)
    await nextTick()
    if (page.value !== p) return // navigated away during render
    if (anchor) scrollToAnchor(anchor)
    else containerRef.value?.scrollTo({ top: 0 })
    scrolled.value = false
  },
  { immediate: true },
)

onUnmounted(() => cancelAnchorReflow?.())
</script>

<template>
  <div class="manual-tab" :data-theme="manualDark ? 'dark' : 'light'">
    <div class="md-toolbar">
      <button class="tool-btn" :disabled="backStack.length === 0" :title="t('manual.back')" @click="goBack">←</button>
      <button class="tool-btn" :title="t('manual.home')" @click="goHome"><Home :size="14" :stroke-width="2" /></button>
      <span class="manual-path">{{ page }}</span>
      <span
        v-if="manualRef"
        class="manual-ref"
        :class="{ latest: !manualRefPinned }"
        :title="manualRefPinned ? t('manual.versionPinned') : t('manual.versionLatest')"
        >{{ manualRef }}</span
      >
      <button class="tool-btn" data-testid="manual-theme-toggle" :title="t('manual.toggleTheme')" @click="toggleManualTheme">
        <Sun v-if="manualDark" :size="14" :stroke-width="2" />
        <Moon v-else :size="14" :stroke-width="2" />
      </button>
      <button class="tool-btn" :title="t('common.refresh')" @click="reload">
        <RefreshCw :size="14" :stroke-width="2" :class="{ spin: loading }" />
      </button>
    </div>

    <div ref="containerRef" class="manual-body" @scroll="onScroll" @click="onClick">
      <div class="md-page md-body">
        <div v-if="error" class="manual-status error">
          {{ t('manual.loadError') }}<br /><code>{{ error }}</code>
        </div>
        <div v-else-if="loading && !html" class="manual-status">{{ t('common.loading') }}</div>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div v-html="html"></div>
      </div>
    </div>

    <button v-if="scrolled" class="back-to-top" :title="t('editor.backToTop')" @click="scrollToTop">
      <ArrowUp :size="18" :stroke-width="2" />
    </button>
  </div>
</template>

<style scoped>
.manual-tab {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  color: var(--text-primary);
}

/* ツールバー（`.md-toolbar`）とそのボタン（`.tool-btn`）、読み幅（`.md-page`）、
   本文の見た目（`.md-body`）、回転（`.spin`）はすべて共有（`theme.css`）。issue タブと
   同じものを使う。 */

.manual-path {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
}

.manual-ref {
  flex-shrink: 0;
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: 10px;
  font-size: 10px;
  color: var(--text-secondary);
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  white-space: nowrap;
  cursor: default;
}

/* `main` (dev/latest) — distinguish from a pinned version tag. */
.manual-ref.latest {
  color: var(--accent);
  border-color: var(--accent);
}

.manual-body {
  flex: 1;
  overflow-y: auto;
}

.manual-status {
  color: var(--text-secondary);
  padding: 12px 0;
}

.manual-status.error code {
  color: var(--danger);
}

/* Markdown 本文の見た目は共有の `.md-body`（`theme.css`）。issue タブと同じものを使う。 */

.back-to-top {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  cursor: pointer;
  opacity: 0.75;
  box-shadow: 0 2px 8px var(--shadow-color);
}

.back-to-top:hover {
  opacity: 1;
  color: var(--text-active);
  background: var(--accent);
  border-color: var(--accent);
}
</style>
