import { useState, useEffect } from "react";
import { activeDataProvider } from "./data";

interface Finding {
  finding_id: string;
  rule_id: string;
  wcag_criterion: string;
  selector?: string;
  check_type: string;
  state: "fail" | "pass" | "uncertain";
  reason: string;
  evidence_ids: string[];
}

interface Decision {
  decision_id: string;
  finding_id: string | null;
  outcome: "fail" | "pass" | "uncertain";
  rule: string;
  reason: string;
}

interface Action {
  action_id: string;
  idempotency_key: string;
  action_type: "log_issue" | "close_issue";
  status: "proposed" | "approved" | "executed" | "rejected";
  payload_json: {
    finding_id?: string;
    title?: string;
    description?: string;
    wcag_criterion?: string;
    severity?: string;
  };
}

interface Issue {
  issue_id: string;
  finding_id: string;
  title: string;
  wcag_criterion: string;
  severity: "critical" | "serious" | "moderate" | "minor";
  status: "open" | "closed";
}

interface EvidenceItem {
  evidence_id: string;
  type: string;
  path: string;
  checksum: string;
}

interface RunData {
  run_id: string;
  target_level: string;
  status: string;
  plan_json?: { check: string; reason: string; scope: string }[];
  findings: Finding[];
  decisions: Decision[];
  actions: Action[];
  issues: Issue[];
  evidence: EvidenceItem[];
}

export const AUDIT_LEVELS = ["WCAG2.1-A", "WCAG2.1-AA", "WCAG2.2-A", "WCAG2.2-AA"] as const;
const MAX_PAGES_PER_RUN = 5; // default MAX_PAGES_PER_RUN; the Edge Function enforces the authoritative cap
const POLL_MS = Number((import.meta as any).env?.VITE_POLL_MS) || 15000;
const MAX_POLLS = 60; // 15 min, then stop with an honest message (worker normally starts < 1 min)

// Client-side mirror of the trigger-audit gate; the Edge Function re-checks
// authoritatively (allowlist, caps, rate limit live server-side).
export function validateAuditForm(urlsText: string): string[] {
  const urls = urlsText.split("\n").map((u) => u.trim()).filter(Boolean);
  const errors: string[] = [];
  if (urls.length === 0) return ["At least one page URL is required."];
  if (urls.length > MAX_PAGES_PER_RUN) errors.push(`At most ${MAX_PAGES_PER_RUN} pages per audit.`);
  for (const u of urls) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      errors.push(`Not a valid URL: ${u}`);
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") errors.push(`Only http(s) URLs: ${u}`);
  }
  return errors;
}

export function App() {
  const [data, setData] = useState<RunData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string>("");
  const [approverName, setApproverName] = useState<string>("");
  const [approverPasscode, setApproverPasscode] = useState<string>("");
  const [approvalMessage, setApprovalMessage] = useState<string>("");
  const [availableRuns, setAvailableRuns] = useState<string[]>([]);
  // P1-T3: New Audit form + Queued state (design.md §5).
  const [urlsText, setUrlsText] = useState<string>("");
  const [targetLevel, setTargetLevel] = useState<string>("WCAG2.2-AA");
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [startMessage, setStartMessage] = useState<string>("");
  const [queuedRunId, setQueuedRunId] = useState<string>("");
  const [starting, setStarting] = useState(false);

  const fetchRun = async (runId?: string, silent = false): Promise<RunData | null> => {
    try {
      if (!silent) setLoading(true);
      setError(null);
      const doc = await activeDataProvider.getRun(runId);
      const currentRun = (Array.isArray(doc.runs) ? doc.runs[0] : null) ?? {};
      const normalized: RunData = {
        run_id: currentRun.run_id ?? doc.run_id ?? "unknown",
        target_level: currentRun.target_level ?? doc.target_level ?? "WCAG2.2-AA",
        status: currentRun.status ?? doc.status ?? "done",
        plan_json: currentRun.plan_json ?? doc.plan_json ?? [],
        findings: doc.findings ?? [],
        decisions: doc.decisions ?? [],
        actions: doc.actions ?? [],
        issues: doc.issues ?? [],
        evidence: doc.evidence ?? [],
      };
      setData(normalized);
      if (normalized.findings.length > 0) {
        setSelectedFindingId((prev) => prev && normalized.findings.some((f) => f.finding_id === prev) ? prev : normalized.findings[0]!.finding_id);
      }
      return normalized;
    } catch (err: unknown) {
      if (!silent) setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    // Load run list
    activeDataProvider.getRuns()
      .then((runs: string[]) => {
        if (Array.isArray(runs)) setAvailableRuns(runs);
      })
      .catch(() => undefined);

    const queryParams = new URLSearchParams(window.location.search);
    const runParam = queryParams.get("run") || undefined;
    fetchRun(runParam);
  }, []);

  // Queued state polling (P7-T3): follow the dispatched run until the CI worker
  // picks it up; the panel auto-updates and results replace it when status moves.
  useEffect(() => {
    if (!queuedRunId) return;
    let attempts = 0;
    let cancelled = false;
    const timer = setInterval(async () => {
      if (cancelled) return;
      attempts += 1;
      const run = await fetchRun(queuedRunId, true);
      if (cancelled) return;
      if (run && run.status !== "pending") {
        setQueuedRunId("");
        setStartMessage(
          run.status === "failed"
            ? `Run ${run.run_id} failed — see its status and log for the error.`
            : `Run ${run.run_id} ${run.status === "awaiting_approval" ? "finished" : "is running"} — results shown below.`,
        );
      } else if (attempts >= MAX_POLLS) {
        setQueuedRunId("");
        setStartMessage(`Run ${queuedRunId} is still queued after 15 minutes — check the GitHub Actions tab for the worker run.`);
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [queuedRunId]);

  const handleStartAudit = async () => {
    if (!activeDataProvider.startAudit) return;
    const errors = validateAuditForm(urlsText);
    setFormErrors(errors);
    if (errors.length > 0) return; // invalid input blocks start (FR-01)
    try {
      setStarting(true);
      setStartMessage("Dispatching audit…");
      const urls = urlsText.split("\n").map((u) => u.trim()).filter(Boolean);
      const res = await activeDataProvider.startAudit(urls, targetLevel);
      setStartMessage(`Audit ${res.run_id} dispatched — queued while the CI worker picks it up.`);
      setQueuedRunId(res.run_id);
      await fetchRun(res.run_id, true);
    } catch (err: unknown) {
      setStartMessage("");
      setFormErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setStarting(false);
    }
  };

  const panel = "var(--space-4)";
  const box = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: panel } as const;

  // New Audit form (P1-T3) — only where a trigger endpoint exists (hosted build).
  // In local mode audits start via `npm run audit`, so the section is absent.
  // Rendered in both the empty state and the main view: the first audit can only
  // ever be dispatched from the empty state.
  const newAuditSection = activeDataProvider.startAudit ? (
    <section aria-labelledby="new-audit-heading" style={{ ...box, marginBottom: "var(--space-6)" }}>
      <h2 id="new-audit-heading" style={{ fontFamily: "var(--font-serif)", fontSize: "var(--text-lg)", margin: "0 0 var(--space-2) 0" }}>
        New Audit
      </h2>
      <p style={{ fontSize: "var(--text-sm)", color: "var(--color-ink-muted)", margin: "0 0 var(--space-3) 0" }}>
        Point the auditor at pages on this site. The worker runs on GitHub Actions and starts in under a minute typically.
      </p>
      <form onSubmit={(e) => { e.preventDefault(); void handleStartAudit(); }} noValidate>
        <label htmlFor="audit-urls" style={{ display: "block", fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", textTransform: "uppercase", marginBottom: "var(--space-1)" }}>
          Page URLs (one per line, max {MAX_PAGES_PER_RUN})
        </label>
        <textarea
          id="audit-urls"
          rows={3}
          value={urlsText}
          onChange={(e) => setUrlsText(e.target.value)}
          aria-invalid={formErrors.length > 0}
          aria-describedby={formErrors.length > 0 ? "audit-urls-error" : undefined}
          placeholder="https://example.org/demo/modal.html"
          style={{ width: "100%", boxSizing: "border-box", padding: "8px", fontSize: "var(--text-sm)", fontFamily: "var(--font-mono)", border: "1px solid var(--color-border-strong)", borderRadius: "var(--radius-sm)" }}
        />
        {formErrors.length > 0 && (
          <div id="audit-urls-error" role="alert" style={{ color: "var(--color-fail)", fontSize: "var(--text-sm)", margin: "var(--space-2) 0" }}>
            {formErrors.map((e, i) => (
              <p key={i} style={{ margin: 0 }}>{e}</p>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-end", flexWrap: "wrap", marginTop: "var(--space-3)" }}>
          <div>
            <label htmlFor="audit-level" style={{ display: "block", fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", textTransform: "uppercase", marginBottom: "var(--space-1)" }}>
              Target level
            </label>
            <select
              id="audit-level"
              value={targetLevel}
              onChange={(e) => setTargetLevel(e.target.value)}
              style={{ padding: "8px", fontSize: "var(--text-sm)", border: "1px solid var(--color-border-strong)", borderRadius: "var(--radius-sm)" }}
            >
              {AUDIT_LEVELS.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={starting}
            style={{ padding: "8px 16px", background: "var(--color-accent)", color: "#ffffff", border: "none", borderRadius: "var(--radius-sm)", cursor: starting ? "wait" : "pointer", fontWeight: 500 }}
          >
            {starting ? "Starting…" : "Start audit"}
          </button>
        </div>
      </form>
      {startMessage && (
        <p aria-live="polite" style={{ margin: "var(--space-3) 0 0 0", fontSize: "var(--text-sm)" }}>{startMessage}</p>
      )}
      {queuedRunId && (
        <div role="status" aria-label={`Run ${queuedRunId} queued`} style={{ marginTop: "var(--space-3)", padding: panel, background: "var(--color-surface-sunken)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)" }}>
          <p style={{ margin: 0, fontSize: "var(--text-md)", fontFamily: "var(--font-mono)" }} aria-hidden="true">…</p>
          <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>
            Queued — the worker starts in under a minute typically. Run <code style={{ fontFamily: "var(--font-mono)" }}>{queuedRunId}</code>
          </p>
        </div>
      )}
    </section>
  ) : null;

  const activeFinding = data?.findings.find((f) => f.finding_id === selectedFindingId) ?? data?.findings[0];
  const activeDecision = data?.decisions.find((d) => d.finding_id === selectedFindingId);
  const activeEvidence = activeFinding
    ? (data?.evidence ?? []).filter((e) => activeFinding.evidence_ids.includes(e.evidence_id))
    : [];

  const handleApprove = async (actionId: string) => {
    if (!data) return;
    if (approverName.trim().length < 2) {
      setApprovalMessage("Approver name required (2-40 characters)");
      return;
    }
    try {
      setApprovalMessage("Approving and executing action...");
      if (!approverPasscode) throw new Error("Approval passcode required");
      await activeDataProvider.approveAction(data.run_id, actionId, approverName.trim(), "approve", undefined, approverPasscode);
      await activeDataProvider.executeAction(data.run_id, actionId, approverPasscode);
      setApproverPasscode("");

      // Re-fetch persisted state directly from store.json
      await fetchRun(data.run_id);
      setApprovalMessage(`Approved & executed by ${approverName.trim()} — saved to store.json`);
    } catch (err: unknown) {
      setApprovalMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleReject = async (actionId: string) => {
    if (!data) return;
    if (approverName.trim().length < 2) {
      setApprovalMessage("Approver name required (2-40 characters)");
      return;
    }
    try {
      setApprovalMessage("Rejecting action...");
      if (!approverPasscode) throw new Error("Approval passcode required");
      await activeDataProvider.approveAction(data.run_id, actionId, approverName.trim(), "reject", undefined, approverPasscode);
      setApproverPasscode("");
      await fetchRun(data.run_id);
      setApprovalMessage(`Rejected by ${approverName.trim()} — saved to store.json`);
    } catch (err: unknown) {
      setApprovalMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (loading) {
    return (
      <main style={{ maxWidth: "var(--grid-max)", margin: "0 auto", padding: "var(--space-6) var(--space-4)" }}>
        <p role="status" style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
          Loading audit results...
        </p>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main style={{ maxWidth: "var(--grid-max)", margin: "0 auto", padding: "var(--space-6) var(--space-4)" }}>
        <header style={{ marginBottom: "var(--space-4)" }}>
          <h1 style={{ fontFamily: "var(--font-serif)", fontSize: "var(--text-xl)" }}>Sunflower Auditor</h1>
        </header>
        <div role="alert" style={{ background: "var(--color-surface)", padding: "var(--space-4)", border: "1px solid var(--color-fail)", borderRadius: "var(--radius-md)", marginBottom: activeDataProvider.startAudit ? "var(--space-6)" : undefined }}>
          <h2 style={{ fontSize: "var(--text-md)", margin: "0 0 var(--space-2) 0", color: "var(--color-fail)" }}>No Run Loaded</h2>
          <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>
            {error ?? (activeDataProvider.startAudit
              ? "No audit runs found yet — start your first audit below."
              : "No audit runs found on disk. Run 'npm run audit' first.")}
          </p>
        </div>
        {newAuditSection}
      </main>
    );
  }

  return (
    <main style={{ maxWidth: "var(--grid-max)", margin: "0 auto", padding: "var(--space-6) var(--space-4)" }}>
      <header style={{ marginBottom: "var(--space-6)", borderBottom: "1px solid var(--color-border)", paddingBottom: "var(--space-4)" }}>
        <p style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", textTransform: "uppercase", letterSpacing: "var(--ls-label)", color: "var(--color-ink-muted)", margin: 0 }}>
          Auditor's Ledger · Sunflower Audit
        </p>
        <h1 style={{ fontFamily: "var(--font-serif)", fontSize: "var(--text-2xl)", margin: "var(--space-2) 0", fontWeight: 600 }}>
          Accessibility Audit Results
        </h1>
        <div style={{ width: 32, height: 2, background: "var(--color-gold)", marginBottom: "var(--space-3)" }} aria-hidden="true" />
        <div style={{ display: "flex", gap: "var(--space-4)", alignItems: "center", fontSize: "var(--text-sm)", flexWrap: "wrap" }}>
          <span>Run: <code style={{ fontFamily: "var(--font-mono)" }}>{data.run_id}</code></span>
          <button
            type="button"
            onClick={() => fetchRun(data.run_id)}
            style={{
              padding: "3px 8px",
              background: "var(--color-surface)",
              border: "1px solid var(--color-border-strong)",
              borderRadius: "var(--radius-sm)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              cursor: "pointer",
            }}
          >
            ↻ Reload Run
          </button>
          {availableRuns.length > 0 && (
            <label style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
              <span>Switch:</span>
              <select
                aria-label="Select audit run"
                value={data.run_id}
                onChange={(e) => fetchRun(e.target.value)}
                style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", padding: "2px 6px" }}
              >
                {availableRuns.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
          )}
          <span>Target: <span style={{ fontWeight: 600 }}>{data.target_level}</span></span>
          <span>
            Status:{" "}
            <span
              style={{
                display: "inline-block",
                padding: "2px 8px",
                border: "1px solid var(--color-border-strong)",
                borderRadius: "var(--radius-sm)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
              }}
            >
              {data.status.toUpperCase()}
            </span>
          </span>
        </div>
      </header>

      {/* New Audit (P1-T3) — rendered in the main view; also present in the empty state below. */}
      {newAuditSection}

      {/* Run Timeline & Plan */}
      <section aria-labelledby="timeline-heading" style={{ marginBottom: "var(--space-6)", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--space-4)" }}>
        <h2 id="timeline-heading" style={{ fontFamily: "var(--font-serif)", fontSize: "var(--text-lg)", margin: "0 0 var(--space-3) 0" }}>
          Run Timeline & Plan
        </h2>
        <ol style={{ margin: 0, paddingLeft: "var(--space-5)", fontSize: "var(--text-sm)", lineHeight: "var(--lh-base)" }}>
          {data.plan_json?.map((p, idx) => (
            <li key={idx} style={{ marginBottom: "var(--space-2)" }}>
              <strong style={{ fontFamily: "var(--font-mono)" }}>{p.check}</strong>: {p.reason}
            </li>
          ))}
        </ol>
      </section>

      {/* Main 7/5 Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "7fr 5fr", gap: "var(--space-6)" }}>
        {/* Left Column: Issue List & Decision Ledger */}
        <section aria-labelledby="issues-heading">
          <h2 id="issues-heading" style={{ fontFamily: "var(--font-serif)", fontSize: "var(--text-lg)", margin: "0 0 var(--space-3) 0" }}>
            Findings Ledger ({data.findings.length})
          </h2>
          <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
            <thead>
              <tr style={{ background: "var(--color-surface-sunken)", borderBottom: "1px solid var(--color-border)", textAlign: "left" }}>
                <th scope="col" style={{ padding: "8px 12px", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", textTransform: "uppercase" }}>Criterion</th>
                <th scope="col" style={{ padding: "8px 12px", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", textTransform: "uppercase" }}>Rule</th>
                <th scope="col" style={{ padding: "8px 12px", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", textTransform: "uppercase" }}>State</th>
                <th scope="col" style={{ padding: "8px 12px", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", textTransform: "uppercase" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.findings.map((f) => (
                <tr
                  key={f.finding_id}
                  style={{
                    borderBottom: "1px solid var(--color-border)",
                    background: selectedFindingId === f.finding_id ? "var(--color-accent-soft)" : "transparent",
                    cursor: "pointer",
                  }}
                  onClick={() => setSelectedFindingId(f.finding_id)}
                >
                  <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>{f.wcag_criterion}</td>
                  <td style={{ padding: "10px 12px", fontSize: "var(--text-sm)" }}>
                    <strong>{f.rule_id}</strong>
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--color-ink-muted)" }}>{f.selector}</div>
                  </td>
                  <td style={{ padding: "10px 12px" }}>
                    <span
                      style={{
                        padding: "2px 6px",
                        fontSize: "var(--text-xs)",
                        fontFamily: "var(--font-mono)",
                        borderRadius: "var(--radius-sm)",
                        border: f.state === "fail" ? "1px solid var(--color-fail)" : "1px dashed var(--color-uncertain)",
                        background: f.state === "fail" ? "var(--color-fail-bg)" : "var(--color-uncertain-bg)",
                        color: f.state === "fail" ? "var(--color-fail)" : "var(--color-uncertain)",
                      }}
                    >
                      {f.state === "fail" ? "✕ FAIL" : "? UNCERTAIN"}
                    </span>
                  </td>
                  <td style={{ padding: "10px 12px" }}>
                    <button
                      type="button"
                      style={{
                        padding: "4px 8px",
                        background: "var(--color-surface)",
                        border: "1px solid var(--color-border-strong)",
                        borderRadius: "var(--radius-sm)",
                        fontSize: "var(--text-xs)",
                        cursor: "pointer",
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedFindingId(f.finding_id);
                      }}
                    >
                      Inspect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Active Decision Traceability */}
          {activeFinding && (
            <div style={{ marginTop: "var(--space-5)", padding: "var(--space-4)", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)" }}>
              <h3 style={{ fontFamily: "var(--font-serif)", fontSize: "var(--text-md)", margin: "0 0 var(--space-2) 0" }}>
                Decision Audit Trail
              </h3>
              <p style={{ fontSize: "var(--text-sm)", lineHeight: "var(--lh-base)", margin: "0 0 var(--space-2) 0" }}>
                <strong>Finding ID:</strong> <code style={{ fontFamily: "var(--font-mono)" }}>{activeFinding.finding_id}</code>
              </p>
              <p style={{ fontSize: "var(--text-sm)", lineHeight: "var(--lh-base)", margin: "0 0 var(--space-2) 0" }}>
                <strong>Written Reason:</strong> {activeFinding.reason}
              </p>
              <p style={{ fontSize: "var(--text-sm)", color: "var(--color-ink-muted)", margin: 0 }}>
                Traceability: <code style={{ fontFamily: "var(--font-mono)" }}>{data.run_id} → pg-01 → src-01 → {activeDecision?.decision_id ?? "dec-auto"}</code>
              </p>
            </div>
          )}
        </section>

        {/* Right Column: Evidence Well & Human Approval Gate */}
        <section aria-labelledby="evidence-heading">
          <h2 id="evidence-heading" style={{ fontFamily: "var(--font-serif)", fontSize: "var(--text-lg)", margin: "0 0 var(--space-3) 0" }}>
            Evidence Well & Approval Gate
          </h2>

          {/* Evidence Well — renders the actual artifacts for the selected
              finding inside a labelled, keyboard-scrollable region. */}
          <div style={{ background: "var(--color-surface-sunken)", padding: "var(--space-4)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", marginBottom: "var(--space-5)" }}>
            <h3 style={{ fontFamily: "var(--font-serif)", fontSize: "var(--text-md)", margin: "0 0 var(--space-2) 0" }}>
              Evidence Well: {activeFinding?.rule_id}
            </h3>
            <p style={{ fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", color: "var(--color-ink-muted)", margin: "0 0 var(--space-3) 0" }}>
              Attached Artifacts ({activeFinding?.evidence_ids.length ?? 0})
            </p>
            {activeEvidence.length > 0 && (
              <div
                role="region"
                aria-label={`Evidence artifacts for ${activeFinding?.rule_id} (${activeFinding?.wcag_criterion})`}
                tabIndex={0}
                style={{ overflowX: "auto", maxHeight: "360px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", padding: "var(--space-2)", background: "var(--color-surface)" }}
              >
                {activeEvidence.map((ev) => (
                  <figure key={ev.evidence_id} style={{ margin: "0 0 var(--space-3) 0" }}>
                    <figcaption style={{ fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", color: "var(--color-ink-muted)", marginBottom: "var(--space-1)" }}>
                      {ev.type} · SHA-256 {ev.checksum?.slice(0, 8)}
                    </figcaption>
                    {(ev.type === "screenshot" || ev.type === "pixel_sample") && (
                      <img
                        src={activeDataProvider.evidenceUrl(data.run_id, ev.path)}
                        alt={`${ev.type === "screenshot" ? "Screenshot" : "Pixel sample"} captured during the audit — evidence for ${activeFinding?.rule_id} (WCAG ${activeFinding?.wcag_criterion})`}
                        style={{ maxWidth: "100%", height: "auto", border: "1px solid var(--color-border)", display: "block" }}
                      />
                    )}
                    {ev.type === "video" && (
                      <video
                        src={activeDataProvider.evidenceUrl(data.run_id, ev.path)}
                        controls
                        aria-label={`Keyboard walk video recording — evidence for ${activeFinding?.rule_id} (WCAG ${activeFinding?.wcag_criterion})`}
                        style={{ maxWidth: "100%", border: "1px solid var(--color-border)", display: "block" }}
                      />
                    )}
                    {(ev.type !== "screenshot" && ev.type !== "pixel_sample" && ev.type !== "video") && (
                      <a
                        href={activeDataProvider.evidenceUrl(data.run_id, ev.path)}
                        style={{ fontSize: "var(--text-sm)", fontFamily: "var(--font-mono)" }}
                      >
                        Open {ev.type.replace("_", " ")} artifact ({ev.path.split("/").pop()})
                      </a>
                    )}
                  </figure>
                ))}
              </div>
            )}
          </div>

          {/* Human Approval Gate */}
          <div style={{ background: "var(--color-surface)", padding: "var(--space-4)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)" }}>
            <h3 style={{ fontFamily: "var(--font-serif)", fontSize: "var(--text-md)", margin: "0 0 var(--space-2) 0" }}>
              Human Approval Gate (FR-09)
            </h3>
            <p style={{ fontSize: "var(--text-sm)", color: "var(--color-ink-muted)", margin: "0 0 var(--space-3) 0" }}>
              Destination: Issue Log · Run <code style={{ fontFamily: "var(--font-mono)" }}>{data.run_id}</code>. Nothing logs without human approval.
            </p>

            {data.actions.map((act) => (
              <div key={act.action_id} style={{ borderTop: "1px solid var(--color-border)", paddingTop: "var(--space-3)", marginTop: "var(--space-3)" }}>
                <p style={{ fontSize: "var(--text-sm)", margin: "0 0 var(--space-2) 0" }}>
                  <strong>Proposed Payload:</strong>
                </p>
                <pre style={{ background: "var(--color-surface-sunken)", padding: "var(--space-2)", fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", overflowX: "auto", margin: "0 0 var(--space-3) 0" }}>
                  {JSON.stringify(act.payload_json, null, 2)}
                </pre>

                {act.status === "proposed" ? (
                  <div>
                    <label htmlFor="approver-input" style={{ display: "block", fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", textTransform: "uppercase", marginBottom: "var(--space-1)" }}>
                      Approver Name (2–40 chars):
                    </label>
                    <input
                      id="approver-input"
                      type="text"
                      value={approverName}
                      onChange={(e) => setApproverName(e.target.value)}
                      placeholder="e.g. Lead Auditor Jane"
                      style={{ width: "100%", boxSizing: "border-box", padding: "8px", fontSize: "var(--text-sm)", border: "1px solid var(--color-border-strong)", borderRadius: "var(--radius-sm)", marginBottom: "var(--space-3)" }}
                    />
                    <label htmlFor="passcode-input" style={{ display: "block", fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", textTransform: "uppercase", marginBottom: "var(--space-1)" }}>
                      Approval Passcode
                    </label>
                    <input
                      id="passcode-input"
                      type="password"
                      autoComplete="one-time-code"
                      value={approverPasscode}
                      onChange={(e) => setApproverPasscode(e.target.value)}
                      placeholder="Typed only for this action"
                      style={{ width: "100%", boxSizing: "border-box", padding: "8px", fontSize: "var(--text-sm)", border: "1px solid var(--color-border-strong)", borderRadius: "var(--radius-sm)", marginBottom: "var(--space-3)" }}
                    />
                    <div style={{ display: "flex", gap: "var(--space-2)" }}>
                      <button
                        type="button"
                        onClick={() => handleApprove(act.action_id)}
                        style={{ padding: "8px 16px", background: "var(--color-accent)", color: "#ffffff", border: "none", borderRadius: "var(--radius-sm)", cursor: "pointer", fontWeight: 500 }}
                      >
                        Approve and Log
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReject(act.action_id)}
                        style={{ padding: "8px 16px", background: "transparent", color: "var(--color-fail)", border: "1px solid var(--color-fail)", borderRadius: "var(--radius-sm)", cursor: "pointer" }}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    style={{
                      padding: "8px 12px",
                      background: act.status === "executed" ? "var(--color-accent-soft)" : "var(--color-fail-bg)",
                      color: act.status === "executed" ? "var(--color-pass)" : "var(--color-fail)",
                      border: act.status === "executed" ? "1px solid var(--color-pass)" : "1px solid var(--color-fail)",
                      borderRadius: "var(--radius-sm)",
                      fontSize: "var(--text-sm)",
                      fontWeight: 500,
                    }}
                  >
                    {act.status === "executed" ? "✓ EXECUTED: Logged to Issue Register" : "✕ REJECTED: Action not executed"}
                  </div>
                )}
              </div>
            ))}

            {approvalMessage && (
              <p style={{ marginTop: "var(--space-3)", fontSize: "var(--text-xs)", color: "var(--color-ink-muted)" }} aria-live="polite">
                {approvalMessage}
              </p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

