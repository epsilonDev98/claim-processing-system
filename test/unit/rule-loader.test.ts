import { expect } from 'chai';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZodError } from 'zod';
import { PolicyConfigError, loadPolicyConfig, parsePolicyConfig } from '../../src/config/rule-loader';

/** A valid §0.2 config in authored (snake_case) form, freshly built per test to allow mutation. */
function validConfig(): Record<string, unknown> {
  return {
    policy_id: 'POL-001',
    plan_year: 2026,
    annual_deductible: 50000,
    exclusions: ['EXPERIMENTAL'],
    coverage: [
      { service_category: 'PREVENTIVE_CARE', covered: true, coinsurance_rate: 0 },
      {
        service_category: 'PHYSICAL_THERAPY',
        covered: true,
        coinsurance_rate: 0.2,
        annual_limit: 400000,
        copay: 2500,
      },
      {
        service_category: 'DIAGNOSTIC_IMAGING',
        covered: true,
        coinsurance_rate: 0.1,
        review_threshold: 1000000,
      },
      { service_category: 'EXPERIMENTAL', covered: true, coinsurance_rate: 0.2 },
      { service_category: 'COSMETIC', covered: false },
    ],
  };
}

describe('coverage rule loader (S13 — strict config, never a DSL)', () => {
  describe('accepts valid configuration', () => {
    it('loads the §0.2 fixture file into typed structs', () => {
      const config = loadPolicyConfig(
        path.resolve(process.cwd(), 'policies/standard-plan-2026.json'),
      );

      expect(config.policyId).to.equal('POL-001');
      expect(config.planYear).to.equal(2026);
      expect(config.annualDeductibleMinor).to.equal(50000);
      expect(config.exclusions).to.deep.equal(['EXPERIMENTAL']);
      expect(config.rules).to.have.length(5);

      const pt = config.rules.find((r) => r.serviceCategory === 'PHYSICAL_THERAPY');
      expect(pt).to.include({
        covered: true,
        coinsuranceRate: 0.2,
        annualLimitMinor: 400000,
        copayMinor: 2500,
      });

      // A non-covered rule carries ONLY the natural key + flag (the discriminated union).
      const cosmetic = config.rules.find((r) => r.serviceCategory === 'COSMETIC');
      expect(cosmetic?.covered).to.equal(false);
      expect(cosmetic && Object.keys(cosmetic).sort()).to.deep.equal(['covered', 'serviceCategory']);

      const imaging = config.rules.find((r) => r.serviceCategory === 'DIAGNOSTIC_IMAGING');
      expect(imaging?.covered).to.equal(true);
      if (imaging?.covered) {
        expect(imaging.reviewThresholdMinor).to.equal(1000000);
      }
    });

    it('parses an in-memory valid config', () => {
      expect(() => parsePolicyConfig(validConfig())).to.not.throw();
    });
  });

  describe('rejects unknown fields (no surrogate ids, no control flags)', () => {
    it('fails fast on an unknown rule field and names it', () => {
      const config = validConfig();
      (config.coverage as Array<Record<string, unknown>>)[1]!.priority = 1;

      let caught: unknown;
      try {
        parsePolicyConfig(config);
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(ZodError);
      expect((caught as ZodError).message).to.include('priority');
    });
  });

  describe('rejects bad types and out-of-range values', () => {
    it('rejects a non-numeric coinsurance_rate', () => {
      const config = validConfig();
      (config.coverage as Array<Record<string, unknown>>)[1]!.coinsurance_rate = 'twenty percent';
      expect(() => parsePolicyConfig(config)).to.throw(ZodError);
    });

    it('rejects a coinsurance_rate above 1', () => {
      const config = validConfig();
      (config.coverage as Array<Record<string, unknown>>)[1]!.coinsurance_rate = 1.5;
      expect(() => parsePolicyConfig(config)).to.throw(ZodError);
    });

    it('rejects a non-integer / negative minor-unit field', () => {
      const config = validConfig();
      (config.coverage as Array<Record<string, unknown>>)[1]!.annual_limit = -100;
      expect(() => parsePolicyConfig(config)).to.throw(ZodError);
    });

    it('rejects an out-of-range plan_year', () => {
      const tooLow = { ...validConfig(), plan_year: 0 };
      const tooHigh = { ...validConfig(), plan_year: 9999 };
      expect(() => parsePolicyConfig(tooLow)).to.throw(ZodError);
      expect(() => parsePolicyConfig(tooHigh)).to.throw(ZodError);
    });
  });

  describe('rejects DSL smells (configuration carries values, never expressions)', () => {
    for (const smell of ['condition', 'expression', 'formula', 'operator']) {
      it(`rejects a rule containing '${smell}'`, () => {
        const config = validConfig();
        (config.coverage as Array<Record<string, unknown>>)[1]![smell] = 'anything';
        expect(() => parsePolicyConfig(config)).to.throw(ZodError);
      });
    }
  });

  describe('cross-field and uniqueness rules', () => {
    it('rejects a non-covered rule that carries cost-share/limit fields', () => {
      const config = validConfig();
      const coverage = config.coverage as Array<Record<string, unknown>>;
      coverage[4] = { service_category: 'COSMETIC', covered: false, annual_limit: 100000 };
      expect(() => parsePolicyConfig(config)).to.throw(ZodError);
    });

    it('rejects a covered rule missing the required coinsurance_rate', () => {
      const config = validConfig();
      const coverage = config.coverage as Array<Record<string, unknown>>;
      coverage[0] = { service_category: 'PREVENTIVE_CARE', covered: true };
      expect(() => parsePolicyConfig(config)).to.throw(ZodError);
    });

    it('rejects a duplicate service_category (one promise per category)', () => {
      const config = validConfig();
      (config.coverage as Array<Record<string, unknown>>).push({
        service_category: 'PHYSICAL_THERAPY',
        covered: true,
        coinsurance_rate: 0.3,
      });
      let caught: unknown;
      try {
        parsePolicyConfig(config);
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(ZodError);
      expect((caught as ZodError).message).to.include('PHYSICAL_THERAPY');
    });
  });

  describe('I/O and JSON errors fail fast', () => {
    it('throws when the file does not exist', () => {
      expect(() => loadPolicyConfig(path.resolve(process.cwd(), 'policies/does-not-exist.json'))).to.throw(
        /Cannot read policy config/,
      );
    });

    it('throws PolicyConfigError on invalid JSON syntax', () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'rule-loader-'));
      const file = path.join(dir, 'malformed.json');
      try {
        writeFileSync(file, '{ "policy_id": "POL-001", "coverage": [ }', 'utf8');
        expect(() => loadPolicyConfig(file)).to.throw(PolicyConfigError, /not valid JSON/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
