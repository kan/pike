export type TerminalTab = {
  id: string
  kind: 'terminal'
  title: string
  pinned: boolean
  ptyId: string | null
}

export type EditorTab = {
  id: string
  kind: 'editor'
  title: string
  pinned: boolean
  path: string
}

export type DockerLogsTab = {
  id: string
  kind: 'docker-logs'
  title: string
  pinned: boolean
  containerId: string
  containerName: string
}

export type Tab = TerminalTab | EditorTab | DockerLogsTab

export type SidebarPanel = 'files' | 'git' | 'search' | 'docker' | 'projects'
