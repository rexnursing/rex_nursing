// nav-guard.js
// 目的：即使主站 index.html 的導覽列在未來被其他流程重新產生、
// 移除了呼吸音連結，本腳本會在頁面載入時自動偵測並補回連結。
// 此檔案位於 breath-sounds/ 資料夾內，不受主站健康衛教發布流程影響。
(function () {
  function ensureBreathSoundsNav() {
    if (document.getElementById('nav-breath')) return; // 連結已存在，不重複加入
    var nav = document.querySelector('.main-nav') || document.querySelector('nav');
    if (!nav) return;
    var link = document.createElement('a');
    link.href = 'breath-sounds/index.html';
    link.id = 'nav-breath';
    link.textContent = '🫁 呼吸音教學';
    var healthLink = document.getElementById('nav-health');
    if (healthLink) {
      healthLink.insertAdjacentElement('afterend', link);
    } else {
      nav.appendChild(link);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureBreathSoundsNav);
  } else {
    ensureBreathSoundsNav();
  }
})();
