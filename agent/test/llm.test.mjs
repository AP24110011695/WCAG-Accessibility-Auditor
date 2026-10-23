import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { clearLlmCache, explainFinding } from "../src/llm/index.ts";

async function provider(sequence) {
  let calls = 0;
  const server = createServer((_req, res) => {
    const item = sequence[Math.min(calls++, sequence.length - 1)];
    res.writeHead(item.status, { "content-type": "application/json" });
    res.end(JSON.stringify(item.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, get calls() { return calls; }, close: () => new Promise((resolve) => server.close(resolve)) };
}
const request = { ruleId: "image-alt", criterion: "1.1.1", selector: "img" };
const save = (keys) => Object.assign(process.env, keys);

test("LLM success and cache use one request for identical input", async () => {
  const p = await provider([{ status: 200, body: { choices: [{ message: { content: "Add useful alt text." } }] } }]);
  const old = { LLM_API_KEY: process.env.LLM_API_KEY, LLM_BASE_URL: process.env.LLM_BASE_URL, LLM_FALLBACK_API_KEY: process.env.LLM_FALLBACK_API_KEY };
  try { clearLlmCache(); save({ LLM_API_KEY: "a", LLM_BASE_URL: p.url, LLM_FALLBACK_API_KEY: "", LLM_MAX_RETRIES: "0" }); const a = await explainFinding(request); const b = await explainFinding(request); assert.equal(a.status, "ok"); assert.equal(b.summary, "Add useful alt text."); assert.equal(p.calls, 1); } finally { save(old); await p.close(); }
});

test("LLM retries 429 then uses fallback; both failures remain non-blocking", async () => {
  const primary = await provider([{ status: 429, body: {} }]); const fallback = await provider([{ status: 200, body: { choices: [{ message: { content: "Fallback explanation." } }] } }]);
  const old = { LLM_API_KEY: process.env.LLM_API_KEY, LLM_BASE_URL: process.env.LLM_BASE_URL, LLM_FALLBACK_API_KEY: process.env.LLM_FALLBACK_API_KEY, LLM_FALLBACK_BASE_URL: process.env.LLM_FALLBACK_BASE_URL, LLM_MAX_RETRIES: process.env.LLM_MAX_RETRIES };
  try { clearLlmCache(); save({ LLM_API_KEY: "a", LLM_BASE_URL: primary.url, LLM_FALLBACK_API_KEY: "b", LLM_FALLBACK_BASE_URL: fallback.url, LLM_MAX_RETRIES: "1" }); const result = await explainFinding({ ...request, selector: "#fallback" }); assert.equal(result.status, "ok"); assert.equal(primary.calls, 2); assert.equal(fallback.calls, 1); } finally { save(old); await primary.close(); await fallback.close(); }
  const broken = await provider([{ status: 500, body: {} }]);
  try { clearLlmCache(); save({ LLM_API_KEY: "a", LLM_BASE_URL: broken.url, LLM_FALLBACK_API_KEY: "", LLM_MAX_RETRIES: "0" }); const result = await explainFinding({ ...request, selector: "#broken" }); assert.equal(result.status, "quota_exhausted"); assert.equal(result.summary, "Explanation unavailable"); } finally { save(old); await broken.close(); }
});
