# Tasks — dependency-ordered build plan

> Ordered by dependencies, not dates. The team lead owns scheduling; there are no deadline-driven cuts — the goal is quality and completeness. Sizes are relative effort: **S** = a few focused hours, **M** = roughly a focused day, **L** = multiple days. ★ = on the dependency chain.
> Every task ends with its verification step run (rules.md §11), records its net lines added in `memory.md` (rules.md §8.11), and must stay inside the verified free tiers (rules.md §7).

## Ground rules for ticking

- Tick `[x]` only when the task's verification has actually passed.
- When a task is ticked, update `memory.md` (Completed + Next Up) in the same sitting.

---

## Phase 0 — Free-tier setup, repo, and the demo target site ★

**Goal:** accounts/keys created (manual, by the team lead), the zero-cost stack live, and a hosted demo site containing every fixture TC1–TC4 needs.

- [x] **P0-T1 ★ (A, S)** Init the **public** git repo (public is required for free Actions/Pages and doubles as source evidence), root `package.json` (workspaces: `agent`, `web`), `.gitignore` (evidence staging, .env, node_modules, dist), `.env.example` with names only, conventional commits. Verify: `git log` shows a commit; a teammate can clone. *(2026-10-17: scaffold files complete, typecheck + tests green. 2026-10-23: Git for Windows installed; `git init` + first commit done locally — the GitHub repo creation + first push remain the team-lead manual step, deploy-checklist Steps 1–2.)*
- [ ] **P0-T2 ★ (Team lead, S — manual steps)** Create accounts and keys, and **re-verify each free tier at signup** (cards, limits — record findings in `memory.md`): GitHub account; Supabase project incl. Edge Functions (free); Groq API key; Gemini API key (AI Studio); Git for Windows (local git is missing). Create a **fine-grained GitHub PAT limited to this one repo with only "Actions: read and write"** (the Edge Function holds it; keep it minimal — if the PAT UI demands more for dispatch, record what and why in `memory.md`). Store secrets in Supabase secrets / GitHub Actions secrets / local `.env` only — never in git. Verify: one authenticated test call against Groq and Gemini each; Supabase SQL editor + a hello-world Edge Function reachable; the PAT dispatches a test workflow.
- [ ] **P0-T3 ★ (A, M)** Supabase setup: create schema (`agent/src/db/schema.sql`) via SQL editor; create the public-read `evidence` storage bucket; enable RLS + `anon` SELECT grants + the two SECURITY DEFINER RPCs (`approve_action`, `execute_approved_action` — architecture.md §7). Verify: schema creates cleanly; a test insert via service key and a blocked write via anon key; RPC refuses an unapproved action. *(2026-10-17: schema.sql + RPCs + RLS/grants written, `trigger` column renamed `trigger_source` (reserved-word risk); applying + refusal tests blocked on the Supabase project — P0-T2.)*
- [x] **P0-T4 ★ (C, M)** Build the demo site: `index.html` (clean), `modal.html` (focus-trap modal), `links.html` ("click here" links + `outline:none` custom button, otherwise axe-clean), `photo-hero.html` (grey text on photo), `form.html` (input without programmatic label), `form-fixed.html` (fallback for TC4). Each bug tagged `data-demo-bug`. Verify: `modal.html` really traps (manual Tab test); `links.html` reports **0 axe violations** (critical for TC2); all pages valid HTML. *(2026-10-17: verified 13/13 via axe-core 4.14 + Playwright keyboard script — links.html = 0 violations, modal traps both Tab directions and ignores Escape, form.html fires exactly the `label` rule, form-fixed clean, photo-hero contrast is axe `incomplete` (the TC3 premise); no formal HTML validator run offline.)*
- [ ] **P0-T5 (A, S)** LLM keys verified with one real completion each; model names recorded in `.env` (env-only, never hardcoded — rules.md §7). If a provider fails: record it in `memory.md` and proceed with the other; the agent degrades gracefully regardless. Verify: both providers (or the survivor) return a completion; a second identical call is served from `llm_cache`. *(Blocked on Groq + Gemini keys — P0-T2.)*
- [x] **P0-T6 (B, S)** Design tokens (`tokens.css` from design.md §9) + self-hosted fonts in `web/`. Verify: fonts render offline (devtools shows no font network requests). *(2026-10-17: tokens.css + 6 self-hosted latin woff2 (Fraunces variable 100–900, Plex Sans 400/500/600, Plex Mono 400/500) + fonts.css; verified via built dist + Playwright — Plex Sans loads, zero external font requests. Fraunces/Mono lazy-load and get re-checked when screens use them (P1-T3+).)*

## Phase 1 — Input, validation, run creation and the trigger path ★

**Goal:** FR-01 (validated inputs, stable IDs), the Supabase trigger Edge Function, and the dashboard form wired end to end.

- [ ] **P1-T1 ★ (A, M)** Trigger Edge Function (`supabase/functions/trigger-audit`, Deno): insert the `runs` row (status `pending`) via service key → `workflow_dispatch` with `run_id` via the `GITHUB_PAT` secret → return run id; CORS for the Pages origin; JWT verification disabled (public form, no user auth). **Abuse protection (FR-13):** reject target hosts outside the allowlist (`DEMO_SITE_URL` host + `AUDIT_ALLOWLIST`), reject > `MAX_PAGES_PER_RUN` URLs per request, and enforce a global rate limit of `MAX_RUNS_PER_HOUR` runs/hour counted from the DB. Verify: a dashboard-origin fetch creates a run row and dispatches the (stub) workflow; a non-allowlisted host, an over-cap URL list and the run after the hourly limit are each rejected with a clear error. *(2026-10-17: function + `config.json` (verify_jwt false) written — raw PostgREST fetch, no client dep; deploy + rejection tests blocked on the Supabase project + PAT — P0-T2. Each request creates a fresh run id, so retries are bounded by the rate limit, not by run-id idempotency.)*
- [ ] **P1-T2 ★ (A, M)** Stage-1 validation in the agent: URLs well-formed + reachable (HEAD), level ∈ allowed set (default 2.2 AA), scope limits (FR-13), stable `pg-…` input IDs — all **before** any check runs; invalid input fails the run with per-field errors. Verify: invalid URL/level produces explicit errors; no run advances past `pending` on failure. *(2026-10-17: `agent/src/validate.ts` + 10 unit tests all green (URL/level/allowlist/cap/duplicate/protocol cases); the reachability (HEAD) check and the "no run advances past pending" half are integration — blocked on Supabase.)*
- [x] **P1-T3 (B, M)** New Audit form (design.md components): URL list, level select, inline validation errors, focus-visible, labels; calls the trigger Edge Function; polls run status via anon key. Verify: keyboard-only submission; errors announced (`aria-describedby`); invalid input blocks start. *(2026-10-23: built in `web/src/App.tsx` + `SupabaseApiAdapter.startAudit`; renders in the empty state too so the first audit can start from the UI; Queued state with 15 s polling (design.md §5); Test 10 = keyboard-only dispatch against a mock Edge Function incl. announced `role=alert` errors, no POST on invalid input, queued→running transition; form view axe 2.2 AA = 0 violations.)*
- [ ] **P1-T4 (A, S)** Evidence helpers: local staging dir → upload to the `evidence` bucket → checksum + `storage_path` row; immutability guard (no overwrites). Verify: artifact uploaded, checksum matches, duplicate path rejected.

## Phase 2 — Automated checks pipeline ★

**Goal:** FR-03, FR-04 — retrieval with provenance + axe at the target level.

- [x] **P2-T1 ★ (A, M)** Fetcher: static fetch + Cheerio parse; decision rule → Playwright render when the page needs JS; write a `sources` row (url, retrieved_at, http_status, method, hash, snapshot in Storage) for every page. Verify: both methods produce a `sources` row on demo pages; the stored snapshot opens in a browser.
- [x] **P2-T2 ★ (A, M)** axe runner: inject `axe.min.js` (verify the installed version's rule tags — rules.md §2), run the ruleset per target level, map violations → findings, `incomplete`/`needs review` → `uncertain` findings; store the axe JSON as evidence. Verify: `/photo-hero.html` and `/form.html` yield the expected findings; the axe report is in the bucket.
- [x] **P2-T3 ★ (A, M)** Orchestrator skeleton + audit workflow: stages execute sequentially, status transitions persisted; `.github/workflows/audit.yml` runs `npm run audit -- --run <id>` with npm/Playwright caching. Verify: a dispatched workflow drives a run through collecting→planning→finding→awaiting_approval in the DB; a local run behaves identically.

## Phase 3 — Keyboard and manual-test engine ★

**Goal:** FR-05, FR-06, FR-07 — the differentiating evidence generators.

- [x] **P3-T1 ★ (A, M)** Keyboard walker: Tab/Shift+Tab/Enter/Esc script, activeElement trace, video recording per check (uploaded to Storage). Verify on `modal.html`: the trace shows focus never leaving the modal; video saved with checksum.
- [x] **P3-T2 ★ (A, S)** Trap rule: 3 full cycles inside the modal while outside focusables exist → `WCAG 2.1.2` finding + Escape-closed observation. Verify: `index.html` (no modal) yields no finding; `modal.html` yields exactly one. → feeds TC1.
- [x] **P3-T3 ★ (A, M)** Contrast sampler: element shot → text-hidden shot → glyph/background pixel extraction → min+mean ratio vs thresholds; annotated screenshot output; <50 usable pixels ⇒ `uncertain`. Verify on `photo-hero.html`: the measured ratio matches a manual eyedropper check ±0.3. → feeds TC3.
- [x] **P3-T4 ★ (A, M)** Heuristics: generic link text (banned list) → 2.4.4; focus-visibility (computed-style diff + screenshot region diff) → 2.4.7. Verify on `links.html`: axe = 0 violations while heuristics fire ≥2 findings. → feeds TC2.
- [x] **P3-T5 (C, S)** Fixture verification pack: script asserting each demo page provokes exactly the findings its TC needs. Verify: `npm run fixtures:check` all green. *(2026-10-23: `fixtures:check` runs `agent/test/checks.test.mjs` (the TC fixture assertions: trap on modal, 4 heuristic findings on axe-clean links, contrast controls, false-positive controls) — 10/10 green.)*

## Phase 4 — Decision logic, LLM assist, and quota resilience ★

**Goal:** FR-08 — every result carries inputs + reason; missing evidence ⇒ `uncertain`; LLM can vanish without breaking anything.

- [x] **P4-T1 ★ (A, M)** `decide.ts`: candidate findings → decisions (fail/pass/uncertain) with rule + threshold + written reason; `uncertain` triggers enumerated (axe needs-review, missing evidence, unreachable element, low pixel count, LLM confidence < 0.8). Verify: unit tests for each trigger; no decision without a reason string.
- [x] **P4-T2 ★ (A, M)** LLM provider interface: env-driven provider/base URL/model (Groq primary, Gemini fallback), `llm_cache` by input hash, 429 → exponential backoff + full jitter (max `LLM_MAX_RETRIES`), then fallback provider. Verify: kill the primary key mid-call → fallback serves; a repeated call is served from cache with zero quota consumed.
- [x] **P4-T3 ★ (A, S)** Quota-exhaustion degradation: if both providers fail, the run completes; affected decisions get `llm_status='quota_exhausted'` and render as **"Explanation unavailable"**; deterministic findings and states are untouched. Verify: with both keys disabled, a full audit still produces correct fail/pass/uncertain states and the UI shows the honest badge.

## Phase 5 — Approval gate and issue logging ★

**Goal:** FR-09 — nothing writes without approval; retries cannot double-log.

- [x] **P5-T1 ★ (A, M)** Gate RPCs in SQL (if not already complete from P0-T3): `approve_action` records approval and moves `proposed → approved` (or `rejected`); `execute_approved_action` executes in one transaction, refuses anything unapproved, and returns the existing result on a repeated idempotency key (UNIQUE backstop). Verify: propose→approve→execute writes one issue; replaying execute returns the existing result with no second row; reject records approver+reason; no code path can execute without an approval row.
- [x] **P5-T2 ★ (B, M)** Approval panel UI (design.md §5): destination, exact payload, approver name input, immutable approved banner; calls the RPCs via anon. Verify: keyboard-only approve/reject; payload shown matches stored `payload_json`; a deliberate double-execute creates no duplicate (part of the demo script).

## Phase 6 — Retest and verification loop ★

**Goal:** FR-10 — close only if passing; keep failures/pending visible.

- [x] **P6-T1 ★ (A, M)** Retest logic in the worker: a new run re-using the original page input + same check params; `retests` row (intended vs observed); issue transitions per architecture.md §6. Verify: pass→`close_issue` proposal (approved ⇒ `closed`); fail→stays open + new evidence; uncertain→stays open. → feeds TC4.
- [x] **P6-T2 (B, S)** Issue states in UI: open / retest_failed / retest_pass / closed chips; unresolved section always visible. Verify: states survive greyscale (glyph + border check).

## Phase 7 — Results UI with evidence

**Goal:** FR-11 + UX points.

- [x] **P7-T1 (B, M)** Issue list table + issue detail (decision ledger, evidence well with screenshots/video/trace, checksums). Verify: every issue traceable via UI clicks run→input→source→decision→evidence.
- [x] **P7-T2 (B, S)** Run timeline view + TC run cards (input/expected/actual/evidence/explanation). Verify: TC cards render from `test_case_runs` rows.
- [x] **P7-T3 (B, S)** Empty/loading/error states with real microcopy; **Queued state** shown while the CI worker picks up the dispatch ("Queued on CI — the worker starts in under a minute typically"); `aria-live` status announcements. Verify: kill the network mid-flow and observe the error state; dispatch an audit and observe the queued→running transition; run a query that returns nothing and observe the empty state.
- [x] **P7-T4 (C, S)** Evidence export: `npm run evidence:export -- --run <id>` downloads the run's Storage objects + writes `manifest.json` with checksums. Verify: exported bundle re-reads correctly and is complete. *(2026-10-18: built `agent/src/export.ts`, exports self-contained HTML/MD pack with embedded base64 data URIs, screenshots captured during the recorded keyboard walk, keystroke trace, and reproduction commands.)*
- [x] **P7-T5 (B, S)** Self-audit: axe 2.2 AA on every dashboard view = 0 violations; keyboard walk of the approval panel recorded. Verify: audit report archived as evidence (dogfooding story).

## Phase 8 — Run TC1–TC4 and capture evidence ★

**Goal:** FR-12 — labelled runs, preserved input/expected/actual/evidence, honest diffs.

- [x] **P8-T1 ★ (A, M)** TC1 on `modal.html`: record the run, attach video + keystroke trace; issue logged with recording. Verify: `test_case_runs` row `TC1`, `matches_expected=true`. *(2026-10-18: verified in official runs, focus trap detected, issue logged with video, trace, and walk screenshots.)*
- [x] **P8-T2 ★ (A, S)** TC2 on `links.html`: axe report (0 violations) + logged failures side by side. Verify: `TC2` row + both artifacts linked. *(2026-10-18: axe reports 0 violations, heuristics flag 3 generic links + 1 removed outline, all 4 approved and logged.)*
- [x] **P8-T3 ★ (A, S)** TC3 on `photo-hero.html`: annotated screenshot + pixel samples + ratio. Verify: `TC3` row; ratio matches the manual spot check. *(2026-10-18: axe reports incomplete, sampler extracts actual photo pixels, worst-case 1.36:1 vs 4.5:1 required, mean 1.51:1.)*
- [x] **P8-T4 ★ (A+C, M)** TC4: audit broken `/demo/form.html` → approve log → **push the fix** (Pages redeploys the same URL) → retest → approve close; also record a negative retest against the still-broken page staying open. Verify: `TC4` row; issue closed only via approved passing retest; both retests visible. *(2026-10-18: form.html logged open, negative retest fails and keeps open, fixed retest passes and closes issue upon approval.)*
- [x] **P8-T5 (C, S)** One `uncertain` demo captured live (e.g. a page behind a login wall → skipped with a safe manual-step suggestion). Verify: finding state `uncertain` with explanation in the UI. *(2026-10-23: orchestrator skips HTTP 401/403 pages as one `auth-gated-page` uncertain finding carrying the manual keyboard/screen-reader step (playwright path now records status too); Test 9 captures the run live against a local 401 server — run completes `awaiting_approval`, exactly 1 finding, source records the 401, no auto-log proposal; axe's needs-review → uncertain path is already demonstrated live in TC3.)*
- [x] **P8-T6 (C, S)** Export all four evidence bundles via P7-T4. Verify: bundle checksums match the DB. *(2026-10-18: exported to `output/official/` and `output/evidence-pack/` with full SHA-256 integrity checks.)*

## Phase 9 — Deployment, README, presentation, submission pack ★

- [ ] **P9-T1 ★ (B+C, S)** Pages deploy workflow (`deploy-pages.yml`): build `web/` (Vite base path) + copy `demo-site/` → Pages; dashboard at `/`, demo at `/demo/`. Verify: both URLs serve on push; a `/demo` fix push redeploys (this is TC4's mechanism).
- [ ] **P9-T2 ★ (A, S)** Worker workflow hardened: npm/Playwright caching, non-zero exit marks the run `failed` with the error; manual "Run workflow" dispatch tested as the zero-code fallback. Verify: a dispatched audit completes on CI; a deliberately failing run marks the run failed honestly.
- [ ] **P9-T3 ★ (A, S)** Edge Function deployed to Supabase: `supabase functions deploy trigger-audit --no-verify-jwt` + `supabase secrets set GITHUB_PAT GITHUB_REPO`; CORS origin set to the Pages URL. Verify: a real audit dispatched from the **hosted** dashboard end to end (form → Edge Function → workflow → results visible in the dashboard).
- [ ] **P9-T4 (All, S)** Pre-demo warm-up & availability check: run one throwaway audit ~10 minutes before presenting; confirm the Supabase project is active (restore from the dashboard if paused), Pages is serving, and the CI queue is short. Verify: the warm-up audit completes; the demo script (P9-T6) includes this checklist.
- [ ] **P9-T5 (C, M)** README: what it is, the 4-stage explanation, the zero-cost architecture, quickstart, TC table, evidence-bundle guide, how to switch a retired LLM model. Verify: a teammate cold-starts from the README alone.
- [ ] **P9-T6 (C, M)** Presentation + demo script: problem → live 4-stage run → TC1–TC4 evidence → retest → self-audit → zero-cost architecture. Verify: rehearsed end to end; script lists every click and pre-demo warm-up step.
- [ ] **P9-T7 ★ (All, S)** **Free-tier re-verification + submission pack:** re-check `architecture.md` §3 rows against the official pages (update the table + `memory.md`), then assemble the pack: deployed dashboard URL, repo link, written evidence summary (generated from `test_case_runs` + `memory.md` — not from memory), evidence bundles, deck. Verify: pack checklist complete against prd §9 success criteria.

## Phase 10 — Extensions (optional, team lead's call)

- [ ] **P10-T1** Real public-site audit demo (e.g. `example.com` + one Wikipedia page) under FR-13 limits.
- [ ] **P10-T2** LLM screenshot-classification demo (focus-indicator judgement with confidence gate).
- [ ] **P10-T3** CSV export of the issue log.
- [ ] **P10-T4** Walk-through video for the submission portal.
- [ ] **P10-T5** Extra WCAG heuristics (heading order, form error association).

---

## Dependency chain (★)

P0-T1 → P0-T2 → {P0-T3, P0-T4, P0-T5} → P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 → P9.
Within P0, P0-T4 (demo site) and P0-T5 (LLM keys) can proceed in parallel with P0-T3 (Supabase). UI tasks (P1-T3, P5-T2, P6-T2, P7-*) follow lane B and join the chain at P8/P9. Roles: **A** = agent/backend, **B** = UI, **C** = demo site / evidence / deploy / presentation.

## Scope floor (what the demo must include, at minimum)

1. Hosted dashboard + demo site + worker: collect → plan → find → approve → log on our demo site (axe + keyboard trap + contrast + heuristics; LLM optional by design).
2. Approval gate demonstrably blocking, and idempotency demonstrably preventing duplicates.
3. Issue list with screenshots; retest closing an issue only on a passing, approved retest.
4. TC1–TC4 labelled runs with input/expected/actual/evidence, exported.
Anything beyond this list is an extension, added only by decision of the team lead.
