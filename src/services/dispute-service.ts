/**
 * Dispute service (implementation-plan §8, domain §7, acceptance S8/S9).
 *
 * Lifecycle: openDispute → startReview → resolve(outcome, note, corrections?). Resolution
 * re-enters the EXISTING adjudication pipeline (via AdjudicationService.reAdjudicateLines) — no new
 * decision logic. A correction is the only sanctioned post-decision edit of a line input, and it is
 * gated by an open dispute. "Is this claim disputed?" is never stored — it is derived from an open
 * Dispute (findOpenByClaim), so this service stores no DISPUTED flag on the claim or line.
 */

import { randomUUID } from 'node:crypto';
import type { Dispute } from '../domain/entities';
import { DisputeOutcome, DisputeState, assertDisputeTransition } from '../domain/states';
import type { ClaimRepository, DisputeRepository, LineCorrection } from '../repositories/interfaces';
import type { AdjudicationService, AdjudicationSummary } from './adjudication-service';
import { NotFoundError, ValidationError } from './errors';

export interface OpenDisputeInput {
  disputeId?: string;
  claimId: string;
  lineIds: string[];
  reason: string;
}

export interface ResolveDisputeInput {
  outcome: DisputeOutcome;
  note: string;
  /** Sanctioned line-input corrections, keyed by lineId (e.g. S9's mis-categorized line). */
  corrections?: Record<string, LineCorrection>;
}

export class DisputeService {
  constructor(
    private readonly disputes: DisputeRepository,
    private readonly claims: ClaimRepository,
    private readonly adjudication: AdjudicationService,
  ) {}

  /** Open a dispute against one or more lines of a claim. No claim/line state changes here. */
  async openDispute(input: OpenDisputeInput): Promise<Dispute> {
    if (input.lineIds.length === 0) {
      throw new ValidationError('A dispute must target at least one line');
    }
    if (input.reason.trim() === '') {
      throw new ValidationError('reason is required');
    }

    const loaded = await this.claims.getWithLines(input.claimId);
    if (!loaded) {
      throw new NotFoundError(`Claim ${input.claimId} not found`);
    }
    const claimLineIds = new Set(loaded.lines.map((line) => line.lineId));
    const targeted = new Set<string>();
    for (const lineId of input.lineIds) {
      if (!claimLineIds.has(lineId)) {
        throw new ValidationError(`Line ${lineId} is not part of claim ${input.claimId}`);
      }
      if (targeted.has(lineId)) {
        throw new ValidationError(`Duplicate dispute line: ${lineId}`);
      }
      targeted.add(lineId);
    }
    if (await this.disputes.findOpenByClaim(input.claimId)) {
      throw new ValidationError(`Claim ${input.claimId} already has an open dispute`);
    }

    const dispute: Dispute = {
      disputeId: input.disputeId ?? randomUUID(),
      claimId: input.claimId,
      lineIds: [...input.lineIds],
      reason: input.reason,
      state: DisputeState.OPEN,
      openedAt: new Date().toISOString(),
    };
    return this.disputes.create(dispute);
  }

  /** OPEN → UNDER_REVIEW. */
  async startReview(disputeId: string): Promise<Dispute> {
    const dispute = await this.requireDispute(disputeId);
    assertDisputeTransition(dispute.state, DisputeState.UNDER_REVIEW);
    const updated: Dispute = { ...dispute, state: DisputeState.UNDER_REVIEW };
    await this.disputes.save(updated);
    return updated;
  }

  /**
   * Resolve a dispute under review: apply any corrections, re-adjudicate the disputed lines through
   * the existing pipeline (new appended adjudication + signed compensating ledger), record the
   * outcome, and move UNDER_REVIEW → RESOLVED → CLOSED.
   */
  async resolve(
    disputeId: string,
    input: ResolveDisputeInput,
  ): Promise<{ dispute: Dispute; adjudication: AdjudicationSummary }> {
    if (input.note.trim() === '') {
      throw new ValidationError('note is required');
    }
    const dispute = await this.requireDispute(disputeId);
    // Resolvable only from UNDER_REVIEW (OPEN → RESOLVED is rejected by the guard).
    assertDisputeTransition(dispute.state, DisputeState.RESOLVED);

    if (input.corrections) {
      for (const [lineId, correction] of Object.entries(input.corrections)) {
        if (!dispute.lineIds.includes(lineId)) {
          throw new ValidationError(`Correction targets line ${lineId} not in dispute ${disputeId}`);
        }
        await this.claims.applyLineCorrection(lineId, correction);
      }
    }

    const adjudication = await this.adjudication.reAdjudicateLines(dispute.claimId, dispute.lineIds);

    // UNDER_REVIEW → RESOLVED → CLOSED (both edges validated; persisted at the terminal CLOSED).
    assertDisputeTransition(DisputeState.RESOLVED, DisputeState.CLOSED);
    const resolved: Dispute = {
      ...dispute,
      state: DisputeState.CLOSED,
      resolutionOutcome: input.outcome,
      resolutionNote: input.note,
      resolvedAt: new Date().toISOString(),
    };
    await this.disputes.save(resolved);

    return { dispute: resolved, adjudication };
  }

  private async requireDispute(disputeId: string): Promise<Dispute> {
    const dispute = await this.disputes.get(disputeId);
    if (!dispute) {
      throw new NotFoundError(`Dispute ${disputeId} not found`);
    }
    return dispute;
  }
}
