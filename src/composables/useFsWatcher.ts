import { listen } from '@tauri-apps/api/event'
import { computed, ref } from 'vue'
import { t } from '../i18n'
import { normalizeSep, wslUncToNative } from '../lib/paths'
import { loadAskedKeys, rememberAskedKey } from '../lib/storage'
import { fsWatchStart, fsWatchStop } from '../lib/tauri'
import { useTabStore } from '../stores/tabs'
import { installKey, isWindowsShell, type ShellType } from '../types/tab'
import { confirmDialog, dialogOpen } from './useConfirmDialog'

export interface FsChangeEntry {
  path: string
  kind: 'create' | 'modify' | 'delete'
}

const SAVE_TTL_MS = 2000

/**
 * 自分が書いたファイルの印。**通知 1 回ぶんで使い切る**（#276）。
 *
 * 以前は「保存から 2 秒のあいだの通知を全部捨てる」形で、しかも保存のたびに窓が延びた。
 * 自動保存（#262）を 2 秒より短い間隔で走らせると窓が開きっぱなしになり、**その最中に
 * エージェントが同じファイルを書いても外部変更として届かない**。届かなければ警告バーも
 * 出ず、「警告中は自動保存しない」というガードも素通りして、次の自動保存が相手の変更を
 * 黙って上書きする。
 *
 * 1 回の書き込みが生む通知は 1 回（Rust 側の `EventBuffer` がパスで畳んでから送る）なので、
 * 使い切りにすれば「自分のぶんを 1 回吸って、次からは他人のもの」になる。まとめ切れずに
 * 2 回に割れたときは、余ったほうが外部変更として出る。clean なタブなら同じ内容で読み直す
 * だけ、dirty なら消せる警告バーが 1 回出る。**黙って上書きするより、消せる誤検知を採る。**
 *
 * **`isRecentlySaved` が真を返した時点で落とす。** 判定と消費が同じ 1 回なので、
 * 「1 回ぶんで使い切る」がそのまま読める。**読む人を 2 人目にしないこと**: 同じバッチで
 * 2 つのリスナが呼ぶ形にすると、先に呼んだほうが印を食べて、後ろのリスナには自分の
 * 書き込みが他人のものとして届く（配り終えてから落とす仕組みが要る）。
 */
const selfWrites = new Map<string, number>()

export function markRecentlySaved(path: string) {
  // Keys are separator-normalized: editor tab paths can mix `/` and `\` on
  // Windows while watcher events always use `\`.
  selfWrites.set(normalizeSep(path), Date.now() + SAVE_TTL_MS)
}

export function isRecentlySaved(path: string): boolean {
  const key = normalizeSep(path)
  const expires = selfWrites.get(key)
  if (expires === undefined) return false
  selfWrites.delete(key)
  return Date.now() < expires
}

interface FsChangedPayload {
  watcherId: string
  changedDirs: string[]
  changedFiles: FsChangeEntry[]
}

/**
 * 監視が落ちた知らせ（#385）。**綴りの正本は Rust の `WatchFailReason`**（camelCase で
 * serialize される）。`watcher.<reason>` の i18n キーもこの綴りで引く。
 */
interface FsWatchFailedPayload {
  watcherId: string
  reason: 'missingTool' | 'watchLimit' | 'other'
  detail: string
}

/**
 * 案内に出す理由。**Rust の 3 つに `wslUnc` を足した集合**（#385）。
 *
 * `wslUnc` だけはフロントが自分で立てる。あれは「監視は動いているが、WSL の中からの
 * 変更は届かない」という**警告**で、Rust から見れば失敗ではない（`notify` は成功を返す）。
 * しかも判定に要るのはシェルの種別とルートの綴りだけで、どちらも `start()` が持っている。
 */
type WatchNoticeReason = FsWatchFailedPayload['reason'] | 'wslUnc'

/**
 * 監視についての知らせ 1 件（#385）。
 *
 * **理由と文言を別々の ref にしないこと。** 3 か所すべてで対で代入・対でクリアされるので、
 * 分けると「理由は null なのに文言は前回のまま」という表せてはいけない状態が作れる。
 */
interface WatchNotice {
  reason: WatchNoticeReason
  /** 実際に出た文言（`wslUnc` ではルート）。理由を当てられなかったときの手がかり。 */
  detail: string
}

/**
 * `inotify-tools` を入れる 1 行。**パッケージマネージャを当てる**のは、WSL の distro が
 * Ubuntu とは限らないため。当たらなければそのまま案内が出るので、ターミナルで見た人が
 * 自分で直せる。
 */
const INSTALL_INOTIFY =
  'if command -v apt-get >/dev/null; then sudo apt-get install -y inotify-tools; ' +
  'elif command -v dnf >/dev/null; then sudo dnf install -y inotify-tools; ' +
  'elif command -v pacman >/dev/null; then sudo pacman -S --noconfirm inotify-tools; ' +
  'elif command -v apk >/dev/null; then sudo apk add inotify-tools; ' +
  'elif command -v zypper >/dev/null; then sudo zypper install -y inotify-tools; ' +
  'else echo "inotify-tools を手で入れてください"; fi'

/**
 * 「入れますか」を聞いたことの記録。**シェルの導入単位ごと**（`useAgentHookPrompt` と
 * 同じ形）。distro を跨いで 1 回にすると、別の distro のプロジェクトを開いたときに
 * 聞かれないまま監視が死ぬ。
 */
const ASKED_KEY = 'pike:inotify-asked'

type DirChangeHandler = (dirs: string[]) => void
type FileChangeHandler = (files: FsChangeEntry[]) => void

const currentWatcherId = ref<string | null>(null)
/**
 * いま出ている知らせ（#385）。null なら何も出さない。出し分けは `reason` を見る
 * （**文面で分岐しないこと**: 翻訳を変えると黙って壊れる）。
 */
const notice = ref<WatchNotice | null>(null)
/**
 * 案内に出す一文。**翻訳結果を ref に焼き込まないこと**: `t()` は呼んだ時点で解決するので、
 * 入れてしまうと UI 言語を切り替えても帯だけ古い言語のまま残る。computed にすれば `locale`
 * への依存が張られて追従する。
 */
const noticeText = computed(() => (notice.value ? t(`watcher.${notice.value.reason}`) : null))
const dirHandlers: DirChangeHandler[] = []
const fileHandlers: FileChangeHandler[] = []

let initialized = false

async function init() {
  if (initialized) return
  initialized = true

  await listen<FsChangedPayload>('fs_changed', (event) => {
    const { watcherId, changedDirs, changedFiles } = event.payload
    if (watcherId !== currentWatcherId.value) return
    for (const h of dirHandlers) h(changedDirs)
    for (const h of fileHandlers) h(changedFiles)
  })

  await listen<FsWatchFailedPayload>('fs_watch_failed', (event) => {
    const { watcherId, reason, detail } = event.payload
    if (watcherId !== currentWatcherId.value) return
    // 監視はもう動いていない。id を落として、以後のイベントを拾わないようにする。
    // **`fsWatchStop` は投げない**: 子は既に終わっていて、後始末（ハンドルの削除と
    // flush スレッドの停止）は Rust 側が自分で済ませる。ここで投げると、死んだ PID に
    // `taskkill` を撃つことになる（Windows が再利用していれば無関係なプロセスを殺す）。
    currentWatcherId.value = null
    notice.value = { reason, detail }
    if (reason === 'missingTool') void askToInstallInotify()
  })
}

/** 直近の監視の材料。落ちたあと入れ直したときに、同じ相手で張り直すために持つ。 */
let lastTarget: { shell: ShellType; root: string } | null = null

async function start(shell: ShellType, root: string) {
  await stop()
  lastTarget = { shell, root }
  try {
    currentWatcherId.value = await fsWatchStart(shell, root)
    notice.value = unwatchableWslUnc(shell, root) ? { reason: 'wslUnc', detail: root } : null
  } catch (e) {
    notice.value = { reason: 'other', detail: String(e) }
  }
}

/**
 * Windows の種別で WSL のディレクトリを開いている（#385）。
 *
 * そのとき監視に使われるのは `ReadDirectoryChangesW` で、**開始は成功するのに WSL の中
 * からの書き込みが 1 件も届かない**（9p 越しでは通知が上がらない。2026-09-21 にこの開発機で
 * 実測: 開始 OK / 受信 0 件）。Windows 側から書いたぶんは届くので監視は止めず、**帯だけ
 * 出す**。エラーが無いぶん、これは `inotify-tools` の不在より気付きにくい。
 *
 * **判定をフロントに置いてあるのは、根がプロジェクトの種別だから。** 直し方は「WSL の
 * プロジェクトとして登録し直す」で、そこは Rust が知らない。
 */
function unwatchableWslUnc(shell: ShellType, root: string): boolean {
  return isWindowsShell(shell) && wslUncToNative(root) !== null
}

/**
 * `inotifywait` が無いので入れるか聞く（#385）。
 *
 * **ダイアログで聞くのは、これが WSL では必須だから。** 入っていないと外部の変更が
 * 一切届かず、しかも**静かに**届かない（エージェントがファイルを書いてもエディタが
 * 古いまま）。以前はファイルツリーのパネルにだけ案内を置いていたが、そもそもその案内が
 * 出ない作りだったうえ、パネルを開いていない人には届かなかった。
 *
 * **聞くのはシェルの導入単位ごとに 1 度**（`useAgentHookPrompt` と同じ形）。断った人に
 * 切り替えのたび聞かない。以後はパネルと設定画面の帯が残る。
 */
async function askToInstallInotify() {
  const target = lastTarget
  if (!target) return
  // **`shellId` ではなく `installKey`**（`useAgentHookPrompt` と同じ鍵）。distro ごとに
  // 1 度で、Windows の 4 シェルは同じ 1 つにまとまる。
  const key = installKey(target.shell)
  if (loadAskedKeys(ASKED_KEY).includes(key)) return

  // **他のダイアログが開いていたら譲る（記録もしない）。** `confirmDialog` は開く前に
  // 前のものを `dismiss()`＝偽で解決するので、割り込むと相手の答えを奪ううえ、自分も
  // 「断られた」ことになって記録される。プロジェクトを切り替えると監視の張り直しと
  // `useAgentHookPrompt` が同じ契機で走るので、これは普通に起きる。
  if (dialogOpen()) return

  const ok = await confirmDialog(t('watcher.installPrompt'))
  // **記録は答えのあと。** 先に書くと、上の割り込みで見ないまま封じられる。`rememberAskedKey`
  // が書く直前に読み直すので、待っているあいだに別のウィンドウが足したキーを消さない。
  rememberAskedKey(ASKED_KEY, key)
  if (!ok) return
  installInotify()
}

/**
 * インストールを実際に走らせる（#385）。
 *
 * **「聞いたか」を見ない。** パネルと設定画面のボタンはここを呼ぶが、そのボタンが出て
 * いる時点で提案は必ず済んでいる（断ったか、割り込まれたか）。`askToInstallInotify` を
 * そのまま繋ぐと、記録に当たって**押しても何も起きないボタン**になる。
 */
function installInotify() {
  const target = lastTarget
  if (!target) return
  useTabStore().runCommandTab(INSTALL_INOTIFY, target.root, target.shell, {
    title: t('watcher.installTitle'),
    keepOnError: true,
    // 入ったら張り直す。**切り替えで相手が変わっていたら何もしない**（`lastTarget` を
    // 見るので、そのときは新しい相手の監視が既に動いている）。
    onExit: (code) => {
      if (code === 0 && lastTarget === target) void start(target.shell, target.root)
    },
  })
}

async function stop() {
  if (currentWatcherId.value) {
    try {
      await fsWatchStop(currentWatcherId.value)
    } catch {
      /* ignore */
    }
    currentWatcherId.value = null
  }
}

function onDirChange(handler: DirChangeHandler) {
  dirHandlers.push(handler)
  return () => {
    const idx = dirHandlers.indexOf(handler)
    if (idx >= 0) dirHandlers.splice(idx, 1)
  }
}

function onFileChange(handler: FileChangeHandler) {
  fileHandlers.push(handler)
  return () => {
    const idx = fileHandlers.indexOf(handler)
    if (idx >= 0) fileHandlers.splice(idx, 1)
  }
}

export const fsWatcher = {
  init,
  start,
  stop,
  onDirChange,
  onFileChange,
  notice,
  noticeText,
  installInotify,
}
