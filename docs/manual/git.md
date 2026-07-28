# Git

Pike の Git 統合は `git` CLI 経由で、WSL / Windows の両方に対応します。ステータスバーとサイドバーの Git パネルから操作します。

- [ステータスバー表示](#ステータスバー表示)
- [Git パネル](#git-パネル)
  - [オプション付きの pull / push](#オプション付きの-pull--push)
- [コミットグラフ](#コミットグラフ)
- [diff タブ](#diff-タブ)
- [コンフリクトの確認](#コンフリクトの確認)
- [ファイル履歴（Git History）](#ファイル履歴git-history)
- [worktree](#worktree)

## ステータスバー表示

<picture>
  <source media="(prefers-color-scheme: light)" srcset="../screenshot-git-light.png">
  <img alt="Git パネルと Claude Code" src="../screenshot-git.png">
</picture>

ステータスバー（下端）には以下が表示されます。

- 現在の**ブランチ名**とダーティ表示（クリックでブランチ切替）
- **worktree セレクタ**（worktree が 2 つ以上あるとき）
- **ahead / behind**（リモートとの差分件数）
- リポジトリへのリンク

## Git パネル

左サイドバーの **🌿 Git** アイコンで開きます。

- **ステージング / アンステージ**：変更ファイルを個別に、または一括で。
- **コミット**：メッセージを入力してコミット。
- **push / pull / refresh**：パネルのボタン、またはサイドバーのアイコン（ahead/behind があると強調表示）。
- **変更の破棄**：ファイルごとに作業ツリーの変更を元に戻す（確認ダイアログあり）。
- コミット履歴は List / Graph で切り替えられ、各コミットはホバーで全文ツールチップを表示します。

サイドバーの Git アイコンには変更件数のバッジが付き、コンフリクトがあるときは赤バッジになります。未 push のコミットがあると右下に「↑」、未 pull のコミットがあると「↓」が出ます（両方あれば「↑↓」）。件数はアイコンのツールチップで確認できます。

### オプション付きの pull / push

pull / push ボタンを**右クリック**すると、オプション付きで実行するメニューが出ます。左クリックはオプションなしの `git pull` / `git push` です。

| pull | push |
|------|------|
| `git pull` | `git push` |
| `git pull --rebase` | `git push -u origin HEAD` |
| `git pull --rebase --autostash` | `git push --tags` |
| `git pull --ff-only` | `git push --force-with-lease` |

- `-u origin HEAD` は、upstream が未設定のブランチを初めて push するときに使います。
- `--force-with-lease` はリモートの履歴を書き換えるため、メニューで赤く表示し、実行前に確認ダイアログを出します。

## コミットグラフ

`git log --all` と親ハッシュ・refs を使って、ブランチのマージグラフを SVG で描画します。Git パネルで **List / Graph** を切り替えて表示します。

<picture>
  <source media="(prefers-color-scheme: light)" srcset="img/git-graph-light.png">
  <img alt="コミットグラフ" src="img/git-graph.png">
</picture>

## diff タブ

ファイルの差分は左右分割の diff タブで表示します。文字単位のハイライト（共通の接頭辞/接尾辞方式）で、変更箇所が分かりやすくなっています。

エディタと同じ **`Ctrl+F`** で検索パネルが開きます。左右どちらのペインの一致も探し、差分の文字ハイライトと重ねて表示します。大文字小文字の区別を切り替えられ、件数を表示し、`Enter` / `Shift+Enter` で前後の一致へ移動、`Esc` で閉じます。移動すると現在の一致が中央に来るようスクロールします。

## コンフリクトの確認

マージコンフリクト（unmerged）のファイルは、Git パネル最上部の専用 **「Conflicts」** セクションに赤字で表示されます。クリックすると作業ツリーのそのファイルをエディタで開きます。

エディタ側では、`<<<<<<<` / `|||||||` / `=======` / `>>>>>>>` のマーカー行と各セクション本文が色分けハイライトされます（表示のみ。解消ツールは未搭載なので、編集して解消します）。→ [エディタとプレビュー](editor-and-preview.md#git-diff-ガターとコンフリクト表示)

## ファイル履歴（Git History）

特定ファイルの git log を専用タブで表示できます。

- ファイルツリーやエディタタブの右クリックメニュー →「Git History」、エディタでは `Alt+H`。
- 履歴の行をクリックすると、その差分を diff タブで開きます。
- 行範囲を指定した履歴（`git log -L`）にも対応します。

## worktree

複数 worktree を 1 ウィンドウで切り替えてレビューできます。ステータスバーの worktree セレクタで参照先を変えると、Git パネルを含む各パネルとエディタが選んだ worktree を参照します。詳しくは [プロジェクトとウィンドウ](projects-and-windows.md#git-worktree-の切り替え) を参照してください。

関連: [エディタとプレビュー](editor-and-preview.md) / [サイドバーパネル](panels.md)
