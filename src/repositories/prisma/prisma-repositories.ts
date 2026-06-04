/**
 * Prisma (SQLite) repository adapters — the production implementation of the ports. They map flat
 * Prisma rows to/from the domain entities: reconstruct the CoverageRule discriminated union from
 * nullable columns, decode JSON-encoded reason-code / line-id arrays, and convert DateTime ↔ ISO
 * strings. Append-only / one-current invariants are enforced inside transactions.
 *
 * These are exercised end-to-end by the API/E2E suite (Commit 9); the services themselves are
 * verified now via the in-memory adapters.
 */

import type {
  Adjudication as PrismaAdjudication,
  Claim as PrismaClaim,
  ClaimLine as PrismaClaimLine,
  CoverageRule as PrismaCoverageRule,
  Dispute as PrismaDispute,
  Member as PrismaMember,
  Policy as PrismaPolicy,
  PrismaClient,
  UsageLedgerEntry as PrismaUsageLedgerEntry,
} from '@prisma/client';
import { DecisionCode, type ReasonCode } from '../../domain/codes';
import type {
  Adjudication,
  Claim,
  ClaimLine,
  CoverageRule,
  CoveredRule,
  Dispute,
  Member,
  Policy,
  UsageLedgerEntry,
} from '../../domain/entities';
import { ClaimState, DisputeOutcome, DisputeState, LineState } from '../../domain/states';
import type {
  AdjudicationRepository,
  ClaimRepository,
  DisputeRepository,
  MemberRepository,
  PolicyRepository,
  UsageLedgerRepository,
} from '../interfaces';

export class PrismaMemberRepository implements MemberRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async get(memberId: string): Promise<Member | null> {
    const row = await this.prisma.member.findUnique({ where: { memberId } });
    return row ? toMember(row) : null;
  }
}

export class PrismaPolicyRepository implements PolicyRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getById(policyId: string): Promise<Policy | null> {
    const row = await this.prisma.policy.findUnique({ where: { policyId } });
    return row ? toPolicy(row) : null;
  }

  async getActivePolicyForMemberOnDate(memberId: string, dateOfService: string): Promise<Policy | null> {
    const row = await this.prisma.policy.findFirst({
      where: {
        memberId,
        effectiveDate: { lte: dateOfService },
        terminationDate: { gte: dateOfService },
      },
    });
    return row ? toPolicy(row) : null;
  }

  async getRulesForPolicy(policyId: string): Promise<CoverageRule[]> {
    const rows = await this.prisma.coverageRule.findMany({ where: { policyId } });
    return rows.map(toCoverageRule);
  }

  async getExclusionsForPolicy(policyId: string): Promise<string[]> {
    const row = await this.prisma.policy.findUnique({ where: { policyId } });
    return row ? parseStringArray(row.exclusions) : [];
  }
}

export class PrismaClaimRepository implements ClaimRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(claim: Claim, lines: ClaimLine[]): Promise<Claim> {
    await this.prisma.claim.create({
      data: {
        claimId: claim.claimId,
        memberId: claim.memberId,
        policyId: claim.policyId,
        provider: claim.provider,
        dateOfService: claim.dateOfService,
        submittedAt: new Date(claim.submittedAt),
        state: claim.state,
        lines: {
          create: lines.map((line) => ({
            lineId: line.lineId,
            serviceCode: line.serviceCode,
            serviceCategory: line.serviceCategory,
            diagnosisCode: line.diagnosisCode,
            billedMinor: line.billedMinor,
            units: line.units,
            state: line.state,
          })),
        },
      },
    });
    return claim;
  }

  async getWithLines(claimId: string): Promise<{ claim: Claim; lines: ClaimLine[] } | null> {
    const row = await this.prisma.claim.findUnique({ where: { claimId }, include: { lines: true } });
    if (!row) return null;
    return { claim: toClaim(row), lines: row.lines.map(toClaimLine) };
  }

  async saveClaimState(claimId: string, state: ClaimState): Promise<void> {
    await this.prisma.claim.update({ where: { claimId }, data: { state } });
  }

  async saveLineState(lineId: string, state: LineState): Promise<void> {
    await this.prisma.claimLine.update({ where: { lineId }, data: { state } });
  }
}

export class PrismaAdjudicationRepository implements AdjudicationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async appendForLine(adjudication: Adjudication): Promise<void> {
    // Flip the prior current record and append the new one atomically (one is_current per line).
    await this.prisma.$transaction([
      this.prisma.adjudication.updateMany({
        where: { lineId: adjudication.lineId, isCurrent: true },
        data: { isCurrent: false },
      }),
      this.prisma.adjudication.create({
        data: {
          adjudicationId: adjudication.adjudicationId,
          lineId: adjudication.lineId,
          sequence: adjudication.sequence,
          isCurrent: adjudication.isCurrent,
          decisionCode: adjudication.decisionCode,
          reasonCodes: JSON.stringify(adjudication.reasonCodes),
          allowedMinor: adjudication.allowedMinor,
          deductibleAppliedMinor: adjudication.deductibleAppliedMinor,
          coinsuranceMinor: adjudication.coinsuranceMinor,
          copayMinor: adjudication.copayMinor,
          payableMinor: adjudication.payableMinor,
          memberRespMinor: adjudication.memberRespMinor,
          adjudicatedAt: new Date(adjudication.adjudicatedAt),
        },
      }),
    ]);
  }

  async currentForLine(lineId: string): Promise<Adjudication | null> {
    const row = await this.prisma.adjudication.findFirst({ where: { lineId, isCurrent: true } });
    return row ? toAdjudication(row) : null;
  }

  async historyForLine(lineId: string): Promise<Adjudication[]> {
    const rows = await this.prisma.adjudication.findMany({
      where: { lineId },
      orderBy: { sequence: 'asc' },
    });
    return rows.map(toAdjudication);
  }
}

export class PrismaUsageLedgerRepository implements UsageLedgerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async append(entry: UsageLedgerEntry): Promise<void> {
    await this.prisma.usageLedgerEntry.create({
      data: {
        entryId: entry.entryId,
        memberId: entry.memberId,
        policyId: entry.policyId,
        period: entry.period,
        bucket: entry.bucket,
        amountOrCount: entry.amountOrCount,
        sourceLineId: entry.sourceLineId,
        createdAt: new Date(entry.createdAt),
      },
    });
  }

  async entriesForMemberPeriod(memberId: string, period: number): Promise<UsageLedgerEntry[]> {
    const rows = await this.prisma.usageLedgerEntry.findMany({ where: { memberId, period } });
    return rows.map(toUsageLedgerEntry);
  }
}

export class PrismaDisputeRepository implements DisputeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(dispute: Dispute): Promise<Dispute> {
    await this.prisma.dispute.create({ data: toDisputeRow(dispute) });
    return dispute;
  }

  async get(disputeId: string): Promise<Dispute | null> {
    const row = await this.prisma.dispute.findUnique({ where: { disputeId } });
    return row ? toDispute(row) : null;
  }

  async findOpenByClaim(claimId: string): Promise<Dispute | null> {
    const row = await this.prisma.dispute.findFirst({
      where: { claimId, state: { in: [DisputeState.OPEN, DisputeState.UNDER_REVIEW] } },
    });
    return row ? toDispute(row) : null;
  }

  async save(dispute: Dispute): Promise<void> {
    await this.prisma.dispute.update({ where: { disputeId: dispute.disputeId }, data: toDisputeRow(dispute) });
  }
}

// --- mappers ---------------------------------------------------------------

function toMember(row: PrismaMember): Member {
  return { memberId: row.memberId, name: row.name, dob: row.dob };
}

function toPolicy(row: PrismaPolicy): Policy {
  return {
    policyId: row.policyId,
    memberId: row.memberId,
    effectiveDate: row.effectiveDate,
    terminationDate: row.terminationDate,
    planYear: row.planYear,
    annualDeductibleMinor: row.annualDeductibleMinor,
  };
}

function toCoverageRule(row: PrismaCoverageRule): CoverageRule {
  if (!row.covered) {
    return { serviceCategory: row.serviceCategory, covered: false };
  }
  const rule: CoveredRule = {
    serviceCategory: row.serviceCategory,
    covered: true,
    coinsuranceRate: row.coinsuranceRate ?? 0,
  };
  if (row.annualLimitMinor !== null) rule.annualLimitMinor = row.annualLimitMinor;
  if (row.visitLimit !== null) rule.visitLimit = row.visitLimit;
  if (row.perIncidentMaxMinor !== null) rule.perIncidentMaxMinor = row.perIncidentMaxMinor;
  if (row.copayMinor !== null) rule.copayMinor = row.copayMinor;
  if (row.reviewThresholdMinor !== null) rule.reviewThresholdMinor = row.reviewThresholdMinor;
  return rule;
}

function toClaim(row: PrismaClaim): Claim {
  return {
    claimId: row.claimId,
    memberId: row.memberId,
    policyId: row.policyId,
    provider: row.provider,
    dateOfService: row.dateOfService,
    submittedAt: row.submittedAt.toISOString(),
    state: row.state as ClaimState,
  };
}

function toClaimLine(row: PrismaClaimLine): ClaimLine {
  return {
    lineId: row.lineId,
    claimId: row.claimId,
    serviceCode: row.serviceCode,
    serviceCategory: row.serviceCategory,
    diagnosisCode: row.diagnosisCode,
    billedMinor: row.billedMinor,
    units: row.units,
    state: row.state as LineState,
  };
}

function toAdjudication(row: PrismaAdjudication): Adjudication {
  return {
    adjudicationId: row.adjudicationId,
    lineId: row.lineId,
    sequence: row.sequence,
    isCurrent: row.isCurrent,
    decisionCode: row.decisionCode as DecisionCode,
    reasonCodes: parseStringArray(row.reasonCodes) as ReasonCode[],
    allowedMinor: row.allowedMinor,
    deductibleAppliedMinor: row.deductibleAppliedMinor,
    coinsuranceMinor: row.coinsuranceMinor,
    copayMinor: row.copayMinor,
    payableMinor: row.payableMinor,
    memberRespMinor: row.memberRespMinor,
    adjudicatedAt: row.adjudicatedAt.toISOString(),
  };
}

function toUsageLedgerEntry(row: PrismaUsageLedgerEntry): UsageLedgerEntry {
  return {
    entryId: row.entryId,
    memberId: row.memberId,
    policyId: row.policyId,
    period: row.period,
    bucket: row.bucket,
    amountOrCount: row.amountOrCount,
    sourceLineId: row.sourceLineId,
    createdAt: row.createdAt.toISOString(),
  };
}

function toDispute(row: PrismaDispute): Dispute {
  const dispute: Dispute = {
    disputeId: row.disputeId,
    claimId: row.claimId,
    lineIds: parseStringArray(row.lineIds),
    reason: row.reason,
    state: row.state as DisputeState,
    openedAt: row.openedAt.toISOString(),
  };
  if (row.resolutionOutcome !== null) dispute.resolutionOutcome = row.resolutionOutcome as DisputeOutcome;
  if (row.resolutionNote !== null) dispute.resolutionNote = row.resolutionNote;
  if (row.resolvedAt !== null) dispute.resolvedAt = row.resolvedAt.toISOString();
  return dispute;
}

function toDisputeRow(dispute: Dispute) {
  return {
    disputeId: dispute.disputeId,
    claimId: dispute.claimId,
    lineIds: JSON.stringify(dispute.lineIds),
    reason: dispute.reason,
    state: dispute.state,
    resolutionOutcome: dispute.resolutionOutcome ?? null,
    resolutionNote: dispute.resolutionNote ?? null,
    openedAt: new Date(dispute.openedAt),
    resolvedAt: dispute.resolvedAt !== undefined ? new Date(dispute.resolvedAt) : null,
  };
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`Expected a JSON string array, got: ${value}`);
  }
  return parsed;
}
