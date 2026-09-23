/**
 * 設定の同期の調停役（#403）。**同期するのは main ウィンドウだけ**で、他のウィンドウは
 * 状態を受け取り、依頼を送るだけにする。以前はウィンドウごとに同期ファイルへ書いていたので、
 * 書き込みどうしが競合していた。
 *
 * 1 回の同期は「読む → 3-way マージ → 書く（読んだときから変わっていなければ）→ 手元へ
 * 反映 → baseline を覚える」を 1 本で行う。マージの規則は `lib/syncMerge.ts`、ファイルとの
 * 行き来は `lib/syncFormat.ts`。
 *
 * **衝突した項目は、手元とリモートをそれぞれの値のまま残し、baseline も前のままにする**
 * （`nextBaseline`）。次の同期でも同じ衝突が出るので、保留を別に覚えておく必要が無い。
 * 衝突の画面（`SyncConflictsTab.vue`）で選んだら、その選択を持ってもう一度同期する。
 *
 * **同期先は 2 つ**（`SyncBackend`）。どちらも「読む・版を確かめる・書く」の 3 つだけで、
 * マージは共通。
 *
 * - **固定のパス**: 「今すぐ同期」のときだけ（#403 の方針）
 * - **GitHub Gist**（`gh` 経由、段階 4）: 自動でも同期する（`scheduleAuto`）。起動時・
 *   変更の数秒後・ウィンドウが前に出たとき（間隔を空ける）
 */

import { emit, listen } from '@tauri-apps/api/event'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { t } from '../i18n'
import { loadJson, saveJson } from '../lib/storage'
import {
  categoryOf,
  fromItems,
  fromSyncFile,
  importSyncItems,
  itemKey,
  mergeSyncItems,
  nextBaseline,
  onlyCategories,
  parseItemKey,
  resolveSyncItems,
  SYNC_CATEGORIES,
  type SyncCategory,
  type SyncMerge,
  type SyncSource,
  toItems,
  toSyncFile,
  withUnsyncedFromRemote,
} from '../lib/syncFormat'
import { type Side, type SyncConflict, type SyncItems, stableKey } from '../lib/syncMerge'
import {
  type GhPlace,
  type GistError,
  pickOpenFile,
  pickSaveFile,
  settingsSyncRead,
  settingsSyncWrite,
  syncGistCreate,
  syncGistRead,
  syncGistRevision,
  syncGistWrite,
} from '../lib/tauri'
import { isMainWindow, windowFocused } from '../lib/window'
import { useProjectStore } from './project'
import { type PersistedSettings, useSettingsStore } from './settings'

/** 同期する種類（マシンごと。同期しない）。 */
const CATEGORIES_KEY = 'pike:sync-categories'
/** 固定のパスの同期先（#164 からの鍵。マシンごと）。 */
const FILE_PATH_KEY = 'pike:sync-path'
/** 同期先の種類と Gist の設定（マシンごと）。 */
const TARGET_KEY = 'pike:sync-target'
/** 同期先ごとの baseline（前回同期した時点の内容）。 */
const BASE_KEY_PREFIX = 'pike:sync-base:'
/** 同期先ごとの、最後に同期できた時刻。 */
const LAST_KEY_PREFIX = 'pike:sync-last:'
/** Gist ごとの、このマシンが最後に書いた版の時刻（古い読み込みを見分ける）。 */
const WRITTEN_KEY_PREFIX = 'pike:sync-written:'

/**
 * 同期ファイルの既定の名前（固定のパスの同期先を選ぶときと、エクスポートの保存先）。Gist の
 * 中のファイル名（`settings_gist.rs` の `FILE_NAME`）とも揃えてある。
 */
export const SYNC_FILE_NAME = 'pike-settings.json'

const STATE_EVENT = 'pike://sync-state'
const COMMAND_EVENT = 'pike://sync-command'

/** 読んでから書くまでにリモートが変わったときに、読み直してやり直す回数。 */
const MAX_ATTEMPTS = 3
/** 自動の同期（Gist）: 変更からこれだけ待つ（続けて変えたら待ち直す）。 */
const AUTO_DEBOUNCE_MS = 5_000
/** 自動の同期（Gist）: ウィンドウが前に出たときに同期する、前回からの最短の間隔。 */
const AUTO_FOCUS_INTERVAL_MS = 5 * 60_000
/** 自動の同期（Gist）: 起動してから最初に同期するまで（プロジェクトの読み込みを待つ）。 */
const AUTO_STARTUP_DELAY_MS = 3_000
/** 同期で手元を書き換えた直後の変更は、自分の反映なので自動の同期の契機にしない。 */
const AUTO_SELF_QUIET_MS = 2_000

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'conflicts' | 'error'

/** 同期先の種類。設定画面の並びもこの順。 */
export const SYNC_TARGET_KINDS = ['none', 'gist', 'file'] as const
export type SyncTargetKind = (typeof SYNC_TARGET_KINDS)[number]

const isTargetKind = (v: unknown): v is SyncTargetKind => SYNC_TARGET_KINDS.includes(v as SyncTargetKind)

/** 同期先の設定（マシンごと）。 */
export interface SyncTargetConfig {
  kind: SyncTargetKind
  filePath: string
  gistId: string
  ghPlace: GhPlace
}

/** 衝突 1 件（画面に出す形。値はマージに使ったもの）。 */
export interface SyncConflictView extends SyncConflict {
  category: SyncCategory
  /** プロジェクトの項目なら、そのプロジェクトの名前（手元かリモートの）。 */
  projectName?: string
}

/**
 * 同期の状態。**main が持ち、他のウィンドウへ丸ごと配る。** 同期先と同期する種類も
 * ここに入れる: どのウィンドウからでも変えられるが、各ウィンドウが自分で読んだ値を持つと、
 * main は古い同期先で同期し続け、他のウィンドウの設定画面は古い選択を出し続ける。
 */
interface SyncState {
  status: SyncStatus
  message: string
  lastSyncedAt: string | null
  conflicts: SyncConflictView[]
  /** 前回同期した時点の内容が無い（初めての同期）。衝突の画面が説明を足す。 */
  firstSync: boolean
  categories: SyncCategory[]
  target: SyncTargetConfig
}

/**
 * 他のウィンドウから main への依頼。`focus` は「そのウィンドウが前に出た」の知らせで、
 * 自動の同期（Gist）は main のウィンドウでなくても、Pike が前に出たら他の PC の変更を拾う。
 */
type SyncCommand = { kind: 'state' } | { kind: 'focus' } | { kind: 'sync'; choices?: [string, Side][] }

/** 同期先の読み書き。`revision` は「読んだときから変わっていないか」を比べる印。 */
interface SyncBackend {
  /** baseline と最終同期時刻の鍵。 */
  key: string
  read(): Promise<{ file: Record<string, unknown>; revision: string | null }>
  revision(): Promise<string | null>
  write(content: string): Promise<void>
}

function loadSyncCategories(): SyncCategory[] {
  const raw = loadJson<unknown>(CATEGORIES_KEY, SYNC_CATEGORIES)
  return Array.isArray(raw) ? SYNC_CATEGORIES.filter((c) => raw.includes(c)) : [...SYNC_CATEGORIES]
}

function sanitizeGhPlace(v: unknown): GhPlace {
  const p = v as Partial<{ kind: string; distro: string }> | null
  return p?.kind === 'wsl' && typeof p.distro === 'string' && p.distro
    ? { kind: 'wsl', distro: p.distro }
    : { kind: 'host' }
}

/**
 * 同期先の設定を読む。**種類を覚えていなければ、同期ファイルのパスの有無で決める**
 * （#403 より前はパスだけを持っていた。移行のための既定）。
 */
function loadTarget(): SyncTargetConfig {
  const filePath = loadJson<string>(FILE_PATH_KEY, '')
  const raw = loadJson<Partial<SyncTargetConfig> | null>(TARGET_KEY, null)
  const kind: SyncTargetKind = isTargetKind(raw?.kind) ? raw.kind : filePath ? 'file' : 'none'
  const gistId = typeof raw?.gistId === 'string' ? raw.gistId : ''
  return { kind, filePath, gistId, ghPlace: sanitizeGhPlace(raw?.ghPlace) }
}

function saveTarget(target: SyncTargetConfig) {
  saveJson(FILE_PATH_KEY, target.filePath)
  saveJson(TARGET_KEY, { kind: target.kind, gistId: target.gistId, ghPlace: target.ghPlace })
}

function loadBase(key: string): Map<string, unknown> | null {
  const raw = loadJson<unknown>(BASE_KEY_PREFIX + key, null)
  return Array.isArray(raw) ? new Map(raw as [string, unknown][]) : null
}

/** 同期ファイルの中身（文字列）を読む。**読めなかったら例外**（空とみなして書くと中身を消す）。 */
function parseFile(raw: string | null): Record<string, unknown> {
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(t('sync.unreadable'))
  return parsed as Record<string, unknown>
}

/** インポートで取り込む項目の数（ファイルの側を選んだもの。手元のままは選ばなかったのと同じ）。 */
export const importChosenCount = (choices: ReadonlyMap<string, Side>) =>
  [...choices.values()].filter((s) => s === 'remote').length

/** 失敗を画面の文言にする。`gh` の失敗は種類で届く（`GistError`）。 */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message
  const g = e as GistError | null
  if (g?.kind === 'ghMissing') return t('sync.ghMissing')
  if (g?.kind === 'ghAuth') return t('sync.ghAuth')
  if (g?.kind === 'other') return String(g.message)
  return String(e)
}

/** 同期先の設定から読み書きの口を作る。同期できる形になっていなければ null。 */
function backendFor(target: SyncTargetConfig): SyncBackend | null {
  if (target.kind === 'file') {
    const path = target.filePath.trim()
    if (!path) return null
    return {
      key: `file:${path}`,
      read: async () => {
        const raw = await settingsSyncRead(path)
        return { file: parseFile(raw), revision: raw }
      },
      revision: () => settingsSyncRead(path),
      write: (content) => settingsSyncWrite(path, content),
    }
  }
  if (target.kind === 'gist') {
    const id = target.gistId.trim()
    if (!id) return null
    const place = target.ghPlace
    const key = `gist:${id}`
    return {
      key,
      read: async () => {
        const g = await syncGistRead(place, id)
        // **書いた直後の読み込みが古い版を返すことがある。** このマシンが最後に書いた版より
        // 前の版をマージすると、書いたばかりの値を「リモートが戻した」と読んで手元を
        // 巻き戻す。そういう読み込みでは同期しない（次の契機で読み直す）。
        const written = loadJson<string>(WRITTEN_KEY_PREFIX + key, '')
        if (written && g.revisedAt && g.revisedAt < written) throw new Error(t('sync.staleRead'))
        return { file: parseFile(g.content), revision: g.revision }
      },
      revision: () => syncGistRevision(place, id),
      write: async (content) => {
        const revisedAt = await syncGistWrite(place, id, content)
        if (revisedAt) saveJson(WRITTEN_KEY_PREFIX + key, revisedAt)
      },
    }
  }
  return null
}

export const useSyncStore = defineStore('sync', () => {
  const settings = useSettingsStore()
  const projectStore = useProjectStore()

  const initialTarget = loadTarget()
  const initialKey = backendFor(initialTarget)?.key
  const state = ref<SyncState>({
    status: 'idle',
    message: '',
    lastSyncedAt: initialKey ? loadJson<string | null>(LAST_KEY_PREFIX + initialKey, null) : null,
    conflicts: [],
    firstSync: false,
    categories: loadSyncCategories(),
    target: initialTarget,
  })

  /** 状態を変えて配る（main だけが呼ぶ）。 */
  function setState(patch: Partial<SyncState>) {
    state.value = { ...state.value, ...patch }
    void emit(STATE_EVENT, state.value)
  }

  /** 今の同期先の読み書きの口。同期先を決める判断はすべてここを通す。 */
  const backend = computed(() => backendFor(state.value.target))
  const hasTarget = computed(() => backend.value !== null)
  const syncing = computed(() => state.value.status === 'syncing')

  /** 衝突を画面に出す形にする（プロジェクトの項目には名前を添える）。 */
  function viewConflicts(list: SyncConflict[], m: SyncMerge): SyncConflictView[] {
    return list.map((c) => {
      const k = parseItemKey(c.key)
      const view: SyncConflictView = { ...c, category: categoryOf(c.key) }
      if (k[0] === 'project') {
        const nameKey = itemKey(['project', k[1], 'name'])
        const name = m.local.get(nameKey) ?? m.remote.get(nameKey)
        view.projectName = typeof name === 'string' ? name : k[1]
      }
      return view
    })
  }

  /** 同期で手元を書き換えた時刻（直後の変更を自動の同期の契機にしない）。 */
  let appliedAt = 0

  /**
   * 1 回の同期（main だけが呼ぶ）。`choices` は衝突の画面で選んだもの。選ばれていない衝突は
   * 保留のまま残る。
   */
  async function runSync(choices: ReadonlyMap<string, Side>) {
    const b = backend.value
    if (!b) return
    lastAttemptAt = Date.now()
    setState({ status: 'syncing', message: '' })
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (await syncOnce(b, choices)) return
      }
      throw new Error(t('sync.busy'))
    } catch (e) {
      if (isCurrent(b)) setState({ status: 'error', message: describeError(e) })
    }
  }

  /** 最後に同期を試みた時刻（成功したかどうかを問わない。前に出したときの間隔に使う）。 */
  let lastAttemptAt = 0

  /**
   * 同期の最中に同期先を変えていないか。変えていたら、古い同期先の結果で状態を上書きしない
   * （新しい同期先が「今同期した」と出てしまう）。
   */
  const isCurrent = (b: SyncBackend) => backend.value?.key === b.key

  /** 手元の今の内容（同期とエクスポート・インポートが共有する）。 */
  function readLocal() {
    const snapshot = settings.snapshot()
    const localSrc: SyncSource = {
      settings: snapshot as unknown as Record<string, unknown>,
      projects: projectStore.syncableProjects(),
      // 写しを取る（反映のときに「同期の最中に変わったか」をこれと比べる）。
      groups: [...projectStore.groups],
    }
    return { snapshot, localSrc }
  }

  /** 導出のキー（古い版の Pike が読む）は今の値で入れ直す（`DERIVED_SETTING_KEYS`）。 */
  const derivedOf = (s: PersistedSettings) => ({
    darkMode: s.darkMode,
    agentProfiles: s.agentProfiles,
    agentCommands: s.agentCommands,
  })

  /**
   * 手元へ反映する。**マージに使った手元の値（`before`）から変わったものだけを当てる。**
   * 同期の最中に利用者が変えたものを、開始時点の値で巻き戻さないため。戻り値は知らせる文言。
   */
  async function applyLocal(result: SyncItems, before: SyncItems, localSrc: SyncSource): Promise<string> {
    let summary = ''
    const changedSettings: Record<string, unknown> = {}
    let projectsChanged = false
    for (const key of new Set([...result.keys(), ...before.keys()])) {
      const v = result.get(key)
      if (stableKey(v) === stableKey(before.get(key))) continue
      const k = parseItemKey(key)
      // 設定の項目は消えることが無い（既定の値がある）ので、値のあるものだけ。
      if (k[0] !== 'setting') projectsChanged = true
      else if (v !== undefined) changedSettings[k[1]] = v
    }
    if (Object.keys(changedSettings).length > 0) settings.applySyncedSettings(changedSettings)
    // プロジェクトに変化が無ければ反映を飛ばす（一覧の読み直しと比べ直しが要らない）。
    if (projectsChanged) {
      const src = fromItems(result)
      const r = await projectStore.applySyncedProjects(
        { projects: src.projects, groups: src.groups },
        { projects: localSrc.projects, groups: localSrc.groups },
      )
      // 作れないものだけなら出さない（同期のたびに同じ件数が出るだけになる）。
      if (r.created + r.updated + r.removed > 0) summary = t('sync.projectSummary', { ...r })
    }
    return summary
  }

  /** 1 回ぶん。読んでから書くまでにリモートが変わっていたら false（読み直してやり直す）。 */
  async function syncOnce(backend: SyncBackend, choices: ReadonlyMap<string, Side>) {
    const { file, revision } = await backend.read()
    const enabled = new Set(loadSyncCategories())
    const storedBase = loadBase(backend.key)
    const remoteAll = toItems(fromSyncFile(file))
    // **プロジェクトの一覧が読み込み済みであることを確かめてから比べる。** 読み込みの前
    // （起動直後）に比べると、手元の一覧が空のまま「全部消した」と読まれて、他の PC からも消える。
    if (enabled.has('projects')) await projectStore.ensureListsLoaded()
    const { snapshot, localSrc } = readLocal()
    const m = mergeSyncItems(
      storedBase && onlyCategories(storedBase, enabled),
      onlyCategories(toItems(localSrc), enabled),
      onlyCategories(remoteAll, enabled),
      // 削除として伝えるのは #403 以降に消したものだけ（`HiddenProject.shared`）。
      (id) => settings.isProjectDeletedForSync(id),
    )
    // 選んだ衝突は決着させる。残りは手元とリモートをそれぞれの値のまま残す。
    const forLocal = resolveSyncItems(m, choices, 'local')
    const forRemote = resolveSyncItems(m, choices, 'remote')

    // 導出のキー（古い版の Pike が読む）は今の値で入れ直す（`DERIVED_SETTING_KEYS`）。
    const out = toSyncFile(withUnsyncedFromRemote(forRemote, remoteAll, enabled), derivedOf(snapshot))
    // 変わらなければ書かない（同期先に毎回「更新された」ものを作らない）。
    if (stableKey(out) !== stableKey(file)) {
      // **読んだときから変わっていないかを確かめてから書く。** 変わっていたら読み直す。
      if ((await backend.revision()) !== revision) return false
      await backend.write(JSON.stringify(out, null, 2))
    }

    // 同期の反映は自分の変更ではないので、自動の同期の契機にしない（前後で印を付ける。反映の
    // 途中で走る watcher も数えないため）。インポートは手元の変更なので付けない。
    appliedAt = Date.now()
    const summary = await applyLocal(forLocal, m.local, localSrc)
    appliedAt = Date.now()

    // 同期しない種類の baseline は前のまま残す（戻したときに、そのあいだの差を比べられる）。
    const next = nextBaseline(m, forRemote, choices)
    for (const [key, v] of storedBase ?? []) if (!enabled.has(categoryOf(key))) next.set(key, v)
    saveJson(BASE_KEY_PREFIX + backend.key, [...next])
    const now = new Date().toISOString()
    saveJson(LAST_KEY_PREFIX + backend.key, now)

    const pending = m.conflicts.filter((c) => !choices.has(c.key))
    if (!isCurrent(backend)) return true
    setState({
      status: pending.length > 0 ? 'conflicts' : 'synced',
      message: summary,
      lastSyncedAt: now,
      conflicts: viewConflicts(pending, m),
      firstSync: storedBase === null,
    })
    return true
  }

  // main だけが実際に同期する。1 本ずつ流す（同期の途中で次の依頼が来ても重ねない）。
  let chain: Promise<void> = Promise.resolve()

  /**
   * 衝突の選択を反映する（選んだものを持って、もう一度同期する）。選ばずに呼べば「今すぐ
   * 同期」。main 以外のウィンドウからは main へ頼むだけで、終わりを待てない（状態は
   * `STATE_EVENT` で届く）。
   */
  function resolveConflicts(choices: ReadonlyMap<string, Side>): void {
    if (isMainWindow()) {
      chain = chain.then(() => runSync(choices))
      return
    }
    void emit(COMMAND_EVENT, { kind: 'sync', choices: [...choices] } satisfies SyncCommand)
  }

  const syncNow = () => resolveConflicts(new Map())

  /** マシンごとの設定を書いたあと、main に読み直して配り直してもらう。 */
  function afterLocalConfigChange() {
    if (isMainWindow()) reloadConfig()
    else void emit(COMMAND_EVENT, { kind: 'state' } satisfies SyncCommand)
  }

  /** 同期する種類を切り替える（マシンごと）。 */
  function setCategories(list: SyncCategory[]) {
    saveJson(
      CATEGORIES_KEY,
      SYNC_CATEGORIES.filter((c) => list.includes(c)),
    )
    afterLocalConfigChange()
  }

  /** 同期先を変える（マシンごと）。 */
  function setTarget(patch: Partial<SyncTargetConfig>) {
    saveTarget({ ...loadTarget(), ...patch })
    afterLocalConfigChange()
  }

  /**
   * 同期用の Gist を作って同期先にする（中身は空のファイル。続く同期で手元の内容が入る）。
   * どのウィンドウからでも呼べる（作るのは `gh` で、同期ファイルには触らない）。**ここで
   * 同期は呼ばない**: 同期先が変わると main の `reloadConfig` が自動の同期を始める。
   */
  async function createGist(place: GhPlace): Promise<void> {
    const id = await syncGistCreate(place, '{}')
    setTarget({ kind: 'gist', gistId: id, ghPlace: place })
  }

  /** main: マシンごとの設定を読み直して配る。同期先が変わっていたら、前の同期先の状態を捨てる。 */
  function reloadConfig() {
    const target = loadTarget()
    const prevKey = backend.value?.key
    const nextKey = backendFor(target)?.key
    const patch: Partial<SyncState> = { categories: loadSyncCategories(), target }
    if (prevKey !== nextKey) {
      Object.assign(patch, {
        status: 'idle',
        message: '',
        conflicts: [],
        firstSync: false,
        lastSyncedAt: nextKey ? loadJson<string | null>(LAST_KEY_PREFIX + nextKey, null) : null,
      } satisfies Partial<SyncState>)
    }
    setState(patch)
    if (prevKey !== nextKey) scheduleAuto(0)
  }

  // --- エクスポート / インポート（段階 5。毎回ファイルを選ぶ。どのウィンドウでも動く） ---

  /**
   * 手元の内容を同期ファイルと同じ形で書き出す。**同期する種類の選択に依らず全部**
   * （バックアップなので、このマシンで同期を切っている種類も残したい）。
   */
  async function exportTo(path: string): Promise<void> {
    await projectStore.ensureListsLoaded()
    const { snapshot, localSrc } = readLocal()
    const out = toSyncFile(toItems(localSrc), derivedOf(snapshot))
    await settingsSyncWrite(path, JSON.stringify(out, null, 2))
  }

  /**
   * 取り込むファイルと手元の差（インポートのタブが並べる）。**ウィンドウごとに持つ**: 読んだ
   * ウィンドウでそのまま選んで当てるだけで、同期のように main に集める理由が無い。
   */
  const importReview = ref<{ path: string; items: SyncConflictView[] } | null>(null)
  /** 当てるときに使うマージの結果。大きな Map なので reactive にしない。 */
  let importMerge: { m: SyncMerge; localSrc: SyncSource } | null = null
  const importMessage = ref('')

  /** ファイルを読んで、手元との差を並べる（まだ何も当てない）。 */
  async function loadImport(path: string): Promise<void> {
    const [raw] = await Promise.all([settingsSyncRead(path), projectStore.ensureListsLoaded()])
    if (raw === null) throw new Error(t('sync.importMissing'))
    const fileSrc = fromSyncFile(parseFile(raw))
    const { localSrc } = readLocal()
    // 手元で作られないプロジェクトは並べない（反映が黙って飛ばすもの。判定は反映と共有する）。
    const creatable = projectStore.creatableSyncedIds(fileSrc.projects)
    const m = importSyncItems(toItems(localSrc), toItems(fileSrc), (id) => !creatable.has(id))
    importMerge = { m, localSrc }
    importReview.value = { path, items: viewConflicts(m.conflicts, m) }
    importMessage.value = ''
  }

  /** 選んだ項目（`remote`＝ファイルの側）だけを取り込む。残りは捨てる。 */
  async function applyImport(choices: ReadonlyMap<string, Side>): Promise<void> {
    if (!importMerge) return
    const { m, localSrc } = importMerge
    // 取り込んだものは手元の変更として、自動の同期の監視が拾って同期先へ出す（main 以外では、
    // 設定は broadcast、プロジェクトは作ったものも含めて `project_updated` で main へ届く）。
    const summary = await applyLocal(resolveSyncItems(m, choices, 'local'), m.local, localSrc)
    const count = importChosenCount(choices)
    cancelImport()
    importMessage.value = [t('sync.imported', { count }), summary].filter(Boolean).join(' ')
  }

  /** 読んだ差を捨てる（当てたとき・インポートのタブを閉じたとき）。 */
  function cancelImport() {
    importMerge = null
    importReview.value = null
  }

  /** ファイルを選ばせて読む（設定画面とインポートのタブが共有）。選ばなければ false。 */
  async function chooseImportFile(): Promise<boolean> {
    const path = await pickOpenFile(['json'])
    if (!path) return false
    await loadImport(path)
    return true
  }

  /** 保存先を選ばせて書き出す。選ばなければ null、書いたら書いた先。 */
  async function chooseExportFile(): Promise<string | null> {
    const path = await pickSaveFile(SYNC_FILE_NAME)
    if (!path) return null
    await exportTo(path)
    return path
  }

  // --- 自動の同期（Gist だけ、main だけ） ---

  let autoTimer: ReturnType<typeof setTimeout> | null = null

  /** 自動で同期する同期先か（固定のパスは「今すぐ同期」のときだけ）。 */
  const autoEnabled = () => state.value.target.kind === 'gist' && backend.value !== null

  function scheduleAuto(delay: number) {
    if (!isMainWindow() || !autoEnabled()) return
    if (autoTimer) clearTimeout(autoTimer)
    autoTimer = setTimeout(() => {
      autoTimer = null
      syncNow()
    }, delay)
  }

  if (isMainWindow()) {
    /**
     * Pike のどれかのウィンドウが前に出たとき。前回試みてから間が空いていれば同期する
     * （他の PC の変更を拾う）。**間隔は試みた時刻で測る**: 成功した時刻で測ると、`gh` が
     * ログインしていないあいだは前に出すたびに `gh` を起こし直す。
     */
    const onFocus = () => {
      if (Date.now() - lastAttemptAt > AUTO_FOCUS_INTERVAL_MS) scheduleAuto(0)
    }
    reloadConfig()
    void listen<SyncCommand>(COMMAND_EVENT, (event) => {
      const cmd = event.payload
      // 状態の問い合わせではマシンごとの設定も読み直す（他のウィンドウが書き換えた直後に来る）。
      if (cmd.kind === 'state') reloadConfig()
      else if (cmd.kind === 'focus') onFocus()
      else resolveConflicts(new Map(cmd.choices ?? []))
    })
    // 起動時。プロジェクトの一覧の読み込みを待つ（`syncOnce` も確かめるが、起動の混雑を避ける）。
    scheduleAuto(AUTO_STARTUP_DELAY_MS)
    // 変更の数秒後。**自動で同期する同期先のときだけ、同期する種類だけを見る**（見るだけで
    // 文字列にするので、ファイルの同期先ではスライダーを動かすたびに無駄になる）。
    // **同期の反映による変更は数えない**（数えると同期のたびにもう 1 回走る）。
    watch(
      () => {
        if (!autoEnabled()) return ''
        // 設定とブックマークはどちらも設定のストアから来る（`categoryOf`）。
        const cats = state.value.categories
        const projects = cats.includes('projects')
        return stableKey([
          cats.some((c) => c !== 'projects') ? settings.snapshot() : null,
          projects ? [projectStore.syncableProjects(), projectStore.groups] : null,
        ])
      },
      (key) => {
        if (!key || Date.now() - appliedAt < AUTO_SELF_QUIET_MS) return
        scheduleAuto(AUTO_DEBOUNCE_MS)
      },
    )
    watch(windowFocused, (focused) => {
      if (focused) onFocus()
    })
  } else {
    void listen<SyncState>(STATE_EVENT, (event) => {
      state.value = event.payload
    }).then(() => emit(COMMAND_EVENT, { kind: 'state' } satisfies SyncCommand))
    // このウィンドウが前に出たことを main へ知らせる（main が自動の同期の間隔を判断する）。
    watch(windowFocused, (focused) => {
      if (focused) void emit(COMMAND_EVENT, { kind: 'focus' } satisfies SyncCommand)
    })
  }

  return {
    status: computed(() => state.value.status),
    message: computed(() => state.value.message),
    lastSyncedAt: computed(() => state.value.lastSyncedAt),
    conflicts: computed(() => state.value.conflicts),
    firstSync: computed(() => state.value.firstSync),
    categories: computed(() => state.value.categories),
    target: computed(() => state.value.target),
    hasTarget,
    syncing,
    setCategories,
    setTarget,
    createGist,
    syncNow,
    resolveConflicts,
    importReview,
    importMessage,
    applyImport,
    cancelImport,
    chooseImportFile,
    chooseExportFile,
  }
})
