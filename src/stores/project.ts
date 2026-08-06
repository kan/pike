import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { confirmDialog, infoDialog } from '../composables/useConfirmDialog'
import { locale, t } from '../i18n'
import { baseForPlatform, joinBase, type ProjectBase, relativeToBase } from '../lib/projectPaths'
import {
  fsDirsExist,
  gitRemoteUrls,
  menusRefresh,
  openProjectWindow,
  projectAddOpen,
  projectCreate,
  projectDelete,
  projectGetLast,
  projectGroupsList,
  projectGroupsSave,
  projectList,
  projectSetLast,
  projectUpdate,
} from '../lib/tauri'
import { ephemeralWindow, isMainWindow } from '../lib/window'
import type { ProjectConfig, SyncedProject } from '../types/project'
import { quoteArg, shellId, shellToPlatform, shellToType } from '../types/tab'
import { useDiagnosticsStore } from './diagnostics'
import { useSearchStore } from './search'
import { useSettingsStore } from './settings'
import { useTabStore } from './tabs'

// Debounce for republishing the project list to the sync file. Longer than the
// settings debounce: a push is a read-modify-write of the whole file.
const SYNC_PUSH_DEBOUNCE_MS = 2000

/** What a pull did, so the caller can explain an empty result (#164). */
export interface PullResult {
  /** Entries found in the sync file. */
  entries: number
  created: number
  /** Skipped because this machine hid them. */
  hidden: number
  /** Skipped because no base (or WSL distro) resolves their path here. */
  unresolvable: number
}

const RESUME_MAP: Record<string, string> = {
  claude: 'claude --continue',
}

function resolveResumeCommand(autoStart?: string): string | undefined {
  if (!autoStart) return undefined
  return RESUME_MAP[autoStart] ?? autoStart
}

export const useProjectStore = defineStore('project', () => {
  const projects = ref<ProjectConfig[]>([])
  const groups = ref<string[]>([])
  const currentProject = ref<ProjectConfig | null>(null)
  const showSwitcher = ref(false)
  const showQuickOpen = ref(false)

  // The git worktree the file tree / git / search / tasks / docker / editor
  // surfaces currently reference. `null` means the project's main root. Reset
  // whenever the project changes; switching worktrees is window-scoped and not
  // persisted.
  const activeWorktreeRoot = ref<string | null>(null)
  // Single source of truth for "which root do root-relative operations use".
  // Always a string (empty only when no project is open), so callers never need
  // their own `?? project.root` fallback — any remaining `project.root` read for
  // a root-relative operation is a bug that forgot to follow the worktree.
  const activeRoot = computed<string>(() => activeWorktreeRoot.value ?? currentProject.value?.root ?? '')

  // Project ids whose `root` is not a directory on this machine (#164): the
  // repository was registered on another machine, moved, or deleted. Populated
  // by `checkRoots`, which the project panel runs when it opens — ids absent
  // from the set are treated as present, so an unchecked list looks normal.
  const missingRoots = ref<Set<string>>(new Set())
  // Each WSL distro in the list costs a `wsl.exe` launch, so a re-check this
  // soon after the last one reuses the previous answer.
  const ROOT_CHECK_TTL_MS = 10_000
  let lastRootCheck = 0

  let saveTimer: ReturnType<typeof setTimeout> | null = null

  async function loadProjects() {
    projects.value = await projectList()
  }

  /** Group projects by what a batched shell probe can answer in one call: one
   *  bucket per WSL distro, one for all Windows shells (native probes run in
   *  this process and never look at the shell). */
  function byProbeShell(list: ProjectConfig[]): ProjectConfig[][] {
    const buckets = new Map<string, ProjectConfig[]>()
    for (const p of list) {
      const key = p.shell.kind === 'wsl' ? shellId(p.shell) : 'windows'
      const bucket = buckets.get(key)
      if (bucket) bucket.push(p)
      else buckets.set(key, [p])
    }
    return [...buckets.values()]
  }

  /** Refresh which roots exist, then fill in any origin URL still unknown.
   *  Each WSL distro costs a `wsl.exe` launch per probe, so repeat calls within
   *  `ROOT_CHECK_TTL_MS` reuse the last result unless forced. */
  async function checkRoots(force = false) {
    if (!force && Date.now() - lastRootCheck < ROOT_CHECK_TTL_MS) return
    lastRootCheck = Date.now()
    const missing = new Set<string>()
    await Promise.all(
      byProbeShell(projects.value).map(async (group) => {
        const flags = await fsDirsExist(
          group[0].shell,
          group.map((p) => p.root),
        ).catch(() => null)
        // A failed probe says nothing about the roots — leave them as present.
        if (!flags) return
        group.forEach((p, i) => {
          if (!flags[i]) missing.add(p.id)
        })
      }),
    )
    missingRoots.value = missing
    await backfillRemotes()
  }

  /** Read `origin` for every present project that has no stored URL yet, and
   *  save what comes back. Projects registered before Pike started recording
   *  the remote (#164) would otherwise only get one the next time they are
   *  opened, which never happens for the ones already gone from this machine. */
  async function backfillRemotes() {
    const targets = projects.value.filter((p) => !p.remoteUrl && !missingRoots.value.has(p.id))
    if (targets.length === 0) return
    await Promise.all(
      byProbeShell(targets).map(async (group) => {
        const urls = await gitRemoteUrls(
          group[0].shell,
          group.map((p) => p.root),
        ).catch(() => null)
        if (!urls) return
        await Promise.all(
          group.map((p, i) => (urls[i] ? saveProject({ ...p, remoteUrl: urls[i] }).catch(() => {}) : null)),
        )
      }),
    )
  }

  /** Clone a missing project back into place from its stored origin URL. The
   *  clone runs in a terminal tab (like task / compose runs) so credential and
   *  passphrase prompts work, and the tab is kept open on exit so failures stay
   *  readable. When it succeeds `onCloned` runs — the caller already knows what
   *  the user asked for; without one, offer to switch to the project. */
  function cloneProject(id: string, onCloned?: () => void) {
    const project = projects.value.find((p) => p.id === id)
    if (!project?.remoteUrl) return
    // `git clone` creates the leading directories, so an absolute destination
    // needs no cwd — the terminal starts wherever the shell defaults to.
    const command = `git clone ${quoteArg(project.shell, project.remoteUrl)} ${quoteArg(project.shell, project.root)}`
    useTabStore().runCommandTab(command, undefined, project.shell, {
      title: `clone ${project.name}`,
      keepOnError: true,
      onExit: async (code) => {
        await checkRoots(true).catch(() => {})
        if (code !== 0 || missingRoots.value.has(id)) return
        if (onCloned) {
          onCloned()
          return
        }
        if (currentProject.value?.id === id) return
        if (await confirmDialog(t('project.cloneDoneSwitch', { name: project.name }))) {
          await switchProject(id)
        }
      },
    })
  }

  /**
   * Make sure a project's root is on this machine before it is opened (#212).
   * The quick launch surfaces — the switcher and, through the window it opens,
   * the taskbar jump list and the tray — list projects the sync file brought in
   * (#164), and those are not cloned here until someone asks for them.
   *
   * Returns whether the root is there now. `false` means the caller must not
   * open the project: either there is no origin URL to clone from, or a clone
   * just started and `onCloned` runs once it lands.
   */
  async function ensureRootPresent(id: string, onCloned: () => void): Promise<boolean> {
    const project = projects.value.find((p) => p.id === id)
    if (!project) return false
    // Ask about this one root instead of `checkRoots`: opening a project should
    // not wait on a `wsl.exe` launch per distro plus an origin read per project
    // when the answer needed is a single boolean. A probe that fails says
    // nothing, so treat the root as present and let the open proceed.
    const [present] = await fsDirsExist(project.shell, [project.root]).catch(() => [true])
    if (present) return true
    if (!project.remoteUrl) {
      await infoDialog(t('project.missingNoRemote', { name: project.name, root: project.root }))
      return false
    }
    if (await confirmDialog(t('project.cloneConfirm', { name: project.name, url: project.remoteUrl }))) {
      cloneProject(id, onCloned)
    }
    return false
  }

  // --- Project list sync (#164) -------------------------------------------
  // The list rides in the same file as the UI settings but under its own key,
  // because it merges by project id instead of last-write-wins: a machine only
  // ever adds entries, never removes another machine's. What stays local: the
  // real path (only the base-relative part travels), shell, pinned tabs,
  // session, recency, and agent session ids.

  /** Projects visible on this machine — hidden ones (#164) are filtered out. */
  const visibleProjects = computed(() => projects.value.filter((p) => !useSettingsStore().isProjectHidden(p.id)))

  /** Portable form of a project, or null when it cannot be shared: no base set
   *  for its platform, or a root outside that base. */
  function toSynced(project: ProjectConfig, base: ProjectBase): SyncedProject | null {
    const platform = shellToPlatform(project.shell)
    const path = relativeToBase(baseForPlatform(base, platform), project.root, platform)
    if (path === null) return null
    return {
      id: project.id,
      name: project.name,
      platform,
      path,
      color: project.color,
      icon: project.icon,
      group: project.group,
      remoteUrl: project.remoteUrl,
      order: project.order,
    }
  }

  /** Projects that stay on this machine: no base set for their platform, or a
   *  root outside it. Surfaced in settings so the exclusion isn't silent. */
  const unsyncableProjects = computed(() => projects.value.filter((p) => !toSynced(p, useSettingsStore().projectBase)))

  /** The shared group list: names in display order (#203). */
  function parseSyncedGroups(raw: unknown): string[] {
    if (!Array.isArray(raw)) return []
    return raw.filter((g): g is string => typeof g === 'string' && !!g.trim())
  }

  function parseSyncedProjects(raw: unknown): SyncedProject[] {
    if (!Array.isArray(raw)) return []
    return raw.filter((e): e is SyncedProject => {
      if (!e || typeof e !== 'object') return false
      const p = e as Partial<SyncedProject>
      return (
        typeof p.id === 'string' &&
        !!p.id &&
        typeof p.name === 'string' &&
        typeof p.path === 'string' &&
        (p.platform === 'wsl' || p.platform === 'windows')
      )
    })
  }

  /**
   * Publish this machine's shareable projects. Entries already in the file keep
   * their name and path and only get their empty fields filled: the merge is
   * symmetric with the pull, so two machines that disagree cannot overwrite each
   * other on every launch. Which also means a rename stays local, matching what
   * the pull does with a name it receives.
   *
   * Ordering is the exception (#203): `order` and the group list are published
   * as-is. Gap-filling an order would freeze it at whatever the first machine
   * wrote, and half of one machine's order interleaved with half of another's
   * is not an order anyone asked for — so here the last push wins.
   */
  async function pushProjectsToSync() {
    const settings = useSettingsStore()
    if (!settings.syncFilePath) return
    const base = settings.projectBase
    await settings.mutateSyncFile((file) => {
      const existing = parseSyncedProjects(file.projects)
      const merged = new Map(existing.map((e) => [e.id, e]))
      for (const project of projects.value) {
        const entry = toSynced(project, base)
        if (!entry) continue
        const previous = merged.get(entry.id)
        merged.set(
          entry.id,
          previous
            ? {
                ...previous,
                color: previous.color ?? entry.color,
                icon: previous.icon ?? entry.icon,
                group: previous.group ?? entry.group,
                remoteUrl: previous.remoteUrl ?? entry.remoteUrl,
                order: entry.order,
              }
            : entry,
        )
      }
      const out = [...merged.values()]
      const outGroups = [...groups.value]
      // Skip the write when nothing changed: every window pushes, and a plain
      // startup re-publishes what it just read, so the sync folder (usually
      // Dropbox) would otherwise see a touched file on every launch.
      const same =
        JSON.stringify(out) === JSON.stringify(existing) &&
        JSON.stringify(outGroups) === JSON.stringify(parseSyncedGroups(file.groups))
      return same ? null : { projects: out, groups: outGroups }
    })
  }

  /**
   * Take in projects other machines registered. Existing projects only get
   * their gaps filled (a local edit always wins), missing ones are created
   * under this machine's base, and hidden ids are skipped so a local delete is
   * not undone by the next pull. Returns what happened so callers can say why
   * nothing appeared — every skip here is silent otherwise.
   */
  async function pullProjectsFromSync(): Promise<PullResult> {
    const result: PullResult = { entries: 0, created: 0, hidden: 0, unresolvable: 0 }
    const settings = useSettingsStore()
    if (!settings.syncFilePath) return result
    const base = settings.projectBase
    const file = await settings.readSyncFile()
    const entries = file ? parseSyncedProjects(file.projects) : []
    result.entries = entries.length
    if (entries.length === 0) return result
    // Re-read first: writing back a config this window loaded at startup would
    // roll back the session another window has been updating since.
    await loadProjects()
    const known = new Map(projects.value.map((p) => [p.id, p]))
    // A project already registered under a different id (same origin or same
    // resolved root) must not be duplicated — both copies would then be pushed.
    const localRemotes = new Set(projects.value.map((p) => p.remoteUrl).filter(Boolean))
    const localRoots = new Set(projects.value.map((p) => p.root.toLowerCase()))
    // Patches to known projects go out together at the end: adopting a shared
    // order (#203) touches every project in a reordered group, and one
    // round trip each would make the startup pull that much longer.
    const patched: ProjectConfig[] = []
    for (const entry of entries) {
      if (settings.isProjectHidden(entry.id)) {
        result.hidden++
        continue
      }
      const local = known.get(entry.id)
      if (local) {
        const patch: Partial<ProjectConfig> = {}
        if (!local.color && entry.color) patch.color = entry.color
        if (!local.icon && entry.icon) patch.icon = entry.icon
        if (!local.group && entry.group) patch.group = entry.group
        if (!local.remoteUrl && entry.remoteUrl) patch.remoteUrl = entry.remoteUrl
        // Order is adopted, not gap-filled — see pushProjectsToSync.
        if (entry.order !== undefined && entry.order !== local.order) patch.order = entry.order
        if (Object.keys(patch).length > 0) patched.push({ ...local, ...patch })
        continue
      }
      const baseDir = baseForPlatform(base, entry.platform)
      // Unresolvable here: no base for that platform, or (for WSL) no distro to
      // resolve it in. The entry stays in the file for a machine that has one.
      if (!baseDir || (entry.platform === 'wsl' && !base.wslDistro)) {
        result.unresolvable++
        continue
      }
      const root = joinBase(baseDir, entry.path, entry.platform)
      if (localRoots.has(root.toLowerCase())) continue
      if (entry.remoteUrl && localRemotes.has(entry.remoteUrl)) continue
      await addProject({
        id: entry.id,
        name: entry.name,
        root,
        shell:
          entry.platform === 'wsl'
            ? { kind: 'wsl', distro: base.wslDistro }
            : shellToType(settings.defaultWindowsShellKind()),
        pinnedTabs: [],
        lastOpened: new Date().toISOString(),
        color: entry.color,
        icon: entry.icon,
        group: entry.group,
        remoteUrl: entry.remoteUrl,
        order: entry.order,
      }).catch(() => {})
      localRoots.add(root.toLowerCase())
      if (entry.remoteUrl) localRemotes.add(entry.remoteUrl)
      result.created++
    }
    await Promise.all(patched.map((config) => saveProject(config).catch(() => {})))
    // Take the shared group order (#203), keeping groups only this machine has.
    // loadGroups() also picks up any group the new projects reference.
    const sharedGroups = parseSyncedGroups(file?.groups)
    await loadGroups()
    if (sharedGroups.length > 0) await reorderGroups(sharedGroups.filter((g) => groups.value.includes(g)))
    if (result.created > 0) await checkRoots(true)
    return result
  }

  // Publish on any change to a shared field. Keyed like the menu watcher below
  // so session flushes and recency updates don't republish. Only the main
  // window writes: every window sees the same project set (the project_updated
  // broadcast keeps them in step), so N windows would just mean N identical
  // read-modify-writes racing on one file.
  let pushTimer: ReturnType<typeof setTimeout> | null = null
  if (isMainWindow()) {
    watch(
      () =>
        JSON.stringify([
          projects.value.map((p) => [
            p.id,
            p.name,
            p.root,
            p.color,
            p.icon,
            p.group,
            p.order,
            p.remoteUrl,
            p.shell.kind,
          ]),
          groups.value,
        ]),
      () => {
        if (pushTimer) clearTimeout(pushTimer)
        pushTimer = setTimeout(() => {
          pushTimer = null
          pushProjectsToSync().catch(() => {})
        }, SYNC_PUSH_DEBOUNCE_MS)
      },
    )
  }

  // Keep `missingRoots` owned by the store rather than by whoever happens to
  // render the list: any change to the set of roots re-probes, so every entry
  // point (panel, switcher) sees the same answer. Keyed on id+root only, so
  // recency and session writes don't re-probe.
  watch(
    () => projects.value.map((p) => `${p.id} ${p.root}`).join('\n'),
    () => {
      checkRoots(true).catch(() => {})
    },
  )

  // Rebuild the taskbar jump list (#160) and system-tray menu (#161) whenever a
  // menu-relevant field changes: the project set, a name/root edit, recency
  // order, or the UI locale (label language). Keyed on exactly those fields so
  // ~1s-debounced session-flush writes — which mutate `lastSession` on objects
  // that also live in `projects` — do NOT trigger a refresh: Vue's per-property
  // tracking never re-runs this getter for `lastSession`. Both are single
  // per-process OS resources (Rust dedups the jump list by signature), so
  // refreshing from any window is enough. Best-effort, Windows-only; each
  // persists from the last run so a failed refresh just goes slightly stale.
  watch(
    () => JSON.stringify([locale.value, projects.value.map((p) => [p.id, p.name, p.root, p.lastOpened])]),
    () => {
      menusRefresh(locale.value).catch(() => {})
    },
  )

  async function loadGroups() {
    try {
      const stored = await projectGroupsList()
      const set = new Set(stored)
      let added = false
      for (const p of projects.value) {
        const g = p.group?.trim()
        if (g && !set.has(g)) {
          stored.push(g)
          set.add(g)
          added = true
        }
      }
      groups.value = stored
      if (added) await persistGroups()
    } catch {
      groups.value = []
    }
  }

  async function persistGroups() {
    try {
      await projectGroupsSave(groups.value)
    } catch {
      // best-effort
    }
  }

  async function addGroup(name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    if (groups.value.includes(trimmed)) return
    groups.value = [...groups.value, trimmed]
    await persistGroups()
  }

  async function renameGroup(oldName: string, newName: string) {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === oldName) return
    if (groups.value.includes(trimmed)) {
      // merge into existing group
      groups.value = groups.value.filter((g) => g !== oldName)
    } else {
      groups.value = groups.value.map((g) => (g === oldName ? trimmed : g))
    }
    await persistGroups()
    const targets = projects.value.filter((p) => p.group === oldName)
    await Promise.all(targets.map((p) => saveProject({ ...p, group: trimmed })))
  }

  async function removeGroup(name: string) {
    groups.value = groups.value.filter((g) => g !== name)
    await persistGroups()
    const targets = projects.value.filter((p) => p.group === name)
    await Promise.all(targets.map((p) => saveProject({ ...p, group: undefined })))
  }

  async function setProjectGroup(projectId: string, group: string | undefined) {
    const project = projects.value.find((p) => p.id === projectId)
    if (!project) return
    const normalized = group?.trim() ? group.trim() : undefined
    if (project.group === normalized) return
    // The manual position belongs to the group it was set in (#203): carrying it
    // over would drop the project into the middle of the new one. Without an
    // order it lands at the end, where the drop happened.
    await saveProject({ ...project, group: normalized, order: undefined })
    if (normalized) await addGroup(normalized)
  }

  /** Put the groups in this order (#203). The array order IS the stored order,
   *  so reordering is just a rewrite of groups.json. */
  async function reorderGroups(ordered: string[]) {
    // Keep any group the caller did not mention (another window may have added
    // one since the panel rendered) instead of dropping it from the file.
    const rest = groups.value.filter((g) => !ordered.includes(g))
    const next = [...ordered, ...rest]
    // The sync pull calls this on every launch with the shared order, which is
    // usually the order already on disk.
    if (next.length === groups.value.length && next.every((g, i) => g === groups.value[i])) return
    groups.value = next
    await persistGroups()
  }

  /**
   * Assign `order` 0..n-1 along `orderedIds`, optionally moving them all into
   * `group` (#203). Only projects whose stored values actually change are
   * written: each save is a whole-object `project_update` plus a cross-window
   * broadcast, so a drag that shifts one row should not rewrite the group.
   */
  async function reorderProjects(orderedIds: string[], group: string | undefined) {
    const normalized = group?.trim() ? group.trim() : undefined
    const writes: ProjectConfig[] = []
    orderedIds.forEach((id, index) => {
      const project = projects.value.find((p) => p.id === id)
      if (!project) return
      if (project.order === index && project.group === normalized) return
      writes.push({ ...project, order: index, group: normalized })
    })
    // Parallel like renameGroup/removeGroup: an insertion at the top shifts the
    // whole group, and each write is its own file.
    await Promise.all(writes.map((config) => saveProject(config)))
    if (normalized) await addGroup(normalized)
  }

  async function restoreLastProject() {
    await loadProjects()
    // Take in projects registered on other machines. Not awaited: the sync file
    // usually sits in a cloud folder, where a read can block for seconds on an
    // un-hydrated placeholder, and nothing here should hold up the first window.
    // Newly created projects show up in the list as they arrive. Only this path
    // pulls — child windows are handed a project id, and concurrent merges would
    // race on the same file.
    pullProjectsFromSync().catch(() => {})
    const lastIds = await projectGetLast().catch(() => [] as string[])
    // Clear the list immediately; each window re-adds itself via projectAddOpen
    projectSetLast([]).catch(() => {})
    if (lastIds.length > 0) {
      // Main window opens the first project
      const mainId = lastIds[0]
      if (projects.value.find((p) => p.id === mainId)) {
        await switchProject(mainId)
      }
      // Remaining projects open in separate windows
      for (const id of lastIds.slice(1)) {
        if (projects.value.find((p) => p.id === id)) {
          openProjectWindow(id).catch(() => {})
        }
      }
      return
    }
    // Nothing to restore: show the switcher so the user can open/create a
    // project or switch this window into global mode. Shown even with zero
    // projects (first-ever launch) so the global-mode entry is reachable.
    showSwitcher.value = true
  }

  async function switchProject(id: string, opts?: { restoreSession?: boolean }) {
    if (saveTimer) clearTimeout(saveTimer)
    const tabStore = useTabStore()
    const searchStore = useSearchStore()
    const project = projects.value.find((p) => p.id === id)
    if (!project) return
    // Switching tears down every tab in this window, so ask before killing a
    // terminal that is still running something (#178).
    if (!(await tabStore.confirmBusyTerminals(tabStore.tabs, 'switch'))) return
    // Elevated admin project window opens the project context only; the caller
    // adds the single pinned-shell terminal, so skip session/pinned restore.
    const restore = opts?.restoreSession !== false

    searchStore.clear()
    searchStore.backend = null
    useDiagnosticsStore().clear()
    activeWorktreeRoot.value = null

    await tabStore.clearAllTabs()

    project.lastOpened = new Date().toISOString()
    currentProject.value = project

    // Fire-and-forget: don't block tab restoration on metadata persistence
    Promise.all([projectUpdate(project).catch(() => {}), projectAddOpen(id).catch(() => {})])

    if (!restore) return

    if (project.lastSession && project.lastSession.tabs.length > 0) {
      for (const def of project.lastSession.tabs) {
        if (def.kind === 'terminal') {
          tabStore.addTerminalTab({
            id: def.id,
            title: def.title,
            pinned: def.pinned,
            autoStart: def.pinned ? resolveResumeCommand(def.autoStart) : undefined,
            cwd: project.root,
            shell: project.shell,
          })
        } else if (def.kind === 'editor') {
          if (def.path) {
            tabStore.addEditorTab({ path: def.path })
          } else if (def.content !== undefined) {
            tabStore.addBlankEditorTab({ title: def.title, content: def.content })
          }
        } else if (def.kind === 'codex-chat' || def.kind === 'agent-chat') {
          const settings = useSettingsStore()
          const agentType =
            (def.agentType as 'codex' | 'claude-code') ??
            (settings.agentDefault === 'ask' ? 'claude-code' : settings.agentDefault)
          tabStore.addAgentChatTab({ pinned: def.pinned, agentType })
        }
      }
      if (project.lastSession.activeTabId) {
        tabStore.setActiveTab(project.lastSession.activeTabId)
      }
    } else {
      for (const def of project.pinnedTabs) {
        if (def.kind === 'agent-chat') {
          tabStore.addAgentChatTab({
            pinned: true,
            agentType: (def.agentType as 'codex' | 'claude-code') ?? 'claude-code',
          })
        } else {
          tabStore.addTerminalTab({
            id: def.id,
            title: def.title,
            pinned: true,
            autoStart: def.autoStart,
            cwd: project.root,
            shell: project.shell,
          })
        }
      }
    }

    // Ensure at least one plain terminal tab exists (for CWD detection, etc.)
    const hasPlainTerminal = tabStore.tabs.some((t) => t.kind === 'terminal' && !t.autoStart)
    if (!hasPlainTerminal) {
      tabStore.addTerminalTab({ cwd: project.root, shell: project.shell })
    }
  }

  async function flushSession() {
    // Ephemeral (elevated admin) window: never persist — its lean session would
    // clobber the real one written by the non-elevated instance (#138).
    if (ephemeralWindow.value) return
    if (!currentProject.value) return
    currentProject.value.lastSession = useTabStore().snapshotSession()
    await projectUpdate(currentProject.value).catch(() => {})
  }

  function saveSessionDebounced() {
    if (!currentProject.value) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushSession, 1000)
  }

  async function saveSessionNow() {
    if (saveTimer) clearTimeout(saveTimer)
    await flushSession()
  }

  /**
   * A project id not already taken locally, nor left behind by a project this
   * machine hid (#164): reusing an id would silently adopt the hidden entry's
   * state, and once ids travel between machines a collision means two different
   * repositories fighting over one sync entry.
   */
  function uniqueProjectId(base: string): string {
    const settings = useSettingsStore()
    const taken = (id: string) => projects.value.some((p) => p.id === id) || settings.isProjectHidden(id)
    if (!taken(base)) return base
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`
      if (!taken(candidate)) return candidate
    }
  }

  async function addProject(config: ProjectConfig) {
    const created = await projectCreate(config)
    projects.value.unshift(created)
  }

  async function saveProject(config: ProjectConfig) {
    await projectUpdate(config)
    const idx = projects.value.findIndex((p) => p.id === config.id)
    if (idx !== -1) {
      projects.value[idx] = config
    }
    if (currentProject.value?.id === config.id) {
      currentProject.value = config
    }
  }

  // Apply a project_updated broadcast from another window: refresh in-memory
  // copies so this window's full-object writes don't revert the edit. The
  // window-local live session is kept (this window owns it while open).
  function applyExternalUpdate(config: ProjectConfig) {
    const idx = projects.value.findIndex((p) => p.id === config.id)
    if (idx !== -1) projects.value[idx] = config
    if (currentProject.value?.id === config.id) {
      currentProject.value = { ...config, lastSession: currentProject.value.lastSession }
    }
  }

  async function removeProject(id: string) {
    const name = projects.value.find((p) => p.id === id)?.name ?? id
    await projectDelete(id)
    // Remember the deletion locally (#164): the sync file only ever gains
    // entries, so without this the next pull would recreate the project. After
    // the delete succeeds — a project hidden but still on disk is unreachable.
    useSettingsStore().hideProject(id, name)
    projects.value = projects.value.filter((p) => p.id !== id)
    if (currentProject.value?.id === id) {
      currentProject.value = null
    }
  }

  function toggleSwitcher() {
    showSwitcher.value = !showSwitcher.value
  }

  function toggleQuickOpen() {
    showQuickOpen.value = !showQuickOpen.value
  }

  return {
    projects,
    groups,
    currentProject,
    showSwitcher,
    showQuickOpen,
    activeWorktreeRoot,
    activeRoot,
    missingRoots,
    visibleProjects,
    unsyncableProjects,
    pullProjectsFromSync,
    pushProjectsToSync,
    checkRoots,
    cloneProject,
    ensureRootPresent,
    loadProjects,
    loadGroups,
    addGroup,
    renameGroup,
    removeGroup,
    setProjectGroup,
    reorderGroups,
    reorderProjects,
    restoreLastProject,
    switchProject,
    saveSessionDebounced,
    saveSessionNow,
    addProject,
    uniqueProjectId,
    saveProject,
    applyExternalUpdate,
    removeProject,
    toggleSwitcher,
    toggleQuickOpen,
  }
})
