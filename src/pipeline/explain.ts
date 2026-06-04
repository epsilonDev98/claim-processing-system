/**
 * Explanation rendering (domain-model §8, acceptance §0.3).
 *
 * Derives the member-facing `Explanation` from reason codes + the catalog + the breakdown. The
 * engine only FILLS catalog templates — it never invents reason text. Explanations are derived
 * on read, never persisted.
 */

import { ReasonCode } from '../domain/codes';
import type { CalculationBreakdown, Explanation } from '../domain/value-objects';
import { getExplanationCode } from '../config/explanation-catalog';

/** Values available to fill catalog templates for one adjudicated line. */
export interface ExplanationContext {
  serviceCategory: string;
  dateOfService: string;
  billedMinor: number;
  allowedMinor: number;
  deductibleAppliedMinor: number;
  coinsuranceMinor: number;
  copayMinor: number;
  annualLimitMinor?: number;
  reviewThresholdMinor?: number;
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function money(minor: number): string {
  return USD.format(minor / 100);
}

/**
 * Build the explanation: short message from the primary (first) reason code, detail from every
 * reason code's filled template, plus the calculation breakdown passed through.
 */
export function explain(
  reasonCodes: readonly ReasonCode[],
  breakdown: CalculationBreakdown,
  context: ExplanationContext,
): Explanation {
  const [primary] = reasonCodes;
  if (primary === undefined) {
    throw new Error('explain requires at least one reason code');
  }

  const detail = reasonCodes
    .map((code) => fillTemplate(getExplanationCode(code).detailTemplate, code, context))
    .join(' ');

  return {
    shortMessage: getExplanationCode(primary).shortMessage,
    detail,
    breakdown,
  };
}

function fillTemplate(template: string, code: ReasonCode, ctx: ExplanationContext): string {
  // {amount} resolves to the figure the reason code is about.
  const amountMinor =
    code === ReasonCode.DEDUCTIBLE_APPLIED
      ? ctx.deductibleAppliedMinor
      : code === ReasonCode.COINSURANCE_APPLIED
        ? ctx.coinsuranceMinor
        : code === ReasonCode.COPAY_APPLIED
          ? ctx.copayMinor
          : 0;

  return template
    .replace('{category}', ctx.serviceCategory)
    .replace('{dos}', ctx.dateOfService)
    .replace('{billed}', money(ctx.billedMinor))
    .replace('{allowed}', money(ctx.allowedMinor))
    .replace('{amount}', money(amountMinor))
    .replace('{limit}', ctx.annualLimitMinor !== undefined ? money(ctx.annualLimitMinor) : '')
    .replace('{threshold}', ctx.reviewThresholdMinor !== undefined ? money(ctx.reviewThresholdMinor) : '');
}
