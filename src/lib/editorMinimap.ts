import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'
import { diffField, setDiffLines } from './editorGitGutter'

const MINIMAP_WIDTH = 60
const MAX_LINES = 5000

const minimapPlugin = ViewPlugin.fromClass(
  class {
    canvas: HTMLCanvasElement
    ctx: CanvasRenderingContext2D
    wrapper: HTMLDivElement
    viewport: HTMLDivElement
    rafId = 0
    contentDirty = true
    // Track drag listeners for cleanup
    private dragCleanup: (() => void) | null = null

    constructor(readonly view: EditorView) {
      this.wrapper = document.createElement('div')
      this.wrapper.className = 'cm-minimap'
      this.wrapper.style.cssText = `position:absolute;right:0;top:0;bottom:0;width:${MINIMAP_WIDTH}px;overflow:hidden;cursor:pointer;`

      this.canvas = document.createElement('canvas')
      this.canvas.style.cssText = 'width:100%;height:100%;'
      this.wrapper.appendChild(this.canvas)

      this.viewport = document.createElement('div')
      this.viewport.className = 'cm-minimap-viewport'
      this.viewport.style.cssText = 'position:absolute;left:0;right:0;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);pointer-events:none;min-height:8px;'
      this.wrapper.appendChild(this.viewport)

      this.ctx = this.canvas.getContext('2d')!

      this.wrapper.addEventListener('mousedown', this.onMouseDown)

      view.scrollDOM.parentElement!.style.paddingRight = MINIMAP_WIDTH + 'px'
      view.scrollDOM.parentElement!.appendChild(this.wrapper)

      this.scheduleRender()
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.geometryChanged) {
        this.contentDirty = true
        this.scheduleRender()
        return
      }
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(setDiffLines)) {
            this.contentDirty = true
            this.scheduleRender()
            return
          }
        }
      }
      if (update.viewportChanged) {
        this.updateViewportIndicator()
      }
    }

    scheduleRender() {
      if (this.rafId) return
      this.rafId = requestAnimationFrame(() => {
        this.rafId = 0
        this.render()
      })
    }

    updateViewportIndicator() {
      const rect = this.wrapper.getBoundingClientRect()
      const scroller = this.view.scrollDOM
      const scrollFrac = scroller.scrollTop / (scroller.scrollHeight || 1)
      const viewFrac = scroller.clientHeight / (scroller.scrollHeight || 1)
      this.viewport.style.top = (scrollFrac * rect.height) + 'px'
      this.viewport.style.height = Math.max(viewFrac * rect.height, 8) + 'px'
    }

    render() {
      const { view, canvas, ctx } = this
      const rect = this.wrapper.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const w = Math.floor(rect.width * dpr)
      const h = Math.floor(rect.height * dpr)

      if (this.contentDirty) {
        this.contentDirty = false
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w
          canvas.height = h
        }
        ctx.clearRect(0, 0, w, h)

        const doc = view.state.doc
        const totalLines = Math.min(doc.lines, MAX_LINES)
        if (totalLines === 0) return

        const pixelsPerLine = h / totalLines
        const lineH = Math.max(pixelsPerLine, 1)
        const diff = view.state.field(diffField, false)

        // Use iterLines for O(n) instead of O(n log n)
        let lineNum = 0
        const iter = doc.iterLines()
        while (!iter.next().done && lineNum < MAX_LINES) {
          lineNum++
          const text = iter.value
          const y = (lineNum - 1) * pixelsPerLine

          if (diff) {
            if (diff.added.has(lineNum)) {
              ctx.fillStyle = 'rgba(46, 160, 67, 0.6)'
              ctx.fillRect(0, y, 3 * dpr, lineH)
            } else if (diff.modified.has(lineNum)) {
              ctx.fillStyle = 'rgba(210, 153, 34, 0.6)'
              ctx.fillRect(0, y, 3 * dpr, lineH)
            } else if (diff.deleted.has(lineNum)) {
              ctx.fillStyle = 'rgba(248, 81, 73, 0.8)'
              ctx.fillRect(0, y, 3 * dpr, lineH)
            }
          }

          if (text.trim().length > 0) {
            const indent = text.length - text.trimStart().length
            const contentLen = Math.min(text.trimEnd().length - indent, 80)
            const x = (indent * 0.8 + 4) * dpr
            const barW = Math.max(contentLen * 0.5 * dpr, 2)
            ctx.fillStyle = 'rgba(180, 180, 180, 0.25)'
            ctx.fillRect(x, y, barW, Math.max(lineH - 0.5, 1))
          }
        }
      }

      this.updateViewportIndicator()
    }

    onMouseDown = (e: MouseEvent) => {
      e.preventDefault()
      this.scrollToY(e.clientY)
      const onMove = (ev: MouseEvent) => this.scrollToY(ev.clientY)
      const onUp = () => {
        this.dragCleanup = null
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      this.dragCleanup = onUp
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }

    scrollToY(clientY: number) {
      const rect = this.wrapper.getBoundingClientRect()
      const frac = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
      const doc = this.view.state.doc
      const targetLine = Math.min(Math.floor(frac * doc.lines) + 1, doc.lines)
      const pos = doc.line(targetLine).from
      this.view.dispatch({
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      })
    }

    destroy() {
      if (this.rafId) cancelAnimationFrame(this.rafId)
      this.dragCleanup?.()
      this.wrapper.removeEventListener('mousedown', this.onMouseDown)
      this.view.scrollDOM.parentElement!.style.paddingRight = ''
      this.wrapper.remove()
    }
  },
)

export function minimap() {
  return [minimapPlugin]
}
