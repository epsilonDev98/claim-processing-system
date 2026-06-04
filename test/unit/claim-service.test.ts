import { expect } from 'chai';
import type { Member, Policy } from '../../src/domain/entities';
import { ClaimState, LineState } from '../../src/domain/states';
import {
  InMemoryClaimRepository,
  InMemoryMemberRepository,
  InMemoryPolicyRepository,
} from '../../src/repositories/memory/in-memory-repositories';
import { ClaimService, type SubmitClaimInput } from '../../src/services/claim-service';
import { ValidationError } from '../../src/services/errors';

function buildClaimService(): ClaimService {
  const member: Member = { memberId: 'M-001', name: '<PHI>', dob: '1985-04-12' };
  const policy: Policy = {
    policyId: 'POL-001',
    memberId: 'M-001',
    effectiveDate: '2026-01-01',
    terminationDate: '2026-12-31',
    planYear: 2026,
    annualDeductibleMinor: 50000,
  };
  return new ClaimService(
    new InMemoryClaimRepository(),
    new InMemoryMemberRepository([member]),
    new InMemoryPolicyRepository([{ policy, rules: [], exclusions: [] }]),
  );
}

function validInput(overrides: Partial<SubmitClaimInput> = {}): SubmitClaimInput {
  return {
    memberId: 'M-001',
    policyId: 'POL-001',
    provider: 'PT Clinic',
    dateOfService: '2026-06-01',
    lines: [{ serviceCode: 'PT-1', serviceCategory: 'PHYSICAL_THERAPY', billedMinor: 80000, units: 1 }],
    ...overrides,
  };
}

describe('ClaimService.submit input validation', () => {
  it('accepts a valid claim → SUBMITTED with AWAITING lines', async () => {
    const service = buildClaimService();
    const { claim, lines } = await service.submit(validInput());
    expect(claim.state).to.equal(ClaimState.SUBMITTED);
    expect(lines[0]!.state).to.equal(LineState.AWAITING_ADJUDICATION);
  });

  it('rejects a blank provider', async () => {
    const service = buildClaimService();
    await expectValidationError(service.submit(validInput({ provider: '   ' })), 'provider');
    await expectValidationError(service.submit(validInput({ provider: '' })), 'provider');
  });

  it('rejects a blank serviceCode', async () => {
    const service = buildClaimService();
    await expectValidationError(
      service.submit(validInput({ lines: [line({ serviceCode: '  ' })] })),
      'serviceCode',
    );
  });

  it('rejects a blank serviceCategory', async () => {
    const service = buildClaimService();
    await expectValidationError(
      service.submit(validInput({ lines: [line({ serviceCategory: '' })] })),
      'serviceCategory',
    );
  });
});

function line(overrides: Partial<SubmitClaimInput['lines'][number]> = {}) {
  return { serviceCode: 'PT-1', serviceCategory: 'PHYSICAL_THERAPY', billedMinor: 80000, units: 1, ...overrides };
}

async function expectValidationError(promise: Promise<unknown>, field: string): Promise<void> {
  try {
    await promise;
    expect.fail(`expected ValidationError for ${field}`);
  } catch (err) {
    expect(err, `error for ${field}`).to.be.instanceOf(ValidationError);
    expect((err as ValidationError).message).to.include(field);
  }
}
