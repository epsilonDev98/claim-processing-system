/**
 * In-memory repository adapters — used by the services in unit/integration tests (fast, no DB).
 * They store domain objects directly and return shallow copies on read so external mutation can't
 * corrupt internal state. The append-only / one-current invariants are enforced the same way the
 * Prisma adapters enforce them.
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
} from '../../domain/entities';
import { ClaimState, DisputeState, LineState } from '../../domain/states';
import { isPolicyActiveOnDate } from '../../pipeline/steps';
import type {
  AdjudicationRepository,
  ClaimRepository,
  DisputeRepository,
  MemberRepository,
  PolicyRepository,
  UsageLedgerRepository,
} from '../interfaces';

export class InMemoryMemberRepository implements MemberRepository {
  private readonly members = new Map<string, Member>();

  constructor(seed: readonly Member[] = []) {
    for (const m of seed) this.members.set(m.memberId, m);
  }

  async get(memberId: string): Promise<Member | null> {
    const found = this.members.get(memberId);
    return found ? { ...found } : null;
  }
}

export class InMemoryPolicyRepository implements PolicyRepository {
  private readonly policies = new Map<string, Policy>();
  private readonly rules = new Map<string, CoverageRule[]>();
  private readonly exclusions = new Map<string, string[]>();

  constructor(
    seed: readonly {
      policy: Policy;
      rules: readonly CoverageRule[];
      exclusions: readonly string[];
    }[] = [],
  ) {
    for (const { policy, rules, exclusions } of seed) {
      this.policies.set(policy.policyId, policy);
      this.rules.set(policy.policyId, [...rules]);
      this.exclusions.set(policy.policyId, [...exclusions]);
    }
  }

  async getById(policyId: string): Promise<Policy | null> {
    const found = this.policies.get(policyId);
    return found ? { ...found } : null;
  }

  async getActivePolicyForMemberOnDate(memberId: string, dateOfService: string): Promise<Policy | null> {
    for (const policy of this.policies.values()) {
      if (policy.memberId === memberId && isPolicyActiveOnDate(policy, dateOfService)) {
        return { ...policy };
      }
    }
    return null;
  }

  async getRulesForPolicy(policyId: string): Promise<CoverageRule[]> {
    return (this.rules.get(policyId) ?? []).map((r) => ({ ...r }));
  }

  async getExclusionsForPolicy(policyId: string): Promise<string[]> {
    return [...(this.exclusions.get(policyId) ?? [])];
  }
}

export class InMemoryClaimRepository implements ClaimRepository {
  private readonly claims = new Map<string, Claim>();
  private readonly linesByClaim = new Map<string, ClaimLine[]>();
  private readonly lineIndex = new Map<string, ClaimLine>();

  async create(claim: Claim, lines: ClaimLine[]): Promise<Claim> {
    this.claims.set(claim.claimId, { ...claim });
    const stored = lines.map((l) => ({ ...l }));
    this.linesByClaim.set(claim.claimId, stored);
    for (const line of stored) this.lineIndex.set(line.lineId, line);
    return { ...claim };
  }

  async getWithLines(claimId: string): Promise<{ claim: Claim; lines: ClaimLine[] } | null> {
    const claim = this.claims.get(claimId);
    if (!claim) return null;
    const lines = (this.linesByClaim.get(claimId) ?? []).map((l) => ({ ...l }));
    return { claim: { ...claim }, lines };
  }

  async saveClaimState(claimId: string, state: ClaimState): Promise<void> {
    const claim = this.claims.get(claimId);
    if (claim) claim.state = state;
  }

  async saveLineState(lineId: string, state: LineState): Promise<void> {
    const line = this.lineIndex.get(lineId);
    if (line) line.state = state;
  }
}

export class InMemoryAdjudicationRepository implements AdjudicationRepository {
  private readonly byLine = new Map<string, Adjudication[]>();

  async appendForLine(adjudication: Adjudication): Promise<void> {
    const history = this.byLine.get(adjudication.lineId) ?? [];
    // Exactly one current record per line.
    for (const prior of history) prior.isCurrent = false;
    history.push({ ...adjudication, reasonCodes: [...adjudication.reasonCodes] });
    this.byLine.set(adjudication.lineId, history);
  }

  async currentForLine(lineId: string): Promise<Adjudication | null> {
    const current = (this.byLine.get(lineId) ?? []).find((a) => a.isCurrent);
    return current ? clone(current) : null;
  }

  async historyForLine(lineId: string): Promise<Adjudication[]> {
    return (this.byLine.get(lineId) ?? []).map(clone);
  }
}

export class InMemoryUsageLedgerRepository implements UsageLedgerRepository {
  private readonly entries: UsageLedgerEntry[] = [];

  constructor(seed: readonly UsageLedgerEntry[] = []) {
    for (const e of seed) this.entries.push({ ...e });
  }

  async append(entry: UsageLedgerEntry): Promise<void> {
    this.entries.push({ ...entry });
  }

  async entriesForMemberPeriod(memberId: string, period: number): Promise<UsageLedgerEntry[]> {
    return this.entries
      .filter((e) => e.memberId === memberId && e.period === period)
      .map((e) => ({ ...e }));
  }
}

export class InMemoryDisputeRepository implements DisputeRepository {
  private readonly disputes = new Map<string, Dispute>();

  async create(dispute: Dispute): Promise<Dispute> {
    this.disputes.set(dispute.disputeId, cloneDispute(dispute));
    return cloneDispute(dispute);
  }

  async get(disputeId: string): Promise<Dispute | null> {
    const found = this.disputes.get(disputeId);
    return found ? cloneDispute(found) : null;
  }

  async findOpenByClaim(claimId: string): Promise<Dispute | null> {
    for (const dispute of this.disputes.values()) {
      if (
        dispute.claimId === claimId &&
        (dispute.state === DisputeState.OPEN || dispute.state === DisputeState.UNDER_REVIEW)
      ) {
        return cloneDispute(dispute);
      }
    }
    return null;
  }

  async save(dispute: Dispute): Promise<void> {
    this.disputes.set(dispute.disputeId, cloneDispute(dispute));
  }
}

function clone(adjudication: Adjudication): Adjudication {
  return { ...adjudication, reasonCodes: [...adjudication.reasonCodes] };
}

function cloneDispute(dispute: Dispute): Dispute {
  return { ...dispute, lineIds: [...dispute.lineIds] };
}
