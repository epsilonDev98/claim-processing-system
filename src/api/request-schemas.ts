/**
 * Zod schemas for request bodies (implementation-plan §10). The API boundary validates shape/types;
 * the services additionally enforce domain rules (duplicate lines, blank fields, lifecycle). All
 * objects are `.strict()` so unknown fields are rejected.
 */

import { z } from 'zod';
import { DisputeOutcome } from '../domain/states';

export const submitClaimSchema = z
  .object({
    memberId: z.string().min(1),
    policyId: z.string().min(1),
    provider: z.string().min(1),
    dateOfService: z.string().min(1),
    lines: z
      .array(
        z
          .object({
            serviceCode: z.string().min(1),
            serviceCategory: z.string().min(1),
            diagnosisCode: z.string().optional().default(''),
            billedMinor: z.number().int().nonnegative(),
            units: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const openDisputeSchema = z
  .object({
    lineIds: z.array(z.string().min(1)).min(1),
    reason: z.string().min(1),
  })
  .strict();

const lineCorrectionSchema = z
  .object({
    serviceCode: z.string().min(1).optional(),
    serviceCategory: z.string().min(1).optional(),
    diagnosisCode: z.string().optional(),
    billedMinor: z.number().int().nonnegative().optional(),
    units: z.number().int().positive().optional(),
  })
  .strict();

export const resolveDisputeSchema = z
  .object({
    outcome: z.nativeEnum(DisputeOutcome),
    note: z.string().min(1),
    corrections: z.record(z.string().min(1), lineCorrectionSchema).optional(),
  })
  .strict();
