---
paths:
  - "src/lib/shortcuts.ts"
  - "src/lib/keys.ts"
  - "src/lib/editorPresetKeys.ts"
  - "src/composables/useKeyboardShortcuts.ts"
  - "src/composables/useShortcutsModal.ts"
  - "src/composables/useAppActions.ts"
  - "src/components/KeyboardShortcuts.vue"
  - "scripts/check-shortcuts.ts"
  - "docs/manual/shortcuts-and-cli.md"
---

# キーボードショートカット実装ルール

キーの割り当て表・4 つの層・プリセット・ターミナルとの取り合い。ターミナル側の実装
（`TerminalTab.vue` の `attachCustomKeyEventHandler`）は `terminal.md` から参照される。

## 層と正本

- **修飾キーの読み替えと macOS のメニューバーは `.claude/rules/platform.md` の
  「キーボードショートカット」が正本**（#254）。`Cmd` 付きのキーはネイティブメニューが
  唯一の入口で、`e.ctrlKey` の直書きは `lib/keys.ts` の `hasMod` に寄せてある。
  表示は同ファイルの `chordChips` / `chordLabel`（`Mod+W` → `⌘W` / `Ctrl+W`）を通す:
  UI に `Ctrl+` と直接書くと macOS で嘘になる
- グローバルは `composables/useKeyboardShortcuts.ts`（window の keydown）。エディタ内は CodeMirror の keymap（`EditorTab.vue`）、ターミナルは xterm の `attachCustomKeyEventHandler`、各モーダルは自前の keydown と、**4 層に分かれている**。一覧は `components/KeyboardShortcuts.vue` + `composables/useShortcutsModal.ts`、マニュアルは `docs/manual/shortcuts-and-cli.md`。**キーの割り当ての正本は `lib/shortcuts.ts` の `keyBindings`**（#254 / #261。プリセットで切り替わる computed）。グローバル層のキーを増やすときに触るのは表とマニュアルの 2 箇所で、判定・一覧の表記・macOS メニューのアクセラレータは全部そこから導出される。表に無い層（CodeMirror・xterm・画像ビューワ）のキーは実装・モーダル・マニュアルの 3 箇所を揃える
- **キーを足すときは、グローバルの表・CodeMirror 層（既定・検索・履歴・Markdown・マクロ）・`terminalFirst` の 3 か所で重なりを見る**（#369 で棚卸し済み。`Mod+F` / `Mod+H` はどちらの層でも同じ操作なので重なりではない）
- **「Pike にできること」の正本は `lib/shortcuts.ts` の `APP_ACTIONS`**（#270）。**キーの表とは別**にしてある: パレットに出したい操作のほとんどはキーを持たない（パネルを開く、git pull など）ので、chord を行にした `keyBindings` では表現できない。`AppActionId` はこの表から導出する
  - **機能を足すときはここに 1 行足す。** 実装（`useAppActions`）は `Record<AppActionId, …>` なので、足して実装を忘れると型エラーになる。パレット（`QuickOpen` の `>` モード）は `palette` を持つ行を流すだけで、**一覧を別に持たない**
  - `palette` は分類（`view` / `git` / `project` / `terminal` / `file` / `help`）。名前だけでは領域が分からないものに接頭辞を付けるためで、絞り込みの対象にも入れてある。**パレットに出さないものには付けない**（タブ移動のように、パレットを開いている時点で意味を失うもの）
  - `needsProject` を付けたものは、プロジェクトを持たないウィンドウでは出さない

## キーの比較と表記

- **`e.key` の英字は `normalizedKey`（`lib/keys.ts`）を通して比較する**。Caps Lock は `e.key` の大小を反転させるので、`'p'` のようなリテラル比較だけだと Caps 中に全滅する。グローバル・PreviewTab・DiffTab の 3 箇所が共有する
- **モーダルの `keys` は「候補コードの配列」**（`['Mod+Shift+Z', 'Mod+Y']`）。描画は `chordChips` が `+` で `<kbd>` に割り（mac は記号を 1 つに畳む）、配列の区切りに `/` を入れる。1 文字列に `/` を混ぜると `split('+')` が壊れて `Z / Ctrl` のようなチップが出る
- **素のキーを見るハンドラは修飾キーを弾く**。修飾を見ない `switch (e.key)` だと、画像タブで `Ctrl+F` が fit、`Ctrl+R` が回転になる
- **文字を大きくするキーは、日本語配列の `Ctrl+;` でも効く（#369）**。`+` の chord だけ、物理キーを Windows の仮想キーコード（`VK_OEM_PLUS`＝187。US は `=` のキー、JIS は `;+` のキー）でも照合する（`matchParsedChord`）。Chrome や Office と同じ作法で、`e.code` では US の `;` と区別できないので `keyCode` を使っている
- 文字の大きさ（#260、`Mod+=` / `Mod++` / `Mod+Shift++` / `Mod+-` / `Mod+0`）。
  **大きくする側の chord が 3 つあるのは配列の都合**で、`matchChord` が「chord に書いていない
  修飾キーは押されていない」ことを求めるため、`Mod++` は Shift 無しで `+` が出る numpad にしか
  一致しない。US の `Ctrl+Shift+=` と JIS の `Ctrl+Shift+;` は `Mod+Shift++` が受ける。**見ているものに効かせる**（エディタのタブならエディタのフォント、それ以外はターミナル）: 設定画面まで行かずに変えられることが目的なので、今フォーカスしている面が対象で自然。ターミナルで押したときに何も起きないのでは意味が無いので、xterm より先に取る
- WebView リロード抑止: Ctrl+R / Ctrl+Shift+R / F5 を `preventDefault`。誤操作でのリロード（全 PTY セッション破棄＝実質再起動）を防ぐ。ターミナルの Ctrl+R（bash 逆方向検索）は xterm がイベントを消費するため影響なし

## CodeMirror 層

- **CodeMirror 標準の redo は `Mod-y` と Linux 限定の `Ctrl-Shift-z`**。Windows が主対象なので `Mod-Shift-z` を明示的に足してある（足さないと案内している `Ctrl+Shift+Z` が効かない）
- **`Ctrl+H`（置換）は `searchKeymap` に無い**。`editorSearch.ts` の `openReplace` が `openSearchPanel` + `revealReplace` エフェクトで置換行を開き、`editorPresetKeys.ts` の `presetKeymap()` がそれをプリセットの置換 chord（`editorChords.replace`）に割り当てる
- **CodeMirror のキー名は 1 文字を小文字にする**（`lib/keys.ts` の `toCodeMirrorKey`）。あちらは修飾キーだけ正規化してキー名は `e.key` と素で比較するので、`Mod-H` と書くと Shift を押したときにしか一致しない
- **CodeMirror の既定と衝突する chord は塞ぐ**（`lib/editorPresetKeys.ts` の `presetKeymap`）。
  `Alt+←→` は `defaultKeymap` の `cursorSyntaxLeft/Right` と同じキーで、CodeMirror は
  `stopPropagation: true` を宣言した binding でしか伝播を止めないため、放っておくと
  **カーソルが動いたうえでタブも切り替わる**

## ターミナルとの取り合い（#224）

- **ターミナルにフォーカスがあるとき、グローバルショートカットは既定で 1 つも効かない**。xterm は PTY へ送るキーで `preventDefault` だけでなく **`stopPropagation` も呼ぶ**（`CoreBrowserTerminal.cancel(ev, true)`。`_keyDown` が `evaluateKeyboardEvent` の結果を PTY へ流したあとに必ず通る）。よって window の keydown ハンドラには **Ctrl+英字も `Tab` も `PageUp/Down` も `F1` も届かない**
  - **#224 の issue 本文にある「両方に届く」は誤り**（コードの読みだけで書かれたもの）。実際はシェルが全部取る。`Ctrl+Shift+P` と `Ctrl+,` が効くのは、xterm がそれらに制御コードを割り当てず `cancel` を通らないため
- 例外を作る側は**割り当ての表の行に付けた印**（`lib/shortcuts.ts` の `terminalFirst`。タブの出し入れ・文字の大きさ・分割など）。判定は同ファイルの `pikeTakesTerminalKey` で、`TerminalTab.vue` の `attachCustomKeyEventHandler` がそれで **`false` を返す**と `_keyDown` が即 return するので、PTY へも流れず `cancel` も通らず window まで伝わる。**`stopPropagation` や `preventDefault` を足す方向では直らない**（xterm 本体はこのハンドラの後に走り、そこで両方呼ぶ）
  - **印を行に付けてあるのは、プリセット（#261）で chord が変わっても追従させるため。** キー名の集合を別に持つと、IDEA 互換に切り替えた瞬間に「シェルへ返す一覧」だけが VSCode 互換のまま残る。Windows の IDEA では `Ctrl+W` と `Ctrl+T` がシェルへ戻り、代わりに `Ctrl+F4` と `Alt+←→` を Pike が取る（mac の IDEA は Cmd 側のキーマップなので、この入れ替わりが起きない。#280）
  - **`attachCustomKeyEventHandler` は Alt も調停に通す**（#261）。Windows の IDEA 互換がタブ移動を `Alt+←→`、新規ターミナルを `Alt+F12` に置くので、Alt を無条件でシェルへ渡すとそれらが一度も発火しない。VSCode 互換では Alt の chord に `terminalFirst` が無いため、素通しの挙動は変わらない
- **`Ctrl+W` だけは代替画面（`inAltScreen`）のあいだシェルへ返す**（行の `altScreenShell`）。vim のウィンドウ操作の prefix なので、奪うと `Ctrl+W s` 等が打てないうえタブが閉じる。素のシェル（readline の unix-werase）では Pike 優先のままにするため、判定はキー単位ではなく代替画面の有無で行う。IDEA 互換では閉じるキーが Windows で `Ctrl+F4`、mac で `⌘W` になり、どちらも vim と衝突しないので、この印は付けない
- **`Ctrl+F`（検索）も同じ 2 つの印を持つ**。readline の forward-char より、エディタ・diff・プレビューと揃うほうを採った（VSCode のターミナルと同じ）。vim / less の `Ctrl+F` は 1 画面進むので代替画面では返す。**受けるのは window の keydown**（`onFindKeydown`。diff タブ・プレビューと同じ）で、xterm のハンドラに特例を足さない: Windows / Linux は表の行がシェルへ渡すかを決め、mac の `⌘F` は xterm が PTY へ送らず cancel もしないので素通しで届く
- readline が使う `Ctrl+K`（行末まで削除）・`Ctrl+P` / `Ctrl+N`（履歴）・`Ctrl+O`（operate-and-get-next）と、TUI アプリの `F1` はシェルに残す（`terminalFirst` を付けない）。**取り合いの判定を割り当ての表と同じファイルに置く**のは、キーを足す人が「ターミナルでは効かない」ことに気付けるようにするため。readline の `Ctrl+A/E/U/D/Y` は未使用のまま残っている
  - 変えたら 3 箇所（表の `terminalFirst`・`KeyboardShortcuts.vue` のターミナル節・`docs/manual/shortcuts-and-cli.md`）を揃える

## マニュアルとの照合

- **マニュアルの「プリセット別の早見表」は `just check-shortcuts` が実装と突き合わせる（#280）**。`scripts/check-shortcuts.ts` が `src/lib/` を実際に import し、`bindingsFor(preset, mac)` と `chordLabel(chord, mac)` で 4 通り（プリセット × プラットフォーム）を作って照合するので、**Windows で作業していても mac 側のずれが CI で落ちる**。正規表現でソースを読まないのは、`Mod` の解決・プリセットの重ね合わせ・`macChords` の差し替えという組み立てを写す羽目になるため。この 2 つが `mac` を引数で受けるのはそのためで、アプリの中からは既定（`isMacHost`）のまま呼ぶ
  - 見るのは**実装 → マニュアルの一方向**（表に無い chord があれば落ちる）。逆を見ないのは、早見表が CodeMirror 層のキー（保存・検索）も併記しているため。アクションを持たない行（`Mod+S` / `Mod+F` / `Mod+H`。ブラウザの既定を潰すだけ）は照合の対象外

## プリセット（#261 / #280）

- `SHORTCUT_PRESETS`（`vscode` / `idea`）。既定の VSCode 互換は元からある割り当てそのもので、名前を付けただけ。IDEA 互換は `IDEA_OVERRIDES` に**差分だけ**を書き、`VSCODE_BINDINGS` に重ねて作る（表を複製すると片方にだけ行を足したとき黙ってずれる）
- **OS 差は行の `macChords` で持つ（#280）。** `Mod`（mac は Cmd、他は Ctrl）は VSCode のように「Ctrl ↔ Cmd の機械的な読み替え」で出来ているキーマップにしか通用しない。IDEA は Windows / Linux 用と macOS 用に別のキーマップを配っていて、Go to File が `Ctrl+Shift+N` と `⇧⌘O` のようにキーそのものが違う。**表を OS ごとに 2 つ持つ形は採らない**: 行を片方にだけ足す事故が起き、しかも症状は mac でしか出ない（CI の macOS ジョブは Rust の cfg のためのもので、ここは走らない）。行ごとに両 OS が並んでいれば見落としが目で分かる。**mac だけの割り当ては空の `chords` と組にする**（`⌘Q`）
- **OS を解決するのは `bindingsFor` の 1 箇所だけ**（`macChords` があればそれを `chords` に差し替える）。読む側（照合・一覧の表記・macOS のメニュー・ターミナルとの取り合い）はすべて解決後の `chords` を見る。OS ごとのフラグを行に足して読む側で濾す形にすると、濾し忘れた読み手に他 OS のキーが見える
- **VSCode 互換にも OS 差がある**（#280）: `nextEditor` は mac だけ `⌘⇧]` で、Windows / Linux は `Ctrl+PageDown`。`Mod+Shift+]` は `macChords` にだけ入れる。新規ターミナルは VSCode の `Ctrl+Shift+` \` を足しつつ `Mod+T` も残す（あちらは配列で `e.key` が変わるうえ、JIS では打ちにくい。VSCode の `Ctrl+T` に当たる機能は Pike に無いので取り合わない）
- **VSCode の chord（2 打鍵）には揃えられない**。`Ctrl+K Ctrl+S`（ショートカット一覧）と `Ctrl+K Ctrl+O`（フォルダを開く）がそれで、Pike は prefix 状態を持たないため 1 打鍵にしてある（一覧は `Mod+Shift+/`、mac は `⌘K`。#369）。実装するなら 4 層すべてで prefix の調停を書くことになる（「任意の再割り当ては採らない」のと同じ理由）
- 設定は `shortcutPreset`（同期対象。好みはマシンに依存しない）。**`lib/shortcuts.ts` はストアを import できない**（`stores/project.ts` から import されるので循環する）ため、設定ストア側が `setShortcutPreset` で値を流し込む。`immediate: true` が要る（無いと起動直後の 1 回だけ既定のキーで動く）
- 追従させる先が 4 つある: グローバル（`keyBindings` を読むので自動）・**CodeMirror のキー**（`lib/editorPresetKeys.ts` の `presetKeymap()` と `EditorTab.vue` の `presetKeymapCompartment`。開いているタブに反映するには張り直しが要る）・**xterm の取り合い**（前述の `terminalFirst`）・**macOS のメニュー**（`stores/project.ts` の watcher のキーに `shortcutPreset` を入れてある）
- **矢印の chord は `Alt+ArrowLeft` と書く**（`e.key` に合わせる）。表示だけ `chordChips` が `←` に読み替える
- **macOS では IDEA 互換の `Alt+F12`（新規ターミナル）が届かない。** `terminalClaims` が mac では
  `Ctrl` を明示した chord だけに絞るのでターミナル上では取らず、そもそも `F12` は音量キーに
  食われる。加えて `primaryChord` は `Mod` を含む chord しか選ばないので、この項目だけ
  メニューにアクセラレータが出ない（項目自体は出るので、メニューからは開ける）
- IDEA 互換に入れていないものにも理由がある。`projectSwitcher` と `openDirectory` は IDEA に相当する既定キーが無く、`newFile` の `Ctrl+N` は IDEA では Go to Class だが Pike にクラス検索が無いので取り合いにならない。タブ移動は `Ctrl+Tab` 系も残す（Windows の `Alt+←→` は代替画面で矢印を使う TUI と重なるので、逃げ道が要る）
