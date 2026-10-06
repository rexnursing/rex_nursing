(function () {
  "use strict";

  var CARD_ID = "ios-app-exam-card";
  var APP_STORE_URL = "https://apps.apple.com/tw/app/id6802031082";
  var INSTAGRAM_URL = "https://www.instagram.com/rex_nursing/";

  function track(eventName) {
    if (typeof window.gtag === "function") {
      window.gtag("event", eventName, { placement: "exam_download_page" });
    }
  }

  function ensureIosAppCard() {
    if (document.getElementById(CARD_ID)) return;

    var page = document.getElementById("page-exam");
    if (!page) return;

    var driveLink = page.querySelector(
      'a[href*="drive.google.com/drive/folders/1hUAH6C6bS-JVGH3QVpT8ngUgWBobYTxW"]'
    );
    var downloadCard = driveLink && driveLink.closest("div");
    if (!downloadCard) return;

    var card = document.createElement("section");
    card.id = CARD_ID;
    card.setAttribute("aria-labelledby", "ios-app-exam-title");
    card.style.cssText =
      "background:linear-gradient(135deg,#1F3B5C,#285f78);" +
      "border-radius:var(--r);padding:28px 30px;margin:0 0 20px;color:#fff;" +
      "box-shadow:0 10px 28px rgba(31,59,92,.16)";

    card.innerHTML =
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:22px;flex-wrap:wrap">' +
        '<div style="flex:1 1 360px">' +
          '<div style="display:inline-flex;align-items:center;gap:7px;background:rgba(255,255,255,.13);' +
            'border:1px solid rgba(255,255,255,.2);border-radius:999px;padding:5px 12px;' +
            'font-size:11.5px;font-weight:700;letter-spacing:.06em;margin-bottom:12px">' +
            '📱 iOS APP 已上架</div>' +
          '<h3 id="ios-app-exam-title" style="font-family:\'Noto Serif TC\',serif;font-size:20px;' +
            'line-height:1.5;color:#fff;margin:0 0 8px">Rex Nursing 護理師國考題庫</h3>' +
          '<p style="font-size:13.5px;line-height:1.85;color:rgba(255,255,255,.82);margin:0">' +
            '使用 iPhone／iPad 隨時練習歷屆國考題、模擬考、錯題本與學習紀錄，' +
            '通勤或離線時也能繼續複習。</p>' +
        '</div>' +
        '<div style="flex:0 1 auto;align-self:center">' +
          '<a id="ios-app-store-download" href="' + APP_STORE_URL + '" target="_blank" ' +
            'rel="noopener noreferrer" style="display:inline-flex;align-items:center;justify-content:center;' +
            'min-height:48px;padding:0 24px;border-radius:999px;background:#fff;color:#1F3B5C;' +
            'font-size:14px;font-weight:700;text-decoration:none;white-space:nowrap">' +
            'App Store 免費下載 →</a>' +
        '</div>' +
      '</div>' +
      '<div style="margin-top:20px;padding:16px 18px;border-radius:12px;background:rgba(255,255,255,.1);' +
        'border:1px solid rgba(255,255,255,.16);font-size:13px;line-height:1.8;color:rgba(255,255,255,.9)">' +
        '<strong style="color:#fff">已購買 Rex Nursing 講義？</strong><br>' +
        '可透過原購買管道或 <a id="ios-premium-claim" href="' + INSTAGRAM_URL + '" target="_blank" ' +
          'rel="noopener noreferrer" style="color:#9fe1cb;font-weight:700">Instagram 私訊 Rex</a>，' +
        '提供訂單資訊核對後，索取 iOS Premium 免費 1 個月專屬兌換連結。' +
        '每位符合資格者限領一次，一個月期滿後不會自動續訂或扣款。' +
      '</div>' +
      '<p style="font-size:11.5px;line-height:1.7;color:rgba(255,255,255,.62);margin:10px 2px 0">' +
        '目前下載與講義 Premium 優惠適用於 iPhone／iPad 版本。</p>';

    downloadCard.insertAdjacentElement("afterend", card);

    var downloadButton = document.getElementById("ios-app-store-download");
    var claimLink = document.getElementById("ios-premium-claim");
    if (downloadButton) {
      downloadButton.addEventListener("click", function () {
        track("ios_app_download_click");
      });
    }
    if (claimLink) {
      claimLink.addEventListener("click", function () {
        track("premium_claim_click");
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureIosAppCard, { once: true });
  } else {
    ensureIosAppCard();
  }
})();
