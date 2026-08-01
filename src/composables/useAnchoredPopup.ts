import { computed, nextTick, type Ref, ref } from 'vue'
import { clampToViewport, type PopupPoint, placeNearAnchor } from '../lib/popupPosition'

export interface AnchoredPopup {
  /** Bind to its `:style` — position plus the visibility gate. */
  style: Ref<{ left: string; top: string; visibility: 'visible' | 'hidden' }>
  /** Place it against an element: above when there is room, else below. */
  placeNear: (anchor: DOMRect) => Promise<void>
  /** Place it at a cursor point, clamped into the viewport. */
  placeAt: (point: PopupPoint) => Promise<void>
  /** Hide it again. Call when closing, so the next open cannot flash at the
   *  previous position. */
  reset: () => void
}

/**
 * A fixed-position popup that only appears once it has been measured (#204).
 *
 * Tooltips and context menus are sized by their content — a commit message can
 * be one line or thirty — so where they fit is only knowable after they render.
 * The element is therefore rendered hidden, measured, and then positioned; the
 * measurement resolves on a microtask, so nothing is painted at the provisional
 * spot. `visibility: hidden` (not `display: none`, which cannot be measured, and
 * not `opacity: 0`, which still takes clicks) is what makes that work.
 *
 * CSS anchor positioning (`anchor-name` + `position-try-fallbacks`) would do all
 * of this declaratively, but it needs Chromium 125+ and Tauri cannot pin the
 * user's WebView2 version. Its failure mode is a popup in the wrong place rather
 * than an error, so it is not worth the silent risk yet.
 *
 * `el` comes from `useTemplateRef('name')`, matching a `ref="name"` on the
 * popup's root element.
 */
export function useAnchoredPopup(el: Readonly<Ref<HTMLElement | null>>): AnchoredPopup {
  const pos = ref<PopupPoint | null>(null)

  const style = computed(() => ({
    left: `${pos.value?.x ?? 0}px`,
    top: `${pos.value?.y ?? 0}px`,
    visibility: (pos.value ? 'visible' : 'hidden') as 'visible' | 'hidden',
  }))

  /** Size of the just-rendered element, or null when it is gone again (the
   *  pointer can leave, or another click can land, during the wait). */
  async function measure() {
    await nextTick()
    return el.value?.getBoundingClientRect() ?? null
  }

  async function placeNear(anchor: DOMRect) {
    const size = await measure()
    if (size) pos.value = placeNearAnchor(anchor, size)
  }

  async function placeAt(point: PopupPoint) {
    const size = await measure()
    if (size) pos.value = clampToViewport(point, size)
  }

  function reset() {
    pos.value = null
  }

  return { style, placeNear, placeAt, reset }
}
