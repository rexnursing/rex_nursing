import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const channelId = "UCLVCrG-U0yhBAgmTVXjK59g";
const feedUrl = process.env.YOUTUBE_FEED_URL ||
  `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
const videosPageUrl = process.env.YOUTUBE_VIDEOS_URL ||
  "https://www.youtube.com/@rexnursing/videos?view=0&sort=dd&flow=grid";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(projectRoot, "assets/latest-video.json");

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function textOf(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? decodeXml(match[1].trim()) : "";
}

const wait = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));

async function loadFeed() {
  const retryDelays = process.env.YOUTUBE_RETRY_DELAYS_MS
    ? process.env.YOUTUBE_RETRY_DELAYS_MS.split(",").map(value => Number.parseInt(value, 10))
    : [0, 2000, 5000, 10000];
  let lastError;

  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    if (retryDelays[attempt]) await wait(retryDelays[attempt]);

    try {
      const separator = feedUrl.includes("?") ? "&" : "?";
      const requestUrl = `${feedUrl}${separator}_=${Date.now()}`;
      const response = await fetch(requestUrl, {
        headers: {
          accept: "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
          "cache-control": "no-cache",
          "user-agent": "Mozilla/5.0 (compatible; RexNursingSiteUpdater/1.1)"
        }
      });

      if (response.ok) return await response.text();
      lastError = new Error(`YouTube feed request failed: ${response.status}`);
      console.warn(`YouTube feed attempt ${attempt + 1}/${retryDelays.length} returned ${response.status}.`);
    } catch (error) {
      lastError = error;
      console.warn(`YouTube feed attempt ${attempt + 1}/${retryDelays.length} failed: ${error.message}`);
    }
  }

  console.warn(
    `YouTube RSS unavailable after ${retryDelays.length} attempts: ` +
    `${lastError?.message || "Unknown error"}. Trying the channel Videos page fallback.`
  );
  return null;
}

function latestVideoFromFeed(xml) {
  const entries = Array.from(xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g), match => match[1]);
  return entries
    .map(entry => {
      const linkMatch = entry.match(/<link\s+rel="alternate"\s+href="([^"]+)"\s*\/>/);
      return {
        videoId: textOf(entry, "yt:videoId"),
        title: textOf(entry, "title"),
        published: textOf(entry, "published"),
        url: linkMatch ? decodeXml(linkMatch[1]) : ""
      };
    })
    .find(video => video.url.includes("/watch?v=") && /^[A-Za-z0-9_-]{11}$/.test(video.videoId));
}

async function loadVideosPageFallback() {
  try {
    const separator = videosPageUrl.includes("?") ? "&" : "?";
    const response = await fetch(`${videosPageUrl}${separator}_=${Date.now()}`, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "zh-TW,zh;q=0.9,en;q=0.8",
        "cache-control": "no-cache",
        "user-agent": "Mozilla/5.0 (compatible; RexNursingSiteUpdater/1.1)"
      }
    });
    if (!response.ok) throw new Error(`YouTube Videos page request failed: ${response.status}`);

    const html = await response.text();
    const marker = "var ytInitialData = ";
    const dataStart = html.indexOf(marker);
    if (dataStart === -1) throw new Error("ytInitialData was not found");
    const jsonStart = dataStart + marker.length;
    const jsonEnd = html.indexOf(";</script>", jsonStart);
    if (jsonEnd === -1) throw new Error("ytInitialData boundary was not found");

    const initialData = JSON.parse(html.slice(jsonStart, jsonEnd));
    let latestLockup;
    function walk(value) {
      if (latestLockup || !value || typeof value !== "object") return;
      const lockup = value.lockupViewModel;
      if (lockup?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO" &&
          /^[A-Za-z0-9_-]{11}$/.test(lockup.contentId || "")) {
        latestLockup = lockup;
        return;
      }
      for (const child of Object.values(value)) walk(child);
    }
    walk(initialData);

    const videoId = latestLockup?.contentId || "";
    const title = latestLockup?.metadata?.lockupMetadataViewModel?.title?.content || "";
    if (!videoId || !title) throw new Error("Latest regular video was not found in the Videos page");

    console.log(`Videos page fallback found: ${title}`);
    return {
      videoId,
      title,
      published: "",
      url: `https://www.youtube.com/watch?v=${videoId}`
    };
  } catch (error) {
    console.warn(`YouTube Videos page fallback failed: ${error.message}`);
    return null;
  }
}

async function main() {
  let currentContent = "";
  let currentVideo = null;
  try {
    currentContent = await readFile(outputPath, "utf8");
    currentVideo = JSON.parse(currentContent);
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }

  const xml = await loadFeed();
  const latestLongForm = (xml && latestVideoFromFeed(xml)) || await loadVideosPageFallback();

  if (!latestLongForm) {
    console.warn(
      "::warning title=YouTube temporarily unavailable::RSS and the Videos page fallback both failed. " +
      "Keeping the last known regular video; the next scheduled run will retry."
    );
    return;
  }

  if (!latestLongForm.published) {
    latestLongForm.published = currentVideo?.videoId === latestLongForm.videoId && currentVideo.published
      ? currentVideo.published
      : new Date().toISOString();
  }

  const nextContent = `${JSON.stringify(latestLongForm, null, 2)}\n`;
  if (currentContent !== nextContent) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, nextContent, "utf8");
    console.log(`Updated latest regular video: ${latestLongForm.title}`);
  } else {
    console.log(`Latest regular video unchanged: ${latestLongForm.title}`);
  }
}

await main();
