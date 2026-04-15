<script setup lang="ts">
import DOMPurify from 'dompurify'
import {
  AlertTriangle,
  Bot,
  BrainCircuit,
  FileCode,
  FileEdit,
  Loader,
  LogIn,
  LogOut,
  MessageSquarePlus,
  Search,
  Send,
  Shield,
  ShieldCheck,
  Square,
  Terminal as TerminalIcon,
} from 'lucide-vue-next'
import { Marked } from 'marked'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { getClipboardImages, saveImageFile } from '../../composables/useImagePaste'
import { useI18n } from '../../i18n'
import { formatTokens } from '../../lib/format'
import { basename, fuzzyMatch, isAbsolutePath, isImageFile, toRelativePath } from '../../lib/paths'
import { fsListDir, fsReadFile, gitDiffWorking, listProjectFiles } from '../../lib/tauri'
import { useCodexStore } from '../../stores/codex'
import { useProjectStore } from '../../stores/project'
import { useTabStore } from '../../stores/tabs'
import type { TurnItem } from '../../types/codex'
import { isWindowsShell } from '../../types/tab'
import ApprovalDialog from '../codex/ApprovalDialog.vue'

const { t } = useI18n()
const codex = useCodexStore()
const projectStore = useProjectStore()
const tabStore = useTabStore()

const input = ref('')
const messageListRef = ref<HTMLDivElement | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)
const userScrolledUp = ref(false)
const searchQuery = ref('')
const showSearch = ref(false)

const marked = new Marked()

const isAuthenticated = computed(() => codex.authState.status === 'authenticated')
const isConnected = computed(() => codex.connected)

const effectiveSandbox = computed(() => {
  if (codex.sandboxMode) return codex.sandboxMode
  const project = projectStore.currentProject
  return project && isWindowsShell(project.shell) ? 'externalSandbox' : 'workspaceWrite'
})

const effectiveApproval = computed(() => {
  if (codex.approvalPolicy) return codex.approvalPolicy
  const project = projectStore.currentProject
  const isWindows = project && isWindowsShell(project.shell)
  return isWindows ? 'untrusted' : 'on-request'
})

function prefillCommand(cmd: string) {
  input.value = cmd
  // Directly open the arg completion menu
  showSlashMenu.value = false
  mentionAnchorPos.value = cmd.length
  mentionFilter.value = ''
  mentionSelectedIdx.value = 0
  mentionMode.value = 'slash-options'
  slashArgOptions.value = /^\/sandbox/i.test(cmd) ? SANDBOX_OPTIONS : APPROVAL_OPTIONS
  showMentionMenu.value = true
  nextTick(() => inputRef.value?.focus())
}

function openInstructionsFile() {
  const name = codex.detectedInstructionsFile
  const project = projectStore.currentProject
  if (!name || !project) return
  const sep = project.shell.kind === 'wsl' ? '/' : '\\'
  tabStore.addEditorTab({ path: `${project.root}${sep}${name}` })
}

function insertAtCursor(text: string) {
  const el = inputRef.value
  if (!el) {
    input.value += text
    return
  }
  const start = el.selectionStart ?? input.value.length
  const before = input.value.slice(0, start)
  const after = input.value.slice(el.selectionEnd ?? start)
  input.value = `${before}${text}${after}`
  nextTick(() => {
    const pos = start + text.length
    el.setSelectionRange(pos, pos)
    el.focus()
  })
}

async function handleImageFiles(files: File[]) {
  for (const file of files) {
    try {
      const relPath = await saveImageFile(file)
      insertAtCursor(`@${relPath} `)
    } catch (e) {
      codex.addSystemMessage(`${t('codex.imagePasteFailed')}: ${e}`)
    }
  }
}

function onPaste(e: ClipboardEvent) {
  const images = getClipboardImages(e)
  if (images.length === 0) return
  e.preventDefault()
  handleImageFiles(images)
}

function onDragOver(e: DragEvent) {
  if (e.dataTransfer?.types.includes('Files') || e.dataTransfer?.types.includes('text/plain')) {
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }
}

async function onDrop(e: DragEvent) {
  const project = projectStore.currentProject
  if (!project) return

  const textData = e.dataTransfer?.getData('text/plain')
  if (textData && isAbsolutePath(textData)) {
    const relPath = toRelativePath(textData, project.root)
    insertAtCursor(`@${relPath} `)
    return
  }

  // OS file drop
  if (e.dataTransfer?.files.length) {
    const imageFiles = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length > 0) {
      await handleImageFiles(imageFiles)
      return
    }
    // Non-image files: just insert path-like mention with filename
    for (const file of e.dataTransfer.files) {
      insertAtCursor(`@${file.name} `)
    }
  }
}

// Memoized markdown rendering — avoids re-parsing unchanged segments on every reactive update
const mdCache = new Map<string, string>()
function renderMarkdown(text: string): string {
  if (!text) return ''
  const cached = mdCache.get(text)
  if (cached) return cached
  const html = DOMPurify.sanitize(marked.parse(text) as string)
  // Only cache completed (non-streaming) text to avoid unbounded growth
  if (text.length > 0 && text.length < 50000) mdCache.set(text, html)
  return html
}

// Search
const searchMatchIds = computed(() => {
  if (!searchQuery.value) return new Set<string>()
  const q = searchQuery.value.toLowerCase()
  const ids = new Set<string>()
  for (const m of codex.messages) {
    if (m.text.toLowerCase().includes(q)) ids.add(m.id)
    for (const seg of m.segments) {
      if (seg.kind === 'text' && seg.text.toLowerCase().includes(q)) {
        ids.add(m.id)
        break
      }
    }
  }
  return ids
})
const searchMatchList = computed(() => codex.messages.filter((m) => searchMatchIds.value.has(m.id)))
const searchCurrentIdx = ref(0)

function toggleSearch() {
  showSearch.value = !showSearch.value
  if (!showSearch.value) {
    searchQuery.value = ''
    searchCurrentIdx.value = 0
  } else {
    nextTick(() => {
      const el = document.querySelector('.search-input') as HTMLInputElement | null
      el?.focus()
    })
  }
}

function searchNav(delta: number) {
  const count = searchMatchList.value.length
  if (count === 0) return
  searchCurrentIdx.value = (searchCurrentIdx.value + delta + count) % count
  scrollToSearchMatch()
}

function scrollToSearchMatch() {
  const msg = searchMatchList.value[searchCurrentIdx.value]
  if (!msg) return
  const el = messageListRef.value?.querySelector(`[data-msg-id="${msg.id}"]`) as HTMLElement | null
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

/** Extract reasoning text from a TurnItem, checking multiple possible field names. */
function reasoningSummary(item: TurnItem): string | null {
  for (const key of ['summary', 'text', 'content']) {
    const v = item.data[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

// Open diff tab for a FileChange item
function openFileChangeDiff(item: TurnItem) {
  const filePath = item.data.filePath as string | undefined
  const diff = item.data.diff as string | undefined
  if (!filePath) return
  tabStore.addDiffTab({ filePath, diff: diff ?? '' })
}

async function startNewConversation() {
  await codex.newConversation()
  await ensureConnected()
}

let connecting = false
async function reconnect() {
  codex.disconnectReason = null
  await ensureConnected()
}

async function ensureConnected() {
  if (codex.connected || connecting) return
  connecting = true
  try {
    const project = projectStore.currentProject
    if (!project) return
    await codex.startSession(project.shell, project.root, project.codexThreadId)
  } catch (e) {
    codex.disconnectReason = String(e)
  } finally {
    connecting = false
  }
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

const SANDBOX_OPTIONS = ['workspaceWrite', 'dangerFullAccess', 'externalSandbox', 'default']
const APPROVAL_OPTIONS = ['untrusted', 'on-failure', 'on-request', 'granular', 'never', 'default']

const OPTION_DESC_KEYS: Record<string, string> = {
  workspaceWrite: 'codex.opt.workspaceWrite',
  dangerFullAccess: 'codex.opt.dangerFullAccess',
  externalSandbox: 'codex.opt.externalSandbox',
  untrusted: 'codex.opt.untrusted',
  'on-failure': 'codex.opt.onFailure',
  'on-request': 'codex.opt.onRequest',
  granular: 'codex.opt.granular',
  never: 'codex.opt.never',
  default: 'codex.opt.default',
}

interface SlashCommand {
  name: string
  description: string
  hasArgs: boolean
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/clear', description: t('codex.cmdClear'), hasArgs: false },
  { name: '/compact', description: t('codex.cmdCompact'), hasArgs: false },
  { name: '/read', description: t('codex.cmdRead'), hasArgs: true },
  { name: '/diff', description: t('codex.cmdDiff'), hasArgs: false },
  { name: '/model', description: t('codex.cmdModel'), hasArgs: true },
  { name: '/rollback', description: t('codex.cmdRollback'), hasArgs: false },
  { name: '/sandbox', description: t('codex.cmdSandbox'), hasArgs: true },
  { name: '/approval', description: t('codex.cmdApproval'), hasArgs: true },
]

const showSlashMenu = ref(false)
const slashFilter = ref('')
const slashSelectedIdx = ref(0)

const filteredSlashCommands = computed(() => {
  if (!slashFilter.value) return SLASH_COMMANDS
  const q = slashFilter.value.toLowerCase()
  return SLASH_COMMANDS.filter((c) => c.name.slice(1).startsWith(q))
})

function updateSlashMenu() {
  const text = input.value
  // Show slash menu when input starts with '/' and cursor is on the first line
  if (text.startsWith('/') && !text.includes('\n')) {
    const afterSlash = text.slice(1).split(/\s/)[0]
    slashFilter.value = afterSlash
    showSlashMenu.value = true
    slashSelectedIdx.value = 0
  } else {
    showSlashMenu.value = false
  }
}

function selectSlashCommand(cmd: SlashCommand) {
  showSlashMenu.value = false
  if (cmd.hasArgs) {
    input.value = `${cmd.name} `
    // Trigger completion menu for commands with args (programmatic value change doesn't fire input event)
    nextTick(() => {
      onInput()
      inputRef.value?.focus()
    })
  } else {
    input.value = cmd.name
    submit()
  }
}

async function handleSlashCommand(text: string): Promise<boolean> {
  const parts = text.split(/\s+/)
  const cmd = parts[0].toLowerCase()

  switch (cmd) {
    case '/clear':
      await startNewConversation()
      return true

    case '/compact':
      try {
        codex.addSystemMessage(t('codex.compacting'))
        await codex.compactThread()
        codex.addSystemMessage(t('codex.compactDone'))
      } catch (e) {
        codex.addSystemMessage(`Error: ${e}`)
      }
      return true

    case '/rollback':
      try {
        await codex.rollbackTurn()
        codex.addSystemMessage(t('codex.rollbackDone'))
      } catch (e) {
        codex.addSystemMessage(`Error: ${e}`)
      }
      return true

    case '/read': {
      const path = parts.slice(1).join(' ').trim()
      if (!path) {
        codex.addSystemMessage(t('codex.readUsage'))
        return true
      }
      try {
        const project = projectStore.currentProject
        if (!project) return true
        const sep = project.shell.kind === 'wsl' ? '/' : '\\'
        const fullPath = path.startsWith('/') || path.includes(':') ? path : `${project.root}${sep}${path}`
        const result = await fsReadFile(project.shell, fullPath)
        const prompt = `[File: ${path}]\n\`\`\`\n${result.content}\n\`\`\`\n\nI've attached the content of \`${path}\` above. What would you like to know about it?`
        await codex.submitTurn(prompt)
      } catch (e) {
        codex.addSystemMessage(`Failed to read ${path}: ${e}`)
      }
      return true
    }

    case '/diff': {
      try {
        const project = projectStore.currentProject
        if (!project) return true
        const diff = await gitDiffWorking(project.root, project.shell)
        if (!diff.trim()) {
          codex.addSystemMessage(t('codex.diffEmpty'))
          return true
        }
        const prompt = `[Git working tree diff]\n\`\`\`diff\n${diff}\n\`\`\`\n\nI've attached the current git diff. Please review the changes.`
        await codex.submitTurn(prompt)
      } catch (e) {
        codex.addSystemMessage(`Failed to get diff: ${e}`)
      }
      return true
    }

    case '/model': {
      const modelArg = parts.slice(1).join(' ').trim()
      if (!modelArg) {
        // List available models
        try {
          const models = await codex.listModels()
          const current = codex.selectedModel ?? '(default)'
          const list = models
            .map((m) => {
              const name = m.displayName ?? m.id
              const def = m.isDefault ? ' **(default)**' : ''
              const desc = m.description ? ` — ${m.description}` : ''
              return `- \`${m.id}\` ${name}${def}${desc}`
            })
            .join('\n')
          codex.addSystemMessage(
            `${t('codex.modelCurrent')}: **${current}**\n\n${t('codex.modelAvailable')}:\n${list}\n\n${t('codex.modelUsage')}`,
          )
        } catch (e) {
          codex.addSystemMessage(`Failed to list models: ${e}`)
        }
      } else {
        codex.setModel(modelArg)
        codex.addSystemMessage(`${t('codex.modelSet')}: **${modelArg}**`)
      }
      return true
    }

    case '/sandbox': {
      const arg = parts.slice(1).join(' ').trim()
      const project = projectStore.currentProject
      const isWindows = project && isWindowsShell(project.shell)
      if (isWindows) {
        codex.addSystemMessage(t('codex.sandboxWindowsFixed'))
        return true
      }
      if (!arg) {
        const current = codex.sandboxMode ?? '(default)'
        codex.addSystemMessage(`${t('codex.sandboxCurrent')}: **${current}**\n\n${t('codex.sandboxUsage')}`)
      } else {
        if (SANDBOX_OPTIONS.includes(arg)) {
          codex.setSandboxMode(arg === 'default' ? null : arg)
          codex.addSystemMessage(`${t('codex.sandboxSet')}: **${arg}**`)
          await startNewConversation()
        } else {
          codex.addSystemMessage(`${t('codex.sandboxInvalid')}: ${SANDBOX_OPTIONS.join(', ')}`)
        }
      }
      return true
    }

    case '/approval': {
      const arg = parts.slice(1).join(' ').trim()
      if (!arg) {
        const current = codex.approvalPolicy ?? '(default)'
        codex.addSystemMessage(`${t('codex.approvalCurrent')}: **${current}**\n\n${t('codex.approvalUsage')}`)
      } else {
        if (APPROVAL_OPTIONS.includes(arg)) {
          codex.setApprovalPolicy(arg === 'default' ? null : arg)
          codex.addSystemMessage(`${t('codex.approvalSet')}: **${arg}**`)
          await startNewConversation()
        } else {
          codex.addSystemMessage(`${t('codex.approvalInvalid')}: ${APPROVAL_OPTIONS.join(', ')}`)
        }
      }
      return true
    }

    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// @ mention completion
// ---------------------------------------------------------------------------

const showMentionMenu = ref(false)
const mentionFilter = ref('')
const mentionSelectedIdx = ref(0)
const mentionAnchorPos = ref(-1) // caret position of the '@' or start of path
const mentionMode = ref<'at' | 'slash-read' | 'slash-options'>('at')
const slashArgOptions = ref<string[]>([]) // fixed options for slash-options mode
const projectFiles = ref<string[]>([])
const projectFilesLoaded = ref(false)

const MAX_MENTION_RESULTS = 20

/** Project files as relative paths from root. */
const relativeFiles = computed(() => {
  const root = projectStore.currentProject?.root ?? ''
  return projectFiles.value.map((f) => toRelativePath(f, root))
})

const filteredMentionItems = computed(() => {
  // Fixed options mode (e.g. /sandbox, /approval)
  if (mentionMode.value === 'slash-options') {
    if (!mentionFilter.value) return slashArgOptions.value
    const q = mentionFilter.value.toLowerCase()
    return slashArgOptions.value.filter((o) => o.toLowerCase().startsWith(q))
  }
  // File completion mode
  const files = relativeFiles.value
  if (!mentionFilter.value) return files.slice(0, MAX_MENTION_RESULTS)
  const pat = mentionFilter.value
  const results: { path: string; score: number }[] = []
  for (const p of files) {
    const name = basename(p)
    if (name.toLowerCase().includes(pat.toLowerCase())) {
      results.push({ path: p, score: 2 })
    } else if (fuzzyMatch(p, pat)) {
      results.push({ path: p, score: 1 })
    }
    if (results.length >= 100) break
  }
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, MAX_MENTION_RESULTS).map((r) => r.path)
})

async function loadProjectFiles() {
  const project = projectStore.currentProject
  if (!project || projectFilesLoaded.value) return
  projectFilesLoaded.value = true
  try {
    projectFiles.value = await listProjectFiles(project.shell, project.root)
  } catch {
    // ignore
  }
}

function updateMentionMenu() {
  const el = inputRef.value
  if (!el) return
  const text = input.value
  const cursor = el.selectionStart ?? text.length

  // Check for slash commands with arg completion: /read, /sandbox, /approval
  const argMatch = text.match(/^\/(read|sandbox|approval)\s+(.*)/i)
  if (argMatch) {
    const cmd = argMatch[1].toLowerCase()
    const partial = argMatch[2]
    // Anchor at the arg start position (after "/cmd ")
    mentionAnchorPos.value = text.length - partial.length
    mentionFilter.value = partial
    mentionSelectedIdx.value = 0

    if (cmd === 'read') {
      mentionMode.value = 'slash-read'
      loadProjectFiles()
    } else {
      mentionMode.value = 'slash-options'
      slashArgOptions.value = cmd === 'sandbox' ? SANDBOX_OPTIONS : APPROVAL_OPTIONS
    }
    showMentionMenu.value = true
    return
  }

  // Find the last '@' before the cursor that is not preceded by a non-space char
  let atIdx = -1
  for (let i = cursor - 1; i >= 0; i--) {
    if (text[i] === '@' && (i === 0 || /\s/.test(text[i - 1]))) {
      atIdx = i
      break
    }
    if (/\s/.test(text[i])) break
  }

  if (atIdx >= 0) {
    const partial = text.slice(atIdx + 1, cursor)
    mentionFilter.value = partial
    mentionAnchorPos.value = atIdx
    mentionSelectedIdx.value = 0
    mentionMode.value = 'at'
    showMentionMenu.value = true
    loadProjectFiles()
  } else {
    showMentionMenu.value = false
  }
}

function selectMentionItem(item: string) {
  const el = inputRef.value
  if (!el) return

  if (mentionMode.value === 'slash-read' || mentionMode.value === 'slash-options') {
    // Replace command arg: /cmd <partial> → /cmd <item>
    const cmdPrefix = input.value.slice(0, mentionAnchorPos.value)
    input.value = `${cmdPrefix}${item}`
    showMentionMenu.value = false
    nextTick(() => {
      const newPos = input.value.length
      el.setSelectionRange(newPos, newPos)
      el.focus()
    })
  } else {
    // Replace @partial with @item
    const cursor = el.selectionStart ?? input.value.length
    const before = input.value.slice(0, mentionAnchorPos.value)
    const after = input.value.slice(cursor)
    input.value = `${before}@${item} ${after}`
    showMentionMenu.value = false
    nextTick(() => {
      const newPos = before.length + 1 + item.length + 1
      el.setSelectionRange(newPos, newPos)
      el.focus()
    })
  }
}

/** Extract @file mentions from the prompt and load their contents. */
async function resolveFileMentions(
  text: string,
): Promise<{ cleanText: string; contextParts: string[]; resolvedPaths: string[] }> {
  const project = projectStore.currentProject
  if (!project) return { cleanText: text, contextParts: [], resolvedPaths: [] }

  const mentionRegex = /@([\w./_\\:-]+)/g
  const mentions = new Set<string>()
  for (const m of text.matchAll(mentionRegex)) {
    mentions.add(m[1])
  }

  const contextParts: string[] = []
  const sep = project.shell.kind === 'wsl' ? '/' : '\\'

  const MAX_DIR_FILES = 20
  const resolvedMentions = new Set<string>()

  for (const path of mentions) {
    const fullPath = path.startsWith('/') || path.includes(':') ? path : `${project.root}${sep}${path}`

    if (isImageFile(path) || path.endsWith('.svg')) {
      contextParts.push(`[Image file: ${fullPath}]\nPlease examine this image file.`)
      resolvedMentions.add(path)
      continue
    }

    // Try as file first
    try {
      const result = await fsReadFile(project.shell, fullPath)
      contextParts.push(`[File: ${path}]\n\`\`\`\n${result.content}\n\`\`\``)
      resolvedMentions.add(path)
      continue
    } catch {
      // Not a file, try as directory
    }
    // Try as directory — read files in parallel
    try {
      const entries = await fsListDir(project.shell, fullPath)
      const fileEntries = entries.filter((e) => !e.isDir).slice(0, MAX_DIR_FILES)
      if (fileEntries.length === 0) continue
      const results = await Promise.allSettled(
        fileEntries.map(async (entry) => {
          const filePath = `${fullPath}${sep}${entry.name}`
          const result = await fsReadFile(project.shell, filePath)
          return `[${path}${sep}${entry.name}]\n\`\`\`\n${result.content}\n\`\`\``
        }),
      )
      const fileParts = results
        .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
        .map((r) => r.value)
      if (fileParts.length > 0) {
        contextParts.push(`[Directory: ${path}] (${fileParts.length} files)\n\n${fileParts.join('\n\n')}`)
        resolvedMentions.add(path)
      }
    } catch {
      // Not a valid path, leave as-is
    }
  }

  // Remove resolved @mentions from the display text
  const cleanText =
    resolvedMentions.size > 0
      ? text
          .replace(mentionRegex, (full, p) => {
            if (resolvedMentions.has(p)) return ''
            return full
          })
          .trim()
      : text

  return { cleanText: cleanText || text, contextParts, resolvedPaths: [...resolvedMentions] }
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

function onInput() {
  // Check for slash commands with arg completion
  if (/^\/(read|sandbox|approval)\s+/i.test(input.value)) {
    showSlashMenu.value = false
    updateMentionMenu()
    return
  }
  updateSlashMenu()
  if (!showSlashMenu.value) {
    updateMentionMenu()
  } else {
    showMentionMenu.value = false
  }
}

async function submit() {
  const text = input.value.trim()
  if (!text || codex.isGenerating) return
  input.value = ''
  showSlashMenu.value = false
  showMentionMenu.value = false
  await ensureConnected()
  userScrolledUp.value = false

  // Handle slash commands
  if (text.startsWith('/')) {
    const handled = await handleSlashCommand(text)
    if (handled) return
  }

  // Resolve @file mentions
  const { cleanText, contextParts, resolvedPaths } = await resolveFileMentions(text)
  if (contextParts.length > 0) {
    const fullPrompt = `${contextParts.join('\n\n')}\n\n${cleanText}`
    const displayText = `${resolvedPaths.map((p) => `@${p}`).join(' ')}\n${cleanText}`
    await codex.submitTurn(fullPrompt, displayText)
  } else {
    await codex.submitTurn(cleanText)
  }
}

function onKeydown(e: KeyboardEvent) {
  // Handle slash menu navigation
  if (showSlashMenu.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      slashSelectedIdx.value = Math.min(slashSelectedIdx.value + 1, filteredSlashCommands.value.length - 1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      slashSelectedIdx.value = Math.max(slashSelectedIdx.value - 1, 0)
      return
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      const selected = filteredSlashCommands.value[slashSelectedIdx.value]
      if (selected) {
        e.preventDefault()
        selectSlashCommand(selected)
        return
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      showSlashMenu.value = false
      return
    }
  }

  // Handle mention menu navigation
  if (showMentionMenu.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      mentionSelectedIdx.value = Math.min(mentionSelectedIdx.value + 1, filteredMentionItems.value.length - 1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      mentionSelectedIdx.value = Math.max(mentionSelectedIdx.value - 1, 0)
      return
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      const selected = filteredMentionItems.value[mentionSelectedIdx.value]
      if (selected) {
        e.preventDefault()
        selectMentionItem(selected)
        return
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      showMentionMenu.value = false
      return
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submit()
  }
}

function onScroll() {
  const el = messageListRef.value
  if (!el) return
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  userScrolledUp.value = !atBottom
}

function scrollToBottom() {
  if (userScrolledUp.value) return
  nextTick(() => {
    const el = messageListRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

// Close menus on outside click
function onDocumentClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (!target.closest('.slash-menu') && !target.closest('.input-area')) {
    showSlashMenu.value = false
  }
  if (!target.closest('.mention-menu') && !target.closest('.input-area')) {
    showMentionMenu.value = false
  }
}

watch(() => codex.messages.length, scrollToBottom)
watch(() => {
  const last = codex.messages[codex.messages.length - 1]
  return last?.text?.length ?? 0
}, scrollToBottom)
watch(() => codex.scrollTrigger, scrollToBottom)

onMounted(async () => {
  document.addEventListener('click', onDocumentClick)
  await ensureConnected()
  inputRef.value?.focus()
})

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick)
})
</script>

<template>
  <div class="codex-chat-wrapper">
    <!-- Disconnected — offer reconnect -->
    <div v-if="codex.disconnectReason" class="auth-panel">
      <AlertTriangle :size="32" :stroke-width="1.5" class="disconnect-icon" />
      <p>{{ t('codex.disconnected') }}</p>
      <p class="disconnect-detail">{{ codex.disconnectReason }}</p>
      <button class="btn-primary" @click="reconnect">{{ t('codex.reconnect') }}</button>
    </div>

    <!-- Connecting -->
    <div v-else-if="!isConnected" class="auth-panel">
      <Loader :size="32" :stroke-width="2" class="spin" />
      <p>{{ t('codex.connecting') }}</p>
    </div>

    <!-- Main Chat UI -->
    <template v-else>
      <!-- Auth bar -->
      <div v-if="!isAuthenticated" class="auth-bar">
        <span>{{ t('codex.notSignedIn') }}</span>
        <button class="btn-sm" @click="codex.login()">
          <LogIn :size="14" :stroke-width="2" />
          {{ t('codex.signIn') }}
        </button>
      </div>
      <div v-else class="auth-bar auth-bar-ok">
        <span>{{ codex.authState.status === 'authenticated' ? (codex.authState as { email: string | null }).email ?? 'ChatGPT' : '' }}</span>
        <div class="auth-actions">
          <button class="btn-sm btn-ghost" :title="t('codex.search')" @click="toggleSearch">
            <Search :size="14" :stroke-width="2" />
          </button>
          <button class="btn-sm btn-ghost" :title="t('codex.newConversation')" @click="startNewConversation">
            <MessageSquarePlus :size="14" :stroke-width="2" />
          </button>
          <button class="btn-sm btn-ghost" :title="t('codex.signOut')" @click="codex.logout()">
            <LogOut :size="14" :stroke-width="2" />
          </button>
        </div>
      </div>

      <!-- Status bar: sandbox/approval mode, instructions file, token usage -->
      <div v-if="codex.connected" class="info-bar">
        <span class="info-indicator sandbox clickable" :title="`/sandbox ${effectiveSandbox}`" @click.stop="prefillCommand('/sandbox ')">
          <Shield :size="12" :stroke-width="2" />
          {{ effectiveSandbox }}
        </span>
        <span class="info-indicator approval clickable" :title="`/approval ${effectiveApproval}`" @click.stop="prefillCommand('/approval ')">
          <ShieldCheck :size="12" :stroke-width="2" />
          {{ effectiveApproval }}
        </span>
        <span v-if="codex.detectedInstructionsFile" class="info-indicator instructions clickable" @click="openInstructionsFile">
          <FileCode :size="12" :stroke-width="2" />
          {{ codex.detectedInstructionsFile }}
        </span>
        <span v-if="codex.tokenUsage" class="info-indicator tokens">
          {{ formatTokens(codex.tokenUsage.input) }} in / {{ formatTokens(codex.tokenUsage.output) }} out
        </span>
      </div>

      <!-- Version warning -->
      <div v-if="codex.versionWarning" class="version-warning">
        <AlertTriangle :size="14" :stroke-width="2" />
        <span>{{ codex.versionWarning }}</span>
      </div>

      <!-- Search bar -->
      <div v-if="showSearch" class="search-bar">
        <Search :size="14" :stroke-width="2" class="search-icon" />
        <input
          v-model="searchQuery"
          :placeholder="t('codex.searchPlaceholder')"
          class="search-input"
          @keydown.escape="toggleSearch"
          @keydown.enter.exact="searchNav(1)"
          @keydown.shift.enter="searchNav(-1)"
        />
        <template v-if="searchQuery">
          <span class="search-count">{{ searchMatchList.length > 0 ? searchCurrentIdx + 1 : 0 }} / {{ searchMatchList.length }}</span>
          <button class="btn-search-nav" @click="searchNav(-1)" :disabled="searchMatchList.length === 0">&uarr;</button>
          <button class="btn-search-nav" @click="searchNav(1)" :disabled="searchMatchList.length === 0">&darr;</button>
        </template>
      </div>

      <!-- Messages -->
      <div class="message-list" ref="messageListRef" @scroll="onScroll">
        <div v-if="codex.messages.length === 0" class="empty-chat">
          <Bot :size="32" :stroke-width="1" />
          <p>{{ t('codex.emptyChat') }}</p>
        </div>
        <div
          v-for="msg in codex.messages"
          :key="msg.id"
          :data-msg-id="msg.id"
          class="message"
          :class="[msg.role, { 'search-hit': searchQuery && searchMatchIds.has(msg.id), 'search-current': searchMatchList[searchCurrentIdx]?.id === msg.id }]"
        >
          <div v-if="msg.role === 'user'" class="msg-user">{{ msg.text }}</div>
          <div v-else class="msg-agent">
            <!-- Segments: text and items in chronological order -->
            <template v-for="(seg, si) in msg.segments" :key="si">
              <!-- Text segment -->
              <div v-if="seg.kind === 'text'" class="msg-text" v-html="renderMarkdown(seg.text)" />

              <!-- Item segment -->
              <template v-else-if="seg.kind === 'item'">
                <div class="msg-item">
                  <template v-if="seg.item.type === 'commandExecution'">
                    <details class="item-details" :open="!seg.item.completed || undefined">
                      <summary class="item-command">
                        <Loader v-if="!seg.item.completed" :size="12" :stroke-width="2" class="spin item-icon" />
                        <TerminalIcon v-else :size="12" :stroke-width="2" class="item-icon" />
                        <code>{{ seg.item.data.command ?? 'Running command...' }}</code>
                        <span v-if="seg.item.completed && seg.item.data.exitCode != null" class="item-exit" :class="{ ok: seg.item.data.exitCode === 0 }">
                          {{ seg.item.data.exitCode === 0 ? '✓' : `exit ${seg.item.data.exitCode}` }}
                        </span>
                      </summary>
                      <pre v-if="seg.item.data.output" class="item-output">{{ seg.item.data.output }}</pre>
                    </details>
                  </template>
                  <template v-else-if="seg.item.type === 'fileChange'">
                    <div class="item-command item-clickable" @click="openFileChangeDiff(seg.item)">
                      <Loader v-if="!seg.item.completed" :size="12" :stroke-width="2" class="spin item-icon" />
                      <FileEdit v-else :size="12" :stroke-width="2" class="item-icon" />
                      <span v-if="seg.item.data.filePath" class="item-filepath">{{ seg.item.data.filePath }}</span>
                      <span v-else>{{ t('codex.fileChange') }}</span>
                      <span v-if="seg.item.completed && (seg.item.data.additions != null || seg.item.data.deletions != null)" class="item-diff-stats">
                        <span v-if="seg.item.data.additions" class="diff-add">+{{ seg.item.data.additions }}</span>
                        <span v-if="seg.item.data.deletions" class="diff-del">-{{ seg.item.data.deletions }}</span>
                      </span>
                    </div>
                  </template>
                  <template v-else-if="seg.item.type === 'reasoning' && reasoningSummary(seg.item)">
                    <details class="item-details">
                      <summary class="item-command item-reasoning">
                        <BrainCircuit :size="12" :stroke-width="2" class="item-icon" />
                        <span>{{ t('codex.reasoning') }}</span>
                      </summary>
                      <div class="item-reasoning-text" v-html="renderMarkdown(reasoningSummary(seg.item)!)" />
                    </details>
                  </template>
                </div>
              </template>
            </template>

            <!-- Thinking indicator (no segments yet) -->
            <div v-if="!msg.completed && msg.segments.length === 0" class="msg-thinking">
              <Loader :size="14" :stroke-width="2" class="spin" />
              <span>{{ t('codex.thinking') }}</span>
            </div>
            <!-- Processing spinner at the end while still generating -->
            <div v-else-if="!msg.completed" class="msg-thinking">
              <Loader :size="14" :stroke-width="2" class="spin" />
            </div>
          </div>
        </div>
      </div>

      <!-- Input -->
      <div class="input-area">
        <!-- Slash command menu -->
        <div v-if="showSlashMenu && filteredSlashCommands.length > 0" class="slash-menu">
          <div
            v-for="(cmd, idx) in filteredSlashCommands"
            :key="cmd.name"
            class="slash-menu-item"
            :class="{ selected: idx === slashSelectedIdx }"
            @click="selectSlashCommand(cmd)"
            @mouseenter="slashSelectedIdx = idx"
          >
            <span class="slash-cmd-name">{{ cmd.name }}</span>
            <span class="slash-cmd-desc">{{ cmd.description }}</span>
          </div>
        </div>

        <!-- Completion menu (files or options) -->
        <div v-if="showMentionMenu && filteredMentionItems.length > 0" class="mention-menu">
          <div
            v-for="(item, idx) in filteredMentionItems"
            :key="item"
            class="mention-menu-item"
            :class="{ selected: idx === mentionSelectedIdx }"
            @click="selectMentionItem(item)"
            @mouseenter="mentionSelectedIdx = idx"
          >
            <template v-if="mentionMode === 'slash-options'">
              <span class="mention-option">{{ item }}</span>
              <span v-if="OPTION_DESC_KEYS[item]" class="mention-option-desc">{{ t(OPTION_DESC_KEYS[item]) }}</span>
            </template>
            <template v-else>
              <span class="mention-filename">{{ basename(item) }}</span>
              <span class="mention-path">{{ item }}</span>
            </template>
          </div>
        </div>

        <div class="input-row">
          <textarea
            ref="inputRef"
            v-model="input"
            :placeholder="t('codex.inputPlaceholder')"
            :disabled="!isAuthenticated"
            rows="1"
            @keydown="onKeydown"
            @input="onInput"
            @paste="onPaste"
            @dragover.prevent="onDragOver"
            @drop.prevent="onDrop"
          />
          <button
            v-if="codex.isGenerating"
            class="btn-send btn-stop"
            :title="t('codex.stop')"
            @click="codex.interruptTurn()"
          >
            <Square :size="16" :stroke-width="2" />
          </button>
          <button
            v-else
            class="btn-send"
            :disabled="!input.trim() || !isAuthenticated"
            :title="t('codex.send')"
            @click="submit()"
          >
            <Send :size="16" :stroke-width="2" />
          </button>
        </div>
      </div>
    </template>

    <!-- Approval Dialogs -->
    <ApprovalDialog />
  </div>
</template>

<style scoped>
.codex-chat-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);
}

.auth-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 100%;
  color: var(--text-secondary);
}

.auth-icon {
  opacity: 0.5;
}

.auth-desc {
  max-width: 300px;
  text-align: center;
  font-size: 13px;
  line-height: 1.5;
}

.btn-primary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--accent);
  color: var(--bg-primary);
  border: none;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
}

.btn-primary:hover {
  opacity: 0.9;
}

.auth-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-secondary);
}

.auth-bar-ok {
  color: var(--text-primary);
}

.auth-actions {
  display: flex;
  gap: 2px;
}

.btn-sm {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: var(--accent);
  color: var(--bg-primary);
  border: none;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
}

.btn-ghost {
  background: transparent;
  color: var(--text-secondary);
}

.btn-ghost:hover {
  color: var(--text-primary);
}

.version-warning {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: rgba(229, 192, 123, 0.15);
  border-bottom: 1px solid rgba(229, 192, 123, 0.3);
  font-size: 12px;
  color: #e5c07b;
}

.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.empty-chat {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  color: var(--text-secondary);
  opacity: 0.5;
}

.message {
  margin-bottom: 12px;
}

.msg-user {
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg-agent {
  font-size: 13px;
}

.msg-text {
  line-height: 1.6;
  word-break: break-word;
}

.msg-text :deep(pre) {
  background: var(--bg-tertiary);
  padding: 8px 12px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 12px;
}

.msg-text :deep(code) {
  background: var(--bg-tertiary);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
}

.msg-text :deep(pre code) {
  background: none;
  padding: 0;
}

.msg-text :deep(a) {
  color: var(--accent);
  text-decoration: none;
  pointer-events: none;
}

.msg-text :deep(p) {
  margin: 0 0 8px;
}

.msg-text :deep(p:last-child) {
  margin-bottom: 0;
}

.msg-thinking {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.msg-item {
  margin: 4px 0;
}

.item-command {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--bg-tertiary);
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}

.item-command code {
  color: var(--text-primary);
  font-size: 11px;
}

.item-icon {
  flex-shrink: 0;
}

.item-exit {
  margin-left: auto;
  font-size: 11px;
  color: var(--danger, #e06c75);
}

.item-exit.ok {
  color: var(--success, #98c379);
}

.item-details {
  margin: 4px 0;
}

.item-details summary {
  cursor: pointer;
  list-style: none;
}

.item-details summary::-webkit-details-marker {
  display: none;
}

.item-output {
  margin: 4px 0 0;
  padding: 6px 8px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 11px;
  line-height: 1.4;
  max-height: 200px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-secondary);
}

.item-clickable {
  cursor: pointer;
}

.item-clickable:hover {
  background: var(--tab-hover-bg);
}

.item-reasoning {
  color: var(--text-secondary);
}

.item-reasoning-text {
  padding: 6px 8px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.item-reasoning-text :deep(p) {
  margin: 0 0 4px;
}

/* Search bar */
.search-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}

.search-icon {
  flex-shrink: 0;
  color: var(--text-secondary);
}

.search-input {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  outline: none;
}

.search-count {
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.btn-search-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.btn-search-nav:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--tab-hover-bg);
}

.btn-search-nav:disabled {
  opacity: 0.3;
  cursor: default;
}

.message.search-hit {
  border-left: 2px solid var(--accent);
  padding-left: 10px;
}

.message.search-current {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  border-left-color: var(--accent);
}

.info-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-secondary);
}

.info-indicator {
  display: flex;
  align-items: center;
  gap: 4px;
}

.info-indicator.clickable {
  cursor: pointer;
}

.info-indicator.clickable:hover {
  opacity: 0.8;
}

.info-indicator.sandbox {
  color: #61afef;
}

.info-indicator.approval {
  color: #d19a66;
}

.info-indicator.instructions {
  color: #98c379;
}

.info-indicator.tokens {
  margin-left: auto;
  color: var(--text-secondary);
}

.disconnect-icon {
  color: var(--danger, #e06c75);
  opacity: 0.7;
}

.disconnect-detail {
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-word;
  max-width: 400px;
  text-align: center;
}

.item-filepath {
  color: var(--text-primary);
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 11px;
}

.item-diff-stats {
  margin-left: auto;
  display: flex;
  gap: 6px;
  font-size: 11px;
}

.diff-add {
  color: var(--success, #98c379);
}

.diff-del {
  color: var(--danger, #e06c75);
}

.input-area {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
}

.input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.input-row textarea {
  flex: 1;
  resize: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  font-family: inherit;
  background: var(--bg-primary);
  color: var(--text-primary);
  outline: none;
  min-height: 36px;
  max-height: 120px;
}

.input-row textarea:focus {
  border-color: var(--accent);
}

/* Slash command menu */
.slash-menu {
  position: absolute;
  bottom: 100%;
  left: 12px;
  right: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.2);
  max-height: 280px;
  overflow-y: auto;
  z-index: 100;
  margin-bottom: 4px;
}

.slash-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
}

.slash-menu-item.selected {
  background: var(--bg-tertiary);
}

.slash-cmd-name {
  color: var(--accent);
  font-weight: 600;
  flex-shrink: 0;
}

.slash-cmd-desc {
  color: var(--text-secondary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* @ mention menu */
.mention-menu {
  position: absolute;
  bottom: 100%;
  left: 12px;
  right: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.2);
  max-height: 240px;
  overflow-y: auto;
  z-index: 100;
  margin-bottom: 4px;
}

.mention-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 12px;
}

.mention-menu-item.selected {
  background: var(--bg-tertiary);
}

.mention-filename {
  color: var(--text-primary);
  font-weight: 500;
  flex-shrink: 0;
}

.mention-path {
  color: var(--text-secondary);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mention-option {
  color: var(--accent);
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 12px;
}

.mention-option-desc {
  color: var(--text-secondary);
  font-size: 11px;
  margin-left: auto;
}

.btn-send {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 6px;
  background: var(--accent);
  color: var(--bg-primary);
  cursor: pointer;
  flex-shrink: 0;
}

.btn-send:disabled {
  opacity: 0.3;
  cursor: default;
}

.btn-stop {
  background: var(--danger, #e06c75);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
