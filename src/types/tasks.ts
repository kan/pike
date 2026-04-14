export type TaskRunner = 'npm' | 'make' | 'deno'

export interface TaskDefinition {
  name: string
  command: string
  runner: TaskRunner
}

export interface TaskGroup {
  runner: TaskRunner
  label: string
  sourceFile: string
  tasks: TaskDefinition[]
}

export const RUNNER_COMMANDS: Record<TaskRunner, (name: string) => string> = {
  npm: (name) => `npm run ${name}`,
  make: (name) => `make ${name}`,
  deno: (name) => `deno task ${name}`,
}
