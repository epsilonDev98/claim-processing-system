import { expect } from 'chai';
import { ALL_REASON_CODES, ReasonCode } from '../../src/domain/codes';
import type { ExplanationCode } from '../../src/domain/entities';
import {
  CatalogIncompleteError,
  EXPLANATION_CATALOG,
  assertCatalogComplete,
  getExplanationCode,
} from '../../src/config/explanation-catalog';

describe('explanation catalog (S14 — completeness is a startup invariant)', () => {
  it('every reason code in the closed enum resolves to a catalog row', () => {
    expect(() => assertCatalogComplete(ALL_REASON_CODES)).to.not.throw();
  });

  it('the default boot-time check passes for the shipped catalog', () => {
    expect(() => assertCatalogComplete()).to.not.throw();
  });

  it('matches the §0.3 catalog text and category for representative codes', () => {
    const covered = getExplanationCode(ReasonCode.COVERED);
    expect(covered.shortMessage).to.equal('Service fully covered.');
    expect(covered.detailTemplate).to.equal(
      'This service is covered in full under your {category} benefit.',
    );
    expect(covered.category).to.equal('approval');

    expect(getExplanationCode(ReasonCode.ANNUAL_LIMIT_REACHED).category).to.equal('denial');
    expect(getExplanationCode(ReasonCode.PENDED_FOR_REVIEW).category).to.equal('pend');
  });

  it('fails at startup if a used reason code is missing from the catalog', () => {
    const partial: Record<string, ExplanationCode> = { ...EXPLANATION_CATALOG };
    delete partial[ReasonCode.COVERED];
    expect(() => assertCatalogComplete(ALL_REASON_CODES, partial)).to.throw(CatalogIncompleteError);
  });

  it('the incompleteness error names the offending code(s)', () => {
    const partial: Record<string, ExplanationCode> = { ...EXPLANATION_CATALOG };
    delete partial[ReasonCode.NOT_COVERED];
    try {
      assertCatalogComplete(ALL_REASON_CODES, partial);
      expect.fail('expected CatalogIncompleteError');
    } catch (err) {
      expect(err).to.be.instanceOf(CatalogIncompleteError);
      expect((err as CatalogIncompleteError).missing).to.include(ReasonCode.NOT_COVERED);
    }
  });
});
