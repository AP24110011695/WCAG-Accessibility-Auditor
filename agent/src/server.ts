import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import fs, { existsSync } from "node:fs";
import path, { resolve, join, extname } from "node:path";
import { LocalStore } from "./store/index.ts";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
};

import { getRootDir } from "./paths.ts";

function resolveOutputDir(): string {
  return getRootDir("output");
}

function resolveDistDir(): string {
  return getRootDir("web/dist");
}

function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try {
        res(raw ? JSON.parse(raw) : {});
      } catch (err) {
        rej(err);
      }
    });
    req.on("error", rej);
  });
}

function findRunStorePath(outputDir: string, runId: string): string | null {
  const direct = path.join(outputDir, runId, "store.json");
  if (existsSync(direct)) return direct;
  const official = path.join(outputDir, "official", runId, "store.json");
  if (existsSync(official)) return official;
  return null;
}

function findRunBaseDir(outputDir: string, runId: string): string {
  if (existsSync(path.join(outputDir, runId, "store.json"))) return outputDir;
  if (existsSync(path.join(outputDir, "official", runId, "store.json"))) return path.join(outputDir, "official");
  return outputDir;
}

export function createAuditServer(customOutputDir?: string, customDistDir?: string) {
  const outputDir = customOutputDir ?? resolveOutputDir();
  const distDir = customDistDir ?? resolveDistDir();

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = parsedUrl.pathname;

    // CORS headers for local dev flexibility
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // API: List runs
    if (pathname === "/api/runs" && req.method === "GET") {
      const runDirs: string[] = [];
      const scan = (d: string) => {
        if (!existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory() && e.name.startsWith("run-") && !runDirs.includes(e.name)) {
            runDirs.push(e.name);
          }
        }
      };
      scan(outputDir);
      scan(path.join(outputDir, "official"));
      runDirs.sort().reverse();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(runDirs));
      return;
    }

    // API: Get run document (defaults to latest)
    if (pathname === "/api/run" && req.method === "GET") {
      let runId = parsedUrl.searchParams.get("id");
      if (!runId) {
        const runDirs: string[] = [];
        const scan = (d: string) => {
          if (!existsSync(d)) return;
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory() && e.name.startsWith("run-") && !runDirs.includes(e.name)) {
              runDirs.push(e.name);
            }
          }
        };
        scan(outputDir);
        scan(path.join(outputDir, "official"));
        runDirs.sort().reverse();
        runId = runDirs[0] ?? null;
      }
      if (!runId) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no_runs_found" }));
        return;
      }

      const storePath = findRunStorePath(outputDir, runId);
      if (!storePath || !existsSync(storePath)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Run ${runId} not found` }));
        return;
      }
      const raw = fs.readFileSync(storePath, "utf-8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(raw);
      return;
    }

    // API: Approve or reject action
    if (pathname === "/api/action/approve" && req.method === "POST") {
      try {
        const body = await parseJsonBody(req);
        const { run_id, action_id, decision, approver_name, reason } = body as {
          run_id: string;
          action_id: string;
          decision: "approve" | "reject";
          approver_name: string;
          reason?: string;
        };
        if (!run_id || !action_id || !decision || !approver_name) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing required fields" }));
          return;
        }
        const store = await LocalStore.open(findRunBaseDir(outputDir, run_id), run_id);
        const approval = await store.approveAction(action_id, decision, approver_name, reason);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, approval }));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // API: Execute approved action
    if (pathname === "/api/action/execute" && req.method === "POST") {
      try {
        const body = await parseJsonBody(req);
        const { run_id, action_id } = body as { run_id: string; action_id: string };
        if (!run_id || !action_id) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing run_id or action_id" }));
          return;
        }
        const store = await LocalStore.open(findRunBaseDir(outputDir, run_id), run_id);
        const result = await store.executeApprovedAction(action_id);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // Serve static files from output/ (evidence, videos, screenshots)
    if (pathname.startsWith("/output/")) {
      const rel = pathname.slice("/output/".length);
      let filePath = resolve(join(outputDir, rel));
      if (!existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        const officialCandidate = resolve(join(outputDir, "official", rel));
        if (existsSync(officialCandidate) && !fs.statSync(officialCandidate).isDirectory()) {
          filePath = officialCandidate;
        }
      }
      if (!filePath.startsWith(outputDir) || !existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      const ext = extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // Serve static files from web/dist
    if (existsSync(distDir)) {
      const rel = pathname === "/" ? "index.html" : pathname.slice(1);
      let filePath = resolve(join(distDir, rel));
      if (!filePath.startsWith(distDir) || !existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = join(distDir, "index.html");
      }
      if (existsSync(filePath)) {
        const ext = extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  return server;
}

export function startServer(port = 4173, outputDir?: string, distDir?: string): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const server = createAuditServer(outputDir, distDir);
  return new Promise((resolvePromise) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolvePromise({
        url: `http://127.0.0.1:${actualPort}`,
        port: actualPort,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

// Standalone runner
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  const port = Number(process.env.PORT || 4173);
  startServer(port).then(({ url }) => {
    console.log(`Sunflower Audit server listening at ${url}`);
  });
}
