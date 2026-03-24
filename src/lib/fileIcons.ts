const EXT_ICONS: Record<string, string> = {
  ts: '🟦', tsx: '🟦',
  js: '🟨', jsx: '🟨', mjs: '🟨',
  vue: '🟩',
  rs: '🦀',
  go: '🐹',
  py: '🐍',
  rb: '💎',
  java: '☕', kt: '☕',
  c: '⚙', cpp: '⚙', h: '⚙', hpp: '⚙',
  cs: '#',
  json: '{}',
  yaml: '📋', yml: '📋', toml: '📋',
  md: '📝', txt: '📝',
  css: '🎨', scss: '🎨', less: '🎨',
  html: '🌐', htm: '🌐', svg: '🌐',
  sh: '$', bash: '$', zsh: '$', fish: '$',
  lock: '🔒',
  png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', ico: '🖼', webp: '🖼',
  wasm: '🔮',
}

const NAME_ICONS: Record<string, string> = {
  'dockerfile': '🐋',
  '.gitignore': '🙈',
  '.env': '🔑',
  'makefile': '🔧',
  'cmakelists.txt': '🔧',
}

import { basename as getBasename } from './paths';

export function fileIcon(path: string): string {
  const name = getBasename(path).toLowerCase()
  if (NAME_ICONS[name]) return NAME_ICONS[name]
  const ext = name.split('.').pop() ?? ''
  return EXT_ICONS[ext] ?? '📄'
}
