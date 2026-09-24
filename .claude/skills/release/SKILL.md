---
name: release
description: Pike の新しいバージョンをリリースする（dependabot の取り込み → rg サイドカー確認 → bump → CHANGELOG → スクリーンショット → push → タグ → ドラフトの公開）。「リリースして」「vX.Y.Z を出して」と頼まれたときに使う。
---

# Pike のリリース手順

**リリースの依頼は end-to-end の依頼。** バージョン bump のコミットだけでなく、`main` の push・
タグ作成と push・Release ワークフローの完了待ち・ドラフトのリリースノート記載と公開までを
Claude が実行する。通常のコミット運用と異なり push の個別確認は要らない。CI の完了待ちは
バックグラウンドの watch で行う。以下を順番に実行する。

### 0. dependabot の PR を取り込む

**バージョン bump より前に、open な dependabot の PR を片付ける。** 出荷済みの版に後から依存の
更新は混ぜられないので、残したまま出すと次のリリースまで届かない。取り込み方は CLAUDE.md の
「コミット & push 運用ルール」のとおり（ロックファイルを共有するので 1 件ずつマージせず、
ローカルでまとめて取り込む）。取り込み → `just check` → push の後に 1 へ進む。

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

バイナリは `.gitignore` 済みなので、コミットするのは `scripts/download-rg.sh` だけ。
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

同じ一覧を後述の「8. リリースの公開」のリリースノートにも使う（片方だけ直すとずれる）。

その上で `CHANGELOG.md` の先頭に新しいセクションを追加し、**CLAUDE.md の「ドキュメント校正ルール」の校正を
かける**（今回足した節だけが対象。過去の節は出荷済みの記録なので触らない）。

### 4. スクリーンショットの撮り直し

**マイナー bump のリリースでは必ず撮り直す。** 画像には StatusBar のバージョンが写るので、
**bump 済みのツリーで撮る**（bump → 撮影 → 同期 → タグ の順。詳細は `.claude/rules/build.md`）。

```bash
just e2e-build           # 出力を | tail に通さないこと（落ちても 0 が返る）
just e2e
just e2e-sync-check      # 差分を確認してから
just e2e-sync            # マニュアルとヒーローの 2 本（枚数は各スクリプトが出す）
```

同期したら、代表的な画像を目視で確認する（バージョン表記と、その回で変えた UI が写っているか）。
あわせてマニュアルを棚卸しする: 新機能の記載漏れ、`grep -rn Windows` でのプラットフォーム記述の
古さ、「撮っているのに使われていない画像」（`.claude/rules/build.md` の comm のワンライナー）。

画像はバージョン bump とは別のコミットにする（`docs: vX.Y.Z でスクリーンショットを撮り直す`）。

### 5. コミット & プッシュ

```bash
git add src-tauri/tauri.conf.json package.json src-tauri/Cargo.toml src-tauri/Cargo.lock package-lock.json CHANGELOG.md
git commit -m "Bump version to vX.Y.Z"
git push origin main
```

**2 つの lockfile を含めること**。忘れると作業ツリーに drift が残り、あとから `chore: Cargo.lock を vX.Y.Z に同期` という追加コミットが必要になる。

### 6. Security Check の確認

GitHub Actions の `Security Check` ワークフローが成功することを確認する。

### 7. タグの作成 & プッシュ

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

タグ push で `Release` ワークフローが自動起動し、Windows と macOS(arm64) の 2 ジョブが
**Windows → macOS の順に直列で**同じドラフトへ成果物をアップロードする。**macOS 版も
Developer ID 署名・公証済みで、updater の対象**（#283。詳細は `.claude/rules/build.md`）。

**公開前に、ドラフトの `latest.json` の `platforms` に `windows-x86_64` と
`darwin-aarch64` の両方があることを確認する。** 片方の OS しか載っていない
`latest.json` を公開すると、もう片方の全クライアントが黙って更新を受け取れなくなる
（片方のジョブが落ちたときに起きうる。理由は `.claude/rules/build.md`）。
足りなければ公開せず、直してタグを打ち直す。

### 8. リリースの公開

ワークフロー完了後、GitHub Releases でドラフトを確認し、リリースノートを記載して公開する。
**中身は CHANGELOG に足した節から起こす**（手順 3 の `git log` で洗い出したもの）。両方を
別々に書くと、片方にしか無い項目ができる:

```bash
gh release edit vX.Y.Z --repo kan/pike --draft=false --notes "$(cat <<'EOF'
## Pike vX.Y.Z

### Changes
- ...

EOF
)"
```

### 注意事項

- `tauri-action` は `tauri.conf.json` の `version` をリリース名・タグ名の `__VERSION__` に埋め込む。**必ずタグを打つ前にバージョンを更新すること**
- `TAURI_SIGNING_PRIVATE_KEY` が GitHub Secrets に設定されていること（署名なしビルドは updater で検証失敗する）
- タグを打ち直す場合: `git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z` → 修正後に再タグ
