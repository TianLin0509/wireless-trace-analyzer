import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { compression } from 'vite-plugin-compression2';
import { writeFileSync } from 'node:fs';

const BUILD_ID = new Date().toISOString();
// 构建时写出 version.json，页面定期比对，发现新版本时提示刷新
const versionFile = () => ({ name: 'version-file', closeBundle() { writeFileSync('dist/version.json', JSON.stringify({ build: BUILD_ID, version: process.env.npm_package_version || '1.0.0' })); } });

// 产物是纯静态文件：index.html + assets/（含 DuckDB-WASM 引擎）+ sw.js，可放任何静态服务器。
export default defineConfig({
  base: '/',
  plugins: [
    preact(),
    versionFile(),
    compression({ algorithms: ['brotliCompress', 'gzip'], include: /\.(js|css|html|wasm|svg|json|webmanifest)$/, threshold: 1024 }),
  ],
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 6000, assetsInlineLimit: 0 },
  define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '1.0.0'), __BUILD_TIME__: JSON.stringify(BUILD_ID) },
  server: { port: 5317, strictPort: true },
});
