/**
 * GFM footnotes for the Markdown preview (#241).
 *
 * `marked` does not implement them, and its failure mode is not "shows the raw
 * text": `[^1]` parses as a link whose target is the note (`<a href="note">`)
 * and the definition line disappears into a link definition. The toolbar can
 * insert a footnote, so the preview has to be able to read one back.
 *
 * Definitions render where they are written rather than being collected into a
 * section at the end. In practice that is the same place — the toolbar appends
 * them to the file, and so does everyone writing by hand — and it keeps this to
 * a pair of tokenizers with no cross-token bookkeeping to get wrong.
 */

import type { MarkedExtension, Tokens } from 'marked'

/** `[^id]: note`, plus any indented continuation lines under it. */
const DEF_RE = /^\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n[ \t]+[^\n]*)*)/
/** `[^id]` in running text. */
const REF_RE = /^\[\^([^\]\s]+)\]/

interface FootnoteToken extends Tokens.Generic {
  id: string
}

export function footnotes(): MarkedExtension {
  // Per-parse state. `preprocess` runs once at the start of every parse, which
  // is what keeps numbering from carrying over between renders of a document.
  let numbers = new Map<string, number>()
  let referenced = new Set<string>()
  let defined = new Set<string>()

  const numberFor = (id: string): number => {
    const known = numbers.get(id)
    if (known !== undefined) return known
    const next = numbers.size + 1
    numbers.set(id, next)
    return next
  }

  return {
    extensions: [
      {
        name: 'footnoteDef',
        level: 'block',
        // `start` is handed the source minus its first character, and marked
        // cuts the paragraph at `index + 1`. So the only definition it can
        // report is one that begins a line *after* this point — hence the
        // leading newline. Matching `^` under /m instead reported an offset in
        // the middle of a line, which chopped the paragraph in two and, when
        // the two halves were rejoined, swallowed a newline into whatever code
        // span happened to be there.
        start(src: string) {
          const m = /\n\[\^[^\]\s]+\]:/.exec(src)
          return m ? m.index + 1 : undefined
        },
        tokenizer(src: string) {
          const m = DEF_RE.exec(src)
          if (!m) return undefined
          // Block tokenizing finishes before any inline pass starts (marked
          // queues the inline work), so every definition is known by the time a
          // reference has to decide whether it is one.
          defined.add(m[1])
          return {
            type: 'footnoteDef',
            raw: m[0],
            id: m[1],
            // Dedent the continuation lines so the note reads as one paragraph.
            tokens: this.lexer.inlineTokens(m[2].replace(/\n[ \t]+/g, '\n')),
          } as FootnoteToken
        },
        renderer(token) {
          const t = token as FootnoteToken
          const num = numberFor(t.id)
          const body = this.parser.parseInline(t.tokens ?? [])
          // Only worth offering when there is somewhere to go back to.
          const back = referenced.has(t.id) ? ` <a class="footnote-back" href="#fnref-${num}">↩</a>` : ''
          return `<div class="footnote" id="fn-${num}"><span class="footnote-num">${num}.</span> ${body}${back}</div>\n`
        },
      },
      {
        name: 'footnoteRef',
        level: 'inline',
        start(src: string) {
          const at = src.indexOf('[^')
          return at < 0 ? undefined : at
        },
        tokenizer(src: string) {
          const m = REF_RE.exec(src)
          // Only a marker with a definition behind it. `[^a-z]` in prose is a
          // character class, and swallowing it would delete the text, link to
          // nothing, and take a number away from the footnotes below it.
          if (!m || !defined.has(m[1])) return undefined
          return { type: 'footnoteRef', raw: m[0], id: m[1] } as FootnoteToken
        },
        renderer(token) {
          const t = token as FootnoteToken
          const num = numberFor(t.id)
          // Only the first reference carries the id: repeating it would put the
          // same anchor in the document twice.
          const id = referenced.has(t.id) ? '' : ` id="fnref-${num}"`
          referenced.add(t.id)
          return `<sup class="footnote-ref"${id}><a href="#fn-${num}">${num}</a></sup>`
        },
      },
    ],
    hooks: {
      preprocess(markdown: string) {
        numbers = new Map()
        referenced = new Set()
        defined = new Set()
        return markdown
      },
    },
  }
}
