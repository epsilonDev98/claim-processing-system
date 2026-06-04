import { expect } from 'chai';
import path from 'node:path';
import { loadPolicyConfig } from '../../src/config/rule-loader';
import { DecisionCode, ReasonCode } from '../../src/domain/codes';
import type { Member, Policy, UsageLedgerEntry } from '../../src/domain/entities';
import { ClaimState, DisputeOutcome, DisputeState, LineState } from '../../src/domain/states';
import { DEDUCTIBLE_BUCKET, annualLimitBucket } from '../../src/pipeline/adjudicate-line';
import {
  InMemoryAdjudicationRepository,
  InMemoryClaimRepository,
  InMemoryDisputeRepository,
  InMemoryMemberRepository,
  InMemoryPolicyRepository,
  InMemoryUsageLedgerRepository,
} from '../../src/repositories/memory/in-memory-repositories';
import { AdjudicationService } from '../../src/services/adjudication-service';
import { ClaimService } from '../../src/services/claim-service';
import { DisputeService } from '../../src/services/dispute-service';
import { LedgerService } from '../../src/services/ledger-service';
import { ValidationError } from '../../src/services/errors';

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

  const claimRepo = new InMemoryClaimRepository();
  const adjudicationRepo = new InMemoryAdjudicationRepository();
  const ledgerRepo = new InMemoryUsageLedgerRepository();
  const disputeRepo = new InMemoryDisputeRepository();
  const ledgerService = new LedgerService(ledgerRepo);
  const policyRepo = new InMemoryPolicyRepository([
    { policy, rules: config.rules, exclusions: config.exclusions },
  ]);
  const adjudicationService = new AdjudicationService(claimRepo, policyRepo, adjudicationRepo, ledgerService);

  return {
    claimService: new ClaimService(claimRepo, new InMemoryMemberRepository([member]), policyRepo),
    adjudicationService,
    disputeService: new DisputeService(disputeRepo, claimRepo, adjudicationService),
    claimRepo,
    adjudicationRepo,
    disputeRepo,
    ledgerRepo,
    memberId,
    policyId,
  };
}

async function ledgerEntries(repo: InMemoryUsageLedgerRepository, memberId: string): Promise<UsageLedgerEntry[]> {
  return (await repo.entriesForMemberPeriod(memberId, 2026)).filter((e) => e.sourceLineId !== 'SEED');
}

describe('dispute handling (lifecycle + append-only re-adjudication)', () => {
  it('S8 — dispute upheld: seq 2 appended, seq 1 untouched, one isCurrent, ledger unchanged, claim re-derives DENIED', async () => {
    const sys = buildSystem('M-001', 'POL-001');
    const { lines } = await sys.claimService.submit({
      claimId: 'C-S2',
      memberId: sys.memberId,
      policyId: sys.policyId,
      provider: 'Aesthetics Clinic',
      dateOfService: '2026-06-01',
      lines: [{ serviceCode: 'COSM-1', serviceCategory: 'COSMETIC', billedMinor: 150000, units: 1 }],
    });
    const lineId = lines[0]!.lineId;
    await sys.adjudicationService.adjudicateClaim('C-S2');

    const dispute = await sys.disputeService.openDispute({
      disputeId: 'D-S8',
      claimId: 'C-S2',
      lineIds: [lineId],
      reason: 'I think this is covered.',
    });
    // "Is disputed" is derived from the open dispute.
    expect(await sys.disputeRepo.findOpenByClaim('C-S2')).to.not.equal(null);
    expect(dispute.state).to.equal(DisputeState.OPEN);

    await sys.disputeService.startReview('D-S8');
    const { dispute: resolved, adjudication } = await sys.disputeService.resolve('D-S8', {
      outcome: DisputeOutcome.UPHELD,
      note: 'Original denial upheld on review.',
    });

    // Re-adjudication reproduces the denial; claim re-derives to DENIED.
    expect(adjudication.claimState).to.equal(ClaimState.DENIED);
    expect(adjudication.lines[0]!.decisionCode).to.equal(DecisionCode.DENIED);

    // Append-only history: seq 1 preserved (not current), seq 2 current; both DENIED [NOT_COVERED].
    const history = await sys.adjudicationRepo.historyForLine(lineId);
    expect(history.map((a) => a.sequence)).to.deep.equal([1, 2]);
    expect(history.filter((a) => a.isCurrent)).to.have.length(1);
    expect(history.find((a) => a.sequence === 1)!.isCurrent).to.equal(false);
    expect(history.find((a) => a.sequence === 2)!.isCurrent).to.equal(true);
    for (const record of history) {
      expect(record.decisionCode).to.equal(DecisionCode.DENIED);
      expect(record.reasonCodes).to.deep.equal([ReasonCode.NOT_COVERED]);
    }

    // No usage was ever consumed → nothing to compensate.
    expect(await ledgerEntries(sys.ledgerRepo, sys.memberId)).to.deep.equal([]);

    // Dispute closed & no longer "open" (not disputed anymore).
    expect(resolved.state).to.equal(DisputeState.CLOSED);
    expect(resolved.resolutionOutcome).to.equal(DisputeOutcome.UPHELD);
    expect(await sys.disputeRepo.findOpenByClaim('C-S2')).to.equal(null);
  });

  it('S9 — dispute overturned: correction re-categorizes, seq 2 PARTIALLY_APPROVED, new ledger consumption, then PAID', async () => {
    const sys = buildSystem('M-003', 'POL-003'); // fresh: deductible unmet, PT unused
    const { lines } = await sys.claimService.submit({
      claimId: 'C-S9',
      memberId: sys.memberId,
      policyId: sys.policyId,
      provider: 'PT Clinic',
      dateOfService: '2026-06-01',
      // Mis-categorized as COSMETIC → originally denied.
      lines: [{ serviceCode: 'PT-1', serviceCategory: 'COSMETIC', billedMinor: 80000, units: 1 }],
    });
    const lineId = lines[0]!.lineId;

    const original = await sys.adjudicationService.adjudicateClaim('C-S9');
    expect(original.lines[0]!.decisionCode).to.equal(DecisionCode.DENIED);
    expect(await ledgerEntries(sys.ledgerRepo, sys.memberId)).to.deep.equal([]);

    await sys.disputeService.openDispute({ disputeId: 'D-S9', claimId: 'C-S9', lineIds: [lineId], reason: 'Wrong category.' });
    await sys.disputeService.startReview('D-S9');
    const { dispute: resolved, adjudication } = await sys.disputeService.resolve('D-S9', {
      outcome: DisputeOutcome.OVERTURNED,
      note: 'Re-categorized to PHYSICAL_THERAPY and approved on dispute.',
      corrections: { [lineId]: { serviceCategory: 'PHYSICAL_THERAPY' } },
    });

    // Re-adjudication now pays (identical math to S3).
    expect(adjudication.claimState).to.equal(ClaimState.PARTIALLY_APPROVED);
    const reLine = adjudication.lines[0]!;
    expect(reLine.decisionCode).to.equal(DecisionCode.PARTIALLY_APPROVED);
    expect(reLine.reasonCodes).to.deep.equal([
      ReasonCode.DEDUCTIBLE_APPLIED,
      ReasonCode.COINSURANCE_APPLIED,
      ReasonCode.COPAY_APPLIED,
    ]);
    expect(reLine.payableMinor).to.equal(21500);
    expect(reLine.memberRespMinor).to.equal(58500);

    // Append-only history: seq 1 DENIED [NOT_COVERED] (not current), seq 2 PARTIALLY_APPROVED (current).
    const history = await sys.adjudicationRepo.historyForLine(lineId);
    expect(history.map((a) => a.sequence)).to.deep.equal([1, 2]);
    const seq1 = history.find((a) => a.sequence === 1)!;
    const seq2 = history.find((a) => a.sequence === 2)!;
    expect(seq1.isCurrent).to.equal(false);
    expect(seq1.decisionCode).to.equal(DecisionCode.DENIED);
    expect(seq1.reasonCodes).to.deep.equal([ReasonCode.NOT_COVERED]);
    expect(seq2.isCurrent).to.equal(true);
    expect(seq2.payableMinor).to.equal(21500);

    // New ledger consumption keyed to the line — all positive (original was a denial, nothing to reverse).
    const written = await ledgerEntries(sys.ledgerRepo, sys.memberId);
    expect(written).to.have.length(2);
    expect(written.every((e) => e.sourceLineId === lineId && e.amountOrCount > 0)).to.equal(true);
    const byBucket = new Map(written.map((e) => [e.bucket, e.amountOrCount]));
    expect(byBucket.get(DEDUCTIBLE_BUCKET)).to.equal(50000);
    expect(byBucket.get(annualLimitBucket('PHYSICAL_THERAPY'))).to.equal(80000);

    expect(resolved.resolutionOutcome).to.equal(DisputeOutcome.OVERTURNED);

    // Pay → PAID.
    const paid = await sys.adjudicationService.payClaim('C-S9');
    expect(paid.claimState).to.equal(ClaimState.PAID);
    expect(paid.lines[0]!.lineState).to.equal(LineState.PAID);
  });

  it('rejects resolving a dispute that has not entered review (OPEN → RESOLVED is illegal)', async () => {
    const sys = buildSystem('M-001', 'POL-001');
    const { lines } = await sys.claimService.submit({
      claimId: 'C-D2',
      memberId: sys.memberId,
      policyId: sys.policyId,
      provider: 'Aesthetics Clinic',
      dateOfService: '2026-06-01',
      lines: [{ serviceCode: 'COSM-1', serviceCategory: 'COSMETIC', billedMinor: 150000, units: 1 }],
    });
    await sys.adjudicationService.adjudicateClaim('C-D2');
    await sys.disputeService.openDispute({ disputeId: 'D-D2', claimId: 'C-D2', lineIds: [lines[0]!.lineId], reason: 'x' });

    let error: unknown;
    try {
      await sys.disputeService.resolve('D-D2', { outcome: DisputeOutcome.UPHELD, note: 'n' });
    } catch (err) {
      error = err;
    }
    expect(error).to.be.instanceOf(Error);
    // The premature resolve must not have appended a re-adjudication.
    expect(await sys.adjudicationRepo.historyForLine(lines[0]!.lineId)).to.have.length(1);
  });

  it('rejects duplicate target lineIds', async () => {
    const sys = buildSystem('M-001', 'POL-001');
    const { lines } = await sys.claimService.submit({
      claimId: 'C-D4',
      memberId: sys.memberId,
      policyId: sys.policyId,
      provider: 'Aesthetics Clinic',
      dateOfService: '2026-06-01',
      lines: [{ serviceCode: 'COSM-1', serviceCategory: 'COSMETIC', billedMinor: 150000, units: 1 }],
    });
    const lineId = lines[0]!.lineId;

    let error: unknown;
    try {
      await sys.disputeService.openDispute({
        disputeId: 'D-D4',
        claimId: 'C-D4',
        lineIds: [lineId, lineId],
        reason: 'x',
      });
    } catch (err) {
      error = err;
    }
    expect(error).to.be.instanceOf(ValidationError);
    expect((error as ValidationError).message).to.match(/duplicate/i);
  });

  it('rejects a blank resolution note', async () => {
    const sys = buildSystem('M-001', 'POL-001');
    const { lines } = await sys.claimService.submit({
      claimId: 'C-D3',
      memberId: sys.memberId,
      policyId: sys.policyId,
      provider: 'Aesthetics Clinic',
      dateOfService: '2026-06-01',
      lines: [{ serviceCode: 'COSM-1', serviceCategory: 'COSMETIC', billedMinor: 150000, units: 1 }],
    });
    await sys.adjudicationService.adjudicateClaim('C-D3');
    await sys.disputeService.openDispute({ disputeId: 'D-D3', claimId: 'C-D3', lineIds: [lines[0]!.lineId], reason: 'x' });
    await sys.disputeService.startReview('D-D3');

    let error: unknown;
    try {
      await sys.disputeService.resolve('D-D3', { outcome: DisputeOutcome.UPHELD, note: '   ' });
    } catch (err) {
      error = err;
    }
    expect(error).to.be.instanceOf(ValidationError);
    // Blank note is rejected before any re-adjudication is appended.
    expect(await sys.adjudicationRepo.historyForLine(lines[0]!.lineId)).to.have.length(1);
  });
});
