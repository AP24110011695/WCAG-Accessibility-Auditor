# Rules — non-negotiable working standards

Imperative rules. "Must" = always. "Never" = never, including under time pressure.

## 1. First-read protocol

1. At the start of **every** session, read all six files, in this order: `prd.md` → `architecture.md` → `rules.md` (this file) → `design.md` → `tasks.md` → `memory.md`.
2. Then open `memory.md`'s "Next Up" and resume exactly there.
3. Do not start work from a stale memory of the files — re-read them; they are the source of truth and they change.
4. Before ending a session, update `memory.md` (protocol in that file). No exceptions.

## 2. Never guess

- If a requirement, API, library version, file or command is unclear: check the six files, then the codebase, then ask the team lead. Never invent.
- Never invent endpoints, package names, function signatures, config keys or DB fields. If something must exist but doesn't, create a task in `tasks.md` first.
- Before using any library, verify the **installed version** (`npm ls <pkg>`) and check the docs for that version. axe-core rule tags, Playwright video APIs and better-sqlite3 APIs all vary by version.
- If the codebase and `prd.md`/`architecture.md` disagree, stop, flag it as a Known Issue in `memory.md`, and resolve with the team lead before coding.
- Never write code against an API response shape you have not seen. Print/capture a real sample first.

## 3. Scope

- Work only the current task in `tasks.md`. No unrequested features, refactors, renames or dependency additions.
- A new dependency requires: a one-line justification in `memory.md` → Decisions Made, plus updating `.env.example`/`architecture.md` if it changes the stack. Zero-impact alternatives must be considered first.
- If you notice a bug outside the current task: log it in `memory.md` → Known Issues. Do not fix it mid-task unless it blocks the current task.
- Finish or explicitly park the task (with a note) before starting another. One `in_progress` task at a time.

## 4. Language & style conventions

- TypeScript strict mode everywhere; `noUncheckedIndexedAccess` on. No `any`; use `unknown` + narrowing.
- Files ≤ 300 lines; functions ≤ 50 lines; one responsibility per module. Split before you scroll.
- Naming: `camelCase` variables/functions, `PascalCase` types/components, `SCREAMING_SNAKE_CASE` constants, files in `kebab-case.ts` (server) / `PascalCase.tsx` (components).
- Named exports only; no default exports.
- Error handling: throw `Error` with a specific message for programming errors; return typed result objects (`{ok:false, error:{code,message}}`) for expected failures (fetch timeouts, blocked pages). Never swallow errors; never `catch {}`.
- No string-typed IDs concatenated ad hoc — use the ID helpers in `server/src/ids.ts` so formats stay consistent (`run-…`, `pg-…`, `TC1`…).
- Logging: structured single-line JSON to console: `{ts, level, run_id, stage, msg, ...data}`. Never log secrets. One log per stage transition and per error, not per row.
- Comments only for constraints the code cannot express (e.g. "axe ≥4.10 required for wcag22aa tags"). No narration comments, no "added for hackathon" remarks.
- No dead code, no commented-out blocks, no TODO without a task ID (`// TODO(P3-T2): …`).

## 5. Evidence rules (the core of the product)

- Every finding must carry: source URL, retrieval timestamp, selector, WCAG criterion, and at least one evidence file path — enforced by the schema; a finding missing any of these is a bug, not a shortcut.
- Every decision stores its inputs and a written reason. "Because axe said so" is insufficient — name the rule and the threshold.
- Never fabricate, estimate or embellish a result. If the evidence doesn't exist, the state is `uncertain`.
- Failures, errors and uncertain results are reported **as what they are** — in the DB, the UI, and the test-case records. Never render a failure as success, never delete inconvenient evidence, never edit an existing run's rows (runs are immutable).
- Screenshots/videos are saved to `evidence/` with checksums recorded in the DB. Renaming or moving artifacts outside the helper functions is forbidden — it breaks traceability.
- The word "pass" appears in the UI only when a check actually ran and passed. Un-run checks are "not checked", not "passing".

## 6. Safety rules (from the official brief)

- Human approval **before** any action that cannot easily be undone. All issue-log writes go through the approval gate (FR-09). `APPROVAL_MODE` stays `required`; never add a bypass.
- Mock or synthetic data whenever a workflow touches personal or sensitive information. Never audit a page containing real personal data; never commit credentials, tokens or `.env`.
- Never bypass OTP or CAPTCHA — not by code, not by asking a teammate for a code. When a flow requires them: show a safe manual step or a mock, and mark the finding `uncertain`.
- Respect crawl scope limits (FR-13): same-origin only, ≤5 pages, ≥2 s delay, robots.txt respected. Do not audit a site whose terms prohibit crawling.

## 7. Free-only rules

- Every library and service must be open source or on a verified free tier. No paid plans, no trials that convert to paid, no pay-as-you-go that requires a card on file. Prefer card-free services; if a card-required service is genuinely unavoidable, mark it "card required" in `architecture.md` §3 and justify it in `memory.md`.
- `architecture.md` §3 (Free-Tier Verification) is the registry. Before adding any new service: open its **official** pricing page, confirm the free tier exists today, and add a row with the date checked and the exact limits. Never rely on memory or blog posts for tier facts.
- Secrets never enter git — the repo is public (free Actions/Pages require it), so assume anything committed is world-readable. Secrets live only in GitHub Actions secrets and host environment variables; `.env` is gitignored; `.env.example` contains names only.
- Rotating a key: revoke the old key at the provider → create the new one → update the host secret store (GitHub/Supabase) → update the local `.env` → append a dated note to `memory.md`. Never "rotate" by editing committed files.
- LLM data rule: free tiers may use inputs for training (verified for Gemini's free tier, 2026-10-17). Send the LLM only synthetic demo-site content or already-public crawled pages — never personal or sensitive data, never raw user input.
- Model names and rate limits are never hardcoded. Provider, base URL, API key and model name come from env vars. On HTTP 429: exponential backoff with jitter, bounded retries, then the fallback provider, then degrade to "Explanation unavailable" — deterministic checks must never depend on the LLM. To replace a retired model: read the provider's current model list, set the env var, make one test call, update `memory.md` — no code changes.

## 8. Minimal code policy

Mandatory. "Required by a task" means required by a task in `tasks.md` or an FR/TC ID — nothing else.

1. Write the least code that satisfies the current task's acceptance criteria. Nothing more. If it is not required by a task or an FR/TC ID, do not write it.
2. No speculative features, "future-proofing", plugin systems, config options nobody asked for, or abstractions with a single use. Add an abstraction only when the same code would otherwise be written three times.
3. No dead code, commented-out code, unused imports, unused functions, unused files or placeholder stubs. Delete them in the same commit.
4. Prefer the standard library and the libraries already chosen over new dependencies. Every new dependency needs a one-line justification in `memory.md`. Do not write code a chosen library already provides (e.g. use axe-core's results instead of reimplementing rules).
5. No boilerplate padding: no comments that restate the code, no giant docstrings, no verbose logging everywhere, no try/catch that only re-throws, no defensive checks for impossible states. Comments explain WHY, never WHAT.
6. Small, flat, readable code: short functions, early returns, no deep nesting, no needless classes. Plain functions and data objects where a class adds nothing.
7. No duplicate logic: before writing a helper, search the codebase for an existing one.
8. Reuse over regenerate: when changing a file, edit the necessary lines only. Never rewrite a whole file to change a few lines.
9. UI: no component or CSS that is not used on a screen defined in `design.md`. No unused tokens.
10. Tests: write only tests that verify an acceptance criterion or TC1–TC4. No tests that only restate the implementation.
11. Size check before every commit: review the diff and remove anything not needed by the task. Record net lines added per task in `memory.md`. If a task grows far beyond what its acceptance criteria require, stop and simplify before continuing.
12. When in doubt, do less and ask. Explain a smaller solution instead of generating a larger one.

## 9. Testing rules

- Every task in `tasks.md` has a verification step. A task is not done until its verification ran and passed — "it should work" is not a result.
- The four official test cases are first-class tests: `tests/tc1.spec.ts` … `tests/tc4.spec.ts`, runnable via `npm run tc:all`, each producing a labelled run record with input/expected/actual/evidence (FR-12).
- Tests verify acceptance criteria or TC1–TC4 only (§8.10) — never the implementation itself.
- Deterministic checks (axe mapping, contrast math, heuristics, idempotency) get unit tests; the fixtures are the demo-site pages.
- Never weaken a test to make it pass. If the test is wrong, say why in `memory.md` → Decisions Made, then change it deliberately.
- Before committing, run: `npm run typecheck && npm run test`. Both must pass.

## 10. Git rules

- Small commits: one task (or one coherent sub-step) per commit; never mix UI, agent and schema changes.
- Conventional commits: `feat: …`, `fix: …`, `docs: …`, `chore: …`, `test: …`, `refactor: …`. Example: `feat(checks): keyboard trap detection with keystroke trace (FR-05)`.
- Reference the task/requirement ID in the commit body: `Implements FR-05, verified by TC1.`
- Never commit: `node_modules/`, `evidence/` artifacts (they are demo data, size-heavy), `server/data/*.db`, `.env`. Commit `.env.example` only.
- Do not force-push; do not rewrite history the team may have pulled. (Repo is local-first; push to the team remote after P0-T1.)

## 11. Definition of done (per task)

1. Code written to the conventions above; `typecheck` and `test` pass.
2. The task's verification step in `tasks.md` executed; actual result recorded.
3. New/changed behaviour reflected in the relevant docs (`architecture.md` for stack/schema, `design.md` for UI, `prd.md` only if scope changed — scope changes need the team lead).
4. `memory.md` updated: task ticked in `tasks.md`, Completed row added (with commit hash), Next Up advanced.
5. For UI tasks: keyboard-operable, focus-visible, axe-clean at 2.2 AA on the touched screens.
6. Diff contains no unnecessary code (Minimal Code Policy §8); net lines added recorded in `memory.md`.

## 12. Anti-patterns (never do these)

- **Fabricating evidence** — writing a "pass" or a screenshot that wasn't produced by a real run.
- Marking `uncertain` as `pass` (or silently dropping it) to make a report look clean.
- Logging issues without an approval record, or executing an action twice under retry.
- Inventing endpoints/packages/flags under deadline pressure instead of checking or asking.
- `any`, silent `catch`, giant files, "temporary" scripts that survive into submission.
- Editing an old run's rows instead of creating a new run.
- Colour as the only carrier of status meaning; emoji as icons; lorem-ipsum copy in the UI.
- Testing on real user data; touching OTP/CAPTCHA flows; crawling outside scope.
- Skipping the first-read protocol because "I remember the files".
- Leaving `memory.md` stale at session end — the next session inherits silence, not context.
- Speculative features, "future-proofing", single-use abstractions, or config options nobody asked for.
- Dead code, commented-out code, unused imports/dependencies/files, placeholder stubs.
- Rewriting a whole file to change a few lines; writing a helper that already exists.
- Hardcoding model names, rate limits, URLs or keys; trusting memory or blogs for free-tier facts instead of the official page.
- Sending personal or sensitive data to a free-tier LLM (inputs may train their models).
- Letting a paid or card-required service sneak into the stack unverified and unrecorded.
- Relying on local disk for anything that must survive a restart (CI and free hosts have ephemeral storage).
