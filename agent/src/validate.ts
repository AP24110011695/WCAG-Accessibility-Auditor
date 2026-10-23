// Stage-1 (Collect) input validation, FR-01: runs before anything executes.
// Self-contained by design: imported both by the orchestrator (TS) and by
// node --test via type stripping (.mjs test file).

export const ALLOWED_LEVELS = ["WCAG2.1-A", "WCAG2.1-AA", "WCAG2.2-A", "WCAG2.2-AA"] as const;

type ValidationError = { field: string; message: string };
type EnvLimits = { maxPages: number; allowedHosts: string[] };

export function validateAuditInput(input: unknown, limits: EnvLimits): ValidationError[] {
  const errors: ValidationError[] = [];
  if (typeof input !== "object" || input === null) {
    return [{ field: "body", message: "A JSON object with urls and target_level is required." }];
  }
  const { urls, target_level } = input as Record<string, unknown>;

  if (!Array.isArray(urls) || urls.length === 0) {
    errors.push({ field: "urls", message: "At least one page URL is required." });
  } else {
    if (urls.length > limits.maxPages) {
      errors.push({ field: "urls", message: `At most ${limits.maxPages} pages per audit.` });
    }
    const seen = new Set<string>();
    urls.forEach((u, i) => {
      const field = `urls[${i}]`;
      if (typeof u !== "string" || u.trim() === "") {
        errors.push({ field, message: "URL must be a non-empty string." });
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(u.trim());
      } catch {
        errors.push({ field, message: `Not a valid URL: ${u}` });
        return;
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        errors.push({ field, message: `Only http(s) URLs are supported: ${u}` });
      }
      const host = parsed.hostname.toLowerCase();
      if (!limits.allowedHosts.includes(host)) {
        errors.push({ field, message: `Target not allowlisted: ${host}. Permitted: ${limits.allowedHosts.join(", ")}` });
      }
      if (seen.has(parsed.href)) {
        errors.push({ field, message: `Duplicate URL: ${u}` });
      }
      seen.add(parsed.href);
    });
  }

  if (typeof target_level !== "string" || !(ALLOWED_LEVELS as readonly string[]).includes(target_level)) {
    errors.push({ field: "target_level", message: `target_level must be one of: ${ALLOWED_LEVELS.join(", ")}.` });
  }
  return errors;
}
