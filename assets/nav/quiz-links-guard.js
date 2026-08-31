// quiz-links-guard.js
// 目的：index.html 的頁尾／首頁分享連結，如果被另一個獨立運作的衛教內容發布流程
// 重新產生 index.html 時意外遺漏，這支腳本會在頁面載入時自動偵測並補回。
// 這個檔案放在 assets/nav/，跟 breath-sounds/assets/js/nav-guard.js 是同一種做法，
// 但保護的是「國考題練習分享連結」而不是導覽列模組連結。
//
// 目前保護：
//   #quiz-footer-link  （頁尾「快速連結」裡的「國考題練習」→ quiz.html）
//   #quiz-share-btn    （首頁「線上各科測驗與模擬考」區塊下方的分享練習頁按鈕 → quiz.html）
//   #quiz-115-1-link   （首頁「線上各科測驗與模擬考」區塊、分享按鈕下方的
//                        「115年第一次護理師國考題目」連結 → questions/115-1/index.html）
//
// 這支腳本只能補回「連結」本身；如果 quiz.html、quiz-share-20260830.html、
// questions/115-1/index.html 這些檔案整個被刪除，腳本無法救回，那必須從發布流程源頭
// 避免刪除檔案。
//
// 2026-08-31: 正常部署後的 index.html 原始 HTML 必須直接包含 #quiz-115-1-link 這個
// 靜態 <a href>（見部署時的 quiz-links-115-1 註解區塊），這支腳本只是連結被誤刪時的
// 備援，不能只依靠 JavaScript 動態產生。
(function () {
  var QUIZ_URL = 'quiz.html';
  var EXAM_115_1_URL = 'questions/115-1/index.html';

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

  function ensureLatestExamLink() {
    if (document.getElementById('quiz-115-1-link')) return;
    var shAccent = document.querySelector('.sh-accent');
    if (!shAccent) return;
    var textCol = shAccent.querySelector('div:last-child') || shAccent;

    var link = document.createElement('a');
    link.href = EXAM_115_1_URL;
    link.id = 'quiz-115-1-link';
    link.style.cssText = 'display:block;margin-top:10px;color:var(--teal-d);font-weight:600;font-size:14px;text-decoration:underline';
    link.textContent = '115年第一次護理師國考題目 →';

    // 優先接在分享按鈕後面，維持原本的視覺順序；分享按鈕也不在時才退回附加在文字欄位最後。
    var shareBtn = document.getElementById('quiz-share-btn');
    if (shareBtn && shareBtn.parentNode === textCol) {
      shareBtn.insertAdjacentElement('afterend', link);
    } else {
      textCol.appendChild(link);
    }
  }

  function ensureQuizLinks() {
    ensureFooterLink();
    ensureShareButton();
    ensureLatestExamLink();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureQuizLinks);
  } else {
    ensureQuizLinks();
  }
})();
