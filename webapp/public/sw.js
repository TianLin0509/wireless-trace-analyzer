// 离线缓存：程序文件缓存在本机，加载后断网也能用。只缓存本站静态文件，不接触任何用户数据。
// 下面两个占位符在构建时替换成本次版本号与文件清单（见 vite.config.js 的 finalize-dist）。
const BUILD = '__BUILD__';
const PRECACHE = __PRECACHE__;
const CACHE = 'trace-ab-' + BUILD;

self.addEventListener('install', (e) => {
  self.skipWaiting();
  // 预先缓存本版本的程序文件（含图表库），保证没打开过图表页也能离线使用；失败不影响正常访问
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).catch(() => {}));
});

self.addEventListener('activate', (e) => e.waitUntil((async () => {
  // 每次发布都是新缓存名，旧版本的文件（引擎 wasm 几十 MB）在这里清掉，不会越积越多
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

const cacheable = (res) => res && res.ok && !(res.headers.get('content-type') || '').includes('text/html');

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname === '/version.json') return;
  if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/') {
    // 页面：优先联网取最新版；只缓存成功的响应，并按各自地址存放（不会把探针页或错误页当成主页）
    const key = url.pathname === '/index.html' ? '/' : url.pathname;
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key)));
    return;
  }
  // 其余静态文件：缓存优先；只缓存成功且不是网页的响应
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (cacheable(res)) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  })));
});
