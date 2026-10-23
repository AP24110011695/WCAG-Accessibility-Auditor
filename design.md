# Design — the Sunflower Audit UI system

> A refined, editorial, calm interface that reads as designed by a careful person. This is also our demo stage: the UI audits accessibility for a living, so it must visibly pass its own audit (NFR-6). Components are built against these tokens; nothing ships outside them.

## 1. Design direction

**"The auditor's ledger."** Warm paper background, a characterful serif for headings, disciplined IBM Plex for body and data, hairline borders instead of shadows, generous whitespace, and one restrained green ("leaf") for interactive elements with a single sunflower-gold accent used only as decoration — a nod to the team name. The layout is a working document, not a dashboard: numbered sections, ruled tables, real sentences. Severity is communicated by glyph + word + border treatment, never colour alone. Motion is limited to small, fast transitions. The overall effect: an evidence file you can read cover to cover.

**Must not look like:**
- purple-to-blue gradients; glow/glassmorphism/backdrop-blur panels;
- emoji used as icons; rainbow severity badges; traffic-light overload;
- oversized `rounded-2xl` cards stacked everywhere; default shadcn/Material look;
- lorem-ipsum-feeling copy, exclamation-heavy marketing voice, centered-hero-with-blob;
- colour as the only carrier of meaning.

## 2. Typography

| Role | Font | Weights | Notes |
|---|---|---|---|
| Display & headings | **Fraunces** (Google Fonts, self-hosted `.woff2` in `web/src/assets/fonts`) | 560, 620 (softness axis 0, optical size auto) | Headings are set tight and warm; never faux-italic. |
| Body & UI | **IBM Plex Sans** | 400, 500, 600 | All controls, table cells, chips. |
| Data & code | **IBM Plex Mono** | 400, 500 | URLs, selectors, IDs, timestamps, ratios, keystroke traces. Uppercase + `letter-spacing .08em` for eyebrow labels only. |

**Modular scale** (ratio ≈1.25, rem-based):

| Token | Size / line-height | Weight / font | Letter-spacing |
|---|---|---|---|
| `--text-xs` | 0.75rem / 1rem | 500 mono | +0.08em, uppercase (eyebrows, table headers) |
| `--text-sm` | 0.875rem / 1.35 | 400 sans | normal |
| `--text-base` | 1rem / 1.625 | 400 sans | normal |
| `--text-md` | 1.125rem / 1.55 | 400 sans | normal |
| `--text-lg` | 1.375rem / 1.25 | 560 Fraunces | −0.005em |
| `--text-xl` | 1.75rem / 1.2 | 580 Fraunces | −0.01em |
| `--text-2xl` | 2.25rem / 1.15 | 600 Fraunces | −0.015em |
| `--text-3xl` | 3rem / 1.05 | 600 Fraunces | −0.02em (display, used once per page max) |

Body measure: max 68ch. Headings hierarchy is never skipped (`h1→h2→h3`).

## 3. Colour system

Named tokens, warm-paper palette. Every text pair below was computed with the WCAG relative-luminance formula and re-verified in the P7 self-audit task; the table is the contract.

| Token | Hex | Role |
|---|---|---|
| `--color-bg` | `#FAF7F0` | Page background (warm paper). |
| `--color-surface` | `#FFFFFF` | Cards, panels, table body. |
| `--color-surface-sunken` | `#F1EBDD` | Evidence well, code blocks, table stripes. |
| `--color-ink` | `#1C1917` | Primary text. |
| `--color-ink-muted` | `#57534E` | Secondary text, captions. |
| `--color-border` | `#E4DCC9` | Hairline rules, table borders. |
| `--color-border-strong` | `#C9BFA6` | Emphasised rules, input borders. |
| `--color-accent` | `#3D6B35` | Links, buttons, focus rings, active states ("leaf"). |
| `--color-accent-soft` | `#EAF3EC` | Accent tint surfaces (approved banner). |
| `--color-gold` | `#E9A820` | **Decorative only** (heading under-rule, ledger tick marks). Never text, never the sole indicator. |
| `--color-fail` | `#B3261E` | Failure text/borders. |
| `--color-fail-bg` | `#FBEDEB` | Failure chip/panel tint. |
| `--color-uncertain` | `#8A5A00` | Uncertain text/borders. |
| `--color-uncertain-bg` | `#FAF3E3` | Uncertain chip/panel tint. |
| `--color-pass` | `#256B44` | Pass text/borders. |
| `--color-pass-bg` | `#EAF3EC` | Pass chip tint. |

**Verified contrast pairs** (computed, WCAG 2.x relative luminance; minimums: 4.5:1 text, 3:1 large text & UI borders):

| Pair | Ratio | Verdict |
|---|---|---|
| ink on bg / surface | 16.3 / 17.5 | AA + AAA |
| ink-muted on bg / surface | 7.1 / 7.8 | AA + AAA |
| ink-muted on surface-sunken | 6.4 | AA |
| accent on bg / surface | 5.9 / 6.3 | AA (normal text) |
| fail on surface / fail-bg | 6.5 / 5.7 | AA |
| uncertain on surface / uncertain-bg | 5.9 / 5.4 | AA |
| pass on surface / pass-bg | 6.4 / 5.7 | AA |
| border-strong vs bg (UI boundary) | ~1.9 | used with glyph/text affordances, never alone |
| gold vs bg | 1.9 | decorative only — exempt from 3:1; never conveys information |

Rule: coloured text never sits on a tint of a different hue family; status text uses its token on white or its matching tint (both verified above).

## 4. Spacing, grid, radii, borders, elevation

- **Spacing scale (4px base):** `--space-1: 4px · --space-2: 8px · --space-3: 12px · --space-4: 16px · --space-5: 24px · --space-6: 32px · --space-7: 48px · --space-8: 64px · --space-9: 96px`. Section rhythm: `--space-7` between page sections; `--space-4` inside cards.
- **Grid:** 12-column, `max-width: 1120px`, gutter 24px, side padding 24px (16px under 640px). Issue detail uses a 7/5 split (evidence right).
- **Radii:** `--radius-sm: 2px` (inputs, chips), `--radius-md: 4px` (cards, panels), `--radius-full: 999px` (nothing else). Sharp, editorial — no pill-stack look.
- **Borders over shadows:** 1px `--color-border` everywhere; `--color-border-strong` for inputs and interactive boundaries (with visible focus states doing the heavy lifting).
- **Elevation (only for overlays):** `--shadow-overlay: 0 8px 24px rgba(28,25,23,.12)`. Nothing else casts a shadow.
- **Rules:** a 2px `--color-gold` under-rule, 32px wide, sits under the `h1` of each page — the one ornamental signature.

## 5. Component specs

| Component | Spec |
|---|---|
| **Issue list table** | Full-width ruled table (`--border` row rules, no zebra). Columns: ID (mono chip), Issue title (sans 500), WCAG criterion (mono sm), Severity (chip), State (chip), Evidence count. Row click → detail. Sortable by severity/state; header row is `--text-xs` uppercase mono with `scope="col"`. Sticky header on scroll. |
| **Issue detail** | Two columns (7/5). Left: title, WCAG criterion, severity, full decision trail rendered as a numbered ledger (`run → page input → source → decision → action/approval`), reason text (plain English, from FR-08), axe context if any. Right: evidence well on `--surface-sunken` — annotated screenshot, video player for TC1, keystroke trace table, pixel-sample JSON in mono. Every evidence item has filename, checksum suffix (last 8 chars) and timestamp. |
| **Approval panel** | Appears on `awaiting_approval`. Header: "Proposed action · Issue log · run `<run_id>`". Body shows the **exact payload** (title, description, criterion, severity, evidence links) rendered as it will be stored. Buttons: "Approve and log" (accent solid), "Reject" (outline). Both require an approver name input (text, 2–40 chars). After decision: immutable banner ("Approved by … at …" / "Rejected by …") and the payload is never editable — a change means a new proposal. |
| **Test-case run cards** | One card per TC (`--surface`, `--radius-md`, strong top border). Header: mono ID + title + status chip. Body rows: Input (fixture URL + params, mono), Expected (official wording), Actual (what happened), Evidence (links), Explanation (honest diff note when `matches_expected = false`). |
| **Status chips** | Glyph + word + border treatment, colour third. `fail`: `✕ FAIL` — solid `--color-fail` border on `--color-fail-bg`. `uncertain`: `? UNCERTAIN` — **dashed** border on `--color-uncertain-bg`. `pass`/`closed`: `✓ PASS` / `✓ CLOSED` — solid `--color-pass` on `--color-pass-bg`. `open`: `○ OPEN` — neutral border. `pending`: `… PENDING` — neutral. Border-style difference means the state survives greyscale printing. |
| **Empty state** | Centered, quiet: eyebrow label, one Fraunces line ("Nothing logged yet."), one sentence with the next action, and the action as a text link — no illustration dumps. |
| **Loading state** | Skeleton = `--surface-sunken` blocks matching final layout; if >2 s, a visible line of copy ("Auditing /photo-hero — running keyboard walk…") with stage name from the run timeline. |
| **Queued state** | Shown after starting an audit while the CI worker picks up the dispatch: "Queued — the worker starts in under a minute typically." Neutral bordered panel with a `…` glyph and the run id in mono; auto-updates via polling; never styled as an error. |
| **Error state** | Bordered panel, `✕` glyph, specific message: what failed, the exact cause, what to do next ("Couldn't reach example.com — timeout after 15 s. Retry, or remove this page from the audit."). Errors never auto-dismiss. |

## 6. Microcopy guidelines

- Plain, specific, human. Name numbers and next steps; never say "Oops", "Something went wrong", or "Please try again later" without the cause.
- Write like an auditor's note: "3 issues found on /checkout — 1 needs your eyes." / "This will log 4 issues to run `run-20261020-1430-a1b2`. Nothing is written until you approve."
- Uncertain is honest and calm: "We couldn't measure contrast here — fewer than 50 text pixels were isolated against the photo. Marked UNCERTAIN, not failed."
- Buttons are verbs ("Approve and log", "Start retest"), never "OK"/"Submit".
- Empty/loading/error states use full sentences (see §5), never fragments.
- No emoji, no exclamation marks, no marketing adjectives.

## 7. Accessibility requirements for our own UI (NFR-6)

- Full keyboard operability: every control reachable and operable by Tab/Shift+Tab/Enter/Space; focus order follows DOM order; no keyboard traps (we dogfood our own TC1 check).
- Focus ring: `3px solid --color-accent` with `2px` offset on all interactive elements (5.9:1 on paper — passes non-text 3:1); on dark/overlay surfaces the ring is `--color-gold` (verified ≥3:1 against `--color-ink` panels).
- Semantic HTML: real `<table>` with headers, `<nav>/<main>/<section aria-labelledby>`, `<label for>` on every field, error messages tied via `aria-describedby`, status changes announced via `aria-live="polite"`.
- Chips carry text + glyph (never colour alone); decorative gold marked `aria-hidden`.
- `prefers-reduced-motion: reduce` disables all transitions/animations; `prefers-contrast: more` swaps borders to `--color-ink`.
- Target size ≥ 24×24px; no hover-only affordances.
- Self-audit gate (task P7-T5): axe at 2.2 AA = 0 violations on every view, plus a recorded keyboard walk of the approval panel.

## 8. Motion

- 120–160ms `ease-out` on hover/focus/chip transitions only. No parallax, no entrance animation chains, no autoplaying video (TC1 video is user-started with captions of the keystroke trace beside it).
- `prefers-reduced-motion` ⇒ transitions 0ms (media query in tokens).
- The run timeline advances by state change, not animation.

## 9. Design tokens (CSS variables — ready to use)

```css
:root {
  /* colour */
  --color-bg: #FAF7F0;
  --color-surface: #FFFFFF;
  --color-surface-sunken: #F1EBDD;
  --color-ink: #1C1917;
  --color-ink-muted: #57534E;
  --color-border: #E4DCC9;
  --color-border-strong: #C9BFA6;
  --color-accent: #3D6B35;
  --color-accent-soft: #EAF3EC;
  --color-gold: #E9A820;            /* decorative only, aria-hidden */
  --color-fail: #B3261E;  --color-fail-bg: #FBEDEB;
  --color-uncertain: #8A5A00; --color-uncertain-bg: #FAF3E3;
  --color-pass: #256B44;  --color-pass-bg: #EAF3EC;

  /* typography */
  --font-serif: "Fraunces", Georgia, serif;
  --font-sans: "IBM Plex Sans", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, monospace;
  --text-xs: 0.75rem;   --lh-xs: 1rem;
  --text-sm: 0.875rem;  --lh-sm: 1.35;
  --text-base: 1rem;    --lh-base: 1.625;
  --text-md: 1.125rem;  --lh-md: 1.55;
  --text-lg: 1.375rem;  --lh-lg: 1.25;
  --text-xl: 1.75rem;   --lh-xl: 1.2;
  --text-2xl: 2.25rem;  --lh-2xl: 1.15;
  --text-3xl: 3rem;     --lh-3xl: 1.05;
  --ls-tight: -0.01em;
  --ls-label: 0.08em;

  /* spacing (4px base) */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px;
  --space-9: 96px;

  /* shape & elevation */
  --radius-sm: 2px; --radius-md: 4px; --radius-full: 999px;
  --border-width: 1px;
  --shadow-overlay: 0 8px 24px rgba(28, 25, 23, 0.12);

  /* layout */
  --grid-max: 1120px; --grid-gutter: 24px; --measure: 68ch;

  /* motion */
  --motion-fast: 130ms ease-out;
}
```

Fonts are self-hosted `.woff2` (Fraunces 560/600/620, Plex Sans 400/500/600, Plex Mono 400/500) — no runtime font CDN dependency during the demo.
