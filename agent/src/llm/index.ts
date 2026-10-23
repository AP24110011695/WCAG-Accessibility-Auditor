import { createHash } from "node:crypto";

interface LlmExplanationRequest {
  ruleId: string;
  criterion: string;
  selector?: string;
  htmlSnippet?: string;
  measuredContext?: string;
}

interface LlmExplanationResponse {
  summary: string;
  recommendation: string;
  status: "ok" | "quota_exhausted" | "disabled" | "none";
}

const memoryCache = new Map<string, LlmExplanationResponse>();
export function clearLlmCache(): void { memoryCache.clear(); }

function requestHash(req: LlmExplanationRequest): string {
  return createHash("sha256").update(JSON.stringify(req)).digest("hex");
}

const unavailable = (status: "quota_exhausted" | "disabled"): LlmExplanationResponse => ({
  summary: "Explanation unavailable", recommendation: "Refer to official WCAG understanding docs for standard remediation.", status,
});

async function ask(baseUrl: string, key: string, model: string, req: LlmExplanationRequest): Promise<LlmExplanationResponse> {
  const content = `Explain this already-determined WCAG finding. Do not change its verdict. Rule: ${req.ruleId}; criterion: ${req.criterion}; selector: ${req.selector ?? "unknown"}; context: ${req.measuredContext ?? "none"}. Return concise remediation.`;
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content }], temperature: 0 }),
  });
  if (!response.ok) throw Object.assign(new Error(`LLM HTTP ${response.status}`), { status: response.status });
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("LLM response has no explanation");
  return { summary: text, recommendation: text, status: "ok" };
}

async function attempt(baseUrl: string, key: string, model: string, req: LlmExplanationRequest): Promise<LlmExplanationResponse> {
  const retries = Math.max(0, Number(process.env.LLM_MAX_RETRIES ?? 2));
  for (let i = 0; ; i++) {
    try { return await ask(baseUrl, key, model, req); }
    catch (error: unknown) {
      if ((error as { status?: number }).status !== 429 || i >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, (25 * (2 ** i)) + Math.floor(Math.random() * 25)));
    }
  }
}

export async function explainFinding(req: LlmExplanationRequest): Promise<LlmExplanationResponse> {
  const hash = requestHash(req);
  const cached = memoryCache.get(hash);
  if (cached) return cached;

  const primary = { url: process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1", key: process.env.LLM_API_KEY || process.env.GROQ_API_KEY || "", model: process.env.LLM_MODEL || "llama-3.3-70b-versatile" };
  const fallback = { url: process.env.LLM_FALLBACK_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai", key: process.env.LLM_FALLBACK_API_KEY || process.env.GEMINI_API_KEY || "", model: process.env.LLM_FALLBACK_MODEL || "gemini-2.5-flash" };
  if (!primary.key && !fallback.key) return unavailable("disabled");
  for (const provider of [primary, fallback]) {
    if (!provider.key) continue;
    try { const result = await attempt(provider.url, provider.key, provider.model, req); memoryCache.set(hash, result); return result; } catch { /* use fallback */ }
  }
  return unavailable("quota_exhausted");
}
