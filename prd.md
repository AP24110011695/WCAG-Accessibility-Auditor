# PRD — WCAG Accessibility Auditor (Team Sunflower, Agentic AI Hackathon 2026)

> Status: source of truth. If code and this file disagree, this file wins — file a Known Issue in `memory.md`.
> Companion files: `architecture.md` (how), `rules.md` (standards), `design.md` (UI system), `tasks.md` (plan), `memory.md` (progress).

## 1. Product summary

We are building **Sunflower Audit**, a deployed, web-based AI agent that audits website pages for accessibility issues and produces an **evidence-backed issue list**. A user submits page URLs and a target conformance level (e.g. WCAG 2.2 AA); the agent combines deterministic automated checks (axe-core) with scripted keyboard testing, pixel-sampled contrast measurement on real backgrounds, and manual-style heuristics; every decision it makes is stored with its inputs, the source page snapshot, the retrieval timestamp and a written reason; anything it cannot prove is reported as **uncertain**, never guessed. Before anything is logged, a human sees exactly what will be written where and approves it — and retries can never log the same issue twice. After a fix is deployed, the agent retests the same page and closes an issue **only if it now passes**.

**The problem it solves:** accessibility audits today are either (a) scanner output — long axe/Lighthouse dumps with no judgement, no keyboard evidence and false confidence, or (b) expensive manual audits with no traceability. Our agent does what a careful human auditor does — automated sweep, keyboard walk, judgement, uncertainty, sign-off — and records *why* every conclusion was reached, so every issue is checkable and every retest is honest. This is the assigned problem in the official catalogue: "Website pages are audited for accessibility issues, with evidence."

## 2. Target users

| User | Need | Where they touch the product |
|---|---|---|
| Primary: web developer / site owner | A trustworthy list of real accessibility failures with proof, prioritised, re-checkable after fixes | New Audit form → Issue list → Issue detail → Retest |
| Hackathon judge / organizer | Verifiable evidence that the agent actually reasons and does not fabricate | Test-case run cards (TC1–TC4), decision trails, evidence files |
| Secondary: QA / accessibility tester | Keyboard-trap recordings and contrast measurements they would otherwise do by hand | Evidence viewer, keyboard trace, annotated screenshots |

## 3. Primary user flow (end to end)

1. **Collect (FR-01):** user opens New Audit, enters one or more page URLs and picks target level (default WCAG 2.2 AA). Each page is assigned a stable input ID. Validation (well-formed URL, reachable, level in allowed set, crawl-scope limits) runs *before* the agent starts; invalid input blocks the run with explicit errors.
2. **Plan (FR-02):** the agent produces a per-page check plan — automated suite, keyboard walk, contrast targets, manual heuristics — stored with a plan ID and shown in the UI.
3. **Find (FR-03–FR-07):** the agent retrieves each page (static fetch + Cheerio, Playwright render when needed) and stores source URL, retrieval timestamp, HTTP status and DOM snapshot. It then runs: axe-core, the keyboard engine (Tab/Shift+Tab/Enter/Esc walk, activeElement trace, focus-trap detection, focus-visibility check), the contrast sampler (pixels from the actual background), and manual heuristics (e.g. generic link text).
4. **Decide (FR-08):** each candidate finding becomes a decision with state `fail`, `pass` or `uncertain`, with a stored reason. Missing evidence, axe "needs review" results, or low-confidence classification → `uncertain`.
5. **Approve (FR-09):** the agent proposes issue-log entries. The UI shows the exact destination and full proposed content. Nothing is written until a human clicks Approve. The approved payload and the approval record are stored; an idempotency key makes retries safe.
6. **Log (FR-09):** approved issues are written to the issue log (with screenshots and all evidence links).
7. **Retest (FR-10):** after the site is fixed and redeployed, the user runs a retest of the same page/checks. An issue closes **only** when the retest passes and the close is approved; failing or pending issues stay visible.
8. **Review (FR-11):** the issue list shows every issue with its screenshot, state (fail / uncertain / pass / closed), WCAG criterion, and full traceability chain run → page input → source → decision → evidence. TC1–TC4 are available as labelled runs (FR-12).

## 4. Functional requirements (mapped to the 4 agent stages)

| ID | Stage | Requirement |
|---|---|---|
| FR-01 | 1. Collect | New Audit form: one or more page URLs + target level (allowed set: WCAG 2.1 A, 2.1 AA, 2.2 A, 2.2 AA; default 2.2 AA). Each page gets a stable input ID (`pg-<runId>-<nn>`). Input validated before the agent runs; invalid input blocks the run and lists every error. |
| FR-02 | 2. Plan | Agent emits a per-page check plan (plan ID, ordered list of checks: axe suite, keyboard walk, contrast targets, manual heuristics, retest hook). Plan is persisted and displayed before execution. |
| FR-03 | 3. Find | Retrieval: fetch each page (HTTP + Cheerio for static; Playwright render when the page needs JS). For every page store: source URL, retrieval timestamp, HTTP status, fetch method, content hash, DOM snapshot path. Every extracted finding references its source record. |
| FR-04 | 3. Find | Automated checks: axe-core run with ruleset matching the target level. Results recorded per rule with selector, help text and impact. axe `incomplete`/`needs review` results map to state `uncertain` (FR-08). |
| FR-05 | 3. Find | Keyboard engine: scripted Tab / Shift+Tab / Enter / Escape walk with activeElement trace; **focus-trap detection** (TC1) with video recording; **focus-visibility check** (computed-style comparison at rest vs focused). Stores keystroke trace + video + screenshots. |
| FR-06 | 3. Find | Contrast sampler: element screenshot; text pixel colour extracted from glyphs; background pixel colour sampled from a text-hidden screenshot of the same region; WCAG ratio computed against the **actual sampled background** (TC3); thresholds 4.5:1 (normal text) / 3:1 (large text). Evidence: annotated screenshot + raw pixel samples. |
| FR-07 | 3. Find | Manual heuristics that scanners pass: generic link text list ("click here", "read more", …) → WCAG 2.4.4 flag; custom control with no visible focus indicator → WCAG 2.4.7 flag (TC2). |
| FR-08 | 3. Find | Decision layer: each finding gets a decision record (inputs, rule applied, reason, outcome ∈ {fail, pass, uncertain}, whether an LLM assisted and with what model). `uncertain` is produced when required evidence is missing, axe says "needs review", or LLM confidence < 0.8. |
| FR-09 | 4. Act | Approval gate + issue logging: proposed payload (destination + exact content) rendered for approval; Approve/Reject recorded with approver and timestamp; approved version stored; **idempotency key** (`sha256(runId + findingIds + actionType + payloadHash)`) prevents duplicate execution on retries. |
| FR-10 | Verify | Retest loop: re-executes the same check with the same parameters on the redeployed page; issue closes only if retest passes **and** the close is approved; still-failing issues keep their old evidence and gain new evidence; pending/uncertain stay visible (TC4). |
| FR-11 | Verify | Result view: issue list with screenshots; every issue traceable run → page input → source → decision → evidence; unresolved and uncertain items always visible. |
| FR-12 | Verify | TC1–TC4 as labelled runs, each preserving input, expected result, actual result, evidence, and an honest explanation of any difference (see §7). |
| FR-13 | 1–3 | Safe real-site auditing: same-origin scope only, max pages per run (default 5), politeness delay between fetches (default 2 s), robots.txt respected, no login/OTP/CAPTCHA — pages requiring those are skipped and marked `uncertain` with a manual-step suggestion. |
| FR-14 | All | Evidence retention: all artifacts (screenshots, videos, traces, snapshots) in the Supabase Storage `evidence` bucket with checksums recorded in the DB; runs are immutable once created. |

## 5. Non-functional requirements

| NFR | Requirement |
|---|---|
| NFR-1 Traceability | Every finding links: source URL + retrieval timestamp, selector, WCAG criterion, decision reason, evidence file paths. No orphan results. |
| NFR-2 Determinism where possible | Deterministic checks (axe, keyboard walker, contrast math, heuristics) must produce identical decisions for identical page state; LLM is used only for language tasks and classification assist, always with a confidence gate and `uncertain` fallback. |
| NFR-3 No duplicate execution | Any retried action resolves to the already-executed result; idempotency keys enforced at the DB level. |
| NFR-4 Honesty | Failures, errors and uncertain results are surfaced as such in the UI and in test-case runs; never rendered as success. |
| NFR-5 Evidence retention | Run artifacts immutable; retained through submission and organizer validation. |
| NFR-6 Our UI passes our own audit | The Sunflower Audit UI itself must reach 0 axe violations at WCAG 2.2 AA and full keyboard operability (dogfooding — demonstrable to judges). |
| NFR-7 Performance | A 5-page audit completes in under 5 minutes of execution time (after the worker starts; CI queue/dispatch latency is excluded from the budget); keyboard-video checks excluded from this budget. |
| NFR-8 Safety | Human approval for any hard-to-undo action; synthetic data only; no CAPTCHA/OTP bypass (see `rules.md` §Safety). |
| NFR-9 Zero cost | Every service and library is free: verified free tiers only (registry in `architecture.md` §3, checked 2026-10-17), open-source libraries, and **no credit card required anywhere in the stack**. If a card-required service is ever unavoidable, it must be marked "card required" in the registry and justified in `memory.md`. |
| NFR-10 Free-tier resilience | The agent survives free-tier realities: LLM quota exhaustion degrades to "Explanation unavailable" while deterministic checks (axe, keyboard, contrast) still run; nothing durable is stored on ephemeral disk (DB + evidence live in Supabase); no component sleeps (Pages, Edge Functions and CI runners are always addressable; Supabase pauses only after 1 week of inactivity — restored manually); the CI dispatch wait is shown as a normal Queued state, never an error. |

## 6. Rubric mapping (100 points)

| Rubric category | Points | Features that earn them |
|---|---|---|
| Agentic capability | 25 | The 4-stage loop itself: validated collection (FR-01), persisted plan (FR-02), autonomous multi-tool retrieval & checking (FR-03–07), decision layer with `uncertain` states (FR-08), approval-gated action (FR-09). Shown live as the run timeline. |
| Problem fit & usefulness | 20 | Evidence-backed issue list a developer can act on (FR-11), retest loop that closes issues honestly (FR-10), safe real-site mode (FR-13). |
| Technical implementation | 20 | Deterministic keyboard walker with trap detection (FR-05), pixel-sampling contrast on real backgrounds (FR-06), axe + heuristics pipeline (FR-04, FR-07), immutable evidence chain with SHA-256 checksums (FR-14). |
| Innovation | 15 | Contrast measured on the *actual* photographed background (FR-06); keyboard-trap judgement from a recorded keystroke trace (FR-05); auditable decisions with honest `uncertain` states (FR-08); idempotent human-in-the-loop action log (FR-09). |
| User experience | 10 | Editorial results UI (`design.md`): issue table, annotated evidence viewer, approval panel, status chips readable without colour. |
| Presentation | 10 | Submission pack: labelled TC1–TC4 runs with evidence bundle, README, deck; AI-scored written evidence is written from `memory.md` + test-case records, not from memory. |

## 7. Test case mapping (official TC1–TC4)

| TC | Scenario (official) | Fixture (our demo site) | Expected result (official) | Our feature + evidence artifact |
|---|---|---|---|---|
| TC1 | Modal traps keyboard focus | Demo site `/modal`: modal whose script forces focus to cycle inside it; background page has focusable elements | Issue logged **with recording** | Implements FR-05; run page → keyboard walk → trap detected after 3 full Tab cycles inside modal + Escape ignored. Evidence: video of the walk, keystroke trace (activeElement per key), screenshots. Finding: WCAG 2.1.2 No Keyboard Trap. |
| TC2 | Automated tool passes but manual check fails | Demo site `/links`: otherwise axe-clean page containing "click here" links and a custom button with `outline:none` and no replacement focus indicator | Still logged **as failure** | Implements FR-07 + FR-08; stored axe report shows **0 violations** *alongside* ≥1 logged failure (2.4.4 generic link text; 2.4.7 invisible focus). Evidence: axe JSON, decision record, screenshots. |
| TC3 | Grey text on a photo background | Demo site `/photo-hero`: light-grey paragraph over a photograph | Contrast measured **on the actual background** | Implements FR-06; sampler hides text, samples the photographed pixels behind the text box, extracts glyph colour, computes ratio vs sampled background (min & mean), compares to 4.5:1. Sampling strictly standardized at 1280x720 viewport and DSF 1.0. Evidence: dual screenshots (text visible and background only), raw pixel samples, computed ratio, and metadata. |
| TC4 | Fix deployed | Demo site `/form`: input missing a programmatic label. Fix = redeploy of the same URL with the label added | Same page retested; issue closed **only if passing** | Implements FR-10 + FR-09; retest re-runs the identical check on the redeployed `/form`; issue transitions to closed only after passing retest + approved close. Evidence: before/after DOM snapshots + screenshots, retest record, approval record. Negative check: a second retest against a *still-broken* page is also recorded showing the issue stays open. |

## 8. Out of scope (deliberately not building)

- Fixing the audited site's code automatically — the agent logs issues; it does not patch sites.
- Full WCAG conformance certification or auditor/consultant sign-off workflow.
- Auditing behind authentication (no login automation of any kind).
- PDF, native mobile, or video/caption accessibility.
- Bulk crawling (hundreds of pages) or scheduled recurring scans.
- Writing to third-party trackers (Jira/GitHub) — the issue log is ours; CSV export is stretch.
- Team accounts, multi-user roles, SSO.
- Bypassing CAPTCHA/OTP in any form — required flows are mocked or skipped as `uncertain`.

## 9. Success criteria

1. Deployed agent is reachable at a public URL and completes an audit end to end (collect → plan → find → approve → log).
2. All four official test cases pass as labelled runs with preserved input / expected / actual / evidence, TC1's issue carries a video recording, and `computeMatchesExpected` deterministically asserts expected match.
3. Every logged issue is traceable to its input record and source snapshot with timestamps, reading and writing from a single unified `output/` directory.
4. At least one `uncertain` state is demonstrated live and explained (this is a feature, not a gap).
5. TC4 demonstrates a real redeploy, a passing retest closing an issue, and a failing retest keeping one open.
6. Our own UI passes its own audit (0 axe violations, keyboard-complete) — shown on the demo.
7. Automated test suite contains 19 passing tests covering deterministic rules, false-positive controls, decision gating, retest loops, and `computeMatchesExpected`.
8. Submission pack complete before the deadline: deployed link, source, presentation, test-case evidence.

## 10. Open Questions / Assumptions

Scheduling, deadlines, build-window timing and team logistics are **decided by the team lead and are not constraints** — recorded as assumptions in `memory.md` (A1, A2, A5) and not raised again. Remaining unknowns live there as assumptions, not questions.

| # | Question | Status |
|---|---|---|
| Q3 | Which LLM provider/key do we have? | **Answered 2026-10-17 (zero-cost):** Groq primary, Gemini (AI Studio key) fallback — both verified free tiers (`architecture.md` §3); GitHub Models evaluated and rejected (retired 30 Jul 2026). Provider/base URL/model name come from env vars only; response caching + backoff + graceful degradation ("Explanation unavailable") are built in. Keys still to be created at setup (P0-T2). |
| Q4 | Where do we host the deployed agent and the demo site? | **Answered 2026-10-17 (zero-cost, verified):** audit worker on GitHub Actions (public repo), dashboard + demo site on GitHub Pages, DB/evidence/trigger on Supabase free tier (an Edge Function holds the PAT and dispatches the worker) — three services, full rationale in `architecture.md` §3 and §11. |
