import { getIcon } from 'material-file-icons'
import { basename as getBasename } from './paths'

const cache = new Map<string, string>()

export function fileIconSvg(path: string): string {
  const name = getBasename(path).toLowerCase()
  let svg = cache.get(name)
  if (svg === undefined) {
    svg = getIcon(name).svg
    cache.set(name, svg)
  }
  return svg
}
