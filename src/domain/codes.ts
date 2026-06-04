/**
 * Decision and reason codes (domain-model §8).
 *
 * Two distinct dimensions on every adjudication:
 *   - DecisionCode — the *outcome*; closed enum; exactly ONE per adjudication.
 *   - ReasonCode   — the *cause* (which pipeline step drove it); closed set; ONE OR MANY.
 *
 * String-valued enums so the codes serialize/persist as their own names
 * (Adjudication.reasonCodes is stored as a JSON array of these strings).
 */

/** The outcome of adjudicating a single line. Exactly one per adjudication. */
export enum DecisionCode {
  APPROVED = 'APPROVED',
  PARTIALLY_APPROVED = 'PARTIALLY_APPROVED',
  DENIED = 'DENIED',
  NEEDS_REVIEW = 'NEEDS_REVIEW',
}

/**
 * The cause(s) behind a decision — emitted by pipeline steps, resolved against
 * the ExplanationCode catalog. One or many per adjudication.
 */
export enum ReasonCode {
  COVERED = 'COVERED',
  NOT_COVERED = 'NOT_COVERED',
  EXCLUDED_SERVICE = 'EXCLUDED_SERVICE',
  POLICY_INACTIVE = 'POLICY_INACTIVE',
  DEDUCTIBLE_APPLIED = 'DEDUCTIBLE_APPLIED',
  ANNUAL_LIMIT_APPLIED = 'ANNUAL_LIMIT_APPLIED',
  ANNUAL_LIMIT_REACHED = 'ANNUAL_LIMIT_REACHED',
  COINSURANCE_APPLIED = 'COINSURANCE_APPLIED',
  COPAY_APPLIED = 'COPAY_APPLIED',
  PENDED_FOR_REVIEW = 'PENDED_FOR_REVIEW',
  PER_INCIDENT_MAX_APPLIED = 'PER_INCIDENT_MAX_APPLIED',
}

/** Every decision code value (useful for exhaustive checks/tests). */
export const ALL_DECISION_CODES: readonly DecisionCode[] = Object.values(DecisionCode);

/** Every reason code value (the set the catalog completeness check covers — §14). */
export const ALL_REASON_CODES: readonly ReasonCode[] = Object.values(ReasonCode);
