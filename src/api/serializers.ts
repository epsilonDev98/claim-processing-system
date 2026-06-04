/**
 * Domain → DTO serializers (implementation-plan §10). DTOs are PHI-minimizing: the member name and
 * line diagnosis code are never serialized. Explanations are derived here (never persisted).
 */

import type {
  Adjudication,
  Claim,
  ClaimLine,
  CoverageRule,
  Dispute,
  Policy,
  UsageLedgerEntry,
} from '../domain/entities';
import type { Explanation } from '../domain/value-objects';
import { explain, type ExplanationContext } from '../pipeline/explain';

export interface AdjudicationView {
  sequence: number;
  isCurrent: boolean;
  decisionCode: string;
  reasonCodes: string[];
  allowedMinor: number;
  deductibleAppliedMinor: number;
  coinsuranceMinor: number;
  copayMinor: number;
  payableMinor: number;
  memberRespMinor: number;
  adjudicatedAt: string;
}

export interface LineView {
  lineId: string;
  serviceCode: string;
  serviceCategory: string;
  billedMinor: number;
  units: number;
  state: string;
  adjudication: AdjudicationView | null;
  explanation: Explanation | null;
}

export interface ClaimView {
  claimId: string;
  memberId: string;
  policyId: string;
  provider: string;
  dateOfService: string;
  state: string;
  isDisputed: boolean;
  lines: LineView[];
}

export interface LedgerView {
  memberId: string;
  period: number;
  balances: Record<string, number>;
  entries: Array<{
    entryId: string;
    bucket: string;
    amountOrCount: number;
    sourceLineId: string;
    createdAt: string;
  }>;
}

export interface DisputeView {
  disputeId: string;
  claimId: string;
  lineIds: string[];
  reason: string;
  state: string;
  resolutionOutcome?: string;
  resolutionNote?: string;
  openedAt: string;
  resolvedAt?: string;
  adjudicationHistory: Record<string, AdjudicationView[]>;
}

export function serializeAdjudication(adjudication: Adjudication): AdjudicationView {
  return {
    sequence: adjudication.sequence,
    isCurrent: adjudication.isCurrent,
    decisionCode: adjudication.decisionCode,
    reasonCodes: [...adjudication.reasonCodes],
    allowedMinor: adjudication.allowedMinor,
    deductibleAppliedMinor: adjudication.deductibleAppliedMinor,
    coinsuranceMinor: adjudication.coinsuranceMinor,
    copayMinor: adjudication.copayMinor,
    payableMinor: adjudication.payableMinor,
    memberRespMinor: adjudication.memberRespMinor,
    adjudicatedAt: adjudication.adjudicatedAt,
  };
}

export function serializeClaimView(params: {
  claim: Claim;
  lines: ClaimLine[];
  currentByLine: Map<string, Adjudication | null>;
  rulesByCategory: Map<string, CoverageRule>;
  isDisputed: boolean;
}): ClaimView {
  const { claim } = params;
  return {
    claimId: claim.claimId,
    memberId: claim.memberId,
    policyId: claim.policyId,
    provider: claim.provider,
    dateOfService: claim.dateOfService,
    state: claim.state,
    isDisputed: params.isDisputed,
    lines: params.lines.map((line) => {
      const adjudication = params.currentByLine.get(line.lineId) ?? null;
      const rule = params.rulesByCategory.get(line.serviceCategory);
      return {
        lineId: line.lineId,
        serviceCode: line.serviceCode,
        serviceCategory: line.serviceCategory,
        billedMinor: line.billedMinor,
        units: line.units,
        state: line.state,
        adjudication: adjudication ? serializeAdjudication(adjudication) : null,
        explanation: adjudication ? buildExplanation(claim, line, adjudication, rule) : null,
      };
    }),
  };
}

export function serializeLedgerView(
  memberId: string,
  period: number,
  balances: Map<string, number>,
  entries: UsageLedgerEntry[],
): LedgerView {
  return {
    memberId,
    period,
    balances: Object.fromEntries(balances),
    entries: entries.map((entry) => ({
      entryId: entry.entryId,
      bucket: entry.bucket,
      amountOrCount: entry.amountOrCount,
      sourceLineId: entry.sourceLineId,
      createdAt: entry.createdAt,
    })),
  };
}

export function serializeDisputeView(
  dispute: Dispute,
  historyByLine: Map<string, Adjudication[]>,
): DisputeView {
  const adjudicationHistory: Record<string, AdjudicationView[]> = {};
  for (const [lineId, history] of historyByLine) {
    adjudicationHistory[lineId] = history.map(serializeAdjudication);
  }
  const view: DisputeView = {
    disputeId: dispute.disputeId,
    claimId: dispute.claimId,
    lineIds: [...dispute.lineIds],
    reason: dispute.reason,
    state: dispute.state,
    openedAt: dispute.openedAt,
    adjudicationHistory,
  };
  if (dispute.resolutionOutcome !== undefined) view.resolutionOutcome = dispute.resolutionOutcome;
  if (dispute.resolutionNote !== undefined) view.resolutionNote = dispute.resolutionNote;
  if (dispute.resolvedAt !== undefined) view.resolvedAt = dispute.resolvedAt;
  return view;
}

export function serializePolicyView(policy: Policy, rules: CoverageRule[], exclusions: string[]) {
  return {
    policyId: policy.policyId,
    memberId: policy.memberId,
    effectiveDate: policy.effectiveDate,
    terminationDate: policy.terminationDate,
    planYear: policy.planYear,
    annualDeductibleMinor: policy.annualDeductibleMinor,
    exclusions,
    coverage: rules,
  };
}

function buildExplanation(
  claim: Claim,
  line: ClaimLine,
  adjudication: Adjudication,
  rule: CoverageRule | undefined,
): Explanation {
  const breakdown = [
    { label: 'Billed', amountMinor: line.billedMinor },
    { label: 'Allowed', amountMinor: adjudication.allowedMinor },
    { label: 'Deductible applied', amountMinor: adjudication.deductibleAppliedMinor },
    { label: 'After deductible', amountMinor: adjudication.allowedMinor - adjudication.deductibleAppliedMinor },
    { label: 'Coinsurance', amountMinor: adjudication.coinsuranceMinor },
    { label: 'Copay', amountMinor: adjudication.copayMinor },
    { label: 'Payable', amountMinor: adjudication.payableMinor },
  ];
  const context: ExplanationContext = {
    serviceCategory: line.serviceCategory,
    dateOfService: claim.dateOfService,
    billedMinor: line.billedMinor,
    allowedMinor: adjudication.allowedMinor,
    deductibleAppliedMinor: adjudication.deductibleAppliedMinor,
    coinsuranceMinor: adjudication.coinsuranceMinor,
    copayMinor: adjudication.copayMinor,
  };
  if (rule?.covered && rule.annualLimitMinor !== undefined) context.annualLimitMinor = rule.annualLimitMinor;
  if (rule?.covered && rule.reviewThresholdMinor !== undefined) context.reviewThresholdMinor = rule.reviewThresholdMinor;
  return explain(adjudication.reasonCodes, breakdown, context);
}
