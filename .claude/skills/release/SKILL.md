---
name: release
description: Pike の新しいバージョンをリリースする（dependabot の取り込み → rg サイドカー確認 → bump → CHANGELOG → push → CI でスクリーンショット → タグ → ドラフトの公開）。「リリースして」「vX.Y.Z を出して」と頼まれたときに使う。
---

# Pike のリリース手順

**リリースの依頼は end-to-end の依頼。** バージョン bump のコミットだけでなく、`main` の push・
タグ作成と push・Release ワークフローの完了待ち・ドラフトのリリースノートの確認と公開までを
Claude が実行する。通常のコミット運用と異なり push の個別確認は要らない。CI の完了待ちは
バックグラウンドの watch で行う。以下を順番に実行する（**例外は手順 5 で、手順 4 の撮影より前に行う**）。
画像の PR（手順 4）のマージも Claude が行う。

### 0. dependabot の PR を取り込む

**バージョン bump より前に、open な dependabot の PR を片付ける。** 出荷済みの版に後から依存の
更新は混ぜられないので、残したまま出すと次のリリースまで届かない。取り込み方は CLAUDE.md の
「コミット & push 運用ルール」のとおり（ロックファイルを共有するので 1 件ずつマージせず、
ローカルでまとめて取り込む）。取り込み → `just check` → push の後に 1 へ進む。

**依存が変わったらクレジットを作り直す**（#420）。`just credits` で `src/assets/credits.json` を
作り直し、取り込みと同じコミットに入れる。忘れると `just check` の `check-credits` が落ちる
（About に出すライセンスの一覧が、配布物の依存と食い違うため）。

### 1. rg サイドカーのバージョン確認

`scripts/download-rg.sh` の `VERSION` を [ripgrep のリリース](https://github.com/BurntSushi/ripgrep/releases)
と突き合わせ、新しい版が出ていれば上げる。上げたら**手元のバイナリを消してから取り直す**:

```bash
rm -f src-tauri/binaries/rg-*
just fetch-rg
```

**この確認を自動でやる仕組みは無い。** dependabot が見るのは npm / cargo / github-actions の
3 つで、シェルスクリプトの中のバージョン文字列は対象外。CI も同じスクリプトを呼ぶだけなので、
`VERSION` が古いままなら CI が作る成果物も古いままになる（毎回ダウンロードすることと、
毎回最新を取ることは別）。消してから取り直すのは、スクリプトがファイルの有無しか見ないため
（詳細は `.claude/rules/platform.md`）。

バイナリは `.gitignore` 済みなので、コミットするのは `scripts/download-rg.sh` と、`just credits` で
作り直した `src/assets/credits.json`（ripgrep の版とライセンスの本文が載っている）。
バージョン bump とは別のコミットにする（`chore: rg サイドカーを X.Y.Z に上げる`）。

### 2. バージョン番号の更新

```bash
just bump X.Y.Z
```

5 ファイルを一度に揃える。**手で編集しない**（手で揃えると取り残しが出る）:

- `src-tauri/tauri.conf.json` → `"version": "X.Y.Z"`
- `package.json` → `"version": "X.Y.Z"`
- `src-tauri/Cargo.toml` → `version = "X.Y.Z"`
- `Cargo.lock` … レシピが `cargo check` を走らせる
- `package-lock.json` … レシピが `npm install --package-lock-only` を走らせる

`scripts/bump-version.mjs` は置換が 1 箇所だけ当たることを確認してから書く（依存の version 行を巻き込んだら止まる）。

### 3. CHANGELOG.md の更新

**書く対象は前回のタグからの差分で洗い出す。**

```bash
git log --oneline <前回のタグ>..HEAD
```

**記憶で書かないこと。** そのセッションで対応した issue を思い出して並べると、**前のリリース
以降に積まれていた他の変更が丸ごと落ちる**。**公開してからでは直しても既読の人には届かない。**

**この節がそのままリリースノートになる。** タグを push すると、`draft` ジョブが
`scripts/release-notes.mjs` で節を抜き出してドラフトの本文にし、`updater-json` がそれを
`latest.json` の `notes` に写す。節が無いか空なら `draft` ジョブが止まる。**`latest.json` の
`notes` はタグの時点で決まり、公開後は差し替えられない**ので、節はタグを打つ前に仕上げる。

その上で `CHANGELOG.md` の先頭に新しいセクションを追加し、**CLAUDE.md の「ドキュメント校正ルール」の校正を
かける**（今回足した節だけが対象。過去の節は出荷済みの記録なので触らない）。

### 4. スクリーンショットの撮り直し

**マイナー bump のリリースでは必ず撮り直す。** 画像には StatusBar のバージョンが写るので、
**bump 済みのツリーで撮る**（bump → 撮影 → 同期 → タグ の順。詳細は `.claude/rules/build.md`）。

**撮影は CI の `Screenshots` ワークフローで行う**（#506）。撮影するのは main の HEAD なので、
**先に手順 5（bump と CHANGELOG のコミットと push）を済ませてから起動する**。

```bash
gh workflow run screenshots.yml --ref main     # 既定で pr: true。起動した run の URL を出す
gh run watch <URL の末尾の run id> --exit-status   # 12 分ほど
```

**run の id は `gh workflow run` が出す URL から取る。** 起動の直後に `gh run list -L 1` で引くと、
新しい run が一覧に現れる前で、前回の完了済みの run を拾うことがある（`watch` がすぐ成功で終わる）。

ジョブは撮影 → `just e2e-sync` → 差分があればブランチ `screenshots/vX.Y.Z` にコミットして
PR（`docs: vX.Y.Z でスクリーンショットを撮り直す`）を作る。**差分が無ければ PR はできない**。
**main の版のタグが既にあると撮る前に止まる**（bump の push を忘れている）。手順 5 を済ませてから起動し直す。

1. PR の Files changed で画像を目視で確認する（バージョン表記と、その回で変えた UI が写っているか）。
   **総称の `monospace` で描く箇所は手元の画像と字形が違う**（許容している。`build.md`）
2. 問題なければ squash でマージして、手元へ取り込む:

   ```bash
   gh pr merge <番号> --squash --delete-branch
   git pull --ff-only
   ```

3. 撮り直しが要るなら、直してから同じ手順でもう一度起動する（同じブランチを上書きし、PR は 1 つのまま）

あわせてマニュアルを棚卸しする: 新機能の記載漏れ、`grep -rn Windows` でのプラットフォーム記述の
古さ、「撮っているのに使われていない画像」（`.claude/rules/build.md` の comm のワンライナー）。

**手元で撮るのは、CI が使えないときと spec を書いている途中だけ**（日本語の Windows・拡大率 150% が要る。
`e2e/README.md` の「撮影環境の前提」）:

```bash
just e2e-build           # 出力を | tail に通さないこと（落ちても 0 が返る）
just e2e
just e2e-sync-check      # 差分を確認してから
just e2e-sync            # マニュアルとヒーローの 2 本（枚数は各スクリプトが出す）
```

この場合、画像はバージョン bump とは別のコミットにし（`docs: vX.Y.Z でスクリーンショットを撮り直す`）、
**手順 6 へ進む前に `git push origin main` する**（bump は手順 5 で push 済みなので、画像のコミットだけが
手元に残る。手順 7 はタグしか push しない）。

### 5. コミット & プッシュ

```bash
git add src-tauri/tauri.conf.json package.json src-tauri/Cargo.toml src-tauri/Cargo.lock package-lock.json CHANGELOG.md
git commit -m "Bump version to vX.Y.Z"
git push origin main
```

**2 つの lockfile を含めること**。忘れると作業ツリーに drift が残り、あとから `chore: Cargo.lock を vX.Y.Z に同期` という追加コミットが必要になる。

**このコミットと push は手順 4 の撮影より前に行う**（CI が撮るのは push 済みの main）。画像の PR をマージしたら、手順 6 へ進む。

### 6. Security Check の確認

GitHub Actions の `Security Check` ワークフローが成功することを確認する。

### 7. タグの作成 & プッシュ

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

タグ push で `Release` ワークフローが自動起動する。`draft`（ドラフトを 1 つ作る）→
Windows と macOS(arm64) の 2 ジョブを**並列に**（成果物を同じドラフトへ上げる）→
`updater-json`（`latest.json` を組み立てて上げる）の順に走る（#505）。**macOS 版も
Developer ID 署名・公証済みで、updater の対象**（#283。詳細は `.claude/rules/build.md`）。

**4 つのジョブがすべて success であることを確認する。** `updater-json` は両 OS のビルドが
成功したときだけ走り、各 URL の実ファイルの署名を検証してから `latest.json` を上げる。
`draft` が落ちたら、タグが `vX.Y.Z` の形か、`tauri.conf.json` の version と合っているか、
タグのコミットの CHANGELOG に `## [X.Y.Z] - 日付` の節が 1 つだけあるかを見る（直したらタグを打ち直す）。
ビルドのどちらかが落ちたら、一時的な失敗なら落ちたジョブだけを再実行する
（`gh run rerun <run-id> --failed`。`updater-json` もそのあと走る）。コードを直す必要があるなら、
直してタグを打ち直す。

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
    --signer-workflow kan/pike/.github/workflows/release.yml || echo "FAILED: $f"
done
```

**5 つとも通ること。** とくに `.dmg` は staple で差し替えたあとのファイルなので、attest の位置が
ずれると `.dmg` だけ落ちる（理由は `.claude/rules/build.md`）。1 つでも落ちたら公開せず、
直してタグを打ち直す。

### 8. リリースの公開

ワークフロー完了後、ドラフトの本文（手順 3 の CHANGELOG の節から作られている）を確認して公開する。
本文は手で書き直さない（手で直した本文は `latest.json` の `notes` に届かず、CHANGELOG ともずれる）。
直したいところがあれば、公開せずに CHANGELOG を直してコミットし、**タグを打ち直す**
（本文と `notes` はタグのコミットの CHANGELOG から作られるので、ワークフローの再実行だけでは変わらない）:

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

### 注意事項

- 成果物の名前は `tauri.conf.json` の `version` から付き、`draft` ジョブはタグ（`vX.Y.Z` の形だけ）と食い違えば止める。**必ずタグを打つ前にバージョンを更新すること**
- `TAURI_SIGNING_PRIVATE_KEY` が GitHub Secrets に設定されていること（署名なしビルドは updater で検証失敗する）
- タグを打ち直す場合: `git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z` → 修正後に再タグ。前の実行のドラフトは消さなくてよい（`draft` ジョブが同じタグのドラフトを消してから作り直す）
