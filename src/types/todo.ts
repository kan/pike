/** A single line of the backing `todo.md`. */
export type TodoLine =
  | {
      kind: 'task'
      id: string
      /** Bullet prefix to preserve on write, e.g. `- ` or `  - `. */
      prefix: string
      text: string
      done: boolean
      /**
       * Free-form body written as indented continuation lines under the task,
       * dedented to the block's own base indent. Empty when the task is a
       * one-liner.
       */
      detail: string
    }
  /** Headings, blank lines, free text — preserved verbatim, not shown as tasks. */
  | { kind: 'raw'; text: string }

export type TodoTask = Extract<TodoLine, { kind: 'task' }>
