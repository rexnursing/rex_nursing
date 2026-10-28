import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const channelId = "UCLVCrG-U0yhBAgmTVXjK59g";
const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
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

const response = await fetch(feedUrl, {
  headers: { "user-agent": "rex-nursing-site-updater/1.0" }
});
if (!response.ok) throw new Error(`YouTube feed request failed: ${response.status}`);

const xml = await response.text();
const entries = Array.from(xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g), match => match[1]);
const latestLongForm = entries
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

if (!latestLongForm) throw new Error("No regular YouTube video found in the channel feed");

const nextContent = `${JSON.stringify(latestLongForm, null, 2)}\n`;
let currentContent = "";
try {
  currentContent = await readFile(outputPath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

if (currentContent !== nextContent) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, nextContent, "utf8");
  console.log(`Updated latest regular video: ${latestLongForm.title}`);
} else {
  console.log(`Latest regular video unchanged: ${latestLongForm.title}`);
}
