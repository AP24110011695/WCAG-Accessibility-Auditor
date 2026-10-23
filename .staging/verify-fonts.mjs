// One-off P0-T6 verification (gitignored): serves web/dist and asserts the
// self-hosted fonts load with zero external font requests.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";

const dist = resolve(import.meta.dirname, "..", "web", "dist");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };

const server = createServer(async (req, res) => {
  try {
    const path = req.url.split("?")[0];
    const file = resolve(dist, path === "/" ? "index.html" : "." + path);
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(4179, r));

const browser = await chromium.launch();
const page = await browser.newPage();
const fontRequests = [];
page.on("request", (r) => { if (/fonts\.googleapis|fonts\.gstatic/.test(r.url())) fontRequests.push(r.url()); });
await page.goto("http://127.0.0.1:4179/");
await page.evaluate(() => document.fonts.ready);
const loaded = await page.evaluate(() => ({
  sans: document.fonts.check("400 16px 'IBM Plex Sans'"),
  mono: document.fonts.check("400 14px 'IBM Plex Mono'"),
  fraunces: document.fonts.check("560 20px Fraunces"),
}));

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failures++; };
check("IBM Plex Sans loads", loaded.sans);
check("no external font requests", fontRequests.length === 0);
console.log(`INFO  Fraunces/Mono loaded: ${loaded.fraunces}/${loaded.mono} (they lazy-load; verified fully once screens use them — see P1-T3+)`);

await browser.close();
server.close();
process.exit(failures === 0 ? 0 : 1);
