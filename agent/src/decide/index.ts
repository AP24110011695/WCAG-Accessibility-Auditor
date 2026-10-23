// P4-T1 (FR-08): decision layer. Turns candidate findings into immutable
// decisions with explicit rule, threshold, and written rationale.
// Uncertain conditions are enumerated and never guessed.
import type { FindingRow, DecisionRow } from "../store/index.ts";

export interface DecisionInput {
  finding: FindingRow;
  evidenceMissing?: boolean;
  unreachableElement?: boolean;
}

export function decideFinding(input: DecisionInput): Omit<DecisionRow, "decision_id"> {
  const { finding, evidenceMissing, unreachableElement } = input;

  // Rule 1: Missing evidence or unreachable element forces uncertain state
  if (evidenceMissing) {
    return {
      finding_id: finding.finding_id,
      input_id: finding.input_id,
      outcome: "uncertain",
      rule: finding.rule_id,
      reason: `Evidence missing for finding ${finding.rule_id}; cannot verify failure or pass deterministically`,
      input_evidence_ids: finding.evidence_ids,
      llm_involved: false,
      llm_status: "none",
    };
  }

  if (unreachableElement) {
    return {
      finding_id: finding.finding_id,
      input_id: finding.input_id,
      outcome: "uncertain",
      rule: finding.rule_id,
      reason: `Element at selector ${finding.selector ?? "unknown"} could not be targeted or measured`,
      input_evidence_ids: finding.evidence_ids,
      llm_involved: false,
      llm_status: "none",
    };
  }

  // Rule 2: Axe 'incomplete' becomes uncertain
  if (finding.check_type === "axe" && finding.state === "uncertain") {
    return {
      finding_id: finding.finding_id,
      input_id: finding.input_id,
      outcome: "uncertain",
      rule: finding.rule_id,
      reason: `Automated engine flagged rule ${finding.rule_id} as incomplete/needs review; specialized or manual test required`,
      input_evidence_ids: finding.evidence_ids,
      llm_involved: false,
      llm_status: "none",
    };
  }

  // Rule 3: Deterministic pass or fail preserves state with evidence
  return {
    finding_id: finding.finding_id,
    input_id: finding.input_id,
    outcome: finding.state,
    rule: finding.rule_id,
    reason: finding.reason,
    input_evidence_ids: finding.evidence_ids,
    llm_involved: false,
    llm_status: "none",
  };
}