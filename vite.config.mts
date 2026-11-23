import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages 等のサブパス配信を想定し、相対パスでビルドする。
  base: './',
  define: { __BUILD_TIME__: JSON.stringify(new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' JST') },
});
