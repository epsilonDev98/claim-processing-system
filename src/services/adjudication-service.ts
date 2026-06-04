/**
 * Adjudication service (implementation-plan §7).
 *
 * Orchestrates a whole claim through the pure pipeline and persists the results + derived state.
 * It never re-decides: it appends the pipeline's outcome as a new (current) Adjudication, applies
 * the line-state transition guard, writes the ledger on approve/partial while threading running
 * balances so later lines in the same claim see consumption, then derives the claim state.
 *
 * Payment is separate: only payable lines transition to PAID, and only when no line still needs
 * review.
 */

import { randomUUID } from 'node:crypto';
import { DecisionCode, type ReasonCode } from '../domain/codes';
import type { Adjudication, ClaimLine, CoverageRule } from '../domain/entities';
import { ClaimState, LineState, assertLineTransition } from '../domain/states';
import {
  DEDUCTIBLE_BUCKET,
  adjudicateLine,
  annualLimitBucket,
} from '../pipeline/adjudicate-line';
import { deriveClaimState } from '../pipeline/derive-claim-state';
import type {
  AdjudicationRepository,
  ClaimRepository,
  PolicyRepository,
} from '../repositories/interfaces';
import { NotFoundError, NotPayableError } from './errors';
import type { LedgerService } from './ledger-service';

export interface LineDecision {
  lineId: string;
  serviceCategory: string;
  decisionCode: DecisionCode;
  reasonCodes: ReasonCode[];
  lineState: LineState;
  allowedMinor: number;
  deductibleAppliedMinor: number;
  coinsuranceMinor: number;
  copayMinor: number;
  payableMinor: number;
  memberRespMinor: number;
}

export interface AdjudicationSummary {
  claimId: string;
  claimState: ClaimState;
  lines: LineDecision[];
}

export class AdjudicationService {
  constructor(
    private readonly claims: ClaimRepository,
    private readonly policies: PolicyRepository,
    private readonly adjudications: AdjudicationRepository,
    private readonly ledger: LedgerService,
  ) {}

  async adjudicateClaim(claimId: string): Promise<AdjudicationSummary> {
    const loaded = await this.claims.getWithLines(claimId);
    if (!loaded) {
      throw new NotFoundError(`Claim ${claimId} not found`);
    }
    const { claim, lines } = loaded;

    const policy = await this.policies.getById(claim.policyId);
    if (!policy) {
      throw new NotFoundError(`Policy ${claim.policyId} not found`);
    }
    const rules = await this.policies.getRulesForPolicy(claim.policyId);
    const exclusions = await this.policies.getExclusionsForPolicy(claim.policyId);
    const rulesByCategory = new Map<string, CoverageRule>(rules.map((r) => [r.serviceCategory, r]));
    const period = policy.planYear;

    // Running balances for the member/period — mutated as lines consume so later lines in the
    // same claim see the consumption (this is what makes S7-L4 cap against the running limit).
    // Loaded from the persisted ledger, so already-consumed lines are reflected (and never
    // re-consumed) on a re-run.
    const balances = await this.ledger.balances(claim.memberId, period);

    // Normal adjudication processes ONLY lines awaiting adjudication, which makes it idempotent and
    // resumable: re-running appends no duplicate adjudication and double-consumes no ledger.
    // Re-adjudicating an already-decided line is the separate dispute flow (compensating entries).
    // Move the claim to UNDER_REVIEW only when there is actually work to do.
    const hasWork = lines.some((line) => line.state === LineState.AWAITING_ADJUDICATION);
    if (hasWork) {
      await this.claims.saveClaimState(claimId, ClaimState.UNDER_REVIEW);
    }

    const lineStates: LineState[] = [];
    const decisions: LineDecision[] = [];

    for (const line of lines) {
      if (line.state !== LineState.AWAITING_ADJUDICATION) {
        // Already adjudicated: preserve its current adjudication + ledger consumption untouched.
        lineStates.push(line.state);
        decisions.push(await this.decisionForLine(line, line.state));
        continue;
      }

      const outcome = adjudicateLine({
        billedMinor: line.billedMinor,
        serviceCategory: line.serviceCategory,
        dateOfService: claim.dateOfService,
        policy: {
          effectiveDate: policy.effectiveDate,
          terminationDate: policy.terminationDate,
          annualDeductibleMinor: policy.annualDeductibleMinor,
        },
        rule: rulesByCategory.get(line.serviceCategory),
        exclusions,
        deductibleConsumedMinor: balances.get(DEDUCTIBLE_BUCKET) ?? 0,
        annualLimitConsumedMinor: balances.get(annualLimitBucket(line.serviceCategory)) ?? 0,
      });

      // Guard the transition BEFORE persisting anything: the append-only adjudication history must
      // never contain a record for a transition we then reject. A rejected transition leaves no
      // adjudication appended and no line-state change.
      assertLineTransition(line.state, outcome.lineState);

      // Append-only: next sequence for the line, this record current.
      const history = await this.adjudications.historyForLine(line.lineId);
      const nextSequence = history.reduce((max, a) => Math.max(max, a.sequence), 0) + 1;
      const adjudication: Adjudication = {
        adjudicationId: randomUUID(),
        lineId: line.lineId,
        sequence: nextSequence,
        isCurrent: true,
        decisionCode: outcome.decisionCode,
        reasonCodes: outcome.reasonCodes,
        allowedMinor: outcome.allowedMinor,
        deductibleAppliedMinor: outcome.deductibleAppliedMinor,
        coinsuranceMinor: outcome.coinsuranceMinor,
        copayMinor: outcome.copayMinor,
        payableMinor: outcome.payableMinor,
        memberRespMinor: outcome.memberRespMinor,
        adjudicatedAt: new Date().toISOString(),
      };
      await this.adjudications.appendForLine(adjudication);
      await this.claims.saveLineState(line.lineId, outcome.lineState);

      // Ledger writes only on approve/partial; update running balances for subsequent lines.
      if (
        outcome.decisionCode === DecisionCode.APPROVED ||
        outcome.decisionCode === DecisionCode.PARTIALLY_APPROVED
      ) {
        await this.ledger.consume({
          memberId: claim.memberId,
          policyId: claim.policyId,
          period,
          sourceLineId: line.lineId,
          deltas: outcome.ledgerDeltas,
        });
        for (const delta of outcome.ledgerDeltas) {
          balances.set(delta.bucket, (balances.get(delta.bucket) ?? 0) + delta.amountMinor);
        }
      }

      lineStates.push(outcome.lineState);
      decisions.push({
        lineId: line.lineId,
        serviceCategory: line.serviceCategory,
        decisionCode: outcome.decisionCode,
        reasonCodes: outcome.reasonCodes,
        lineState: outcome.lineState,
        allowedMinor: outcome.allowedMinor,
        deductibleAppliedMinor: outcome.deductibleAppliedMinor,
        coinsuranceMinor: outcome.coinsuranceMinor,
        copayMinor: outcome.copayMinor,
        payableMinor: outcome.payableMinor,
        memberRespMinor: outcome.memberRespMinor,
      });
    }

    const claimState = deriveClaimState(lineStates);
    await this.claims.saveClaimState(claimId, claimState);

    return { claimId, claimState, lines: decisions };
  }

  /**
   * Re-adjudicate specific (already-decided) lines — the dispute flow's entry point (§8). Unlike
   * normal adjudication this DOES reprocess decided lines: it appends a new adjudication for each,
   * reconciles the ledger with SIGNED compensating entries (never double-consuming), and re-derives
   * the claim state. The claim re-enters UNDER_REVIEW for the re-adjudication. No new pipeline logic.
   */
  async reAdjudicateLines(claimId: string, lineIds: readonly string[]): Promise<AdjudicationSummary> {
    const loaded = await this.claims.getWithLines(claimId);
    if (!loaded) {
      throw new NotFoundError(`Claim ${claimId} not found`);
    }
    const { claim, lines } = loaded;

    const policy = await this.policies.getById(claim.policyId);
    if (!policy) {
      throw new NotFoundError(`Policy ${claim.policyId} not found`);
    }
    const rules = await this.policies.getRulesForPolicy(claim.policyId);
    const exclusions = await this.policies.getExclusionsForPolicy(claim.policyId);
    const rulesByCategory = new Map<string, CoverageRule>(rules.map((r) => [r.serviceCategory, r]));
    const period = policy.planYear;
    const targeted = new Set(lineIds);

    await this.claims.saveClaimState(claimId, ClaimState.UNDER_REVIEW);

    // Running totals from the persisted ledger, adjusted per re-adjudicated line.
    const balances = await this.ledger.balances(claim.memberId, period);

    const lineStates: LineState[] = [];
    const decisions: LineDecision[] = [];

    for (const line of lines) {
      if (!targeted.has(line.lineId)) {
        lineStates.push(line.state);
        decisions.push(await this.decisionForLine(line, line.state));
        continue;
      }

      // Re-adjudicate against balances EXCLUDING this line's own prior consumption, so the line's
      // earlier usage is not double-counted against its own (recomputed) limit/deductible.
      const priorForLine = await this.ledger.consumedByLine(claim.memberId, period, line.lineId);
      const limitBucket = annualLimitBucket(line.serviceCategory);
      const outcome = adjudicateLine({
        billedMinor: line.billedMinor,
        serviceCategory: line.serviceCategory,
        dateOfService: claim.dateOfService,
        policy: {
          effectiveDate: policy.effectiveDate,
          terminationDate: policy.terminationDate,
          annualDeductibleMinor: policy.annualDeductibleMinor,
        },
        rule: rulesByCategory.get(line.serviceCategory),
        exclusions,
        deductibleConsumedMinor: (balances.get(DEDUCTIBLE_BUCKET) ?? 0) - (priorForLine.get(DEDUCTIBLE_BUCKET) ?? 0),
        annualLimitConsumedMinor: (balances.get(limitBucket) ?? 0) - (priorForLine.get(limitBucket) ?? 0),
      });

      // Guard only a real state change — a re-adjudication that reproduces the same line state
      // (e.g. S8 upheld DENIED→DENIED) is not a transition, just a new appended record.
      if (line.state !== outcome.lineState) {
        assertLineTransition(line.state, outcome.lineState);
      }

      const history = await this.adjudications.historyForLine(line.lineId);
      const nextSequence = history.reduce((max, a) => Math.max(max, a.sequence), 0) + 1;
      await this.adjudications.appendForLine({
        adjudicationId: randomUUID(),
        lineId: line.lineId,
        sequence: nextSequence,
        isCurrent: true,
        decisionCode: outcome.decisionCode,
        reasonCodes: outcome.reasonCodes,
        allowedMinor: outcome.allowedMinor,
        deductibleAppliedMinor: outcome.deductibleAppliedMinor,
        coinsuranceMinor: outcome.coinsuranceMinor,
        copayMinor: outcome.copayMinor,
        payableMinor: outcome.payableMinor,
        memberRespMinor: outcome.memberRespMinor,
        adjudicatedAt: new Date().toISOString(),
      });
      await this.claims.saveLineState(line.lineId, outcome.lineState);

      // Reconcile the ledger with signed compensating entries (positive newly-due, negative
      // reversal). For a re-adjudication that consumes nothing new (S8), this posts nothing.
      await this.ledger.reconcileLine({
        memberId: claim.memberId,
        policyId: claim.policyId,
        period,
        sourceLineId: line.lineId,
        target: outcome.ledgerDeltas,
      });

      // Update running totals: replace this line's prior contribution with its new consumption.
      for (const [bucket, amount] of priorForLine) {
        balances.set(bucket, (balances.get(bucket) ?? 0) - amount);
      }
      for (const delta of outcome.ledgerDeltas) {
        balances.set(delta.bucket, (balances.get(delta.bucket) ?? 0) + delta.amountMinor);
      }

      lineStates.push(outcome.lineState);
      decisions.push({
        lineId: line.lineId,
        serviceCategory: line.serviceCategory,
        decisionCode: outcome.decisionCode,
        reasonCodes: outcome.reasonCodes,
        lineState: outcome.lineState,
        allowedMinor: outcome.allowedMinor,
        deductibleAppliedMinor: outcome.deductibleAppliedMinor,
        coinsuranceMinor: outcome.coinsuranceMinor,
        copayMinor: outcome.copayMinor,
        payableMinor: outcome.payableMinor,
        memberRespMinor: outcome.memberRespMinor,
      });
    }

    const claimState = deriveClaimState(lineStates);
    await this.claims.saveClaimState(claimId, claimState);

    return { claimId, claimState, lines: decisions };
  }

  /** Pay payable lines → PAID. Blocked while any line still needs review or is unadjudicated. */
  async payClaim(claimId: string): Promise<AdjudicationSummary> {
    const loaded = await this.claims.getWithLines(claimId);
    if (!loaded) {
      throw new NotFoundError(`Claim ${claimId} not found`);
    }
    const { lines } = loaded;

    if (lines.some((l) => l.state === LineState.AWAITING_ADJUDICATION)) {
      throw new NotPayableError(`Claim ${claimId} has not been adjudicated`);
    }
    if (lines.some((l) => l.state === LineState.NEEDS_REVIEW)) {
      throw new NotPayableError(`Claim ${claimId} has lines needing review`);
    }

    const lineStates: LineState[] = [];
    const decisions: LineDecision[] = [];

    for (const line of lines) {
      let nextState = line.state;
      if (line.state === LineState.APPROVED || line.state === LineState.PARTIALLY_APPROVED) {
        assertLineTransition(line.state, LineState.PAID);
        await this.claims.saveLineState(line.lineId, LineState.PAID);
        nextState = LineState.PAID;
      }
      lineStates.push(nextState);
      decisions.push(await this.decisionForLine(line, nextState));
    }

    const claimState = deriveClaimState(lineStates);
    await this.claims.saveClaimState(claimId, claimState);

    return { claimId, claimState, lines: decisions };
  }

  /** Summary entry for a line that is not (re-)adjudicated here, from its current adjudication. */
  private async decisionForLine(line: ClaimLine, lineState: LineState): Promise<LineDecision> {
    const current = await this.adjudications.currentForLine(line.lineId);
    return {
      lineId: line.lineId,
      serviceCategory: line.serviceCategory,
      decisionCode: current?.decisionCode ?? DecisionCode.DENIED,
      reasonCodes: current?.reasonCodes ?? [],
      lineState,
      allowedMinor: current?.allowedMinor ?? 0,
      deductibleAppliedMinor: current?.deductibleAppliedMinor ?? 0,
      coinsuranceMinor: current?.coinsuranceMinor ?? 0,
      copayMinor: current?.copayMinor ?? 0,
      payableMinor: current?.payableMinor ?? 0,
      memberRespMinor: current?.memberRespMinor ?? 0,
    };
  }
}
