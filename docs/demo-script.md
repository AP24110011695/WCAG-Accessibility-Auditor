# Three-minute demonstration script

1. Before presenting, trigger one throwaway audit. Confirm the Actions queue time and that secrets work; do not rely on a sleeping-service warm-up.
2. Open the Pages dashboard and select TC1. Inspect the keyboard video, screenshots, and trace, then explain that a human must enter their name and transient passcode before logging an issue.
3. Switch to TC2. Show that axe has no violations while the deterministic contextual-link and focus checks still produce four evidenced findings.
4. Switch to TC3. Open the two image artifacts: rendered text and background-only pixels. Point out the measured contrast ratio and the `uncertain` axe result.
5. Switch to TC4. Show a failed retest leaving the issue open, then a clean retest that only proposes closure until a human approves it.
6. Close on the evidence pack: every artifact has a SHA-256 checksum, and decisions show `llm_status`. The LLM supplies optional wording only; deterministic checks make every verdict.
