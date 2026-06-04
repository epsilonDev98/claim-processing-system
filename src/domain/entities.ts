/**
 * Domain entities (domain-model §2.1, implementation-plan §3) — TypeScript interfaces that
 * mirror the persistence schema 1:1. No fields beyond the model; no behaviour (pure types).
 *
 * Money is carried as integer minor-unit `number` fields (`*Minor`); the `Money` value object
 * is used by the pipeline for arithmetic, not for storage. CoverageRule carries no explanation
 * metadata and no surrogate id — `serviceCategory` is its natural key.
 */

import type { DecisionCode, ReasonCode } from './codes';
import type { ClaimState, DisputeOutcome, DisputeState, LineState } from './states';

/** Covered person; owns accumulators. `name` is PHI. */
export interface Member {
  memberId: string;
  name: string;
  dob: string;
}

/** The contract: promises + active period + annual deductible. */
export interface Policy {
  policyId: string;
  memberId: string;
  effectiveDate: string;
  terminationDate: string;
  planYear: number;
  annualDeductibleMinor: number;
}

/**
 * One coverage promise for a service category. Authored as JSON, validated into this struct.
 * `serviceCategory` is the natural key. A present `reviewThresholdMinor` is the "pend above
 * this amount" term; absent ⇒ never pends.
 */
export interface CoverageRule {
  serviceCategory: string;
  covered: boolean;
  annualLimitMinor?: number;
  visitLimit?: number;
  perIncidentMaxMinor?: number;
  coinsuranceRate: number;
  copayMinor?: number;
  reviewThresholdMinor?: number;
}

/** The submitted request envelope. `state` is a derived cache (see §6 / deriveClaimState). */
export interface Claim {
  claimId: string;
  memberId: string;
  policyId: string;
  provider: string;
  dateOfService: string;
  submittedAt: string;
  state: ClaimState;
}

/** One billed service — the atomic adjudication unit. `diagnosisCode` is PHI. */
export interface ClaimLine {
  lineId: string;
  claimId: string;
  serviceCode: string;
  serviceCategory: string;
  diagnosisCode: string;
  billedMinor: number;
  units: number;
  state: LineState;
}

/**
 * Append-only decision record for a line. Each (re-)adjudication appends one record with the
 * next `sequence`; exactly one record per line has `isCurrent = true`. One `decisionCode`,
 * one-or-more `reasonCodes`.
 */
export interface Adjudication {
  adjudicationId: string;
  lineId: string;
  sequence: number;
  isCurrent: boolean;
  decisionCode: DecisionCode;
  reasonCodes: ReasonCode[];
  allowedMinor: number;
  deductibleAppliedMinor: number;
  coinsuranceMinor: number;
  copayMinor: number;
  payableMinor: number;
  memberRespMinor: number;
  adjudicatedAt: string;
}

/**
 * Append-only consumed-usage record. `amountOrCount` is signed (compensating entries are
 * negative). Keyed to `sourceLineId`; balances are computed by summing entries per bucket.
 */
export interface UsageLedgerEntry {
  entryId: string;
  memberId: string;
  policyId: string;
  period: number;
  bucket: string;
  amountOrCount: number;
  sourceLineId: string;
  createdAt: string;
}

/** Member's challenge + its lifecycle/outcome. Targets one or more lines. */
export interface Dispute {
  disputeId: string;
  claimId: string;
  lineIds: string[];
  reason: string;
  state: DisputeState;
  resolutionOutcome?: DisputeOutcome;
  resolutionNote?: string;
  openedAt: string;
  resolvedAt?: string;
}

/** Reference catalog row: a reason code → member-facing templates. */
export interface ExplanationCode {
  code: string;
  shortMessage: string;
  detailTemplate: string;
  category: string;
}
