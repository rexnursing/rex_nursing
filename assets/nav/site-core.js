// assets/nav/site-core.js
// 全站共用導覽列（方案A分組：首頁 / 學習資源▾ / 考試工具▾ / 更多▾ / YouTube）
// + 基本防複製（右鍵選單停用；文字選取停用交由 site-nav.css 的 user-select 規則）
//
// 設計原則（請保留這段註解，未來維護時先看這裡）：
// 1. 不重新產生 <a id="nav-xxx"> 節點內容，只是把既有節點「搬移」進新的分組
//    容器，藉此完整保留原本的 onclick / href，以及可能已綁定的事件監聽器。
//    例如既有 SPA 路由高亮邏輯用的是 document.querySelectorAll('.nav-r a[id^="nav-"]')
//    這種後代選擇器，不受巢狀深度影響，完全不需要跟著修改。
// 2. 找不到的連結（例如某些頁面沒有練習考題連結）直接跳過，不會報錯。
// 3. 不在下面 GROUPS 名單內、但確實存在於 .nav-r 裡的 <a id^="nav-"> 連結
//    （例如未來新增的分類連結），會自動歸類進「更多」，不會被吃掉、也不需要
//    每次新增頁面連結都回來改這支程式。
// 4. 每次頁面載入都會重新分組一次，所以就算 index.html 被其他工具重新產生、
//    導覽列被還原成扁平清單，畫面上還是會是分組後的樣子——這是自我修復機制
//    的核心，但前提是這支檔案本身、以及 index.html 裡載入它的那一小段
//    <script> 標籤還在。如果那段標籤本身被清掉，就需要手動補回去，
//    這是目前架構已知、暫不打算解決的限制。
(function () {
  'use strict';

  var GROUPS = [
    { key: 'study', label: '學習資源', ids: ['nav-health', 'nav-breath', 'nav-ekg'] },
    { key: 'exam', label: '考試工具', ids: ['nav-exam', 'nav-quiz', 'nav-countdown', 'nav-studyplan'] },
    { key: 'more', label: '更多', ids: ['nav-playlists', 'nav-videos', 'nav-notes', 'nav-about'] }
  ];
  var FALLBACK_GROUP_KEY = 'more';
  var HOME_ID = 'nav-home';

  function buildNav() {
    var navR = document.querySelector('.nav-r');
    if (!navR) return;
    if (navR.getAttribute('data-grouped') === '1') return; // 防止重複執行

    // 1) 先把目前所有 <a> 節點（可能是扁平清單，也可能已被分組過）抓下來，
    //    這些是真實 DOM 節點物件，之後用 appendChild 搬移，不是重建字串。
    var allLinks = Array.prototype.slice.call(navR.querySelectorAll('a'));
    var byId = {};
    var ytLink = null;
    allLinks.forEach(function (a) {
      if (a.id) byId[a.id] = a;
      if (a.classList.contains('nav-yt')) ytLink = a;
    });

    var used = {};
    var groupEls = {};

    // 2) 清空 .nav-r 目前的內容（節點物件仍保留在 allLinks/byId 陣列中）
    while (navR.firstChild) navR.removeChild(navR.firstChild);

    // 3) 首頁：保持獨立、排最前面
    if (byId[HOME_ID]) {
      navR.appendChild(byId[HOME_ID]);
      used[HOME_ID] = true;
    }

    // 4) 依 GROUPS 設定建立每個分組的下拉選單
    GROUPS.forEach(function (g) {
      groupEls[g.key] = createGroup(g.label, g.key);
      g.ids.forEach(function (id) {
        if (byId[id] && !used[id]) {
          groupEls[g.key].dropdown.appendChild(byId[id]);
          used[id] = true;
        }
      });
    });

    // 5) 任何 id 以 nav- 開頭、但沒被上面任何分組收走的連結，自動歸類進
    //    「更多」（例如未來新增的健康衛教子分類），確保不會消失不見。
    allLinks.forEach(function (a) {
      if (a.id && /^nav-/.test(a.id) && !used[a.id]) {
        groupEls[FALLBACK_GROUP_KEY].dropdown.appendChild(a);
        used[a.id] = true;
      }
    });

    // 6) 依序把「實際有內容」的分組容器放回 .nav-r（避免出現空的下拉選單）
    GROUPS.forEach(function (g) {
      if (groupEls[g.key].dropdown.children.length > 0) {
        navR.appendChild(groupEls[g.key].wrapper);
      }
    });

    // 7) YouTube 連結：保持獨立、排最後
    if (ytLink) {
      navR.appendChild(ytLink);
    }

    navR.setAttribute('data-grouped', '1');
    wireInteractions(navR);
  }

  function createGroup(label, key) {
    var wrapper = document.createElement('div');
    wrapper.className = 'nav-group';
    wrapper.setAttribute('data-group', key);

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'nav-group-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-haspopup', 'true');
    toggle.innerHTML = label + ' <span class="nav-caret" aria-hidden="true">▾</span>';

    var dropdown = document.createElement('div');
    dropdown.className = 'nav-dropdown';

    wrapper.appendChild(toggle);
    wrapper.appendChild(dropdown);

    return { wrapper: wrapper, toggle: toggle, dropdown: dropdown };
  }

  function closeAllGroups(except) {
    document.querySelectorAll('.nav-group.open').forEach(function (g) {
      if (g !== except) {
        g.classList.remove('open');
        var t = g.querySelector('.nav-group-toggle');
        if (t) t.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function wireInteractions(navR) {
    // 分組標題點擊：開關自己的下拉選單，並關閉其他已開啟的分組
    navR.querySelectorAll('.nav-group-toggle').forEach(function (toggle) {
      toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        var group = toggle.closest('.nav-group');
        var willOpen = !group.classList.contains('open');
        closeAllGroups();
        if (willOpen) {
          group.classList.add('open');
          toggle.setAttribute('aria-expanded', 'true');
        }
      });
    });

    // 點擊下拉選單內的實際連結：關閉下拉選單 + 關閉手機版漢堡選單
    navR.querySelectorAll('.nav-dropdown a').forEach(function (a) {
      a.addEventListener('click', function () {
        closeAllGroups();
        navR.classList.remove('open');
      });
    });

    // 點擊選單以外的地方：關閉所有已開啟的下拉選單
    document.addEventListener('click', function (e) {
      if (!e.target.closest || !e.target.closest('.nav-group')) closeAllGroups();
    });

    // 按 Esc：關閉所有已開啟的下拉選單
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAllGroups();
    });

    // 手機版點擊漢堡選單「關閉」時，一併收合可能展開中的分組，
    // 避免下次打開時殘留上次展開的狀態。不覆寫既有 toggleNav()，
    // 只是額外掛一個監聽器。
    var navToggleBtn = document.getElementById('nav-toggle');
    if (navToggleBtn) {
      navToggleBtn.addEventListener('click', function () {
        closeAllGroups();
      });
    }
  }

  // 基本防複製：停用右鍵選單（文字選取停用交給 site-nav.css 的 user-select 規則）
  function disableContextMenu() {
    document.addEventListener('contextmenu', function (e) {
      e.preventDefault();
    });
  }

  function init() {
    buildNav();
    disableContextMenu();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
