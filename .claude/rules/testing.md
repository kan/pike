# テスト方針

## 基本方針
- 自動テストは最小限。動作確認は手動（GUI で実挙動を確認）で行う
- Rust のユニットテストは純粋なロジック（パース処理等）にのみ書く
- PTY / Docker / git などの外部プロセス依存部分は統合テストの対象外
- Vue コンポーネントのテストは当面スコープ外
- PTY / tmux / bollard の接続検証は `src-tauri/src/bin/` に小さい検証バイナリを作って `cargo run --bin verify_xxx` で確認する

## 検証バイナリの置き場
```
src-tauri/src/bin/
├── verify_pty.rs      # PTY + wsl.exe の接続確認
├── verify_tmux.rs     # tmux セッション管理の確認
└── verify_bollard.rs  # Docker socket 接続確認
```

各バイナリは単独で `cargo run --bin verify_xxx` できるように `fn main()` を持つ。
Tauri に依存しないこと。
