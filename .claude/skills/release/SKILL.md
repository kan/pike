---
name: release
description: Pike の新しいバージョンをリリースする（dependabot の取り込み → rg サイドカー確認 → tagpr のリリース PR の確認 → CI でスクリーンショット → リリース PR のマージでタグとビルド → ドラフトの公開）。「リリースして」「vX.Y.Z を出して」と頼まれたときに使う。
---

# Pike のリリース手順

**リリースの依頼は end-to-end の依頼。** リリース PR の確認と調整・スクリーンショットの撮影・
リリース PR のマージ・Release の完了待ち・ドラフトの確認と公開までを Claude が実行する。
通常の PR 運用と異なり、リリース PR のマージの個別確認は要らない。CI の完了待ちは
バックグラウンドの watch で行う。以下を順番に実行する。

**bump・lockfile・CHANGELOG の見出しとリンク・クレジットは tagpr が作るリリース PR に載る**（#529）。
main に push があるたびに `tagpr.yml` がリリース PR を作り直し、
`scripts/release-prepare.mjs` が中身をそろえる。仕組みと理由は `.claude/rules/build.md` の
「リリース PR（tagpr）」。**版の表記を手で書き換えない。リリース PR のブランチへ手でコミットしない**
（画像のコミットは手順 4 のワークフローが積む）。

### 0. dependabot の PR を取り込む

**リリース PR をマージする前に、open な dependabot の PR を片付ける。** 出荷済みの版に後から依存の
更新は混ぜられないので、残したまま出すと次のリリースまで届かない。取り込み方は CLAUDE.md の
「コミット & PR 運用ルール」のとおり（ロックファイルを共有するので 1 件ずつマージせず、1 本の
ブランチにまとめて取り込んで PR にする）。`CHANGELOG.md` の `## [Unreleased]` の `### Changes` に
依存の更新を 1 行足す。**クレジットは作り直さない**（リリース PR が作り直す）。

### 1. rg サイドカーのバージョン確認

`scripts/download-rg.sh` の `VERSION` を [ripgrep のリリース](https://github.com/BurntSushi/ripgrep/releases)
と突き合わせ、新しい版が出ていれば上げる PR を作る（`chore: rg サイドカーを X.Y.Z に上げる`）。
手元で試すときは**手元のバイナリを消してから取り直す**:

```bash
rm -f src-tauri/binaries/rg-*
just fetch-rg
```

**この確認を自動でやる仕組みは無い。** dependabot が見るのは npm / cargo / github-actions の
3 つで、シェルスクリプトの中のバージョン文字列は対象外。CI も同じスクリプトを呼ぶだけなので、
`VERSION` が古いままなら CI が作る成果物も古いままになる（毎回ダウンロードすることと、
毎回最新を取ることは別）。消してから取り直すのは、スクリプトがファイルの有無しか見ないため
（詳細は `.claude/rules/platform.md`）。クレジットに載る ripgrep の版とライセンスは、リリース PR が
作り直す。

0 と 1 の PR をマージしたら、tagpr がリリース PR を作り直す。次へ進む前に、その run の完了を待つ。

### 2. リリース PR を確かめる

```bash
gh pr list --label tagpr --state open --json number,title,headRefName
gh run list --workflow tagpr.yml --branch main -L 3
```

**ブランチ名は `tagpr-from-v<前回の版>`**（v0.69.0 を出すリリース PR なら `tagpr-from-v0.68.0`）。
以下の `<ブランチ>` は上の一覧に出るブランチ名を使う。

**最新の tagpr の run が success であること。** 落ちた run はリリース PR を draft にする（ready に戻す
条件は `scripts/tagpr/README.md` の「The tagpr workflow」）。失敗していたら、run の注釈（`postVersionCommand` の
失敗）を読む。多いのは `## [Unreleased]` が空のとき（リリースの直後は毎回そうなる）。直す PR を main に
マージすると作り直される。`credits` ジョブ（クレジットの生成。ネットワークに出る）が落ちていたら、
一時的な失敗ならその run を再実行する。「タグより新しい版の節がある」で落ちていたら、手順 6 の
「cancelled になっていたら」を見る。

**版が正しいか**（PR のタイトルの `vX.Y.Z`）。機能の PR（`enhancement`）があれば minor、無ければ patch に
なる。違うときは `tauri.conf.json` を手で直さず、ラベルを付けて作り直す:

```bash
gh pr edit <番号> --add-label tagpr:minor
gh workflow run tagpr.yml --ref main
```

Files changed が、5 つの版の表記（`tauri.conf.json` / `package.json` / `Cargo.toml` / 2 つの lockfile）、
`src/assets/credits.json`、`CHANGELOG.md` の見出しとリンク（版の節の見出し、その上に戻した空の
`## [Unreleased]`、末尾の `releases/tag` のリンク）だけであることを確かめる。

**リリース PR にも Copilot のレビューが付く**（ルールセットの条件が PR の向き先でしか絞れず、
元のブランチで外せないため）。差分は上の生成物だけで、コードの中身は機能の PR で見てあるので、
指摘は読むだけにする。版の食い違いのような生成物の誤りを指していたら、手で直さずに原因
（`scripts/release-prepare.mjs` か main の CHANGELOG）を直す PR を作る。

### 3. CHANGELOG の節を確かめる

**この節がそのままリリースノートになる。** マージすると `draft` ジョブが `scripts/release-notes.mjs` で
節を抜き出してドラフトの本文にし、`updater-json` がそれを `latest.json` の `notes` に写す。
**`latest.json` の `notes` はタグの時点で決まり、公開後は差し替えられない**ので、マージの前に仕上げる。

```bash
git fetch origin
git show origin/<ブランチ>:CHANGELOG.md | sed -n '1,60p'
git log --oneline <前回のタグ>..origin/main
```

**記憶で照合しないこと。** `git log` の各コミット（PR）が節に載っているか、利用者に届かない変更
（CI・開発ノートなど）だけが抜けているかを見る。載っていない利用者向けの変更や、言い回しの直しは、
**main への PR で `## [Unreleased]` を直す**（リリース PR のブランチでは見出しが書き換わっているので、
そこへコミットすると tagpr の作り直しとぶつかる）。マージ後に作り直されたリリース PR で見直す。
**公開してからでは直しても既読の人には届かない。** 校正は CLAUDE.md の「ドキュメント校正ルール」
（各 PR で済ませてあるが、節全体のつながりもここで見る）。

### 4. スクリーンショットの撮り直し

**マイナー bump のリリースでは必ず撮り直す。** 画像には StatusBar のバージョンが写るので、
**bump 済みのリリース PR のブランチで撮る**（#506。詳細は `.claude/rules/build.md`）。
**CHANGELOG 以外の PR を main にマージし終えてから起動する**（UI が変わると撮り直しになる）。

```bash
gh workflow run screenshots.yml --ref <ブランチ>   # 既定で commit: true。起動した run の URL を出す
gh run watch <URL の末尾の run id> --exit-status        # 12 分ほど
```

**run の id は `gh workflow run` が出す URL から取る。** 起動の直後に `gh run list -L 1` で引くと、
新しい run が一覧に現れる前で、前回の完了済みの run を拾うことがある（`watch` がすぐ成功で終わる）。

ジョブは撮影 → `just e2e-sync` → 差分があればリリース PR のブランチへ
`docs: vX.Y.Z でスクリーンショットを撮り直す` を積む。**差分が無ければ何も積まない**。
**撮影中に tagpr がブランチを作り直すと push で落ちる**（古いツリーの画像を載せないため）。起動し直す。

1. リリース PR の Files changed で画像を目視で確認する（バージョン表記と、その回で変えた UI が写っているか）。
   **総称の `monospace` で描く箇所は手元の画像と字形が違う**（許容している。`build.md`）
2. 撮り直しが要るなら、直す PR を main にマージし、作り直されたリリース PR のブランチでもう一度起動する

あわせてマニュアルを棚卸しする: 新機能の記載漏れ、`grep -rn Windows` でのプラットフォーム記述の
古さ、「撮っているのに使われていない画像」（`.claude/rules/build.md` の comm のワンライナー）。
直すものがあれば main への PR にする。

**手元で撮るのは、CI が使えないときと spec を書いている途中だけ**（日本語の Windows・拡大率 150% が要る。
`e2e/README.md` の「撮影環境の前提」）。手元で撮った画像はリリース PR のブランチへ手でコミットせず、
CI が使えるようになってから撮り直す。

### 5. CI と Security Check の確認

- main の最新の `Security Check` と `CI` が success であること:

  ```bash
  gh run list --branch main --workflow security.yml -L 1
  gh run list --branch main --workflow ci.yml -L 1
  ```

- **リリース PR の run はボット（GITHUB_TOKEN）が作った PR なので、承認待ち（`action_required`）で止まる。**
  撮影のコミットにも run ができる。**今の head（手順 4 の画像のコミット）の 2 本（CI と Security Check）だけを
  API で承認し**、通ることを確かめる。古い head の run は承認しなくてよい（マージ後の判定には使わない）:

  ```bash
  gh run list --branch <ブランチ> -L 4 --json databaseId,workflowName,conclusion,headSha
  gh api -X POST repos/kan/pike/actions/runs/<id>/approve   # 2 本それぞれ
  gh run watch <id> --exit-status
  ```

### 6. リリース PR のマージ

CHANGELOG の見出しの日付は、tagpr が最後にリリース PR を作り直した日になる。**マージする日と
違えば、先に作り直して日付を合わせる**（`gh workflow run tagpr.yml --ref main`。画像のコミットは
引き継がれる）。

```bash
gh pr merge <番号> --squash --delete-branch
git switch main && git pull --ff-only
sha=$(git rev-parse HEAD)
gh run list --workflow tagpr.yml --commit "$sha" --json databaseId,status -q '.[0]'
gh run watch <run id> --exit-status
```

マージの push で走る tagpr の run が、**タグ `vX.Y.Z` を打ち、annotated に打ち直してから、同じ run の
`release` ジョブで Release ワークフローをそのタグで起動する**（#562 / #573。どれも kan/tagpr-scripts の共通の
workflow が行う。`workflow_dispatch`。GITHUB_TOKEN で打ったタグの push では Release は起動しない）。
Release は tagpr とは別の run になる:

```bash
gh run list --workflow release.yml --branch vX.Y.Z -L 1 --json databaseId,status
gh run watch <run id> --exit-status
```

Release の中は `draft`（ドラフトを 1 つ作る）→ `build`（Windows と macOS(arm64) を**並列に**コンパイル）→
`bundle`（OS ごとにインストーラを作って署名する）→ `attest`（来歴の証明）と `upload`（アセットを
ドラフトへ上げる）→ `updater-json`（`latest.json` を組み立てて上げる）の順に走る（#505 / #585）。
ジョブを権限と鍵ごとに分けた理由は `.claude/rules/build.md`。
**macOS 版も Developer ID 署名・公証済みで、updater の対象**（#283。詳細は `.claude/rules/build.md`）。

**マージの tagpr の run が cancelled になっていたら**（待っている間に main へ push が来ると、GitHub は
古いほうを取り消す）、タグは打たれていない。その run を再実行する（`gh run rerun <run id>`。マージ
コミットをチェックアウトしてタグを打つ）。後の push の tagpr の run は「タグより新しい版の節がある」で
赤になっているが、再実行でタグが打たれれば次の run から通る。**新しいリリース PR をマージしてやり過ごさない**
（打たれていない版の上に次の版を重ねることになる）。

置き換えた側の run は赤になり、版だけ上がったリリース PR が draft で残ることがある。**その PR は
マージしない。** タグが打たれた後、main への push で成功した run がコメントを付けて閉じる（扱いの正本は
`scripts/tagpr/README.md` の「The tagpr workflow」。kan/tagpr-scripts#11）。閉じられる前も、閉じた後に
開き直しても、マージしない。

**タグは打たれたのに Release の run が無いとき**は、**そのマージの tagpr の run を再実行する**（tagpr
は既にあるタグを受け入れるので、annotated への打ち直しと `release` ジョブがもう一度動く）。
**Release の run が既に起動していたら再実行しない**（同じタグでもう一度起動する）。手順の正本は
`scripts/tagpr/README.md` の「When the run of a merge made the tag but failed after it」。

再実行できないとき（30 日を過ぎた run）だけ、その README の手順で手で直す。**pike の `release.yml` は
`push: tags` を持たないので、タグを手で push しても Release は起動しない**（roji や lily と違う）。
lightweight のタグを打ち直したときも、最後に `gh workflow run release.yml --ref vX.Y.Z` で起動する。

**タグが打たれ、Release の run のジョブ（`draft`、OS ごとの `build` と `bundle`、`attest`、
`upload`、`updater-json`）がすべて success であることを確認する。** `updater-json` は両 OS のアセットが
上がったときだけ走り、各 URL の実ファイルの署名を検証してから `latest.json` を上げる。

- `draft` が落ちたら、タグで起動されているか、タグが `vX.Y.Z` の形か、`tauri.conf.json` の version と
  合っているか、タグのコミットの CHANGELOG に `## [X.Y.Z] - 日付` の節が 1 つだけあり空でないかを見る
- `build` か `bundle` のどちらかが落ちたら、一時的な失敗なら落ちたジョブだけを再実行する
  （`gh run rerun <run-id> --failed`。後ろのジョブもそのあと走る）
- `bundle` の「Collect the release assets」が落ちたら、バンドラが出すファイルの名前が変わっている
  （tauri を上げたときなど）。`scripts/release-assets.mjs` の表の `from` を直す PR を作り、マージしてから
  タグを打ち直す（`name` は変えない。`updater-json.mjs` が読む名前と、これまでのリリースのアセットの名前のため）
- 打ってあるタグで丸ごとやり直すなら `gh workflow run release.yml --ref vX.Y.Z`（**`--ref` にはタグを渡す**。
  ブランチで起動すると `draft` が止める。`draft` が同じタグのドラフトを消してから作り直す）
- コードや CHANGELOG を直す必要があるなら、下の「タグを打ち直す場合」

### 7. ドラフトの確認

**ドラフトに `latest.json` とポータブル版の zip（`Pike_X.Y.Z_x64-portable.zip`、#451）が
あることを確認する。** `latest.json` の `platforms` に両 OS がそろうことは `updater-json` が
保証するので、中身を開いて見る必要はない:

```bash
gh release view vX.Y.Z --repo kan/pike --json assets -q '.assets[].name'
```

**手でダウンロードする 5 つのファイルに attestation（来歴の証明）が付いていることを確認する**（#468）。
ドラフトから落として 1 つずつ検証する:

```bash
dir=$(mktemp -d)
gh release download vX.Y.Z --repo kan/pike --dir "$dir" \
  --pattern '*-setup.exe' --pattern '*.msi' --pattern '*-portable.zip' \
  --pattern '*.dmg' --pattern '*.app.tar.gz'
ls "$dir"   # 5 件あること
for f in "$dir"/*; do
  gh attestation verify "$f" --repo kan/pike \
    --signer-workflow kan/pike/.github/workflows/release.yml \
    --source-ref refs/tags/vX.Y.Z || echo "FAILED: $f"
done
```

**5 つとも通ること。** とくに `.dmg` は staple で差し替えたあとのファイルなので、attest の位置が
ずれると `.dmg` だけ落ちる（理由は `.claude/rules/build.md`）。1 つでも落ちたら公開せず、
直してタグを打ち直す。Release はタグで起動されるので、source の ref はタグになる（#562。v0.70.0 までは
`workflow_call` で呼んでいたので `refs/heads/main`。それらの版を検証するときは `--source-ref` を外す）。

### 8. リリースの公開

ドラフトの本文（CHANGELOG の節から作られている）を確認して公開する。本文は手で書き直さない
（手で直した本文は `latest.json` の `notes` に届かず、CHANGELOG ともずれる）。直したいところがあれば、
公開せずに CHANGELOG を直す PR をマージし、**タグを打ち直す**（本文と `notes` はタグのコミットの
CHANGELOG から作られるので、ワークフローの再実行だけでは変わらない）:

```bash
gh release view vX.Y.Z --repo kan/pike --json body -q .body
gh release edit vX.Y.Z --repo kan/pike --draft=false
```

**Immutable releases（リポジトリ設定、#468）が有効だと、公開した時点で成果物とタグが
不変になる。** 公開後に `latest.json` の欠けや attestation の漏れに気付いても、成果物の差し替えも
タグの打ち直しもできず、次のバージョンを出すしかない（消したリリースのタグ名も再利用できない）。
**手順 7 の確認を済ませてから公開する。** リリースノートの本文とタイトルは公開後も GitHub 上では
編集できるが、`latest.json` の `notes` は変わらないので、本文は公開後も手で書き換えない。

有効にしてある場合は、公開後に release attestation も確かめる:

```bash
gh api repos/kan/pike/immutable-releases -q .enabled   # true のときだけ
gh release verify vX.Y.Z --repo kan/pike
```

### タグを打ち直す場合

公開前に限る。

1. タグを消す: `git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z`
2. 直す PR を main にマージする（CHANGELOG を直すなら、main ではもう `## [X.Y.Z] - 日付` になっている節を直す）
3. 直した main の先頭に **annotated の**タグを打って push し、Release を手で起動する（タグの push では起動しない）:

   ```bash
   git switch main && git pull --ff-only
   git tag -a -m "Release vX.Y.Z" vX.Y.Z
   git push origin vX.Y.Z
   gh workflow run release.yml --ref vX.Y.Z
   ```

前の実行のドラフトは消さなくてよい（`draft` ジョブが同じタグのドラフトを消してから作り直す）。
タグを消したあいだに main が進むと、その tagpr の run は「タグより新しい版の節がある」で赤になる
（手順 2 の PR のマージでもそうなる）。タグを打ち直したら次の run から通るので、放っておいてよい。
手順 2 の run が残した版だけ上がったリリース PR（draft）は、マージしない。手順 3 の後に main への push で
成功した run が閉じる（kan/tagpr-scripts#11。`scripts/tagpr/README.md` の「The tagpr workflow」）。

### 注意事項

- 成果物の名前は `tauri.conf.json` の `version` から付き、`draft` ジョブはタグ（`vX.Y.Z` の形だけ）と食い違えば止める。版はリリース PR がそろえるので、`tauri.conf.json` を手で書き換えない
- `TAURI_SIGNING_PRIVATE_KEY` が GitHub Secrets に設定されていること（署名なしビルドは updater で検証失敗する）。`release.yml` はリポジトリの secrets を直接読む（`workflow_dispatch` で起動するため）
