import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages 等のサブパス配信を想定し、相対パスでビルドする。
  base: './',
});
