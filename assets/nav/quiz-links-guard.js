// quiz-links-guard.js
// 目的：index.html 的頁尾／首頁分享連結，如果被另一個獨立運作的衛教內容發布流程
// 重新產生 index.html 時意外遺漏，這支腳本會在頁面載入時自動偵測並補回。
// 這個檔案放在 assets/nav/，跟 breath-sounds/assets/js/nav-guard.js 是同一種做法，
// 但保護的是「國考題練習分享連結」而不是導覽列模組連結。
//
// 目前保護：
//   #quiz-footer-link  （頁尾「快速連結」裡的「國考題練習」→ quiz.html）
//   #quiz-share-btn    （首頁「線上各科測驗與模擬考」區塊下方的分享練習頁按鈕 → quiz.html）
//
// 這支腳本只能補回「連結」本身；如果 quiz.html、quiz-share-20260830.html 這些
// 檔案整個被刪除，腳本無法救回，那必須從發布流程源頭避免刪除檔案。
(function () {
  var QUIZ_URL = 'quiz.html';

  function ensureFooterLink() {
    if (document.getElementById('quiz-footer-link')) return;
    var healthFooterLink = (function () {
      var links = document.querySelectorAll('footer a[href="health.html"]');
      return links.length ? links[0] : null;
    })();
    if (!healthFooterLink || !healthFooterLink.parentNode) return;

    var link = document.createElement('a');
    link.href = QUIZ_URL;
    link.id = 'quiz-footer-link';
    link.textContent = '國考題練習';
    healthFooterLink.parentNode.insertBefore(link, healthFooterLink);
  }

  function ensureShareButton() {
    if (document.getElementById('quiz-share-btn')) return;
    var shAccent = document.querySelector('.sh-accent');
    if (!shAccent) return;
    var textCol = shAccent.querySelector('div:last-child') || shAccent;

    var btn = document.createElement('a');
    btn.href = QUIZ_URL;
    btn.id = 'quiz-share-btn';
    btn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;gap:6px;margin-top:12px;min-height:44px;padding:12px 24px;background:var(--teal);color:#fff;border-radius:50px;font-size:14.5px;font-weight:600;text-decoration:none;box-shadow:0 4px 14px rgba(75,166,161,.35)';
    btn.textContent = '📤 分享練習頁給朋友 →';
    textCol.appendChild(btn);
  }

  function ensureQuizLinks() {
    ensureFooterLink();
    ensureShareButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureQuizLinks);
  } else {
    ensureQuizLinks();
  }
})();
