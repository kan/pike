import { listen } from '@tauri-apps/api/event'
import { basename } from '../lib/paths'
import { type CliAction, cliGetInitialAction, cliSetPendingAction, openProjectWindow } from '../lib/tauri'
import { useProjectStore } from '../stores/project'
import { useTabStore } from '../stores/tabs'
import type { ProjectConfig } from '../types/project'

let initialized = false

function normalizePath(p: string): string {
  return p.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '')
}

function isUnderRoot(filePath: string, root: string): boolean {
  const f = normalizePath(filePath)
  const r = normalizePath(root)
  return f.startsWith(`${r}/`) || f === r
}

/** Find the project whose root best matches the file path (longest root wins). */
function findBestProject(filePath: string, projects: ProjectConfig[]): ProjectConfig | undefined {
  let best: ProjectConfig | undefined
  let bestLen = 0
  for (const p of projects) {
    if (isUnderRoot(filePath, p.root) && p.root.length > bestLen) {
      best = p
      bestLen = p.root.length
    }
  }
  return best
}

/**
 * Parse a Windows UNC WSL path into distro + WSL path.
 * e.g. "\\\\wsl.localhost\\Ubuntu\\home\\user" → { distro: "Ubuntu", wslPath: "/home/user" }
 *      "\\\\wsl$\\Ubuntu\\home\\user"          → { distro: "Ubuntu", wslPath: "/home/user" }
 */
function parseWslUncPath(p: string): { distro: string; wslPath: string } | null {
  const norm = p.replace(/\\/g, '/')
  const m = norm.match(/^\/\/(wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/)
  if (!m) return null
  return { distro: m[2], wslPath: m[3] || '/' }
}

/** Find WSL project matching a UNC WSL path. */
function findWslProject(uncPath: string, projects: ProjectConfig[]): ProjectConfig | undefined {
  const parsed = parseWslUncPath(uncPath)
  if (!parsed) return undefined
  const wslNorm = normalizePath(parsed.wslPath)
  return projects.find(
    (p) => p.shell.kind === 'wsl' && p.shell.distro === parsed.distro && normalizePath(p.root) === wslNorm,
  )
}

/** Derive a parent directory suitable as a project root from a file path. */
function deriveProjectRoot(filePath: string): string {
  const sep = filePath.includes('\\') ? '\\' : '/'
  const parts = filePath.split(sep)
  parts.pop() // remove filename
  return parts.join(sep)
}

async function handleAction(action: CliAction) {
  if (action.action === 'none') return

  const projectStore = useProjectStore()
  const tabStore = useTabStore()

  if (action.action === 'openFile') {
    let targetProject =
      findBestProject(action.path, projectStore.projects) ?? findWslProject(action.path, projectStore.projects)

    if (!targetProject) {
      const parsed = parseWslUncPath(action.path)
      const root = parsed ? parsed.wslPath : deriveProjectRoot(action.path)
      const name = basename(root) || 'Untitled'
      const id = crypto.randomUUID()
      await projectStore.addProject({
        id,
        name,
        root,
        shell: parsed ? { kind: 'wsl', distro: parsed.distro } : { kind: 'powershell' },
        pinnedTabs: [],
        lastOpened: new Date().toISOString(),
      })
      targetProject = projectStore.projects.find((p) => p.id === id)
      if (!targetProject) return
    }

    if (projectStore.currentProject?.id === targetProject.id) {
      tabStore.addEditorTab({ path: action.path, initialLine: action.line ?? undefined, reload: true })
    } else {
      // Register the action so the new window picks it up via cli_get_initial_action
      const windowLabel = `project-${targetProject.id}`
      await cliSetPendingAction(windowLabel, action)
      await openProjectWindow(targetProject.id)
    }
  } else if (action.action === 'openDirectory') {
    const normalized = normalizePath(action.path)
    let match =
      projectStore.projects.find((p) => normalizePath(p.root) === normalized) ??
      findWslProject(action.path, projectStore.projects)

    if (!match) {
      // Create ad-hoc project for unregistered directory
      const parsed = parseWslUncPath(action.path)
      const name = basename(action.path) || 'Untitled'
      const id = crypto.randomUUID()
      await projectStore.addProject({
        id,
        name,
        root: parsed ? parsed.wslPath : action.path,
        shell: parsed ? { kind: 'wsl', distro: parsed.distro } : { kind: 'powershell' },
        pinnedTabs: [],
        lastOpened: new Date().toISOString(),
      })
      match = projectStore.projects.find((p) => p.id === id)
    }

    if (match && projectStore.currentProject?.id !== match.id) {
      await projectStore.switchProject(match.id)
    }
  }
}

export async function initCliOpen() {
  if (initialized) return
  initialized = true

  await listen<CliAction>('cli_open', (event) => {
    handleAction(event.payload)
  })

  const initial = await cliGetInitialAction()
  if (initial.action !== 'none') {
    handleAction(initial)
  }
}
