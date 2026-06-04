/**
 * Money — the single source of money arithmetic (domain-model §2.2, §4 value objects).
 *
 * Amounts are integer **minor units** (cents); never floats. All arithmetic stays in
 * integer space except `percentOf`, whose product is rounded back to whole minor units
 * using **banker's rounding** (round half to even) so coinsurance figures match the
 * acceptance scenarios (S3 $60.00, S5 $700.00, S7-L4 $40.00) exactly and identically
 * everywhere the math runs.
 *
 * Immutable: every operation returns a new Money.
 */

export type Currency = 'USD';

/** Thrown when two Money values of different currencies are combined. */
export class CurrencyMismatchError extends Error {
  constructor(
    public readonly left: Currency,
    public readonly right: Currency,
  ) {
    super(`Cannot combine Money of different currencies: ${left} vs ${right}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class Money {
  private constructor(
    public readonly amountMinor: number,
    public readonly currency: Currency,
  ) {}

  /** Construct from whole minor units. Rejects non-integers — minor units never have fractions. */
  static of(amountMinor: number, currency: Currency = 'USD'): Money {
    if (!Number.isInteger(amountMinor)) {
      throw new RangeError(
        `Money requires integer minor units; received ${amountMinor}`,
      );
    }
    return new Money(amountMinor, currency);
  }

  static zero(currency: Currency = 'USD'): Money {
    return new Money(0, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor + other.amountMinor, this.currency);
  }

  sub(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor - other.amountMinor, this.currency);
  }

  /** The lesser of the two amounts (used for limit/deductible caps). */
  min(other: Money): Money {
    this.assertSameCurrency(other);
    return this.amountMinor <= other.amountMinor ? this : other;
  }

  /**
   * `rate` fraction of this amount, rounded to whole minor units with banker's rounding.
   * `rate` must be finite and non-negative (e.g. a 0.20 coinsurance rate).
   */
  percentOf(rate: number): Money {
    if (!Number.isFinite(rate) || rate < 0) {
      throw new RangeError(`rate must be a finite, non-negative number; received ${rate}`);
    }
    return new Money(bankersRound(this.amountMinor * rate), this.currency);
  }

  /** Negative amounts collapse to zero; non-negative amounts are returned unchanged. */
  clampToZero(): Money {
    return this.amountMinor < 0 ? new Money(0, this.currency) : this;
  }

  isZero(): boolean {
    return this.amountMinor === 0;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amountMinor === other.amountMinor;
  }

  toString(): string {
    return `${this.amountMinor} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

/**
 * Round half to even ("banker's rounding"), the rounding mode used for all minor-unit
 * conversions. Standard rounding biases sums upward on repeated halves; rounding halves
 * to the nearest even integer removes that bias.
 */
export function bankersRound(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  const HALF_EPSILON = 1e-6; // tolerates float noise from rate multiplications

  if (Math.abs(fraction - 0.5) < HALF_EPSILON) {
    // Exactly halfway: pick the even neighbour.
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return Math.round(value);
}
