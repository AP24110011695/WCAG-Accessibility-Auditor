// Dashboard Data Layer (architecture.md §2).
// Provides a unified interface for the React dashboard.
// Default: LocalApiAdapter (talking to the local REST server during local testing/verification).
// Deployment: SupabaseApiAdapter (talking directly to Supabase Postgres + Storage via PostgREST).

interface DashboardDataProvider {
  getRuns(): Promise<string[]>;
  getRun(runId?: string): Promise<any>;
  approveAction(runId: string, actionId: string, approverName: string, decision: "approve" | "reject", reason?: string, passcode?: string): Promise<void>;
  executeAction(runId: string, actionId: string, passcode?: string): Promise<void>;
  evidenceUrl(runId: string, path: string): string;
  // P1-T3: dispatch a new audit via the trigger-audit Edge Function.
  // Optional: the local adapter has no trigger endpoint (runs start via CLI).
  startAudit?(urls: string[], targetLevel: string): Promise<{ run_id: string; status: string }>;
}

class LocalApiAdapter implements DashboardDataProvider {
  async getRuns(): Promise<string[]> {
    const res = await fetch("/api/runs");
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? list : [];
  }

  async getRun(runId?: string): Promise<any> {
    const url = runId ? `/api/run?id=${encodeURIComponent(runId)}` : "/api/run";
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `Failed to load run: HTTP ${res.status}`);
    }
    return res.json();
  }

  async approveAction(runId: string, actionId: string, approverName: string, decision: "approve" | "reject", reason?: string): Promise<void> {
    const res = await fetch("/api/action/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId, action_id: actionId, decision, approver_name: approverName, reason }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? "Approval failed");
    }
  }

  async executeAction(runId: string, actionId: string): Promise<void> {
    const res = await fetch("/api/action/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId, action_id: actionId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? "Execution failed");
    }
  }

  evidenceUrl(runId: string, path: string): string {
    return `/output/${encodeURIComponent(runId)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  }
}

class SupabaseApiAdapter implements DashboardDataProvider {
  private readonly baseUrl: string;
  private readonly publishableKey: string;

  constructor(supabaseUrl?: string, publishableKey?: string) {
    this.baseUrl = (supabaseUrl || (import.meta as any).env?.VITE_SUPABASE_URL || "").replace(/\/$/, "");
    this.publishableKey = publishableKey || (import.meta as any).env?.VITE_SUPABASE_PUBLISHABLE_KEY || "";
  }

  private headers(): Record<string, string> {
    return {
      apikey: this.publishableKey,
      authorization: `Bearer ${this.publishableKey}`,
      "content-type": "application/json",
    };
  }

  async getRuns(): Promise<string[]> {
    if (!this.baseUrl || !this.publishableKey) return [];
    const res = await fetch(`${this.baseUrl}/rest/v1/runs?select=run_id&order=created_at.desc`, {
      headers: this.headers(),
    });
    if (!res.ok) return [];
    const rows = await res.json();
    return Array.isArray(rows) ? rows.map((r: any) => r.run_id) : [];
  }

  async getRun(runId?: string): Promise<any> {
    if (!this.baseUrl || !this.publishableKey) throw new Error("Supabase credentials not configured in environment");
    const targetRun = runId
      ? runId
      : (await this.getRuns())[0];
    if (!targetRun) throw new Error("No runs found in Supabase database");

    const [runRes, inputsRes, findingsRes, decisionsRes, actionsRes, issuesRes, evidenceRes] = await Promise.all([
      fetch(`${this.baseUrl}/rest/v1/runs?run_id=eq.${encodeURIComponent(targetRun)}`, { headers: this.headers() }),
      fetch(`${this.baseUrl}/rest/v1/page_inputs?run_id=eq.${encodeURIComponent(targetRun)}`, { headers: this.headers() }),
      fetch(`${this.baseUrl}/rest/v1/findings?run_id=eq.${encodeURIComponent(targetRun)}`, { headers: this.headers() }),
      fetch(`${this.baseUrl}/rest/v1/decisions?select=*`, { headers: this.headers() }),
      fetch(`${this.baseUrl}/rest/v1/actions?select=*`, { headers: this.headers() }),
      fetch(`${this.baseUrl}/rest/v1/issues?select=*`, { headers: this.headers() }),
      fetch(`${this.baseUrl}/rest/v1/evidence?run_id=eq.${encodeURIComponent(targetRun)}`, { headers: this.headers() }),
    ]);

    const runRow = (await runRes.json())[0] ?? {};
    return {
      runs: [runRow],
      page_inputs: await inputsRes.json(),
      findings: await findingsRes.json(),
      decisions: await decisionsRes.json(),
      actions: await actionsRes.json(),
      issues: await issuesRes.json(),
      evidence: ((await evidenceRes.json()) as any[]).map((e) => ({
        evidence_id: e.evidence_id,
        type: e.type,
        path: e.storage_path,
        checksum: e.checksum,
      })),
    };
  }

  async approveAction(_runId: string, actionId: string, approverName: string, decision: "approve" | "reject", reason?: string, passcode?: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/functions/v1/approve-action`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        operation: decision,
        action_id: actionId,
        approver_name: approverName,
        reason: reason ?? null,
        passcode,
      }),
    });
    if (!res.ok) throw new Error(`Supabase approval failed: ${await res.text()}`);
  }

  async executeAction(_runId: string, actionId: string, passcode?: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/functions/v1/approve-action`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ operation: "execute", action_id: actionId, passcode }),
    });
    if (!res.ok) throw new Error(`Supabase execution failed: ${await res.text()}`);
  }

  // The evidence bucket is public-read, so artifact URLs need no key.
  evidenceUrl(_runId: string, path: string): string {
    return `${this.baseUrl}/storage/v1/object/public/evidence/${path.split("/").map(encodeURIComponent).join("/")}`;
  }

  // P1-T3 (FR-01/FR-13): the Edge Function re-validates everything (allowlist,
  // page cap, hourly rate limit) — client checks are only the cheap gate.
  async startAudit(urls: string[], targetLevel: string): Promise<{ run_id: string; status: string }> {
    const res = await fetch(`${this.baseUrl}/functions/v1/trigger-audit`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ urls, target_level: targetLevel }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const details = Array.isArray(body.details) && body.details.length > 0 ? ` (${body.details.join("; ")})` : "";
      throw new Error(`${body.error ?? `Trigger failed: HTTP ${res.status}`}${details}`);
    }
    return body;
  }
}

// Select active adapter based on environment variable (VITE_DATA_PROVIDER="supabase" vs "local")
export const activeDataProvider: DashboardDataProvider =
  (import.meta as any).env?.VITE_DATA_PROVIDER === "supabase"
    ? new SupabaseApiAdapter()
    : new LocalApiAdapter();
