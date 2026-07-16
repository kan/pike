import type mermaidType from 'mermaid'

let mermaidInstance: typeof mermaidType | null = null

export async function getMermaid(): Promise<typeof mermaidType> {
  if (!mermaidInstance) {
    const mod = await import('mermaid')
    mermaidInstance = mod.default
    mermaidInstance.initialize({
      startOnLoad: false,
      theme: 'dark',
      // 'antiscript' keeps HTML labels enabled (htmlLabels defaults to true
      // regardless of securityLevel, so foreignObject labels still get the dark
      // theme's colors) while mermaid's own DOMPurify pass strips scripts and
      // event handlers from label text. Unlike 'loose' it also blocks the
      // click/`javascript:` href interactions. We insert the rendered SVG as-is
      // (mermaid's documented usage) — do NOT run it through our SVG_PURIFY_OPTS
      // sanitizer, which drops the foreignObject label contents and blanks every
      // label. Untrusted standalone .svg files are still sanitized in EditorTab.
      securityLevel: 'antiscript',
    })
  }
  return mermaidInstance
}
