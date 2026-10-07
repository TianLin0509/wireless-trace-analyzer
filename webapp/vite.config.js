import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { compression } from 'vite-plugin-compression2';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const BUILD_ID = new Date().toISOString();
const VERSION = process.env.npm_package_version || '1.0.0';

// 与线上 Caddy 响应头一致的安全策略，作为页面内兜底：换一台静态服务器部署时依然禁止页面向外发送请求
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self' blob: data:; "
  + "img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'";

const metaCsp = () => ({
  name: 'meta-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${CSP}">`),
});

// 构建结束：写 version.json（页面据此提示新版本），并把版本号与预缓存清单写进 sw.js
const finalize = () => ({
  name: 'finalize-dist',
  apply: 'build',
  closeBundle() {
    writeFileSync('dist/version.json', JSON.stringify({ build: BUILD_ID, version: VERSION }));
    const assets = readdirSync('dist/assets')
      .filter((f) => !/\.(br|gz)$/.test(f) && !/mvp/.test(f)) // mvp 版引擎只给老浏览器用，不预缓存
      .map((f) => `/assets/${f}`);
    const sw = readFileSync('dist/sw.js', 'utf8')
      .replace('__BUILD__', BUILD_ID)
      .replace('__PRECACHE__', JSON.stringify(['/', '/icon.svg', '/manifest.webmanifest', ...assets]));
    writeFileSync('dist/sw.js', sw);
  },
});

// 产物是纯静态文件：index.html + assets/（含 DuckDB-WASM 引擎）+ sw.js，可放任何静态服务器。
export default defineConfig({
  base: '/',
  plugins: [
    preact(),
    metaCsp(),
    finalize(),
    // sw.js 构建后还要改写，不生成预压缩副本，避免服务器发出过期内容
    compression({ algorithms: ['brotliCompress', 'gzip'], include: /\.(js|css|html|wasm|svg|json|webmanifest)$/, exclude: [/sw\.js$/, /version\.json$/], threshold: 1024 }),
  ],
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 6000, assetsInlineLimit: 0 },
  define: { __APP_VERSION__: JSON.stringify(VERSION), __BUILD_TIME__: JSON.stringify(BUILD_ID) },
  server: { port: 5317, strictPort: true },
});
