import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);
const mime = new Map([
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"], [".ogg", "audio/ogg"], [".mp3", "audio/mpeg"], [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".svg", "image/svg+xml"],
]);

const server = createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" }).end("Method Not Allowed");
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, `http://${host}`).pathname); }
  catch { response.writeHead(400).end("Bad Request"); return; }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) { response.writeHead(403).end("Forbidden"); return; }
  let stats;
  try { stats = statSync(target); if (!stats.isFile()) throw new Error("Not a file"); }
  catch { response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not Found"); return; }
  response.writeHead(200, {
    "content-type": mime.get(extname(target).toLowerCase()) || "application/octet-stream",
    "content-length": stats.size, "cache-control": "no-cache", "x-content-type-options": "nosniff",
  });
  if (request.method === "HEAD") response.end(); else createReadStream(target).pipe(response);
});
server.listen(port, host, () => console.log(`月蚀幸存者 · X先生  http://${host}:${port}`));


