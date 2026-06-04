import { expect } from 'chai';
import {
  AdjudicationInput,
  adjudicateLine,
  annualLimitBucket,
} from '../../src/pipeline/adjudicate-line';
import { DecisionCode, ReasonCode } from '../../src/domain/codes';
import { LineState } from '../../src/domain/states';
import type { CoverageRule } from '../../src/domain/entities';

const POLICY = {
  effectiveDate: '2026-01-01',
  terminationDate: '2026-12-31',
  annualDeductibleMinor: 50000,
};

const RULES: Record<string, CoverageRule> = {
  PREVENTIVE_CARE: { serviceCategory: 'PREVENTIVE_CARE', covered: true, coinsuranceRate: 0 },
  PHYSICAL_THERAPY: {
    serviceCategory: 'PHYSICAL_THERAPY',
    covered: true,
    coinsuranceRate: 0.2,
    annualLimitMinor: 400000,
    copayMinor: 2500,
  },
  DIAGNOSTIC_IMAGING: {
    serviceCategory: 'DIAGNOSTIC_IMAGING',
    covered: true,
    coinsuranceRate: 0.1,
    reviewThresholdMinor: 1000000,
  },
  EXPERIMENTAL: { serviceCategory: 'EXPERIMENTAL', covered: true, coinsuranceRate: 0.2 },
  COSMETIC: { serviceCategory: 'COSMETIC', covered: false },
};

const EXCLUSIONS = ['EXPERIMENTAL'];

function input(overrides: Partial<AdjudicationInput> & Pick<AdjudicationInput, 'serviceCategory' | 'billedMinor'>): AdjudicationInput {
  return {
    dateOfService: '2026-06-01',
    policy: POLICY,
    rule: RULES[overrides.serviceCategory],
    exclusions: EXCLUSIONS,
    deductibleConsumedMinor: 0,
    annualLimitConsumedMinor: 0,
    ...overrides,
  };
}

describe('adjudicateLine (pure pipeline)', () => {
  it('S1 — covered service, full approval (deductible already met)', () => {
    const out = adjudicateLine(
      input({ serviceCategory: 'PREVENTIVE_CARE', billedMinor: 20000, deductibleConsumedMinor: 50000 }),
    );

    expect(out.decisionCode).to.equal(DecisionCode.APPROVED);
    expect(out.lineState).to.equal(LineState.APPROVED);
    expect(out.reasonCodes).to.deep.equal([ReasonCode.COVERED]);
    expect(out.payableMinor).to.equal(20000);
    expect(out.memberRespMinor).to.equal(0);
    expect(out.ledgerDeltas).to.deep.equal([]);
  });

  it('S2 — non-covered service, hard deny at Coverage', () => {
    const out = adjudicateLine(input({ serviceCategory: 'COSMETIC', billedMinor: 150000 }));

    expect(out.decisionCode).to.equal(DecisionCode.DENIED);
    expect(out.lineState).to.equal(LineState.DENIED);
    expect(out.reasonCodes).to.deep.equal([ReasonCode.NOT_COVERED]);
    expect(out.payableMinor).to.equal(0);
    expect(out.memberRespMinor).to.equal(150000);
    expect(out.ledgerDeltas).to.deep.equal([]);
  });

  it('S3 — deductible + coinsurance + copay (first claim of the year)', () => {
    const out = adjudicateLine(input({ serviceCategory: 'PHYSICAL_THERAPY', billedMinor: 80000 }));

    expect(out.decisionCode).to.equal(DecisionCode.PARTIALLY_APPROVED);
    expect(out.reasonCodes).to.deep.equal([
      ReasonCode.DEDUCTIBLE_APPLIED,
      ReasonCode.COINSURANCE_APPLIED,
      ReasonCode.COPAY_APPLIED,
    ]);
    expect(out.allowedMinor).to.equal(80000);
    expect(out.deductibleAppliedMinor).to.equal(50000);
    expect(out.coinsuranceMinor).to.equal(6000);
    expect(out.copayMinor).to.equal(2500);
    expect(out.payableMinor).to.equal(21500);
    expect(out.memberRespMinor).to.equal(58500);
    expect(out.ledgerDeltas).to.deep.equal([
      { bucket: 'DEDUCTIBLE', amountMinor: 50000 },
      { bucket: annualLimitBucket('PHYSICAL_THERAPY'), amountMinor: 80000 },
    ]);
  });

  it('S6 — manual review pend (billed above threshold)', () => {
    const out = adjudicateLine(input({ serviceCategory: 'DIAGNOSTIC_IMAGING', billedMinor: 1500000 }));

    expect(out.decisionCode).to.equal(DecisionCode.NEEDS_REVIEW);
    expect(out.lineState).to.equal(LineState.NEEDS_REVIEW);
    expect(out.reasonCodes).to.deep.equal([ReasonCode.PENDED_FOR_REVIEW]);
    expect(out.payableMinor).to.equal(0);
    expect(out.ledgerDeltas).to.deep.equal([]);
  });

  it('S11 — eligibility hard deny (policy inactive on DOS)', () => {
    const out = adjudicateLine(
      input({ serviceCategory: 'PHYSICAL_THERAPY', billedMinor: 80000, dateOfService: '2025-12-15' }),
    );

    expect(out.decisionCode).to.equal(DecisionCode.DENIED);
    expect(out.reasonCodes).to.deep.equal([ReasonCode.POLICY_INACTIVE]);
    expect(out.payableMinor).to.equal(0);
    expect(out.ledgerDeltas).to.deep.equal([]);
  });

  it('S12 — exclusion hard deny (covered rule, on the exclusion list)', () => {
    const out = adjudicateLine(input({ serviceCategory: 'EXPERIMENTAL', billedMinor: 300000 }));

    expect(out.decisionCode).to.equal(DecisionCode.DENIED);
    expect(out.reasonCodes).to.deep.equal([ReasonCode.EXCLUDED_SERVICE]);
    expect(out.payableMinor).to.equal(0);
    expect(out.ledgerDeltas).to.deep.equal([]);
  });

  it('S4 (pure) — exhausted annual limit hard-denies with ANNUAL_LIMIT_REACHED', () => {
    const out = adjudicateLine(
      input({
        serviceCategory: 'PHYSICAL_THERAPY',
        billedMinor: 100000,
        deductibleConsumedMinor: 50000,
        annualLimitConsumedMinor: 400000,
      }),
    );

    expect(out.decisionCode).to.equal(DecisionCode.DENIED);
    expect(out.reasonCodes).to.deep.equal([ReasonCode.ANNUAL_LIMIT_REACHED]);
    expect(out.allowedMinor).to.equal(0);
    expect(out.ledgerDeltas).to.deep.equal([]);
  });

  it('S5 (pure) — annual limit caps allowed, partial approval', () => {
    const out = adjudicateLine(
      input({
        serviceCategory: 'PHYSICAL_THERAPY',
        billedMinor: 1200000,
        deductibleConsumedMinor: 50000,
        annualLimitConsumedMinor: 50000,
      }),
    );

    expect(out.decisionCode).to.equal(DecisionCode.PARTIALLY_APPROVED);
    expect(out.reasonCodes).to.deep.equal([
      ReasonCode.ANNUAL_LIMIT_APPLIED,
      ReasonCode.COINSURANCE_APPLIED,
      ReasonCode.COPAY_APPLIED,
    ]);
    expect(out.allowedMinor).to.equal(350000);
    expect(out.coinsuranceMinor).to.equal(70000);
    expect(out.payableMinor).to.equal(277500);
    expect(out.memberRespMinor).to.equal(922500);
    expect(out.ledgerDeltas).to.deep.equal([
      { bucket: annualLimitBucket('PHYSICAL_THERAPY'), amountMinor: 350000 },
    ]);
  });
});
