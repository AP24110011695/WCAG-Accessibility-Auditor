// Supabase Edge Function: trigger-audit (P1-T1, architecture.md §11.4).
// Deno runtime. Creates the pending run row, then dispatches the GitHub
// Actions worker. Uses raw PostgREST fetch calls — no client dependency.
//
// Abuse protection (FR-13): browser-origin allowlist, audit-target host
// allowlist, page cap, and a global runs-per-hour limit counted from the DB.
// Authoritative input validation re-runs in the agent (Stage 1) — the checks
// here are the cheap gate in front of our free quotas.
//
// Platform injects SUPABASE_URL and the API keys: SUPABASE_SECRET_KEYS (new-style
// sb_secret_ keys, JSON dict) plus legacy SUPABASE_SERVICE_ROLE_KEY. Custom secrets:
// GITHUB_PAT, GITHUB_REPO, ALLOWED_ORIGINS, DEMO_SITE_URL and AUDIT_ALLOWLIST.
// Config: ALLOWED_ORIGINS, DEMO_SITE_URL, AUDIT_ALLOWLIST, MAX_PAGES_PER_RUN
// (default 5), MAX_RUNS_PER_HOUR (default 10), GITHUB_REF (default "main").

const GH_API = "https://api.github.com";

const json = (body: unknown, status: number, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });

function corsHeaders(req: Request): Record<string, string> {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("origin") ?? "";
  return origin && allowed.includes(origin)
    ? { "access-control-allow-origin": origin, "vary": "Origin" }
    : {};
}

function allowedHosts(): string[] {
  const hosts: string[] = [];
  const demo = Deno.env.get("DEMO_SITE_URL");
  if (demo) {
    try {
      hosts.push(new URL(demo).hostname.toLowerCase());
    } catch { /* misconfigured DEMO_SITE_URL: fall through to AUDIT_ALLOWLIST */ }
  }
  for (const h of (Deno.env.get("AUDIT_ALLOWLIST") ?? "").split(",")) {
    const t = h.trim().toLowerCase();
    if (t) hosts.push(t);
  }
  return [...new Set(hosts)];
}

function checkInput(body: unknown): { errors: string[]; urls?: string[]; level?: string } {
  const maxPages = Number(Deno.env.get("MAX_PAGES_PER_RUN") ?? 5);
  const hosts = allowedHosts();
  const errors: string[] = [];
  if (typeof body !== "object" || body === null) return { errors: ["JSON object with urls and target_level required."] };
  const { urls, target_level } = body as Record<string, unknown>;
  if (!Array.isArray(urls) || urls.length === 0) {
    errors.push("At least one page URL is required.");
  } else {
    if (urls.length > maxPages) errors.push(`At most ${maxPages} pages per audit.`);
    for (const u of urls) {
      if (typeof u !== "string") {
        errors.push("URL must be a string.");
        continue;
      }
      let parsed: URL;
      try {
        parsed = new URL(u.trim());
      } catch {
        errors.push(`Not a valid URL: ${u}`);
        continue;
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") errors.push(`Only http(s) URLs: ${u}`);
      const host = parsed.hostname.toLowerCase();
      if (hosts.length > 0 && !hosts.includes(host)) errors.push(`Target not allowlisted: ${host}`);
    }
  }
  if (typeof target_level !== "string" || !/^WCAG2\.[12]-(A|AA)$/.test(target_level)) {
    errors.push("target_level must be WCAG2.1-A, WCAG2.1-AA, WCAG2.2-A or WCAG2.2-AA.");
  }
  return { errors, urls: Array.isArray(urls) ? urls as string[] : undefined, level: typeof target_level === "string" ? target_level : undefined };
}

// Elevated key: new-style secret keys first (legacy keys are deprecated by end
// of 2026); SUPABASE_SERVICE_ROLE_KEY remains for projects still on legacy keys.
function serviceKey(): string {
  // A project-specific fallback makes deployments reliable on runtimes where
  // the platform-managed key dictionary is not exposed to a function.
  const configured = Deno.env.get("APP_SUPABASE_SECRET_KEY");
  if (configured) return configured;
  try {
    const dict = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "") as Record<string, string>;
    if (typeof dict["default"] === "string" && dict["default"]) return dict["default"];
  } catch { /* not set or not JSON — legacy project, fall through */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

function restHeaders(): Record<string, string> {
  return {
    "apikey": serviceKey(),
    "content-type": "application/json",
  };
}

function newRunId(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const suffix = [...crypto.getRandomValues(new Uint8Array(2))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `run-${stamp}-${suffix}`;
}

async function runsInLastHour(): Promise<number> {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const res = await fetch(
    `${Deno.env.get("SUPABASE_URL")}/rest/v1/runs?select=run_id&created_at=gte.${since}`,
    { headers: { ...restHeaders(), "prefer": "count=exact" } },
  );
  if (!res.ok) throw new Error(`rate-limit count failed: ${res.status}`);
  const range = res.headers.get("content-range") ?? "/*";
  return Number(range.split("/")[1] ?? Infinity);
}

async function dispatchWorkflow(runId: string): Promise<void> {
  const repo = Deno.env.get("GITHUB_REPO");
  if (!repo) throw new Error("GITHUB_REPO secret missing");
  const res = await fetch(`${GH_API}/repos/${repo}/actions/workflows/audit.yml/dispatches`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${Deno.env.get("GITHUB_PAT") ?? ""}`,
      "accept": "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: Deno.env.get("GITHUB_REF") ?? "main", inputs: { run_id: runId } }),
  });
  if (res.status !== 204) {
    throw new Error(`workflow dispatch failed (${res.status}); check the PAT's Actions: read and write permission`);
  }
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, cors);

  const origin = req.headers.get("origin");
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (origin && !allowed.includes(origin)) return json({ error: "Origin not allowed." }, 403, cors);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400, cors);
  }

  const { errors, urls, level } = checkInput(body);
  if (errors.length > 0 || !urls || !level) return json({ error: "Invalid audit request.", details: errors }, 400, cors);

  try {
    const maxPerHour = Number(Deno.env.get("MAX_RUNS_PER_HOUR") ?? 10);
    if (await runsInLastHour() >= maxPerHour) {
      return json({ error: `Rate limit: at most ${maxPerHour} audits per hour.` }, 429, { ...cors, "retry-after": "3600" });
    }

    const runId = newRunId();
    const insert = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/runs`, {
      method: "POST",
      headers: { ...restHeaders(), "prefer": "return=minimal" },
      body: JSON.stringify({
        run_id: runId,
        target_level: level,
        status: "pending",
        config_json: { urls, target_level: level, max_pages: maxPages, allowed_hosts: allowedHosts() },
        trigger_source: "edge_function",
      }),
    });
    if (insert.status !== 201) throw new Error(`run insert failed (${insert.status})`);

    await dispatchWorkflow(runId);
    return json({ run_id: runId, status: "pending" }, 200, cors);
  } catch (err) {
    return json({ error: "Could not start the audit.", details: [String(err instanceof Error ? err.message : err)] }, 502, cors);
  }
});
