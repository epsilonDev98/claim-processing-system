import { expect } from 'chai';
import { Money, bankersRound } from '../../src/domain/money';

describe('Money', () => {
  describe('construction', () => {
    it('builds from integer minor units', () => {
      expect(Money.of(20000).amountMinor).to.equal(20000);
      expect(Money.of(20000).currency).to.equal('USD');
    });

    it('zero() is a zero-amount USD value', () => {
      const z = Money.zero();
      expect(z.amountMinor).to.equal(0);
      expect(z.isZero()).to.equal(true);
    });

    it('rejects non-integer minor units (no fractional cents)', () => {
      expect(() => Money.of(10.5)).to.throw(RangeError);
      expect(() => Money.of(Number.NaN)).to.throw(RangeError);
    });
  });

  describe('arithmetic', () => {
    it('adds amounts', () => {
      expect(Money.of(50000).add(Money.of(2500)).amountMinor).to.equal(52500);
    });

    it('subtracts amounts (may go negative before clamping)', () => {
      expect(Money.of(30000).sub(Money.of(36000)).amountMinor).to.equal(-6000);
    });

    it('min() returns the lesser amount — the limit/deductible cap', () => {
      // S5: allowed = min(billed 1_200_000, remaining limit 350_000) = 350_000
      expect(Money.of(1_200_000).min(Money.of(350_000)).amountMinor).to.equal(350_000);
      // S7-L4: allowed = min(billed 100_000, remaining limit 20_000) = 20_000
      expect(Money.of(100_000).min(Money.of(20_000)).amountMinor).to.equal(20_000);
    });

    it('clampToZero() floors negatives at zero and leaves non-negatives unchanged', () => {
      expect(Money.of(-500).clampToZero().amountMinor).to.equal(0);
      expect(Money.of(0).clampToZero().amountMinor).to.equal(0);
      expect(Money.of(21500).clampToZero().amountMinor).to.equal(21500);
    });

    it('is immutable — operations return new values', () => {
      const a = Money.of(100);
      const b = a.add(Money.of(50));
      expect(a.amountMinor).to.equal(100);
      expect(b.amountMinor).to.equal(150);
    });

    it('equals() compares amount and currency', () => {
      expect(Money.of(100).equals(Money.of(100))).to.equal(true);
      expect(Money.of(100).equals(Money.of(101))).to.equal(false);
    });
  });

  describe('percentOf (coinsurance) — banker’s rounding to minor units', () => {
    it('matches the acceptance-scenario coinsurance figures', () => {
      // S3: after-deductible 30_000 × 0.20 = 6_000 ($60.00)
      expect(Money.of(30_000).percentOf(0.2).amountMinor).to.equal(6_000);
      // S5: after-deductible 350_000 × 0.20 = 70_000 ($700.00)
      expect(Money.of(350_000).percentOf(0.2).amountMinor).to.equal(70_000);
      // S7-L4: after-deductible 20_000 × 0.20 = 4_000 ($40.00)
      expect(Money.of(20_000).percentOf(0.2).amountMinor).to.equal(4_000);
    });

    it('a 0.00 rate yields zero (e.g. PREVENTIVE_CARE)', () => {
      expect(Money.of(20_000).percentOf(0).amountMinor).to.equal(0);
    });

    it('rejects negative or non-finite rates', () => {
      expect(() => Money.of(100).percentOf(-0.1)).to.throw(RangeError);
      expect(() => Money.of(100).percentOf(Number.POSITIVE_INFINITY)).to.throw(RangeError);
    });
  });

  describe('currency safety', () => {
    it('add/sub/min stay within USD', () => {
      // Single-currency domain: arithmetic never changes currency.
      expect(Money.of(100).add(Money.of(1)).currency).to.equal('USD');
    });
  });
});

describe('bankersRound (round half to even)', () => {
  it('rounds exact halves to the nearest even integer', () => {
    expect(bankersRound(0.5)).to.equal(0);
    expect(bankersRound(1.5)).to.equal(2);
    expect(bankersRound(2.5)).to.equal(2);
    expect(bankersRound(3.5)).to.equal(4);
    expect(bankersRound(4.5)).to.equal(4);
  });

  it('rounds non-halves to the nearest integer', () => {
    expect(bankersRound(2.4)).to.equal(2);
    expect(bankersRound(2.6)).to.equal(3);
    expect(bankersRound(2.0)).to.equal(2);
  });

  it('handles negative halves symmetrically (toward even)', () => {
    expect(bankersRound(-0.5)).to.equal(0);
    expect(bankersRound(-1.5)).to.equal(-2);
    expect(bankersRound(-2.5)).to.equal(-2);
  });
});
