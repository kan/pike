import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { confirmDialog, infoDialog } from '../composables/useConfirmDialog'
import { locale, t } from '../i18n'
import { normalizeRemoteUrl } from '../lib/gitRemote'
import { baseForPlatform, joinBase, type ProjectBase, relativeToBase, rootKey } from '../lib/projectPaths'
import {
  focusProjectWindow,
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
  projectTransientBind,
  projectTransientCreate,
  projectTransientDrop,
  projectTransientGet,
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

/** Where `placeProject` puts a project. */
type OpenMode = 'switch' | 'window' | 'focusOrSwitch'

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

  // The directory this window opened without registering it (#230). Deliberately
  // kept out of `projects`, which is the registered list and drives the panel,
  // the switcher, the jump list and the sync push — leaving it out is what makes
  // all of those skip it, rather than each of them testing a flag.
  const transientProject = ref<ProjectConfig | null>(null)
  const isTransient = computed(() => !!transientProject.value && currentProject.value?.id === transientProject.value.id)

  /** A project by id, registered or transient. */
  function findProject(id: string): ProjectConfig | null {
    return (
      projects.value.find((p) => p.id === id) ?? (transientProject.value?.id === id ? transientProject.value : null)
    )
  }

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
  let rootCheck: Promise<void> | null = null

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
   *  `ROOT_CHECK_TTL_MS` reuse the last result unless forced.
   *
   *  A caller that arrives while a probe runs waits for that one instead of
   *  reading a set that is about to be replaced: the list watcher below starts a
   *  probe the moment projects load, which is exactly when a window checks the
   *  root it was handed (#212). A forced call always re-probes — `cloneProject`
   *  needs an answer that postdates the clone. */
  function checkRoots(force = false): Promise<void> {
    if (!force && (rootCheck || Date.now() - lastRootCheck < ROOT_CHECK_TTL_MS)) {
      return rootCheck ?? Promise.resolve()
    }
    lastRootCheck = Date.now()
    const run = probeRoots().finally(() => {
      if (rootCheck === run) rootCheck = null
    })
    rootCheck = run
    return run
  }

  async function probeRoots() {
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
    // Not awaited: it only reads origins of roots that are present, so it can
    // change neither this set nor the URL of a project waiting to be cloned.
    // Whoever is blocked on the answer above should not also wait on git.
    backfillRemotes().catch(() => {})
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
  function cloneProject(id: string, onCloned?: () => void | Promise<void>) {
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
          await onCloned()
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
   * Put a project in a window, with no questions asked:
   *
   * - `switch`: take over this window.
   * - `window`: give it its own window (the backend focuses one already on it).
   * - `focusOrSwitch`: jump to its window if one exists, else `switch`.
   *
   * `openProject` runs this after its check. Calling it directly skips that, so
   * the only caller allowed to is project creation: the root the user just typed
   * may not exist yet and a new project has no origin, which would leave the
   * check refusing to open what was asked for.
   */
  async function placeProject(id: string, mode: OpenMode): Promise<void> {
    if (mode === 'window') {
      await openProjectWindow(id)
      return
    }
    if (mode === 'focusOrSwitch' && (await focusProjectWindow(id))) return
    await switchProject(id)
  }

  /** Open a project the user picked from a list. The one entry point for that,
   *  so a root that is not on this machine is offered for cloning (#212)
   *  wherever a project can be chosen. */
  async function openProject(id: string, mode: OpenMode): Promise<void> {
    // A window already showing it proves the root is there, and jumping to it is
    // the whole point of that mode — settle it before checking anything. What is
    // left afterwards is this window, unless a dedicated one was asked for.
    if (mode === 'focusOrSwitch' && (await focusProjectWindow(id))) return
    const open = () => placeProject(id, mode === 'window' ? 'window' : 'switch')
    if (await ensureRootPresent(id, open)) await open()
  }

  /** Open a project this window was handed rather than picked: the startup
   *  restore, and the windows the backend opens for the jump list, the tray or a
   *  CLI launch. The offer to clone can only come after the window is showing
   *  the project, so a successful clone reopens it (#212). Kept as one call so
   *  no caller can do the first half and forget the second. */
  async function adoptProject(id: string, opts?: { restoreSession?: boolean }): Promise<void> {
    // An id the registered list doesn't have is either a transient project (#230)
    // the backend made for this window, or a project that vanished. Resolve the
    // former before switching; the root of a directory just opened is there by
    // definition, so the clone offer below doesn't apply to it.
    if (!projects.value.some((p) => p.id === id)) {
      const transient = await projectTransientGet(id).catch(() => null)
      if (transient) {
        transientProject.value = transient
        await switchProject(id, opts)
        // Not awaited, for the same reason the clone offer below isn't: the
        // caller's startup sequence must not park on a dialog waiting for a
        // human. Kept in here rather than in the caller so a future adopt path
        // cannot open a directory and silently never ask about it.
        offerToRegisterDirectory().catch(() => {})
        return
      }
    }
    await switchProject(id, opts)
    ensureRootPresent(id, () => switchProject(id, opts)).catch(() => {})
  }

  /**
   * Ask once whether the directory this window opened should become a project.
   * Declining records the root, so the same directory never asks again — and the
   * switcher's "open a directory" entry records it as it opens, which is why
   * that path never reaches a dialog.
   */
  async function offerToRegisterDirectory(): Promise<void> {
    const project = transientProject.value
    if (!project || !isTransient.value) return
    const settings = useSettingsStore()
    if (settings.skipsRegisterPrompt(project.root)) return
    if (await confirmDialog(t('project.registerDirectoryConfirm', { root: project.root }))) {
      await registerTransientProject()
    } else {
      settings.rememberTransientRoot(project.root)
    }
  }

  /**
   * Open a directory without registering it (#230): the window behaves like a
   * project window, but nothing is written to disk and the config dies with it.
   *
   * Choosing this is itself the answer to "register this directory?", so the
   * root is remembered as one not to ask about again.
   */
  async function openDirectory(path: string, mode: 'switch' | 'window' = 'switch'): Promise<void> {
    const config = await projectTransientCreate(path)
    useSettingsStore().rememberTransientRoot(config.root)
    if (mode === 'window') {
      await openProjectWindow(config.id)
      return
    }
    transientProject.value = config
    await projectTransientBind(config.id)
    await switchProject(config.id)
  }

  /**
   * Turn the directory this window opened into a registered project.
   *
   * The backend kept the id unique against the registered and transient ones,
   * but it cannot see the hidden list (#164) — that lives in localStorage — so
   * the id is re-checked here before it is written. `projectAddOpen` then points
   * `window_projects` at whatever id won, which is also what keeps focus and CLI
   * routing on this window when the slug had to change.
   */
  async function registerTransientProject(): Promise<void> {
    const config = transientProject.value
    if (!config || !isTransient.value) return
    const stored = { ...config, id: uniqueProjectId(config.id), lastOpened: new Date().toISOString() }
    await addProject(stored)
    await projectTransientDrop(config.id).catch(() => {})
    transientProject.value = null
    currentProject.value = projects.value.find((p) => p.id === stored.id) ?? stored
    useSettingsStore().forgetTransientRoot(stored.root)
    await projectAddOpen(stored.id).catch(() => {})
    await flushSession()
  }

  /**
   * Make sure a project's root is on this machine before it is opened (#212).
   * Projects the sync file brought in (#164) are not cloned here until someone
   * asks for them, so any list of projects can offer one that has no local copy.
   *
   * Returns whether the root is there now. `false` means the caller must not
   * open the project: either there is no origin URL to clone from, or a clone
   * just started and `onCloned` runs once it lands.
   */
  async function ensureRootPresent(id: string, onCloned: () => void | Promise<void>): Promise<boolean> {
    // Read the batched answer rather than probing this one root: every surface
    // that offers a project keeps it fresh (the panel and the switcher refresh
    // on open, the list watcher re-probes on any change), the batch costs one
    // `wsl.exe` launch per distro instead of one per project, and the badge in
    // those lists then cannot disagree with what happens on click.
    await checkRoots().catch(() => {})
    if (!missingRoots.value.has(id)) return true
    const project = projects.value.find((p) => p.id === id)
    if (!project) return false
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
  // because the whole section is not replaced wholesale: a machine publishes the
  // projects it has and leaves every other entry alone, so nobody's list is ever
  // dropped by a machine that has never seen it. What stays local: the real path
  // (only the base-relative part travels), shell, pinned tabs, session, recency,
  // and agent session ids.

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
      golangciCommand: project.golangciCommand,
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
   * Publish this machine's shareable projects: an entry for a project that is
   * here is replaced by what is here, and every other entry is left alone.
   *
   * Filling only the file's empty fields (what this used to do) made the first
   * value the file ever saw permanent, so a field *cleared* here kept its stale
   * value there and the next pull filled it back in. The cost of publishing
   * as-is is that with two machines the last one to run owns the record.
   *
   * Note what this does *not* buy: the pull still only fills gaps, so a machine
   * that already has the project keeps its own name, color and group whatever
   * the file says. Edits reach the file, and from there only machines that have
   * yet to create the project. Making them converge needs a per-record
   * `updatedAt` on both sides, which nothing has asked for yet.
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
        merged.set(entry.id, entry)
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
   * their gaps filled (a local edit always wins) and missing ones are created
   * under this machine's base — unless this machine deleted them, which is
   * matched by id, root and origin so a local delete is not undone by the next
   * pull. Returns what happened so callers can say why nothing appeared — every
   * skip here is silent otherwise.
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
    // What counts as "a project this machine already decided about", by every
    // key that survives the trip through the file. Ids do not: one repository
    // ends up with an id per machine that registered it separately, so an entry
    // is matched by where it lands and what it clones from as well.
    //
    // Kept together because the two readers below must agree — the dedup, so a
    // second copy is not created and then pushed back, and the deletion check,
    // so a sibling entry cannot recreate what was deleted here. Origins compare
    // normalized: the same repository reaches the file as
    // `git@host:owner/repo.git` from one machine and `https://host/owner/repo`
    // from another, and a raw comparison reads those as two projects.
    const compactSet = (values: (string | null | undefined)[]) => new Set(values.filter((v): v is string => !!v))
    const localRemotes = compactSet(projects.value.map((p) => normalizeRemoteUrl(p.remoteUrl)))
    const localRoots = compactSet(projects.value.map((p) => rootKey(p.root)))
    const hiddenRoots = compactSet(settings.hiddenProjects.map((p) => p.root && rootKey(p.root)))
    const hiddenRemotes = compactSet(settings.hiddenProjects.map((p) => normalizeRemoteUrl(p.remoteUrl)))
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
        if (!local.golangciCommand && entry.golangciCommand) patch.golangciCommand = entry.golangciCommand
        // Order is adopted rather than gap-filled (#203): a manual order is one
        // intent over a whole list, and half of one machine's interleaved with
        // half of another's is nobody's order.
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
      const key = rootKey(root)
      if (localRoots.has(key)) continue
      const remote = normalizeRemoteUrl(entry.remoteUrl)
      if (remote && localRemotes.has(remote)) continue
      // The id check at the top of the loop only catches the entry the deletion
      // was recorded against. A sibling entry for the same repository carries a
      // different id, and recognising it needs the resolved root — which is why
      // this half of the check waits until here.
      if (hiddenRoots.has(key) || (remote && hiddenRemotes.has(remote))) {
        result.hidden++
        continue
      }
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
        golangciCommand: entry.golangciCommand,
        order: entry.order,
      }).catch(() => {})
      localRoots.add(key)
      if (remote) localRemotes.add(remote)
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
            p.golangciCommand,
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
        await adoptProject(mainId)
      }
      // Remaining projects open in separate windows, each adopting its own (#212)
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
    const project = findProject(id)
    if (!project) return
    // Moving this window off a transient project (#230) is the end of that
    // project: drop it here rather than at window close, or `pike <that dir>`
    // would keep focusing a window that no longer shows it.
    if (transientProject.value && transientProject.value.id !== id) {
      projectTransientDrop(transientProject.value.id).catch(() => {})
      transientProject.value = null
    }
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

    // A transient project (#230) has no file to update and must stay out of the
    // open list, or the throwaway directory would reopen on the next plain launch.
    // Fire-and-forget: don't block tab restoration on metadata persistence
    if (!isTransient.value) {
      Promise.all([projectUpdate(project).catch(() => {}), projectAddOpen(id).catch(() => {})])
    }

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
    // Transient project (#230): there is no project.json to write to.
    if (isTransient.value) return
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
    // A transient project (#230) has no project.json, so the write would reject.
    // Guarded here rather than in each caller: this is the one place a config
    // reaches disk, and `stores/git.ts` already calls it to record `origin`.
    // The in-memory copies are still updated, so the value holds for this window.
    if (transientProject.value?.id === config.id) {
      transientProject.value = config
      if (currentProject.value?.id === config.id) currentProject.value = config
      return
    }
    await projectUpdate(config)
    const idx = projects.value.findIndex((p) => p.id === config.id)
    if (idx !== -1) {
      projects.value[idx] = config
    }
    if (currentProject.value?.id === config.id) {
      currentProject.value = config
    }
  }

  /** Apply a `project_groups_updated` broadcast from another window (see
   *  `project_groups_save` for why the list has to travel). */
  function applyExternalGroups(list: string[]) {
    groups.value = list
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
    const project = projects.value.find((p) => p.id === id)
    await projectDelete(id)
    // Remember the deletion locally (#164): the sync file only ever gains
    // entries, so without this the next pull would recreate the project. The
    // root and origin go in the record too — see the match in the pull. After
    // the delete succeeds — a project hidden but still on disk is unreachable.
    useSettingsStore().hideProject({
      id,
      name: project?.name ?? id,
      root: project?.root,
      remoteUrl: project?.remoteUrl,
    })
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
    isTransient,
    openDirectory,
    registerTransientProject,
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
    placeProject,
    openProject,
    adoptProject,
    loadProjects,
    loadGroups,
    addGroup,
    renameGroup,
    removeGroup,
    setProjectGroup,
    reorderGroups,
    reorderProjects,
    restoreLastProject,
    saveSessionDebounced,
    saveSessionNow,
    addProject,
    uniqueProjectId,
    saveProject,
    applyExternalUpdate,
    applyExternalGroups,
    removeProject,
    toggleSwitcher,
    toggleQuickOpen,
  }
})
