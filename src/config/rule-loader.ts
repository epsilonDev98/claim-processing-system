/**
 * Coverage-rule loader (domain-model §4/§6, acceptance S13).
 *
 * Reads authored JSON → validates with the strict schema (fail fast on the first violation) →
 * maps to typed camelCase `CoverageRule` domain structs. No interpreter, no priority field,
 * no rule ids — pipeline ordering lives only in `pipeline/`.
 */

import { readFileSync } from 'node:fs';
import type { CoverageRule, CoveredRule } from '../domain/entities';
import { type CoverageRuleInput, type PolicyConfigInput, policyConfigSchema } from './rule-schema';

/** A validated policy configuration: header values, policy-level exclusions, and typed rules. */
export interface LoadedPolicyConfig {
  policyId: string;
  planYear: number;
  annualDeductibleMinor: number;
  exclusions: string[];
  rules: CoverageRule[];
}

/** Thrown for I/O and JSON-syntax failures. Schema violations surface as ZodError (field-named). */
export class PolicyConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PolicyConfigError';
  }
}

/** Validate already-parsed config data (no file I/O). Throws ZodError on any violation. */
export function parsePolicyConfig(data: unknown): LoadedPolicyConfig {
  const config = policyConfigSchema.parse(data);
  return mapConfig(config);
}

/** Read + validate a policy config file. Fails fast on read, JSON-parse, or schema errors. */
export function loadPolicyConfig(path: string): LoadedPolicyConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new PolicyConfigError(`Cannot read policy config at '${path}'.`, { cause: err });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new PolicyConfigError(`Policy config at '${path}' is not valid JSON.`, { cause: err });
  }

  return parsePolicyConfig(json);
}

function mapConfig(config: PolicyConfigInput): LoadedPolicyConfig {
  return {
    policyId: config.policy_id,
    planYear: config.plan_year,
    annualDeductibleMinor: config.annual_deductible,
    exclusions: config.exclusions,
    rules: config.coverage.map(toCoverageRule),
  };
}

function toCoverageRule(input: CoverageRuleInput): CoverageRule {
  if (!input.covered) {
    // A non-covered category carries only the natural key + flag (no cost-share math exists).
    return { serviceCategory: input.service_category, covered: false };
  }

  // Optional fields are added only when present (exactOptionalPropertyTypes: no `undefined` writes).
  const rule: CoveredRule = {
    serviceCategory: input.service_category,
    covered: true,
    coinsuranceRate: input.coinsurance_rate,
  };
  if (input.annual_limit !== undefined) rule.annualLimitMinor = input.annual_limit;
  if (input.visit_limit !== undefined) rule.visitLimit = input.visit_limit;
  if (input.per_incident_max !== undefined) rule.perIncidentMaxMinor = input.per_incident_max;
  if (input.copay !== undefined) rule.copayMinor = input.copay;
  if (input.review_threshold !== undefined) rule.reviewThresholdMinor = input.review_threshold;
  return rule;
}
