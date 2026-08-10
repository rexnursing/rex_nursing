// sw.js — Rex Nursing 練習考題 PWA 專用 Service Worker
//
// 設計原則（刻意保守，範圍只鎖定「練習考題」相關檔案）：
// 1. 只快取跟考題離線作答有關的檔案（app shell + exam-data.js 題庫）。
//    健康衛教文章、EKG教學、呼吸音教學等其他頁面完全不攔截、不快取，
//    避免使用者離線時看到舊版衛教內容，也避免佔用不必要的裝置空間。
// 2. 跨網域請求（Firebase Auth／Firestore、Google Analytics 等）完全不攔截，
//    一律直接交給瀏覽器處理——攔截 opaque cross-origin response 容易踩雷，
//    而且登入／雲端同步本來就假設需要網路，離線時讓它自然失敗即可
//    （quiz-sync.js 那邊會自己處理離線寫入失敗、恢復連線後重試）。
// 3. exam-data.js 題庫檔案較大（~5MB，gzip後約2MB），採「先用快取、背景更新」
//    （stale-while-revalidate），並用 ETag 判斷題庫是否真的變了；
//    真的變了才會通知頁面「有新題目可用」，不會每次背景更新都打擾使用者。
// 4. app shell 檔案（index.html、quiz-sync.js等）採「先試網路、失敗才用快取」，
//    確保有網路時使用者永遠拿到 Rex 最新部署的版本，只有離線時才退回快取。

const CACHE_VERSION = "v1";
const SHELL_CACHE = "rex-quiz-shell-" + CACHE_VERSION;
const DATA_CACHE = "rex-quiz-data-" + CACHE_VERSION;

const BASE = "/rex_nursing";

const SHELL_FILES = [
  BASE + "/index.html",
  BASE + "/manifest.json",
  BASE + "/quiz-sync.js",
  BASE + "/assets/exam-schedule.js",
  BASE + "/assets/nav/site-core.js",
  BASE + "/icons/badge-small.png",
  BASE + "/icons/badge-large.png",
  BASE + "/icons/badge-mask.png",
  BASE + "/icons/badge-touch.png",
];

const DATA_FILE = BASE + "/exam-data.js";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      Promise.all(
        SHELL_FILES.map((f) =>
          cache.add(f).catch((err) => {
            // 個別檔案快取失敗不應該讓整個 SW 安裝失敗
            console.warn("[sw] 預先快取失敗，略過:", f, err);
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨網域一律不攔截

  if (url.pathname === DATA_FILE) {
    event.respondWith(cacheFirstWithRevalidate(req, event));
    return;
  }

  if (SHELL_FILES.indexOf(url.pathname) !== -1) {
    event.respondWith(networkFirstWithCacheFallback(req));
    return;
  }

  // 其他所有頁面／資源（衛教文章、EKG、呼吸音教學、影片縮圖等）：
  // 完全不攔截，維持瀏覽器原生行為。
});

async function networkFirstWithCacheFallback(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirstWithRevalidate(req, event) {
  const cache = await caches.open(DATA_CACHE);
  const cached = await cache.match(req);

  const revalidatePromise = fetch(req)
    .then(async (fresh) => {
      if (!fresh || !fresh.ok) return fresh;
      const oldEtag = cached ? cached.headers.get("etag") : null;
      const newEtag = fresh.headers.get("etag");
      await cache.put(req, fresh.clone());
      if (cached && oldEtag && newEtag && oldEtag !== newEtag) {
        notifyClients({ type: "EXAM_DATA_UPDATED" });
      }
      return fresh;
    })
    .catch(() => null);

  if (cached) {
    // 立刻回傳快取版本；背景繼續確認題庫是否有更新，不阻塞畫面載入。
    // 用 event.waitUntil() 讓瀏覽器在背景 fetch 完成前不要提早關閉 SW，
    // 否則 revalidate 可能跑到一半被中斷，永遠偵測不到題庫更新。
    event.waitUntil(revalidatePromise);
    return cached;
  }

  const fresh = await revalidatePromise;
  if (fresh) return fresh;

  // 完全沒快取過又離線：直接讓請求失敗，index.html 那邊需要能處理
  // 「exam-data.js 載入失敗」的情況（顯示「請先連網載入一次題庫」之類的提示）。
  return fetch(req);
}

async function notifyClients(msg) {
  const clientsArr = await self.clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  });
  clientsArr.forEach((c) => c.postMessage(msg));
}
