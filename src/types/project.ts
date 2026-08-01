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
  icon?: string
  group?: string
  remoteUrl?: string
  /** Manual position inside its group. Unlike the other fields this one is
   *  overwritten rather than gap-filled on merge: an order is one user's intent
   *  over a whole list, so a half-merged one means nothing (#203). */
  order?: number
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
  /** Preset accent color name for identifying windows/projects (resolved to a
   *  CSS value by `projectColorValue`) */
  color?: string
  /** Emoji shown in front of the name in the panel and the switcher (#203).
   *  Stored as the character itself — validate with `projectIconValue`. */
  icon?: string
  /** Manual position within the project's group, assigned by drag & drop in the
   *  panel's group mode (#203). Absent until the group is first reordered; those
   *  projects fall back to name order. */
  order?: number
  /** git remote `origin` URL, refreshed whenever the git panel resolves one.
   *  Lets a project whose root is missing on this machine be cloned back into
   *  place (#164). Absent for non-repositories and repos without an origin. */
  remoteUrl?: string
}
