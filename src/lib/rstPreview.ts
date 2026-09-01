/**
 * reStructuredText のプレビュー（#284）。
 *
 * **自前で書いているのは、使える変換器が無いため。** JS の rst → HTML は `rst2html` /
 * `restructured` くらいで、どちらも 2022 年で更新が止まっているうえ、`power-assert`（650KB）と
 * `commander`（207KB）を production dependencies に持っている（テストと CLI のものが誤って
 * 入っている形）。「軽さ最優先」「不要な npm パッケージを追加しない」という方針とは釣り合わない。
 *
 * **したがってこれは docutils の再実装ではない。** 実際に書かれる文書でよく出る要素だけを扱い、
 * **解釈できなかったものは捨てずに字面のまま出す**。プレビューは読むためのもので、変換に失敗した
 * 箇所が消えるほうが困る。字面へ落とすのは、セルを結合した表・知らないディレクティブ・置換指定で、
 * `toctree` / `include` / `math` / `raw` もそこに含まれる（他ファイルの一覧・外部ファイルの
 * 読み込み・数式描画・生 HTML の埋め込みで、プレビューで解決する意味が薄いか、そのまま通すと
 * 危ないもの）。**本文に出さないのは、真のコメントとリンク定義だけ。**
 *
 * 組み立てた HTML は呼び出し側（`EditorTab.vue`）が DOMPurify に通すが、**それを唯一の防波堤に
 * しない**。エスケープ済みかどうかは `lib/text.ts` の `Html` 型で持ち、生の文字列を属性へ差し込む
 * 経路がコンパイルエラーになるようにしてある。
 */

import { displayWidth, sliceByWidth } from './displayWidth'
import { asHtml, escapeHtml, escapeRegExp, type Html, splitDelimited } from './text'

/** 見出しに使える記号（docutils が認めるもの）。どれが何レベルかは文書ごとに決まる。 */
const ADORNMENT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'

/** アドモニション（`.. note::` など）のうち、専用の見出しを付けて出すもの。 */
const ADMONITIONS = new Set(['attention', 'caution', 'danger', 'error', 'hint', 'important', 'note', 'tip', 'warning'])

/**
 * 組み上げた断片を一時的に伏せるための囲み。**私用領域の文字を使う**: 本文に現れないうえ、
 * 制御文字と違って正規表現に書いても lint に引っかからない。
 */
const HOLE_OPEN = ''
const HOLE_CLOSE = ''
/** 定数 2 つから作るので、`renderInline` のたびに組み直さない（段落とセルの数だけ呼ばれる）。 */
const HOLE_RE = new RegExp(`${HOLE_OPEN}(\\d+)${HOLE_CLOSE}`, 'g')

/** 箇条書きの記号（`-` `*` `+` `•`）。 */
const BULLET = /^([-*+•])\s+(.*)$/
/** 番号付き（`1.` `1)` `(1)` `#.`）。 */
const ENUM = /^(\(?[0-9]+[.)]|#\.)\s+(.*)$/
/** フィールドリスト（`:key: value`）。 */
const FIELD = /^:([^:]+):\s*(.*)$/
/** ディレクティブ（`.. name:: argument`）。 */
const DIRECTIVE = /^\.\.\s+([\w-]+)::\s*(.*)$/
/** ハイパーリンクの定義（`.. _name: url`）。本文には出さず、参照の解決に使う。 */
const LINK_TARGET = /^\.\.\s+_([^:]+):\s*(.*)$/
/** 脚注と引用の定義（`.. [1] 本文` / `.. [CIT2002] 本文`）。 */
const NOTE_DEF = /^\.\.\s+\[([^\]]+)\]\s+(.*)$/

/**
 * 脚注・引用の 1 件。**`key` は id に使う**ので、ラベルの `#` や `*` をそのまま持ち込まない。
 * `display` は定義側の見出し（脚注は `1.`、引用は `[CIT2002]`）、`ref` は参照側の短い表記。
 */
interface Note {
  key: string
  display: string
  ref: string
}

/** 参照の解決に要る、文書ぜんたいの情報。段落やセルを組むどの経路にも同じものが渡る。 */
interface RstContext {
  /** 名前 → URL（エスケープ済み）。 */
  links: Map<string, Html>
  /** 脚注・引用のラベル → 表示のしかた。 */
  notes: Map<string, Note>
}

/** 行頭のインデント幅（文字数）。 */
function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** 参照名の照合は大小文字と連続空白を無視する（docutils の規則）。 */
function normalizeRefName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * 定義済みのリンク名をまとめて探す正規表現。**文書につき 1 回だけ組む**（`links` をキーにした
 * WeakMap で持つ）。名前ごとに `new RegExp` を作っていたころは、段落とセルの数だけコンパイルが
 * 走り、リンクを多く持つ文書で目に見えて遅かった。
 *
 * 長い名前から並べるのは、選択肢が左から試されるため（`a` と `abc` を短い順に並べると、
 * `abc_` の `a` だけが先に当たる）。
 */
const refPatterns = new WeakMap<Map<string, Html>, RegExp | null>()

function refPattern(links: Map<string, Html>): RegExp | null {
  const cached = refPatterns.get(links)
  if (cached !== undefined) return cached
  const names = [...links.keys()].sort((a, b) => b.length - a.length).map((n) => escapeRegExp(escapeHtml(n)))
  const pattern = names.length ? new RegExp(`(?:${names.join('|')})_(?![\\w_])`, 'gi') : null
  refPatterns.set(links, pattern)
  return pattern
}

/** 属性に置いてよいスキーム。持たないもの（相対パス・`#`）はプレビュー内のリンクとして通す。 */
const SAFE_SCHEME = /^(https?|mailto)$/i

function anchor(href: Html, label: Html): Html {
  // **`Html` を受けるのは、生の URL が属性へ入る経路を型で塞ぐため**（引用符で属性を閉じられる）。
  // エスケープを解かないこと: 属性値の中の `&#34;` はブラウザが読むときにデコードするので、
  // そのままで正しく働く。
  //
  // スキームの検査は**空白と制御文字を落としてから**行う。ブラウザは `java&#9;script:` の
  // ようにタブを挟んだものも javascript: として解釈するので、素の文字列を見るだけでは足りない。
  const bare = [...href].filter((c) => (c.codePointAt(0) ?? 0) > 0x20).join('')
  const scheme = bare.match(/^([a-z][a-z0-9+.-]*):/i)
  const safe = !scheme || SAFE_SCHEME.test(scheme[1]) ? href : '#'
  return asHtml(`<a href="${safe}">${label}</a>`)
}

/**
 * インラインの記法を HTML にする。**エスケープしてから記法を当てる**ので、入力に含まれる
 * `<` は記法の解釈にも出力にも影響しない。
 *
 * 順番に意味がある。`` `` `` のリテラルを最初に伏せておかないと、その中の `*` が強調として
 * 食われる（rst のリテラルは Markdown のコードスパンと同じく中身を解釈しない）。**組み上げた
 * 断片も伏せる**: 見せたままだと、リンク名が生成済みの URL の中にも現れるときに、その URL の
 * 内側までアンカーに置き換えてしまう。
 */
function renderInline(text: string, ctx: RstContext): Html {
  const done: string[] = []
  const hide = (html: Html) => `${HOLE_OPEN}${done.push(html) - 1}${HOLE_CLOSE}`

  let out: string = escapeHtml(text).replace(/``([^`]+)``/g, (_, code: string) => hide(asHtml(`<code>${code}</code>`)))

  // 参照（`name`_ / `name <url>`_）。行き先が分からないものは字面のまま残す。
  out = out.replace(/`([^`]+)`__?/g, (whole: string, body: string) => {
    // 中身は既にエスケープ済みの文字列から切り出したもの。
    const embedded = body.match(/^(.*?)\s*&#60;(.+?)&#62;$/)
    if (embedded) return hide(anchor(asHtml(embedded[2]), asHtml(embedded[1] || embedded[2])))
    const target = ctx.links.get(normalizeRefName(body))
    return target ? hide(anchor(target, asHtml(body))) : whole
  })

  // 脚注・引用の参照（`[1]_` / `[#name]_` / `[CIT2002]_`）。定義のあるものだけリンクにする。
  // 名前付きの自動採番は定義側が `#` を落として登録するので、参照側でも落として引く。
  out = out.replace(/\[([^\]\s]+)\]_/g, (whole: string, label: string) => {
    const note = ctx.notes.get(noteKey(label))
    if (!note) return whole
    return hide(
      asHtml(`<sup class="footnote-ref" id="fnref-${note.key}"><a href="#fn-${note.key}">${note.ref}</a></sup>`),
    )
  })

  // バッククォート無しのリンク参照（`name_`）。**定義済みの名前だけを探す**のが要点で、
  // `\w+_` のような綴りで拾うと日本語の名前に当たらない（`\b` は日本語の境界を知らない）
  // うえ、`snake_case` の識別子まで参照に化ける。
  const pattern = refPattern(ctx.links)
  if (pattern) {
    out = out.replace(pattern, (matched: string) => {
      const name = matched.slice(0, -1)
      const url = ctx.links.get(normalizeRefName(name))
      return url ? hide(anchor(url, asHtml(name))) : matched
    })
  }

  out = out
    // 単一のバッククォートは既定ロール（title reference）。docutils は `<cite>` にする。
    .replace(/`([^`]+)`/g, '<cite>$1</cite>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // 開きと閉じの内側は空白でない、が rst の規則。無いと `A * B * C` が強調に化ける。
    .replace(/(^|[^*\w])\*(\S(?:[^*]*\S)?)\*(?!\*)/g, '$1<em>$2</em>')
    // 素の URL。rst は自動リンクするので合わせる。
    .replace(
      /(^|[\s(])(https?:\/\/[^\s<>()]+)/g,
      (_, lead: string, url: string) => lead + hide(anchor(asHtml(url), asHtml(url))),
    )

  return asHtml(out.replace(HOLE_RE, (_, i: string) => done[Number(i)]))
}

/** 行の集合から、共通のインデントを外す。 */
function dedent(lines: string[]): string[] {
  const widths = lines.filter((l) => l.trim()).map(indentOf)
  const min = widths.length ? Math.min(...widths) : 0
  return lines.map((l) => l.slice(min))
}

/** grid の罫線（`+---+---+` / `+===+===+`）。 */
function isGridRule(line: string): boolean {
  const t = line.trim()
  return t.length >= 3 && /^\+[-=+]+\+$/.test(t)
}

/** simple の罫線（`===== =====`）。 */
function isSimpleRule(line: string): boolean {
  const t = line.trim()
  return t.length >= 3 && /^=+(\s+=+)+$/.test(t)
}

/** 表の罫線か。組めなかった表を「段落として流さない」ための目印でもある。 */
function isTableRule(line: string): boolean {
  return isGridRule(line) || isSimpleRule(line)
}

/** 見出しの下線か（同じ記号が 2 つ以上続く行）。 */
function isAdornment(line: string): boolean {
  const t = line.trim()
  return t.length >= 2 && ADORNMENT.includes(t[0]) && [...t].every((c) => c === t[0])
}

/** 字面のまま見せる（解釈できなかったもの）。 */
function verbatim(lines: string[]): Html {
  return asHtml(`<pre><code>${escapeHtml(lines.join('\n'))}</code></pre>`)
}

/** 脚注（数字・`#`・`*`）か、引用（それ以外のラベル）か。 */
function isFootnoteLabel(label: string): boolean {
  return /^(\d+|#\S*|\*)$/.test(label)
}

/**
 * 脚注・引用を引くときのキー。**名前付きの自動採番（`[#name]`）は `#` を落とす**ので、
 * 定義側と参照側の両方がこれを通る（片方だけだと参照が解決できない）。
 */
function noteKey(label: string): string {
  const raw = label.trim()
  return normalizeRefName(raw.startsWith('#') && raw.length > 1 ? raw.slice(1) : raw)
}

/**
 * 文書ぜんたいから、参照の行き先（リンク・脚注・引用）を集める。
 *
 * **本文を組む前に一度だけ走る。** 定義は文書のどこにあってもよく、参照より後ろに書かれる
 * ことのほうが多いため。URL はここでエスケープしておく（`anchor` は `Html` しか受けない）。
 */
function collectContext(lines: string[], inherited?: RstContext): RstContext {
  // **入れ子のたびに複製しない。** 塊の中に定義が無ければ親のものをそのまま使い回す。
  // 複製すると `refPattern` のキャッシュ（Map の identity をキーにする）が塊ごとに外れ、
  // リンクの多い文書で正規表現の再コンパイルが効いてくる。
  const hasLink = lines.some((l) => LINK_TARGET.test(l))
  const hasNote = lines.some((l) => NOTE_DEF.test(l))
  if (!hasLink && !hasNote && inherited) return inherited

  const links = new Map<string, Html>(inherited?.links)
  const notes = new Map<string, Note>(inherited?.notes)

  for (let i = 0; i < lines.length; i++) {
    const link = lines[i].match(LINK_TARGET)
    if (link) {
      // 行を分けて書く形（`.. _name:` の次の行に URL）も拾う。よく使われる書き方で、
      // 取りこぼすと参照が宙に浮いたうえ、URL の行ごと本文から消える。
      let url = link[2].trim()
      if (!url) {
        const next = lines[i + 1]
        if (next?.trim() && indentOf(next) > 0) url = next.trim()
      }
      if (url) links.set(normalizeRefName(link[1]), escapeHtml(url))
      continue
    }
    const note = lines[i].match(NOTE_DEF)
    if (note) noteFor(note[1].trim(), notes)
  }
  return { links, notes }
}

/**
 * ラベルから `Note` を作って登録する（既にあればそれを返す）。**採番は登場順**で、`#` の自動
 * 採番も明示的な数字も同じ列に並べる。docutils は空き番号を探すが、プレビューでは順に振れば
 * 定義と参照が一致する。
 */
function noteFor(raw: string, notes: Map<string, Note>): Note {
  const key = noteKey(raw)
  const found = notes.get(key)
  if (found) return found

  const footnote = isFootnoteLabel(raw)
  const num = footnote ? [...notes.values()].filter((n) => n.display.endsWith('.')).length + 1 : 0
  const note: Note = footnote
    ? { key: `n${num}`, display: `${num}.`, ref: String(num) }
    : { key: `c-${key.replace(/[^\w-]/g, '')}`, display: `[${raw}]`, ref: raw }
  notes.set(key, note)
  return note
}

/**
 * `inherited` は入れ子（アドモニションの中身・リストの項目・セル）を組み直すときに渡す。
 * 文書のどこにあってもよい定義を、外側で集めたまま引き継ぐため。
 */
export function buildRstPreview(text: string, inherited?: RstContext): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const ctx = collectContext(lines, inherited)
  /** 見出しの記号 → レベル。**出現順で決まる**のが rst の規則で、記号そのものに意味は無い。 */
  const levels: string[] = []
  const out: string[] = []
  let i = 0

  /**
   * インデントされた塊を読み切って、共通インデントを外して返す（使う側は全員そうする）。
   * 間の空行は塊の一部だが、前後のものは含めない。
   */
  const takeIndented = (from: number): { body: string[]; next: number; blankFirst: boolean } => {
    const body: string[] = []
    let j = from
    while (j < lines.length) {
      if (lines[j].trim() === '') {
        body.push('')
        j++
        continue
      }
      if (indentOf(lines[j]) === 0) break
      body.push(lines[j])
      j++
    }
    // 先頭に空行があったかは返す。**脚注では段落の切れ目を意味する**（`.. [1] 一段落目` の
    // 次に空行を置いてから続きを書くと、docutils はそこで段落を分ける）。
    const blankFirst = body[0] === ''
    while (body.length && body[0] === '') body.shift()
    while (body.length && body[body.length - 1] === '') body.pop()
    return { body: dedent(body), next: j, blankFirst }
  }

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed === '') {
      i++
      continue
    }

    // 見出し（上線付き）。上線・題・下線の 3 行を 1 つとして読む。
    //
    // **同じ記号でも上線の有無で別のレベル**（docutils の規則）。よくある `===` の上線付きを
    // 文書の題、`===` の下線のみを章に使う書き方が、これが無いと同じ h1 に潰れる。
    if (isAdornment(trimmed) && i + 1 < lines.length && lines[i + 1].trim() && !isAdornment(lines[i + 1].trim())) {
      const title = lines[i + 1].trim()
      const skip = i + 2 < lines.length && isAdornment(lines[i + 2].trim()) ? 3 : 2
      out.push(heading(`${trimmed[0]}^`, title, levels, ctx))
      i += skip
      continue
    }
    // 見出し（下線のみ）。下線は題と同じ長さ以上でなければならない。
    if (i + 1 < lines.length && isAdornment(lines[i + 1].trim()) && lines[i + 1].trim().length >= trimmed.length) {
      out.push(heading(lines[i + 1].trim()[0], trimmed, levels, ctx))
      i += 2
      continue
    }

    // 表。**罫線の判定より先に置く**（`+---+` も `=====` も `isAdornment` に当たりうる）。
    // 組めなかったときは下の段落側が字面のまま出す。
    if (isTableRule(line)) {
      const table = isGridRule(line) ? parseGridTable(lines, i, ctx) : parseSimpleTable(lines, i, ctx)
      if (table) {
        out.push(table.html)
        i = table.next
        continue
      }
    }

    // 題を伴わない罫線は区切り。
    if (isAdornment(trimmed)) {
      out.push('<hr>')
      i++
      continue
    }

    // ディレクティブ。中身はインデントされた塊。
    const directive = trimmed.match(DIRECTIVE)
    if (directive) {
      const { body, next } = takeIndented(i + 1)
      out.push(renderDirective(directive[1].toLowerCase(), directive[2], body, ctx))
      i = next
      continue
    }

    // 脚注・引用の定義。定義は**書かれた場所に描く**（末尾に集めない）。この関数は入れ子でも
    // 呼ばれるので、集める先を決められない。
    const note = trimmed.match(NOTE_DEF)
    if (note) {
      const { body, next, blankFirst } = takeIndented(i + 1)
      // 定義行の残りと続きのあいだに空行があったなら、そこは段落の切れ目。
      out.push(renderNote(note[1].trim(), [note[2], ...(blankFirst ? [''] : []), ...body], ctx))
      i = next
      continue
    }

    if (trimmed.startsWith('..')) {
      const { body, next } = takeIndented(i + 1)
      // **本文から消してよいのは、真のコメントとリンク定義だけ。** ここは認識できなかった
      // 明示マークアップ全部の受け皿でもあるので、それらは字面のまま残す（置換指定など）。
      if (!LINK_TARGET.test(line) && /^\.\.\s+\|/.test(line)) out.push(verbatim([line, ...body]))
      i = next
      continue
    }

    // 単独の `::` に続くインデント塊はリテラルブロック。
    if (trimmed === '::') {
      const { body, next } = takeIndented(i + 1)
      out.push(verbatim(body))
      i = next
      continue
    }

    if (BULLET.test(trimmed) || ENUM.test(trimmed)) {
      const { html, next } = renderList(lines, i, ctx)
      out.push(html)
      i = next
      continue
    }

    if (FIELD.test(trimmed)) {
      const rows: string[] = []
      while (i < lines.length) {
        const m = lines[i].trim().match(FIELD)
        if (!m) break
        rows.push(`<tr><th>${escapeHtml(m[1])}</th><td>${renderInline(m[2], ctx)}</td></tr>`)
        i++
      }
      out.push(`<table class="rst-fields"><tbody>${rows.join('')}</tbody></table>`)
      continue
    }

    // 段落。空行まで読む。末尾が `::` なら、続くインデント塊はリテラルブロック。
    const para: string[] = []
    while (i < lines.length && lines[i].trim() !== '') {
      para.push(lines[i].trim())
      i++
    }

    // 表を組めなかったときはここへ来る。段落として流すと罫線がずれるので字面を保つ。
    if (para.some(isTableRule)) {
      out.push(verbatim(para))
      continue
    }

    let body = para.join('\n')
    let literal = ''
    if (body.endsWith('::')) {
      // docutils の規則: `text::` はコロンを 1 つ残し、`text ::`（空白付き）は両方落とす。
      const spaced = body.endsWith(' ::')
      body = spaced ? body.slice(0, -3).trimEnd() : `${body.slice(0, -2).trimEnd()}:`
      const { body: block, next } = takeIndented(i)
      if (block.length) {
        literal = verbatim(block)
        i = next
      }
    }
    if (body) out.push(`<p>${renderInline(body, ctx)}</p>`)
    if (literal) out.push(literal)
  }

  return out.join('\n')
}

/** `key` は記号 1 文字（下線のみ）か、それに `^` を足したもの（上線付き）。 */
function heading(key: string, title: string, levels: string[], ctx: RstContext): string {
  let level = levels.indexOf(key)
  if (level === -1) {
    levels.push(key)
    level = levels.length - 1
  }
  // h1 から h6 まで。それより深い入れ子は h6 に留める。
  const tag = `h${Math.min(level + 1, 6)}`
  return `<${tag}>${renderInline(title, ctx)}</${tag}>`
}

/**
 * 脚注・引用の定義。**見た目は Markdown プレビューの脚注（#241）と同じ構造**にしてあるので、
 * `md-preview` の CSS がそのまま当たる（rst のプレビューはあのクラスを共有している）。
 */
function renderNote(raw: string, body: string[], ctx: RstContext): string {
  const note = noteFor(raw, ctx.notes)
  const inner = renderFlow(body.join('\n'), ctx)
  const back = `<a class="footnote-back" href="#fnref-${note.key}">↩</a>`
  return `<div class="footnote" id="fn-${note.key}"><span class="footnote-num">${escapeHtml(note.display)}</span> ${inner}${back}</div>`
}

function renderDirective(name: string, arg: string, body: string[], ctx: RstContext): string {
  if (name === 'code-block' || name === 'code' || name === 'sourcecode') {
    const lang = arg.trim()
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : ''
    return `<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`
  }
  if (ADMONITIONS.has(name)) {
    const title = name.charAt(0).toUpperCase() + name.slice(1)
    const inner = buildRstPreview(body.join('\n'), ctx)
    return `<div class="rst-admonition rst-${escapeHtml(name)}"><p class="rst-admonition-title">${escapeHtml(title)}</p>${inner}</div>`
  }
  if (name === 'list-table' || name === 'csv-table') {
    const table = name === 'list-table' ? parseListTable(body, ctx) : parseCsvTable(body, ctx)
    if (table) return table
  }
  if (name === 'image' || name === 'figure') {
    // 実体の取得は Markdown プレビューと同じ経路（`resolveMarkdownImages`）に任せる。
    // figure のキャプション（オプション行の後ろに続く段落）も落とさずに出す。
    const img = `<img src="${escapeHtml(arg.trim())}" alt="">`
    const caption = body.filter((l) => !FIELD.test(l.trim())).join('\n')
    if (name === 'figure' && caption.trim()) {
      return `<figure>${img}<figcaption>${buildRstPreview(caption, ctx)}</figcaption></figure>`
    }
    return img
  }
  // 知らないディレクティブは、指示行ごと字面のまま見せる（黙って消さない）。
  return verbatim([`.. ${name}:: ${arg}`.trimEnd(), ...body.map((l) => `   ${l}`)])
}

/** 表のオプション行（`:header-rows: 1` など）を読み切る。 */
function takeOptions(body: string[]): { options: Map<string, string>; next: number } {
  const options = new Map<string, string>()
  let i = 0
  for (; i < body.length; i++) {
    const opt = body[i].trim().match(FIELD)
    if (!opt) break
    options.set(opt[1].trim(), opt[2].trim())
  }
  return { options, next: i }
}

function tableHtml(rows: string[][], headerRows: number): string {
  const row = (cells: string[], head: boolean) => {
    const tag = head ? 'th' : 'td'
    return `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`
  }
  return `<table class="rst-table"><tbody>${rows.map((cells, r) => row(cells, r < headerRows)).join('')}</tbody></table>`
}

/** 素の欄をインラインとして組んで表にする（list-table と csv-table が共有）。 */
function renderRows(rows: string[][], ctx: RstContext, headerRows: number): string {
  return tableHtml(
    rows.map((cells) => cells.map((c) => renderInline(c, ctx))),
    headerRows,
  )
}

/**
 * simple table（`===== =====`）。**罫線の空白位置が列の境界**で、最終列だけは行末まで伸びる
 * （長い値を書けるようにする docutils の規則）。
 *
 * 罫線は 2 本（見出し無し）か 3 本（1 本目と 2 本目のあいだが見出し）。
 */
function parseSimpleTable(lines: string[], start: number, ctx: RstContext): { html: string; next: number } | null {
  const rule = lines[start].trim()
  // 列の境界は罫線の `=` の並びから取る。行頭のインデントぶんを足して桁を合わせる。
  const indent = displayWidth(lines[start].slice(0, indentOf(lines[start])))
  const bounds: number[] = []
  for (const m of rule.matchAll(/=+/g)) bounds.push(indent + displayWidth(rule.slice(0, m.index)))
  if (bounds.length < 2) return null

  const rules: number[] = []
  let i = start
  while (i < lines.length) {
    if (isSimpleRule(lines[i])) rules.push(i)
    else if (lines[i].trim() === '' && rules.length >= 2) break
    i++
  }
  if (rules.length < 2) return null
  const end = rules[rules.length - 1]

  // 3 本以上なら 1 本目と 2 本目のあいだが見出し。
  const headerEnd = rules.length >= 3 ? rules[1] : rules[0]
  const rows: string[][] = []
  let headerRows = 0
  for (let j = start + 1; j < end; j++) {
    if (isSimpleRule(lines[j]) || !lines[j].trim()) continue
    const cells = bounds.map((from, c) =>
      // 最終列は行末まで。途中の列は次の境界の手前まで（罫線の空白ぶんも欄に含める）。
      sliceByWidth(lines[j], from, c === bounds.length - 1 ? Number.MAX_SAFE_INTEGER : bounds[c + 1]).trim(),
    )
    rows.push(cells)
    if (j < headerEnd) headerRows = rows.length
  }
  if (!rows.length) return null
  return { html: renderRows(rows, ctx, headerRows), next: end + 1 }
}

/**
 * grid table（`+---+---+`）。罫線の `+` の桁が列の境界で、`+===+` が見出しの区切り。
 *
 * **セルの結合には対応しない。** 縦の結合は罫線の `+` が欠けることで、横の結合はデータ行の
 * `|` が境界に無いことで分かる。どちらも `null` を返して呼び出し側に字面のまま出させる（桁の
 * 切り出しが一気に複雑になるわりに、書かれる頻度が低い）。**横の結合を見落とすと、境界に
 * 乗った 1 文字が黙って消える。**
 */
function parseGridTable(lines: string[], start: number, ctx: RstContext): { html: string; next: number } | null {
  const first = lines[start]
  const indent = indentOf(first)
  const rule = first.trim()
  // 境界は `+` の桁。表示幅で持つ（全角を含む行から切り出すため）。
  const bounds = [...rule.matchAll(/\+/g)].map((m) => displayWidth(rule.slice(0, m.index)) + indent)
  if (bounds.length < 2) return null

  let end = start
  let headerAt = -1
  for (let j = start + 1; j < lines.length; j++) {
    const t = lines[j].trim()
    if (!t) break
    if (isGridRule(lines[j])) {
      const cols = [...t.matchAll(/\+/g)].map((m) => displayWidth(t.slice(0, m.index)) + indent)
      if (cols.length !== bounds.length || cols.some((c, k) => c !== bounds[k])) return null
      if (t.includes('=')) headerAt = j
      end = j
      continue
    }
    if (!t.startsWith('|')) return null
    if (!bounds.every((b) => sliceByWidth(lines[j], b, b + 1) === '|')) return null
    end = j
  }
  if (!isGridRule(lines[end])) return null

  // 罫線で区切られた塊が 1 行。塊の中の各行を桁で切り、セルごとに縦に積む。
  const rows: string[][] = []
  let headerRows = 0
  let chunk: string[] = []
  const flush = (before: number) => {
    if (!chunk.length) return
    const cells: string[][] = bounds.slice(0, -1).map(() => [])
    for (const line of chunk) {
      for (let c = 0; c < cells.length; c++) cells[c].push(sliceByWidth(line, bounds[c] + 1, bounds[c + 1]))
    }
    rows.push(cells.map((c) => renderCell(c, ctx)))
    if (headerAt !== -1 && before <= headerAt) headerRows = rows.length
    chunk = []
  }
  for (let j = start + 1; j <= end; j++) {
    if (isGridRule(lines[j])) flush(j)
    else chunk.push(lines[j])
  }
  if (!rows.length) return null
  return { html: tableHtml(rows, headerRows), next: end + 1 }
}

/**
 * 本文を組む。**1 段落に収まるものは `<p>` を作らずインラインだけを当てる。**
 *
 * `<p>` はブロックなので、表のセルでは行間が空き、脚注では見出しの数字・本文・戻りリンクが
 * それぞれ別の行に落ちる。改行は段落の続きなので空白 1 つで繋ぐ（docutils と同じ）。
 */
function renderFlow(body: string, ctx: RstContext): string {
  if (!body.trim()) return ''
  const multi = /\n\s*\n/.test(body) || body.split('\n').some((l) => BULLET.test(l.trim()))
  if (multi) return buildRstPreview(body, ctx)
  return renderInline(
    body
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' '),
    ctx,
  )
}

/** セルの中身（複数行）を HTML に。 */
function renderCell(lines: string[], ctx: RstContext): string {
  // 桁を合わせるための右側の空白は中身ではない。落としてから繋ぐ。
  return renderFlow(
    dedent(lines.map((l) => l.trimEnd()))
      .join('\n')
      .replace(/\n+$/, ''),
    ctx,
  )
}

/**
 * `list-table` ディレクティブ。外側の箇条書きが行、内側が欄。
 */
function parseListTable(body: string[], ctx: RstContext): string | null {
  const { options, next } = takeOptions(body)
  const headerRows = Number(options.get('header-rows')) || 0

  const rows: string[][] = []
  for (let i = next; i < body.length; i++) {
    const line = body[i]
    if (!line.trim()) continue
    const outer = line.trim().match(BULLET)
    if (outer && indentOf(line) === 0) {
      rows.push([])
      // 行の宣言（`* - 最初の欄`）は同じ行に最初の欄を持てる。
      const inner = outer[2].trim().match(BULLET)
      if (inner) rows[rows.length - 1].push(inner[2])
      continue
    }
    if (!rows.length) return null
    const cells = rows[rows.length - 1]
    const inner = line.trim().match(BULLET)
    if (inner) cells.push(inner[2])
    // 欄の続き（インデントされた継続行）は直前の欄に足す。
    else if (cells.length) cells[cells.length - 1] += ` ${line.trim()}`
  }
  return rows.length ? renderRows(rows, ctx, headerRows) : null
}

/** `csv-table` ディレクティブ。列見出しは `:header:` オプションで与える書き方に合わせる。 */
function parseCsvTable(body: string[], ctx: RstContext): string | null {
  const { options, next } = takeOptions(body)
  const header = options.has('header') ? splitDelimited(options.get('header') ?? '', ',').map((c) => c.trim()) : []

  const rows = body
    .slice(next)
    .filter((l) => l.trim())
    .map((l) => splitDelimited(l, ',').map((c) => c.trim()))
  if (!rows.length && !header.length) return null

  return renderRows(header.length ? [header, ...rows] : rows, ctx, header.length ? 1 : 0)
}

/**
 * 箇条書き・番号付きリスト。**インデントの深さで入れ子にする**（rst は深さがすべて）。
 * 続きの行（インデントされた継続）は同じ項目の本文として扱う。
 */
function renderList(lines: string[], start: number, ctx: RstContext): { html: string; next: number } {
  const baseIndent = indentOf(lines[start])
  const ordered = ENUM.test(lines[start].trim())
  const items: string[][] = []
  let i = start

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      // 空行の次がまだこのリストなら続き、そうでなければ終わり。**添字で先を見る**:
      // `slice().find()` にすると、リスト内の空行ごとに文書の残り全体を複製することになる。
      let k = i + 1
      while (k < lines.length && lines[k].trim() === '') k++
      if (k >= lines.length) break
      const aheadIndent = indentOf(lines[k])
      if (aheadIndent < baseIndent) break
      if (aheadIndent === baseIndent && !BULLET.test(lines[k].trim()) && !ENUM.test(lines[k].trim())) break
      i++
      continue
    }
    const indent = indentOf(line)
    if (indent < baseIndent) break
    const marker = line.trim().match(BULLET) ?? line.trim().match(ENUM)
    if (indent === baseIndent && marker) {
      items.push([marker[2]])
      i++
      continue
    }
    if (!items.length) break
    items[items.length - 1].push(line.slice(baseIndent))
    i++
  }

  const tag = ordered ? 'ol' : 'ul'
  const html = items
    .map(([first, ...rest]) => {
      const nested = rest.length ? buildRstPreview(dedent(rest).join('\n'), ctx) : ''
      return `<li>${renderInline(first, ctx)}${nested}</li>`
    })
    .join('')
  return { html: `<${tag}>${html}</${tag}>`, next: i }
}
