(function () {
  "use strict";

  var CARD_ID = "ios-app-exam-card";
  var APP_STORE_URL = "https://apps.apple.com/tw/app/rex-nursing-%E8%AD%B7%E7%90%86%E5%B8%AB%E5%9C%8B%E8%80%83%E9%A1%8C%E5%BA%AB/id6802031082";
  var INSTAGRAM_URL = "https://www.instagram.com/rex_nursing/";

  function track(eventName) {
    if (typeof window.gtag === "function") {
      window.gtag("event", eventName, { placement: "exam_download_page" });
    }
  }

  function createDownloadCard(id, titleId, placement) {
    var card = document.createElement("section");
    card.id = id;
    card.setAttribute("aria-labelledby", titleId);
    card.style.cssText =
      "background:var(--white);border:1px solid var(--bd);border-left:5px solid var(--teal);" +
      "border-radius:var(--r);padding:18px 20px;margin:0 0 24px;position:relative;z-index:2;" +
      "box-shadow:0 8px 24px rgba(31,59,92,.08)";

    card.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap">' +
        '<div style="display:flex;align-items:center;gap:14px;flex:1 1 420px;min-width:0">' +
          '<img src="favicon.png" alt="Rex Nursing App 圖示" width="58" height="58" ' +
            'style="width:58px;height:58px;border-radius:14px;flex-shrink:0;box-shadow:0 4px 12px rgba(31,59,92,.15)">' +
          '<div style="min-width:0">' +
            '<div style="font-size:10.5px;letter-spacing:.09em;font-weight:700;color:var(--teal);margin-bottom:2px">' +
              'REX NURSING · iOS APP</div>' +
            '<h3 id="' + titleId + '" style="font-size:17px;line-height:1.45;color:var(--teal-d);margin:0 0 3px">' +
              '下載 Rex Nursing iOS App</h3>' +
            '<p style="font-size:13px;line-height:1.65;color:var(--muted);margin:0">' +
              '隨時練習護理師國考題庫，免費下載。</p>' +
          '</div>' +
        '</div>' +
        '<a href="' + APP_STORE_URL + '" target="_blank" rel="noopener noreferrer" ' +
          'data-ios-app-placement="' + placement + '" ' +
          'aria-label="下載 Rex Nursing iOS App（在新分頁開啟 App Store）" ' +
          'style="display:inline-flex;align-items:center;justify-content:center;min-height:48px;' +
            'padding:0 22px;border-radius:12px;background:#111827;color:#fff;font-size:14px;' +
            'font-weight:700;text-decoration:none;white-space:nowrap;box-shadow:0 4px 12px rgba(17,24,39,.2)">' +
          'App Store 下載 →</a>' +
      '</div>';

    var link = card.querySelector("a");
    if (link) {
      link.addEventListener("click", function () {
        if (typeof window.gtag === "function") {
          window.gtag("event", "ios_app_download_click", { placement: placement });
        }
      });
    }
    return card;
  }

  function ensurePrimaryDownloadCards() {
    var homePage = document.getElementById("page-home");
    var homeHero = homePage && homePage.querySelector(".hero.hero-wrap");
    if (homeHero && !document.getElementById("ios-app-home-card")) {
      homeHero.insertAdjacentElement(
        "afterend",
        createDownloadCard("ios-app-home-card", "ios-app-home-title", "home")
      );
    }

    var quizPage = document.getElementById("page-quiz");
    var syncBar = quizPage && quizPage.querySelector("#sync-bar");
    if (syncBar && !document.getElementById("ios-app-quiz-card")) {
      syncBar.insertAdjacentElement(
        "afterend",
        createDownloadCard("ios-app-quiz-card", "ios-app-quiz-title", "quiz")
      );
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

  function initializeIosAppCards() {
    ensurePrimaryDownloadCards();
    ensureIosAppCard();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeIosAppCards, { once: true });
  } else {
    initializeIosAppCards();
  }
})();
