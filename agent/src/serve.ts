// Local static server so the agent can audit demo-site/ over real http
// (fetch() cannot read file:// URLs). Dev-only helper.
import { createServer, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, extname, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".png": "image/png", ".svg": "image/svg+xml", ".webm": "video/webm",
  ".json": "application/json",
};

interface LocalServer {
  url: string;
  close(): Promise<void>;
}

export function serveDir(dir: string): Promise<LocalServer> {
  const root = resolve(dir);
  const server: Server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
      const file = resolve(join(root, path === "/" ? "index.html" : "." + path));
      if (file !== root && !file.startsWith(root + sep)) throw new Error("outside root");
      await stat(file);
      const buf = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream" });
      res.end(buf);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      r({ url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}
