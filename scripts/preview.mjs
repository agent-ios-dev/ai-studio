import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

const root = resolve(import.meta.dirname, "..");
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
const port = Number(process.env.PREVIEW_PORT || 4173);
createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const path = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!path.startsWith(root + "\\") && path !== root) { response.writeHead(403); response.end(); return; }
  try { const data = await readFile(path); response.writeHead(200, { "Content-Type": mime[extname(path)] || "application/octet-stream" }); response.end(data); }
  catch { response.writeHead(404); response.end("Not found"); }
}).listen(port, "127.0.0.1", () => console.log(`Preview: http://localhost:${port}`));
