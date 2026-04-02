import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { php } from '@codemirror/lang-php'
import { rust } from '@codemirror/lang-rust'
import { yaml } from '@codemirror/lang-yaml'
import { LanguageSupport, StreamLanguage } from '@codemirror/language'
import { c, cpp, csharp, java, kotlin, objectiveC, scala } from '@codemirror/legacy-modes/mode/clike'
import { css as cssMode, sCSS } from '@codemirror/legacy-modes/mode/css'
import { diff } from '@codemirror/legacy-modes/mode/diff'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { go } from '@codemirror/legacy-modes/mode/go'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { nginx } from '@codemirror/legacy-modes/mode/nginx'
import { perl } from '@codemirror/legacy-modes/mode/perl'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf'
import { python } from '@codemirror/legacy-modes/mode/python'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { standardSQL } from '@codemirror/legacy-modes/mode/sql'
import { swift } from '@codemirror/legacy-modes/mode/swift'
import { toml } from '@codemirror/legacy-modes/mode/toml'

function legacy(mode: Parameters<typeof StreamLanguage.define>[0]): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(mode))
}

const EXT_MAP: Record<string, () => LanguageSupport> = {
  // Official CM6 packages
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  js: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  mjs: () => javascript(),
  rs: () => rust(),
  md: () => markdown(),
  yaml: () => yaml(),
  yml: () => yaml(),
  vue: () => html(),
  html: () => html(),
  htm: () => html(),
  svg: () => html(),
  json: () => json(),
  jsonc: () => json(),
  php: () => php(),
  phtml: () => php(),
  // Legacy modes
  go: () => legacy(go),
  sh: () => legacy(shell),
  bash: () => legacy(shell),
  zsh: () => legacy(shell),
  py: () => legacy(python),
  rb: () => legacy(ruby),
  pl: () => legacy(perl),
  pm: () => legacy(perl),
  java: () => legacy(java),
  kt: () => legacy(kotlin),
  kts: () => legacy(kotlin),
  scala: () => legacy(scala),
  swift: () => legacy(swift),
  c: () => legacy(c),
  h: () => legacy(c),
  cpp: () => legacy(cpp),
  cc: () => legacy(cpp),
  cxx: () => legacy(cpp),
  hpp: () => legacy(cpp),
  cs: () => legacy(csharp),
  m: () => legacy(objectiveC),
  css: () => legacy(cssMode),
  scss: () => legacy(sCSS),
  sql: () => legacy(standardSQL),
  lua: () => legacy(lua),
  dockerfile: () => legacy(dockerFile),
  toml: () => legacy(toml),
  diff: () => legacy(diff),
  patch: () => legacy(diff),
  ps1: () => legacy(powerShell),
  psm1: () => legacy(powerShell),
  conf: () => legacy(nginx),
  proto: () => legacy(protobuf),
}

const NAME_MAP: Record<string, () => LanguageSupport> = {
  dockerfile: () => legacy(dockerFile),
  makefile: () => legacy(shell),
  '.bashrc': () => legacy(shell),
  '.zshrc': () => legacy(shell),
  '.gitignore': () => legacy(shell),
}

const LABEL_MAP: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript (JSX)',
  js: 'JavaScript',
  jsx: 'JavaScript (JSX)',
  mjs: 'JavaScript',
  rs: 'Rust',
  go: 'Go',
  py: 'Python',
  rb: 'Ruby',
  pl: 'Perl',
  pm: 'Perl',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  scala: 'Scala',
  swift: 'Swift',
  c: 'C',
  h: 'C',
  cpp: 'C++',
  cc: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  cs: 'C#',
  m: 'Objective-C',
  php: 'PHP',
  phtml: 'PHP',
  json: 'JSON',
  jsonc: 'JSON',
  md: 'Markdown',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  html: 'HTML',
  htm: 'HTML',
  vue: 'Vue',
  svg: 'SVG',
  css: 'CSS',
  scss: 'SCSS',
  sql: 'SQL',
  lua: 'Lua',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  ps1: 'PowerShell',
  psm1: 'PowerShell',
  dockerfile: 'Dockerfile',
  diff: 'Diff',
  patch: 'Diff',
  conf: 'Nginx',
  proto: 'Protobuf',
}

export function getLanguageLabel(filename: string): string {
  const name = filename.split(/[/\\]/).pop()?.toLowerCase() ?? ''
  if (name === 'dockerfile') return 'Dockerfile'
  if (name === 'makefile') return 'Makefile'
  const ext = name.split('.').pop() ?? ''
  return LABEL_MAP[ext] ?? 'Plain Text'
}

export function getLanguage(filename: string): LanguageSupport | null {
  const name = filename.split(/[/\\]/).pop()?.toLowerCase() ?? ''
  if (NAME_MAP[name]) return NAME_MAP[name]()
  const ext = name.split('.').pop() ?? ''
  return EXT_MAP[ext]?.() ?? null
}
