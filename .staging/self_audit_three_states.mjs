// Reusable verification: axe WCAG 2.2 AA + visible-focus check of the dashboard
// in three states — (a) run loaded, (b) approval panel open, (c) executed issue.
// Self-contained: builds its own dashboard dist and writes fixture runs into a
// temp dir (never touches output/). Prints the counts per state.
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startServer } from "../agent/src/server.ts";
import { LocalStore } from "../agent/src/store/index.ts";
import { runAxe } from "../agent/src/checks/axe.ts";

const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const root = path.resolve(import.meta.dirname, "..");
const workDir = mkdtempSync(path.join(tmpdir(), "sunflower-self-audit-"));
const distDir = path.join(workDir, "dist");
execFileSync(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build", "--outDir", distDir], { cwd: path.join(root, "web"), stdio: "pipe" });

async function fixtureRun(store, runId, status) {
  await store.initRun({
    run_id: runId,
    created_at: new Date().toISOString(),
    target_level: "WCAG2.2-AA",
    status,
    config_json: { urls: ["http://127.0.0.1/demo/modal.html"], target_level: "WCAG2.2-AA", max_pages: 1, allowed_hosts: ["127.0.0.1"] },
    trigger_source: "local",
    plan_json: [{ check: "fetch", scope: "page", reason: "static fetch" }],
  });
  const input = { input_id: `pg-${runId}-01`, run_id: runId, url: "http://127.0.0.1/demo/modal.html", validation_status: "valid" };
  await store.addPageInput(input);
  const src = await store.addSource({ input_id: input.input_id, url: input.url, retrieved_at: new Date().toISOString(), http_status: 200, fetch_method: "cheerio", content_hash: "abc", snapshot_path: "s.html" });
  const shot = await store.saveEvidence("keyboard-keyframe-1.png", png1x1, "screenshot");
  const finding = await store.addFinding({
    input_id: input.input_id, source_id: src.source_id, rule_id: "keyboard-trap", wcag_criterion: "2.1.2",
    selector: "dialog", check_type: "keyboard", state: "fail", reason: "Focus trapped inside modal for 3 full cycles", evidence_ids: [shot.evidence_id],
  });
  await store.addDecision({
    decision_id: `dec-${runId}`, finding_id: finding.finding_id, input_id: input.input_id, outcome: "fail",
    rule: "keyboard-trap", reason: finding.reason, input_evidence_ids: [shot.evidence_id], llm_involved: false, llm_status: "none",
  });
  const action = await store.proposeAction({
    idempotency_key: `idem-${runId}`, action_type: "log_issue",
    payload_json: { finding_id: finding.finding_id, title: "keyboard-trap failure", description: finding.reason, wcag_criterion: "2.1.2", severity: "serious" },
  });
  return action;
}

const outputDir = path.join(workDir, "output");
const roStore = await LocalStore.open(outputDir, "audit-read-only");
await fixtureRun(roStore, "audit-read-only", "done"); // executed action → read-only ledger
{
  const doc = await roStore.read();
  const act = doc.actions[0];
  await roStore.approveAction(act.action_id, "approve", "Lead Auditor Jane", "fixture");
  await roStore.executeApprovedAction(act.action_id);
}
const panelStore = await LocalStore.open(outputDir, "audit-approval-open");
await fixtureRun(panelStore, "audit-approval-open", "awaiting_approval");

const server = await startServer(0, outputDir, distDir);
const browser = await chromium.launch({ headless: true });

async function report(page, label) {
  const axe = await runAxe(page, "WCAG2.2-AA");
  const focusable = await page.$$("button, a, input, select, textarea, [role='region'][tabindex='0']");
  let withIndicator = 0;
  for (const el of focusable) {
    await el.focus();
    const visible = await page.evaluate((node) => {
      const s = window.getComputedStyle(node);
      return (s.outlineStyle !== "none" && s.outlineWidth !== "0px") || (s.boxShadow && s.boxShadow !== "none");
    }, el);
    if (visible) withIndicator++;
  }
  console.log(`${label}: axe violations = ${axe.violations.length}; visible focus on ${withIndicator}/${focusable.length} focusable controls`);
}

try {
  const page = await browser.newPage();

  await page.goto(`${server.url}/?run=audit-read-only`, { waitUntil: "networkidle" });
  await report(page, "State (a) run loaded          ");

  await page.goto(`${server.url}/?run=audit-approval-open`, { waitUntil: "networkidle" });
  await report(page, "State (b) approval panel open  ");

  await page.locator("#approver-input").fill("Lead Auditor Jane");
  await page.locator("#passcode-input").fill("fixture-passcode");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.body.innerText.includes("saved to store.json"));
  await report(page, "State (c) executed issue       ");
} finally {
  await browser.close();
  await server.close();
}
