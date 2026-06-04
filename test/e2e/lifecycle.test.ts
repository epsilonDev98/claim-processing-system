import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import request from 'supertest';
import { loadPolicyConfig } from '../../src/config/rule-loader';
import type { Member, Policy, UsageLedgerEntry } from '../../src/domain/entities';
import { annualLimitBucket, DEDUCTIBLE_BUCKET } from '../../src/pipeline/adjudicate-line';
import { buildContainer } from '../../src/container';
import { createServer } from '../../src/api/server';
import {
  InMemoryAdjudicationRepository,
  InMemoryClaimRepository,
  InMemoryDisputeRepository,
  InMemoryMemberRepository,
  InMemoryPolicyRepository,
  InMemoryUsageLedgerRepository,
} from '../../src/repositories/memory/in-memory-repositories';

const PERIOD = 2026;

function buildApp(memberId: string, policyId: string) {
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

  const ledgerRepo = new InMemoryUsageLedgerRepository();
  const container = buildContainer({
    members: new InMemoryMemberRepository([member]),
    policies: new InMemoryPolicyRepository([{ policy, rules: config.rules, exclusions: config.exclusions }]),
    claims: new InMemoryClaimRepository(),
    adjudications: new InMemoryAdjudicationRepository(),
    ledger: ledgerRepo,
    disputes: new InMemoryDisputeRepository(),
  });

  return { app: createServer(container), ledgerRepo, memberId, policyId };
}

async function seedLedger(
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
    period: PERIOD,
    bucket,
    amountOrCount: amountMinor,
    sourceLineId: 'SEED',
    createdAt: new Date().toISOString(),
  };
  await ledgerRepo.append(entry);
}

interface ApiLine {
  lineId: string;
  serviceCategory: string;
  state: string;
  adjudication: { decisionCode: string; reasonCodes: string[]; payableMinor: number } | null;
  explanation: { shortMessage: string } | null;
}

function lineByCategory(lines: ApiLine[], category: string): ApiLine {
  const line = lines.find((l) => l.serviceCategory === category);
  if (!line) throw new Error(`No line for category ${category}`);
  return line;
}

describe('E2E-1 — full lifecycle (submit → adjudicate → resolve review → pay → PAID)', () => {
  it('walks C-S7 to PAID over REST', async () => {
    const sys = buildApp('M-001', 'POL-001');
    await seedLedger(sys.ledgerRepo, sys.memberId, sys.policyId, DEDUCTIBLE_BUCKET, 50000);
    await seedLedger(sys.ledgerRepo, sys.memberId, sys.policyId, annualLimitBucket('PHYSICAL_THERAPY'), 380000);

    // Submit the multi-line claim.
    const submit = await request(sys.app)
      .post('/claims')
      .send({
        memberId: 'M-001',
        policyId: 'POL-001',
        provider: 'Multi Clinic',
        dateOfService: '2026-06-01',
        lines: [
          { serviceCode: 'PREV-1', serviceCategory: 'PREVENTIVE_CARE', billedMinor: 20000, units: 1 },
          { serviceCode: 'COSM-1', serviceCategory: 'COSMETIC', billedMinor: 150000, units: 1 },
          { serviceCode: 'IMG-1', serviceCategory: 'DIAGNOSTIC_IMAGING', billedMinor: 1500000, units: 1 },
          { serviceCode: 'PT-1', serviceCategory: 'PHYSICAL_THERAPY', billedMinor: 100000, units: 1 },
        ],
      });
    expect(submit.status).to.equal(201);
    expect(submit.body.state).to.equal('SUBMITTED');
    const claimId: string = submit.body.claimId;

    // Adjudicate → UNDER_REVIEW with mixed outcomes.
    const adjudicate = await request(sys.app).post(`/claims/${claimId}/adjudicate`);
    expect(adjudicate.status).to.equal(200);
    expect(adjudicate.body.claimState).to.equal('UNDER_REVIEW');
    expect(adjudicate.body.lines.map((l: { lineState: string }) => l.lineState)).to.deep.equal([
      'APPROVED',
      'DENIED',
      'NEEDS_REVIEW',
      'PARTIALLY_APPROVED',
    ]);

    // Full claim view: PHI-minimized, explanations derived, imaging pended.
    const view = await request(sys.app).get(`/claims/${claimId}`);
    expect(view.status).to.equal(200);
    expect(view.body).to.not.have.property('name');
    expect(view.body.lines[0]).to.not.have.property('diagnosisCode');
    expect(view.body.isDisputed).to.equal(false);
    const imaging = lineByCategory(view.body.lines, 'DIAGNOSTIC_IMAGING');
    expect(imaging.state).to.equal('NEEDS_REVIEW');
    expect(imaging.explanation!.shortMessage).to.equal('Needs manual review.');

    // Cannot pay while a line needs review.
    const blockedPay = await request(sys.app).post(`/claims/${claimId}/pay`);
    expect(blockedPay.status).to.equal(409);

    // Resolve the pended imaging line → PARTIALLY_APPROVED.
    const resolveReview = await request(sys.app).post(`/claims/${claimId}/lines/${imaging.lineId}/resolve-review`);
    expect(resolveReview.status).to.equal(200);
    expect(resolveReview.body.claimState).to.equal('PARTIALLY_APPROVED');

    // Pay → PAID.
    const pay = await request(sys.app).post(`/claims/${claimId}/pay`);
    expect(pay.status).to.equal(200);
    expect(pay.body.claimState).to.equal('PAID');

    const finalView = await request(sys.app).get(`/claims/${claimId}`);
    expect(finalView.body.state).to.equal('PAID');
    expect(lineByCategory(finalView.body.lines, 'DIAGNOSTIC_IMAGING').state).to.equal('PAID');
  });
});

describe('E2E-2 — dispute overturned round-trip (S9 over REST)', () => {
  it('submit mis-categorized → denial → dispute → re-adjudicate → PARTIALLY_APPROVED → PAID', async () => {
    const sys = buildApp('M-003', 'POL-003'); // fresh: deductible unmet, PT unused

    const submit = await request(sys.app)
      .post('/claims')
      .send({
        memberId: 'M-003',
        policyId: 'POL-003',
        provider: 'PT Clinic',
        dateOfService: '2026-06-01',
        lines: [{ serviceCode: 'PT-1', serviceCategory: 'COSMETIC', billedMinor: 80000, units: 1 }],
      });
    expect(submit.status).to.equal(201);
    const claimId: string = submit.body.claimId;

    const adjudicate = await request(sys.app).post(`/claims/${claimId}/adjudicate`);
    expect(adjudicate.body.claimState).to.equal('DENIED');

    const denied = await request(sys.app).get(`/claims/${claimId}`);
    const lineId: string = denied.body.lines[0].lineId;
    expect(denied.body.lines[0].adjudication.decisionCode).to.equal('DENIED');
    expect(denied.body.lines[0].explanation.shortMessage).to.equal('Service not covered.');

    // Open dispute → start review → resolve OVERTURNED with a category correction.
    const open = await request(sys.app)
      .post(`/claims/${claimId}/disputes`)
      .send({ lineIds: [lineId], reason: 'Wrong category.' });
    expect(open.status).to.equal(201);
    const disputeId: string = open.body.disputeId;

    const startReview = await request(sys.app).post(`/disputes/${disputeId}/start-review`);
    expect(startReview.status).to.equal(200);
    expect(startReview.body.state).to.equal('UNDER_REVIEW');

    const resolve = await request(sys.app)
      .post(`/disputes/${disputeId}/resolve`)
      .send({
        outcome: 'OVERTURNED',
        note: 'Re-categorized to PHYSICAL_THERAPY and approved on dispute.',
        corrections: { [lineId]: { serviceCategory: 'PHYSICAL_THERAPY' } },
      });
    expect(resolve.status).to.equal(200);
    expect(resolve.body.adjudication.claimState).to.equal('PARTIALLY_APPROVED');
    expect(resolve.body.adjudication.lines[0].payableMinor).to.equal(21500);
    expect(resolve.body.dispute.resolutionOutcome).to.equal('OVERTURNED');

    // Append-only history: seq 1 DENIED preserved, seq 2 PARTIALLY_APPROVED current.
    const disputeView = await request(sys.app).get(`/disputes/${disputeId}`);
    const history = disputeView.body.adjudicationHistory[lineId];
    expect(history.map((a: { sequence: number }) => a.sequence)).to.deep.equal([1, 2]);
    expect(history.filter((a: { isCurrent: boolean }) => a.isCurrent)).to.have.length(1);
    expect(history.find((a: { sequence: number }) => a.sequence === 1).decisionCode).to.equal('DENIED');
    expect(history.find((a: { sequence: number }) => a.sequence === 2).decisionCode).to.equal('PARTIALLY_APPROVED');

    // New ledger consumption keyed to the line (all positive — original was a denial).
    const ledger = await request(sys.app).get(`/claims/${claimId}/ledger`);
    expect(ledger.body.balances[DEDUCTIBLE_BUCKET]).to.equal(50000);
    expect(ledger.body.balances[annualLimitBucket('PHYSICAL_THERAPY')]).to.equal(80000);
    const written = ledger.body.entries.filter((e: { sourceLineId: string }) => e.sourceLineId === lineId);
    expect(written).to.have.length(2);

    // Pay → PAID.
    const pay = await request(sys.app).post(`/claims/${claimId}/pay`);
    expect(pay.body.claimState).to.equal('PAID');
    expect((await request(sys.app).get(`/claims/${claimId}`)).body.state).to.equal('PAID');
  });
});
