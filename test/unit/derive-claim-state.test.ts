import { expect } from 'chai';
import { deriveClaimState } from '../../src/pipeline/derive-claim-state';
import { ClaimState, LineState } from '../../src/domain/states';

describe('deriveClaimState (S10 — claim state is a pure projection of line states)', () => {
  // Table from acceptance S10 (rows a–i): the five ordered guards, first match wins.
  const rows: ReadonlyArray<{
    id: string;
    lineStates: LineState[];
    expected: ClaimState;
    guard: number;
  }> = [
    { id: 'a', lineStates: [LineState.NEEDS_REVIEW], expected: ClaimState.UNDER_REVIEW, guard: 1 },
    {
      id: 'b',
      lineStates: [LineState.NEEDS_REVIEW, LineState.APPROVED, LineState.DENIED],
      expected: ClaimState.UNDER_REVIEW,
      guard: 1,
    },
    { id: 'c', lineStates: [LineState.PAID, LineState.PAID], expected: ClaimState.PAID, guard: 2 },
    { id: 'd', lineStates: [LineState.PAID, LineState.DENIED], expected: ClaimState.PAID, guard: 2 },
    { id: 'e', lineStates: [LineState.DENIED, LineState.DENIED], expected: ClaimState.DENIED, guard: 3 },
    { id: 'f', lineStates: [LineState.APPROVED, LineState.APPROVED], expected: ClaimState.APPROVED, guard: 4 },
    {
      id: 'g',
      lineStates: [LineState.APPROVED, LineState.DENIED],
      expected: ClaimState.PARTIALLY_APPROVED,
      guard: 5,
    },
    {
      id: 'h',
      lineStates: [LineState.PARTIALLY_APPROVED, LineState.APPROVED],
      expected: ClaimState.PARTIALLY_APPROVED,
      guard: 5,
    },
    {
      id: 'i',
      lineStates: [LineState.PARTIALLY_APPROVED],
      expected: ClaimState.PARTIALLY_APPROVED,
      guard: 5,
    },
  ];

  for (const row of rows) {
    it(`row ${row.id}: [${row.lineStates.join(', ')}] → ${row.expected} (guard ${row.guard})`, () => {
      expect(deriveClaimState(row.lineStates)).to.equal(row.expected);
    });
  }

  it('guard 0: a brand-new claim with all lines awaiting adjudication is SUBMITTED', () => {
    expect(deriveClaimState([LineState.AWAITING_ADJUDICATION])).to.equal(ClaimState.SUBMITTED);
    expect(
      deriveClaimState([LineState.AWAITING_ADJUDICATION, LineState.AWAITING_ADJUDICATION]),
    ).to.equal(ClaimState.SUBMITTED);
  });

  it('guard order: a NEEDS_REVIEW line holds the whole claim open (S7 four-line roll-up)', () => {
    // S7 line states [APPROVED, DENIED, NEEDS_REVIEW, PARTIALLY_APPROVED] → UNDER_REVIEW.
    expect(
      deriveClaimState([
        LineState.APPROVED,
        LineState.DENIED,
        LineState.NEEDS_REVIEW,
        LineState.PARTIALLY_APPROVED,
      ]),
    ).to.equal(ClaimState.UNDER_REVIEW);
  });

  it('does not depend on line order', () => {
    expect(deriveClaimState([LineState.DENIED, LineState.PAID])).to.equal(ClaimState.PAID);
    expect(deriveClaimState([LineState.APPROVED, LineState.PARTIALLY_APPROVED])).to.equal(
      ClaimState.PARTIALLY_APPROVED,
    );
  });

  it('throws on an empty claim (a claim always has at least one line)', () => {
    expect(() => deriveClaimState([])).to.throw();
  });

  describe('exhaustiveness — every combination maps to exactly one valid ClaimState', () => {
    const POST_ADJUDICATION: readonly LineState[] = [
      LineState.NEEDS_REVIEW,
      LineState.APPROVED,
      LineState.PARTIALLY_APPROVED,
      LineState.DENIED,
      LineState.PAID,
    ];
    const validStates = new Set<string>(Object.values(ClaimState));

    it('returns a single valid ClaimState for all 1- to 3-line combinations (never throws, never undefined)', () => {
      for (const a of POST_ADJUDICATION) {
        expect(validStates.has(deriveClaimState([a]))).to.equal(true);
        for (const b of POST_ADJUDICATION) {
          expect(validStates.has(deriveClaimState([a, b]))).to.equal(true);
          for (const c of POST_ADJUDICATION) {
            const result = deriveClaimState([a, b, c]);
            expect(validStates.has(result), `[${a}, ${b}, ${c}] → ${result}`).to.equal(true);
          }
        }
      }
    });
  });
});
