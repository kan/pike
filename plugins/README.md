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
スキルディレクトリをそこへコピーする。

```bash
mkdir -p ~/.codex/skills
cp -r /path/to/pike/plugins/codex/pike-todo ~/.codex/skills/pike-todo
```

## 前提

`pike.exe` が PATH にあること（Pike インストール時に配置される）。スキルは
`pike todo ...` を実行して TODO を操作する。
