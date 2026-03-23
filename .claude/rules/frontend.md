# フロント実装ルール

## 基本方針
- Vue 3 Composition API + `<script setup>` で統一
- 状態管理は Pinia、ストアは `src/stores/` に置く
- Tauri invoke は `src/lib/tauri.ts` に型付きラッパーを作って使う（直接 invoke しない）
- コンポーネントは `src/components/{category}/XxxYyy.vue` の命名

## タブ管理
- タブの状態は `src/stores/tabs.ts` で一元管理
- Tab の型定義:
  ```typescript
  type Tab =
    | { id: string; kind: 'terminal'; title: string; pinned: boolean }
    | { id: string; kind: 'editor';   path: string }
    | { id: string; kind: 'docker-logs'; containerId: string; containerName: string }
  ```
- pinned タブは ✕ ボタン非表示、Ctrl+W のハンドラで早期リターン

## xterm.js
- `Terminal` インスタンスはタブごとに生成し、コンポーネントの `onUnmounted` で `.dispose()`
- `FitAddon` で初期サイズを確定してから `pty_spawn` を invoke する
- ResizeObserver でコンテナサイズ変化を検知 → `FitAddon.fit()` → `pty_resize` invoke
- フォントは等幅フォントを明示: `fontFamily: "'Cascadia Code', 'Fira Code', monospace"`

## スタイル
- CSS フレームワークは使わない（Tauri アプリなので外部 CDN 不要、軽量が正義）
- CSS Variables でテーマ変数を管理 (`--bg-primary`, `--text-primary` 等)
- レイアウトは CSS Grid / Flexbox のみ

## 禁止事項
- Monaco Editor（重い）
- 不要な npm パッケージの追加（都度相談）
- `any` 型（型定義を作ること）
