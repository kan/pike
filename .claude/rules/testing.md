# テスト方針

## M1（スパイク）フェーズ
- 自動テストは書かない
- 動作確認は MILESTONE.md のチェックリストを手動で消化する
- PTY / tmux / bollard の接続検証は `src-tauri/src/bin/` に小さい検証バイナリを作って `cargo run --bin verify_xxx` で確認する

## M2 以降
- Rust のユニットテストは純粋なロジック（パース処理等）にのみ書く
- PTY / Docker / git2 などの外部プロセス依存部分は統合テストの対象外
- Vue コンポーネントのテストは当面スコープ外

## 検証バイナリの置き場
```
src-tauri/src/bin/
├── verify_pty.rs      # PTY + wsl.exe の接続確認
├── verify_tmux.rs     # tmux セッション管理の確認
└── verify_bollard.rs  # Docker socket 接続確認
```

各バイナリは単独で `cargo run --bin verify_xxx` できるように `fn main()` を持つ。
Tauri に依存しないこと。
