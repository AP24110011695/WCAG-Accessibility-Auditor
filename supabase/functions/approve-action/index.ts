// Server-side approval gate. The public dashboard submits a transient passcode;
// this function verifies it and is the only public path to the protected RPCs.
import { approvePasscode } from "../../../agent/src/approval.ts";
function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((v) => v.trim());
  return origin && allowed.includes(origin) ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
}
const json = (body: unknown, status: number, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...extra },
});

// Elevated key: new-style secret keys first (legacy keys are deprecated by end
// of 2026); SUPABASE_SERVICE_ROLE_KEY remains for projects still on legacy keys.
function serviceKey(): string {
  const configured = Deno.env.get("APP_SUPABASE_SECRET_KEY");
  if (configured) return configured;
  try {
    const dict = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "") as Record<string, string>;
    if (typeof dict["default"] === "string" && dict["default"]) return dict["default"];
  } catch { /* not set or not JSON — legacy project, fall through */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

function headers(): Record<string, string> {
  const key = serviceKey();
  return { apikey: key, "content-type": "application/json" };
}

Deno.serve(async (req) => {
  const corsHeaders = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, corsHeaders);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const expected = Deno.env.get("APPROVER_PASSCODE");
  const client = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "global";
  if (!approvePasscode(body.passcode, expected, client)) return json({ error: "Invalid approval passcode" }, 403, corsHeaders);
  const actionId = typeof body.action_id === "string" ? body.action_id : "";
  const operation = body.operation;
  if (!actionId || (operation !== "approve" && operation !== "execute" && operation !== "reject")) {
    return json({ error: "action_id and valid operation required" }, 400, corsHeaders);
  }
  const base = Deno.env.get("SUPABASE_URL");
  if (!base) return json({ error: "Server configuration missing" }, 500, corsHeaders);
  const url = operation === "execute" ? "/rest/v1/rpc/execute_approved_action" : "/rest/v1/rpc/approve_action";
  const payload = operation === "execute"
    ? { p_action_id: actionId }
    : {
        p_action_id: actionId,
        p_decision: operation === "approve" ? "approve" : "reject",
        p_approver: body.approver_name,
        p_reason: body.reason ?? null,
      };
  const res = await fetch(`${base}${url}`, { method: "POST", headers: headers(), body: JSON.stringify(payload) });
  if (!res.ok) return json({ error: "Action rejected", detail: await res.text() }, res.status, corsHeaders);
  return new Response(await res.text(), { status: 200, headers: { "content-type": "application/json", ...corsHeaders } });
});
