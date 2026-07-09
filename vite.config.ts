import { execSync } from "child_process";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const host = process.env.TAURI_DEV_HOST;

function gitCommitHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

export default defineConfig({
  plugins: [vue()],
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
