/**
 * 本文から描くプレビューの部品（#524 で `EditorTab.vue` から切り出した）。エディタの
 * Preview / Split と、diff タブのプレビュー比較（`components/DiffPreview.vue`）が同じものを使う。
 *
 * **描き方を 2 か所に持たないこと。** diff の左右がエディタのプレビューと違う見た目になると、
 * 「差分があるように見えて実は描き方の違い」が起きる。見た目の CSS も `assets/preview.css` の
 * `.md-preview` / `.rst-preview` / `.svg-preview` / `.mermaid-preview` を共有する。**CSS は
 * このファイルが読み込む**ので、プレビューを使う画面を開くまでは起動時の CSS に載らない。
 *
 * ここに置くのは「文字列 → HTML」と「描いた DOM の後処理」だけ。どのファイルを開いているか、
 * 打鍵のたびに描き直すか、といった段取りは呼び出し側が持つ。どのファイルが描けるかの判定は
 * `lib/fileType.ts`（`previewKindOfKey`。描けるかを知りたいだけの画面にこの束を読ませない）。
 */
import '../assets/preview.css'
import DOMPurify from 'dompurify'
import { confirmDialog } from '../composables/useConfirmDialog'
import { t } from '../i18n'
import { useSettingsStore } from '../stores/settings'
import { type ShellType, shellToPlatform } from '../types/tab'
import { highlightCodeBlock } from './codeHighlight'
import { imageHostOf, remoteImageDataUrl, retryRemoteImage } from './externalImages'
import { detectFrontmatter } from './frontmatter'
import { parseFrontmatter } from './frontmatterParse'
import { previewParser } from './markdownGfm'
import { renderMath } from './markdownMath'
import { renderMermaid } from './mermaid'
import { isEmbeddableImage, mimeType, pathSep } from './paths'
import { relativeToBase } from './projectPaths'
import { buildRstPreview } from './rstPreview'
import { ALLOWED_URI_REGEXP } from './sanitizeHtml'
import { createHeadingSlugger } from './slug'
import { fsReadFileBase64 } from './tauri'
import { escapeHtml } from './text'

const SVG_PURIFY_OPTS = {
  ADD_TAGS: [
    'svg',
    'g',
    'path',
    'rect',
    'circle',
    'line',
    'polyline',
    'polygon',
    'text',
    'tspan',
    'defs',
    'clipPath',
    'use',
    'marker',
    'foreignObject',
    'style',
  ],
  ADD_ATTR: [
    'viewBox',
    'xmlns',
    'd',
    'fill',
    'stroke',
    'stroke-width',
    'transform',
    'x',
    'y',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'width',
    'height',
    'points',
    'text-anchor',
    'dominant-baseline',
    'font-size',
    'font-family',
    'font-weight',
    'clip-path',
    'marker-end',
    'refX',
    'refY',
    'orient',
    'markerWidth',
    'markerHeight',
    'dx',
    'dy',
    'preserveAspectRatio',
    'startOffset',
    'data-id',
    'data-node-id',
    'data-look',
  ],
  ALLOWED_URI_REGEXP,
}

/** コードブロックの色に使うテーマ名。描画のたびに読む（computed の中で読めばテーマへの依存が張られる）。 */
const codeTheme = () => useSettingsStore().effectiveEditorThemeName

/**
 * Own `marked` instances: the footnote extension (#241) belongs to these previews and must
 * not leak into the agent chat's Markdown. **モジュールに 1 つ**持ち、エディタと diff タブで
 * 共有する（本文が要る block 拡張の組み合わせごとのインスタンスは `previewParser` が覚える）。
 */
const markdownParser = previewParser({ theme: codeTheme, footnotes: true })

/**
 * Front matter fools CommonMark: the opening `---` is a thematic break and the closing
 * one underlines it into a setext heading, so the whole block lands in the body as an
 * `<h2>`. Slice it off and render it as metadata instead.
 *
 * 無害化はしていない（`renderMarkdownHtml` が通す）。
 */
function buildMarkdownPreview(text: string, parse: (text: string) => string): string {
  const block = detectFrontmatter(text)
  if (!block) return parse(text)

  const parsed = parseFrontmatter(block)
  let cls = ''
  let body: string
  if (!parsed.ok) {
    const message = parsed.reason === 'not-mapping' ? t('frontmatter.notMapping') : parsed.message
    cls = ' frontmatter-invalid'
    body = `<div class="frontmatter-error">${escapeHtml(message)}</div><pre>${escapeHtml(block.raw.trim())}</pre>`
  } else if (parsed.entries.length === 0) {
    body = `<div class="frontmatter-empty">${escapeHtml(t('frontmatter.empty'))}</div>`
  } else {
    const rows = parsed.entries
      .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`)
      .join('')
    body = `<table><tbody>${rows}</tbody></table>`
  }
  // Collapsed by default, but a block we couldn't parse is worth showing unasked.
  const open = parsed.ok ? '' : ' open'
  // **rst の `.. meta::` も同じマークアップを出す**（#302。`lib/rstPreview.ts` の `metaBlock`）。
  // `assets/preview.css` の `.md-preview .frontmatter > …` は子結合子なので、ここの入れ子を変えると
  // あちらが黙って素の `<details>` に戻る。`EditorTab.vue` の `trackFrontmatterToggle` も両方が使う。
  const label = `<summary>${escapeHtml(t('frontmatter.title'))}<span class="frontmatter-kind">${block.kind.toUpperCase()}</span></summary>`
  const meta = `<details class="frontmatter${cls}"${open}>${label}${body}</details>`
  const rest = text.slice(block.bodyFrom)
  return meta + parse(rest)
}

/**
 * `issueRefs` は `#123` をリンクにするか（#482。決め方は呼び出し側。エディタは
 * `EditorTab.vue` の `issueRefsOn`）。
 */
export function renderMarkdownHtml(text: string, issueRefs = false): string {
  const parse = (s: string) => markdownParser(s, { issueRefs }).parse(s) as string
  return DOMPurify.sanitize(buildMarkdownPreview(text, parse), SVG_PURIFY_OPTS)
}

/**
 * rst は SVG を出さない（mermaid も通さない）ので、`SVG_PURIFY_OPTS` の追加許可
 * （`foreignObject` や SVG の属性）を持ち込まない。
 */
export function renderRstHtml(text: string): string {
  const theme = codeTheme()
  const highlight = (code: string, lang: string) => highlightCodeBlock(code, lang, theme)
  return DOMPurify.sanitize(buildRstPreview(text, highlight), { ALLOWED_URI_REGEXP })
}

export function renderSvgHtml(text: string): string {
  return DOMPurify.sanitize(text, SVG_PURIFY_OPTS)
}

/** 図を描いて `.mermaid-inline` に包む。元のソースは `data-mermaid-source` に持つ（書体を変えたときの描き直し用）。 */
async function mermaidDiagram(source: string, id: string, font: string): Promise<HTMLDivElement> {
  const svg = await renderMermaid(source, id, font)
  const wrapper = document.createElement('div')
  wrapper.className = 'mermaid-inline'
  wrapper.dataset.mermaidSource = source
  wrapper.append(svg)
  return wrapper
}

/**
 * Mermaid のファイル 1 つを `target` に描く。読めない図は理由を `pre` で出す。`stale` は
 * `renderMarkdownExtras` と同じで、図種のチャンクを初めて読む描画は遅いので、前の描画が
 * あとから終わって新しい図を上書きしないようにする。
 */
export async function renderMermaidInto(
  target: HTMLElement,
  source: string,
  id: string,
  font: string,
  stale: () => boolean,
): Promise<void> {
  const trimmed = source.trim()
  if (!trimmed) {
    target.replaceChildren()
    return
  }
  try {
    const diagram = await mermaidDiagram(trimmed, id, font)
    if (!stale()) target.replaceChildren(diagram)
  } catch (e) {
    if (stale()) return
    const pre = document.createElement('pre')
    pre.className = 'mermaid-render-error'
    pre.textContent = String(e)
    target.replaceChildren(pre)
  }
}

/**
 * Markdown の中の数式（#482）と ```mermaid``` を描く。どちらも DOM に入ってから当てる
 * （理由は `lib/markdownMath.ts`）。図は元のソースを持つので、書体を変えたときは同じ要素から
 * 描き直せる。
 *
 * **`stale` が真を返したら途中でやめる。** 描画は図ごとに待つ（図種のチャンクの読み込み）ので、
 * 打鍵が描画より速いと古いループが外れた要素を描き続ける。後から始まった描画が勝つように、
 * 呼び出し側が回数を数えて渡す。
 */
export async function renderMarkdownExtras(
  container: HTMLElement,
  idPrefix: string,
  font: string,
  stale: () => boolean,
): Promise<void> {
  void renderMath(container)
  const targets = container.querySelectorAll<HTMLElement>(
    'pre > code.language-mermaid, .mermaid-inline[data-mermaid-source]',
  )
  let idx = 0
  for (const el of targets) {
    if (stale()) return
    const host = el.tagName === 'CODE' ? el.parentElement : el
    const source = el.dataset.mermaidSource ?? (el.textContent ?? '').trim()
    try {
      const diagram = await mermaidDiagram(source, `${idPrefix}-${idx++}-${Date.now()}`, font)
      if (!stale()) host?.replaceWith(diagram)
    } catch {
      // Leave code block as-is on syntax error
    }
  }
}

/** Give preview headings GitHub-style ids so in-page `#anchor` links can scroll. */
export function assignHeadingIds(container: HTMLElement) {
  const slug = createHeadingSlugger()
  for (const h of container.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    h.id = slug(h.textContent ?? '')
  }
}

/** プレビューの中のリンクや画像の相対パスを解く基準。 */
export type PreviewPathBase = {
  /** 描いているファイルの絶対パス（相対パスの基準になるディレクトリを決める）。 */
  filePath: string
  /** プロジェクトのルート。`/` で始まるパスの基準で、解いた結果はこの外へ出さない。 */
  root: string
  shell: ShellType
}

/**
 * プレビューの `href` / `src` をディスク上のパスにする。プロジェクトのルートの外を指すもの、
 * スキームを持つもの（`mailto:` / `javascript:` / `data:` など）は null。
 */
export function resolvePreviewPath(href: string, base: PreviewPathBase): string | null {
  // Prevent opening arbitrary protocol handlers (mailto:, javascript:, data:, etc.)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !/^[a-zA-Z]:\\/.test(href)) return null

  // Decode URL-encoded characters (%20 → space, etc.)
  try {
    href = decodeURIComponent(href)
  } catch {
    return null
  }

  const { filePath, root, shell } = base
  const sep = pathSep(shell)

  // Determine the directory containing the current file. A leading slash is
  // repo-relative in Markdown (the way GitHub and VS Code read it) rather than
  // a filesystem path, so resolving it against the file's own directory sent
  // those images somewhere nothing lives.
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const dir = href.startsWith('/') ? root : lastSep > 0 ? filePath.slice(0, lastSep) : root

  // Normalize all separators to forward slash for resolution, then convert back
  const joined = `${dir}/${href}`.replace(/\\/g, '/')
  const parts = joined.split('/')

  // Resolve . and .. segments, preserving leading empty string for absolute paths
  const resolved: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === '.') continue
    if (part === '' && i > 0) continue // skip empty parts except the leading one
    if (part === '..') {
      // Don't pop past the root (keep at least the drive letter or leading empty string)
      if (resolved.length > 1) resolved.pop()
    } else {
      resolved.push(part)
    }
  }

  const fullPath = resolved.join(sep)

  // Security: ensure the resolved path is within the project root.
  //
  // **判定は `relativeToBase` に任せる**（区切りの正規化・末尾スラッシュ・Windows での
  // 大小折り畳みを持っている）。プレビュー画像の内外判定（`useMarkdownImages` の `isOurs`）と
  // 別実装にすると、シェルを足したときに両方へ別々に同じ手を入れることになる。
  //
  // `relativeToBase` は base 自身に対して null を返すので、末尾に 1 セグメント足して
  // 聞く。root 自身も root の配下も真になり、外は偽のままになる。
  const probe = `${fullPath}/probe`
  if (relativeToBase(root, probe, shellToPlatform(shell)) === null) return null
  return fullPath
}

/**
 * Give every <img> in the preview a source the webview is allowed to load.
 *
 * Neither kind can be loaded from the markup itself: the webview cannot read a
 * disk-relative path, and the CSP blocks remote hosts. Both end up as `data:`
 * URLs — local files through the usual file IPC, remote ones (#239) only for
 * hosts the user approved, with a chip offering to approve the rest.
 *
 * `base` が null なら（プロジェクトが無いなど）ローカルの画像は解かない。
 */
export async function resolvePreviewImages(container: HTMLElement, base: PreviewPathBase | null): Promise<void> {
  // A matching <source> outranks the <img> we resolve, and a remote srcset
  // outranks its own src, so neither can be left to win.
  for (const source of container.querySelectorAll('picture source')) source.remove()
  const tasks: Promise<void>[] = []
  for (const img of container.querySelectorAll('img')) {
    img.removeAttribute('srcset')
    const src = img.getAttribute('src')
    if (!src || src.startsWith('data:')) continue
    const host = imageHostOf(src)
    if (host) {
      tasks.push(resolveRemoteImage(img, src, host))
      continue
    }
    // http: is neither loadable nor offerable — leave it as the markup had it.
    if (/^https?:/i.test(src)) continue
    if (base) tasks.push(resolveLocalImage(img, src, base))
  }
  // Independent reads: a slow host must not hold up the images next to it.
  await Promise.all(tasks)
}

async function resolveLocalImage(img: HTMLImageElement, src: string, base: PreviewPathBase) {
  // `img.png?v=2` and `img.png#top` name the same file: the suffix tells a
  // browser how to cache or where to scroll, and is no part of the path on disk.
  const resolved = resolvePreviewPath(src.replace(/[?#].*$/, ''), base) // stays within the project root
  if (!resolved || !isEmbeddableImage(resolved)) return
  try {
    const base64 = await fsReadFileBase64(base.shell, resolved)
    img.src = `data:${mimeType(resolved)};base64,${base64}`
  } catch {
    // leave the image broken if it can't be read
  }
}

async function resolveRemoteImage(img: HTMLImageElement, url: string, host: string) {
  // This pass also re-runs on approval, so start from a clean slate: the chip
  // and the hiding are what the previous pass decided, not what the markup says.
  const stale = img.nextElementSibling
  if (stale?.classList.contains('external-image')) stale.remove()
  // Hidden until we know what to show: the src in the markup is the remote one,
  // which the CSP blocks — leaving it visible flashes a broken-image icon.
  img.hidden = true
  if (!useSettingsStore().allowedImageHosts.includes(host)) {
    showImageChip(img, host, url, t('preview.externalImageShow', { host }))
    return
  }
  const dataUrl = await remoteImageDataUrl(url)
  if (dataUrl) {
    img.src = dataUrl
    img.hidden = false
    return
  }
  // Fetch failed — say so on the chip, which retries when clicked.
  showImageChip(img, host, url, t('preview.externalImageFailed', { host }))
}

/**
 * Stand a button carrying the host where an image the preview will not load
 * would have been. The <img> keeps its original src (the CSP is what stops the
 * request) and is only hidden, so the next pass can resolve it in place.
 */
function showImageChip(img: HTMLImageElement, host: string, url: string, label: string) {
  img.hidden = true
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'external-image'
  btn.dataset.host = host
  btn.dataset.url = url
  btn.textContent = label
  btn.title = t('preview.externalImageHint')
  img.after(btn)
}

/**
 * クリックが外部画像のチップ（#239）に当たったら、そのチップ。チップは描くたびに作り直される
 * ので、リスナーはプレビューの容器に置いて、ここで見分ける。
 *
 * **判定は同期で返す。** 呼び出し側はチップでなければ続けてリンクの `preventDefault` を
 * するので、ここを `await` すると、その `preventDefault` がイベントの配送のあとになり、
 * webview がリンク先へ遷移する。
 */
export function imageChipAt(e: MouseEvent): HTMLElement | null {
  return (e.target as HTMLElement).closest<HTMLElement>('.external-image')
}

/**
 * 押されたチップのホストを承認する。承認すると `allowedImageHosts` が変わり、各プレビューの
 * watcher が解き直す。承認済みのホストのチップは取得に失敗したもので、押すとその 1 件だけ
 * 忘れて `retry` で解き直す。
 */
export async function approveImageChip(chip: HTMLElement, retry: () => void): Promise<void> {
  const host = chip.dataset.host
  if (!host) return
  const settings = useSettingsStore()
  if (settings.allowedImageHosts.includes(host)) {
    retryRemoteImage(chip.dataset.url ?? '')
    retry()
    return
  }
  if (await confirmDialog(t('confirm.allowImageHost', { host }))) settings.allowImageHost(host)
}
