// Agent orchestrator (architecture.md §4): Stage 1 Collect → 2 Plan →
// 3 Find → (4 Act lands with the approval gate, P5). Status transitions are
// persisted after every stage so any crashed run stays inspectable.
import { chromium, type Browser, type Page } from "playwright";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { validateAuditInput } from "../validate.ts";
import { pageInputId, newRunId } from "../ids.ts";
import { LocalStore, type AuditStore, type PlanEntry, type RunRow, type PageInputRow, type FindingRow, type EvidenceRef } from "../store/index.ts";
import { staticFetch, looksJsRendered } from "../checks/fetcher.ts";
import { runAxe, criterionOf } from "../checks/axe.ts";
import { runKeyboardWalk } from "../checks/keyboard.ts";
import { samplePageContrast, STANDARD_VIEWPORT, STANDARD_DEVICE_SCALE_FACTOR } from "../checks/contrast.ts";
import { checkHeuristics } from "../checks/heuristics.ts";
import { decideFinding } from "../decide/index.ts";
import { explainFinding } from "../llm/index.ts";
import { getRootDir } from "../paths.ts";

export interface RunOptions {
  urls: string[];
  targetLevel: string;
  maxPages: number;
  allowedHosts: string[];
  store: AuditStore;
  allowLlmExplanations?: boolean;
}

// Stage 2 (FR-02): the plan is recorded before execution. Conditions that
// need the rendered page (modals, background images) are declared here and
// evaluated during Find; the reason for every entry is persisted.
export function planFor(targetLevel: string): PlanEntry[] {
  return [
    { check: "fetch", scope: "page", reason: "static fetch first (Cheerio); escalate to a Playwright render only if the body looks like an empty JS app shell" },
    { check: "axe", scope: "page", reason: `baseline automated sweep at ${targetLevel}; axe 'incomplete' results become uncertain findings` },
    { check: "keyboard_walk", scope: "page", reason: "run when the rendered page has interactive elements; traces Tab/Shift+Tab/Escape and checks focus visibility" },
    { check: "modal_trap_walk", scope: "page", reason: "deep trap walk only when modal markers, forms or custom widgets are detected (condition evaluated post-render)" },
    { check: "contrast_sample", scope: "page", reason: "sample contrast against real background pixels wherever text sits over a background image (evaluated post-render)" },
    { check: "heuristics", scope: "page", reason: "deterministic manual-style checks that scanners pass: generic link text, focus visibility" },
  ];
}

export async function runAudit(opts: RunOptions): Promise<{ runId: string; status: string }> {
  const store = opts.store;
  const runId = store.runId;
  const run: RunRow = {
    run_id: runId,
    created_at: new Date().toISOString(),
    target_level: opts.targetLevel,
    status: "pending",
    config_json: { urls: opts.urls, target_level: opts.targetLevel, max_pages: opts.maxPages, allowed_hosts: opts.allowedHosts },
    trigger_source: "local",
  };
  await store.initRun(run);
  await store.updateRun({ status: "collecting" });

  // Stage 1: Collect — nothing runs before validation (FR-01).
  const errors = validateAuditInput(
    { urls: opts.urls, target_level: opts.targetLevel },
    { maxPages: opts.maxPages, allowedHosts: opts.allowedHosts },
  );
  const inputs: PageInputRow[] = opts.urls.map((url, i) => ({
    input_id: pageInputId(runId, i + 1),
    run_id: runId,
    url,
    validation_status: "valid",
    validation_errors: errors.filter((e) => e.field === `urls[${i}]`).map((e) => e.message),
  }));
  for (const input of inputs) {
    const levelErrors = input.input_id.endsWith("-01")
      ? errors.filter((e) => e.field === "target_level").map((e) => e.message)
      : [];
    const all = [...(input.validation_errors ?? []), ...levelErrors];
    input.validation_status = all.length === 0 ? "valid" : "invalid";
    input.validation_errors = all.length === 0 ? undefined : all;
    await store.addPageInput(input);
  }
  if (errors.length > 0) {
    await store.updateRun({ status: "failed" });
    return { runId, status: "failed" };
  }

  // Stage 2: Plan (FR-02).
  const plan = planFor(opts.targetLevel);
  await store.updateRun({ status: "planning", plan_json: plan });

  // Stage 3: Find (FR-03/04) — one browser for the whole run.
  await store.updateRun({ status: "finding" });
  const browser = await chromium.launch();
  try {
    for (const input of inputs.filter((i) => i.validation_status === "valid")) {
      await auditPage(store, browser, input, opts.targetLevel, opts.allowLlmExplanations === true);
    }
  } finally {
    await browser.close();
  }

  // Stage 4: Propose actions for human approval (FR-09).
  const doc = await store.read();
  const failedDecisions = doc.decisions.filter((d) => d.outcome === "fail" && d.finding_id);
  for (const dec of failedDecisions) {
    const finding = doc.findings.find((f) => f.finding_id === dec.finding_id);
    if (!finding) continue;
    const payload = {
      finding_id: finding.finding_id,
      title: `${finding.rule_id} failure at ${finding.selector ?? "page"}`,
      description: finding.reason,
      wcag_criterion: finding.wcag_criterion,
      severity: "serious",
    };
    const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const idempotencyKey = createHash("sha256")
      .update(`${runId}|${finding.finding_id}|log_issue|${payloadHash}`)
      .digest("hex");

    await store.proposeAction({
      idempotency_key: idempotencyKey,
      action_type: "log_issue",
      payload_json: payload,
    });
  }

  await store.updateRun({ status: "awaiting_approval" });
  return { runId, status: "awaiting_approval" };
}

interface LoadedPage {
  page: Page;
  html: string;
  method: "cheerio" | "playwright";
  httpStatus: number | null;
  retrievedAt: string;
  finalUrl: string;
}

async function loadPage(browser: Browser, input: PageInputRow): Promise<LoadedPage> {
  const page = await browser.newPage({
    viewport: STANDARD_VIEWPORT,
    deviceScaleFactor: STANDARD_DEVICE_SCALE_FACTOR,
    // Hosts like GitHub Pages send a strict CSP (default-src 'none') that blocks
    // the axe-core script injection; the audit context must bypass it.
    bypassCSP: true,
  });
  const stat = await staticFetch(input.url);
  if (looksJsRendered(stat.html)) {
    const resp = await page.goto(input.url, { waitUntil: "networkidle" });
    return {
      page,
      html: await page.content(),
      method: "playwright",
      httpStatus: resp?.status() ?? null,
      retrievedAt: new Date().toISOString(),
      finalUrl: page.url(),
    };
  }
  await page.goto(input.url, { waitUntil: "load" });
  return { page, html: stat.html, method: "cheerio", httpStatus: stat.httpStatus, retrievedAt: stat.retrievedAt, finalUrl: stat.url };
}

async function auditPage(store: AuditStore, browser: Browser, input: PageInputRow, level: string, allowLlmExplanations: boolean): Promise<void> {
  const loaded = await loadPage(browser, input);
  const snapshot = await store.saveEvidence(
    `snapshot-${input.input_id.slice(-2)}.html`,
    Buffer.from(loaded.html),
    "dom_snippet",
  );
  const source = await store.addSource({
    input_id: input.input_id,
    url: loaded.finalUrl,
    retrieved_at: loaded.retrievedAt,
    http_status: loaded.httpStatus,
    fetch_method: loaded.method,
    content_hash: createHash("sha256").update(loaded.html).digest("hex"),
    snapshot_path: snapshot.path,
  });

  // Auth-gated page (P8-T5, FR-08): 401/403 means the real content is behind a
  // login — auditing the login form would misreport it as the page's
  // accessibility. Skip with one uncertain finding carrying a safe manual step.
  if (loaded.httpStatus === 401 || loaded.httpStatus === 403) {
    const finding = await store.addFinding({
      input_id: input.input_id,
      source_id: source.source_id,
      rule_id: "auth-gated-page",
      wcag_criterion: "N/A",
      check_type: "collect",
      state: "uncertain",
      reason: `Page requires authentication (HTTP ${loaded.httpStatus}) — the automated audit skipped the gated content. Manual step: sign in and walk the page with keyboard and screen reader, checking the same ${level} criteria.`,
      evidence_ids: [snapshot.evidence_id],
    });
    await addDecision(store, finding, allowLlmExplanations);
    return;
  }

  // Automated sweep (FR-04).
  const axe = await runAxe(loaded.page, level);
  const axeReport = await store.saveEvidence(
    `axe-${input.input_id.slice(-2)}.json`,
    Buffer.from(JSON.stringify({ level, violations: axe.violations, incomplete: axe.incomplete, passesCount: axe.passesCount }, null, 2)),
    "axe_report",
  );
  for (const v of axe.violations) {
    const finding = await store.addFinding({
      input_id: input.input_id,
      source_id: source.source_id,
      rule_id: v.id,
      wcag_criterion: criterionOf(v),
      selector: v.nodes[0]?.target.join(" ") ?? undefined,
      check_type: "axe",
      state: "fail",
      reason: `axe violation: ${v.help} (impact ${v.impact ?? "unknown"}); ${v.nodes.length} node(s)`,
      evidence_ids: [axeReport.evidence_id],
    });
    await addDecision(store, finding, allowLlmExplanations);
  }
  for (const v of axe.incomplete) {
    const finding = await store.addFinding({
      input_id: input.input_id,
      source_id: source.source_id,
      rule_id: v.id,
      wcag_criterion: criterionOf(v),
      selector: v.nodes[0]?.target.join(" ") ?? undefined,
      check_type: "axe",
      state: "uncertain",
      reason: `axe needs review — cannot determine ${v.help} automatically; manual/pixel measurement required`,
      evidence_ids: [axeReport.evidence_id],
    });
    await addDecision(store, finding, allowLlmExplanations);
  }

  // P3-T3 (FR-06, TC3): contrast sampler
  const contrastResults = await samplePageContrast(loaded.page);
  for (const cs of contrastResults) {
    const evIds: string[] = [];
    if (cs.screenshotWithText) {
      const shot = await store.saveEvidence(
        `contrast-text-${input.input_id.slice(-2)}.png`,
        cs.screenshotWithText,
        "pixel_sample",
        { viewport: cs.viewport, deviceScaleFactor: cs.deviceScaleFactor }
      );
      evIds.push(shot.evidence_id);
    }
    if (cs.screenshotBgOnly) {
      const shot = await store.saveEvidence(
        `contrast-bg-${input.input_id.slice(-2)}.png`,
        cs.screenshotBgOnly,
        "pixel_sample",
        { viewport: cs.viewport, deviceScaleFactor: cs.deviceScaleFactor }
      );
      evIds.push(shot.evidence_id);
    }

    if (cs.status === "fail") {
      const finding = await store.addFinding({
        input_id: input.input_id,
        source_id: source.source_id,
        rule_id: "color-contrast-image",
        wcag_criterion: "1.4.3",
        selector: cs.selector,
        check_type: "contrast",
        state: "fail",
        reason: `Measured text contrast ratio ${cs.measuredRatio}:1 (worst-case, mean ${cs.meanRatio}:1) on real background pixels is below required ${cs.requiredRatio}:1 (text: "${cs.text}")`,
        evidence_ids: evIds,
      });
      await addDecision(store, finding, allowLlmExplanations);
    }
  }

  // P3-T4 (FR-07, TC2): heuristics
  const heuristics = await checkHeuristics(loaded.page);
  for (const link of heuristics.genericLinks) {
    const finding = await store.addFinding({
      input_id: input.input_id,
      source_id: source.source_id,
      rule_id: "generic-link-text",
      wcag_criterion: "2.4.4",
      selector: link.selector,
      check_type: "heuristic",
      state: "fail",
      reason: `Generic link text "${link.text}" pointing to "${link.href}" provides no context out of flow (WCAG 2.4.4)`,
      evidence_ids: [snapshot.evidence_id],
    });
    await addDecision(store, finding, allowLlmExplanations);
  }
  for (const outline of heuristics.removedOutlines) {
    const finding = await store.addFinding({
      input_id: input.input_id,
      source_id: source.source_id,
      rule_id: "focus-indicator-removed",
      wcag_criterion: "2.4.7",
      selector: outline.selector,
      check_type: "heuristic",
      state: "fail",
      reason: `Focus indicator explicitly removed (outline: none/0) on interactive <${outline.tag}>${outline.text ? ` ("${outline.text}")` : ""}${outline.href ? ` pointing to "${outline.href}"` : ""} (WCAG 2.4.7)`,
      evidence_ids: [snapshot.evidence_id],
    });
    await addDecision(store, finding, allowLlmExplanations);
  }

  // P3-T1/T2 (FR-05, TC1): keyboard walker
  const intermediateVideoDir = join(os.tmpdir(), "sunflower-walk-videos");
  const kwResult = await runKeyboardWalk(browser, loaded.finalUrl, intermediateVideoDir);
  const traceEv = await store.saveEvidence(
    `keyboard-trace-${input.input_id.slice(-2)}.json`,
    Buffer.from(JSON.stringify(kwResult.trace, null, 2)),
    "keystroke_trace",
  );

  const findingEvIds = [traceEv.evidence_id];
  if (kwResult.videoPath) {
    try {
      const vBuf = readFileSync(kwResult.videoPath);
      const vidEv = await store.saveEvidence(
        `keyboard-walk-${input.input_id.slice(-2)}.webm`,
        vBuf,
        "video",
      );
      findingEvIds.push(vidEv.evidence_id);
    } catch {
      // video recording optional fallback
    }
  }

  if (kwResult.keyframes && kwResult.keyframes.length > 0) {
    for (let i = 0; i < kwResult.keyframes.length; i++) {
      const kf = kwResult.keyframes[i]!;
      const kfEv = await store.saveEvidence(
        `keyboard-keyframe-${i + 1}-${input.input_id.slice(-2)}.png`,
        kf,
        "screenshot",
      );
      findingEvIds.push(kfEv.evidence_id);
    }
  }

  if (kwResult.trapDetected) {
    const finding = await store.addFinding({
      input_id: input.input_id,
      source_id: source.source_id,
      rule_id: "keyboard-trap",
      wcag_criterion: "2.1.2",
      selector: "dialog, [role='dialog']",
      check_type: "keyboard",
      state: "fail",
      reason: `Focus trapped inside modal for 3 complete cycles while focusable elements exist outside. Escape closes modal: ${kwResult.escapeCloses ? "yes" : "no"}.`,
      evidence_ids: findingEvIds,
    });
    await addDecision(store, finding, allowLlmExplanations);
  }

  await loaded.page.close();
}

async function addDecision(store: AuditStore, finding: FindingRow, allowLlmExplanations: boolean): Promise<void> {
  const decision = decideFinding({ finding });
  if (allowLlmExplanations) {
    const result = await explainFinding({ ruleId: finding.rule_id, criterion: finding.wcag_criterion, selector: finding.selector, measuredContext: finding.reason });
    decision.llm_involved = result.status === "ok";
    decision.llm_status = result.status;
  } else {
    decision.llm_status = "disabled";
  }
  await store.addDecision(decision);
}

export interface RetestOptions {
  issueId: string;
  url: string;
  targetLevel: string;
  rootDir?: string;
  store: AuditStore;
}

export async function runRetest(opts: RetestOptions): Promise<{ outcome: "pass" | "fail" | "uncertain"; actionId?: string; retestStore: AuditStore }> {
  const { issueId, url, targetLevel, rootDir = getRootDir("output"), store } = opts;
  const doc = await store.read();
  const issue = (doc.issues ?? []).find((i) => i.issue_id === issueId);
  if (!issue) throw new Error(`Issue not found: ${issueId}`);

  // Re-run the audit on the target page in a new run store (architecture.md §6: a retest is a new run)
  const retestRunId = newRunId();
  const retestStore = await LocalStore.open(rootDir, retestRunId);

  await runAudit({
    urls: [url],
    targetLevel,
    maxPages: 1,
    allowedHosts: ["127.0.0.1", "localhost", "example.com", "sunflower-audit.github.io"],
    store: retestStore,
  });

  const retestDoc = await retestStore.read();
  // Check if any finding failed in this retest run
  const ruleFailed = retestDoc.findings.some(
    (f: FindingRow) => f.state === "fail" && (f.wcag_criterion === issue.wcag_criterion || f.rule_id === issue.wcag_criterion)
  );

  const outcome: "pass" | "fail" | "uncertain" = ruleFailed ? "fail" : "pass";
  const observed = outcome === "pass" ? "All checks passed clean on retested page" : `Check ${issue.wcag_criterion} failed again on retested page`;

  await store.addRetest({
    issue_id: issueId,
    run_id: retestRunId,
    intended: `Fix issue ${issue.title} (${issue.wcag_criterion}) and pass all checks`,
    observed,
    outcome,
    evidence_ids: retestDoc.evidence.map((e: EvidenceRef) => e.evidence_id),
  });

  let closeActionId: string | undefined;
  if (outcome === "pass") {
    const payload = { issue_id: issueId, reason: "Resolved: retest passed all checks clean" };
    const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const idempotencyKey = createHash("sha256")
      .update(`${retestRunId}|${issueId}|close_issue|${payloadHash}`)
      .digest("hex");

    const action = await store.proposeAction({
      idempotency_key: idempotencyKey,
      action_type: "close_issue",
      payload_json: payload,
    });
    closeActionId = action.action_id;
  }

  return { outcome, actionId: closeActionId, retestStore };
}

