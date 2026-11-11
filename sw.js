// 离线缓存：程序和词书存在手机里，没网也能打开。
// - 页面等小文件：先用缓存里的（秒开），同时在后台检查更新；发现新版本就通知页面显示“点这里刷新”。
// - 词书（.tsv，几 MB）：下载一次就一直用缓存，只有版本号（?v=）变了才重新下载，省流量。
const CACHE = 'cet6-app-v2';
const CORE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './books.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// 发现新版本时页面往往还没加载完，所以等一会儿再通知，并且发两次
function notifyUpdate() {
  const send = () => self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => cs.forEach(c => c.postMessage({ type: 'update' }))).catch(() => {});
  return new Promise(done => { setTimeout(send, 1500); setTimeout(() => send().then(done, done), 5000); });
}
const stamp = r => r && (r.headers.get('etag') || r.headers.get('last-modified') || r.headers.get('content-length'));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // GitHub 同步、发音等外部请求不经过缓存
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('.tsv')) {
    e.respondWith(caches.open(CACHE).then(async cache => {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      try {
        const r = await fetch(e.request);
        if (r && r.ok) cache.put(e.request, r.clone());
        return r;
      } catch (err) {
        const any = await cache.match(e.request, { ignoreSearch: true });      // 没网：有旧版本就先用旧的
        if (any) return any;
        throw err;
      }
    }));
    return;
  }

  const isPage = e.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
  const work = (async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(e.request, { ignoreSearch: true });
    // 后台去网上取最新的：存进缓存；如果页面变了，通知已经打开的页面
    const net = fetch(e.request).then(async r => {
      if (r && r.ok) {
        const changed = isPage && hit && stamp(hit) && stamp(r) && stamp(hit) !== stamp(r);
        await cache.put(e.request, r.clone());
        if (changed) await notifyUpdate();
      }
      return r;
    }).catch(() => hit);
    return { hit, net };
  })();
  e.respondWith(work.then(x => x.hit || x.net));
  e.waitUntil(work.then(x => x.net).catch(() => {}));       // 让后台更新做完再休眠
});

// 页面下载完词书后，让这里确认它们已经存进缓存（第一次打开时页面可能比缓存脚本先跑）
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type !== 'cache' || !Array.isArray(d.urls)) return;
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(d.urls.map(u =>
    c.match(u).then(h => h || fetch(u).then(r => { if (r && r.ok) return c.put(u, r); }).catch(() => {}))
  ))));
});
