/**
 * Value objects (domain-model §2.2, §4).
 *
 * These are pure data shapes with no behaviour beyond `ServiceCode` equality —
 * the payable math lives in `Money` and the explanation/breakdown are assembled
 * by the pipeline. `Money` itself lives in ./money.
 */

/**
 * ServiceCode — a CPT-like coded service identifier. Branded so a raw string is not
 * accidentally used where a validated code is expected. Equality is the only behaviour.
 */
export type ServiceCode = string & { readonly __brand: 'ServiceCode' };

export function toServiceCode(value: string): ServiceCode {
  return value as ServiceCode;
}

export function serviceCodeEquals(a: ServiceCode, b: ServiceCode): boolean {
  return (a as string) === (b as string);
}

/** Cost share for a covered service, derived from a CoverageRule. No logic. */
export interface CostShare {
  readonly coinsuranceRate: number;
  readonly copayMinor: number;
}

/** The plan year that scopes ledger accumulators (domain §10.4). */
export interface Period {
  readonly planYear: number;
}

/** One ordered step in the payable-math trace. */
export interface BreakdownLine {
  readonly label: string;
  readonly amountMinor: number;
}

/** The ordered payable-math trace, built during line adjudication. */
export type CalculationBreakdown = readonly BreakdownLine[];

/**
 * Member-facing explanation — derived from reason codes + the ExplanationCode catalog +
 * the calculation breakdown. **Never persisted** (built by the pipeline's explain step).
 */
export interface Explanation {
  readonly shortMessage: string;
  readonly detail: string;
  readonly breakdown: CalculationBreakdown;
}
