import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Manifest of every table/column the Supabase adapters actually reference:
// agent/src/store/supabase.ts (PostgREST + Storage), both Edge Functions
// (trigger-audit, approve-action), and the dashboard provider web/src/data.ts.
// If a column is added to an adapter, add it here — the test then fails until
// schema.sql declares it with the same name and type.
const USED = {
  runs: {
    run_id: "text", created_at: "timestamptz", target_level: "text", status: "text",
    config_json: "jsonb", trigger_source: "text", plan_json: "jsonb",
  },
  page_inputs: {
    input_id: "text", run_id: "text", url: "text", label: "text",
    validation_status: "text", validation_errors: "jsonb",
  },
  sources: {
    source_id: "text", input_id: "text", url: "text", retrieved_at: "timestamptz",
    http_status: "integer", fetch_method: "text", content_hash: "text", snapshot_path: "text",
  },
  findings: {
    finding_id: "text", run_id: "text", input_id: "text", source_id: "text", rule_id: "text",
    wcag_criterion: "text", selector: "text", check_type: "text", state: "text", reason: "text",
    evidence_ids: "jsonb",
  },
  evidence: {
    evidence_id: "text", run_id: "text", finding_id: "text", type: "text", storage_path: "text",
    checksum: "text", created_at: "timestamptz", metadata: "jsonb",
  },
  decisions: {
    decision_id: "text", finding_id: "text", input_id: "text", outcome: "text", rule: "text",
    reason: "text", input_evidence_ids: "jsonb", llm_involved: "integer", llm_status: "text",
    llm_model: "text", llm_confidence: "real",
  },
  actions: {
    action_id: "text", idempotency_key: "text", action_type: "text", status: "text",
    payload_json: "jsonb", created_at: "timestamptz", executed_at: "timestamptz",
  },
  approvals: {
    approval_id: "text", action_id: "text", decision: "text", approver: "text",
    reason: "text", approved_at: "timestamptz",
  },
  issues: {
    issue_id: "text", finding_id: "text", action_id: "text", title: "text", description: "text",
    wcag_criterion: "text", severity: "text", status: "text", created_at: "timestamptz",
  },
  retests: {
    retest_id: "text", issue_id: "text", run_id: "text", intended: "text", observed: "text",
    outcome: "text", evidence_ids: "jsonb", created_at: "timestamptz",
  },
};

function parseSchema(sql) {
  const tables = {};
  for (const m of sql.matchAll(/create table\s+(\w+)\s*\((.*?)\n\);/gs)) {
    const cols = {};
    for (const line of m[2].split("\n")) {
      const def = line.trim();
      if (!def || def.startsWith("--")) continue;
      const cm = def.match(/^(\w+)\s+(text|timestamptz|jsonb|integer|real|boolean)\b/);
      if (cm) cols[cm[1]] = cm[2];
    }
    tables[m[1]] = cols;
  }
  return tables;
}

test("schema.sql declares every table and column the Supabase adapters use", () => {
  const sql = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");
  const tables = parseSchema(sql);
  const missing = [];
  for (const [table, cols] of Object.entries(USED)) {
    if (!tables[table]) { missing.push(`table ${table}`); continue; }
    for (const [col, type] of Object.entries(cols)) {
      if (tables[table][col] !== type) {
        missing.push(`${table}.${col} (adapter expects ${type}, schema has ${tables[table][col] ?? "nothing"})`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("schema.sql keeps the approval-gate RPCs the Edge Function invokes", () => {
  const sql = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");
  assert.match(sql, /create or replace function approve_action\(p_action_id text, p_decision text, p_approver text, p_reason text\)/);
  assert.match(sql, /create or replace function execute_approved_action\(p_action_id text\)/);
});
