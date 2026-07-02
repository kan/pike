export type TaskRunner = 'npm' | 'make' | 'deno' | 'cargo'

export interface TaskDefinition {
  name: string
  command: string
  runner: TaskRunner
  cwd?: string
}

export interface TaskGroup {
  runner: TaskRunner
  label: string
  sourceFile: string
  cwd: string
  tasks: TaskDefinition[]
}

export const RUNNER_COMMANDS: Record<TaskRunner, (name: string) => string> = {
  npm: (name) => `npm run ${name}`,
  make: (name) => `make ${name}`,
  deno: (name) => `deno task ${name}`,
  cargo: (name) => `cargo ${name}`,
}
