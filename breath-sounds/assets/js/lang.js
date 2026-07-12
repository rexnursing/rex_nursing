// 語言切換：以 <html data-active-lang="zh|en"> 控制全站顯示語言，記錄在 localStorage
(function () {
  var KEY = "breathsounds_lang";

  function applyLang(lang) {
    document.documentElement.setAttribute("data-active-lang", lang);
    var btn = document.getElementById("lang-toggle");
    if (btn) {
      btn.textContent = lang === "zh" ? "EN" : "中文";
      btn.setAttribute("aria-label", lang === "zh" ? "Switch to English" : "切換為中文");
    }
    document.querySelectorAll("audio").forEach(function (a) {
      // no-op placeholder for future per-language audio captions if needed
    });
  }

  function getSavedLang() {
    try {
      return localStorage.getItem(KEY) || "zh";
    } catch (e) {
      return "zh";
    }
  }

  function saveLang(lang) {
    try {
      localStorage.setItem(KEY, lang);
    } catch (e) {}
  }

  document.addEventListener("DOMContentLoaded", function () {
    var current = getSavedLang();
    applyLang(current);

    var btn = document.getElementById("lang-toggle");
    if (btn) {
      btn.addEventListener("click", function () {
        var now = document.documentElement.getAttribute("data-active-lang") === "zh" ? "en" : "zh";
        applyLang(now);
        saveLang(now);
      });
    }
  });
})();
