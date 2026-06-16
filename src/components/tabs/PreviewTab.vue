<script setup lang="ts">
import { FlipHorizontal2, Grid2x2, Maximize2, RefreshCw, RotateCcw, RotateCw, ZoomIn, ZoomOut } from 'lucide-vue-next'
import { computed, nextTick, onUnmounted, ref } from 'vue'
import { useI18n } from '../../i18n'
import { useTabStore } from '../../stores/tabs'
import type { PreviewTab } from '../../types/tab'

const { t } = useI18n()
const props = defineProps<{ tabId: string }>()
const tabStore = useTabStore()

const tab = computed(() => tabStore.tabs.find((t): t is PreviewTab => t.id === props.tabId && t.kind === 'preview'))

const canvas = ref<HTMLElement | null>(null)
const zoom = ref(1)
const rotation = ref(0) // 0 / 90 / 180 / 270
const flipped = ref(false)
const checker = ref(false)
const naturalW = ref(0)
const naturalH = ref(0)

const MIN_ZOOM = 0.05
const MAX_ZOOM = 32
const PADDING = 40 // canvas padding allowance for fit calc

const rotated = computed(() => rotation.value % 180 !== 0)
const dispW = computed(() => naturalW.value * zoom.value)
const dispH = computed(() => naturalH.value * zoom.value)
// Rotated bounding box drives the scroll area so the image never overflows unreachably.
const stageW = computed(() => (rotated.value ? dispH.value : dispW.value))
const stageH = computed(() => (rotated.value ? dispW.value : dispH.value))

const stageStyle = computed(() => ({
  width: `${stageW.value}px`,
  height: `${stageH.value}px`,
}))
const imgStyle = computed(() => ({
  width: `${dispW.value}px`,
  height: `${dispH.value}px`,
  transform: `translate(-50%, -50%) rotate(${rotation.value}deg) scaleX(${flipped.value ? -1 : 1})`,
}))

const zoomPercent = computed(() => Math.round(zoom.value * 100))
const canPan = computed(() => {
  const el = canvas.value
  if (!el) return false
  return stageW.value > el.clientWidth + 1 || stageH.value > el.clientHeight + 1
})

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
}

function computeFitScale(): number {
  const el = canvas.value
  if (!el || !naturalW.value || !naturalH.value) return 1
  const bw = rotated.value ? naturalH.value : naturalW.value
  const bh = rotated.value ? naturalW.value : naturalH.value
  const cw = Math.max(1, el.clientWidth - PADDING)
  const ch = Math.max(1, el.clientHeight - PADDING)
  return Math.min(cw / bw, ch / bh)
}

// Shrink large images to fit the window, but never upscale small ones.
function shrinkToFit() {
  zoom.value = clampZoom(Math.min(1, computeFitScale()))
}

function onImgLoad(e: Event) {
  const img = e.target as HTMLImageElement
  naturalW.value = img.naturalWidth
  naturalH.value = img.naturalHeight
  shrinkToFit()
}

// Keep the point under the cursor (or the viewport centre) stable across a zoom step.
async function applyZoom(next: number, anchorX?: number, anchorY?: number) {
  const el = canvas.value
  const target = clampZoom(next)
  if (target === zoom.value) return
  if (!el) {
    zoom.value = target
    return
  }
  const rect = el.getBoundingClientRect()
  const px = anchorX !== undefined ? anchorX - rect.left : el.clientWidth / 2
  const py = anchorY !== undefined ? anchorY - rect.top : el.clientHeight / 2
  const sw = el.scrollWidth || 1
  const sh = el.scrollHeight || 1
  const ratioX = (el.scrollLeft + px) / sw
  const ratioY = (el.scrollTop + py) / sh
  zoom.value = target
  await nextTick()
  el.scrollLeft = ratioX * el.scrollWidth - px
  el.scrollTop = ratioY * el.scrollHeight - py
}

function zoomIn(x?: number, y?: number) {
  applyZoom(zoom.value * 1.25, x, y)
}
function zoomOut(x?: number, y?: number) {
  applyZoom(zoom.value / 1.25, x, y)
}
function reset100() {
  applyZoom(1)
}
function fit() {
  applyZoom(computeFitScale())
}
function rotateCW() {
  rotation.value = (rotation.value + 90) % 360
}
function rotateCCW() {
  rotation.value = (rotation.value + 270) % 360
}
function toggleFlip() {
  flipped.value = !flipped.value
}
function toggleChecker() {
  checker.value = !checker.value
}
function resetView() {
  rotation.value = 0
  flipped.value = false
  shrinkToFit()
  const el = canvas.value
  if (el) {
    el.scrollLeft = 0
    el.scrollTop = 0
  }
}

function onWheel(e: WheelEvent) {
  if (!e.ctrlKey) return // plain wheel scrolls normally
  e.preventDefault()
  if (e.deltaY < 0) zoomIn(e.clientX, e.clientY)
  else zoomOut(e.clientX, e.clientY)
}

function onDblClick(e: MouseEvent) {
  if (Math.abs(zoom.value - 1) < 0.01) fit()
  else applyZoom(1, e.clientX, e.clientY)
}

// Drag-to-pan when the image overflows the canvas.
let panning = false
let panStartX = 0
let panStartY = 0
let scrollStartX = 0
let scrollStartY = 0

function onMouseDown(e: MouseEvent) {
  if (e.button !== 0 || !canPan.value || !canvas.value) return
  panning = true
  panStartX = e.clientX
  panStartY = e.clientY
  scrollStartX = canvas.value.scrollLeft
  scrollStartY = canvas.value.scrollTop
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  e.preventDefault()
}
function onMouseMove(e: MouseEvent) {
  if (!panning || !canvas.value) return
  canvas.value.scrollLeft = scrollStartX - (e.clientX - panStartX)
  canvas.value.scrollTop = scrollStartY - (e.clientY - panStartY)
}
function onMouseUp() {
  panning = false
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
}

// Drop any in-flight drag listeners if the tab is closed mid-pan.
onUnmounted(onMouseUp)

function onKeyDown(e: KeyboardEvent) {
  switch (e.key) {
    case '+':
    case '=':
      zoomIn()
      break
    case '-':
      zoomOut()
      break
    case '0':
      reset100()
      break
    case 'f':
      fit()
      break
    case 'r':
      if (e.shiftKey) rotateCCW()
      else rotateCW()
      break
    default:
      return
  }
  e.preventDefault()
}
</script>

<template>
  <div class="preview-tab">
    <div v-if="!tab" class="empty">{{ t('preview.notFound') }}</div>
    <template v-else>
      <div class="toolbar">
        <button class="tb-btn" :title="t('preview.zoomOut')" @click="zoomOut()"><ZoomOut :size="16" /></button>
        <button class="tb-btn zoom-label" :title="t('preview.resetZoom')" @click="reset100">{{ zoomPercent }}%</button>
        <button class="tb-btn" :title="t('preview.zoomIn')" @click="zoomIn()"><ZoomIn :size="16" /></button>
        <span class="sep" />
        <button class="tb-btn" :title="t('preview.fit')" @click="fit"><Maximize2 :size="16" /></button>
        <span class="sep" />
        <button class="tb-btn" :title="t('preview.rotateLeft')" @click="rotateCCW"><RotateCcw :size="16" /></button>
        <button class="tb-btn" :title="t('preview.rotateRight')" @click="rotateCW"><RotateCw :size="16" /></button>
        <button class="tb-btn" :class="{ active: flipped }" :title="t('preview.flip')" @click="toggleFlip"><FlipHorizontal2 :size="16" /></button>
        <span class="sep" />
        <button class="tb-btn" :class="{ active: checker }" :title="t('preview.checkerboard')" @click="toggleChecker"><Grid2x2 :size="16" /></button>
        <button class="tb-btn" :title="t('preview.reset')" @click="resetView"><RefreshCw :size="16" /></button>
        <span class="spacer" />
        <span v-if="naturalW" class="dims">{{ naturalW }} × {{ naturalH }}</span>
      </div>
      <div
        ref="canvas"
        class="canvas"
        :class="{ checker, pannable: canPan }"
        tabindex="0"
        @wheel="onWheel"
        @mousedown="onMouseDown"
        @dblclick="onDblClick"
        @keydown="onKeyDown"
      >
        <div class="stage" :style="stageStyle">
          <img :src="tab.dataUrl" :alt="tab.title" :style="imgStyle" draggable="false" @load="onImgLoad" />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.preview-tab {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  flex-shrink: 0;
}

.tb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 26px;
  padding: 0 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.tb-btn:hover {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}
.tb-btn.active {
  color: var(--accent);
}
.zoom-label {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  min-width: 48px;
}

.sep {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: var(--border);
}
.spacer {
  flex: 1;
}
.dims {
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

/* Scroll container — margin:auto on the stage centres the image without the
   flex `align-items: center` overflow bug that made tall images unscrollable. */
.canvas {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: auto;
  outline: none;
}
.canvas.pannable {
  cursor: grab;
}
.canvas.pannable:active {
  cursor: grabbing;
}
.canvas.checker {
  --c: var(--bg-tertiary);
  background-color: var(--bg-primary);
  background-image:
    linear-gradient(45deg, var(--c) 25%, transparent 25%),
    linear-gradient(-45deg, var(--c) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--c) 75%),
    linear-gradient(-45deg, transparent 75%, var(--c) 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0;
}

.stage {
  position: relative;
  margin: auto;
  flex-shrink: 0;
}
.stage img {
  position: absolute;
  top: 50%;
  left: 50%;
  user-select: none;
  -webkit-user-drag: none;
}

.empty {
  margin: auto;
  color: var(--text-secondary);
  font-size: 14px;
}
</style>
