/**
 * Repository ports (implementation-plan §9). Prisma and in-memory adapters implement each.
 * Methods are the minimum the services call. Domain types only — no ORM types leak through.
 */

import type {
  Adjudication,
  Claim,
  ClaimLine,
  CoverageRule,
  Dispute,
  Member,
  Policy,
  UsageLedgerEntry,
} from '../domain/entities';
import type { ClaimState, LineState } from '../domain/states';

export interface MemberRepository {
  get(memberId: string): Promise<Member | null>;
}

export interface PolicyRepository {
  getById(policyId: string): Promise<Policy | null>;
  getActivePolicyForMemberOnDate(memberId: string, dateOfService: string): Promise<Policy | null>;
  getRulesForPolicy(policyId: string): Promise<CoverageRule[]>;
  getExclusionsForPolicy(policyId: string): Promise<string[]>;
}

export interface ClaimRepository {
  create(claim: Claim, lines: ClaimLine[]): Promise<Claim>;
  getWithLines(claimId: string): Promise<{ claim: Claim; lines: ClaimLine[] } | null>;
  /** Cache write only — the derived claim state (deriveClaimState is the sole computer). */
  saveClaimState(claimId: string, state: ClaimState): Promise<void>;
  saveLineState(lineId: string, state: LineState): Promise<void>;
}

export interface AdjudicationRepository {
  /** Append a record and flip the prior current record for the line to is_current = false. */
  appendForLine(adjudication: Adjudication): Promise<void>;
  currentForLine(lineId: string): Promise<Adjudication | null>;
  historyForLine(lineId: string): Promise<Adjudication[]>;
}

export interface UsageLedgerRepository {
  /** Append-only; amounts are signed. */
  append(entry: UsageLedgerEntry): Promise<void>;
  entriesForMemberPeriod(memberId: string, period: number): Promise<UsageLedgerEntry[]>;
}

export interface DisputeRepository {
  create(dispute: Dispute): Promise<Dispute>;
  get(disputeId: string): Promise<Dispute | null>;
  /** Derives "is disputed": an open dispute in {OPEN, UNDER_REVIEW} for the claim. */
  findOpenByClaim(claimId: string): Promise<Dispute | null>;
  save(dispute: Dispute): Promise<void>;
}
