import type { ShellType } from './tab'

export interface PinnedTabDef {
  id: string
  kind: 'terminal'
  title: string
  autoStart?: string
}

export interface SessionTabDef {
  id: string
  kind: 'terminal' | 'editor'
  title: string
  pinned: boolean
  autoStart?: string
  path?: string
  content?: string
}

export interface LastSession {
  tabs: SessionTabDef[]
  activeTabId: string | null
}

export interface ProjectConfig {
  id: string
  name: string
  root: string
  shell: ShellType
  pinnedTabs: PinnedTabDef[]
  lastOpened: string
  lastSession?: LastSession
  codexThreadId?: string
}
