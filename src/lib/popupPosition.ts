// Placement for fixed-position popups (tooltips, context menus) — #204.
//
// The size of these popups depends on their content (a commit message can be
// one line or thirty), so callers measure the rendered element and then place
// it. Rendering it hidden for that one frame is what keeps the measurement from
// flashing at the provisional spot.

/** Gap kept between a popup and the window edge. */
const MARGIN = 8
/** Gap between a popup and the element it is anchored to. */
const ANCHOR_GAP = 4

export interface PopupSize {
  width: number
  height: number
}

export interface PopupPoint {
  x: number
  y: number
}

/** Slide a popup back inside the viewport. A popup taller or wider than the
 *  viewport is aligned to the top-left edge; capping its size is the caller's
 *  job (CSS `max-height`), since only it knows what may be dropped. */
export function clampToViewport(point: PopupPoint, size: PopupSize): PopupPoint {
  return {
    x: Math.max(MARGIN, Math.min(point.x, window.innerWidth - size.width - MARGIN)),
    y: Math.max(MARGIN, Math.min(point.y, window.innerHeight - size.height - MARGIN)),
  }
}

/**
 * Place a popup above `anchor`, or below it when there is no room above — the
 * commit list sits near the top of the sidebar, so a tall tooltip anchored
 * above it used to run off the screen (#204). Left-aligned with the anchor.
 */
export function placeNearAnchor(anchor: DOMRect, size: PopupSize): PopupPoint {
  const above = anchor.top - ANCHOR_GAP - size.height
  const y = above >= MARGIN ? above : anchor.bottom + ANCHOR_GAP
  return clampToViewport({ x: anchor.left, y }, size)
}
