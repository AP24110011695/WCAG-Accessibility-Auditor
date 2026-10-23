// Storage interface (architecture.md §4/§11): the engine only knows this
// contract; LocalStore writes one self-contained folder per run
// (output/<runId>/store.json + evidence/). The Supabase adapter later
// implements the same methods against Postgres + Storage — engine untouched.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId } from "../ids.ts";

export type EvidenceType =
  | "screenshot" | "video" | "dom_snippet" | "keystroke_trace"
  | "pixel_sample" | "axe_report";

export interface EvidenceRef {
  evidence_id: string;
  type: EvidenceType;
  path: string; // relative to the run folder — self-contained by construction
  checksum: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

export interface PlanEntry {
  check: "fetch" | "axe" | "keyboard_walk" | "modal_trap_walk" | "contrast_sample" | "heuristics";
  reason: string;
  scope: "run" | "page";
}

export interface RunRow {
  run_id: string;
  created_at: string;
  target_level: string;
  status: string; // pending|collecting|planning|finding|done|failed
  config_json: { urls: string[]; target_level: string; max_pages: number; allowed_hosts: string[] };
  trigger_source: "local" | "edge_function" | "manual_dispatch";
  plan_json?: PlanEntry[];
}

export interface PageInputRow {
  input_id: string;
  run_id: string;
  url: string;
  validation_status: "valid" | "invalid";
  validation_errors?: string[];
}

export interface SourceRow {
  source_id: string;
  input_id: string;
  url: string;
  retrieved_at: string;
  http_status: number | null;
  fetch_method: "cheerio" | "playwright";
  content_hash: string;
  snapshot_path: string;
}

export interface FindingRow {
  finding_id: string;
  run_id: string;
  input_id: string;
  source_id: string;
  rule_id: string;
  wcag_criterion: string;
  selector?: string;
  check_type: "axe" | "keyboard" | "contrast" | "heuristic" | "collect";
  state: "fail" | "pass" | "uncertain";
  reason: string;
  evidence_ids: string[];
}

export interface DecisionRow {
  decision_id: string;
  finding_id: string | null; // null = page-level aggregate pass
  input_id: string;
  outcome: "fail" | "pass" | "uncertain";
  rule: string;
  reason: string;
  input_evidence_ids: string[];
  llm_involved: boolean;
  llm_status: "ok" | "quota_exhausted" | "disabled" | "none";
}

export interface ActionRow {
  action_id: string;
  idempotency_key: string;
  action_type: "log_issue" | "close_issue";
  status: "proposed" | "approved" | "executing" | "executed" | "failed" | "rejected";
  payload_json: Record<string, unknown>;
  created_at: string;
  executed_at?: string | null;
}

interface ApprovalRow {
  approval_id: string;
  action_id: string;
  decision: "approve" | "reject";
  approver: string;
  reason?: string | null;
  approved_at: string;
}

interface IssueRow {
  issue_id: string;
  finding_id: string;
  action_id: string;
  title: string;
  description: string;
  wcag_criterion: string;
  severity: "critical" | "serious" | "moderate" | "minor";
  status: "open" | "closed";
}

export interface RetestRow {
  retest_id: string;
  issue_id: string;
  run_id: string;
  intended: string;
  observed: string;
  outcome: "pass" | "fail" | "uncertain";
  evidence_ids: string[];
  created_at: string;
}

export interface StoreDocument {
  runs: RunRow[];
  page_inputs: PageInputRow[];
  sources: SourceRow[];
  findings: FindingRow[];
  decisions: DecisionRow[];
  evidence: EvidenceRef[];
  actions: ActionRow[];
  approvals: ApprovalRow[];
  issues: IssueRow[];
  retests: RetestRow[];
}

const emptyDoc = (): StoreDocument => ({
  runs: [],
  page_inputs: [],
  sources: [],
  findings: [],
  decisions: [],
  evidence: [],
  actions: [],
  approvals: [],
  issues: [],
  retests: [],
});

export interface AuditStore {
  readonly runId: string;
  initRun(run: RunRow): Promise<void>;
  updateRun(patch: Partial<Pick<RunRow, "status" | "plan_json">>): Promise<void>;
  addPageInput(row: Omit<PageInputRow, "run_id">): Promise<void>;
  addSource(row: Omit<SourceRow, "source_id">): Promise<SourceRow>;
  addFinding(row: Omit<FindingRow, "run_id" | "finding_id">): Promise<FindingRow>;
  addDecision(row: Omit<DecisionRow, "decision_id">): Promise<DecisionRow>;
  saveEvidence(name: string, bytes: Uint8Array, type: EvidenceType, metadata?: Record<string, unknown>, findingId?: string): Promise<EvidenceRef>;
  read(): Promise<StoreDocument>;
  proposeAction(action: Omit<ActionRow, "action_id" | "status" | "created_at">): Promise<ActionRow>;
  approveAction(actionId: string, decision: "approve" | "reject", approver: string, reason?: string): Promise<void>;
  executeApprovedAction(actionId: string): Promise<{ status: string; duplicate: boolean; issue_id: string }>;
  addRetest(retest: Omit<RetestRow, "retest_id" | "created_at">): Promise<RetestRow>;
}

export class LocalStore implements AuditStore {
  readonly runId: string;
  private readonly dir: string;

  private constructor(runId: string, dir: string) {
    this.runId = runId;
    this.dir = dir;
  }

  static async open(rootDir: string, runId: string): Promise<LocalStore> {
    const dir = join(rootDir, runId);
    await mkdir(join(dir, "evidence"), { recursive: true });
    const store = new LocalStore(runId, dir);
    try {
      await store.read();
    } catch {
      await writeFile(join(dir, "store.json"), JSON.stringify(emptyDoc(), null, 2));
    }
    return store;
  }

  private async mutate(fn: (doc: StoreDocument) => void): Promise<void> {
    const doc = await this.read();
    fn(doc);
    await writeFile(join(this.dir, "store.json"), JSON.stringify(doc, null, 2));
  }

  async read(): Promise<StoreDocument> {
    return JSON.parse(await readFile(join(this.dir, "store.json"), "utf8")) as StoreDocument;
  }

  async initRun(run: RunRow): Promise<void> {
    await this.mutate((doc) => doc.runs.push(run));
  }

  async updateRun(patch: Partial<Pick<RunRow, "status" | "plan_json">>): Promise<void> {
    await this.mutate((doc) => {
      const run = doc.runs.find((r) => r.run_id === this.runId);
      if (run) Object.assign(run, patch);
    });
  }

  async addPageInput(row: Omit<PageInputRow, "run_id">): Promise<void> {
    await this.mutate((doc) => doc.page_inputs.push({ ...row, run_id: this.runId }));
  }

  async addSource(row: Omit<SourceRow, "source_id">): Promise<SourceRow> {
    const full: SourceRow = { source_id: newId("src"), ...row };
    await this.mutate((doc) => doc.sources.push(full));
    return full;
  }

  async addFinding(row: Omit<FindingRow, "run_id" | "finding_id">): Promise<FindingRow> {
    const full: FindingRow = { finding_id: newId("find"), ...row, run_id: this.runId };
    await this.mutate((doc) => doc.findings.push(full));
    return full;
  }

  async addDecision(row: Omit<DecisionRow, "decision_id">): Promise<DecisionRow> {
    const full: DecisionRow = { decision_id: newId("dec"), ...row };
    await this.mutate((doc) => doc.decisions.push(full));
    return full;
  }

  async saveEvidence(
    name: string,
    bytes: Uint8Array,
    type: EvidenceType,
    metadata?: Record<string, unknown>,
    findingId?: string
  ): Promise<EvidenceRef> {
    const safe = name.replace(/[^\w.-]+/g, "_");
    const rel = `evidence/${Date.now()}-${safe}`;
    await writeFile(join(this.dir, rel), bytes);
    const ref: EvidenceRef = {
      evidence_id: newId("ev"),
      type,
      path: rel,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      created_at: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    };
    await this.mutate((doc) => {
      doc.evidence.push(ref);
      if (findingId) {
        const f = doc.findings.find((x) => x.finding_id === findingId);
        if (f) f.evidence_ids.push(ref.evidence_id);
      }
    });
    return ref;
  }

  async proposeAction(action: Omit<ActionRow, "action_id" | "status" | "created_at">): Promise<ActionRow> {
    let result: ActionRow = {
      action_id: newId("act"),
      ...action,
      status: "proposed",
      created_at: new Date().toISOString(),
    };
    await this.mutate((doc) => {
      if (!doc.actions) doc.actions = [];
      const existing = doc.actions.find((a) => a.idempotency_key === action.idempotency_key);
      if (existing) {
        result = existing;
        return;
      }
      doc.actions.push(result);
    });
    return result;
  }

  async approveAction(actionId: string, decision: "approve" | "reject", approver: string, reason?: string): Promise<void> {
    if (decision !== "approve" && decision !== "reject") {
      throw new Error("decision must be approve or reject");
    }
    const cleanApprover = (approver ?? "").trim();
    if (cleanApprover.length < 2 || cleanApprover.length > 40) {
      throw new Error("approver name required (2-40 characters)");
    }

    await this.mutate((doc) => {
      if (!doc.actions) doc.actions = [];
      if (!doc.approvals) doc.approvals = [];
      const act = doc.actions.find((a) => a.action_id === actionId);
      if (!act) throw new Error("action not found");
      if (act.status !== "proposed") {
        throw new Error(`action ${actionId} is not proposed (status: ${act.status})`);
      }

      const apr: ApprovalRow = {
        approval_id: newId("apr"),
        action_id: actionId,
        decision,
        approver: cleanApprover,
        reason: reason ?? null,
        approved_at: new Date().toISOString(),
      };
      doc.approvals.push(apr);
      act.status = decision === "approve" ? "approved" : "rejected";
    });
  }

  async executeApprovedAction(actionId: string): Promise<{ status: string; duplicate: boolean; issue_id: string }> {
    let result = { status: "executed", duplicate: false, issue_id: "" };

    await this.mutate((doc) => {
      if (!doc.actions) doc.actions = [];
      if (!doc.approvals) doc.approvals = [];
      if (!doc.issues) doc.issues = [];

      const act = doc.actions.find((a) => a.action_id === actionId);
      if (!act) throw new Error("action not found");

      if (act.status === "executed") {
        const existingIssue = doc.issues.find((i) => i.action_id === act.action_id);
        result = {
          status: "executed",
          duplicate: true,
          issue_id: existingIssue?.issue_id ?? "",
        };
        return;
      }

      if (act.status !== "approved") {
        throw new Error(`action ${actionId} is not approved (status: ${act.status})`);
      }

      const hasApproval = doc.approvals.some((ap) => ap.action_id === actionId && ap.decision === "approve");
      if (!hasApproval) {
        throw new Error(`action ${actionId} has no approval record`);
      }

      if (act.action_type === "log_issue") {
        const issueId = newId("issue");
        const payload = act.payload_json;
        const issue: IssueRow = {
          issue_id: issueId,
          finding_id: String(payload.finding_id ?? ""),
          action_id: act.action_id,
          title: String(payload.title ?? "Accessibility Issue"),
          description: String(payload.description ?? ""),
          wcag_criterion: String(payload.wcag_criterion ?? "WCAG"),
          severity: (payload.severity as IssueRow["severity"]) ?? "serious",
          status: "open",
        };
        doc.issues.push(issue);
        result = { status: "executed", duplicate: false, issue_id: issueId };
      } else if (act.action_type === "close_issue") {
        const issueId = String(act.payload_json.issue_id ?? "");
        const issue = doc.issues.find((i) => i.issue_id === issueId);
        if (issue) issue.status = "closed";
        result = { status: "executed", duplicate: false, issue_id: issueId };
      } else {
        throw new Error(`unknown action_type: ${act.action_type}`);
      }

      act.status = "executed";
      act.executed_at = new Date().toISOString();
    });

    return result;
  }

  async addRetest(retest: Omit<RetestRow, "retest_id" | "created_at">): Promise<RetestRow> {
    const full: RetestRow = {
      retest_id: newId("ret"),
      ...retest,
      created_at: new Date().toISOString(),
    };
    await this.mutate((doc) => {
      if (!doc.retests) doc.retests = [];
      doc.retests.push(full);
    });
    return full;
  }
}
