---
paths:
  - "src-tauri/src/settings_sync.rs"
  - "src-tauri/src/settings_gist.rs"
  - "src/stores/sync.ts"
  - "src/stores/project.ts"
  - "src/lib/sync*.ts"
  - "src/lib/gitRemote.ts"
  - "src/components/tabs/SyncConflictsTab.vue"
---

# 設定の同期 実装ルール

設定とプロジェクト一覧の同期（#164 / #403）。プロジェクトそのものの管理は `project.md`。

- **設定の同期（#403）**: 実体は `stores/sync.ts`（調停役）・`lib/syncMerge.ts`（3-way マージ）・`lib/syncFormat.ts`（ファイルとの行き来）。判断の正本はその 3 つの doc。ここには規範だけ置く
  - **同期するのは main ウィンドウだけ**。他のウィンドウは状態を受け取り、依頼を送るだけ（`pike://sync-state` / `pike://sync-command`）。ウィンドウごとに書くと、書き込みどうしが競合する
  - **前回同期した時点の内容（baseline）を手元に覚え、項目ごとに 3-way で比べる**（`pike:sync-base:<同期先>`、マシンごと）。丸ごと上書きや、読みと書きで規則が違う形だと、最後に同期したマシンが他のマシンの変更を消す
  - **衝突は自動で決めない**。手元とリモートをそれぞれの値のまま残し、baseline も前のままにする（`nextBaseline`）ので、次の同期でも同じ衝突が出る。保留を別に覚えない
  - **同期先は 2 つで、マージは共通**（`stores/sync.ts` の `SyncBackend`＝読む・版を確かめる・書く）
    - **固定のパスは「今すぐ同期」のときだけ動く**。起動時と変更のたびには動かない
    - **GitHub Gist は自動で同期する**（起動時・変更の数秒後・前に出たとき）。読み書きは `settings_gist.rs` が `gh api` で行い、本文は標準入力で渡す（`cmd /C` の引用と長さの上限を避ける）。どの `gh` を使うか（ホストか WSL の distro か）は利用者が選ぶ
    - **同期の前にプロジェクトの一覧が読み込み済みであることを確かめる**。起動直後の自動の同期で一覧が空のまま比べると、「全部消した」と読まれて他の PC からも消える
    - **同期で手元を書き換えた直後の変更は、自動の同期の契機にしない**（数えると同期のたびにもう 1 回走る）
    - **Gist は書いた直後の読み込みが古い版を返しうる**。このマシンが最後に書いた版の時刻（`pike:sync-written:<同期先>`）より前の版を読んだら同期しない。マージすると、書いたばかりの値を「リモートが戻した」と読んで手元を巻き戻す
    - **前に出したときの間隔は、成功した時刻ではなく試みた時刻で測る**（`gh` がログインしていないあいだ、前に出すたびに `gh` を起こし直さない）。main 以外のウィンドウが前に出たことも main へ知らせる
    - **同期の直前に一覧を読み直すのは、まだ一度も読んでいないときだけ**（`ensureListsLoaded`）。読み直すと `projects` の要素が差し替わり、`currentProject` とずれる。反映（`applySyncedProjects`）もディスクの写しを別に読むだけで、`projects` には代入しない
  - **同期先と同期する種類はマシンごとで、持ち主は sync ストア**（`pike:sync-path` / `pike:sync-target` / `pike:sync-categories`）。どのウィンドウからでも変えられるが、書いたら main に読み直させて配る。各ウィンドウが自分で読んだ値を持つ形だと、他のウィンドウで変えた同期先に main が気付かない
  - **プロジェクトの新しい共有フィールドは 4 か所に足す**: `SyncedProject`（型）、`toSynced`（出す）、`SYNCED_FIELDS`（`applySyncedProjects` が変わったものをそろえる）、`applySyncedProjects` の中の `addProject`（作るとき）。衝突の画面に出す名前は i18n の `sync.field.<フィールド名>`（無ければフィールド名のまま出る）。置き場所（`platform` / `path`）は作るときにだけ使い、あとから比べない（`CREATE_ONLY_FIELDS`）
  - **手元へは、マージに使った手元の値から変わったものだけを反映する**（`applySyncedSettings` に渡すのは変わったキーだけ、`applySyncedProjects` は `before` と比べる）。結果を丸ごと当てると、同期ファイルの読み込みを待つあいだに利用者が変えたものが開始時点の値に巻き戻る
  - **手元に無いプロジェクトは 2 通りに分ける**: このマシンで消したもの（非表示の記録）は削除として伝え、それ以外（base の外で作れない、別のマシンが登録したもの）は「追っていない」として baseline のまま据え置く（`mergeSyncItems` の doc）。後者を削除と読むと、同期のたびにファイルから消す
    - **削除は常に全端末へ伝える**。「このマシンでだけ隠す」という区別は持たない（分かりにくいので 1 つにした）。**古い記録も削除として伝わる**（利用者の判断。アップデート後の最初の同期で他の端末からも消える）。削除の記録そのものは残す: 初めての同期（baseline が無い）で「消した」と分かるのと、別の id で登録された同じリポジトリを作り直さないために要る（`planSyncedCreate`）
    - 消したものを戻す道は、衝突の画面で「残す」を選ぶか、インポートで取り込むか、登録し直すこと。どれも記録を外してから作る
    - 手元にあっても base の外にある（同期しない）プロジェクトには、同期の値を当てない
  - **同期で remote URL が変わったら、手元のリポジトリの origin もそろえる**（`alignOrigins` → `git_set_origin`）。**確認は挟まず、書き方（ssh / https）の違いもそろえる**（利用者の判断）。端末ごとに書き方がばらけると、各端末が自分の origin を記録し直す（`stores/git.ts` の `loadRemoteUrl`）たびに同期で衝突する
    - **差し替えるのは同じリポジトリの書き方違いだけ**（`lib/gitRemote.ts` の `isRespelling`）。fork と upstream のように別のリポジトリを指していたら触らない: 確認なしに差し替えると、次の push が別のリポジトリへ飛ぶ。判定をフロントに置くのは、正規化がフロントにしか無いため（Rust は差し替えるだけ）
    - **衝突の出どころ（`stores/git.ts` の `loadRemoteUrl`）でも同じ判定を使う**。プロジェクトを開いたとき手元の origin が記録の書き方違いなら、記録を書き換えずに手元の origin を記録へそろえる。記録を書き換えると、各端末が自分の書き方を同期に流して衝突する。同期の側（`alignOrigins`）だけでは、同期で値が変わらなかったプロジェクトが直らない
    - 今の origin の読み取りは `gitRemoteUrls` で distro ごとにまとめる（`byProbeShell`。`backfillRemotes` と同じ形）
    - origin が無いディレクトリには足さない（まだ clone していないものに勝手にリモートを生やさない）。URL は位置引数に渡るので、`-` で始まるものと改行を含むものは Rust で弾く
    - 対象はその同期で `remoteUrl` が変わったものだけ（`SyncApplyResult.remoteChanged`）。毎回全プロジェクトの origin を聞くと、WSL では 1 件ごとに `wsl.exe` が起きる
    - **origin をそろえる処理は sync ストアに置く**（`applySyncedProjects` は変わったものを返すだけ）。project ストアから git ストアを読むと循環する。開いているプロジェクトなら `loadRemoteUrl` で読み直す（ステータスバーのリンクが古いまま残る）
  - **エクスポート / インポートは同期先の外の経路**。書き出しは同期する種類の選択に依らず全部、取り込みは `importSyncItems`（`lib/syncFormat.ts`）が手元と違う項目を並べ、衝突の画面（`SyncConflictsTab.vue` を `sync-import` の種別で開く）で選んだものだけを当てる。規則の正本は `importSyncItems` の doc
    - **main に集めない**（読んだウィンドウで選んで当てるだけ）。そのために `project_create` も `project_updated` を送り、`applyExternalUpdate` は知らない id を一覧に足す（一覧を読み込み済みのウィンドウだけ）。送らないと、main 以外で作ったプロジェクトが main の一覧に入らず、同期先へ出ない。当てるのは同期と同じ `applyLocal` で、変わったものだけを当てる規則も共有する
    - **「自分の反映」の印（`appliedAt`）は同期（`syncOnce`）だけが付ける**。`applyLocal` の中に置くと、取り込みまで自動の同期の契機から外れ、main で取り込んだ変更だけが同期先に出ない
    - **手元で作られるプロジェクトかの判定は `planSyncedCreate` の 1 つ**（反映と、インポートの一覧の `creatableSyncedIds` が読む）。一覧に「取り込める」と出たものが黙って作られない、を防ぐ
  - **この版の Pike が知らない設定のキーも消さない**（新しい版が書いたもの）。ファイルの形を #164 のまま（平らな設定のキー＋`projects`＋`groups`）にしているのも、古い版と混在したときに互いの書き込みで項目が消えないため
- **削除の記録は id だけでは足りない（#164）**: 同期ファイルは 1 つのリポジトリに対して複数の id を持ちうる（各マシンが別々に登録すると別 id になる）。削除の記録（`DeletedProject`）は `root` と `remoteUrl` も持ち、同期の反映は id・解決後の root・正規化した origin の 3 つで照合する。id だけで照合すると、手元のコピーを削除したとき兄弟エントリが「まだ知らないプロジェクト」として古い名前・色/アイコン無しで作り直される
  - **照合は `planSyncedCreate` の中で重複ガード（`localIdentities` の鍵）と並べて組み立てる**: 「同じプロジェクトか」の判定軸を増やしたとき、片方だけ直すと無言で複製か復活が出る
  - root の比較キーは `lib/projectPaths.ts` の `rootKey`（区切りの正規化＋末尾スラッシュ除去＋小文字化。`relativeToBase` と違い WSL でも大小を無視する＝「同じディレクトリを登録済みか」の判定なので）
  - origin の比較は `lib/gitRemote.ts` の `normalizeRemoteUrl` を通すこと: 同じリポジトリが `git@host:owner/repo.git` と `https://host/owner/repo` の両方の形でファイルに入るため、生の文字列比較では重複ガードが素通りする
  - root も origin も持たない古い削除の記録には、この照合は効かない
- **グループ一覧の broadcast が無いと、同期ファイルへ古いグループ一覧が出る**（経路は `project.md` のグループの節）
