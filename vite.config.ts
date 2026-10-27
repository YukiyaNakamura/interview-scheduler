import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

// react() で画面（src/web）を、cloudflare() で Worker（src/worker）を同じ開発サーバーで動かす
export default defineConfig({
  plugins: [react(), cloudflare()],
  build: { outDir: 'dist/web' },
  server: {
    // 5173 は別プロジェクト（sns_pdca）が使うことがあるので固定でずらす。.dev.vars の APP_URL と合わせる
    port: 5180,
    strictPort: true,
    // Google OAuth の callback を手元で試すとき、cloudflared のクイックトンネル経由のアクセスを許可する（開発サーバーのみ）
    allowedHosts: ['.trycloudflare.com'],
  },
});
