(function () {
  "use strict";

  var fallbackVideo = {
    videoId: "IuGOXn0NPJw",
    title: "神經系統生解總整理 EP1｜腦、脊髓、12 對腦神經與自主神經｜睿克獅圖解護理｜Rex Nursing",
    published: "2026-10-22T02:37:39+00:00"
  };

  var heading = Array.from(document.querySelectorAll(".sh-accent h2")).find(function (node) {
    return node.textContent.trim() === "最新影片";
  });
  if (!heading) return;

  var sectionHeader = heading.closest(".sh-accent");
  var videoGrid = sectionHeader && sectionHeader.nextElementSibling;
  if (!videoGrid || !videoGrid.classList.contains("vids")) return;

  var description = sectionHeader.querySelector("p");
  if (description) description.textContent = "自動同步最新一般影片（不含 Shorts）";

  function validVideo(data) {
    return data && /^[A-Za-z0-9_-]{11}$/.test(data.videoId) && typeof data.title === "string";
  }

  function render(data) {
    if (!validVideo(data)) return;

    videoGrid.style.gridTemplateColumns = "1fr";
    videoGrid.replaceChildren();

    var card = document.createElement("div");
    card.className = "vcard";
    card.style.cursor = "default";
    card.style.transform = "none";

    var frameWrap = document.createElement("div");
    frameWrap.style.cssText = "position:relative;width:100%;aspect-ratio:16/9;background:#111";

    var frame = document.createElement("iframe");
    frame.src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(data.videoId) + "?rel=0";
    frame.title = data.title;
    frame.loading = "lazy";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    frame.allowFullscreen = true;
    frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0";

    var info = document.createElement("div");
    info.className = "vinfo";

    var title = document.createElement("h3");
    title.textContent = data.title;

    var meta = document.createElement("div");
    meta.className = "vmeta";

    var status = document.createElement("span");
    status.className = "tag";
    status.style.cssText = "background:var(--teal-l);color:var(--teal-d)";
    status.textContent = "一般影片 · 不含 Shorts";

    var videoLink = document.createElement("a");
    videoLink.href = "https://www.youtube.com/watch?v=" + encodeURIComponent(data.videoId);
    videoLink.target = "_blank";
    videoLink.rel = "noopener noreferrer";
    videoLink.textContent = "在 YouTube 觀看 →";
    videoLink.style.cssText = "color:var(--teal);text-decoration:none";

    frameWrap.appendChild(frame);
    meta.append(status, videoLink);
    info.append(title, meta);
    card.append(frameWrap, info);
    videoGrid.appendChild(card);
  }

  render(fallbackVideo);

  fetch("assets/latest-video.json?v=20261028-longform2", { cache: "no-store" })
    .then(function (response) {
      if (!response.ok) throw new Error("Latest video data unavailable");
      return response.json();
    })
    .then(function (data) {
      if (validVideo(data)) render(data);
    })
    .catch(function () {
      // Keep the known-good fallback video when the generated data cannot load.
    });
})();
