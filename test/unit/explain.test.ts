import { expect } from 'chai';
import { explain, type ExplanationContext } from '../../src/pipeline/explain';
import { ReasonCode } from '../../src/domain/codes';

const baseContext: ExplanationContext = {
  serviceCategory: 'PHYSICAL_THERAPY',
  dateOfService: '2026-06-01',
  billedMinor: 80000,
  allowedMinor: 80000,
  deductibleAppliedMinor: 50000,
  coinsuranceMinor: 6000,
  copayMinor: 2500,
};

describe('explain (derived member explanation)', () => {
  it('S1 — COVERED fills the category template', () => {
    const explanation = explain([ReasonCode.COVERED], [], {
      ...baseContext,
      serviceCategory: 'PREVENTIVE_CARE',
    });
    expect(explanation.shortMessage).to.equal('Service fully covered.');
    expect(explanation.detail).to.equal(
      'This service is covered in full under your PREVENTIVE_CARE benefit.',
    );
  });

  it('S2 — NOT_COVERED names the category', () => {
    const explanation = explain([ReasonCode.NOT_COVERED], [], {
      ...baseContext,
      serviceCategory: 'COSMETIC',
    });
    expect(explanation.shortMessage).to.equal('Service not covered.');
    expect(explanation.detail).to.equal('COSMETIC is not covered under your policy.');
  });

  it('S3 — multi-reason detail uses each reason’s own amount; short message is the primary reason', () => {
    const explanation = explain(
      [ReasonCode.DEDUCTIBLE_APPLIED, ReasonCode.COINSURANCE_APPLIED, ReasonCode.COPAY_APPLIED],
      [],
      baseContext,
    );
    expect(explanation.shortMessage).to.equal('Deductible applied.');
    expect(explanation.detail).to.equal(
      '$500.00 was applied toward your annual deductible. ' +
        'Coinsurance of $60.00 is your responsibility. ' +
        'A $25.00 copay applies to this service.',
    );
  });

  it('carries the breakdown through unchanged', () => {
    const breakdown = [
      { label: 'Billed', amountMinor: 80000 },
      { label: 'Payable', amountMinor: 21500 },
    ];
    const explanation = explain([ReasonCode.COVERED], breakdown, baseContext);
    expect(explanation.breakdown).to.equal(breakdown);
  });

  it('throws if given no reason codes', () => {
    expect(() => explain([], [], baseContext)).to.throw();
  });
});
