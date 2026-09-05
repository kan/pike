import type { ProjectPlatform } from '../lib/projectPaths'
import type { PaneId, ShellType } from './tab'

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
  /** Custom golangci-lint command (#213). Machine-independent: it names the
   *  project's own lint entry point, not anything about this machine. */
  golangciCommand?: string
  /** Manual position inside its group. Unlike the other fields this one is
   *  overwritten rather than gap-filled on merge: an order is one user's intent
   *  over a whole list, so a half-merged one means nothing (#203). */
  order?: number
}

/**
 * A project hidden on this machine, so the merge-only sync cannot resurrect it.
 * Carries the root and origin as well as the id because the sync file can hold
 * several ids for one repository — see the match in `pullProjectsFromSync`.
 */
export interface HiddenProject {
  id: string
  /** Last known name, so the settings list can label it after deletion. */
  name: string
  /** Both absent for entries hidden before Pike started recording them. */
  root?: string
  remoteUrl?: string
}

/**
 * **この 2 つは「Pike が書く形」を表す。ディスクにある形ではない。**（#275）
 *
 * 古い `project.json` には廃止した `'agent-chat'` / `'codex-chat'` の行が残っていることが
 * あるが、互換はパース境界（Rust 側の `kind: String`）が持つ。TS の型は実行時に何も検証
 * しないので、死んだ値を union に残しても読み込みやすさは 1 つも変わらず、「この分岐はもう
 * 要らない」を `just check` が教えてくれなくなるだけになる。読み側は知らない kind を
 * 読み飛ばす（`restoreSession`）。
 */
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
  /** 左右どちらのペインで開いていたか（#308）。省略＝左。 */
  pane?: PaneId
}

export interface LastSession {
  tabs: SessionTabDef[]
  /**
   * フォーカスのあるペインで選んでいたタブ。分割していたセッションでは
   * `panes.active[panes.focused]` と同じ値で、**古い版の Pike のために残してある**
   * （あちらはこのフィールドしか読まない）。
   */
  activeTabId: string | null
  /**
   * 作業領域の分割（#308）。**この節があること自体が「分割していた」**で、無ければ
   * 1 ペイン。分割比はマシンに依存する見た目なので、ここではなく localStorage に持つ。
   */
  panes?: {
    focused: PaneId
    active: Record<PaneId, string | null>
  }
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
  /** Command the Problems panel runs instead of the golangci-lint line derived
   *  from go.mod (#213) — for projects whose toolchain lives in a container,
   *  e.g. `docker compose exec -T golang make lint`. Runs in the Go module's
   *  directory like the built-in one, so output paths still resolve. */
  golangciCommand?: string
}
