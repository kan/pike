/**
 * reStructuredText のプレビュー（#284）。
 *
 * **自前で書いているのは、#284 の時点で使える変換器が無かったため。** 当時の JS の rst → HTML は
 * `rst2html`（2017 年で更新停止）と `restructured`（最終公開 2016 年）くらいで、後者は
 * `power-assert`（650KB）と `commander`（207KB）を production dependencies に持っている
 * （テストと CLI のものが誤って入っている形）。「軽さ最優先」「不要な npm パッケージを追加
 * しない」という方針とは釣り合わなかった。
 *
 * **その前提はもう古い。** `rst-compiler`（Trinovantes、純 TypeScript・MIT・現役）が実用水準に
 * ある。乗り換えていないのは production dependencies に `shiki` と `katex` を持つためで、
 * プレビューのためにハイライタと数式エンジンをもう一式抱えることになる。**運用してみて不具合が
 * 続くようなら、依存が太るのを許容してこちらへ載せ替える**（2026-09-01 の判断）。載せ替えるときは
 * 下の「解釈できなかったものは字面のまま出す」だけは維持すること（あちらは失敗時に落とす作りで、
 * プレビューとしては消えるより残るほうがよい）。Rust 側（`rust_parser` / `rst_renderer`）は
 * README 自身が「rST の部分集合」と書いていて完成度が変わらないうえ、**CLAUDE.md の「Rust は
 * I/O ブリッジに徹する」に反し、打鍵のたびに IPC を往復する**ので採らない。
 *
 * **したがってこれは docutils の再実装ではない。** 実際に書かれる文書でよく出る要素だけを扱い、
 * **解釈できなかったものは捨てずに字面のまま出す**。プレビューは読むためのもので、変換に失敗した
 * 箇所が消えるほうが困る。字面へ落とすのは、セルを結合した表・知らないディレクティブ・扱えない
 * 置換定義で、`toctree` / `include` / `math` / `raw` もそこに含まれる（他ファイルの一覧・外部
 * ファイルの読み込み・数式描画・生 HTML の埋め込みで、プレビューで解決する意味が薄いか、そのまま
 * 通すと危ないもの）。**本文に出さないのは、真のコメント・リンク定義・差し替えた置換定義だけ。**
 *
 * 組み立てた HTML は呼び出し側（`EditorTab.vue`）が DOMPurify に通すが、**それを唯一の防波堤に
 * しない**。エスケープ済みかどうかは `lib/text.ts` の `Html` 型で持ち、生の文字列を属性へ差し込む
 * 経路がコンパイルエラーになるようにしてある。
 */

import { t } from '../i18n'
import { displayWidth, sliceByWidth } from './displayWidth'
import { asHtml, charEntity, escapeHtml, escapeRegExp, type Html, splitDelimited } from './text'

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
/**
 * 原文に紛れ込んだ伏せ字の文字。**実体参照へ逃がす**: そのままだと穴の解決が誤爆して、
 * `a␀5␁b` のような並びが `aundefinedb` になる（閉じが無ければ穴が残ったまま出る）。
 */
const HOLE_CHARS = new RegExp(`[${HOLE_OPEN}${HOLE_CLOSE}]`, 'g')

/** 箇条書きの記号（`-` `*` `+` `•`）。 */
const BULLET = /^([-*+•])\s+(.*)$/
/**
 * `list-table` の欄の切り出しだけに使う、本文が空でもよい版。空欄は記号だけの行で書くので、
 * 空白を必須にすると欄が 1 つ足りないまま前の欄へ連結され、列がずれる。
 *
 * **`BULLET` のほうを緩めないこと。** あれは本文全体の振り分けにも使われるので、記号 1 文字の
 * 行がリストの開始に化ける。表の `-`（該当なし）や `.. [1] -` の脚注が空の箇条書きになる。
 */
const LIST_TABLE_CELL = /^([-*+•])(?:\s+(.*))?$/
/** 番号付き（`1.` `1)` `(1)` `#.`）。 */
const ENUM = /^(\(?[0-9]+[.)]|#\.)\s+(.*)$/
/** フィールドリスト（`:key: value`）。 */
const FIELD = /^:([^:]+):\s*(.*)$/
/** ディレクティブ（`.. name:: argument`）。 */
const DIRECTIVE = /^\.\.\s+([\w-]+)::\s*(.*)$/
/** ハイパーリンクの定義（`.. _name: url`）。本文には出さず、参照の解決に使う。 */
const LINK_TARGET = /^\.\.\s+_([^:]+):\s*(.*)$/
/**
 * 置換定義（`.. |name| replace:: text`、#302）。**ディレクティブ名まで一緒に取る**:
 * 置換の中身は任意のディレクティブで、扱えるものだけを差し替えの対象にするため。
 */
const SUBSTITUTION = /^\.\.\s+\|([^|]+)\|\s+([\w-]+)::\s*(.*)$/
/**
 * 置換参照（`|name|`）。前後に空白を持たない名前だけを拾う（表の罫線と取り違えない）。
 *
 * **リンクの `refPattern` と違い、定義済みの名前を列挙した正規表現にはしない。** あちらが
 * そうしているのは `name_` の左側に区切りが無く、名前の切れ目を候補の列挙でしか決められない
 * ため。`|name|` は両側が区切られているので、静的な 1 本で切り出して `Map` を引けば足りる
 * （文書ごとの再コンパイルも `escapeRegExp` も要らない）。
 */
const SUBSTITUTION_REF = /\|([^|\s](?:[^|]*[^|\s])?)\|/g
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
  /** 置換の名前 → 組み上げた断片（#302）。扱えたものだけが入る。 */
  subs: Map<string, Html>
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
  // **左にも境界が要る。** 無いと `test` を定義した文書で `latest_` の後ろ 4 文字に当たり、
  // `la<a …>test</a>` になる（`openapi-spec_` のような命名で普通に踏む）。`\b` は日本語の
  // 境界を知らないので、英数字と `_` が直前に来ないことだけを見る。
  const pattern = names.length ? new RegExp(`(?<![\\w_])(?:${names.join('|')})_(?![\\w_])`, 'gi') : null
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

  let out: string = escapeHtml(text)
    .replace(HOLE_CHARS, charEntity)
    .replace(/``([^`]+)``/g, (_, code: string) => hide(asHtml(`<code>${code}</code>`)))

  // 置換参照（`|name|`、#302）。**リテラルを伏せた直後に置く**: 差し込む断片は組み上がった
  // HTML なので、伏せておかないと中の `*` や `_` を後続の記法が食う。定義の無い名前は綴りを
  // そのまま残す（表の罫線や `a | b` のような素の縦棒を壊さないため）。
  //
  // `includes` で前置きするのは、`subs.size` が文書に定義が 1 つでもあれば全段落・全セルで
  // 真になるため。縦棒を含む散文はまれなので、ほぼ全段落が正規表現の起動を免れる（実測 8 倍）。
  if (ctx.subs.size && out.includes('|')) {
    out = out.replace(SUBSTITUTION_REF, (whole: string, name: string) => {
      const html = ctx.subs.get(normalizeRefName(name))
      return html ? hide(html) : whole
    })
  }

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

  // **穴は無くなるまで繰り返して戻す。** 伏せた断片の中に別の穴が入ることがあり
  // （リンクのラベルにインラインリテラルを書いた場合）、`replace` は置換した結果を
  // 走査し直さないので、1 パスだと内側が私用領域の文字のまま画面に出る。
  // 入れ子の深さは伏せた数を超えないので、その回数で打ち切ってよい。
  let html: string = out
  for (let i = 0; i <= done.length && html.includes(HOLE_OPEN); i++) {
    html = html.replace(HOLE_RE, (_, n: string) => done[Number(n)])
  }
  return asHtml(html)
}

/**
 * `from` から始まるインデントされた塊を読み切って、共通インデントを外して返す（使う側は
 * 全員そうする）。間の空行は塊の一部だが、前後のものは含めない。
 *
 * **`collectContext` からも呼ぶので自由関数にしてある（#302）。** `buildRstPreview` の中の
 * クロージャだったころ、置換定義の値を読む側が同じ walk を書き直す羽目になり、空行とオプション
 * 行の扱いが 2 通りに割れていた。
 */
function takeIndented(lines: string[], from: number): { body: string[]; next: number; blankFirst: boolean } {
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
  // **明示マークアップは罫線として扱わない。** `.` も `:` も罫線に使える文字だが、`..` は
  // コメント、`::` はリテラルブロックの印で、docutils ではそちらが優先される。除かないと、
  // この関数を先に通る見出しと `<hr>` の分岐に食われて、`..` だけのコメントが `<h1>` になり、
  // 単独の `::` が `<hr>` ＋ ただの段落に化ける。
  //
  // **ちょうど 2 文字のときだけ**にすること。明示マークアップは `..` の後ろに空白か行末が
  // 要るので、`...` や `.....` は正当な罫線（前者は区切り、後者は見出しの下線）。前方一致で
  // 弾くと、それらが `<hr>` や `<h1>` にならないうえ、`..` の分岐に拾われて本文から消える。
  if (t === '..' || t === '::') return false
  return t.length >= 2 && ADORNMENT.includes(t[0]) && [...t].every((c) => c === t[0])
}

/**
 * 指示行・定義行に書いた本文（`.. note:: 気をつけて` / `.. [1] 最初の脚注`）を、続くインデント
 * 塊の前に足す。**あいだに空行があったなら段落の切れ目**なので 1 行挟む。挟まないと、続く
 * リストや 2 つ目の段落が指示行の文に吸い込まれて 1 つの `<p>` に潰れる。
 */
function withLead(lead: string, blankFirst: boolean, body: string[]): string[] {
  return [lead, ...(blankFirst ? [''] : []), ...body]
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
  //
  // **走査は 1 周にまとめる。** 定義はどれも `..` で始まるので、その 1 文字の判定で大半の行を
  // 落としてから正規表現を当てる。3 本の `some()` を並べていたころは全行を 3 周していた
  // （4,800 行で 185µs → 8µs）。ここは入れ子の塊ごとに呼ばれるので倍率が効く。
  let hasLink = false
  let hasNote = false
  let hasSub = false
  for (const line of lines) {
    if (!line.startsWith('..')) continue
    if (LINK_TARGET.test(line)) hasLink = true
    else if (NOTE_DEF.test(line)) hasNote = true
    else if (SUBSTITUTION.test(line)) hasSub = true
  }
  if (!hasLink && !hasNote && !hasSub && inherited) return inherited

  // **脚注の採番は文書で 1 つ**なので、Map は複製せず親のものへ足す。複製すると、入れ子の
  // 兄弟ブロック（2 つの `.. note::` の中など）がどちらも親の状態から数え直し、同じ番号と
  // 同じ id を持つ脚注が 2 つできてアンカーが常に前者へ飛ぶ。
  const notes = inherited?.notes ?? new Map<string, Note>()
  // リンクのほうは足すときだけ複製する。`refPattern` のキャッシュが Map の identity を
  // キーにしているので、同じ Map に足すと古い正規表現が返って新しい名前を拾えない。
  const links = hasLink ? new Map<string, Html>(inherited?.links) : (inherited?.links ?? new Map<string, Html>())

  const subs = hasSub ? new Map<string, Html>(inherited?.subs) : (inherited?.subs ?? new Map<string, Html>())
  /** 置換は本文（`links` / `notes`）が揃ってから組む。中身にリンク参照を書けるため。 */
  const pending = new Map<string, { name: string; kind: string; parts: string[] }>()

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
    const sub = lines[i].match(SUBSTITUTION)
    if (sub) {
      // 扱えない種別（`unicode` など）もここで拾っておく。**解決を試みた事実が要る**からで、
      // 値の中からそれを参照していた定義を「解決できなかった」と判定するのに使う。
      pending.set(subKey(sub[1]), { name: sub[1], kind: sub[2].toLowerCase(), parts: subValue(lines, i, sub[3]) })
      continue
    }
    const note = lines[i].match(NOTE_DEF)
    if (note) noteFor(note[1].trim(), notes)
  }

  const ctx: RstContext = { links, notes, subs }
  const resolving = new Set<string>()

  /**
   * 置換を 1 つ組む（#302）。**値が参照している置換を先に解く**: `.. |a| replace:: |b| 込み`
   * のような入れ子は docutils で正当な書き方なので、解けるものは解く。
   *
   * **半端に解けたものは採用しない。** 値の中に、定義があるのに解けなかった参照が残っていたら
   * 捨てる（循環定義がここに落ちる）。採用すると、定義行は「解決済み」として本文から消える
   * 一方で値の中の `|b|` は綴りのまま出るので、**字面に戻せる元が無い壊れた表示**になる。
   * このファイルが避けようとしている失敗そのもので、捨てれば定義も参照も字面のまま残る。
   */
  function resolveSub(key: string): void {
    // 済み、または循環の輪の中（呼び出しが自分へ戻ってきた）
    if (subs.has(key) || resolving.has(key)) return
    const def = pending.get(key)
    if (!def) return
    resolving.add(key)
    for (const ref of def.parts.join(' ').matchAll(SUBSTITUTION_REF)) resolveSub(subKey(ref[1]))
    resolving.delete(key)
    const html = substitutionHtml(def.kind, def.parts, escapeHtml(def.name.trim()), ctx)
    if (html && ![...html.matchAll(SUBSTITUTION_REF)].some((m) => pending.has(subKey(m[1])))) subs.set(key, html)
  }
  for (const key of pending.keys()) resolveSub(key)
  return ctx
}

/**
 * 置換名の照合キー（#302）。**エスケープしてから正規化する**のが要点で、参照側は
 * `escapeHtml` 済みの本文から名前を切り出すため、生の名前をキーにすると `|Q&A|` のような
 * 名前が永久に一致しない（定義だけ本文から消えて何も差し替わらない、という形で出る）。
 */
function subKey(name: string): string {
  return normalizeRefName(escapeHtml(name))
}

/**
 * 置換定義の値になる行を集める（#302）。
 *
 * **指示行の続き（インデントされた行）も値の一部。** `.. |x| replace:: 長い文の` の下に
 * 続きを書くのは docutils で普通の書き方で、1 行目だけを採ると残りが本文にも字面にも
 * 出ないまま消える。**オプション行（`:alt:` など）は値ではない**ので飛ばす: 引数を書かずに
 * `.. |i| image::` と改行した文書で、`:width: 20px` を URL にしてしまうのを防ぐ。
 */
function subValue(lines: string[], at: number, first: string): string[] {
  const cont = takeIndented(lines, at + 1)
    .body.map((l) => l.trim())
    .filter((l) => l && !FIELD.test(l))
  return first.trim() ? [first.trim(), ...cont] : cont
}

/**
 * 置換の中身を組むディレクティブ（#302）。**扱える種別の出典はこの表 1 つ**で、定義行を本文から
 * 消してよいかの判定（`buildRstPreview`）も `in` で引く。実際に書かれるのは `replace` と `image`
 * がほとんどで、それ以外（`unicode` / `date`）を半端に解釈するより、解釈できなかったものを字面で
 * 見せるこのファイルの方針に合わせるほうが読み手を裏切らない。
 *
 * `label` はエスケープ済みの元の名前（キーは小文字に潰してあるので alt には使えない）。
 *
 * **`renderDirective` と統合しないこと。** あちらが返すのは `<div>` や `<pre>` のブロックで、
 * `|x|` の位置（インライン）には置けない。置換で今後増える候補もすべてインライン側になる。
 */
const SUBSTITUTION_RENDERERS: Record<string, (parts: string[], label: Html, ctx: RstContext) => Html> = {
  replace: (parts, _label, ctx) => renderInline(parts.join(' '), ctx),
  // **画像は URL 1 つ**なので、続きの行があっても最初のものだけを使う（連結すると読めない src）。
  image: (parts, label) => imageHtml(parts[0], label),
}

/** 扱えない種別と、値を持たない定義は `null`（定義行も参照も字面のまま残る）。 */
function substitutionHtml(kind: string, parts: string[], label: Html, ctx: RstContext): Html | null {
  if (!parts.length) return null
  return SUBSTITUTION_RENDERERS[kind]?.(parts, label, ctx) ?? null
}

/**
 * プレビューの `<img>`。**実体の取得は `resolveMarkdownImages` に任せる**ので、src には
 * 書かれたパスをそのまま置く（後段が `data:` URL に差し替える）。`.. image::` と置換の
 * `image` が共有する 1 行で、片方だけ変えると置換で書いた画像だけが壊れる。
 */
function imageHtml(src: string, alt: Html): Html {
  return asHtml(`<img src="${escapeHtml(src.trim())}" alt="${alt}">`)
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
  /** `.. meta::` の行（#302）。集める先を持てるのはルートの呼び出しだけ。 */
  const meta: string[] = []
  let i = 0

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
      const { body, next, blankFirst } = takeIndented(lines, i + 1)
      const name = directive[1].toLowerCase()
      // `.. meta::` は本文ではなく文書のメタデータ（docutils は `<meta>` タグにする）。
      // **文書の頭に 1 つだけ集める**ので、集める先を持てるルートの呼び出し（＝`inherited` を
      // 渡されていない＝入れ子ではない）でだけ拾う（#302）。入れ子では下の字面の経路へ落ちる。
      // フィールドとして読めない行が混ざっていたときも同じく字面で出す。
      if (name === 'meta' && !inherited) {
        const rows = metaRows(body)
        if (rows) {
          meta.push(...rows)
          i = next
          continue
        }
      }
      out.push(renderDirective(name, directive[2], body, ctx, blankFirst))
      i = next
      continue
    }

    // 脚注・引用の定義。定義は**書かれた場所に描く**（末尾に集めない）。この関数は入れ子でも
    // 呼ばれるので、集める先を決められない。
    const note = trimmed.match(NOTE_DEF)
    if (note) {
      const { body, next, blankFirst } = takeIndented(lines, i + 1)
      out.push(renderNote(note[1].trim(), withLead(note[2], blankFirst, body), ctx))
      i = next
      continue
    }

    if (trimmed.startsWith('..')) {
      const { body, next } = takeIndented(lines, i + 1)
      // **本文から消してよいのは、真のコメント・リンク定義・差し替えられた置換定義だけ。**
      // ここは認識できなかった明示マークアップ全部の受け皿でもあるので、それらは字面のまま
      // 残す（`unicode::` のような、扱えなかった置換の定義を含む）。
      // **種別まで見る。** 名前だけで引くと、同じ名前を `replace` と `unicode` の両方で
      // 定義した文書で、差し替えに使っていないほうまで「解決済み」とみなして消してしまう。
      const sub = trimmed.match(SUBSTITUTION)
      const resolved = sub ? sub[2].toLowerCase() in SUBSTITUTION_RENDERERS && ctx.subs.has(subKey(sub[1])) : false
      if (!LINK_TARGET.test(line) && /^\.\.\s+\|/.test(line) && !resolved) out.push(verbatim([line, ...body]))
      i = next
      continue
    }

    // 単独の `::` に続くインデント塊はリテラルブロック。
    if (trimmed === '::') {
      const { body, next } = takeIndented(lines, i + 1)
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
      const { body: block, next } = takeIndented(lines, i)
      if (block.length) {
        literal = verbatim(block)
        i = next
      }
    }
    if (body) out.push(`<p>${renderInline(body, ctx)}</p>`)
    if (literal) out.push(literal)
  }

  const html = out.join('\n')
  return meta.length ? metaBlock(meta) + html : html
}

/**
 * `.. meta::` の中身を表の行にする（#302）。**フィールドとして読めない行が残ったら `null`**:
 * その塊は「解釈できなかったもの」として字面のまま出す側へ回す（黙って落とさない）。
 */
function metaRows(body: string[]): string[] | null {
  const { options, next } = takeOptions(body)
  if (!options.size) return null
  if (body.slice(next).some((l) => l.trim() !== '')) return null
  return [...options].map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
}

/**
 * 文書の頭に出すメタデータの折り畳み（#302）。**Markdown のフロントマター（#229）と同じ
 * クラスを使う**: 見た目（`theme.css` ではなく `EditorTab` の `.md-preview :deep(.frontmatter)`）も、
 * 開閉状態を打鍵のたびに復元する仕掛け（`trackFrontmatterToggle`）も、そのまま相乗りできる。
 * どちらも「本文ではない、文書に付いた key/value」を畳んで頭に出すという同じ役目。
 */
function metaBlock(rows: string[]): string {
  const label = `<summary>${escapeHtml(t('rst.meta'))}<span class="frontmatter-kind">META</span></summary>`
  return `<details class="frontmatter">${label}<table><tbody>${rows.join('')}</tbody></table></details>`
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

function renderDirective(name: string, arg: string, body: string[], ctx: RstContext, blankFirst: boolean): string {
  // 表の 2 つはオプションの値そのものを使うので、自分で読む（先に振り分けて二度読みを避ける）。
  if (name === 'list-table' || name === 'csv-table') {
    const table = name === 'list-table' ? parseListTable(body, ctx) : parseCsvTable(body, ctx)
    if (table) return table
  }
  // **オプション行（`:linenos:` 等）は本文ではない。** docutils では、指示行の直後に空行を
  // 挟まず並ぶフィールドだけがオプションで、空行のあとに来るものは本文のフィールドリスト。
  // `blankFirst` を見ないと、`.. note::` の本文が `:key: value` で始まるだけで消える。
  const content = blankFirst ? body : body.slice(takeOptions(body).next)
  if (name === 'code-block' || name === 'code' || name === 'sourcecode') {
    const lang = arg.trim()
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : ''
    // オプションと本文のあいだの空行はコードの一部ではない。
    const first = content.findIndex((l) => l.trim() !== '')
    const code = first < 0 ? [] : content.slice(first)
    return `<pre><code${cls}>${escapeHtml(code.join('\n'))}</code></pre>`
  }
  if (ADMONITIONS.has(name)) {
    const title = name.charAt(0).toUpperCase() + name.slice(1)
    // **指示行に書いた本文も本文**（`.. note:: 気をつけて` は docutils でいちばん普通の書き方）。
    // 落とすと中身の無い箱だけが出る。続きのインデント塊があれば同じ段落として繋がる。
    const inner = buildRstPreview(withLead(arg.trim(), blankFirst, content).join('\n'), ctx)
    return `<div class="rst-admonition rst-${escapeHtml(name)}"><p class="rst-admonition-title">${escapeHtml(title)}</p>${inner}</div>`
  }
  if (name === 'image' || name === 'figure') {
    // figure のキャプション（オプション行の後ろに続く段落）も落とさずに出す。
    const img = imageHtml(arg, asHtml(''))
    const caption = content.join('\n')
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

  /** 罫線の桁に収まっているか（欄の境目に文字が跨っていないか）。 */
  const fitsColumns = (line: string) =>
    bounds.slice(1).every((b) => {
      const head = sliceByWidth(line, 0, b)
      return displayWidth(head) < b || /\s$/.test(head)
    })

  const rules: number[] = []
  let i = start
  while (i < lines.length) {
    if (isSimpleRule(lines[i])) {
      rules.push(i)
      // **閉じたら止める。** 罫線は最大 3 本（上・見出しの区切り・下）で、2 本目の次が表の行で
      // なければ 2 本目が下の罫線。読み進めると、後続の散文と次の表まで 1 つに繋げてしまい、
      // 桁で切った散文が欄に入る。
      //
      // **2 本目の次が空行なら閉じたとみなす**（`!next.trim()`）。`==== ====/a b/==== ====/空行/
      // ==== ====` という並びは「表 2 つ」とも「見出しの区切りのあとに空行を挟んだ 1 つの表」とも
      // 読めて、字面では区別が付かない。前者のほうが桁違いに多いのでそちらを採る。
      if (rules.length >= 3) break
      const next = lines[i + 1]
      if (rules.length === 2 && (next === undefined || isSimpleRule(next) || !next.trim() || !fitsColumns(next))) break
      i++
      continue
    }
    if (lines[i].trim() === '') {
      // 空行の次が罫線か、表の桁に収まっているあいだは続き（行を空行で束ねる書き方がある）。
      // **「閉じ罫線が来るまで読み進める」にしないこと**: 閉じ罫線を欠いた表がここで止まらず、
      // やはり後続を飲み込む。
      let k = i + 1
      while (k < lines.length && lines[k].trim() === '') k++
      if (k >= lines.length || !(isSimpleRule(lines[k]) || fitsColumns(lines[k]))) break
      i = k
      continue
    }
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
    const outer = line.trim().match(LIST_TABLE_CELL)
    if (outer && indentOf(line) === 0) {
      rows.push([])
      // 行の宣言（`* - 最初の欄`）は同じ行に最初の欄を持てる。
      const inner = (outer[2] ?? '').trim().match(LIST_TABLE_CELL)
      if (inner) rows[rows.length - 1].push(inner[2] ?? '')
      continue
    }
    if (!rows.length) return null
    const cells = rows[rows.length - 1]
    const inner = line.trim().match(LIST_TABLE_CELL)
    if (inner) cells.push(inner[2] ?? '')
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
