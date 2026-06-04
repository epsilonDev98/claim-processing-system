/**
 * Single-line adjudication (domain-model §5, decision contract acceptance §0.5, ledger §0.6).
 *
 * Runs the steps in the fixed order eligibility → coverage → exclusion → review → limit →
 * deductible → cost share, then derives the DecisionCode + LineState and the reason codes, the
 * payable money, the calculation breakdown, and the ledger deltas. Pure: no I/O. The service
 * never re-decides — it persists this outcome and applies the deltas.
 */

import { DecisionCode, ReasonCode } from '../domain/codes';
import type { CoverageRule } from '../domain/entities';
import { LineState } from '../domain/states';
import type { CalculationBreakdown } from '../domain/value-objects';
import {
  applyCostShare,
  applyDeductible,
  applyLimit,
  isCovered,
  isExcluded,
  isPolicyActiveOnDate,
  needsReview,
} from './steps';

/** Ledger bucket keys (acceptance §0.6). */
export const DEDUCTIBLE_BUCKET = 'DEDUCTIBLE';
export function annualLimitBucket(serviceCategory: string): string {
  return `ANNUAL_LIMIT:${serviceCategory}`;
}

/** A positive consumption to post to the ledger on approval/partial. */
export interface LedgerDelta {
  bucket: string;
  amountMinor: number;
}

export interface AdjudicationInput {
  billedMinor: number;
  serviceCategory: string;
  dateOfService: string;
  policy: { effectiveDate: string; terminationDate: string; annualDeductibleMinor: number };
  rule: CoverageRule | undefined;
  exclusions: readonly string[];
  /** Running balances for the member/period at the time this line is adjudicated. */
  deductibleConsumedMinor: number;
  annualLimitConsumedMinor: number;
  /**
   * When true, the Review step is skipped — a human has already reviewed the line, so it proceeds
   * to the payable math instead of pending. Used when resolving a manual-review pend (§5).
   */
  manuallyReviewed?: boolean;
}

export interface AdjudicationOutcome {
  decisionCode: DecisionCode;
  reasonCodes: ReasonCode[];
  lineState: LineState;
  allowedMinor: number;
  deductibleAppliedMinor: number;
  coinsuranceMinor: number;
  copayMinor: number;
  payableMinor: number;
  memberRespMinor: number;
  breakdown: CalculationBreakdown;
  /** Positive consumption to post on approve/partial; empty for deny/pend. */
  ledgerDeltas: LedgerDelta[];
}

export function adjudicateLine(input: AdjudicationInput): AdjudicationOutcome {
  const { billedMinor, serviceCategory, dateOfService, policy, rule, exclusions } = input;

  // a. Eligibility — hard deny if the policy is inactive on the date of service.
  if (!isPolicyActiveOnDate(policy, dateOfService)) {
    return hardDeny(ReasonCode.POLICY_INACTIVE, billedMinor);
  }

  // b. Coverage — hard deny if the category is not covered (or has no rule).
  if (!isCovered(rule)) {
    return hardDeny(ReasonCode.NOT_COVERED, billedMinor);
  }

  // c. Exclusion — hard deny if explicitly excluded (distinct from coverage).
  if (isExcluded(serviceCategory, exclusions)) {
    return hardDeny(ReasonCode.EXCLUDED_SERVICE, billedMinor);
  }

  // d. Review — pend and stop; no payment math runs. Skipped once a human has reviewed the line.
  if (!input.manuallyReviewed && needsReview(rule, billedMinor)) {
    return pend(billedMinor);
  }

  // e. Limit — exhausted limit is a hard deny; a partial cap continues to cost share.
  const limit = applyLimit(billedMinor, rule, input.annualLimitConsumedMinor);
  if (limit.annualLimitReached) {
    return hardDeny(ReasonCode.ANNUAL_LIMIT_REACHED, billedMinor);
  }

  // f. Deductible, then g. Cost share.
  const deductible = applyDeductible(limit.allowedMinor, policy.annualDeductibleMinor, input.deductibleConsumedMinor);
  const costShare = applyCostShare(deductible.afterDeductibleMinor, rule);

  const payableMinor = costShare.payableMinor;
  const memberRespMinor = billedMinor - payableMinor;

  // Reason codes, in pipeline evaluation order (limit → deductible → cost share).
  const reasonCodes: ReasonCode[] = [];
  if (limit.perIncidentMaxApplied) reasonCodes.push(ReasonCode.PER_INCIDENT_MAX_APPLIED);
  if (limit.annualLimitApplied) reasonCodes.push(ReasonCode.ANNUAL_LIMIT_APPLIED);
  if (deductible.deductibleAppliedMinor > 0) reasonCodes.push(ReasonCode.DEDUCTIBLE_APPLIED);
  if (costShare.coinsuranceMinor > 0) reasonCodes.push(ReasonCode.COINSURANCE_APPLIED);
  if (costShare.copayMinor > 0) reasonCodes.push(ReasonCode.COPAY_APPLIED);

  // Decision derivation §0.5 guards 4–6: a covered line where the plan pays the full bill is
  // APPROVED; anything less (including $0 consumed entirely by deductible/share) is partial.
  let decisionCode: DecisionCode;
  let lineState: LineState;
  if (payableMinor === billedMinor) {
    decisionCode = DecisionCode.APPROVED;
    lineState = LineState.APPROVED;
    if (reasonCodes.length === 0) reasonCodes.push(ReasonCode.COVERED);
  } else {
    decisionCode = DecisionCode.PARTIALLY_APPROVED;
    lineState = LineState.PARTIALLY_APPROVED;
    // A partial always has at least one cost-share/limit reason; COVERED is a defensive fallback.
    if (reasonCodes.length === 0) reasonCodes.push(ReasonCode.COVERED);
  }

  // Ledger deltas: deductible consumed + allowed consumed against the annual limit (if any).
  // 0-amount consumptions are omitted (§0.6).
  const ledgerDeltas: LedgerDelta[] = [];
  if (deductible.deductibleAppliedMinor > 0) {
    ledgerDeltas.push({ bucket: DEDUCTIBLE_BUCKET, amountMinor: deductible.deductibleAppliedMinor });
  }
  if (rule.annualLimitMinor !== undefined && limit.allowedMinor > 0) {
    ledgerDeltas.push({ bucket: annualLimitBucket(serviceCategory), amountMinor: limit.allowedMinor });
  }

  return {
    decisionCode,
    reasonCodes,
    lineState,
    allowedMinor: limit.allowedMinor,
    deductibleAppliedMinor: deductible.deductibleAppliedMinor,
    coinsuranceMinor: costShare.coinsuranceMinor,
    copayMinor: costShare.copayMinor,
    payableMinor,
    memberRespMinor,
    breakdown: [
      { label: 'Billed', amountMinor: billedMinor },
      { label: 'Allowed', amountMinor: limit.allowedMinor },
      { label: 'Deductible applied', amountMinor: deductible.deductibleAppliedMinor },
      { label: 'After deductible', amountMinor: deductible.afterDeductibleMinor },
      { label: 'Coinsurance', amountMinor: costShare.coinsuranceMinor },
      { label: 'Copay', amountMinor: costShare.copayMinor },
      { label: 'Payable', amountMinor: payableMinor },
    ],
    ledgerDeltas,
  };
}

/** Hard deny (eligibility/coverage/exclusion/limit-exhausted): payable 0, member owes the bill. */
function hardDeny(reason: ReasonCode, billedMinor: number): AdjudicationOutcome {
  return {
    decisionCode: DecisionCode.DENIED,
    reasonCodes: [reason],
    lineState: LineState.DENIED,
    allowedMinor: 0,
    deductibleAppliedMinor: 0,
    coinsuranceMinor: 0,
    copayMinor: 0,
    payableMinor: 0,
    memberRespMinor: billedMinor,
    breakdown: [
      { label: 'Billed', amountMinor: billedMinor },
      { label: 'Payable', amountMinor: 0 },
    ],
    ledgerDeltas: [],
  };
}

/** Pend for manual review: pipeline stops, nothing computed or consumed yet. */
function pend(billedMinor: number): AdjudicationOutcome {
  return {
    decisionCode: DecisionCode.NEEDS_REVIEW,
    reasonCodes: [ReasonCode.PENDED_FOR_REVIEW],
    lineState: LineState.NEEDS_REVIEW,
    allowedMinor: 0,
    deductibleAppliedMinor: 0,
    coinsuranceMinor: 0,
    copayMinor: 0,
    payableMinor: 0,
    // Payable/member responsibility are pending (not computed) for a pended line.
    memberRespMinor: 0,
    breakdown: [{ label: 'Billed', amountMinor: billedMinor }],
    ledgerDeltas: [],
  };
}
