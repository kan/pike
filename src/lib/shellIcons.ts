import { GitBranch, SquareChevronRight, SquareTerminal, Terminal } from 'lucide-vue-next'
import type { Component } from 'vue'
import type { ShellType } from '../types/tab'

/** Shell kind → lucide icon, shared by the terminal-add dropdown and Settings. */
export const SHELL_KIND_ICONS: Record<ShellType['kind'], Component> = {
  cmd: SquareTerminal,
  powershell: SquareChevronRight,
  pwsh: SquareChevronRight,
  'git-bash': GitBranch,
  wsl: Terminal,
}
