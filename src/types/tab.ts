export type ShellType =
  | { kind: 'wsl'; distro: string }
  | { kind: 'cmd' }
  | { kind: 'powershell' }
  | { kind: 'git-bash' }

export type WindowsShellKind = 'cmd' | 'powershell' | 'git-bash'

export const WINDOWS_SHELLS: { kind: WindowsShellKind; label: string }[] = [
  { kind: 'cmd', label: 'Command Prompt' },
  { kind: 'powershell', label: 'PowerShell' },
  { kind: 'git-bash', label: 'Git Bash' },
]

export function isWindowsShell(shell: ShellType): boolean {
  return shell.kind !== 'wsl'
}

export function shellToType(kind: WindowsShellKind): ShellType {
  switch (kind) {
    case 'cmd': return { kind: 'cmd' }
    case 'powershell': return { kind: 'powershell' }
    case 'git-bash': return { kind: 'git-bash' }
  }
}

export function shellLabel(shell: ShellType): string {
  switch (shell.kind) {
    case 'wsl': return `WSL (${shell.distro})`
    case 'cmd': return 'CMD'
    case 'powershell': return 'PowerShell'
    case 'git-bash': return 'Git Bash'
  }
}

export function shellToPlatform(shell: ShellType): 'wsl' | 'windows' {
  return shell.kind === 'wsl' ? 'wsl' : 'windows'
}

export function shellToWinKind(shell: ShellType): WindowsShellKind {
  return shell.kind === 'wsl' ? 'powershell' : shell.kind
}

export function shellToDistro(shell: ShellType, fallback = 'Ubuntu'): string {
  return shell.kind === 'wsl' ? shell.distro : fallback
}

export function buildShell(
  platform: 'wsl' | 'windows',
  distro: string,
  winShell: WindowsShellKind
): ShellType {
  if (platform === 'wsl') return { kind: 'wsl', distro }
  return shellToType(winShell)
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)
}

export function rootPlaceholder(platform: 'wsl' | 'windows'): string {
  return platform === 'wsl'
    ? 'WSL path (e.g. /home/user/project)'
    : 'Path (e.g. C:\\Users\\user\\project)'
}

export type TerminalTab = {
  id: string
  kind: 'terminal'
  title: string
  pinned: boolean
  ptyId: string | null
  autoStart?: string
  cwd?: string
  shell?: ShellType
}

export type EditorTab = {
  id: string
  kind: 'editor'
  title: string
  pinned: boolean
  path: string
  readOnly?: boolean
  initialContent?: string
  initialLine?: number
  reloadRequested?: number
}

export type PreviewTab = {
  id: string
  kind: 'preview'
  title: string
  pinned: boolean
  path: string
  dataUrl: string
}

export type DockerLogsTab = {
  id: string
  kind: 'docker-logs'
  title: string
  pinned: boolean
  containerId: string
  containerName: string
}

export type DiffTab = {
  id: string
  kind: 'diff'
  title: string
  pinned: boolean
  filePath: string
  diff: string
  commitHash?: string
  staged?: boolean
}

export type HistoryTab = {
  id: string
  kind: 'history'
  title: string
  pinned: boolean
  filePath: string
}

export type SettingsTab = {
  id: string
  kind: 'settings'
  title: string
  pinned: boolean
}

export type Tab = TerminalTab | EditorTab | DockerLogsTab | DiffTab | PreviewTab | HistoryTab | SettingsTab

export type SidebarPanel = 'files' | 'git' | 'search' | 'docker' | 'projects'
