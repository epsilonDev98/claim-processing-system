/**
 * Adjudication pipeline steps (domain-model §4/§5, math contract acceptance §0.4).
 *
 * Each step is a pure function. The fixed evaluation order lives in `adjudicate-line.ts`; this
 * module only encodes what each step decides/computes. All money arithmetic goes through `Money`
 * so rounding is identical everywhere (the coinsurance figures in S3/S5/S7).
 *
 * Steps a–c are hard-deny gates, d pends, e–g compute the payable math on a covered rule.
 */

import { Money } from '../domain/money';
import type { CoverageRule, CoveredRule } from '../domain/entities';

/** a. Eligibility — the policy must be active on the date of service (inclusive bounds). */
export function isPolicyActiveOnDate(
  policy: { effectiveDate: string; terminationDate: string },
  dateOfService: string,
): boolean {
  // ISO yyyy-mm-dd compares correctly as a string.
  return dateOfService >= policy.effectiveDate && dateOfService <= policy.terminationDate;
}

/** b. Coverage — a category is covered iff a rule exists for it and it is covered. */
export function isCovered(rule: CoverageRule | undefined): rule is CoveredRule {
  return rule !== undefined && rule.covered;
}

/** c. Exclusion — an explicit policy-level carve-out hard-denies even a covered category. */
export function isExcluded(serviceCategory: string, exclusions: readonly string[]): boolean {
  return exclusions.includes(serviceCategory);
}

/** d. Review — a covered rule with a review_threshold pends when billed exceeds the threshold. */
export function needsReview(rule: CoveredRule, billedMinor: number): boolean {
  return rule.reviewThresholdMinor !== undefined && billedMinor > rule.reviewThresholdMinor;
}

/** e. Limit — cap allowed by per-incident max, then by the remaining annual limit. */
export interface LimitResult {
  allowedMinor: number;
  perIncidentMaxApplied: boolean;
  /** The annual limit capped allowed below the pre-limit amount (partial). */
  annualLimitApplied: boolean;
  /** The annual limit was fully exhausted (remaining 0 ⇒ allowed forced to 0 ⇒ hard deny). */
  annualLimitReached: boolean;
}

export function applyLimit(
  billedMinor: number,
  rule: CoveredRule,
  annualLimitConsumedMinor: number,
): LimitResult {
  let allowed = Money.of(billedMinor);

  let perIncidentMaxApplied = false;
  if (rule.perIncidentMaxMinor !== undefined) {
    const cap = Money.of(rule.perIncidentMaxMinor);
    perIncidentMaxApplied = cap.amountMinor < allowed.amountMinor;
    allowed = allowed.min(cap);
  }

  let annualLimitApplied = false;
  let annualLimitReached = false;
  if (rule.annualLimitMinor !== undefined) {
    const remaining = Money.of(rule.annualLimitMinor).sub(Money.of(annualLimitConsumedMinor)).clampToZero();
    const preLimit = allowed.amountMinor;
    allowed = allowed.min(remaining);
    if (remaining.amountMinor === 0) {
      annualLimitReached = true;
    } else if (allowed.amountMinor < preLimit) {
      annualLimitApplied = true;
    }
  }

  return { allowedMinor: allowed.amountMinor, perIncidentMaxApplied, annualLimitApplied, annualLimitReached };
}

/** f. Deductible — the member pays up to the remaining annual deductible first. */
export interface DeductibleResult {
  deductibleAppliedMinor: number;
  afterDeductibleMinor: number;
}

export function applyDeductible(
  allowedMinor: number,
  annualDeductibleMinor: number,
  deductibleConsumedMinor: number,
): DeductibleResult {
  const allowed = Money.of(allowedMinor);
  const remaining = Money.of(annualDeductibleMinor).sub(Money.of(deductibleConsumedMinor)).clampToZero();
  const deductibleApplied = allowed.min(remaining);
  const afterDeductible = allowed.sub(deductibleApplied);
  return {
    deductibleAppliedMinor: deductibleApplied.amountMinor,
    afterDeductibleMinor: afterDeductible.amountMinor,
  };
}

/** g. Cost share — coinsurance (banker's rounded) + copay reduce the post-deductible amount. */
export interface CostShareResult {
  coinsuranceMinor: number;
  copayMinor: number;
  payableMinor: number;
}

export function applyCostShare(afterDeductibleMinor: number, rule: CoveredRule): CostShareResult {
  const afterDeductible = Money.of(afterDeductibleMinor);
  const coinsurance = afterDeductible.percentOf(rule.coinsuranceRate);
  const copay = Money.of(rule.copayMinor ?? 0);
  const payable = afterDeductible.sub(coinsurance).sub(copay).clampToZero();
  return {
    coinsuranceMinor: coinsurance.amountMinor,
    copayMinor: copay.amountMinor,
    payableMinor: payable.amountMinor,
  };
}
