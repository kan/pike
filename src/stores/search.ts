import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { askOnce, confirmDialog, infoDialog } from '../composables/useConfirmDialog'
import { t } from '../i18n'
import { relativeToBase, rootKey } from '../lib/projectPaths'
import { searchDetectBackend, searchExecute, searchReplaceApply } from '../lib/tauri'
import type { ReplaceFileEdit, ReplaceOutcome, SearchBackendInfo, SearchMatch, SearchOptions } from '../types/search'
import { installKey, isUnsavedEditor, type ShellType, shellToPlatform } from '../types/tab'
import { useProjectStore } from './project'
import { createShellProbe } from './shellProbe'
import { useStatusMessageStore } from './statusMessage'
import { useTabStore } from './tabs'

/**
 * 検出に失敗したときの想定。grep に PCRE2 は無い。**ripgrep の導入は勧めない**
 * （`rgMissing` が偽）: IPC が落ちただけで「入っていない」と言うことになる。
 */
const GREP_ONLY: SearchBackendInfo = {
  backend: 'grep',
  version: null,
  pcre2: false,
  replace: false,
  outdated: false,
  rgMissing: false,
}

/**
 * WSL に公式リリースの ripgrep を入れる 1 行。**apt は使わない**: Ubuntu 22.04 の apt が
 * 入れるのは 13 で、入れた直後に「古い」側へ回る。`musl` の静的リンクのバイナリなので
 * distro を問わず動く。置き場は `/usr/local/bin`（`wsl.exe -e` の既定の PATH で `/usr/bin`
 * より前にあるので、Pike の検出もターミナルも新しいほうを拾う）。sha256 を照合してから置く。
 *
 * `bash -c` で包むのは、ターミナルの対話シェルに `set -e` と `exit` を流さないため。
 * **中身に単引用符を使わないこと**（包みが割れる）。
 */
const INSTALL_RIPGREP =
  'bash -c \'set -e; case "$(uname -m)" in x86_64) t=x86_64-unknown-linux-musl;; ' +
  'aarch64|arm64) t=aarch64-unknown-linux-musl;; *) echo "unsupported: $(uname -m)"; exit 1;; esac; ' +
  'v=$(curl -fsSLI -o /dev/null -w "%{url_effective}" https://github.com/BurntSushi/ripgrep/releases/latest); ' +
  'v=${v##*/}; d=$(mktemp -d); trap "rm -rf \\"$d\\"" EXIT; cd "$d"; n=ripgrep-$v-$t; ' +
  'u=https://github.com/BurntSushi/ripgrep/releases/download/$v/$n.tar.gz; ' +
  'curl -fsSLO "$u"; curl -fsSLO "$u.sha256"; sha256sum -c "$n.tar.gz.sha256"; tar xzf "$n.tar.gz"; ' +
  'sudo install -m 755 "$n/rg" /usr/local/bin/rg; /usr/local/bin/rg --version\''

/** 「ripgrep を入れますか」を聞いたことの記録（`installKey:missing` / `installKey:outdated`）。 */
const RIPGREP_ASKED_KEY = 'pike:ripgrep-asked'

export type RipgrepNotice = 'missing' | 'outdated'

export const useSearchStore = defineStore('search', () => {
  /**
   * バックエンドを探すラッチ（仕組みは `stores/shellProbe.ts`）。**TTL は持たない**
   * （シェルが変わるまで有効）。rg を入れ替える運用は無いので、聞き直す理由が無い。
   *
   * **失敗もそのまま覚える。** grep への落ちは「検出できなかった」ではなく答えそのもので、
   * 覚えないと検索のたびに `wsl.exe` が 1 本上がる。
   */
  const backendProbe = createShellProbe<SearchBackendInfo>((shell, _root, force) =>
    searchDetectBackend(shell, force).catch(() => GREP_ONLY),
  )
  /**
   * 今のシェルのバックエンド。**シェルごとの表を引く**ので、切り替えて probe が返るまでの
   * あいだ前のシェルの答え（別 distro の rg の機能）が出ることはない。
   */
  const backendInfo = computed<SearchBackendInfo | null>(() =>
    backendProbe.answerFor(useProjectStore().currentProject?.shell),
  )

  /**
   * キーから「開いてフォーカスしろ」と言われた合図（#307）。`seed` は選択していた文字列。
   *
   * **持ち回りの状態が要るのは、パネルが遅延マウントだから。** サイドバーは `v-else-if` ＋
   * `defineAsyncComponent` なので、アクションが走る時点ではチャンクすら読まれておらず、
   * `nextTick` を挟んでも template ref が null になる。ref を渡す既存の手
   * （`SideBar` の `fileTreeRef` 等）が使えない。
   *
   * **押すたびにオブジェクトごと差し替える**（`useOutlineSource` の `jumpRequest` と同じ形）
   * ので、同じ内容で押し直しても watcher が再発火する。**受け取った側は null に戻す**:
   * 残すと、パネルを閉じて開き直したときに `immediate` の watcher が古い合図を拾って
   * フォーカスを奪う。
   */
  const pendingOpen = ref<{ seed: string | null } | null>(null)

  /**
   * 検索する範囲を絞ったフォルダ（#376。ファイルツリーの右クリック「このフォルダ内を
   * 検索」）。絶対パスで持ち、**今の `activeRoot` の配下にあるときだけ効く**
   * （`scopeRel`）。プロジェクトや worktree を切り替えると自然に外れるので、切り替えの
   * 経路ごとに消す約束を持たなくてよい（`clear()` は検索語を消したときにも呼ばれるので、
   * そこで消すと絞り込みが打ち直しのたびに外れる）。
   */
  const scope = ref<string | null>(null)

  /** 絞ったフォルダの、プロジェクトのルートからの相対パス（`/` 区切り）。無効なら null。 */
  const scopeRel = computed(() => {
    const projectStore = useProjectStore()
    const project = projectStore.currentProject
    if (!scope.value || !project) return null
    return relativeToBase(projectStore.activeRoot, scope.value, shellToPlatform(project.shell))
  })

  function requestOpen(seed: string | null) {
    pendingOpen.value = { seed }
  }

  /**
   * 範囲を絞る（null で全体に戻す）。**範囲を変える入口はこれだけ。**
   *
   * **前の結果は捨てる**（#376）。パネルは `v-else-if` でマウントし直されるので入力欄は
   * 空に戻るが、ここを触らないとストアの結果だけが前の検索のまま残る。「In: src/lib」と
   * 出ているのに一覧はプロジェクト全体のヒット、という食い違いになり、しかも
   * `results.length` が非 0 なので「結果をタブで開く」が出たままになる。押すと
   * `lastOptions.query` を**新しい範囲で**引き直すので、画面と中身の違うタブができる。
   */
  function setScope(folder: string | null) {
    if (folder === scope.value) return
    scope.value = folder
    clear()
  }

  /** 検索の起点。絞っていればそのフォルダ、無ければプロジェクト（worktree）のルート。 */
  function searchRoot(): string {
    const projectStore = useProjectStore()
    return scopeRel.value ? (scope.value as string) : projectStore.activeRoot
  }
  const results = ref<SearchMatch[]>([])
  /**
   * いま出ている結果がどのクエリのものか（#307）。null は「結果が無い」。
   *
   * **キーで押し直したときに、同じ検索をもう一度走らせないための目印。** `searchSeq` は
   * 遅れて届いた結果を捨てるだけで**子プロセスは止めない**ので、連打するとプロジェクト
   * 全体の rg が並列に積み上がる。一方でプロジェクトの切り替えは `clear()` を呼ぶだけで
   * 入力欄の中身は残るため、「語は入っているのに 0 件」から抜け出す道も要る。
   */
  const resultsFor = computed(() => lastOptions.value?.query ?? null)
  /** いま出ている結果を作った指定。書き出し（`extractToTab`）は同じ条件で検索し直す。 */
  const lastOptions = ref<SearchOptions | null>(null)
  const truncated = ref(false)
  const searching = ref(false)
  const error = ref<string | null>(null)
  let searchSeq = 0

  /** SideBar のヘッダが読む。機能の有無は `backendInfo` から直に読む（聞き方を 2 通りにしない）。 */
  const backend = computed(() => backendInfo.value?.backend ?? null)

  /**
   * 検出は**べき等**にしてある（#304）。バックエンドはシェルごとに違いうる（Windows は
   * 同梱のサイドカー、WSL は distro のもの）ので、シェルごとに覚えて、変わったときだけ
   * 取り直す。**呼ぶ側に「無効化」を持たせないため**で、以前はプロジェクトストアが
   * `resetBackend()` を呼ぶ約束になっていた。シェルを差し替える経路を足した人がそれを
   * 忘れると、別の distro の rg の機能でトグルが出たままになる。
   */
  async function detectBackend(): Promise<void> {
    const projectStore = useProjectStore()
    // **帯が出ているあいだ（rg が無い・古い）だけ、覚えた答えを捨てて聞き直す。** Pike の
    // 導線を通さずに入れた rg（apt・手で置いたもの）を、再起動せずに拾うため。正常な環境では
    // 聞き直さないので、パネルを開くたびに `wsl.exe` が増えることはない。
    const retry = ripgrepNotice.value !== null
    await backendProbe.ask(projectStore.currentProject?.shell, projectStore.activeRoot, retry)
    void offerRipgrep()
  }

  /**
   * WSL の ripgrep が無い・古い（inotify-tools と同じ導線）。**WSL だけ**: Windows と macOS は
   * Pike が同梱する rg と比べて新しいほうを使うので、ここに来ない。grep に落ちると置換も
   * PCRE2 も `.gitignore` の尊重も無くなる。
   */
  const ripgrepNotice = computed<RipgrepNotice | null>(() => {
    const info = backendInfo.value
    if (!info || useProjectStore().currentProject?.shell.kind !== 'wsl') return null
    // **確かに無いときだけ**（Rust の `Probe::Missing`）。冷えた WSL の時間切れでも grep に
    // 落ちるので、`backend === 'grep'` だけで見ると入っている人に sudo の導入を持ちかける。
    if (info.rgMissing) return 'missing'
    return info.outdated ? 'outdated' : null
  })

  /**
   * 入れるか（更新するか）を 1 度だけ聞く。**聞く単位はシェルの導入単位と、無い / 古いの
   * 別**（入れたあとで古いと分かることは無いが、古い rg を消した人にはもう一度聞く）。
   * 譲り方と記録の順序は `askOnce` の doc。
   */
  async function offerRipgrep(): Promise<void> {
    const kind = ripgrepNotice.value
    const shell = useProjectStore().currentProject?.shell
    if (!kind || !shell) return
    const msg = t(`search.ripgrep.${kind}Prompt`, { version: backendInfo.value?.version ?? '' })
    if (await askOnce(RIPGREP_ASKED_KEY, `${installKey(shell)}:${kind}`, msg)) installRipgrep()
  }

  /** 帯の文面とボタンの文言（パネルは読むだけ。`fsWatcher.noticeText` と同じ形）。 */
  const ripgrepNoticeText = computed(() =>
    ripgrepNotice.value
      ? t(`search.ripgrep.${ripgrepNotice.value}`, { version: backendInfo.value?.version ?? '' })
      : null,
  )
  const ripgrepActionLabel = computed(() =>
    ripgrepNotice.value ? t(`search.ripgrep.${ripgrepNotice.value}Title`) : '',
  )

  /**
   * 入れる（更新する）。パネルの帯のボタンもここを呼ぶ（「聞いたか」は見ない。
   * `installInotify` と同じ理由）。終わったら検出をやり直す。
   */
  function installRipgrep(): void {
    const projectStore = useProjectStore()
    const shell = projectStore.currentProject?.shell
    const root = projectStore.activeRoot
    if (!shell) return
    useTabStore().runCommandTab(INSTALL_RIPGREP, root, shell, {
      title: ripgrepActionLabel.value,
      keepOnError: true,
      onExit: (code) => {
        if (code === 0) void backendProbe.ask(shell, root, true)
      },
    })
  }

  async function search(options: SearchOptions) {
    const projectStore = useProjectStore()
    const project = projectStore.currentProject
    if (!project || !options.query.trim()) return
    if (!backendInfo.value) await detectBackend()
    if (!backendInfo.value) return

    searching.value = true
    error.value = null
    const mySeq = ++searchSeq
    try {
      const result = await searchExecute(project.shell, searchRoot(), options)
      if (mySeq !== searchSeq) return
      results.value = result.matches
      lastOptions.value = options
      truncated.value = result.truncated
    } catch (e) {
      // **失敗も seq で捨てる**（#376）。1 本目が 30 秒の `wait_with_timeout` や rg の
      // exit 2 で落ちるころには、2 本目の結果が出ていることがある。`lastOptions` まで
      // 消すと「結果をタブで開く」も何も起こさなくなる。
      if (mySeq !== searchSeq) return
      error.value = String(e)
      results.value = []
      lastOptions.value = null
    } finally {
      if (mySeq === searchSeq) searching.value = false
    }
  }

  /**
   * いま出ている結果を捨てる（プロジェクトや worktree の切り替え、範囲の変更、語を消したとき）。
   *
   * **`searching` の扱いは `stores/issues.ts` の `load` の doc が正本**（「seq を進めた者が
   * 持つ。例外は `clear()`」）。ここもその形で、`searchSeq` を進めて自分で下ろす。
   *
   * search 固有の帰結（#376）: 進めないと、捨てた直後に前の検索が返って `results` と
   * `lastOptions` を書き戻す。範囲を絞った場合は「In: そのフォルダ」の下にプロジェクト
   * 全体のヒットが並び、しかも「結果をタブで開く」が押せる、という `setScope` の doc が
   * 防ぐと書いた状態そのものになる。
   */
  function clear() {
    searchSeq++
    results.value = []
    lastOptions.value = null
    truncated.value = false
    error.value = null
    searching.value = false
  }

  const extracting = ref(false)

  /**
   * いまの結果と同じ条件で、上限を広げて検索し直し、grep の出力の形でエディタのタブに
   * 書き出す（#376）。パスはプロジェクトのルートからの相対で、`パス:行: 内容` の 1 行ずつ。
   * タブでは `Ctrl+Click` / F12 でその行のファイルへ飛べる（`lib/editorPathJump.ts`）。
   *
   * **無題のタブにする**（ファイルに書かない）。保存すれば残せるし、閉じれば消える。
   */
  async function extractToTab(): Promise<void> {
    const projectStore = useProjectStore()
    const project = projectStore.currentProject
    const options = lastOptions.value
    if (!project || !options || extracting.value) return
    extracting.value = true
    const tabStore = useTabStore()
    // **タブは先に出す**（#376）。書き出しは上限 10,000 件で rg を回し直すので、押してから
    // 数秒かかる。結果が揃ってから作る形だと、そのあいだ画面が何も変わらず、押せていない
    // ように見える。`setUntitledContent` が届いたところで中身を差し替える。
    const tabId = tabStore.addBlankEditorTab({
      title: t('search.extractTitle', { query: options.query }),
      content: `# ${t('search.extracting', { query: options.query })}\n`,
    })
    try {
      const root = projectStore.activeRoot
      const result = await searchExecute(project.shell, searchRoot(), { ...options, extract: true })
      const rel = (p: string) => relativeToBase(root, p, shellToPlatform(project.shell)) ?? p
      const header = [
        `# ${t('search.extractHeader', { query: options.query, count: String(result.matches.length) })}${scopeRel.value ? ` (${scopeRel.value})` : ''}`,
        `# ${t('search.extractHint')}`,
      ]
      if (result.truncated) header.push(`# ${t('search.extractTruncated', { max: String(result.matches.length) })}`)
      const body = result.matches.map((m) => `${rel(m.path)}:${m.line}: ${m.content}`)
      tabStore.setUntitledContent(tabId, `${[...header, '', ...body].join('\n')}\n`)
    } catch (e) {
      error.value = String(e)
      // **失敗もタブに出す**（先に出した「検索中」のまま残さない）。パネルのエラー帯は
      // 見えていないことがある（書き出しのあとはタブへ目が移っている）。
      tabStore.setUntitledContent(tabId, `# ${t('search.extractFailed')}\n# ${String(e)}\n`)
    } finally {
      extracting.value = false
    }
  }

  /** 置換を書いているあいだ（#401）。二重に押させない。 */
  const replacing = ref(false)

  /**
   * エディタで未保存のファイル（比較キー）。置換はこれらを飛ばす（#401）。ディスクに
   * 書くと、エディタには外部変更の警告が出るだけで、そのまま保存すれば置換が消える。
   *
   * **`visibleTabs` ではなく `tabs` を見る。** 保持中の別プロジェクト（#264）のタブでも、
   * 同じファイルを開いていれば同じディスクの内容を上書きしうる。
   */
  function dirtyPathKeys(): Set<string> {
    const keys = new Set<string>()
    for (const tab of useTabStore().tabs) {
      if (isUnsavedEditor(tab) && tab.path) keys.add(rootKey(tab.path))
    }
    return keys
  }

  /** 置換を書き込み、結果を知らせる（#401）。一覧をどう直すかは呼び出し側が決める。 */
  async function applyMatches(shell: ShellType, root: string, matches: SearchMatch[]): Promise<ReplaceOutcome | null> {
    const dirty = dirtyPathKeys()
    const byFile = new Map<string, ReplaceFileEdit>()
    const skippedDirty = new Set<string>()
    for (const m of matches) {
      if (!m.replace) continue
      if (dirty.has(rootKey(m.path))) {
        skippedDirty.add(m.path)
        continue
      }
      let edit = byFile.get(m.path)
      if (!edit) {
        edit = { path: m.path, lines: [] }
        byFile.set(m.path, edit)
      }
      edit.lines.push({ line: m.line, from: m.content, to: m.replace.line })
    }
    const outcome = byFile.size > 0 ? await searchReplaceApply(shell, [...byFile.values()]) : null
    await reportReplace(shell, root, outcome, [...skippedDirty])
    return outcome
  }

  async function reportReplace(
    shell: ShellType,
    root: string,
    outcome: ReplaceOutcome | null,
    skippedDirty: string[],
  ): Promise<void> {
    const rel = (p: string) => relativeToBase(root, p, shellToPlatform(shell)) ?? p
    const lines = outcome?.lines ?? 0
    const stale = outcome?.stale ?? 0
    const failed = outcome?.failed ?? []
    useStatusMessageStore().show({
      text:
        t('search.replaceDone', { count: String(lines), files: String(outcome?.files ?? 0) }) +
        (stale > 0 ? ` ${t('search.replaceStale', { count: String(stale) })}` : ''),
      variant: lines > 0 && !failed.length && !skippedDirty.length ? 'success' : 'warn',
      durationMs: 4000,
    })
    // 飛ばしたファイルはステータスバーの 1 行に収まらないので、名前を挙げて知らせる。
    const notes: string[] = []
    if (skippedDirty.length) {
      notes.push(t('search.replaceSkippedDirty', { names: skippedDirty.map(rel).join('\n') }))
    }
    if (failed.length) {
      const names = failed.map(
        (f) => `${rel(f.path)}: ${t(`search.replaceFail.${f.reason}`)}${f.detail ? ` (${f.detail})` : ''}`,
      )
      notes.push(t('search.replaceFailed', { names: names.join('\n') }))
    }
    if (notes.length) await infoDialog(notes.join('\n\n'))
  }

  /**
   * 置換の段取りの共通部。二重に押させない印と、失敗の受け取りを 1 か所に置く。
   * シェルと root は押した時点のものを渡す（待つあいだにプロジェクトを切り替えられても、
   * 頼まれた場所に書く）。
   */
  async function withReplacing(fn: (shell: ShellType, root: string) => Promise<void>): Promise<void> {
    const projectStore = useProjectStore()
    const project = projectStore.currentProject
    if (!project || replacing.value) return
    replacing.value = true
    try {
      await fn(project.shell, projectStore.activeRoot)
    } catch (e) {
      error.value = String(e)
    } finally {
      replacing.value = false
    }
  }

  /**
   * 1 行ぶんを置換する（結果の行のボタン）。**検索し直さず、その行を一覧から外す**:
   * 行を順に押していくたびにプロジェクト全体の rg を回すことになるため。
   */
  function replaceMatch(match: SearchMatch): Promise<void> {
    return withReplacing(async (shell, root) => {
      const outcome = await applyMatches(shell, root, [match])
      if (outcome?.lines) results.value = results.value.filter((m) => m !== match)
    })
  }

  /**
   * `options` の一致をすべて置換する（#401）。**パネルの結果は使わない**: あちらは
   * ファイルごと 20 件・全体 500 件で切ってあるので、書き出し（`extractToTab`）と同じ
   * 上限で検索し直してから、件数を見せて確かめる。**条件は呼び出し側が今の入力から渡す**
   * （`lastOptions` は打鍵のデバウンス中だと 1 つ前の置換文字列のまま）。書いたあとは
   * 同じ条件で検索し直し、残った一致を出す。
   */
  function replaceAll(options: SearchOptions): Promise<void> {
    const replacement = options.replacement
    if (replacement == null || !options.query.trim()) return Promise.resolve()
    return withReplacing(async (shell, root) => {
      const result = await searchExecute(shell, searchRoot(), { ...options, extract: true })
      const matches = result.matches.filter((m) => m.replace)
      if (!matches.length) return
      const files = new Set(matches.map((m) => m.path)).size
      let msg = t('search.replaceAllConfirm', {
        query: options.query,
        replacement,
        count: String(matches.length),
        files: String(files),
      })
      if (result.truncated) msg += `\n\n${t('search.replaceAllTruncated', { max: String(result.matches.length) })}`
      if (!(await confirmDialog(msg))) return
      await applyMatches(shell, root, matches)
      await search(options)
    })
  }

  return {
    scopeRel,
    setScope,
    searchRoot,
    extracting,
    extractToTab,
    replacing,
    replaceMatch,
    replaceAll,
    backend,
    backendInfo,
    ripgrepNoticeText,
    ripgrepActionLabel,
    installRipgrep,
    pendingOpen,
    requestOpen,
    resultsFor,
    results,
    truncated,
    searching,
    error,
    detectBackend,
    search,
    clear,
  }
})
