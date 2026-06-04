/**
 * Explanation catalog (domain-model §8, acceptance §0.3 + S14).
 *
 * Static catalog mapping each ReasonCode to member-facing templates. The pipeline only FILLS
 * these templates — it never invents reason text.
 *
 * The catalog is typed `Record<ReasonCode, ExplanationCode>`, so the closed reason-code set is
 * covered **by construction**: adding a ReasonCode without a row here is a compile error. The
 * runtime `assertCatalogComplete` is the boot-time guard (S14) — it fails startup, not mid-claim.
 *
 * Note: §0.3 tabulates 10 codes; the closed `ReasonCode` enum also includes
 * PER_INCIDENT_MAX_APPLIED (a per-incident cap not exercised by the §0.2 fixtures). Its row is
 * included here so the entire closed set is explainable.
 */

import { ALL_REASON_CODES, ReasonCode } from '../domain/codes';
import type { ExplanationCode } from '../domain/entities';

export const EXPLANATION_CATALOG: Readonly<Record<ReasonCode, ExplanationCode>> = {
  [ReasonCode.COVERED]: {
    code: ReasonCode.COVERED,
    category: 'approval',
    shortMessage: 'Service fully covered.',
    detailTemplate: 'This service is covered in full under your {category} benefit.',
  },
  [ReasonCode.NOT_COVERED]: {
    code: ReasonCode.NOT_COVERED,
    category: 'denial',
    shortMessage: 'Service not covered.',
    detailTemplate: '{category} is not covered under your policy.',
  },
  [ReasonCode.EXCLUDED_SERVICE]: {
    code: ReasonCode.EXCLUDED_SERVICE,
    category: 'denial',
    shortMessage: 'Service excluded.',
    detailTemplate: 'This service is explicitly excluded from your policy.',
  },
  [ReasonCode.POLICY_INACTIVE]: {
    code: ReasonCode.POLICY_INACTIVE,
    category: 'denial',
    shortMessage: 'Policy not active.',
    detailTemplate: 'Your policy was not active on the date of service {dos}.',
  },
  [ReasonCode.DEDUCTIBLE_APPLIED]: {
    code: ReasonCode.DEDUCTIBLE_APPLIED,
    category: 'cost-share',
    shortMessage: 'Deductible applied.',
    detailTemplate: '{amount} was applied toward your annual deductible.',
  },
  [ReasonCode.ANNUAL_LIMIT_APPLIED]: {
    code: ReasonCode.ANNUAL_LIMIT_APPLIED,
    category: 'cost-share',
    shortMessage: 'Annual limit applied.',
    detailTemplate: 'Your {category} annual limit capped the covered amount at {allowed}.',
  },
  [ReasonCode.ANNUAL_LIMIT_REACHED]: {
    code: ReasonCode.ANNUAL_LIMIT_REACHED,
    category: 'denial',
    shortMessage: 'Annual limit reached.',
    detailTemplate:
      'You have reached your {category} annual limit of {limit}; nothing further is payable.',
  },
  [ReasonCode.COINSURANCE_APPLIED]: {
    code: ReasonCode.COINSURANCE_APPLIED,
    category: 'cost-share',
    shortMessage: 'Coinsurance applied.',
    detailTemplate: 'Coinsurance of {amount} is your responsibility.',
  },
  [ReasonCode.COPAY_APPLIED]: {
    code: ReasonCode.COPAY_APPLIED,
    category: 'cost-share',
    shortMessage: 'Copay applied.',
    detailTemplate: 'A {amount} copay applies to this service.',
  },
  [ReasonCode.PENDED_FOR_REVIEW]: {
    code: ReasonCode.PENDED_FOR_REVIEW,
    category: 'pend',
    shortMessage: 'Needs manual review.',
    detailTemplate: 'This line needs manual review (billed {billed} exceeds {threshold}).',
  },
  [ReasonCode.PER_INCIDENT_MAX_APPLIED]: {
    code: ReasonCode.PER_INCIDENT_MAX_APPLIED,
    category: 'cost-share',
    shortMessage: 'Per-incident maximum applied.',
    detailTemplate: 'Your per-incident maximum capped the covered amount at {allowed}.',
  },
};

/** Thrown at startup if a reason code cannot be explained (S14: fail at boot, not mid-claim). */
export class CatalogIncompleteError extends Error {
  constructor(public readonly missing: readonly string[]) {
    super(`Explanation catalog is missing entries for: ${missing.join(', ')}`);
    this.name = 'CatalogIncompleteError';
  }
}

/**
 * Assert every given reason code resolves to a catalog row. Defaults to the entire closed
 * `ReasonCode` set against the static catalog — the boot-time completeness invariant.
 */
export function assertCatalogComplete(
  reasonCodes: readonly ReasonCode[] = ALL_REASON_CODES,
  catalog: Readonly<Record<string, ExplanationCode>> = EXPLANATION_CATALOG,
): void {
  const missing = reasonCodes.filter((code) => catalog[code] === undefined);
  if (missing.length > 0) {
    throw new CatalogIncompleteError(missing);
  }
}

/** Resolve a reason code to its catalog entry; throws if (somehow) absent. */
export function getExplanationCode(code: ReasonCode): ExplanationCode {
  const entry = EXPLANATION_CATALOG[code];
  if (entry === undefined) {
    throw new CatalogIncompleteError([code]);
  }
  return entry;
}
