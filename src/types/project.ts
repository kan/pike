import type { ShellType } from './tab'

export interface PinnedTabDef {
  id: string
  kind: 'terminal'
  title: string
  autoStart?: string
}

export interface ProjectConfig {
  id: string
  name: string
  root: string
  shell: ShellType
  pinnedTabs: PinnedTabDef[]
  lastOpened: string
}
