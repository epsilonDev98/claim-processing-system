/**
 * Claim-state derivation (domain-model §6, acceptance S10).
 *
 * Claim state is NOT a transition machine — it is a pure projection of the line states,
 * computed by this function and nothing else. `Claim.state`, if persisted, is a cache that
 * only this function writes (same status as the deferred `total_payable` denormalization).
 *
 * Evaluated as ordered guard clauses, first match wins, exhaustive over every
 * line-state combination:
 *
 *   0. every line AWAITING_ADJUDICATION         → SUBMITTED      (not adjudicated yet)
 *   1. any line NEEDS_REVIEW                     → UNDER_REVIEW   (not finished)
 *   2. else every payable line PAID             → PAID
 *   3. else every line DENIED                   → DENIED
 *   4. else every line APPROVED (none partial)  → APPROVED
 *   5. else (any PARTIALLY_APPROVED, or an
 *            approved/denied mix)               → PARTIALLY_APPROVED
 *
 * Guard 0 reflects that adjudication is atomic over a claim's lines (domain §5): before it
 * runs, every line is AWAITING_ADJUDICATION and the claim is simply SUBMITTED.
 *
 * This module lives in `pipeline/` and imports only from `domain/` — dependencies point inward.
 */

import { ClaimState, LineState } from '../domain/states';

/** States a line can be in once it is (or can become) payable; DENIED is not payable. */
const PAYABLE_LINE_STATES: readonly LineState[] = [
  LineState.APPROVED,
  LineState.PARTIALLY_APPROVED,
  LineState.PAID,
];

/**
 * Derive the claim state from its lines' states. Input is the post-adjudication line states;
 * a claim always has at least one line (domain §3), so an empty input is a programming error.
 */
export function deriveClaimState(lineStates: readonly LineState[]): ClaimState {
  if (lineStates.length === 0) {
    throw new Error('Cannot derive claim state from zero lines: a claim has at least one line.');
  }

  // Guard 0 — nothing adjudicated yet (every line still awaiting) ⇒ the claim is freshly submitted.
  //
  // INVARIANT (domain §5): adjudication is atomic across all of a claim's lines — they are
  // adjudicated together in a single synchronous pass. A claim is therefore either fully
  // pre-adjudication (every line AWAITING_ADJUDICATION) or fully post-adjudication (no line
  // AWAITING_ADJUDICATION); a partial mix such as [AWAITING_ADJUDICATION, APPROVED] cannot occur.
  // Because of this invariant `every` is intentional and correct here — `any` would be wrong, as
  // there is no transient "partially adjudicated" claim state to express. If the invariant were
  // ever violated, a stray AWAITING line would fall through to the outcome guards below rather
  // than corrupting the SUBMITTED result.
  if (lineStates.every((state) => state === LineState.AWAITING_ADJUDICATION)) {
    return ClaimState.SUBMITTED;
  }

  // Guard 1 — any line still needs review ⇒ the claim is not finished.
  if (lineStates.some((state) => state === LineState.NEEDS_REVIEW)) {
    return ClaimState.UNDER_REVIEW;
  }

  // Guard 2 — there is at least one payable line and every payable line is PAID.
  // (Denied lines are not payable, so a PAID + DENIED mix still resolves to PAID.)
  const payableLines = lineStates.filter((state) => PAYABLE_LINE_STATES.includes(state));
  if (payableLines.length > 0 && payableLines.every((state) => state === LineState.PAID)) {
    return ClaimState.PAID;
  }

  // Guard 3 — every line denied.
  if (lineStates.every((state) => state === LineState.DENIED)) {
    return ClaimState.DENIED;
  }

  // Guard 4 — every line approved, none partial.
  if (lineStates.every((state) => state === LineState.APPROVED)) {
    return ClaimState.APPROVED;
  }

  // Guard 5 — any partial approval, or an approved/denied (or approved/paid) mix.
  return ClaimState.PARTIALLY_APPROVED;
}
