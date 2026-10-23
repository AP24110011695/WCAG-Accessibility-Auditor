# Sunflower Accessibility Auditor — Presentation & Demo Script

> **Team Sunflower · Ziro.Digital Agentic AI Hackathon 2026**
> Audience: Evaluation Panel & Judges
> Target Duration: 5–7 minutes

---

## 1. Presentation Outline & Pitch Deck Structure

### Slide 1: Title & Hook
- **Headline:** Sunflower Accessibility Auditor — Autonomous WCAG 2.2 AA Agent
- **Sub-headline:** Finding what single-tool scanners miss, with cryptographic evidence and human-in-the-loop control.
- **Problem:** Automated single-tool scanners (like pure axe-core) miss over 60% of real WCAG barriers:
  - Focus trapped in modal dialogs
  - Ambiguous link purposes ("click here", "read more")
  - Focus outlines stripped via CSS `:focus { outline: none; }`
  - Text placed over real photography where CSS color alone is meaningless

### Slide 2: The 4-Stage Agent Loop
- **Stage 1 (Collect):** Authoritative validation gate. Malformed URLs, unallowlisted origins, or unreachable targets never consume compute.
- **Stage 2 (Plan):** Declared and persisted audit plan before running.
- **Stage 3 (Find):** Multi-tool deterministic sweep (axe-core baseline + interactive Playwright keyboard walker + pixel-sampling contrast analyzer + manual-assist heuristics).
- **Stage 4 (Act):** Human-in-the-loop approval gate. Every action starts as `proposed`. Approvals sign the record with approver identity; database-level idempotency prevents duplicate execution.

### Slide 3: Differentiating Technical Innovations
1. **Interactive Keyboard Walker:** Detects modal focus traps across 3 full Tab cycles, tests Escape closure, and captures a `.webm` video with synchronized keystroke trace.
2. **True Pixel Sampler on Photographs:** Captures element with text, sets `visibility: hidden` to sample the underlying photographic pixels, and evaluates worst-case (min) and mean contrast ratios.
3. **Honest `uncertain` States:** Axe `incomplete` results and low pixel distributions become explicit `uncertain` findings rather than false passes or crashes.
4. **Self-Audited Results UI:** Built with IBM Plex and Fraunces editorial tokens, achieving **0 axe violations at WCAG 2.2 AA** and full keyboard operability.

### Slide 4: Zero-Cost, Card-Free Stack
- 100% free-tier verified:
  - **Audit Compute:** GitHub Actions CI (`ubuntu-latest`, 4 vCPU, 16 GB RAM)
  - **Static Dashboard:** GitHub Pages
  - **Database & Trigger:** Supabase Postgres + Edge Functions (500K invocations/mo)
  - **Local Runner:** Disk-isolated `LocalStore` running offline with zero cloud dependency

---

## 2. Pre-Demo Checklist (Before the Demo)

Trigger one throwaway audit beforehand to confirm Actions queue time and that secrets work.

1. [ ] Verify tests pass: `npm test` (all 27 tests green).
2. [ ] Verify typecheck passes: `npm run typecheck` (0 errors).

---

## 3. Step-by-Step Live Demo Script (5 Minutes)

### Minute 0:00 – 1:00: Introduction & The 4-Stage Loop
- **Speaker:** "Good morning judges. Today, most accessibility audits rely on automated scanners that miss keyboard traps, missing focus indicators, and text over background images. We built Sunflower Accessibility Auditor—an autonomous agent running a strict 4-stage loop: Collect, Plan, Find, and Act."
- **Action:** Open `http://localhost:4173/?run=run-official-tc1` in browser. Point to the top status bar: Target level, Run ID, and the declared **Run Timeline & Plan**.

### Minute 1:00 – 2:00: TC1 — The Keyboard Focus Trap
- **Speaker:** "Notice our first official test case: `modal.html`. Axe-core marked this modal clean because ARIA attributes were valid. But our agent ran an interactive Playwright keyboard walker. It pressed Tab, observed focus cycling inside the modal for 3 complete loops while interactive elements existed outside, and verified Escape failed to close the modal."
- **Action:**
  - Click on the `keyboard-trap` finding in the Findings Ledger.
  - Show the **Evidence Well**: point to the attached `.webm` video recording, keystroke trace, and walk screenshots.
  - Point to the **Decision Audit Trail**: Explain that the rule is deterministic under WCAG 2.1.2.

### Minute 2:00 – 3:00: TC2 — Axe Passes but Manual Heuristics Fail
- **Speaker:** "In TC2 (`links.html`), axe reports zero violations. But our heuristics inspected the accessible text and computed focus styles. It detected 3 generic link phrases ('click here', 'read more', 'learn more') under WCAG 2.4.4 and a custom button where CSS `:focus { outline: none; }` removed the indicator under WCAG 2.4.7."
- **Action:** Switch to `run-official-tc2` via the run dropdown. Show all 4 distinct, contextual selectors (`section[aria-labelledby='water'] a[href='index.html']`, etc.) and show that all 4 were approved and logged.

### Minute 3:00 – 4:00: TC3 — Pixel Contrast on Photo Backgrounds
- **Speaker:** "In TC3 (`photo-hero.html`), axe returned `incomplete` because it cannot evaluate contrast against CSS background photographs. Rather than guessing, Sunflower isolated the element, hid the text via `visibility: hidden` to capture the true background photograph pixels, and sampled the actual luminance distribution."
- **Action:**
  - Switch to `run-official-tc3`.
  - Point to the dual screenshots in the evidence pack: Rendered text visible vs background only.
  - Highlight the measured numbers: worst-case **1.36:1** against the 4.5:1 requirement (failing), and mean **1.51:1**.

### Minute 4:00 – 4:45: TC4 — Retest Loop & Idempotent Human Approval Gate
- **Speaker:** "Now let's see how actions and retests work. When `form.html` was audited with a missing label, an issue was proposed. Notice: the agent cannot write directly to the issue log. It requires human approval."
- **Action:**
  - Show the **Human Approval Gate**: enter 'Lead Auditor Jane' and click **Approve and Log**.
  - Show that a second click or repeated API call is rejected by the database UNIQUE idempotency key—zero double logging.
  - Show the **Retest Ledger**: Negative retest on broken form returned `fail` and kept the issue open. Retest on fixed form returned `pass`, proposing `close_issue`. Issue transitioned to `closed` only after human approval.

### Minute 4:45 – 5:30: Self-Audit & Conclusion
- **Speaker:** "Finally, Sunflower audits itself: our dashboard achieves **0 axe violations at WCAG 2.2 AA** and full keyboard operability. Everything you saw runs on 100% free, card-free infrastructure. Thank you!"
- **Action:** Open `output/evidence-pack/evidence-pack.html` in browser to show the complete self-contained evaluation dossier.
