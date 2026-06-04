/**
 * Thin HTTP controllers (implementation-plan §10): validate request → call a service/repo →
 * serialize a PHI-safe DTO. No business logic here. Errors propagate to the central handler.
 */

import type { Request, Response } from 'express';
import type { Container } from '../container';
import type { Adjudication, CoverageRule } from '../domain/entities';
import { NotFoundError } from '../services/errors';
import type { LineCorrection } from '../repositories/interfaces';
import type { ResolveDisputeInput } from '../services/dispute-service';
import { openDisputeSchema, resolveDisputeSchema, submitClaimSchema } from './request-schemas';
import {
  serializeClaimView,
  serializeDisputeView,
  serializeLedgerView,
  serializePolicyView,
} from './serializers';

function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (value === undefined) {
    throw new NotFoundError(`Missing path parameter '${name}'`);
  }
  return value;
}

export function makeControllers(c: Container) {
  return {
    async submitClaim(req: Request, res: Response): Promise<void> {
      const body = submitClaimSchema.parse(req.body);
      const { claim } = await c.claimService.submit(body);
      res.status(201).json({ claimId: claim.claimId, state: claim.state });
    },

    async adjudicateClaim(req: Request, res: Response): Promise<void> {
      const summary = await c.adjudicationService.adjudicateClaim(requireParam(req, 'claimId'));
      res.status(200).json(summary);
    },

    async getClaim(req: Request, res: Response): Promise<void> {
      const claimId = requireParam(req, 'claimId');
      const loaded = await c.repositories.claims.getWithLines(claimId);
      if (!loaded) {
        throw new NotFoundError(`Claim ${claimId} not found`);
      }
      const rules = await c.repositories.policies.getRulesForPolicy(loaded.claim.policyId);
      const rulesByCategory = new Map<string, CoverageRule>(rules.map((r) => [r.serviceCategory, r]));
      const currentByLine = new Map<string, Adjudication | null>();
      for (const line of loaded.lines) {
        currentByLine.set(line.lineId, await c.repositories.adjudications.currentForLine(line.lineId));
      }
      const openDispute = await c.repositories.disputes.findOpenByClaim(claimId);
      res.status(200).json(
        serializeClaimView({
          claim: loaded.claim,
          lines: loaded.lines,
          currentByLine,
          rulesByCategory,
          isDisputed: openDispute !== null,
        }),
      );
    },

    async getLedger(req: Request, res: Response): Promise<void> {
      const claimId = requireParam(req, 'claimId');
      const loaded = await c.repositories.claims.getWithLines(claimId);
      if (!loaded) {
        throw new NotFoundError(`Claim ${claimId} not found`);
      }
      const policy = await c.repositories.policies.getById(loaded.claim.policyId);
      if (!policy) {
        throw new NotFoundError(`Policy ${loaded.claim.policyId} not found`);
      }
      const balances = await c.ledgerService.balances(loaded.claim.memberId, policy.planYear);
      const entries = await c.repositories.ledger.entriesForMemberPeriod(loaded.claim.memberId, policy.planYear);
      res.status(200).json(serializeLedgerView(loaded.claim.memberId, policy.planYear, balances, entries));
    },

    async payClaim(req: Request, res: Response): Promise<void> {
      const summary = await c.adjudicationService.payClaim(requireParam(req, 'claimId'));
      res.status(200).json(summary);
    },

    async resolveReview(req: Request, res: Response): Promise<void> {
      const summary = await c.adjudicationService.resolveReview(
        requireParam(req, 'claimId'),
        requireParam(req, 'lineId'),
      );
      res.status(200).json(summary);
    },

    async openDispute(req: Request, res: Response): Promise<void> {
      const claimId = requireParam(req, 'claimId');
      const body = openDisputeSchema.parse(req.body);
      const dispute = await c.disputeService.openDispute({
        claimId,
        lineIds: body.lineIds,
        reason: body.reason,
      });
      res.status(201).json({ disputeId: dispute.disputeId, claimId: dispute.claimId, state: dispute.state });
    },

    async startReview(req: Request, res: Response): Promise<void> {
      const dispute = await c.disputeService.startReview(requireParam(req, 'disputeId'));
      res.status(200).json({ disputeId: dispute.disputeId, state: dispute.state });
    },

    async resolveDispute(req: Request, res: Response): Promise<void> {
      const disputeId = requireParam(req, 'disputeId');
      const body = resolveDisputeSchema.parse(req.body);
      const input: ResolveDisputeInput = { outcome: body.outcome, note: body.note };
      if (body.corrections !== undefined) {
        // Validated by Zod; bridge the exactOptionalPropertyTypes gap to the service input.
        input.corrections = body.corrections as Record<string, LineCorrection>;
      }
      const { dispute, adjudication } = await c.disputeService.resolve(disputeId, input);
      res.status(200).json({
        dispute: {
          disputeId: dispute.disputeId,
          state: dispute.state,
          resolutionOutcome: dispute.resolutionOutcome,
          resolutionNote: dispute.resolutionNote,
        },
        adjudication,
      });
    },

    async getDispute(req: Request, res: Response): Promise<void> {
      const disputeId = requireParam(req, 'disputeId');
      const dispute = await c.repositories.disputes.get(disputeId);
      if (!dispute) {
        throw new NotFoundError(`Dispute ${disputeId} not found`);
      }
      const historyByLine = new Map<string, Adjudication[]>();
      for (const lineId of dispute.lineIds) {
        historyByLine.set(lineId, await c.repositories.adjudications.historyForLine(lineId));
      }
      res.status(200).json(serializeDisputeView(dispute, historyByLine));
    },

    async getPolicy(req: Request, res: Response): Promise<void> {
      const policyId = requireParam(req, 'policyId');
      const policy = await c.repositories.policies.getById(policyId);
      if (!policy) {
        throw new NotFoundError(`Policy ${policyId} not found`);
      }
      const rules = await c.repositories.policies.getRulesForPolicy(policyId);
      const exclusions = await c.repositories.policies.getExclusionsForPolicy(policyId);
      res.status(200).json(serializePolicyView(policy, rules, exclusions));
    },
  };
}

export type Controllers = ReturnType<typeof makeControllers>;
