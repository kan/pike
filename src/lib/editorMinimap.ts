import { showMinimap } from '@replit/codemirror-minimap'
import { diffField } from './editorGitGutter'

function create() {
  const dom = document.createElement('div')
  dom.style.cssText = 'width: 60px;'
  return { dom }
}

export function minimap() {
  return showMinimap.compute(['doc', diffField], (state) => {
    const diff = state.field(diffField, false)
    const gutters: Record<number, string>[] = []
    if (diff) {
      const gutter: Record<number, string> = {}
      for (const line of diff.added) gutter[line] = 'rgba(46, 160, 67, 0.7)'
      for (const line of diff.modified) gutter[line] = 'rgba(210, 153, 34, 0.7)'
      for (const line of diff.deleted) gutter[line] = 'rgba(248, 81, 73, 0.8)'
      gutters.push(gutter)
    }
    return {
      create,
      displayText: 'blocks' as const,
      showOverlay: 'always' as const,
      gutters,
    }
  })
}
