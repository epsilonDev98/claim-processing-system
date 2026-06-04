import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadPolicyConfig } from '../../src/config/rule-loader';
import type { Member, Policy, UsageLedgerEntry } from '../../src/domain/entities';
import { ClaimState, LineState } from '../../src/domain/states';
import { DecisionCode, ReasonCode } from '../../src/domain/codes';
import { annualLimitBucket, DEDUCTIBLE_BUCKET } from '../../src/pipeline/adjudicate-line';
import {
  InMemoryAdjudicationRepository,
  InMemoryClaimRepository,
  InMemoryMemberRepository,
  InMemoryPolicyRepository,
  InMemoryUsageLedgerRepository,
} from '../../src/repositories/memory/in-memory-repositories';
import { AdjudicationService } from '../../src/services/adjudication-service';
import { ClaimService } from '../../src/services/claim-service';
import { LedgerService } from '../../src/services/ledger-service';
import { NotPayableError } from '../../src/services/errors';

const PLAN_YEAR = 2026;

/** Assemble the services over in-memory repos seeded with the §0.2 standard plan for one member. */
function buildSystem(memberId: string, policyId: string) {
  const config = loadPolicyConfig(path.resolve(process.cwd(), 'policies/standard-plan-2026.json'));

  const member: Member = { memberId, name: '<PHI>', dob: '1985-04-12' };
  const policy: Policy = {
    policyId,
    memberId,
    effectiveDate: '2026-01-01',
    terminationDate: '2026-12-31',
    planYear: config.planYear,
    annualDeductibleMinor: config.annualDeductibleMinor,
  };

  const memberRepo = new InMemoryMemberRepository([member]);
  const policyRepo = new InMemoryPolicyRepository([
    { policy, rules: config.rules, exclusions: config.exclusions },
  ]);
  const claimRepo = new InMemoryClaimRepository();
  const adjudicationRepo = new InMemoryAdjudicationRepository();
  const ledgerRepo = new InMemoryUsageLedgerRepository();
  const ledgerService = new LedgerService(ledgerRepo);

  return {
    claimService: new ClaimService(claimRepo, memberRepo, policyRepo),
    adjudicationService: new AdjudicationService(claimRepo, policyRepo, adjudicationRepo, ledgerService),
    claimRepo,
    adjudicationRepo,
    ledgerRepo,
    memberId,
    policyId,
  };
}

function seedLedger(
  ledgerRepo: InMemoryUsageLedgerRepository,
  memberId: string,
  policyId: string,
  bucket: string,
  amountMinor: number,
): Promise<void> {
  const entry: UsageLedgerEntry = {
    entryId: randomUUID(),
    memberId,
    policyId,
    period: PLAN_YEAR,
    bucket,
    amountOrCount: amountMinor,
    sourceLineId: 'SEED',
    createdAt: new Date().toISOString(),
  };
  return ledgerRepo.append(entry);
}

/** Ledger entries written by adjudication (excludes the test's starting "SEED" entries). */
async function adjudicationLedgerEntries(
  ledgerRepo: InMemoryUsageLedgerRepository,
  memberId: string,
): Promise<UsageLedgerEntry[]> {
  const entries = await ledgerRepo.entriesForMemberPeriod(memberId, PLAN_YEAR);
  return entries.filter((e) => e.sourceLineId !== 'SEED');
}

describe('adjudication integration (assembled pipeline + in-memory ledger)', () => {
  it('S4 — annual limit exhausted → DENIED [ANNUAL_LIMIT_REACHED], no ledger write', async () => {
    const sys = buildSystem('M-002', 'POL-002');
    await seedLedger(sys.ledgerRepo, sys.memberId, sys.policyId, DEDUCTIBLE_BUCKET, 50000);
    await seedLedger(sys.ledgerRepo, sys.memberId, sys.policyId, annualLimitBucket('PHYSICAL_THERAPY'), 400000);

    await sys.claimService.submit({
      claimId: 'C-S4',
      memberId: sys.memberId,
      policyId: sys.policyId,
      provider: 'PT Clinic',
      dateOfService: '2026-06-01',
      lines: [{ serviceCode: 'PT-1', serviceCategory: 'PHYSICAL_THERAPY', billedMinor: 100000, units: 1 }],
    });

    const summary = await sys.adjudicationService.adjudicateClaim('C-S4');

    expect(summary.claimState).to.equal(ClaimState.DENIED);
    expect(summary.lines).to.have.length(1);
    const [line] = summary.lines;
    expect(line!.decisionCode).to.equal(DecisionCode.DENIED);
    expect(line!.reasonCodes).to.deep.equal([ReasonCode.ANNUAL_LIMIT_REACHED]);
    expect(line!.payableMinor).to.equal(0);
    expect(line!.memberRespMinor).to.equal(100000);

    expect(await adjudicationLedgerEntries(sys.ledgerRepo, sys.memberId)).to.deep.equal([]);
  });

  it('S3 — deductible + cost share writes DEDUCTIBLE += 50000 and ANNUAL_LIMIT:PT += 80000 (keyed to the line)', async () => {
    const sys = buildSystem('M-002', 'POL-002'); // empty starting ledger (deductible unmet)

    const { lines } = await sys.claimService.submit({
      claimId: 'C-S3',
      memberId: sys.memberId,
      policyId: sys.policyId,
      provider: 'PT Clinic',
      dateOfService: '2026-06-01',
      lines: [{ serviceCode: 'PT-1', serviceCategory: 'PHYSICAL_THERAPY', billedMinor: 80000, units: 1 }],
    });

    const summary = await sys.adjudicationService.adjudicateClaim('C-S3');

    expect(summary.claimState).to.equal(ClaimState.PARTIALLY_APPROVED);
    expect(summary.lines[0]!.payableMinor).to.equal(21500);
    expect(summary.lines[0]!.memberRespMinor).to.equal(58500);

    const written = await adjudicationLedgerEntries(sys.ledgerRepo, sys.memberId);
    expect(written).to.have.length(2);
    expect(written.every((e) => e.sourceLineId === lines[0]!.lineId)).to.equal(true);
    const byBucket = new Map(written.map((e) => [e.bucket, e.amountOrCount]));
    expect(byBucket.get(DEDUCTIBLE_BUCKET)).to.equal(50000);
    expect(byBucket.get(annualLimitBucket('PHYSICAL_THERAPY'))).to.equal(80000);
  });

  it('S5 — annual limit caps allowed → PARTIALLY_APPROVED, ledger ANNUAL_LIMIT:PT += 350000, then PAID', async () => {
    const sys = buildSystem('M-003', 'POL-003');
    await seedLedger(sys.ledgerRepo, sys.memberId, sys.policyId, DEDUCTIBLE_BUCKET, 50000);
    await seedLedger(sys.ledgerRepo, sys.memberId, sys.policyId, annualLimitBucket('PHYSICAL_THERAPY'), 50000);

    const { lines } = await sys.claimService.submit({
      claimId: 'C-S5',
      memberId: sys.memberId,
      policyId: sys.policyId,
      provider: 'PT Clinic',
      dateOfService: '2026-06-01',
      lines: [{ serviceCode: 'PT-1', serviceCategory: 'PHYSICAL_THERAPY', billedMinor: 1200000, units: 1 }],
    });

    const summary = await sys.adjudicationService.adjudicateClaim('C-S5');

    expect(summary.claimState).to.equal(ClaimState.PARTIALLY_APPROVED);
    const [line] = summary.lines;
    expect(line!.decisionCode).to.equal(DecisionCode.PARTIALLY_APPROVED);
    expect(line!.reasonCodes).to.deep.equal([
      ReasonCode.ANNUAL_LIMIT_APPLIED,
      ReasonCode.COINSURANCE_APPLIED,
      ReasonCode.COPAY_APPLIED,
    ]);
    expect(line!.payableMinor).to.equal(277500);
    expect(line!.memberRespMinor).to.equal(922500);

    const written = await adjudicationLedgerEntries(sys.ledgerRepo, sys.memberId);
    expect(written).to.have.length(1);
    expect(written[0]).to.include({
      bucket: annualLimitBucket('PHYSICAL_THERAPY'),
      amountOrCount: 350000,
      sourceLineId: lines[0]!.lineId,
    });

    const paid = await sys.adjudicationService.payClaim('C-S5');
    expect(paid.claimState).to.equal(ClaimState.PAID);
    expect(paid.lines[0]!.lineState).to.equal(LineState.PAID);
  });

  it('S7 — multi-line mixed outcomes, one pended line holds the claim UNDER_REVIEW; only L4 writes the ledger', async () => {
    const sys = buildSystem('M-001', 'POL-001');
    await seedLedger(sys.ledgerRepo, sys.memberId, sys.policyId, DEDUCTIBLE_BUCKET, 50000);
    await seedLedger(sys.ledgerRepo, sys.memberId, sys.policyId, annualLimitBucket('PHYSICAL_THERAPY'), 380000);

    const { lines } = await sys.claimService.submit({
      claimId: 'C-S7',
      memberId: sys.memberId,
      policyId: sys.policyId,
      provider: 'Multi Clinic',
      dateOfService: '2026-06-01',
      lines: [
        { serviceCode: 'PREV-1', serviceCategory: 'PREVENTIVE_CARE', billedMinor: 20000, units: 1 },
        { serviceCode: 'COSM-1', serviceCategory: 'COSMETIC', billedMinor: 150000, units: 1 },
        { serviceCode: 'IMG-1', serviceCategory: 'DIAGNOSTIC_IMAGING', billedMinor: 1500000, units: 1 },
        { serviceCode: 'PT-1', serviceCategory: 'PHYSICAL_THERAPY', billedMinor: 100000, units: 1 },
      ],
    });

    const summary = await sys.adjudicationService.adjudicateClaim('C-S7');

    expect(summary.claimState).to.equal(ClaimState.UNDER_REVIEW);
    expect(summary.lines.map((l) => l.lineState)).to.deep.equal([
      LineState.APPROVED,
      LineState.DENIED,
      LineState.NEEDS_REVIEW,
      LineState.PARTIALLY_APPROVED,
    ]);
    expect(summary.lines.map((l) => l.decisionCode)).to.deep.equal([
      DecisionCode.APPROVED,
      DecisionCode.DENIED,
      DecisionCode.NEEDS_REVIEW,
      DecisionCode.PARTIALLY_APPROVED,
    ]);

    // L4: capped against the running $200 remaining → payable 13500, member resp 86500.
    const l4 = summary.lines[3]!;
    expect(l4.reasonCodes).to.deep.equal([
      ReasonCode.ANNUAL_LIMIT_APPLIED,
      ReasonCode.COINSURANCE_APPLIED,
      ReasonCode.COPAY_APPLIED,
    ]);
    expect(l4.payableMinor).to.equal(13500);
    expect(l4.memberRespMinor).to.equal(86500);

    // Only L4 writes the ledger: ANNUAL_LIMIT:PT += 20000 (now exhausted at 400000).
    const written = await adjudicationLedgerEntries(sys.ledgerRepo, sys.memberId);
    expect(written).to.have.length(1);
    expect(written[0]).to.include({
      bucket: annualLimitBucket('PHYSICAL_THERAPY'),
      amountOrCount: 20000,
      sourceLineId: lines[3]!.lineId,
    });

    // Paying is blocked while the imaging line is NEEDS_REVIEW.
    let payError: unknown;
    try {
      await sys.adjudicationService.payClaim('C-S7');
    } catch (err) {
      payError = err;
    }
    expect(payError).to.be.instanceOf(NotPayableError);
  });

  it('is idempotent — re-running adjudicateClaim appends no duplicate adjudication and does not double-consume', async () => {
    const sys = buildSystem('M-003', 'POL-003');
    await seedLedger(sys.ledgerRepo, sys.memberId, sys.policyId, DEDUCTIBLE_BUCKET, 50000);
    await seedLedger(sys.ledgerRepo, sys.memberId, sys.policyId, annualLimitBucket('PHYSICAL_THERAPY'), 50000);

    const { lines } = await sys.claimService.submit({
      claimId: 'C-IDEM',
      memberId: sys.memberId,
      policyId: sys.policyId,
      provider: 'PT Clinic',
      dateOfService: '2026-06-01',
      lines: [{ serviceCode: 'PT-1', serviceCategory: 'PHYSICAL_THERAPY', billedMinor: 1200000, units: 1 }],
    });
    const lineId = lines[0]!.lineId;

    const first = await sys.adjudicationService.adjudicateClaim('C-IDEM');
    const ledgerAfterFirst = await adjudicationLedgerEntries(sys.ledgerRepo, sys.memberId);
    const historyAfterFirst = await sys.adjudicationRepo.historyForLine(lineId);

    const second = await sys.adjudicationService.adjudicateClaim('C-IDEM');
    const ledgerAfterSecond = await adjudicationLedgerEntries(sys.ledgerRepo, sys.memberId);
    const historyAfterSecond = await sys.adjudicationRepo.historyForLine(lineId);

    // Same outcome, no state churn.
    expect(first.claimState).to.equal(ClaimState.PARTIALLY_APPROVED);
    expect(second.claimState).to.equal(ClaimState.PARTIALLY_APPROVED);
    expect(second.lines[0]!.payableMinor).to.equal(277500);

    // No duplicate adjudication: a single seq-1 record before and after the re-run.
    expect(historyAfterFirst).to.have.length(1);
    expect(historyAfterSecond).to.have.length(1);
    expect(historyAfterSecond[0]!.sequence).to.equal(1);

    // No double consumption: the ledger is byte-for-byte unchanged by the second run.
    expect(ledgerAfterFirst).to.have.length(1);
    expect(ledgerAfterFirst[0]!.amountOrCount).to.equal(350000);
    expect(ledgerAfterSecond).to.deep.equal(ledgerAfterFirst);
  });

  it('only processes AWAITING lines — re-running a partly-pended claim leaves decided lines and the ledger untouched', async () => {
    const sys = buildSystem('M-001', 'POL-001');
    await seedLedger(sys.ledgerRepo, sys.memberId, sys.policyId, DEDUCTIBLE_BUCKET, 50000);
    await seedLedger(sys.ledgerRepo, sys.memberId, sys.policyId, annualLimitBucket('PHYSICAL_THERAPY'), 380000);

    const { lines } = await sys.claimService.submit({
      claimId: 'C-S7B',
      memberId: sys.memberId,
      policyId: sys.policyId,
      provider: 'Multi Clinic',
      dateOfService: '2026-06-01',
      lines: [
        { serviceCode: 'PREV-1', serviceCategory: 'PREVENTIVE_CARE', billedMinor: 20000, units: 1 },
        { serviceCode: 'IMG-1', serviceCategory: 'DIAGNOSTIC_IMAGING', billedMinor: 1500000, units: 1 },
        { serviceCode: 'PT-1', serviceCategory: 'PHYSICAL_THERAPY', billedMinor: 100000, units: 1 },
      ],
    });

    await sys.adjudicationService.adjudicateClaim('C-S7B');
    const ledgerAfterFirst = await adjudicationLedgerEntries(sys.ledgerRepo, sys.memberId);

    const second = await sys.adjudicationService.adjudicateClaim('C-S7B');

    // Re-derives the same claim state (the imaging line is still NEEDS_REVIEW).
    expect(second.claimState).to.equal(ClaimState.UNDER_REVIEW);
    // Each line still has exactly one adjudication, and the ledger is unchanged.
    for (const line of lines) {
      expect(await sys.adjudicationRepo.historyForLine(line.lineId)).to.have.length(1);
    }
    expect(await adjudicationLedgerEntries(sys.ledgerRepo, sys.memberId)).to.deep.equal(ledgerAfterFirst);
  });
});
