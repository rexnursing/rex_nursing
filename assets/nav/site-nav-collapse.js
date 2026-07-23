// assets/nav/site-nav-collapse.js
// 通用「手機版漢堡收合」腳本，給沒有 .nav-r（首頁專用分組導覽列）的其他頁面用：
// 健康衛教類頁面（health.html 等、header.site > div.bar > nav 這一系列模板）、
// breath-sounds 子站（header.site-header > div.header-inner > nav.main-nav）。
// 不分組、不改變連結內容或數量，單純把現有連結包進一個可收合的容器，
// 桌面版完全不變，手機版加一顆漢堡按鈕收合/展開。
//
// 這支跟 site-core.js 是分開的兩支檔案：site-core.js 處理首頁的分組下拉選單
// （只認 .nav-r），這支處理「其他頁面那種扁平、連結數不固定的 <nav>」。
// 兩支都會各自附加防複製用的 contextmenu 阻擋（各自獨立判斷是否已執行過，
// 就算兩支都被載入到同一頁也不會重複綁定或衝突）。
(function () {
  'use strict';

  function setupCollapse(nav) {
    if (!nav || nav.getAttribute('data-collapse-init') === '1') return;
    // 不要跟首頁的分組導覽列（.nav-r）互相干擾
    if (nav.classList.contains('nav-r')) return;

    var links = Array.prototype.slice.call(nav.children);
    if (links.length === 0) return; // 空的 nav 不處理

    var wrapper = document.createElement('div');
    wrapper.className = 'simple-nav-links';
    links.forEach(function (el) { wrapper.appendChild(el); });

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'simple-nav-toggle';
    toggle.setAttribute('aria-label', '選單');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '☰';

    nav.appendChild(toggle);
    nav.appendChild(wrapper);
    nav.setAttribute('data-collapse-init', '1');

    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = wrapper.classList.toggle('open');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    wrapper.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        wrapper.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      });
    });

    document.addEventListener('click', function (e) {
      if (!e.target.closest || !e.target.closest('nav')) {
        wrapper.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        wrapper.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function disableContextMenu() {
    // 跟 site-core.js 各自獨立判斷，避免同頁同時載入兩支時重複綁定
    if (document.documentElement.getAttribute('data-copyguard-init') === '1') return;
    document.documentElement.setAttribute('data-copyguard-init', '1');
    document.addEventListener('contextmenu', function (e) {
      e.preventDefault();
    });
  }

  function init() {
    // 這幾種頁面每頁只有一個主導覽列 <nav>（跟首頁不同，首頁還有一個
    // 無關的頁尾 <nav aria-label="頁尾連結">，但頁尾連結不是這裡的處理對象）。
    // 是否為首頁的 .nav-r 交給 setupCollapse() 內部檢查並跳過，這裡不用
    // :not() 選擇器，避免多一層相依。
    var nav = document.querySelector('nav');
    setupCollapse(nav);
    disableContextMenu();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
