import { expect } from 'chai';
import {
  ClaimState,
  DisputeState,
  IllegalTransitionError,
  LineState,
  assertDisputeTransition,
  assertLineTransition,
  canDisputeTransition,
  canLineTransition,
} from '../../src/domain/states';

describe('state transition guards (domain §6)', () => {
  describe('line state machine', () => {
    it('allows the adjudication outcome edges from AWAITING_ADJUDICATION', () => {
      expect(() => assertLineTransition(LineState.AWAITING_ADJUDICATION, LineState.APPROVED)).to.not.throw();
      expect(() => assertLineTransition(LineState.AWAITING_ADJUDICATION, LineState.PARTIALLY_APPROVED)).to.not.throw();
      expect(() => assertLineTransition(LineState.AWAITING_ADJUDICATION, LineState.DENIED)).to.not.throw();
      expect(() => assertLineTransition(LineState.AWAITING_ADJUDICATION, LineState.NEEDS_REVIEW)).to.not.throw();
    });

    it('allows a pended line to resolve to a decision', () => {
      expect(() => assertLineTransition(LineState.NEEDS_REVIEW, LineState.APPROVED)).to.not.throw();
      expect(() => assertLineTransition(LineState.NEEDS_REVIEW, LineState.PARTIALLY_APPROVED)).to.not.throw();
      expect(() => assertLineTransition(LineState.NEEDS_REVIEW, LineState.DENIED)).to.not.throw();
    });

    it('allows payable lines to be paid', () => {
      expect(() => assertLineTransition(LineState.APPROVED, LineState.PAID)).to.not.throw();
      expect(() => assertLineTransition(LineState.PARTIALLY_APPROVED, LineState.PAID)).to.not.throw();
    });

    it('allows dispute-overturn edges off DENIED', () => {
      expect(() => assertLineTransition(LineState.DENIED, LineState.APPROVED)).to.not.throw();
      expect(() => assertLineTransition(LineState.DENIED, LineState.PARTIALLY_APPROVED)).to.not.throw();
    });

    it('allows the re-adjudication self-loop on APPROVED', () => {
      expect(() => assertLineTransition(LineState.APPROVED, LineState.APPROVED)).to.not.throw();
    });

    it('rejects AWAITING_ADJUDICATION → PAID (must be adjudicated first)', () => {
      expect(() => assertLineTransition(LineState.AWAITING_ADJUDICATION, LineState.PAID)).to.throw(
        IllegalTransitionError,
      );
    });

    it('rejects DENIED → PAID (nothing payable)', () => {
      expect(() => assertLineTransition(LineState.DENIED, LineState.PAID)).to.throw(IllegalTransitionError);
    });

    it('rejects NEEDS_REVIEW → PAID (decision required before payment)', () => {
      expect(() => assertLineTransition(LineState.NEEDS_REVIEW, LineState.PAID)).to.throw(IllegalTransitionError);
    });

    it('rejects any transition out of the terminal PAID state', () => {
      expect(() => assertLineTransition(LineState.PAID, LineState.APPROVED)).to.throw(IllegalTransitionError);
    });

    it('canLineTransition mirrors the guard without throwing', () => {
      expect(canLineTransition(LineState.APPROVED, LineState.PAID)).to.equal(true);
      expect(canLineTransition(LineState.DENIED, LineState.PAID)).to.equal(false);
    });
  });

  describe('dispute state machine', () => {
    it('allows the OPEN → UNDER_REVIEW → RESOLVED → CLOSED happy path', () => {
      expect(() => assertDisputeTransition(DisputeState.OPEN, DisputeState.UNDER_REVIEW)).to.not.throw();
      expect(() => assertDisputeTransition(DisputeState.UNDER_REVIEW, DisputeState.RESOLVED)).to.not.throw();
      expect(() => assertDisputeTransition(DisputeState.RESOLVED, DisputeState.CLOSED)).to.not.throw();
    });

    it('allows withdrawal from OPEN and UNDER_REVIEW', () => {
      expect(() => assertDisputeTransition(DisputeState.OPEN, DisputeState.WITHDRAWN)).to.not.throw();
      expect(() => assertDisputeTransition(DisputeState.UNDER_REVIEW, DisputeState.WITHDRAWN)).to.not.throw();
      expect(() => assertDisputeTransition(DisputeState.WITHDRAWN, DisputeState.CLOSED)).to.not.throw();
    });

    it('rejects skipping review (OPEN → RESOLVED)', () => {
      expect(() => assertDisputeTransition(DisputeState.OPEN, DisputeState.RESOLVED)).to.throw(
        IllegalTransitionError,
      );
    });

    it('rejects reopening a CLOSED dispute', () => {
      expect(() => assertDisputeTransition(DisputeState.CLOSED, DisputeState.OPEN)).to.throw(
        IllegalTransitionError,
      );
    });

    it('canDisputeTransition mirrors the guard without throwing', () => {
      expect(canDisputeTransition(DisputeState.OPEN, DisputeState.UNDER_REVIEW)).to.equal(true);
      expect(canDisputeTransition(DisputeState.OPEN, DisputeState.RESOLVED)).to.equal(false);
    });
  });

  describe('IllegalTransitionError carries context', () => {
    it('names the machine, from, and to', () => {
      try {
        assertLineTransition(LineState.DENIED, LineState.PAID);
        expect.fail('expected IllegalTransitionError');
      } catch (err) {
        expect(err).to.be.instanceOf(IllegalTransitionError);
        const e = err as IllegalTransitionError;
        expect(e.machine).to.equal('Line');
        expect(e.from).to.equal(LineState.DENIED);
        expect(e.to).to.equal(LineState.PAID);
      }
    });
  });

  describe('no stored DISPUTED state exists (domain §6)', () => {
    it('is absent from both ClaimState and LineState', () => {
      expect(Object.values(ClaimState)).to.not.include('DISPUTED');
      expect(Object.values(LineState)).to.not.include('DISPUTED');
    });
  });
});
