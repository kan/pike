import {
  type ComputedRef,
  computed,
  type InjectionKey,
  inject,
  onScopeDispose,
  provide,
  type Ref,
  reactive,
  ref,
  toRaw,
} from 'vue'
import { t } from '../i18n'
import { findRanges } from '../lib/diffSearch'

/**
 * 設定画面の絞り込み（#314）。VS Code の設定画面と同じく、上部の入力欄で項目名と説明文を
 * 絞り込む。
 *
 * **「項目 → 所属セクション・i18n キー」の表は持たない。** 表の正本は設定画面の
 * テンプレートそのもの（`SettingSection` / `SettingGroup` / `SettingItem` の props）で、
 * 各部品が setup で自分を登録する。別に表を持つと、同じ i18n キーが `t()` を呼ぶ側と
 * 表の側の 2 箇所に出て、**片方だけ直したときに「名前は変わったのに検索に当たらない」**
 * という形でずれる（`check-docs` はキーの実在しか見ないので検出できない）。選択肢の
 * ラベルも同じ理由で、描く側（`SettingToggle`）が `addKeys` で自分から載せる。
 *
 * **一致は i18n の値に対して行う。** キー名（`settings.wordWrap`）ではなく、いま表示して
 * いる言語の文言に当てる。日本語 UI で `wordWrap` を引けなくなるが、画面に出ていない
 * 文字列で引けるほうが説明しにくい。
 *
 * **登録は setup で行い、`v-if` は各部品が自分の中で使う。** 部品の側で `v-if` を書くと
 * （＝親が `v-if` で部品ごと外すと）、絞り込みで消えた項目の登録まで消えて「消えたから
 * 節が空になり、節が出るので項目が戻る」という往復になる。`v-if` を部品のルート要素に
 * 置けば、コンポーネント自体はマウントされたまま残る。
 */

/** 一致部分で切り分けたテキスト（`<mark>` を当てる単位）。 */
export interface TextPart {
  text: string
  hit: boolean
}

interface ItemEntry {
  section: string
  group: string | null
  /** 項目名・説明文・選択肢のラベルの i18n キー。 */
  keys: string[]
}

export interface SettingsSearch {
  query: Ref<string>
  /** 1 つでも出ているか（「該当なし」の判定）。 */
  hasResults: ComputedRef<boolean>
  addSection(id: string, titleKey: string): void
  /** 小見出しを登録し、その id を返す（`SettingItem` が自分の所属として使う）。 */
  addGroup(titleKey: string): string
  addItem(entry: ItemEntry): void
  /** 項目の検索語を足す（選択肢を描く子が、自分のラベルを載せるのに使う）。 */
  addKeys(entry: ItemEntry, keys: string[]): void
  sectionVisible(id: string): boolean
  groupVisible(id: string): boolean
  itemVisible(entry: ItemEntry): boolean
  split(text: string): TextPart[]
}

const KEY: InjectionKey<SettingsSearch> = Symbol('settings-search')

/** 一致を見る文字列。**キー名ではなく、いま表示している言語の値**を並べる。 */
function textOf(keys: string[]): string {
  return keys
    .map((k) => t(k))
    .join(' ')
    .toLowerCase()
}

function hit(terms: string[], keys: string[]): boolean {
  const text = textOf(keys)
  return terms.every((q) => text.includes(q))
}

function createSettingsSearch(): SettingsSearch {
  const query = ref('')
  // **3 つとも reactive にしておく。** 登録は子の setup（＝親の描画のあと）で起きるので、
  // 素の Map にすると、あとから増えた節や小見出しが `result` の再計算に入らない。
  const sections = reactive(new Map<string, string>())
  const groups = reactive(new Map<string, string>())
  const items = ref<ItemEntry[]>([])
  let groupSeq = 0

  // 空白区切りは AND（「エディタ 折り返し」で絞れる）。
  const terms = computed(() =>
    query.value
      .toLowerCase()
      .split(/\s+/)
      .filter((s) => s !== ''),
  )
  const active = computed(() => terms.value.length > 0)

  /**
   * 項目が持つ文言。**自分の分だけでなく、所属する節と小見出しの見出しも含める。**
   * 語をすべて含む項目だけを残す（AND）ので、含めないと「エディタ 折り返し」のように
   * **節で範囲を絞ってから語を足す**引き方が 1 件も当たらない（節の見出しに「折り返し」は
   * 無く、項目の側に「エディタ」は無い）。
   *
   * これで「節の名前だけを入れたらその中身が全部出る」も同じ規則から出る（その節の項目は
   * どれも節の見出しを持っている）ので、見出しの一致を別に持たなくてよい。
   */
  function keysOf(entry: ItemEntry): string[] {
    const keys = [...entry.keys]
    const section = sections.get(entry.section)
    if (section) keys.push(section)
    const group = entry.group ? groups.get(entry.group) : undefined
    if (group) keys.push(group)
    return keys
  }

  /**
   * 出すものを 1 回で決める。**項目まで含めて 1 つの走査に閉じる**: 各項目が自分で
   * 判定し直す形にすると、「一致とは何か」を触る先が 2 つになる。
   */
  const result = computed(() => {
    const openItems = new Set<ItemEntry>()
    const openSections = new Set<string>()
    const openGroups = new Set<string>()
    const qs = terms.value
    if (qs.length > 0) {
      for (const e of items.value) {
        if (!hit(qs, keysOf(e))) continue
        // **`toRaw` を通すこと。** `items` は deep reactive なので、ここで回ってくるのは
        // proxy だが、`itemVisible` に渡されるのは `SettingItem` が持つ生のオブジェクト。
        // そのまま入れると `Set.has` が常に false になり、**当たった項目が 1 つも出ない**
        // まま節と小見出しだけが出る。
        openItems.add(toRaw(e))
        openSections.add(e.section)
        if (e.group) openGroups.add(e.group)
      }
    }
    return { openItems, openSections, openGroups }
  })

  return {
    query,
    hasResults: computed(() => !active.value || result.value.openSections.size > 0),
    addSection(id, titleKey) {
      sections.set(id, titleKey)
      onScopeDispose(() => sections.delete(id))
    },
    addGroup(titleKey) {
      // 同じ小見出し（「表示」）を別の節で使うので、id は連番で振る。
      const id = `g${++groupSeq}`
      groups.set(id, titleKey)
      onScopeDispose(() => groups.delete(id))
      return id
    },
    addItem(entry) {
      items.value.push(entry)
      onScopeDispose(() => {
        const i = items.value.indexOf(entry)
        if (i >= 0) items.value.splice(i, 1)
      })
    },
    addKeys(entry, keys) {
      // **`entry.keys` を直接触らない。** `items` は deep reactive なので、生のオブジェクト
      // を書き換えても `result` は気付かない。
      const i = items.value.indexOf(entry)
      if (i >= 0) items.value[i].keys.push(...keys)
    },
    // `v-show` を外す（＝絞り込んでいない）ときは全部出す。
    sectionVisible: (id) => !active.value || result.value.openSections.has(id),
    groupVisible: (id) => !active.value || result.value.openGroups.has(id),
    itemVisible: (entry) => !active.value || result.value.openItems.has(toRaw(entry)),
    split(text) {
      const qs = terms.value
      if (qs.length === 0) return [{ text, hit: false }]
      // 位置の列挙は diff の検索（#176）と同じもの。**自分で書かないこと**: 進める幅を
      // 1 文字にすると、重なった一致を数えて畳む側の入力が変わる。
      const ranges = qs.flatMap((q) => findRanges(text, q, false))
      if (ranges.length === 0) return [{ text, hit: false }]
      ranges.sort((a, b) => a[0] - b[0])
      const parts: TextPart[] = []
      let pos = 0
      for (const [s, e] of ranges) {
        if (e <= pos) continue // 語どうしが重なったぶん
        const start = Math.max(s, pos)
        if (start > pos) parts.push({ text: text.slice(pos, start), hit: false })
        parts.push({ text: text.slice(start, e), hit: true })
        pos = e
      }
      if (pos < text.length) parts.push({ text: text.slice(pos), hit: false })
      return parts
    },
  }
}

export function provideSettingsSearch(): SettingsSearch {
  const search = createSettingsSearch()
  provide(KEY, search)
  return search
}

export function useSettingsSearch(): SettingsSearch {
  const search = inject(KEY, null)
  if (!search) throw new Error('useSettingsSearch: 設定画面の外で呼ばれた')
  return search
}

/** 自分がどの節・どの小見出しの下にいるか（`SettingItem` が登録に使う）。 */
export const SETTINGS_SECTION: InjectionKey<string> = Symbol('settings-section')
export const SETTINGS_GROUP: InjectionKey<string> = Symbol('settings-group')

/**
 * 自分を囲む項目に検索語を足す口（`SettingItem` が配り、`SettingToggle` が使う）。
 * 項目の中でラベルを描くのは子なので、キーを親のテンプレートに書き写さずに済ませる。
 */
export const SETTINGS_ADD_KEYS: InjectionKey<(keys: string[]) => void> = Symbol('settings-add-keys')
