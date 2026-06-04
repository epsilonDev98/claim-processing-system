/**
 * State definitions and transition guards (domain-model §6).
 *
 * Three deliberately tiny machines, expressed as hand-rolled transition tables + a guard
 * function — no state-machine library (the graphs are small and explicit tables keep the
 * "invalid transition" tests readable).
 *
 *   - Claim state is NOT a transition machine here: it is a *derived projection* of line
 *     states (computed by `deriveClaimState` in the pipeline, a later commit). The enum
 *     lives here; there is intentionally no CLAIM_TRANSITIONS table.
 *   - Line and Dispute states ARE transition machines, guarded by `assertTransition`.
 *
 * There is no `DISPUTED` value anywhere. "Is this claim disputed?" is derived from an open
 * Dispute, not stored on the claim or line (domain §6, §7).
 */

/** Derived claim state — written only by deriveClaimState (cache), never assigned directly. */
export enum ClaimState {
  SUBMITTED = 'SUBMITTED',
  UNDER_REVIEW = 'UNDER_REVIEW',
  APPROVED = 'APPROVED',
  PARTIALLY_APPROVED = 'PARTIALLY_APPROVED',
  DENIED = 'DENIED',
  PAID = 'PAID',
}

/** Authoritative per-line state, written by the adjudication pipeline. */
export enum LineState {
  AWAITING_ADJUDICATION = 'AWAITING_ADJUDICATION',
  NEEDS_REVIEW = 'NEEDS_REVIEW',
  APPROVED = 'APPROVED',
  PARTIALLY_APPROVED = 'PARTIALLY_APPROVED',
  DENIED = 'DENIED',
  PAID = 'PAID',
}

export enum DisputeState {
  OPEN = 'OPEN',
  UNDER_REVIEW = 'UNDER_REVIEW',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED',
  WITHDRAWN = 'WITHDRAWN',
}

export enum DisputeOutcome {
  UPHELD = 'UPHELD',
  OVERTURNED = 'OVERTURNED',
  PARTIALLY_OVERTURNED = 'PARTIALLY_OVERTURNED',
}

/**
 * Line transition table — mirrors the domain §6 line-state diagram exactly.
 * `APPROVED → APPROVED` is the re-adjudication self-loop; `DENIED → APPROVED |
 * PARTIALLY_APPROVED` are dispute-overturn edges. Notably absent (illegal):
 * `AWAITING_ADJUDICATION → PAID` and `DENIED → PAID`.
 */
export const LINE_TRANSITIONS: Readonly<Record<LineState, readonly LineState[]>> = {
  [LineState.AWAITING_ADJUDICATION]: [
    LineState.APPROVED,
    LineState.PARTIALLY_APPROVED,
    LineState.DENIED,
    LineState.NEEDS_REVIEW,
  ],
  [LineState.NEEDS_REVIEW]: [
    LineState.APPROVED,
    LineState.PARTIALLY_APPROVED,
    LineState.DENIED,
  ],
  [LineState.APPROVED]: [LineState.PAID, LineState.APPROVED],
  [LineState.PARTIALLY_APPROVED]: [LineState.PAID],
  [LineState.DENIED]: [LineState.APPROVED, LineState.PARTIALLY_APPROVED],
  [LineState.PAID]: [],
};

/** Dispute transition table — mirrors the domain §6 dispute-state diagram exactly. */
export const DISPUTE_TRANSITIONS: Readonly<Record<DisputeState, readonly DisputeState[]>> = {
  [DisputeState.OPEN]: [DisputeState.UNDER_REVIEW, DisputeState.WITHDRAWN],
  [DisputeState.UNDER_REVIEW]: [DisputeState.RESOLVED, DisputeState.WITHDRAWN],
  [DisputeState.RESOLVED]: [DisputeState.CLOSED],
  [DisputeState.WITHDRAWN]: [DisputeState.CLOSED],
  [DisputeState.CLOSED]: [],
};

/** Thrown when a transition is not permitted by the relevant transition table. */
export class IllegalTransitionError extends Error {
  constructor(
    public readonly machine: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Illegal ${machine} transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

function assertTransition<S extends string>(
  table: Readonly<Record<S, readonly S[]>>,
  machine: string,
  from: S,
  to: S,
): void {
  const allowed = table[from];
  if (allowed === undefined || !allowed.includes(to)) {
    throw new IllegalTransitionError(machine, from, to);
  }
}

/** Guard a line-state transition; throws IllegalTransitionError on an illegal edge. */
export function assertLineTransition(from: LineState, to: LineState): void {
  assertTransition(LINE_TRANSITIONS, 'Line', from, to);
}

/** Guard a dispute-state transition; throws IllegalTransitionError on an illegal edge. */
export function assertDisputeTransition(from: DisputeState, to: DisputeState): void {
  assertTransition(DISPUTE_TRANSITIONS, 'Dispute', from, to);
}

/** True if the line-state transition is permitted (non-throwing companion to the guard). */
export function canLineTransition(from: LineState, to: LineState): boolean {
  return LINE_TRANSITIONS[from].includes(to);
}

/** True if the dispute-state transition is permitted (non-throwing companion to the guard). */
export function canDisputeTransition(from: DisputeState, to: DisputeState): boolean {
  return DISPUTE_TRANSITIONS[from].includes(to);
}
