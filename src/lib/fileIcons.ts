import { defaultIcon, getAllIcons, getIcon } from 'material-file-icons'
import { fileTypeKey } from './fileType'
import { basename as getBasename } from './paths'

/**
 * `material-file-icons` が既定のアイコンに落ちたとき、こちらの種別から補う（#347）。
 *
 * **判定の主はあちら**（独自の表で多くを拾えているので置き換えない）。ここに置くのは、
 * Pike が種別として知っているのに向こうが知らない名前だけ。値は向こうのアイコン名。
 *
 * **小さく保つこと。** 増えてきたら、それは `material-file-icons` を上げるべきという合図。
 */
const ICON_FALLBACK: Record<string, string> = Object.assign(Object.create(null), {
  // `justfile` / `.justfile` / `Justfile` はどれも既定のアイコンになる（2.4.0 で確認）。
  // レシピを並べるファイルなので Makefile のアイコンを借りる。
  justfile: 'makefile',
  // Text::Xslate のテンプレート（#409）。`.tx` は向こうに無いので、Perl のアイコンを借りる。
  tx: 'perl',
})

/** 名前で引いたアイコンの SVG。`getAllIcons()` は配列を毎回作るので 1 度だけ畳む。 */
let byName: Map<string, string> | null = null
function iconSvgByName(name: string): string | undefined {
  if (!byName) byName = new Map(getAllIcons().map((icon) => [icon.name, icon.svg]))
  return byName.get(name)
}

const cache = new Map<string, string>()

export function fileIconSvg(path: string): string {
  const name = getBasename(path).toLowerCase()
  let svg = cache.get(name)
  if (svg === undefined) {
    const icon = getIcon(name)
    // 既定のアイコンに落ちたときだけ、こちらの種別で補う（#347）。
    const fallback = icon.name === defaultIcon.name ? ICON_FALLBACK[fileTypeKey(name)] : undefined
    svg = (fallback && iconSvgByName(fallback)) || icon.svg
    cache.set(name, svg)
  }
  return svg
}
