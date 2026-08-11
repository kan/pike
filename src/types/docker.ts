export interface ComposeService {
  name: string
}

/** One compose file and its services. A monorepo yields several (#221). */
export interface ComposeProject {
  /** Absolute directory holding the file — where `docker compose` runs, and
   *  what a container's `composeWorkingDir` is matched against. The backend
   *  builds it so the frontend never has to join paths per platform. */
  dir: string
  /** The file relative to the project root (`compose.yml`, `apps/web/compose.yml`). */
  file: string
  /** Project name compose derives from `dir`; the fallback match for containers
   *  from Compose versions that predate the working-dir label. */
  name: string
  services: ComposeService[]
}

export interface TunnelInfo {
  tunnelId: string
  targetId: string
  targetPort: number
  localPort: number
}

export interface ContainerListResult {
  containers: ContainerInfo[]
  tunnels: TunnelInfo[]
}

export interface ContainerInfo {
  id: string
  name: string
  image: string
  state: string
  status: string
  composeService: string | null
  composeProject: string | null
  /** Directory compose ran in — how a container is tied to a discovered file. */
  composeWorkingDir: string | null
}
