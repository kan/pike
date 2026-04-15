# Pike 第2段階: AgentRuntime trait 抽出 + ACP経由 Claude Code 対応

## 進捗

### 完了済み (Step 1–4 + 部分的 Step 5)

- `AgentRuntime` trait 設計・実装 (`src-tauri/src/agent/types.rs`)
- `CodexAppServerRuntime` — 既存 Codex app-server を trait wrap (`codex_runtime.rs`)
- `ACPRuntime` — ACP JSON-RPC over stdio 実装 (`acp_runtime.rs`)
- `agent_*` Tauri コマンド 13個 登録済み (`commands.rs`)
- `AgentState` — ウィンドウ別セッション管理 + window destroy 時 cleanup (`state.rs`)
- フロント: `agent.ts` (types), `stores/agent.ts` (Pinia), `useAgentRouter.ts` (event router)
- `AgentChatTab.vue` — capabilities ベースの条件分岐 UI
- `AgentApprovalDialog.vue` — generic approval 対応含む
- `TabPane.vue`, `tabs.ts`, `project.ts` に agent-chat タブ対応追加

### 残作業

以下の作業が残っている。前段階の実装は済んでいるため、**UI 導線の接続とクリーンアップ**が中心。

---

## Step 6: CodexTab → AgentTab 完全移行

### 方針
- 互換性維持は不要。**CodexChatTab とそれを使う実装を削除**し、AgentChatTab に一本化する
- 既存の `codex` store / `useCodexRouter` / `CodexChatTab.vue` / `ApprovalDialog.vue` は削除
- サイドバー Bot ボタン、セッション復元、pinned tab はすべて `agent-chat` を使う
- `codex_*` Tauri コマンドは Rust 側に残しても良い（削除は任意、今回は残す方針）

### 具体作業

1. **SideBar.vue**: Bot アイコンクリック → `tabStore.addAgentChatTab()` に変更
   - 設定値が「都度選択」の場合はポップアップリスト表示（後述の Step 7 で実装）
2. **project.ts (store)**: セッション復元で `codex-chat` → `agent-chat` にマッピング
   - `lastSession.tabs` 内の `kind: 'codex-chat'` は `kind: 'agent-chat'` として読み替え
   - `codexThreadId` があり `agentSessionId` が無い場合、`codexThreadId` を `agentSessionId` にフォールバック
3. **project.ts (store)**: `pinnedTabs` がゼロの場合のデフォルト Claude Code ターミナルタブは維持
4. **codex store / router / component 削除**:
   - `src/stores/codex.ts` 削除
   - `src/composables/useCodexRouter.ts` 削除
   - `src/components/tabs/CodexChatTab.vue` 削除
   - `src/components/codex/ApprovalDialog.vue` 削除
   - `App.vue` から `initCodexRouter` 呼び出し削除
   - `TabPane.vue` から CodexChatTab 関連削除
   - `tabs.ts` から `addCodexChatTab` 削除、`codex-chat` 参照を `agent-chat` に統一
   - `types/tab.ts` から `CodexChatTab` 型削除
   - `types/project.ts` の `SessionTabDef.kind` から `'codex-chat'` 削除
   - `types/codex.ts` は `ChatMessage` / `TurnItem` 等の型が agent store からも参照されているため、ファイル名を `types/chat.ts` にリネーム
5. **tauri.ts**: `codex*` ラッパー関数群を削除
6. **i18n**: `codex.*` キーは当面そのまま（AgentChatTab が参照しているため）。将来的に `agent.*` にリネーム可

---

## Step 7: エージェント選択設定

### Settings Tab

Settings タブに「Agent」セクションを追加:

```
Agent
┌─────────────────────────────────────────┐
│ Default Agent                           │
│ ┌─────────────────────────────────┐     │
│ │ ▾ Claude Code                   │     │
│ └─────────────────────────────────┘     │
│   ○ Claude Code (ACP)                   │
│   ○ Codex (app-server)                  │
│   ○ Ask each time                       │
└─────────────────────────────────────────┘
```

- 設定値: `'claude-code' | 'codex' | 'ask'`
- `localStorage` (`pike:settings`) に保存。キー: `agentDefault`
- `settings` store に `agentDefault` を追加

### サイドバー Bot ボタン動作

- `agentDefault === 'ask'` の場合:
  - Bot ボタンクリック → ポップアップリスト表示（ProjectSwitcher と同じパターン）
  - 選択肢: `Claude Code` / `Codex`
  - 選択 → `tabStore.addAgentChatTab({ agentType: 選択値 })`
- それ以外:
  - Bot ボタンクリック → `tabStore.addAgentChatTab({ agentType: agentDefault })`
- ポップアップは Bot ボタンの横にフロート表示（小さいメニュー、2項目のみ）

### agent store への反映

- `startSession()` で `agentType` を決定する優先順位:
  1. per-project 設定 (`pike:agent:{projectId}` の `agentType`)
  2. グローバル設定 (`settings.agentDefault`)
  3. フォールバック: `'codex'`
- タブ作成時に `agentType` が渡された場合はそれを使用（都度選択の場合）

---

## Step 8: QuickOpen からエージェントタブを開く

### QuickOpen 統合

QuickOpen (`Ctrl+P`) の入力候補に以下を追加:

- `> Claude Code` — Claude Code エージェントタブを開く
- `> Codex` — Codex エージェントタブを開く

実装:
- QuickOpen にコマンドパレット機能を追加（`>` プレフィックスで切替、VS Code 方式）
- または、既存のファイル候補リストの先頭に固定項目として表示
- 簡易実装: `>` 入力時に特殊コマンド候補を表示。選択で `tabStore.addAgentChatTab({ agentType })` を呼ぶ

### コマンド候補リスト

```
> Claude Code        — Open Claude Code agent
> Codex              — Open Codex agent
> Settings           — Open settings
```

---

## 参考情報

- ACP仕様: https://zed.dev/acp
- claude-agent-acp: https://github.com/zed-industries/claude-code-acp (Apache License)
- codex-acp (参考実装): https://github.com/zed-industries/codex-acp

## やらないこと（スコープ外）

- Codex側のACP移行（段階3の判断は後で行う）
- MCP サーバー設定のUI/管理
- claude-agent-acp バイナリの自動インストール/アップデート
- Inline Assistant（選択範囲の1ショット変換）— 別タスクとして後日実装
- エージェント間でのコンテキスト共有・引き継ぎ
- i18n キーの `codex.*` → `agent.*` リネーム（機能に影響しないため後回し）
