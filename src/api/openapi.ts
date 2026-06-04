/**
 * OpenAPI 3.0 document for the claim-processing API. Hand-authored to mirror the route table in
 * routes.ts, the Zod request schemas in request-schemas.ts, and the DTO shapes in serializers.ts.
 * Served as JSON at /openapi.json and rendered as interactive docs at /docs (server.ts).
 *
 * All money fields are integer minor units (e.g. cents). Diagnosis codes and member names are
 * never serialized in responses (PHI minimization) — they are absent from the response schemas.
 */

import type { OpenAPIV3 } from './openapi-types';

const claimStates = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'PAID'];
const lineStates = ['AWAITING_ADJUDICATION', 'NEEDS_REVIEW', 'APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'PAID'];
const disputeStates = ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CLOSED', 'WITHDRAWN'];
const disputeOutcomes = ['UPHELD', 'OVERTURNED', 'PARTIALLY_OVERTURNED'];

export const openApiDocument: OpenAPIV3 = {
  openapi: '3.0.3',
  info: {
    title: 'Claim Processing System API',
    version: '0.1.0',
    description:
      'Insurance claims adjudication: fixed pipeline, append-only ledger, derived claim state.\n\n' +
      'All monetary amounts are integer **minor units** (e.g. cents). Responses are PHI-minimizing — ' +
      'member names and line diagnosis codes are never returned.',
  },
  servers: [{ url: '/', description: 'This server' }],
  tags: [
    { name: 'Claims', description: 'Submit, adjudicate, inspect, and pay claims.' },
    { name: 'Disputes', description: 'Open, review, and resolve disputes against adjudicated lines.' },
    { name: 'Policies', description: 'Policy coverage rules and exclusions.' },
    { name: 'System', description: 'Operational endpoints.' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Liveness probe',
        responses: {
          '200': {
            description: 'Service is up',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { status: { type: 'string', example: 'ok' }, service: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    '/claims': {
      post: {
        tags: ['Claims'],
        summary: 'Submit a new claim',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitClaimRequest' } } },
        },
        responses: {
          '201': {
            description: 'Claim created (state SUBMITTED)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    claimId: { type: 'string' },
                    state: { type: 'string', enum: claimStates },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
    },
    '/claims/{claimId}': {
      get: {
        tags: ['Claims'],
        summary: 'Get a claim with its lines, current adjudications, and explanations',
        parameters: [{ $ref: '#/components/parameters/ClaimId' }],
        responses: {
          '200': {
            description: 'Claim view',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ClaimView' } } },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/claims/{claimId}/adjudicate': {
      post: {
        tags: ['Claims'],
        summary: 'Run the adjudication pipeline over all lines',
        parameters: [{ $ref: '#/components/parameters/ClaimId' }],
        responses: {
          '200': {
            description: 'Adjudication summary',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AdjudicationSummary' } } },
          },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/claims/{claimId}/ledger': {
      get: {
        tags: ['Claims'],
        summary: "Get the member's usage-ledger balances and entries for the claim's plan year",
        parameters: [{ $ref: '#/components/parameters/ClaimId' }],
        responses: {
          '200': {
            description: 'Ledger view',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/LedgerView' } } },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/claims/{claimId}/pay': {
      post: {
        tags: ['Claims'],
        summary: 'Pay approved lines on a claim',
        parameters: [{ $ref: '#/components/parameters/ClaimId' }],
        responses: {
          '200': {
            description: 'Adjudication summary after payment',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AdjudicationSummary' } } },
          },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/claims/{claimId}/lines/{lineId}/resolve-review': {
      post: {
        tags: ['Claims'],
        summary: 'Resolve a manual-review pend on a single line',
        parameters: [{ $ref: '#/components/parameters/ClaimId' }, { $ref: '#/components/parameters/LineId' }],
        responses: {
          '200': {
            description: 'Adjudication summary after the review is resolved',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AdjudicationSummary' } } },
          },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/claims/{claimId}/disputes': {
      post: {
        tags: ['Disputes'],
        summary: 'Open a dispute against one or more adjudicated lines',
        parameters: [{ $ref: '#/components/parameters/ClaimId' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/OpenDisputeRequest' } } },
        },
        responses: {
          '201': {
            description: 'Dispute opened',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    disputeId: { type: 'string' },
                    claimId: { type: 'string' },
                    state: { type: 'string', enum: disputeStates },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/disputes/{disputeId}': {
      get: {
        tags: ['Disputes'],
        summary: 'Get a dispute with per-line adjudication history',
        parameters: [{ $ref: '#/components/parameters/DisputeId' }],
        responses: {
          '200': {
            description: 'Dispute view',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DisputeView' } } },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/disputes/{disputeId}/start-review': {
      post: {
        tags: ['Disputes'],
        summary: 'Move a dispute OPEN → UNDER_REVIEW',
        parameters: [{ $ref: '#/components/parameters/DisputeId' }],
        responses: {
          '200': {
            description: 'Dispute now under review',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    disputeId: { type: 'string' },
                    state: { type: 'string', enum: disputeStates },
                  },
                },
              },
            },
          },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/disputes/{disputeId}/resolve': {
      post: {
        tags: ['Disputes'],
        summary: 'Resolve a dispute (optionally re-adjudicating lines with corrections)',
        parameters: [{ $ref: '#/components/parameters/DisputeId' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ResolveDisputeRequest' } } },
        },
        responses: {
          '200': {
            description: 'Dispute resolved',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    dispute: {
                      type: 'object',
                      properties: {
                        disputeId: { type: 'string' },
                        state: { type: 'string', enum: disputeStates },
                        resolutionOutcome: { type: 'string', enum: disputeOutcomes },
                        resolutionNote: { type: 'string' },
                      },
                    },
                    adjudication: { $ref: '#/components/schemas/AdjudicationSummary' },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/policies/{policyId}': {
      get: {
        tags: ['Policies'],
        summary: 'Get a policy with coverage rules and exclusions',
        parameters: [{ $ref: '#/components/parameters/PolicyId' }],
        responses: {
          '200': {
            description: 'Policy view',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PolicyView' } } },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
  },
  components: {
    parameters: {
      ClaimId: { name: 'claimId', in: 'path', required: true, schema: { type: 'string' } },
      LineId: { name: 'lineId', in: 'path', required: true, schema: { type: 'string' } },
      DisputeId: { name: 'disputeId', in: 'path', required: true, schema: { type: 'string' } },
      PolicyId: { name: 'policyId', in: 'path', required: true, schema: { type: 'string' } },
    },
    responses: {
      ValidationError: {
        description: 'Request failed validation',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      NotFound: {
        description: 'Resource not found',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Conflict: {
        description: 'Illegal state transition or domain conflict',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', description: 'Error class name', example: 'NotFoundError' },
          message: { type: 'string' },
          issues: { type: 'array', items: { type: 'object' }, description: 'Present for ValidationError (Zod issues)' },
        },
      },
      MinorUnits: {
        type: 'integer',
        description: 'Monetary amount in integer minor units (e.g. cents).',
        example: 12500,
      },
      ClaimLineInput: {
        type: 'object',
        required: ['serviceCode', 'serviceCategory', 'billedMinor', 'units'],
        properties: {
          serviceCode: { type: 'string', minLength: 1 },
          serviceCategory: { type: 'string', minLength: 1 },
          diagnosisCode: { type: 'string', description: 'Optional; stored but never returned (PHI).', default: '' },
          billedMinor: { $ref: '#/components/schemas/MinorUnits' },
          units: { type: 'integer', minimum: 1 },
        },
      },
      SubmitClaimRequest: {
        type: 'object',
        required: ['memberId', 'policyId', 'provider', 'dateOfService', 'lines'],
        properties: {
          memberId: { type: 'string', minLength: 1 },
          policyId: { type: 'string', minLength: 1 },
          provider: { type: 'string', minLength: 1 },
          dateOfService: { type: 'string', minLength: 1, example: '2026-01-15' },
          lines: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/ClaimLineInput' } },
        },
      },
      OpenDisputeRequest: {
        type: 'object',
        required: ['lineIds', 'reason'],
        properties: {
          lineIds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          reason: { type: 'string', minLength: 1 },
        },
      },
      LineCorrection: {
        type: 'object',
        description: 'Partial override of a line for re-adjudication. All fields optional.',
        properties: {
          serviceCode: { type: 'string', minLength: 1 },
          serviceCategory: { type: 'string', minLength: 1 },
          diagnosisCode: { type: 'string' },
          billedMinor: { $ref: '#/components/schemas/MinorUnits' },
          units: { type: 'integer', minimum: 1 },
        },
      },
      ResolveDisputeRequest: {
        type: 'object',
        required: ['outcome', 'note'],
        properties: {
          outcome: { type: 'string', enum: disputeOutcomes },
          note: { type: 'string', minLength: 1 },
          corrections: {
            type: 'object',
            description: 'Map of lineId → correction. Required when outcome re-adjudicates lines.',
            additionalProperties: { $ref: '#/components/schemas/LineCorrection' },
          },
        },
      },
      AdjudicationView: {
        type: 'object',
        properties: {
          sequence: { type: 'integer' },
          isCurrent: { type: 'boolean' },
          decisionCode: { type: 'string' },
          reasonCodes: { type: 'array', items: { type: 'string' } },
          allowedMinor: { $ref: '#/components/schemas/MinorUnits' },
          deductibleAppliedMinor: { $ref: '#/components/schemas/MinorUnits' },
          coinsuranceMinor: { $ref: '#/components/schemas/MinorUnits' },
          copayMinor: { $ref: '#/components/schemas/MinorUnits' },
          payableMinor: { $ref: '#/components/schemas/MinorUnits' },
          memberRespMinor: { $ref: '#/components/schemas/MinorUnits' },
          adjudicatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Explanation: {
        type: 'object',
        description: 'Derived, human-readable explanation of the line decision (never persisted).',
        additionalProperties: true,
      },
      LineView: {
        type: 'object',
        properties: {
          lineId: { type: 'string' },
          serviceCode: { type: 'string' },
          serviceCategory: { type: 'string' },
          billedMinor: { $ref: '#/components/schemas/MinorUnits' },
          units: { type: 'integer' },
          state: { type: 'string', enum: lineStates },
          adjudication: { allOf: [{ $ref: '#/components/schemas/AdjudicationView' }], nullable: true },
          explanation: { allOf: [{ $ref: '#/components/schemas/Explanation' }], nullable: true },
        },
      },
      ClaimView: {
        type: 'object',
        properties: {
          claimId: { type: 'string' },
          memberId: { type: 'string' },
          policyId: { type: 'string' },
          provider: { type: 'string' },
          dateOfService: { type: 'string' },
          state: { type: 'string', enum: claimStates },
          isDisputed: { type: 'boolean' },
          lines: { type: 'array', items: { $ref: '#/components/schemas/LineView' } },
        },
      },
      AdjudicationSummary: {
        type: 'object',
        description: 'Result of running the pipeline (claim state plus per-line outcomes).',
        additionalProperties: true,
      },
      LedgerView: {
        type: 'object',
        properties: {
          memberId: { type: 'string' },
          period: { type: 'integer', description: 'Plan year' },
          balances: { type: 'object', additionalProperties: { type: 'integer' } },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                entryId: { type: 'string' },
                bucket: { type: 'string' },
                amountOrCount: { type: 'integer' },
                sourceLineId: { type: 'string' },
                createdAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      DisputeView: {
        type: 'object',
        properties: {
          disputeId: { type: 'string' },
          claimId: { type: 'string' },
          lineIds: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
          state: { type: 'string', enum: disputeStates },
          resolutionOutcome: { type: 'string', enum: disputeOutcomes },
          resolutionNote: { type: 'string' },
          openedAt: { type: 'string', format: 'date-time' },
          resolvedAt: { type: 'string', format: 'date-time' },
          adjudicationHistory: {
            type: 'object',
            additionalProperties: { type: 'array', items: { $ref: '#/components/schemas/AdjudicationView' } },
          },
        },
      },
      PolicyView: {
        type: 'object',
        properties: {
          policyId: { type: 'string' },
          memberId: { type: 'string' },
          effectiveDate: { type: 'string' },
          terminationDate: { type: 'string', nullable: true },
          planYear: { type: 'integer' },
          annualDeductibleMinor: { $ref: '#/components/schemas/MinorUnits' },
          exclusions: { type: 'array', items: { type: 'string' } },
          coverage: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
    },
  },
};
