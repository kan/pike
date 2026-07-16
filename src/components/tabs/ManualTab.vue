<script setup lang="ts">
import DOMPurify from 'dompurify'
import { ArrowUp, Home, Moon, RefreshCw, Sun } from 'lucide-vue-next'
import { marked } from 'marked'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from '../../i18n'
import {
  fetchManual,
  getManualRef,
  isMarkdownPage,
  MANUAL_INDEX,
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
const manualRefPinned = computed(() => /^v\d/.test(manualRef.value))

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

/** Split a `page` value into its path and (decoded) `#anchor`. */
function splitPage(p: string): [string, string] {
  const i = p.indexOf('#')
  if (i === -1) return [p, '']
  let anchor = p.slice(i + 1)
  try {
    anchor = decodeURIComponent(anchor)
  } catch {
    /* raw */
  }
  return [p.slice(0, i), anchor]
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
    let id = href.slice(1)
    try {
      id = decodeURIComponent(id)
    } catch {
      /* raw */
    }
    if (id) scrollToAnchor(id)
    return
  }
  // Relative link → another manual page (navigate) or open externally.
  const resolved = resolveManualPath(page.value, href)
  if (isMarkdownPage(resolved)) navigate(resolved)
  else void openUrlWithConfirm(manualRawUrl(resolved))
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
    <div class="manual-toolbar">
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
      <div class="manual-content">
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

.manual-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.tool-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  padding: 0 6px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  font-size: 13px;
}

.tool-btn:hover:not(:disabled) {
  color: var(--text-active);
  background: var(--tab-hover-bg);
}

.tool-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

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

.spin {
  animation: spin 1s linear infinite;
}

.manual-body {
  flex: 1;
  overflow-y: auto;
}

.manual-content {
  max-width: 820px;
  margin: 0 auto;
  padding: 16px 32px 48px;
  line-height: 1.7;
}

.manual-status {
  color: var(--text-secondary);
  padding: 12px 0;
}

.manual-status.error code {
  color: var(--danger);
}

/* Markdown rendering */
.manual-content :deep(h1),
.manual-content :deep(h2),
.manual-content :deep(h3),
.manual-content :deep(h4) {
  color: var(--text-active);
  line-height: 1.3;
  margin: 1.4em 0 0.6em;
}
.manual-content :deep(h1) {
  font-size: 1.7em;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.3em;
}
.manual-content :deep(h2) {
  font-size: 1.4em;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.2em;
}
.manual-content :deep(h3) {
  font-size: 1.15em;
}
.manual-content :deep(p),
.manual-content :deep(ul),
.manual-content :deep(ol),
.manual-content :deep(blockquote) {
  margin: 0.6em 0;
}
.manual-content :deep(a) {
  color: var(--accent);
  text-decoration: none;
  cursor: pointer;
}
.manual-content :deep(a:hover) {
  text-decoration: underline;
}
.manual-content :deep(img) {
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: 4px;
}
.manual-content :deep(code) {
  background: var(--bg-tertiary);
  padding: 0.1em 0.4em;
  border-radius: 3px;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 0.9em;
}
.manual-content :deep(pre) {
  background: var(--bg-tertiary);
  padding: 10px 12px;
  border-radius: 4px;
  overflow-x: auto;
}
.manual-content :deep(pre code) {
  background: none;
  padding: 0;
}
.manual-content :deep(blockquote) {
  border-left: 3px solid var(--border);
  padding-left: 12px;
  color: var(--text-secondary);
}
.manual-content :deep(table) {
  border-collapse: collapse;
  margin: 0.8em 0;
  display: block;
  overflow-x: auto;
}
.manual-content :deep(th),
.manual-content :deep(td) {
  border: 1px solid var(--border);
  padding: 5px 10px;
  text-align: left;
}
.manual-content :deep(th) {
  background: var(--bg-tertiary);
}
.manual-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 1.4em 0;
}

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
