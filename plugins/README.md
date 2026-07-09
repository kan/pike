# Pike agent plugins

エージェント（Claude Code / Codex）から Pike の機能を扱うためのプラグイン・スキル。
現状は **`pike todo` CLI**（プロジェクトの TODO パネルを端末から操作）を説明するスキルを収録する。

`pike todo` はプロジェクトの `.pike/todo.md` を直接読み書きするため、端末からの変更は
Pike の TODO パネルに即時反映され、パネル側の編集も CLI から読める。

## 構成

```
plugins/
├── .claude-plugin/
│   └── marketplace.json       # Claude Code マーケットプレイス定義（pike-todo を収録）
├── pike-todo/                 # Claude Code プラグイン
│   ├── .claude-plugin/plugin.json
│   └── skills/pike-todo/SKILL.md
└── codex/
    └── pike-todo/SKILL.md     # Codex 用スキル（Claude 版と同一内容）
```

Claude Code と Codex は同じ [Agent Skills](https://code.claude.com/docs/en/skills) 形式
（`SKILL.md` + frontmatter）を使うため、スキル本文は両者で共通。

## Claude Code へ導入

このリポジトリの `plugins/` をマーケットプレイスとして登録し、プラグインを入れる。

```bash
# ローカルパスをマーケットプレイスとして登録
claude plugin marketplace add /path/to/pike/plugins
# プラグインを導入
claude plugin install pike-todo@pike
```

プロジェクト単位で使うなら、スキルディレクトリを `.claude/skills/` に置くだけでもよい。

```bash
cp -r /path/to/pike/plugins/pike-todo/skills/pike-todo .claude/skills/
```

## Codex へ導入

Codex はユーザーの `~/.codex/skills/`（`$CODEX_HOME/skills`）配下のスキルを読み込む。
導入方法は 2 通り。

### 方法A: skill-installer で GitHub から導入（推奨）

Codex 標準の `skill-installer` スキルは、任意の GitHub リポジトリのパスからスキルを
導入できる。Codex にこう頼む。

```
kan/pike の plugins/codex/pike-todo のスキルを入れて
```

内部では次のスクリプトが走り、`~/.codex/skills/pike-todo` へ導入される。

```
install-skill-from-github.py --repo kan/pike --path plugins/codex/pike-todo
```

導入先に同名ディレクトリがあると中断する。**導入後は Codex を再起動**すると新しい
スキルが読み込まれる。

Claude のようなマーケットプレイス登録機能（任意リポジトリを登録して一覧から選ぶ）は
Codex には無いが、この「リポジトリとパスを指定して直接 pull」で同等のことができる。

### 方法B: 手動コピー

スキルディレクトリを `~/.codex/skills/` へコピーする。

```bash
mkdir -p ~/.codex/skills
cp -r /path/to/pike/plugins/codex/pike-todo ~/.codex/skills/pike-todo
```

## 前提

`pike.exe` が PATH にあること（Pike インストール時に配置される）。スキルは
`pike todo ...` を実行して TODO を操作する。
