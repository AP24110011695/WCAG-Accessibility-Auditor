// Supabase adapter for AuditStore (architecture.md §2, §4, §11).
// Implements the same AuditStore interface against Supabase Postgres (PostgREST)
// and Supabase Storage using native fetch, requiring zero external client dependencies.
import { createHash } from "node:crypto";
import { newId } from "../ids.ts";
import type {
  AuditStore,
  StoreDocument,
  RunRow,
  PageInputRow,
  SourceRow,
  FindingRow,
  DecisionRow,
  EvidenceRef,
  EvidenceType,
  ActionRow,
  RetestRow,
} from "./index.ts";

export class SupabaseStore implements AuditStore {
  readonly runId: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly bucket: string;

  constructor(runId: string, options?: { supabaseUrl?: string; supabaseKey?: string; bucket?: string }) {
    this.runId = runId;
    this.baseUrl = (options?.supabaseUrl ?? process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
    // Elevated key for the worker: sb_secret_... (new-style) or the legacy
    // service_role key during transition. Never a publishable/anon key.
    this.apiKey = options?.supabaseKey ?? process.env.SUPABASE_SECRET_KEY ?? "";
    this.bucket = options?.bucket ?? process.env.SUPABASE_EVIDENCE_BUCKET ?? "evidence";
    if (!this.baseUrl || !this.apiKey) {
      throw new Error("SupabaseStore requires SUPABASE_URL and SUPABASE_SECRET_KEY");
    }
  }

  private headers(prefer = ""): Record<string, string> {
    const h: Record<string, string> = {
      apikey: this.apiKey,
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    };
    if (prefer) h.prefer = prefer;
    return h;
  }

  async initRun(run: RunRow): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rest/v1/runs`, {
      method: "POST",
      headers: this.headers("resolution=merge-duplicates"),
      body: JSON.stringify(run),
    });
    if (!res.ok) throw new Error(`initRun failed: ${res.status} ${await res.text()}`);
  }

  async updateRun(patch: Partial<Pick<RunRow, "status" | "plan_json">>): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rest/v1/runs?run_id=eq.${encodeURIComponent(this.runId)}`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`updateRun failed: ${res.status} ${await res.text()}`);
  }

  async addPageInput(row: Omit<PageInputRow, "run_id">): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rest/v1/page_inputs`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ ...row, run_id: this.runId }),
    });
    if (!res.ok) throw new Error(`addPageInput failed: ${res.status} ${await res.text()}`);
  }

  async addSource(row: Omit<SourceRow, "source_id">): Promise<SourceRow> {
    const full: SourceRow = { source_id: newId("src"), ...row };
    const res = await fetch(`${this.baseUrl}/rest/v1/sources`, {
      method: "POST",
      headers: this.headers("return=representation"),
      body: JSON.stringify(full),
    });
    if (!res.ok) throw new Error(`addSource failed: ${res.status} ${await res.text()}`);
    return full;
  }

  async addFinding(row: Omit<FindingRow, "run_id" | "finding_id">): Promise<FindingRow> {
    const full: FindingRow = { finding_id: newId("find"), ...row, run_id: this.runId };
    const res = await fetch(`${this.baseUrl}/rest/v1/findings`, {
      method: "POST",
      headers: this.headers("return=representation"),
      body: JSON.stringify(full),
    });
    if (!res.ok) throw new Error(`addFinding failed: ${res.status} ${await res.text()}`);
    return full;
  }

  async addDecision(row: Omit<DecisionRow, "decision_id">): Promise<DecisionRow> {
    // The Postgres column is integer; the in-memory row type carries a boolean.
    const llmFlag = row.llm_involved ? 1 : 0;
    const full: DecisionRow = { decision_id: newId("dec"), ...row, llm_involved: llmFlag as unknown as boolean };
    const res = await fetch(`${this.baseUrl}/rest/v1/decisions`, {
      method: "POST",
      headers: this.headers("return=representation"),
      body: JSON.stringify(full),
    });
    if (!res.ok) throw new Error(`addDecision failed: ${res.status} ${await res.text()}`);
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
    const rel = `${this.runId}/${Date.now()}-${safe}`;
    const checksum = createHash("sha256").update(bytes).digest("hex");

    // Upload to Supabase Storage
    const storageRes = await fetch(`${this.baseUrl}/storage/v1/object/${this.bucket}/${rel}`, {
      method: "POST",
      headers: {
        apikey: this.apiKey,
        authorization: `Bearer ${this.apiKey}`,
        "content-type": name.endsWith(".webm") ? "video/webm" : name.endsWith(".png") ? "image/png" : "application/octet-stream",
        "x-upsert": "true",
      },
      body: Buffer.from(bytes),
    });
    if (!storageRes.ok) {
      throw new Error(`saveEvidence storage upload failed: ${storageRes.status} ${await storageRes.text()}`);
    }

    const ref: EvidenceRef = {
      evidence_id: newId("ev"),
      type,
      path: rel,
      checksum,
      created_at: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    };

    const evidenceRes = await fetch(`${this.baseUrl}/rest/v1/evidence`, {
      method: "POST",
      headers: this.headers("return=representation"),
      body: JSON.stringify({
        evidence_id: ref.evidence_id,
        run_id: this.runId,
        finding_id: findingId ?? null,
        type: ref.type,
        storage_path: ref.path,
        checksum: ref.checksum,
        created_at: ref.created_at,
        metadata: ref.metadata ?? null,
      }),
    });
    if (!evidenceRes.ok) throw new Error(`saveEvidence row insert failed: ${evidenceRes.status} ${await evidenceRes.text()}`);

    if (findingId) {
      // Append evidence_id to finding
      const findRes = await fetch(`${this.baseUrl}/rest/v1/findings?finding_id=eq.${encodeURIComponent(findingId)}`, {
        headers: this.headers(),
      });
      if (findRes.ok) {
        const findings = await findRes.json();
        if (findings[0]) {
          const evIds = [...(findings[0].evidence_ids || []), ref.evidence_id];
          const linkRes = await fetch(`${this.baseUrl}/rest/v1/findings?finding_id=eq.${encodeURIComponent(findingId)}`, {
            method: "PATCH",
            headers: this.headers(),
            body: JSON.stringify({ evidence_ids: evIds }),
          });
          if (!linkRes.ok) throw new Error(`saveEvidence finding link failed: ${linkRes.status} ${await linkRes.text()}`);
        }
      }
    }

    return ref;
  }

  async proposeAction(action: Omit<ActionRow, "action_id" | "status" | "created_at">): Promise<ActionRow> {
    const full: ActionRow = {
      action_id: newId("act"),
      ...action,
      status: "proposed",
      created_at: new Date().toISOString(),
    };
    const res = await fetch(`${this.baseUrl}/rest/v1/actions`, {
      method: "POST",
      headers: this.headers("return=representation"),
      body: JSON.stringify(full),
    });
    if (!res.ok) throw new Error(`proposeAction failed: ${res.status} ${await res.text()}`);
    return full;
  }

  async approveAction(actionId: string, decision: "approve" | "reject", approver: string, reason?: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rest/v1/rpc/approve_action`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        p_action_id: actionId,
        p_decision: decision,
        p_approver: approver,
        p_reason: reason ?? null,
      }),
    });
    if (!res.ok) throw new Error(`approveAction failed: ${res.status} ${await res.text()}`);
  }

  async executeApprovedAction(actionId: string): Promise<{ status: string; duplicate: boolean; issue_id: string }> {
    const res = await fetch(`${this.baseUrl}/rest/v1/rpc/execute_approved_action`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ p_action_id: actionId }),
    });
    if (!res.ok) throw new Error(`executeApprovedAction failed: ${res.status} ${await res.text()}`);
    const result = await res.json();
    return {
      status: result.status ?? "executed",
      duplicate: result.duplicate ?? false,
      issue_id: result.issue_id ?? "",
    };
  }

  async addRetest(retest: Omit<RetestRow, "retest_id" | "created_at">): Promise<RetestRow> {
    const full: RetestRow = {
      retest_id: newId("ret"),
      ...retest,
      created_at: new Date().toISOString(),
    };
    const res = await fetch(`${this.baseUrl}/rest/v1/retests`, {
      method: "POST",
      headers: this.headers("return=representation"),
      body: JSON.stringify(full),
    });
    if (!res.ok) throw new Error(`addRetest failed: ${res.status} ${await res.text()}`);
    return full;
  }

  async read(): Promise<StoreDocument> {
    const [runsRes, inputsRes, sourcesRes, findingsRes, evidenceRes, decisionsRes, actionsRes, approvalsRes, issuesRes, retestsRes] =
      await Promise.all([
        fetch(`${this.baseUrl}/rest/v1/runs?run_id=eq.${encodeURIComponent(this.runId)}`, { headers: this.headers() }),
        fetch(`${this.baseUrl}/rest/v1/page_inputs?run_id=eq.${encodeURIComponent(this.runId)}`, { headers: this.headers() }),
        fetch(`${this.baseUrl}/rest/v1/sources?select=*`, { headers: this.headers() }),
        fetch(`${this.baseUrl}/rest/v1/findings?run_id=eq.${encodeURIComponent(this.runId)}`, { headers: this.headers() }),
        fetch(`${this.baseUrl}/rest/v1/evidence?run_id=eq.${encodeURIComponent(this.runId)}`, { headers: this.headers() }),
        fetch(`${this.baseUrl}/rest/v1/decisions?select=*`, { headers: this.headers() }),
        fetch(`${this.baseUrl}/rest/v1/actions?select=*`, { headers: this.headers() }),
        fetch(`${this.baseUrl}/rest/v1/approvals?select=*`, { headers: this.headers() }),
        fetch(`${this.baseUrl}/rest/v1/issues?select=*`, { headers: this.headers() }),
        fetch(`${this.baseUrl}/rest/v1/retests?run_id=eq.${encodeURIComponent(this.runId)}`, { headers: this.headers() }),
      ]);

    return {
      runs: runsRes.ok ? await runsRes.json() : [],
      page_inputs: inputsRes.ok ? await inputsRes.json() : [],
      sources: sourcesRes.ok ? await sourcesRes.json() : [],
      findings: findingsRes.ok ? await findingsRes.json() : [],
      decisions: decisionsRes.ok ? await decisionsRes.json() : [],
      evidence: evidenceRes.ok ? (await evidenceRes.json()).map((e: Record<string, unknown>) => ({
        evidence_id: e.evidence_id,
        type: e.type,
        path: e.storage_path,
        checksum: e.checksum,
        created_at: e.created_at,
        ...(e.metadata ? { metadata: e.metadata } : {}),
      })) : [],
      actions: actionsRes.ok ? await actionsRes.json() : [],
      approvals: approvalsRes.ok ? await approvalsRes.json() : [],
      issues: issuesRes.ok ? await issuesRes.json() : [],
      retests: retestsRes.ok ? await retestsRes.json() : [],
    };
  }
}
