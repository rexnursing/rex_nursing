(function () {
  "use strict";

  var uploadsPlaylistId = "UULVCrG-U0yhBAgmTVXjK59g";
  var heading = Array.from(document.querySelectorAll(".sh-accent h2")).find(function (node) {
    return node.textContent.trim() === "最新影片";
  });

  if (!heading) return;

  var sectionHeader = heading.closest(".sh-accent");
  var videoGrid = sectionHeader && sectionHeader.nextElementSibling;
  if (!videoGrid || !videoGrid.classList.contains("vids")) return;

  var description = sectionHeader.querySelector("p");
  if (description) description.textContent = "自動同步 YouTube 頻道最新公開影片";

  videoGrid.style.gridTemplateColumns = "1fr";
  videoGrid.replaceChildren();

  var card = document.createElement("div");
  card.className = "vcard";
  card.style.cursor = "default";
  card.style.transform = "none";

  var frameWrap = document.createElement("div");
  frameWrap.style.cssText = "position:relative;width:100%;aspect-ratio:16/9;background:#111";

  var frame = document.createElement("iframe");
  frame.src = "https://www.youtube-nocookie.com/embed/videoseries?list=" +
    encodeURIComponent(uploadsPlaylistId) + "&rel=0";
  frame.title = "Rex Nursing 最新上傳影片";
  frame.loading = "lazy";
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  frame.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
  frame.allowFullscreen = true;
  frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0";

  var info = document.createElement("div");
  info.className = "vinfo";

  var title = document.createElement("h3");
  title.textContent = "YouTube 最新上傳（自動同步）";

  var meta = document.createElement("div");
  meta.className = "vmeta";

  var status = document.createElement("span");
  status.className = "tag";
  status.style.cssText = "background:var(--teal-l);color:var(--teal-d)";
  status.textContent = "即時更新";

  var channelLink = document.createElement("a");
  channelLink.href = "https://www.youtube.com/@rexnursing/videos";
  channelLink.target = "_blank";
  channelLink.rel = "noopener noreferrer";
  channelLink.textContent = "前往 YouTube 查看全部影片 →";
  channelLink.style.cssText = "color:var(--teal);text-decoration:none";

  frameWrap.appendChild(frame);
  meta.append(status, channelLink);
  info.append(title, meta);
  card.append(frameWrap, info);
  videoGrid.appendChild(card);
})();
