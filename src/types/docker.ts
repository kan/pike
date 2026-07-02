export interface ComposeService {
  name: string
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
}
