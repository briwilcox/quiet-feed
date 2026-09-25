// Serves the content-script browser tests. The page must live at /home because
// the content script only runs on X's home timeline path.
//   node scripts/test-server.mjs   ->  http://localhost:4173/home
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 4173);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const ALLOWED = ["dist/", "test/browser/"];

createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const rel = ["/home", "/explore"].includes(path) ? "test/browser/feed.html" : normalize(path.slice(1));
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT) || !ALLOWED.some((p) => rel.startsWith(p))) {
    res.writeHead(404).end("not found");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Browser tests: http://localhost:${PORT}/home`));
