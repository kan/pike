import { execSync } from "child_process";
import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";

/**
 * KaTeX の CSS（#482）から woff / ttf の参照を落とし、フォントを woff2 だけ同梱させる。
 * CSS は 1 つの書体に 3 形式を並べていて、Vite は参照された全部を配布物へ出す（約 1.2MB）。
 * WebView2 と WKWebView は woff2 を読むので、残りの 2 つは使われないまま載るだけになる。
 */
function katexWoff2Only(): Plugin {
  return {
    name: "katex-woff2-only",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]katex[\\/]dist[\\/]katex(\.min)?\.css$/.test(id)) return;
      return code.replace(/,\s*url\([^)]+\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, "");
    },
  };
}

const host = process.env.TAURI_DEV_HOST;

function gitCommitHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

export default defineConfig({
  plugins: [katexWoff2Only(), vue()],
  define: {
    __GIT_COMMIT_HASH__: JSON.stringify(gitCommitHash()),
    // E2E 撮影ビルド (issue #142) でのみ true。通常ビルドでは false 定数に
    // なり、main.ts の wdio guest 読み込み分岐ごと Rollup が dead-code
    // elimination するのでプロダクションには一切含まれない。
    __PIKE_E2E__: JSON.stringify(process.env.PIKE_E2E === '1'),
  },
  clearScreen: false,
  // Limit dep-scan to the actual app entry. Without this, rolldown-vite crawls
  // every *.html in the repo and chokes on src-tauri/target/doc (cargo doc
  // output, ~5000 winapi HTML files) with EMFILE.
  optimizeDeps: {
    entries: ["index.html"],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
