// pwa-init.js — Rex Nursing 練習考題 PWA
// 負責：Service Worker 註冊與更新、安裝提示（Android原生 + iOS圖文教學）、
// 題庫更新通知橫幅。
//
// 獨立成單一檔案、所有 UI 都用 DOM API 動態注入，不直接改 index.html
// 既有結構——原因跟 quiz-sync.js 開頭註解一樣：index.html 由 Rex 另一個
// 衛教工具定期整份重新產生，寫死在靜態內容裡的東西容易被蓋掉；
// index.html 那邊只需要一行 <script src="pwa-init.js" defer></script>。

(function () {
  "use strict";

  function isStandalone() {
    return (
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      window.navigator.standalone === true
    );
  }

  function isIOS() {
    var ua = navigator.userAgent || "";
    var isIOSUA = /iphone|ipad|ipod/i.test(ua) && !window.MSStream;
    var isIPadOS13Plus = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    return isIOSUA || isIPadOS13Plus;
  }

  function onQuizPageActive() {
    var el = document.getElementById("page-quiz");
    return !!(el && el.classList.contains("active"));
  }

  if ("serviceWorker" in navigator) {
    var refreshingAfterUpdate = false;

    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (refreshingAfterUpdate) return;
      refreshingAfterUpdate = true;
      location.reload();
    });

    window.addEventListener("load", function () {
      navigator.serviceWorker
        .register("/rex_nursing/sw.js")
        .then(function (reg) {
          reg.addEventListener("updatefound", function () {
            var newWorker = reg.installing;
            if (!newWorker) return;
            newWorker.addEventListener("statechange", function () {
              if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
                newWorker.postMessage("SKIP_WAITING");
              }
            });
          });
        })
        .catch(function (err) {
          console.warn("[pwa-init] Service Worker 註冊失敗", err);
        });

      navigator.serviceWorker.addEventListener("message", function (event) {
        if (event.data && event.data.type === "EXAM_DATA_UPDATED") {
          showUpdateBanner();
        }
      });
    });
  }

  function ensureBannerContainer() {
    var el = document.getElementById("pwa-banner-root");
    if (el) return el;
    el = document.createElement("div");
    el.id = "pwa-banner-root";
    el.style.cssText =
      "position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;" +
      "display:flex;flex-direction:column;gap:8px;pointer-events:none";
    document.body.appendChild(el);
    return el;
  }

  function makeBanner(html) {
    var root = ensureBannerContainer();
    var card = document.createElement("div");
    card.style.cssText =
      "pointer-events:auto;background:#fff;border:1px solid var(--bd,#e5e0d5);" +
      "border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.15);" +
      "padding:12px 14px;font-size:13.5px;line-height:1.5;color:var(--text,#2b2b2b);" +
      "display:flex;align-items:center;gap:10px;max-width:480px;margin:0 auto;width:100%;" +
      "font-family:inherit;box-sizing:border-box";
    card.innerHTML = html;
    root.appendChild(card);
    return card;
  }

  var deferredPrompt = null;
  var DISMISS_KEY = "rex_pwa_install_dismissed_at";
  var DISMISS_DAYS = 14;

  function wasDismissedRecently() {
    try {
      var t = localStorage.getItem(DISMISS_KEY);
      if (!t) return false;
      var elapsedDays = (Date.now() - parseInt(t, 10)) / 86400000;
      return elapsedDays < DISMISS_DAYS;
    } catch (e) {
      return false;
    }
  }

  function markDismissed() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch (e) {}
  }

  function showInstallBanner() {
    if (isStandalone() || wasDismissedRecently()) return;
    if (document.getElementById("pwa-install-banner")) return;

    var iOSDevice = isIOS();
    if (!iOSDevice && !deferredPrompt) return;

    var card = makeBanner(
      iOSDevice
        ? '<div style="flex:1">📲 把「練習考題」加到主畫面，下次一鍵打開。<br>' +
          '<span style="color:var(--muted,#8a8577)">點畫面下方的分享圖示 ⬆️ →「加入主畫面」</span></div>' +
          '<button type="button" id="pwa-dismiss-btn" aria-label="關閉" style="border:none;background:none;font-size:18px;cursor:pointer;color:var(--muted,#8a8577);flex-shrink:0">✕</button>'
        : '<div style="flex:1">📲 把「練習考題」安裝到手機，下次一鍵打開、支援離線刷題。</div>' +
          '<button type="button" id="pwa-install-btn" style="background:var(--teal,#4BA6A1);color:#fff;border:none;border-radius:20px;padding:7px 14px;font-size:13px;cursor:pointer;white-space:nowrap;flex-shrink:0">安裝</button>' +
          '<button type="button" id="pwa-dismiss-btn" aria-label="關閉" style="border:none;background:none;font-size:18px;cursor:pointer;color:var(--muted,#8a8577);flex-shrink:0">✕</button>'
    );
    card.id = "pwa-install-banner";

    var dismissBtn = card.querySelector("#pwa-dismiss-btn");
    if (dismissBtn) {
      dismissBtn.onclick = function () {
        markDismissed();
        card.remove();
      };
    }
    var installBtn = card.querySelector("#pwa-install-btn");
    if (installBtn) {
      installBtn.onclick = function () {
        if (!deferredPrompt) return;
        var promptEvent = deferredPrompt;
        deferredPrompt = null;
        promptEvent.prompt();
        promptEvent.userChoice.finally(function () {
          card.remove();
        });
      };
    }
  }

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (onQuizPageActive()) showInstallBanner();
  });

  window.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    var el = document.getElementById("pwa-install-banner");
    if (el) el.remove();
  });

  function checkAndMaybeShowOnQuizPage() {
    setTimeout(function () {
      if (!onQuizPageActive()) return;
      if (isIOS() || deferredPrompt) showInstallBanner();
    }, 300);
  }
  window.addEventListener("hashchange", checkAndMaybeShowOnQuizPage);
  window.addEventListener("load", checkAndMaybeShowOnQuizPage);

  function showUpdateBanner() {
    if (document.getElementById("pwa-update-banner")) return;
    var card = makeBanner(
      '<div style="flex:1">🆕 題庫有更新囉！</div>' +
        '<button type="button" id="pwa-refresh-btn" style="background:var(--teal,#4BA6A1);color:#fff;border:none;border-radius:20px;padding:7px 14px;font-size:13px;cursor:pointer;white-space:nowrap;flex-shrink:0">重新整理</button>'
    );
    card.id = "pwa-update-banner";
    card.querySelector("#pwa-refresh-btn").onclick = function () {
      location.reload();
    };
  }
})();
