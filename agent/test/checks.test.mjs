import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { chromium } from "playwright";
import { serveDir } from "../src/serve.ts";
import { runAxe } from "../src/checks/axe.ts";
import { runKeyboardWalk } from "../src/checks/keyboard.ts";
import { checkHeuristics } from "../src/checks/heuristics.ts";
import { sampleElementContrast } from "../src/checks/contrast.ts";
import { decideFinding } from "../src/decide/index.ts";
import { LocalStore } from "../src/store/index.ts";
import { runAudit, runRetest } from "../src/agent/orchestrator.ts";
import { startServer } from "../src/server.ts";
import { computeMatchesExpected } from "../src/official_runs.ts";

let server;
let browser;
const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sunflower-audit-tests-"));
const testVideosDir = path.join(testTmpDir, "videos");

before(async () => {
  const dir = existsSync("demo-site") ? "demo-site" : "../demo-site";
  server = await serveDir(dir);
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
  try {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  } catch {}
});

test("Test 1: Focus-trap rule detects real trap on modal.html", async () => {
  const result = await runKeyboardWalk(browser, `${server.url}/modal.html`, testVideosDir);

  assert.equal(result.trapDetected, true, "Modal must be detected as trapping focus");
  assert.equal(result.escapeCloses, false, "Escape key must not close the trapping modal");
  assert.ok(result.trace.length > 5, "Keystroke trace must contain Tab events");
  assert.ok(result.trace.some((t) => t.key === "Escape"), "Trace must record Escape attempt");
});

test("Test 1b: Keyboard walker false-positive controls (accessible modal + page with no modal)", async () => {
  // Control (a): Accessible modal that closes on Escape and restores focus produces zero trap finding
  const cleanModalResult = await runKeyboardWalk(browser, `${server.url}/modal-clean.html`, testVideosDir);
  assert.equal(cleanModalResult.trapDetected, false, "Accessible modal that closes on Escape must NOT be flagged as trap");
  assert.equal(cleanModalResult.escapeCloses, true, "Escape must close accessible modal");

  // Control (b): Page with no modal (index.html) produces zero trap finding
  const noModalResult = await runKeyboardWalk(browser, `${server.url}/index.html`, testVideosDir);
  assert.equal(noModalResult.trapDetected, false, "Page with no modal must NOT be flagged as trap");
  assert.equal(noModalResult.escapeCloses, null, "Page with no modal has escapeCloses = null");
});


test("Test 2: Heuristics detect generic link text and removed focus outlines on links.html (and passes negative control)", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url}/links.html`, { waitUntil: "networkidle" });

    // Verify axe-core reports 0 violations for link context/focus indicator
    const axeResults = await runAxe(page, "WCAG2.2-AA");
    const axeGeneric = axeResults.violations.filter((v) => v.id.includes("link-name") || v.id.includes("focus"));
    assert.equal(axeGeneric.length, 0, "Axe must report 0 violations for link context and focus indicators on links.html");

    // Exact heuristic checks on links.html: exactly 3 generic links + 1 removed focus outline = 4 distinct findings
    const heuristicResults = await checkHeuristics(page);
    assert.equal(heuristicResults.genericLinks.length, 3, "Must flag exactly 3 generic links");
    assert.equal(heuristicResults.genericLinks[0].text, "click here");
    assert.equal(heuristicResults.genericLinks[0].selector, "section[aria-labelledby='water'] a[href='index.html']");
    assert.equal(heuristicResults.genericLinks[0].href, "index.html");

    assert.equal(heuristicResults.genericLinks[1].text, "read more");
    assert.equal(heuristicResults.genericLinks[1].selector, "section[aria-labelledby='packlist'] a[href='form.html']");
    assert.equal(heuristicResults.genericLinks[1].href, "form.html");

    assert.equal(heuristicResults.genericLinks[2].text, "learn more");
    assert.equal(heuristicResults.genericLinks[2].selector, "section[aria-labelledby='save'] a[href='index.html']");
    assert.equal(heuristicResults.genericLinks[2].href, "index.html");

    // All selectors must be unique on the page
    const allSelectors = [
      ...heuristicResults.genericLinks.map((l) => l.selector),
      ...heuristicResults.removedOutlines.map((o) => o.selector),
    ];
    assert.equal(new Set(allSelectors).size, 4, "All 4 finding selectors must be distinct");

    // Exactly 1 removed outline (fails if check evaluates at rest because 8 normal links would be falsely flagged)
    assert.equal(heuristicResults.removedOutlines.length, 1, "Must detect exactly 1 removed focus indicator");
    assert.equal(heuristicResults.removedOutlines[0].selector, "button.icon-btn[data-demo-bug='TC2-no-focus-indicator']");
    assert.equal(heuristicResults.removedOutlines[0].tag, "button");
    assert.equal(heuristicResults.removedOutlines[0].text, "Save trip plan");

    // Negative control: Descriptive link and button with visible focus indicator must yield ZERO findings
    await page.setContent(`
      <main>
        <p>Information on equipment:</p>
        <a id="desc-link" href="/rentals">View full equipment rental details</a>
        <button id="desc-btn" type="button">Reserve canoe equipment</button>
      </main>
    `);
    const cleanResults = await checkHeuristics(page);
    assert.equal(cleanResults.genericLinks.length, 0, "Descriptive link must yield 0 generic link findings");
    assert.equal(cleanResults.removedOutlines.length, 0, "Element with native visible focus indicator must yield 0 removed outline findings");
  } finally {
    await page.close();
  }
});

test("Test 3: Contrast sampler measures 3 controls accurately", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    // Control 1: Grey text on photo in photo-hero.html (TC3)
    await page.goto(`${server.url}/photo-hero.html`, { waitUntil: "networkidle" });
    const heroResults = await sampleElementContrast(page, [
      { selector: ".hero-text", text: "Morning on the valley", fontSize: 20, isBold: false },
    ]);
    assert.ok(heroResults.length >= 1, "Must find .hero-text contrast candidate");
    const heroRes = heroResults[0];
    assert.ok(heroRes.usablePixels >= 50, "Must have sampled sufficient background pixels");
    assert.ok(heroRes.measuredRatio < 2.0, `Grey text on photo ratio (${heroRes.measuredRatio}) must fail 4.5:1`);
    assert.equal(heroRes.status, "fail");

    // Control 2: Dark text on plain white background
    await page.setContent(`
      <div style="background: #ffffff; padding: 40px;">
        <p id="dark-on-white" style="color: #1c1917; font-size: 16px;">Readable dark text</p>
      </div>
    `);
    const whiteResults = await sampleElementContrast(page, [
      { selector: "#dark-on-white", text: "Readable dark text", fontSize: 16, isBold: false },
    ]);
    assert.equal(whiteResults.length, 1);
    assert.ok(whiteResults[0].measuredRatio >= 15.0, "Dark on white must have high contrast >= 15:1");
    assert.equal(whiteResults[0].status, "pass");

    // Control 3: Dark text on photo
    await page.goto(`${server.url}/photo-hero.html`, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      const el = document.querySelector(".hero-text");
      if (el) el.style.color = "#1c1917";
    });
    const darkOnPhotoResults = await sampleElementContrast(page, [
      { selector: ".hero-text", text: "Morning on the valley", fontSize: 20, isBold: false },
    ]);
    assert.equal(darkOnPhotoResults.length, 1);
    assert.ok(darkOnPhotoResults[0].measuredRatio >= 4.5, "Dark text on photo must meet WCAG AA >= 4.5:1");
    assert.equal(darkOnPhotoResults[0].status, "pass");
  } finally {
    await page.close();
  }
});

test("Test 4: Uncertain-state decision fires when axe reports incomplete or evidence is missing", () => {
  // Axe incomplete rule mapped to uncertain finding
  const axeFinding = {
    finding_id: "find-axe-01",
    input_id: "pg-01",
    source_id: "src-01",
    rule_id: "color-contrast",
    wcag_criterion: "1.4.3",
    selector: ".hero-text",
    check_type: "axe",
    state: "uncertain",
    reason: "axe needs review — cannot determine color contrast automatically",
    evidence_ids: ["ev-01"],
  };
  const decisionAxe = decideFinding({ finding: axeFinding });
  assert.equal(decisionAxe.outcome, "uncertain");
  assert.ok(decisionAxe.reason.includes("incomplete/needs review"));

  // Finding with missing evidence
  const missingFinding = {
    finding_id: "find-missing-01",
    input_id: "pg-01",
    source_id: "src-01",
    rule_id: "color-contrast-image",
    wcag_criterion: "1.4.3",
    selector: ".hero-text",
    check_type: "contrast",
    state: "fail",
    reason: "Ratio below 4.5",
    evidence_ids: [],
  };
  const decisionMissing = decideFinding({ finding: missingFinding, evidenceMissing: true });
  assert.equal(decisionMissing.outcome, "uncertain");
  assert.ok(decisionMissing.reason.includes("Evidence missing"));
});

test("Test 5: P5 Approval Gate enforces approval and idempotency (no double-log, refuses unapproved)", async () => {
  const outDir = testTmpDir;
  const runId = `test-gate-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const store = await LocalStore.open(outDir, runId);

  // Propose an action
  const action = await store.proposeAction({
    idempotency_key: "idem-key-12345",
    action_type: "log_issue",
    payload_json: {
      finding_id: "find-demo-01",
      title: "Missing label at #input",
      description: "Form control missing accessible label",
      wcag_criterion: "4.1.2",
      severity: "serious",
    },
  });

  assert.equal(action.status, "proposed");

  // 1. Refuse execution of unapproved action
  await assert.rejects(
    async () => {
      await store.executeApprovedAction(action.action_id);
    },
    /is not approved/,
    "Must refuse to execute unapproved action"
  );

  // 2. Reject decision records rejection
  const rejectAction = await store.proposeAction({
    idempotency_key: "idem-key-reject",
    action_type: "log_issue",
    payload_json: { finding_id: "find-demo-02" },
  });
  await store.approveAction(rejectAction.action_id, "reject", "Auditor Jane", "False positive");
  const docAfterReject = await store.read();
  const rejAct = docAfterReject.actions.find((a) => a.action_id === rejectAction.action_id);
  assert.equal(rejAct?.status, "rejected");

  // 3. Approve action
  await store.approveAction(action.action_id, "approve", "Auditor John");
  const docAfterApprove = await store.read();
  const appAct = docAfterApprove.actions.find((a) => a.action_id === action.action_id);
  assert.equal(appAct?.status, "approved");

  // 4. Execute approved action
  const res1 = await store.executeApprovedAction(action.action_id);
  assert.equal(res1.status, "executed");
  assert.equal(res1.duplicate, false);
  assert.ok(res1.issue_id.startsWith("issue-"));

  // Check issue log has exactly 1 issue
  const docAfterExec1 = await store.read();
  const issuesForAction = docAfterExec1.issues.filter((i) => i.action_id === action.action_id);
  assert.equal(issuesForAction.length, 1);

  // 5. Duplicate execute of same action returns existing result and does NOT double-log
  const res2 = await store.executeApprovedAction(action.action_id);
  assert.equal(res2.status, "executed");
  assert.equal(res2.duplicate, true);
  assert.equal(res2.issue_id, res1.issue_id);

  const docAfterExec2 = await store.read();
  const issuesAfterRetry = docAfterExec2.issues.filter((i) => i.action_id === action.action_id);
  assert.equal(issuesAfterRetry.length, 1, "Retrying execution must NEVER create duplicate issue rows");
});

test("Test 6: P6 Retest loop closes issue only when passing and keeps open when still failing", async () => {
  const outDir = testTmpDir;
  const runId = `test-retest-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const store = await LocalStore.open(outDir, runId);

  // Create an open issue for form.html (missing label 4.1.2)
  const initialAction = await store.proposeAction({
    idempotency_key: "idem-initial-issue",
    action_type: "log_issue",
    payload_json: {
      finding_id: "find-form-initial",
      title: "Input missing label",
      description: "Form input requires a label",
      wcag_criterion: "4.1.2",
      severity: "serious",
    },
  });
  await store.approveAction(initialAction.action_id, "approve", "Auditor");
  const execInit = await store.executeApprovedAction(initialAction.action_id);
  const issueId = execInit.issue_id;

  // Negative Retest: Retest against still-broken form.html
  const brokenRetest = await runRetest({
    issueId,
    url: `${server.url}/form.html`,
    targetLevel: "WCAG2.2-AA",
    rootDir: outDir,
    store,
  });
  assert.equal(brokenRetest.outcome, "fail", "Broken form must fail retest");
  assert.equal(brokenRetest.actionId, undefined, "Failing retest must NOT propose a close_issue action");

  // Check issue is still open
  const docAfterBroken = await store.read();
  const issueBroken = docAfterBroken.issues.find((i) => i.issue_id === issueId);
  assert.equal(issueBroken?.status, "open", "Still-failing retest must leave issue open");

  // Positive Retest: Retest against fixed page form-fixed.html
  const passingRetest = await runRetest({
    issueId,
    url: `${server.url}/form-fixed.html`,
    targetLevel: "WCAG2.2-AA",
    rootDir: outDir,
    store,
  });
  assert.equal(passingRetest.outcome, "pass", "Fixed form must pass retest");
  assert.ok(passingRetest.actionId, "Passing retest must propose a close_issue action");

  // Issue must remain OPEN until human approves and executes the close action
  const docBeforeCloseApproval = await store.read();
  const issueBeforeClose = docBeforeCloseApproval.issues.find((i) => i.issue_id === issueId);
  assert.equal(issueBeforeClose?.status, "open", "Issue must stay open until close action is approved");

  // Approve and execute close action
  await store.approveAction(passingRetest.actionId, "approve", "Auditor Lead");
  await store.executeApprovedAction(passingRetest.actionId);

  const docAfterClose = await store.read();
  const issueClosed = docAfterClose.issues.find((i) => i.issue_id === issueId);
  assert.equal(issueClosed?.status, "closed", "Issue transitions to closed only upon approved execution");
});

test("Test 7: P7 Self-audit of web dashboard with real run loaded, approval persistence to store.json, and page reload", async () => {
  const rootDist = path.join(testTmpDir, `web-${Date.now()}`);
  execFileSync(process.execPath, [path.resolve("..", "node_modules/vite/bin/vite.js"), "build", "--outDir", rootDist], { cwd: path.resolve("..", "web"), stdio: "pipe" });
  const outputDir = testTmpDir;
  assert.ok(existsSync(rootDist), "Test 7 must build an isolated dashboard distribution");

  // Create a clean read-only run to verify State (a)
  const readOnlyRunId = `test-ui-readonly-${Date.now()}`;
  const roStore = await LocalStore.open(outputDir, readOnlyRunId);
  await roStore.initRun({
    run_id: readOnlyRunId,
    created_at: new Date().toISOString(),
    target_level: "WCAG2.2-AA",
    status: "done",
    config_json: { urls: ["http://127.0.0.1/demo/index.html"], target_level: "WCAG2.2-AA", max_pages: 1, allowed_hosts: ["127.0.0.1"] },
    trigger_source: "local",
    plan_json: [{ check: "fetch", scope: "page", reason: "static fetch" }],
  });

  // Create a clean dedicated test run in outputDir with a proposed action for State (b)
  const testRunId = `test-ui-${Date.now()}`;
  const testStore = await LocalStore.open(outputDir, testRunId);
  await testStore.initRun({
    run_id: testRunId,
    created_at: new Date().toISOString(),
    target_level: "WCAG2.2-AA",
    status: "awaiting_approval",
    config_json: { urls: ["http://127.0.0.1/demo/modal.html"], target_level: "WCAG2.2-AA", max_pages: 1, allowed_hosts: ["127.0.0.1"] },
    trigger_source: "local",
    plan_json: [
      { check: "fetch", scope: "page", reason: "static fetch" },
      { check: "axe", scope: "page", reason: "automated sweep" },
      { check: "keyboard_walk", scope: "page", reason: "keyboard trap check" },
    ],
  });
  const inputRow = {
    input_id: `pg-${testRunId}-01`,
    run_id: testRunId,
    url: "http://127.0.0.1/demo/modal.html",
    validation_status: "valid",
  };
  await testStore.addPageInput(inputRow);
  const srcRow = await testStore.addSource({
    input_id: inputRow.input_id,
    url: inputRow.url,
    retrieved_at: new Date().toISOString(),
    http_status: 200,
    fetch_method: "cheerio",
    content_hash: "abcd",
    snapshot_path: "evidence/snap.html",
  });
  // Real screenshot evidence (1x1 PNG) so the evidence well renders an image.
  const png1x1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const shotEv = await testStore.saveEvidence("keyboard-keyframe-1.png", png1x1, "screenshot", undefined, undefined);
  const finding = await testStore.addFinding({
    input_id: inputRow.input_id,
    source_id: srcRow.source_id,
    rule_id: "keyboard-trap",
    wcag_criterion: "2.1.2",
    selector: "dialog[role='dialog']",
    check_type: "keyboard",
    state: "fail",
    reason: "Focus trapped inside modal for 3 complete cycles while outside elements exist",
    evidence_ids: [shotEv.evidence_id],
  });
  await testStore.addDecision({
    decision_id: `dec-${testRunId}`,
    finding_id: finding.finding_id,
    input_id: inputRow.input_id,
    outcome: "fail",
    rule: "keyboard-trap",
    reason: finding.reason,
    input_evidence_ids: [shotEv.evidence_id],
    llm_involved: false,
    llm_status: "none",
  });
  const act = await testStore.proposeAction({
    idempotency_key: `idem-${testRunId}`,
    action_type: "log_issue",
    payload_json: {
      finding_id: finding.finding_id,
      title: "keyboard-trap failure at dialog",
      description: finding.reason,
      wcag_criterion: "2.1.2",
      severity: "serious",
    },
  });

  // Start real local audit server
  const server = await startServer(0, outputDir, rootDist);
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();

    // 0. State (a): Clean read-only run view with no pending actions
    await page.goto(`${server.url}/?run=${readOnlyRunId}`, { waitUntil: "networkidle" });
    const axeStateA = await runAxe(page, "WCAG2.2-AA");
    assert.equal(axeStateA.violations.length, 0, `Self-audit State (a) (Read-only): Expected 0 axe violations, got: ${JSON.stringify(axeStateA.violations)}`);
    const buttonsStateA = await page.locator("button").count();
    assert.ok(buttonsStateA > 0, "State (a) read-only view must provide interactive focusable controls (e.g. reload button)");
    const reloadBtn = page.locator("button").first();
    await reloadBtn.focus();
    const reloadHasFocus = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return false;
      const s = window.getComputedStyle(el);
      return (s.outlineStyle !== "none" && s.outlineWidth !== "0px") || (s.boxShadow && s.boxShadow !== "none");
    });
    assert.ok(reloadHasFocus, "State (a) interactive control must display visible focus indicator");

    // 1. State (b): Proposed action awaiting approval
    await page.goto(`${server.url}/?run=${testRunId}`, { waitUntil: "networkidle" });
    const axeState1 = await runAxe(page, "WCAG2.2-AA");
    assert.equal(axeState1.violations.length, 0, `Self-audit State (b) (Proposed): Expected 0 axe violations, got: ${JSON.stringify(axeState1.violations)}`);

    // 1b. Evidence well: real artifacts only — labelled scrollable region with
    // keyboard-reachable images with meaningful alt text; no stub controls.
    const inspectArtifactCount = await page.getByRole("button", { name: "Inspect Artifact" }).count();
    assert.equal(inspectArtifactCount, 0, "The stub 'Inspect Artifact' control must not exist");
    const region = page.locator("[role='region'][aria-label^='Evidence artifacts']");
    assert.equal(await region.count(), 1, "Evidence well must be a labelled region");
    assert.equal(await region.getAttribute("tabindex"), "0", "Evidence region must be keyboard-scrollable (tabindex=0)");
    const imgCount = await region.locator("img").count();
    assert.ok(imgCount >= 1, "Evidence region must render the attached screenshot");
    const imgAlt = await region.locator("img").first().getAttribute("alt");
    assert.ok(imgAlt && imgAlt.length > 10 && /keyboard-trap/.test(imgAlt), `Evidence image alt must describe the finding meaningfully, got: ${imgAlt}`);

    // 2. Verify visible focus on interactive controls
    const focusableSelectors = ["#approver-input", "button"];
    for (const sel of focusableSelectors) {
      const el = page.locator(sel).first();
      await el.focus();
      const hasOutline = await page.evaluate((s) => {
        const elem = document.querySelector(s);
        if (!elem) return false;
        const style = window.getComputedStyle(elem);
        const hasOut = style.outlineStyle !== "none" && style.outlineWidth !== "0px";
        const hasBox = style.boxShadow && style.boxShadow !== "none";
        return hasOut || hasBox;
      }, sel);
      assert.ok(hasOutline, `Focused control ${sel} must have a visible focus indicator (outline or box-shadow)`);
    }

    // 3. Perform approval and execution through the browser UI
    await page.locator("#approver-input").focus();
    await page.keyboard.type("Lead Auditor Jane");
    await page.keyboard.press("Tab");
    await page.keyboard.type(`test-${crypto.randomUUID()}`);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");

    // Wait for the UI message confirming persistence
    await page.waitForFunction(() => {
      return document.body.innerText.includes("saved to store.json");
    });

    // 4. Verify that store.json on disk was ACTUALLY mutated
    const storeDiskDoc = await testStore.read();
    const diskAction = storeDiskDoc.actions.find((a) => a.action_id === act.action_id);
    assert.equal(diskAction?.status, "executed", "Action in store.json on disk must be updated to executed");
    assert.equal(storeDiskDoc.issues.length, 1, "Issue row must be persisted to store.json on disk");
    assert.equal(storeDiskDoc.issues[0]?.title, "keyboard-trap failure at dialog");

    // 5. Reload the page to prove persistence across browser sessions
    await page.reload({ waitUntil: "networkidle" });
    const reloadedBody = await page.textContent("body");
    assert.ok(reloadedBody?.includes("EXECUTED"), "Page reload must display EXECUTED status badge from store.json");

    // 6. Axe WCAG 2.2 AA Self-Audit in state 2: Executed issue showing
    const axeState2 = await runAxe(page, "WCAG2.2-AA");
    assert.equal(axeState2.violations.length, 0, `Self-audit State 2 (Executed): Expected 0 axe violations, got: ${JSON.stringify(axeState2.violations)}`);
  } finally {
    await browser.close();
    await server.close();
  }
});

test("Test 8: matches_expected returns false for deliberately wrong actual results via computeMatchesExpected", () => {
  // TC1 wrong: wrong rule_id
  assert.equal(
    computeMatchesExpected("TC1", {
      trapFinding: { rule_id: "wrong-rule", evidence_ids: ["ev-vid"] },
      trapIssue: { issue_id: "i1" },
      trapVideoEv: { type: "video" },
      approvalRecorded: true,
    }),
    false,
    "TC1 must be false when rule_id is wrong"
  );
  // TC1 wrong: missing video evidence
  assert.equal(
    computeMatchesExpected("TC1", {
      trapFinding: { rule_id: "keyboard-trap", evidence_ids: [] },
      trapIssue: { issue_id: "i1" },
      trapVideoEv: null,
      approvalRecorded: true,
    }),
    false,
    "TC1 must be false when video evidence is missing"
  );
  // TC1 wrong: approval not recorded
  assert.equal(
    computeMatchesExpected("TC1", {
      trapFinding: { rule_id: "keyboard-trap", evidence_ids: ["ev-vid"] },
      trapIssue: { issue_id: "i1" },
      trapVideoEv: { type: "video" },
      approvalRecorded: false,
    }),
    false,
    "TC1 must be false when approval is not recorded"
  );

  // TC2 wrong: axe reports violations > 0
  assert.equal(
    computeMatchesExpected("TC2", {
      axeViolationsCount: 1,
      heuristicFindingsCount: 4,
      issuesLoggedCount: 4,
      actionsApprovedCount: 4,
    }),
    false,
    "TC2 must be false when axe reports violations"
  );
  // TC2 wrong: heuristic count is wrong
  assert.equal(
    computeMatchesExpected("TC2", {
      axeViolationsCount: 0,
      heuristicFindingsCount: 3,
      issuesLoggedCount: 4,
      actionsApprovedCount: 4,
    }),
    false,
    "TC2 must be false when heuristic findings count is not 4"
  );
  // TC2 wrong: actions not approved
  assert.equal(
    computeMatchesExpected("TC2", {
      axeViolationsCount: 0,
      heuristicFindingsCount: 4,
      issuesLoggedCount: 4,
      actionsApprovedCount: 3,
    }),
    false,
    "TC2 must be false when actions approved count is not 4"
  );

  // TC3 wrong: axe did not return incomplete
  assert.equal(
    computeMatchesExpected("TC3", {
      axeIncompleteContrast: false,
      contrastFinding: { state: "fail", evidence_ids: ["ev1", "ev2"] },
      contrastTextEv: { type: "screenshot" },
      contrastBgEv: { type: "screenshot" },
      worstCaseRatio: 1.36,
      contrastThreshold: 4.5,
    }),
    false,
    "TC3 must be false when axe did not report incomplete"
  );
  // TC3 wrong: missing background-only screenshot
  assert.equal(
    computeMatchesExpected("TC3", {
      axeIncompleteContrast: true,
      contrastFinding: { state: "fail", evidence_ids: ["ev1"] },
      contrastTextEv: { type: "screenshot" },
      contrastBgEv: null,
      worstCaseRatio: 1.36,
      contrastThreshold: 4.5,
    }),
    false,
    "TC3 must be false when background-only screenshot is missing"
  );
  // TC3 wrong: ratio above threshold
  assert.equal(
    computeMatchesExpected("TC3", {
      axeIncompleteContrast: true,
      contrastFinding: { state: "fail", evidence_ids: ["ev1", "ev2"] },
      contrastTextEv: { type: "screenshot" },
      contrastBgEv: { type: "screenshot" },
      worstCaseRatio: 4.8,
      contrastThreshold: 4.5,
    }),
    false,
    "TC3 must be false when worst case ratio is not below threshold"
  );

  // TC4 wrong: issue status is open instead of closed
  assert.equal(
    computeMatchesExpected("TC4", {
      initialIssueLogged: true,
      negativeRetestOutcome: "fail",
      issueOpenAfterNegative: true,
      positiveRetestOutcome: "pass",
      issueClosedStatus: "open",
      closeApprovalRecorded: true,
    }),
    false,
    "TC4 must be false when issue status is open"
  );
  // TC4 wrong: close approval was not recorded
  assert.equal(
    computeMatchesExpected("TC4", {
      initialIssueLogged: true,
      negativeRetestOutcome: "fail",
      issueOpenAfterNegative: true,
      positiveRetestOutcome: "pass",
      issueClosedStatus: "closed",
      closeApprovalRecorded: false,
    }),
    false,
    "TC4 must be false when close approval is not recorded"
  );

  // All pass cases confirm true
  assert.equal(
    computeMatchesExpected("TC1", {
      trapFinding: { rule_id: "keyboard-trap", evidence_ids: ["ev-vid"] },
      trapIssue: { issue_id: "i1" },
      trapVideoEv: { type: "video" },
      approvalRecorded: true,
    }),
    true
  );
  assert.equal(
    computeMatchesExpected("TC2", {
      axeViolationsCount: 0,
      heuristicFindingsCount: 4,
      issuesLoggedCount: 4,
      actionsApprovedCount: 4,
    }),
    true
  );
  assert.equal(
    computeMatchesExpected("TC3", {
      axeIncompleteContrast: true,
      contrastFinding: { state: "fail", evidence_ids: ["ev1", "ev2"] },
      contrastTextEv: { type: "screenshot" },
      contrastBgEv: { type: "screenshot" },
      worstCaseRatio: 1.36,
      contrastThreshold: 4.5,
    }),
    true
  );
  assert.equal(
    computeMatchesExpected("TC4", {
      initialIssueLogged: true,
      negativeRetestOutcome: "fail",
      issueOpenAfterNegative: true,
      positiveRetestOutcome: "pass",
      issueClosedStatus: "closed",
      closeApprovalRecorded: true,
    }),
    true
  );
});

test("Test 9: Auth-gated page (HTTP 401) is skipped as one uncertain finding with a manual step", async () => {
  // P8-T5: a page behind a login wall cannot be audited honestly — the run must
  // not crash and must not report the login form as the page's accessibility.
  const authServer = http.createServer((_req, res) => {
    res.writeHead(401, { "content-type": "text/html" });
    res.end(
      "<!DOCTYPE html><html lang=\"en\"><head><title>Sign in required</title></head>" +
      "<body><form><label for=\"user\">User</label><input id=\"user\">" +
      "<label for=\"pass\">Password</label><input id=\"pass\" type=\"password\"></form></body></html>",
    );
  });
  await new Promise((resolve) => authServer.listen(0, "127.0.0.1", resolve));
  const port = authServer.address().port;
  try {
    const outDir = path.join(testTmpDir, "auth-wall");
    const store = await LocalStore.open(outDir, `test-authwall-${Date.now()}`);
    const { status } = await runAudit({
      urls: [`http://127.0.0.1:${port}/`],
      targetLevel: "WCAG2.2-AA",
      maxPages: 5,
      allowedHosts: ["127.0.0.1"],
      store,
    });
    assert.equal(status, "awaiting_approval", "Auth-gated run must still complete for human review");
    const doc = await store.read();
    assert.equal(doc.findings.length, 1, "Exactly one skip finding, no axe/keyboard/contrast findings on the login form");
    const finding = doc.findings[0];
    assert.equal(finding.state, "uncertain", "Auth-gated page must yield an uncertain finding");
    assert.equal(finding.rule_id, "auth-gated-page");
    assert.equal(finding.check_type, "collect");
    assert.match(finding.reason, /Manual step:/, "Finding must carry the safe manual-step suggestion");
    assert.match(finding.reason, /401/, "Finding must state the observed HTTP status");
    assert.equal(doc.sources[0].http_status, 401, "Source row records the 401");
    assert.equal(doc.decisions[0].outcome, "uncertain", "Decision records uncertain, not fail");
    assert.equal(doc.actions.length, 0, "Uncertain findings are not proposed for auto-logging");
  } finally {
    authServer.close();
  }
});
