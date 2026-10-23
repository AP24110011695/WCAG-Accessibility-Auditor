// P2-T2 (FR-04): axe-core runner. Ruleset per target level; axe
// "incomplete" results become uncertain findings (FR-08).
// Tag map verified against installed axe-core 4.14.0 on 2026-10-17
// (getRules() probe): wcag22a does not exist, so WCAG2.2-A == 2.1-A tags.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "playwright";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export const LEVEL_TAGS: Record<string, string[]> = {
  "WCAG2.1-A": ["wcag2a", "wcag21a"],
  "WCAG2.1-AA": ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
  "WCAG2.2-A": ["wcag2a", "wcag21a"],
  "WCAG2.2-AA": ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
};

interface AxeNode {
  target: string[];
  html: string;
  any: { data?: Record<string, unknown> }[];
}
interface AxeRuleResult {
  id: string;
  impact: string | null;
  help: string;
  tags: string[];
  nodes: AxeNode[];
}
export interface AxeOutcome {
  violations: AxeRuleResult[];
  incomplete: AxeRuleResult[];
  passesCount: number;
}

export function tagsForLevel(level: string): string[] {
  const tags = LEVEL_TAGS[level];
  if (!tags) throw new Error(`Unsupported target level: ${level}`);
  return tags;
}

// "wcag412" -> "4.1.2" (first WCAG tag on the rule)
export function criterionOf(rule: AxeRuleResult): string {
  const tag = rule.tags.find((t) => /^wcag\d{3}$/.test(t));
  if (!tag) return "best practice";
  const n = tag.slice(4);
  return `${n[0]}.${n[1]}.${n[2]}`;
}

export async function runAxe(page: Page, level: string): Promise<AxeOutcome> {
  await page.addScriptTag({ content: axeSource });
  const raw = (await page.evaluate(async (tags: string[]) => {
    const axe = (window as unknown as { axe: { run: (c: Document, o: object) => Promise<unknown> } }).axe;
    return axe.run(document, { runOnly: { type: "tag", values: tags } });
  }, tagsForLevel(level))) as { violations: AxeRuleResult[]; incomplete: AxeRuleResult[]; passes: AxeRuleResult[] };

  return {
    violations: raw.violations,
    incomplete: raw.incomplete,
    passesCount: raw.passes.length,
  };
}
