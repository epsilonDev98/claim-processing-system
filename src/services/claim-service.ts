/**
 * Claim service (implementation-plan §7, domain §5 submission flow).
 *
 * Submit + validation + duplicate-line rejection. A submitted claim starts SUBMITTED with all
 * lines AWAITING_ADJUDICATION; no adjudication happens here.
 */

import { randomUUID } from 'node:crypto';
import type { Claim, ClaimLine } from '../domain/entities';
import { ClaimState, LineState } from '../domain/states';
import type { ClaimRepository, MemberRepository, PolicyRepository } from '../repositories/interfaces';
import { NotFoundError, ValidationError } from './errors';

export interface SubmitLineInput {
  lineId?: string;
  serviceCode: string;
  serviceCategory: string;
  diagnosisCode?: string;
  billedMinor: number;
  units: number;
}

export interface SubmitClaimInput {
  claimId?: string;
  memberId: string;
  policyId: string;
  provider: string;
  dateOfService: string;
  lines: SubmitLineInput[];
}

export class ClaimService {
  constructor(
    private readonly claims: ClaimRepository,
    private readonly members: MemberRepository,
    private readonly policies: PolicyRepository,
  ) {}

  async submit(input: SubmitClaimInput): Promise<{ claim: Claim; lines: ClaimLine[] }> {
    if (isBlank(input.dateOfService)) {
      throw new ValidationError('dateOfService is required');
    }
    if (isBlank(input.provider)) {
      throw new ValidationError('provider is required');
    }
    if (input.lines.length === 0) {
      throw new ValidationError('A claim must have at least one line');
    }

    const seen = new Set<string>();
    for (const line of input.lines) {
      if (isBlank(line.serviceCode)) {
        throw new ValidationError('serviceCode is required');
      }
      if (isBlank(line.serviceCategory)) {
        throw new ValidationError('serviceCategory is required');
      }
      if (!Number.isInteger(line.billedMinor) || line.billedMinor < 0) {
        throw new ValidationError('billedMinor must be a non-negative integer (minor units)');
      }
      if (!Number.isInteger(line.units) || line.units <= 0) {
        throw new ValidationError('units must be a positive integer');
      }
      // Duplicate-line rejection: same service_code + billed + units (domain §5).
      const key = `${line.serviceCode}|${line.billedMinor}|${line.units}`;
      if (seen.has(key)) {
        throw new ValidationError(`Duplicate claim line: ${line.serviceCode}`);
      }
      seen.add(key);
    }

    const member = await this.members.get(input.memberId);
    if (!member) {
      throw new NotFoundError(`Member ${input.memberId} not found`);
    }
    const policy = await this.policies.getById(input.policyId);
    if (!policy) {
      throw new NotFoundError(`Policy ${input.policyId} not found`);
    }
    if (policy.memberId !== input.memberId) {
      throw new ValidationError(`Policy ${input.policyId} does not belong to member ${input.memberId}`);
    }

    const claimId = input.claimId ?? randomUUID();
    const claim: Claim = {
      claimId,
      memberId: input.memberId,
      policyId: input.policyId,
      provider: input.provider,
      dateOfService: input.dateOfService,
      submittedAt: new Date().toISOString(),
      state: ClaimState.SUBMITTED,
    };
    const lines: ClaimLine[] = input.lines.map((line) => ({
      lineId: line.lineId ?? randomUUID(),
      claimId,
      serviceCode: line.serviceCode,
      serviceCategory: line.serviceCategory,
      diagnosisCode: line.diagnosisCode ?? '',
      billedMinor: line.billedMinor,
      units: line.units,
      state: LineState.AWAITING_ADJUDICATION,
    }));

    await this.claims.create(claim, lines);
    return { claim, lines };
  }
}

/** A required string is "blank" if it is empty or only whitespace. */
function isBlank(value: string): boolean {
  return value.trim() === '';
}
