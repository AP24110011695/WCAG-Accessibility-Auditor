import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { SupabaseStore } from "../src/store/supabase.ts";

async function mockSupabase() {
  const tables = Object.fromEntries(["runs", "page_inputs", "sources", "findings", "evidence", "decisions", "actions", "approvals", "issues", "retests"].map((name) => [name, []]));
  const requests = []; const objects = new Map(); let fail = false;
  const server = createServer(async (req, res) => {
    const body = await new Promise((resolve) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks))); });
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: body.toString() });
    if (fail) { res.writeHead(500); return res.end("intentional failure"); }
    if (req.url.startsWith("/storage/v1/object/")) { objects.set(req.url, body); res.writeHead(200); return res.end("{}"); }
    const match = req.url.match(/^\/rest\/v1\/([^?]+)/); if (!match) { res.writeHead(404); return res.end(); }
    const table = match[1]; const rows = tables[table]; if (!rows) { res.writeHead(404); return res.end(); }
    const runId = new URL(req.url, "http://x").searchParams.get("run_id")?.replace("eq.", "");
    const findingId = new URL(req.url, "http://x").searchParams.get("finding_id")?.replace("eq.", "");
    if (req.method === "POST") { rows.push(JSON.parse(body)); res.writeHead(201, { "content-type": "application/json" }); return res.end("[]"); }
    if (req.method === "PATCH") { Object.assign(rows.find((r) => r.run_id === runId || r.finding_id === findingId), JSON.parse(body)); res.writeHead(204); return res.end(); }
    const filtered = rows.filter((r) => !runId || r.run_id === runId); res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(filtered));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, tables, requests, objects, fail: () => { fail = true; }, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("SupabaseStore shapes PostgREST/Storage writes and reads persisted evidence", async () => {
  const mock = await mockSupabase();
  try {
    const store = new SupabaseStore("run-mock", { supabaseUrl: mock.url, supabaseKey: "service-test" });
    await store.initRun({ run_id: "run-mock", created_at: "2026-01-01T00:00:00Z", target_level: "WCAG2.2-AA", status: "pending", config_json: { urls: ["http://demo.test/"], target_level: "WCAG2.2-AA", max_pages: 1, allowed_hosts: ["demo.test"] }, trigger_source: "manual_dispatch" });
    await store.addPageInput({ input_id: "pg-01", url: "http://demo.test/", validation_status: "valid" });
    const source = await store.addSource({ input_id: "pg-01", url: "http://demo.test/", retrieved_at: "2026-01-01T00:00:00Z", http_status: 200, fetch_method: "cheerio", content_hash: "hash", snapshot_path: "run-mock/snap.html" });
    const finding = await store.addFinding({ input_id: "pg-01", source_id: source.source_id, rule_id: "image-alt", wcag_criterion: "1.1.1", check_type: "axe", state: "fail", reason: "missing alt", evidence_ids: [] });
    const evidence = await store.saveEvidence("report.json", Buffer.from("proof"), "axe_report", { fixture: true }, finding.finding_id);
    await store.addDecision({ finding_id: finding.finding_id, input_id: "pg-01", outcome: "fail", rule: "image-alt", reason: "missing alt", input_evidence_ids: [evidence.evidence_id], llm_involved: false, llm_status: "disabled" });
    const doc = await store.read();
    assert.equal(doc.findings[0].evidence_ids[0], evidence.evidence_id);
    assert.equal(doc.evidence[0].checksum.length, 64);
    assert.equal(mock.objects.size, 1);
    const runPost = mock.requests.find((r) => r.url === "/rest/v1/runs" && r.method === "POST");
    assert.equal(runPost.headers.apikey, "service-test"); assert.match(runPost.headers.authorization, /^Bearer service-test$/);
    assert.equal(JSON.parse(runPost.body).run_id, "run-mock");
    assert.equal(mock.tables.evidence[0].run_id, "run-mock");
  } finally { await mock.close(); }
});

test("SupabaseStore reports PostgREST 5xx with operation context", async () => {
  const mock = await mockSupabase();
  try {
    mock.fail(); const store = new SupabaseStore("run-fail", { supabaseUrl: mock.url, supabaseKey: "key" });
    await assert.rejects(store.initRun({ run_id: "run-fail", created_at: "2026-01-01T00:00:00Z", target_level: "WCAG2.2-AA", status: "pending", config_json: { urls: [], target_level: "WCAG2.2-AA", max_pages: 1, allowed_hosts: [] }, trigger_source: "manual_dispatch" }), /initRun failed: 500/);
  } finally { await mock.close(); }
});
