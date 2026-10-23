import assert from "node:assert/strict";
import test from "node:test";
import { loadWorkerRun } from "../src/worker_run.ts";

// Minimal fake of a store whose persisted run row can be tampered with —
// no Supabase and no browser involved: the refusal must happen in the
// loader, before runAudit would ever launch Chromium.
function storeWithRun(config) {
  return {
    read: async () => ({
      runs: [{
        run_id: "run-tamper",
        created_at: "2026-01-01T00:00:00Z",
        target_level: config.target_level,
        status: "pending",
        config_json: config,
        trigger_source: "edge_function",
      }],
      page_inputs: [], sources: [], findings: [], decisions: [], evidence: [], actions: [], approvals: [], issues: [], retests: [],
    }),
  };
}

const base = { urls: ["https://demo.example.com/"], target_level: "WCAG2.2-AA", max_pages: 5, allowed_hosts: ["demo.example.com"] };

test("worker --run refuses a tampered run row before any browser starts", async () => {
  await assert.rejects(
    loadWorkerRun(storeWithRun({ ...base, urls: ["https://evil.example.org/"] }), "run-tamper", 5),
    /not allowlisted/,
  );
  await assert.rejects(
    loadWorkerRun(storeWithRun({ ...base, urls: Array.from({ length: 6 }, (_, i) => `https://demo.example.com/p${i}`) }), "run-tamper", 5),
    /At most 5 pages/,
  );
  await assert.rejects(
    loadWorkerRun(storeWithRun({ ...base, urls: ["javascript:alert(1)"] }), "run-tamper", 5),
    /Only http\(s\)/,
  );
  // A row inflating its own max_pages is still held to the worker's env cap.
  await assert.rejects(
    loadWorkerRun(storeWithRun({ ...base, max_pages: 99, urls: Array.from({ length: 6 }, (_, i) => `https://demo.example.com/p${i}`) }), "run-tamper", 5),
    /At most 5 pages/,
  );
  // A clean row still loads.
  const ok = await loadWorkerRun(storeWithRun(base), "run-tamper", 5);
  assert.deepEqual(ok, { urls: ["https://demo.example.com/"], targetLevel: "WCAG2.2-AA", maxPages: 5, allowedHosts: ["demo.example.com"] });
});
