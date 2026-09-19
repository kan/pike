import type { GitLogEntry } from '../types/git'

const LANE_COLORS = [
  'var(--accent)',
  'var(--graph-lane-1)',
  'var(--graph-lane-2)',
  'var(--graph-lane-3)',
  'var(--graph-lane-4)',
  'var(--graph-lane-5)',
]

export interface GraphLine {
  fromCol: number
  toCol: number
  color: string
}

export interface GraphRow {
  hash: string
  /** The log entry this row draws, so the view doesn't re-index `logEntries` by position. */
  entry: GitLogEntry
  column: number
  lines: GraphLine[] // lines continuing through this row
  mergeLines: GraphLine[] // lines merging into this commit
  /**
   * Parents outside the fetched range (#371), drawn as a short dashed line from the dot
   * toward `toCol` that stops before the row's edge (the lane is freed, so the next row may
   * put an unrelated commit there). They don't get a lane: nothing below would ever close it, so it would
   * run to the bottom of the list and widen every row.
   */
  stubs: GraphLine[]
  /**
   * The commit's own lane is drawn only where it really runs (#374): the upper half when a
   * child above was waiting for it, the lower half when its first parent keeps the lane.
   * Drawing both halves unconditionally left a stray segment at every branch point (the
   * parent is already on another lane, so nothing continues below) and at every branch tip,
   * which read as the graph breaking off mid-list.
   */
  hasChild: boolean
  continuesDown: boolean
  isMerge: boolean
  color: string
  refs: string
  maxCol: number
}

/**
 * Build a graph representation from git log entries.
 * Each entry must have `hash` and `parents` fields.
 */
export function buildGraph(entries: GitLogEntry[]): GraphRow[] {
  // activeLanes[i] = hash of the commit expected in lane i, or null if free
  const activeLanes: (string | null)[] = []
  const rows: GraphRow[] = []
  const fetched = new Set(entries.map((e) => e.hash))

  function laneColor(col: number): string {
    return LANE_COLORS[col % LANE_COLORS.length]
  }

  function findLane(hash: string): number {
    return activeLanes.indexOf(hash)
  }

  function allocLane(): number {
    const free = activeLanes.indexOf(null)
    if (free !== -1) return free
    activeLanes.push(null)
    return activeLanes.length - 1
  }

  for (const entry of entries) {
    let col = findLane(entry.hash)
    // A lane holds a hash only because a child above reserved it for its parent.
    const hasChild = col !== -1
    if (col === -1) {
      col = allocLane()
      activeLanes[col] = entry.hash
    }

    const color = laneColor(col)
    const isMerge = entry.parents.length > 1

    // Build continuation lines for all active lanes
    const lines: GraphLine[] = []
    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i] !== null && i !== col) {
        lines.push({ fromCol: i, toCol: i, color: laneColor(i) })
      }
    }

    // Handle parents
    const mergeLines: GraphLine[] = []
    const stubs: GraphLine[] = []
    const firstParent = entry.parents[0] ?? null

    // Clear this commit's lane
    activeLanes[col] = null

    if (firstParent && !fetched.has(firstParent)) {
      stubs.push({ fromCol: col, toCol: col, color })
    } else if (firstParent) {
      // First parent takes this commit's lane
      const existingLane = findLane(firstParent)
      if (existingLane === -1) {
        activeLanes[col] = firstParent
      } else {
        // First parent already has a lane — draw merge line
        mergeLines.push({ fromCol: col, toCol: existingLane, color })
      }
    }

    // Second+ parents (merge sources)
    for (let pi = 1; pi < entry.parents.length; pi++) {
      const parentHash = entry.parents[pi]
      if (!fetched.has(parentHash)) {
        stubs.push({ fromCol: col, toCol: col + 1, color: laneColor(col + 1) })
        continue
      }
      const existingLane = findLane(parentHash)
      if (existingLane !== -1) {
        mergeLines.push({ fromCol: col, toCol: existingLane, color: laneColor(existingLane) })
      } else {
        const newLane = allocLane()
        activeLanes[newLane] = parentHash
        mergeLines.push({ fromCol: col, toCol: newLane, color: laneColor(newLane) })
      }
    }

    const continuesDown = firstParent !== null && activeLanes[col] === firstParent

    // Compact: trim trailing nulls
    while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === null) {
      activeLanes.pop()
    }

    const maxCol = Math.max(
      col,
      ...lines.map((l) => Math.max(l.fromCol, l.toCol)),
      ...mergeLines.map((l) => Math.max(l.fromCol, l.toCol)),
      ...stubs.map((l) => l.toCol),
      0,
    )

    rows.push({
      hash: entry.hash,
      entry,
      column: col,
      lines,
      mergeLines,
      stubs,
      hasChild,
      continuesDown,
      isMerge,
      color,
      refs: entry.refs,
      maxCol,
    })
  }

  return rows
}

export const ROW_HEIGHT = 24
export const LANE_WIDTH = 12
export const DOT_RADIUS = 3
