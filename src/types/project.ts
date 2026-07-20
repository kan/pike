import type { ProjectPlatform } from '../lib/projectPaths'
import type { ShellType } from './tab'

/**
 * A project as it travels through the sync file (#164). Only machine-independent
 * fields: the path is relative to this machine's base, and the shell (WSL distro
 * / Windows shell), pinned tabs, session and recency stay local.
 */
export interface SyncedProject {
  id: string
  name: string
  platform: ProjectPlatform
  /** Path below the platform's base directory, forward-slashed. */
  path: string
  color?: string
  group?: string
  remoteUrl?: string
}

/** A project hidden on this machine — kept by id so sync can't resurrect it. */
export interface HiddenProject {
  id: string
  /** Last known name, so the settings list can label it after deletion. */
  name: string
}

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
  group?: string
  /** Preset accent color (hex) for identifying windows/projects */
  color?: string
  /** git remote `origin` URL, refreshed whenever the git panel resolves one.
   *  Lets a project whose root is missing on this machine be cloned back into
   *  place (#164). Absent for non-repositories and repos without an origin. */
  remoteUrl?: string
}
