// 純 Node 內建 http 模組寫的靜態檔案伺服器，只給瀏覽器驗收測試
// （acceptance.mjs）在本機起一個暫時的伺服器用，不依賴 python3 或任何額外
// 套件——這樣 Rex 在 Windows 上只要有 Node（專案本來就已經要求要有），不需要
// 另外裝 python 也能重跑整套測試。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

export function startServer(rootDir, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        let urlPath = decodeURIComponent((req.url || "/").split("?")[0].split("#")[0]);
        if (urlPath === "/") urlPath = "/index.html";
        const filePath = path.join(rootDir, urlPath);
        // 防止路徑跳脫到 rootDir 以外（雖然這裡只是本機測試用的暫時伺服器，
        // 還是養成不要相信 request path 的習慣）。
        if (!filePath.startsWith(rootDir)) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }
        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end("Not found: " + urlPath);
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
          res.end(data);
        });
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
