import { defineConfig } from 'vitest/config';

// テストは純粋関数（空き枠の計算・日時の変換など）が中心。vite.config.ts（Cloudflare プラグイン入り）を読まないよう別ファイルにする
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
