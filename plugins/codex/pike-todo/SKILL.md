---
name: pike-todo
description: Read and update a Pike project's shared TODO checklist from the terminal with the `pike todo` CLI. Use when working inside a Pike project (a Windows dev environment) and the user asks to add, check off, list, or clear TODO items, or when you want to track multi-step work in a list the user can watch in Pike's TODO panel. Backed by the plain-Markdown `.pike/todo.md`.
metadata:
  short-description: Manage a Pike project's TODO list via the pike todo CLI
---

# Pike TODO CLI

Pike shows a TODO panel backed by a plain Markdown checklist at
`<project-root>/.pike/todo.md`. The `pike todo` CLI reads and writes that same
file, so anything you change from the terminal appears in Pike's TODO panel
immediately (the running window reloads the file on change), and vice versa.

Use this to share a task list with the user: they add or check items in the
panel, you do the same from the terminal, and both stay in sync.

## When to use

- The user asks to add / complete / list / remove TODO items.
- You are doing multi-step work and want a checklist the user can see and edit
  in Pike while you work.
- The user says things like "put this on the TODO", "mark that done",
  "what's left on the list".

Prefer this over an ad-hoc scratch file: it is the list the user already sees.

## Commands

Run these in the project directory (any subdirectory works — the CLI walks up to
the project's `.pike/`, falling back to the git root).

```
pike todo                      # list tasks, numbered 1-based (alias: pike todo list)
pike todo list --json          # same, as JSON: [{"n":1,"done":false,"text":"..."}]
pike todo add <text...>        # append a task
pike todo done <n...>          # mark task number(s) done
pike todo undone <n...>        # mark task number(s) not done
pike todo rm <n...>            # remove task number(s)
pike todo clear                # remove all tasks (headings and notes are kept)
```

Numbers are the positions shown by `pike todo list`. `done`, `undone`, and `rm`
accept several numbers at once, e.g. `pike todo done 1 3 4`.

## Notes

- `.pike/` is git-ignored (the CLI writes a `.gitignore` with `*` on first use),
  so the list stays local to the machine.
- The file is ordinary Markdown: lines like `- [ ] task` and `- [x] done`.
  Headings (`# ...`) and free-text lines are preserved and are not shown as
  tasks, so you can organize with headings the panel ignores.
- Re-run `pike todo list` after a batch of edits to confirm the current numbers
  before using `done` / `rm`, since numbers shift when tasks are removed.

## Example

```
$ pike todo add investigate flaky test
added #1: investigate flaky test
$ pike todo add fix root cause
added #2: fix root cause
$ pike todo done 1
done #1: investigate flaky test
$ pike todo list
1. [x] investigate flaky test
2. [ ] fix root cause
```
