---
paths:
  - "tests/**"
  - "src-tauri/src/bin/**"
---

# テスト方針

## 基本方針
- 自動テストは最小限。動作確認は手動（GUI で実挙動を確認）で行う
- Rust のユニットテストは純粋なロジック（パース処理等）にのみ書く
- フロントも**純粋なロジックだけ**テストを書く（`tests/*.test.ts`、`just test-ts`）
  - 走らせるのは `tsx --test`（Node 標準の `node:test`）。**vitest は入れていない**: `tsx` は `check-shortcuts` で既に使っていて、依存を増やさずに済む
  - 置き場を `src/` の外にしているのは、`vue-tsc` の対象（`src/` の DOM 向けの設定）に `node:` の型を持ち込まないため。テストのファイル自体は型検査されない（`tsx` は型を剥がして走らせるだけ）
  - テストにしたいロジックは、ストアから切り出して `src/lib/` の純粋な関数にする（`lib/syncMerge.ts` が例）
- PTY / Docker / git などの外部プロセス依存部分は統合テストの対象外
- Vue コンポーネントのテストは当面スコープ外
- PTY / tmux / bollard の接続検証は `src-tauri/src/bin/` に小さい検証バイナリを作って `cargo run --bin verify_xxx` で確認する

## 検証バイナリの置き場
```
src-tauri/src/bin/
├── verify_pty.rs      # PTY + wsl.exe の接続確認
├── verify_tmux.rs     # tmux セッション管理の確認
├── verify_bollard.rs  # Docker socket 接続確認
├── verify_busy.rs     # 実行中プロセス判定（#178）。ConPTY / WSL の挙動確認なので中身ごと
│                      # Windows 専用（`mod imp` を 1 つの cfg で包む。非 Windows でも
│                      # cargo が拾うので main だけは常に生やす）
└── verify_toast.rs    # デスクトップ通知（#318 → #334）。AUMID と活性化 CLSID 付きの
                       # ショートカット、`pike-dev://` の登録、プロトコル活性化のトーストを
                       # 実機で見る（**通知センターからのクリックはそこでしか確かめられない**）。
                       # 同じく Windows 専用
```

各バイナリは単独で `cargo run --bin verify_xxx` できるように `fn main()` を持つ。
Tauri に依存しないこと。
