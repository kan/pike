/** A single line of the backing `todo.md`. */
export type TodoLine =
  | {
      kind: 'task'
      id: string
      /** Bullet prefix to preserve on write, e.g. `- ` or `  - `. */
      prefix: string
      text: string
      done: boolean
    }
  /** Headings, blank lines, free text — preserved verbatim, not shown as tasks. */
  | { kind: 'raw'; text: string }

export type TodoTask = Extract<TodoLine, { kind: 'task' }>
