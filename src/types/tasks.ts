export type TaskRunner = 'npm' | 'make' | 'deno' | 'cargo' | 'just'

export interface TaskDefinition {
  name: string
  /** ツールチップ用。実行するシェル行は RUNNER_COMMANDS が name から組み立てる */
  command: string
  /** 人が書いた説明（justfile の doc comment。他の runner は持たない） */
  description?: string
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
  just: (name) => `just ${name}`,
}
