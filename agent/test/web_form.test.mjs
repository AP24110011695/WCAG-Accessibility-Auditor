// Test 10: P1-T3 New Audit form — keyboard-only dispatch against a mock
// trigger-audit Edge Function, announced inline validation errors, and the
// Queued → running transition via status polling (design.md Queued state).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { chromium } from "playwright";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };

test("New Audit form: keyboard dispatch, announced validation errors, queued→running transition", async () => {
  // Mock Supabase + static dist host. Built after the server binds so the mock
  // URL can be baked in as VITE_SUPABASE_URL.
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "web-form-"));
  const distDir = path.join(tmpBase, "dist");
  const state = { runStatus: "pending", triggerPosts: [] };
  const runRow = () => ({
    run_id: "run-form-1",
    target_level: "WCAG2.2-AA",
    status: state.runStatus,
    plan_json: [],
    created_at: new Date().toISOString(),
    config_json: {},
  });
  const server = createServer(async (req, res) => {
    const body = await new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/functions/v1/trigger-audit" && req.method === "POST") {
      state.triggerPosts.push(JSON.parse(body.toString()));
      state.runStatus = "pending";
      // Worker picks the run up shortly after dispatch: status moves off pending.
      setTimeout(() => { state.runStatus = "finding"; }, 800);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ run_id: "run-form-1", status: "pending" }));
    }
    const m = url.pathname.match(/^\/rest\/v1\/(\w+)/);
    if (m) {
      const table = m[1];
      const json = (rows) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(rows)); };
      if (table === "runs") {
        if (url.searchParams.get("select") === "run_id") return json(state.triggerPosts.length > 0 ? [{ run_id: "run-form-1" }] : []);
        return json([runRow()]);
      }
      return json([]);
    }
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.join(distDir, rel);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });

  try {
    execFileSync(
      process.execPath,
      [path.resolve("..", "node_modules/vite/bin/vite.js"), "build", "--outDir", distDir],
      {
        cwd: path.resolve("..", "web"),
        env: {
          ...process.env,
          VITE_DATA_PROVIDER: "supabase",
          VITE_SUPABASE_URL: base,
          VITE_SUPABASE_PUBLISHABLE_KEY: "test-key",
          VITE_POLL_MS: "300",
        },
        stdio: "pipe",
      },
    );

    const page = await browser.newPage();
    await page.goto(base);

    // Empty state hosts the form — the first audit can only start from there.
    await page.waitForSelector("#audit-urls");
    assert.equal(await page.getAttribute("#audit-urls", "aria-invalid"), "false", "No error state before submission");

    // 1. Invalid input blocks start (FR-01): submit an invalid URL by keyboard.
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "audit-urls", "Tab must reach the URL field first");
    await page.keyboard.type("not a url");
    await page.keyboard.press("Tab"); // target-level select
    await page.keyboard.press("Tab"); // Start audit button
    await page.keyboard.press("Enter");

    const alertLoc = page.locator("#audit-urls-error");
    await alertLoc.waitFor({ timeout: 5000 });
    assert.match(await alertLoc.innerText(), /Not a valid URL: not a url/, "Inline error names the bad URL");
    assert.equal(await page.getAttribute("#audit-urls", "aria-invalid"), "true", "Field marked aria-invalid");
    assert.equal(await alertLoc.getAttribute("role"), "alert", "Errors announced via role=alert");
    assert.equal(state.triggerPosts.length, 0, "Invalid input must not reach the trigger endpoint");

    // 2. Keyboard-only valid submission (no mouse anywhere).
    await page.keyboard.press("Shift+Tab"); // back to select
    await page.keyboard.press("Shift+Tab"); // back to textarea
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("http://127.0.0.1:9/demo/modal.html");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");

    await page.waitForFunction(() => document.querySelector("#audit-urls")?.getAttribute("aria-invalid") === "false", undefined, { timeout: 5000 }).catch(() => {});
    assert.equal(state.triggerPosts.length, 1, "Valid submission dispatches exactly one trigger call");
    assert.deepEqual(state.triggerPosts[0], { urls: ["http://127.0.0.1:9/demo/modal.html"], target_level: "WCAG2.2-AA" });

    // 3. Queued state appears while the worker picks up the dispatch.
    await page.waitForSelector("text=Queued — the worker starts in under a minute typically", { timeout: 5000 });
    await page.waitForSelector("text=run-form-1", { timeout: 5000 });

    // 4. Poll moves the panel off queued once the run status changes.
    await page.waitForSelector("text=Queued — the worker starts in under a minute typically", { state: "detached", timeout: 10000 });
    await page.waitForSelector("text=is running — results shown below", { timeout: 5000 });
    await page.waitForSelector("text=FINDING", { timeout: 5000 }); // status chip, uppercased
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
