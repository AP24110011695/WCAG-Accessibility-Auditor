# Sunflower Accessibility Auditor — Deployment Checklist

This runbook provides the step-by-step procedure to deploy the Sunflower WCAG 2.2 AA Accessibility Auditor to GitHub and Supabase. Every service in this stack operates on verified, card-free free tiers.

> **Privacy & Public Bucket Notice:** The Supabase `evidence` storage bucket is public-read so the dashboard can load artifacts without authentication keys. Only synthetic benchmark fixtures or public websites should be audited. Never point the auditor at private internal endpoints.

---

## Step 1: Install Git (Local Machine)
If Git is not installed on your machine:
- **Windows:** Run `winget install --id Git.Git -e --source winget` or download from [git-scm.com](https://git-scm.com/download/win).
- **Verify:** Run `git --version` in terminal.
- **Expected result:** Output displays `git version 2.x.x`.

---

## Step 2: Initialize Git Repository & Push Code
Push the codebase to a new public GitHub repository.

1. Create a new public repository on GitHub (e.g. `sunflower-audit`) without adding README, license, or .gitignore.
2. Initialize and verify secret exclusion locally:
   ```bash
   git init
   # Verify .gitignore excludes .env, node_modules, and dist
   git status
   ```
3. Stage and commit:
   ```bash
   git add .
   git commit -m "Initial commit: Sunflower WCAG 2.2 AA Auditor"
   git branch -M main
   git remote add origin https://github.com/<owner>/<repo>.git
   git push -u origin main
   ```
- **Expected result:** Code pushes cleanly to `main`. Browsing GitHub confirms `.env` and `node_modules` are absent, while `output/official/` and `output/evidence-pack/` are committed.

---

## Step 3: Enable GitHub Pages
1. Navigate to repository **Settings** &rarr; **Pages**.
2. Under **Build and deployment** &rarr; **Source**, select **GitHub Actions**.
3. Note your Pages URL: `https://<owner>.github.io/<repo>/`.
- **Expected result:** A deployment workflow triggers upon push or dispatch, deploying `web/dist` and `demo-site/` to your Pages URL.

---

## Step 4: Create Supabase Project
1. Log in to [supabase.com](https://supabase.com) and click **New project**.
2. Select an organization, name the project (e.g. `sunflower-audit`), set a secure database password, and choose your preferred region.
3. Wait ~2 minutes for provisioning to finish.
4. Under **Project Settings** &rarr; **API**, copy:
   - **Project URL:** `https://<project-ref>.supabase.co`
   - **Publishable Key (`sb_publishable_...`)** (or legacy `anon` key)
   - **Secret Key (`sb_secret_...`)** (or legacy `service_role` key)
- **Expected result:** The Supabase dashboard status indicates the project is active.

> **Free Tier Inactivity Notice:** Supabase Free projects pause after 1 week of API inactivity. Before presenting a demo, open the Supabase dashboard; if paused, click **Restore project** (restoration takes 1–2 minutes).

---

## Step 5: Apply Database Schema
1. In the Supabase Dashboard, open **SQL Editor** &rarr; **New query**.
2. Paste the entire content of [`agent/src/db/schema.sql`](../agent/src/db/schema.sql).
3. Click **Run**.
- **Expected result:** Output reports `Success. No rows returned`. In **Table Editor**, 10 tables appear: `runs`, `page_inputs`, `sources`, `findings`, `evidence`, `decisions`, `actions`, `approvals`, `issues`, `retests`.

---

## Step 6: Create the Public Evidence Bucket
1. In the Supabase Dashboard, go to **Storage** &rarr; **New bucket**.
2. Bucket name: `evidence`.
3. Toggle **Public bucket** to **ON**.
4. Click **Save bucket**.
- **Expected result:** The `evidence` bucket is listed with a green **Public** badge.

---

## Step 7: Configure Supabase Edge Function Secrets
Set function secrets using the Supabase CLI (or in Dashboard under **Edge Functions** &rarr; **Secrets**). Only allowed secret names are permitted:

```bash
supabase login
supabase link --project-ref <project-ref>

# Set only permitted secret names:
supabase secrets set \
  GITHUB_PAT="<fine-grained-github-pat>" \
  GITHUB_REPO="<owner>/<repo>" \
  APPROVER_PASSCODE="<your-auditor-passcode>" \
  ALLOWED_ORIGINS="https://<owner>.github.io,http://localhost:4173,http://localhost:5173" \
  DEMO_SITE_URL="https://<owner>.github.io/<repo>/demo/" \
  AUDIT_ALLOWLIST="<owner>.github.io,127.0.0.1,localhost" \
  MAX_PAGES_PER_RUN="5" \
  MAX_RUNS_PER_HOUR="10"
```
- **Widening AUDIT_ALLOWLIST:** To audit other public domains, add comma-separated hosts to `AUDIT_ALLOWLIST` (e.g. `AUDIT_ALLOWLIST="<owner>.github.io,example.com"`).
- **Expected result:** Running `supabase secrets list` displays all 8 secrets with non-empty digests. Notice custom secrets do not use the reserved `SUPABASE_` prefix (the service role key `SUPABASE_SERVICE_ROLE_KEY` is injected automatically by the runtime).

---

## Step 8: Deploy Edge Functions with `--no-verify-jwt`
Deploy both functions from the repository root:
```bash
supabase functions deploy trigger-audit --no-verify-jwt
supabase functions deploy approve-action --no-verify-jwt
```
*Note: Both functions also declare `verify_jwt: false` in their local `config.json` files.*
- **Expected result:** CLI outputs `Deployed Function trigger-audit` and `Deployed Function approve-action`. In Supabase Dashboard &rarr; **Edge Functions**, both show active deployment status.

---

## Step 9: Configure GitHub Actions Secrets & Variables
In GitHub repository **Settings** &rarr; **Secrets and variables** &rarr; **Actions**:

1. Under the **Variables** tab (Public repository variables for Vite Pages build):
   - `SUPABASE_URL`: `https://<project-ref>.supabase.co`
   - `SUPABASE_PUBLISHABLE_KEY`: `sb_publishable_...` (or legacy `anon` key)

2. Under the **Secrets** tab (Encrypted secrets for CI audit runner):
   - `SUPABASE_URL`: `https://<project-ref>.supabase.co`
   - `SUPABASE_SECRET_KEY`: `sb_secret_...` (or legacy `service_role` key)
   - `MAX_PAGES_PER_RUN`: `5`

- **Expected result:** Variables tab displays the two public values; Secrets tab displays the encrypted worker credentials.

---

## Step 10: Generate Fine-Grained GitHub Personal Access Token (PAT)
1. Go to GitHub **Settings** &rarr; **Developer Settings** &rarr; **Personal Access Tokens** &rarr; **Fine-grained tokens**.
2. Click **Generate new token**.
3. Name: `sunflower-audit-trigger`.
4. Expiration: 30–90 days.
5. **Repository access:** Choose **Only select repositories** &rarr; select `<repo>`.
6. **Permissions:** Under **Repository permissions**, set **Actions** to **Read and write**.
7. Click **Generate token** and copy the resulting string (`github_pat_...`).
8. **Verify token can dispatch workflows:**
   ```bash
   curl -i -X POST \
     -H "Accept: application/vnd.github+json" \
     -H "Authorization: Bearer <GITHUB_PAT>" \
     https://api.github.com/repos/<owner>/<repo>/actions/workflows/audit.yml/dispatches \
     -d '{"ref":"main"}'
   ```
- **Expected result:** The curl command returns `HTTP/2 204 No Content`, and a new run appears under the GitHub repository **Actions** tab.

---

## Step 11: Configure LLM Provider Keys (Optional)
Sunflower runs 100% deterministically without LLM keys. To enable AI-generated plain-language explanations in the dashboard:
Add the following repository secrets under GitHub **Settings** &rarr; **Secrets and variables** &rarr; **Actions**:
- `LLM_API_KEY`: Groq API key (`gsk_...` from [console.groq.com](https://console.groq.com))
- `LLM_FALLBACK_API_KEY`: Google Gemini API key (`AIza...` from Google AI Studio)
- Default models: `llama-3.3-70b-versatile` (primary) and `gemini-2.5-flash` (fallback).
- **Expected result:** If secrets are omitted or quota is exhausted, decisions record `llm_status: disabled` or `quota_exhausted` and the dashboard renders "Explanation unavailable" without error.

---

## Step 12: Execute First Throwaway Audit
Run an end-to-end audit to verify CI dispatch, worker execution, and dashboard approval:

1. **Trigger audit:**
   Invoke the `trigger-audit` Edge Function:
   ```bash
   curl -X POST https://<project-ref>.supabase.co/functions/v1/trigger-audit \
     -H "Content-Type: application/json" \
     -d '{"urls": ["https://<owner>.github.io/<repo>/demo/modal.html"], "target_level": "WCAG2.2-AA"}'
   ```
   *Stage 1 expected result:* Returns HTTP 200 with JSON `{ "ok": true, "run_id": "run-...", "status": "pending" }`.

2. **Actions runner execution:**
   *Stage 2 expected result:* In GitHub Actions, workflow `audit.yml` runs, validates target against allowlist, builds conditional plan, runs axe, keyboard walker, contrast sampler, and heuristics, uploads evidence to Supabase `evidence` bucket, and sets run status to `awaiting_approval`.

3. **Dashboard verification & approval:**
   Open `https://<owner>.github.io/<repo>/?run=<run-id>`.
   *Stage 3 expected result:*
   - Header shows target level and run status `AWAITING_APPROVAL`.
   - Findings ledger shows detected barriers.
   - Evidence well displays screenshot and video artifacts directly from the public bucket.
   - Enter your name and `APPROVER_PASSCODE`, then click **Approve and Log**.
   - Issue row transitions to executed; subsequent approve attempts are rejected by database idempotency constraint.
