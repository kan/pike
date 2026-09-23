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
 * **いつ同期するか**は同期先で決まる。固定のパスは「今すぐ同期」のときだけ（#403 の方針）。
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
  itemKey,
  mergeSyncItems,
  nextBaseline,
  onlyCategories,
  parseItemKey,
  resolveSyncItems,
  SYNC_CATEGORIES,
  type SyncCategory,
  type SyncMerge,
  toItems,
  toSyncFile,
  withUnsyncedFromRemote,
} from '../lib/syncFormat'
import { type Side, type SyncConflict, stableKey } from '../lib/syncMerge'
import { settingsSyncRead, settingsSyncWrite } from '../lib/tauri'
import { isMainWindow } from '../lib/window'
import { useProjectStore } from './project'
import { useSettingsStore } from './settings'

/** 同期する種類（マシンごと。同期しない）。 */
const CATEGORIES_KEY = 'pike:sync-categories'
/** 同期先ごとの baseline（前回同期した時点の内容）。 */
const BASE_KEY_PREFIX = 'pike:sync-base:'
/** 同期先ごとの、最後に同期できた時刻。 */
const LAST_KEY_PREFIX = 'pike:sync-last:'

const STATE_EVENT = 'pike://sync-state'
const COMMAND_EVENT = 'pike://sync-command'

/** 読んでから書くまでにリモートが変わったときに、読み直してやり直す回数。 */
const MAX_ATTEMPTS = 3

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'conflicts' | 'error'

/** 衝突 1 件（画面に出す形。値はマージに使ったもの）。 */
export interface SyncConflictView extends SyncConflict {
  category: SyncCategory
  /** プロジェクトの項目なら、そのプロジェクトの名前（手元かリモートの）。 */
  projectName?: string
}

/**
 * 同期の状態。**main が持ち、他のウィンドウへ丸ごと配る。** 同期する種類もここに入れる:
 * どのウィンドウからでも切り替えられるが、各ウィンドウが自分で読んだ値を持つと、他の
 * ウィンドウの設定画面が古い選択を出し続ける。
 */
interface SyncState {
  status: SyncStatus
  message: string
  lastSyncedAt: string | null
  conflicts: SyncConflictView[]
  /** 前回同期した時点の内容が無い（初めての同期）。衝突の画面が説明を足す。 */
  firstSync: boolean
  categories: SyncCategory[]
}

type SyncCommand = { kind: 'state' } | { kind: 'sync'; choices?: [string, Side][] }

function loadSyncCategories(): SyncCategory[] {
  const raw = loadJson<unknown>(CATEGORIES_KEY, SYNC_CATEGORIES)
  return Array.isArray(raw) ? SYNC_CATEGORIES.filter((c) => raw.includes(c)) : [...SYNC_CATEGORIES]
}

function loadBase(target: string): Map<string, unknown> | null {
  const raw = loadJson<unknown>(BASE_KEY_PREFIX + target, null)
  return Array.isArray(raw) ? new Map(raw as [string, unknown][]) : null
}

export const useSyncStore = defineStore('sync', () => {
  const settings = useSettingsStore()
  const projectStore = useProjectStore()

  const state = ref<SyncState>({
    status: 'idle',
    message: '',
    lastSyncedAt: null,
    conflicts: [],
    firstSync: false,
    categories: loadSyncCategories(),
  })

  /** 状態を変えて配る（main だけが呼ぶ）。 */
  function setState(patch: Partial<SyncState>) {
    state.value = { ...state.value, ...patch }
    void emit(STATE_EVENT, state.value)
  }

  /** 同期先の識別子（baseline と最終同期時刻の鍵）。無ければ同期しない。 */
  function target(): { key: string; path: string } | null {
    const path = settings.syncFilePath.trim()
    return path ? { key: `file:${path}`, path } : null
  }

  const hasTarget = computed(() => target() !== null)
  const syncing = computed(() => state.value.status === 'syncing')

  /** 同期ファイルを読む。無ければ空。**読めなかったら例外**（空とみなして書くと中身を消す）。 */
  async function readRemote(path: string): Promise<{ file: Record<string, unknown>; raw: string | null }> {
    const raw = await settingsSyncRead(path)
    if (raw === null) return { file: {}, raw }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(t('sync.unreadable'))
    return { file: parsed as Record<string, unknown>, raw }
  }

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

  /**
   * 1 回の同期（main だけが呼ぶ）。`choices` は衝突の画面で選んだもの。選ばれていない衝突は
   * 保留のまま残る。
   */
  async function runSync(choices: ReadonlyMap<string, Side>) {
    const dest = target()
    if (!dest) return
    setState({ status: 'syncing', message: '' })
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (await syncOnce(dest, choices)) return
      }
      throw new Error(t('sync.busy'))
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  /** 1 回ぶん。読んでから書くまでにリモートが変わっていたら false（読み直してやり直す）。 */
  async function syncOnce(dest: { key: string; path: string }, choices: ReadonlyMap<string, Side>) {
    const { file, raw } = await readRemote(dest.path)
    const enabled = new Set(loadSyncCategories())
    const storedBase = loadBase(dest.key)
    const remoteAll = toItems(fromSyncFile(file))
    const snapshot = settings.snapshot()
    const localSrc = {
      settings: snapshot as unknown as Record<string, unknown>,
      projects: projectStore.syncableProjects(),
      // 写しを取る（反映のときに「同期の最中に変わったか」をこれと比べる）。
      groups: [...projectStore.groups],
    }
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
    const out = toSyncFile(withUnsyncedFromRemote(forRemote, remoteAll, enabled), {
      darkMode: snapshot.darkMode,
      agentProfiles: snapshot.agentProfiles,
      agentCommands: snapshot.agentCommands,
    })
    // 変わらなければ書かない（クラウドのフォルダに毎回「更新された」ファイルを作らない）。
    if (stableKey(out) !== stableKey(file)) {
      // **読んだときから変わっていないかを確かめてから書く。** 変わっていたら読み直す。
      if ((await settingsSyncRead(dest.path)) !== raw) return false
      await settingsSyncWrite(dest.path, JSON.stringify(out, null, 2))
    }

    // **手元へは、マージに使った手元の値から変わったものだけを反映する。** 同期の最中に
    // 利用者が変えたものを、開始時点の値で巻き戻さないため。
    let summary = ''
    const changedSettings: Record<string, unknown> = {}
    for (const [key, v] of forLocal) {
      const k = parseItemKey(key)
      if (k[0] === 'setting' && stableKey(v) !== stableKey(m.local.get(key))) changedSettings[k[1]] = v
    }
    if (Object.keys(changedSettings).length > 0) settings.applySyncedSettings(changedSettings)
    if (enabled.has('projects')) {
      const src = fromItems(forLocal)
      const r = await projectStore.applySyncedProjects(
        { projects: src.projects, groups: src.groups },
        { projects: localSrc.projects, groups: localSrc.groups },
      )
      // 作れないものだけなら出さない（同期のたびに同じ件数が出るだけになる）。
      if (r.created + r.updated + r.removed > 0) summary = t('sync.projectSummary', { ...r })
    }

    // 同期しない種類の baseline は前のまま残す（戻したときに、そのあいだの差を比べられる）。
    const next = nextBaseline(m, forRemote, choices)
    for (const [key, v] of storedBase ?? []) if (!enabled.has(categoryOf(key))) next.set(key, v)
    saveJson(BASE_KEY_PREFIX + dest.key, [...next])
    const now = new Date().toISOString()
    saveJson(LAST_KEY_PREFIX + dest.key, now)

    const pending = m.conflicts.filter((c) => !choices.has(c.key))
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

  /** 同期する種類を切り替える（マシンごと）。書いたら main に配り直してもらう。 */
  function setCategories(list: SyncCategory[]) {
    saveJson(
      CATEGORIES_KEY,
      SYNC_CATEGORIES.filter((c) => list.includes(c)),
    )
    if (isMainWindow()) setState({ categories: loadSyncCategories() })
    else void emit(COMMAND_EVENT, { kind: 'state' } satisfies SyncCommand)
  }

  if (isMainWindow()) {
    // 同期先を変えたら、前の同期先の状態（最終同期時刻・衝突）を捨てる。
    watch(
      () => settings.syncFilePath,
      () => {
        const dest = target()
        setState({
          status: 'idle',
          message: '',
          conflicts: [],
          firstSync: false,
          lastSyncedAt: dest ? loadJson<string | null>(LAST_KEY_PREFIX + dest.key, null) : null,
        })
      },
      { immediate: true },
    )
    void listen<SyncCommand>(COMMAND_EVENT, (event) => {
      const cmd = event.payload
      // 状態の問い合わせでは同期する種類も読み直す（他のウィンドウが書き換えた直後に来る）。
      if (cmd.kind === 'state') setState({ categories: loadSyncCategories() })
      else resolveConflicts(new Map(cmd.choices ?? []))
    })
  } else {
    void listen<SyncState>(STATE_EVENT, (event) => {
      state.value = event.payload
    }).then(() => emit(COMMAND_EVENT, { kind: 'state' } satisfies SyncCommand))
  }

  return {
    status: computed(() => state.value.status),
    message: computed(() => state.value.message),
    lastSyncedAt: computed(() => state.value.lastSyncedAt),
    conflicts: computed(() => state.value.conflicts),
    firstSync: computed(() => state.value.firstSync),
    categories: computed(() => state.value.categories),
    hasTarget,
    syncing,
    setCategories,
    syncNow,
    resolveConflicts,
  }
})
