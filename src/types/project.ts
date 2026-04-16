import type { ShellType } from './tab'

export interface PinnedTabDef {
  id: string
  kind: 'terminal' | 'agent-chat'
  title: string
  autoStart?: string
  agentType?: string
}

export interface SessionTabDef {
  id: string
  kind: 'terminal' | 'editor' | 'agent-chat' | 'codex-chat'
  title: string
  pinned: boolean
  autoStart?: string
  path?: string
  content?: string
  agentType?: string
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
}
