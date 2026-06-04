/**
 * Coverage-rule configuration schema (domain-model §4, acceptance S13).
 *
 * This is THE configuration-vs-DSL guard, expressed in code:
 *   - `.strict()` on every object ⇒ any unknown field fails fast. This catches surrogate ids
 *     (`rule_id`), control flags (`priority`), and — crucially — the DSL smells
 *     (`condition`, `expression`, `formula`, `operator`) without enumerating them. JSON may
 *     carry values only, never expressions.
 *   - Type/range checks: `coinsurance_rate` is a 0..1 number; every `*_minor`/limit/threshold
 *     is a non-negative integer.
 *   - Cross-field rule: a non-covered category carries ONLY `service_category` + `covered`
 *     (a non-covered benefit has no cost-share math). Enforced via a discriminated union.
 *   - Uniqueness: a `service_category` is the natural key — duplicates are a load-time error.
 *
 * The schema mirrors the AUTHORED (snake_case) JSON form; `rule-loader` maps it to the typed
 * camelCase `CoverageRule` domain structs.
 */

import { z } from 'zod';

/** Money/limit fields are whole, non-negative minor units (or counts). */
const nonNegativeInt = z.number().int().nonnegative();

/** A covered category: cost-share + optional limits/threshold. `coinsurance_rate` is required. */
const coveredRuleSchema = z
  .object({
    service_category: z.string().min(1),
    covered: z.literal(true),
    annual_limit: nonNegativeInt.optional(),
    visit_limit: nonNegativeInt.optional(),
    per_incident_max: nonNegativeInt.optional(),
    coinsurance_rate: z.number().min(0).max(1),
    copay: nonNegativeInt.optional(),
    review_threshold: nonNegativeInt.optional(),
  })
  .strict();

/** A non-covered category: only the natural key + the flag. No math fields permitted. */
const nonCoveredRuleSchema = z
  .object({
    service_category: z.string().min(1),
    covered: z.literal(false),
  })
  .strict();

export const coverageRuleSchema = z.discriminatedUnion('covered', [
  coveredRuleSchema,
  nonCoveredRuleSchema,
]);

export const policyConfigSchema = z
  .object({
    policy_id: z.string().min(1),
    // A four-digit calendar year; rejects nonsense like 0 or negative "years".
    plan_year: z.number().int().min(1900).max(3000),
    annual_deductible: nonNegativeInt,
    exclusions: z.array(z.string().min(1)).default([]),
    coverage: z.array(coverageRuleSchema).min(1),
  })
  .strict()
  .superRefine((config, ctx) => {
    // Exactly one promise per service category (natural key, no surrogate id).
    const seen = new Set<string>();
    config.coverage.forEach((rule, index) => {
      if (seen.has(rule.service_category)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['coverage', index, 'service_category'],
          message: `Duplicate service_category '${rule.service_category}': exactly one promise per category.`,
        });
      }
      seen.add(rule.service_category);
    });
  });

export type CoverageRuleInput = z.infer<typeof coverageRuleSchema>;
export type PolicyConfigInput = z.infer<typeof policyConfigSchema>;
