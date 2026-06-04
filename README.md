# Claim Processing System

Insurance claims adjudication service: a **fixed adjudication pipeline**, an **append-only usage ledger**, and **derived claim state** (claim state is projected from line states, never stored directly). Built with TypeScript, Express, Prisma, and SQLite.

- Money is always integer **minor units** (cents) — never floats.
- Adjudication is append-only: each (re-)adjudication adds a new row; exactly one is current per line.
- Responses are PHI-minimizing: member names and line diagnosis codes are never returned.

See [`docs/domain-model.md`](docs/domain-model.md) and [`docs/detailed-design.md`](docs/detailed-design.md) for the full design.

---

## Prerequisites

- **Node.js ≥ 18.18** (see `engines` in `package.json`)
- **npm** (ships with Node)

No external database server is required — persistence is local SQLite via Prisma.

---

## Quickstart

```bash
# 1. Install dependencies
npm install

# 2. Create your local env file (the repo does NOT ship a committed .env)
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env

# 3. Generate the Prisma client + apply the migration (creates prisma/dev.db)
npm run migrate

# 4. Seed reference data (members, policies, coverage rules, explanation catalog)
npm run seed

# 5. Start the API (defaults to http://localhost:3000)
npm run dev
```

Verify it's up:

```bash
curl http://localhost:3000/health
# {"status":"ok","service":"claim-processing-system"}
```

Then open the interactive API docs: **http://localhost:3000/docs**

> **Want to run only the tests?** You can skip steps 3–5 entirely — the test suite uses in-memory repositories and needs no database. See [Testing](#testing).

---

## Environment variables

Copy `.env.example` to `.env` and adjust as needed. Prisma resolves the SQLite `file:` path **relative to `prisma/schema.prisma`**, so `file:./dev.db` lives at `prisma/dev.db`.

| Variable | Used by | Required | Default | Notes |
|----------|---------|----------|---------|-------|
| `DATABASE_URL` | Prisma datasource (migrate, seed, dev server) | **Yes** | `file:./dev.db` | Must be a local SQLite `file:` URL. The seed refuses to run against anything else. |
| `PORT` | Express server (`src/index.ts`) | No | `3000` | Integer 1–65535. |
| `POLICY_CONFIG_PATH` | Rule loader (seed; optional at boot) | No | `./policies/standard-plan-2026.json` | The coverage-rule config the strict loader validates and the seed loads. |
| `TEST_DATABASE_URL` | — | No | — | **Currently unused** — declared for future test-DB isolation but not read by any code or test. Safe to ignore. |
| `CURRENCY` | — | No | `USD` | **Currently unused** — documents the single-currency assumption (domain §10.1); not read by any code. |

---

## Database & migrations

The committed migration lives in `prisma/migrations/`. The schema is in `prisma/schema.prisma`.

**Standard (local development):**

```bash
npm run migrate     # prisma migrate dev — applies migrations AND regenerates the client
npm run seed        # loads fixtures (idempotent: truncates then reloads)
```

**CI / non-interactive (applying existing migrations only):**

```bash
npx prisma migrate deploy   # applies migrations, does NOT generate the client
npm run generate            # prisma generate — required separately after `deploy`
```

> ⚠️ `prisma migrate deploy` does **not** regenerate the Prisma client. If you use it instead of `npm run migrate`, you must also run `npm run generate`, or the seed/server will fail to import the client.

**Reset the local database:**

```bash
npx prisma migrate reset    # drops, re-applies migrations, and re-runs the seed
```

The seed creates three members, each with their own copy of the standard plan (so accumulators are independent):

| Member | Policy |
|--------|--------|
| `M-001` | `POL-001` |
| `M-002` | `POL-002` |
| `M-003` | `POL-003` |

Coverage categories in the standard plan: `PREVENTIVE_CARE`, `PHYSICAL_THERAPY`, `DIAGNOSTIC_IMAGING`, `EXPERIMENTAL` (excluded), `COSMETIC` (not covered). Annual deductible: `50000` minor units ($500.00).

---

## Running the server

```bash
npm run dev      # ts-node, no build step
# or
npm run build && node dist/index.js
```

The server logs `claim-processing-system listening on port <PORT>` on boot. It fails fast if the explanation catalog is incomplete or the policy config is invalid.

---

## API documentation (Swagger)

- **Interactive UI:** http://localhost:3000/docs — browse every endpoint and use **Try it out** to send live requests.
- **Raw OpenAPI 3 spec:** http://localhost:3000/openapi.json — import into Postman/Insomnia or use for client codegen.

> The docs page renders without a database, but the **Try it out** calls hit real endpoints — so run `npm run migrate && npm run seed` first for them to return data.

### Endpoint summary

Listed in the order routes are registered in [`src/api/routes.ts`](src/api/routes.ts), which mirrors the typical claim lifecycle (submit → adjudicate → inspect → pay, then the dispute flow).

| # | Method | Path | Description |
|---|--------|------|-------------|
| 1 | `GET` | `/health` | Liveness probe |
| 2 | `POST` | `/claims` | Submit a new claim |
| 3 | `POST` | `/claims/:claimId/adjudicate` | Run the adjudication pipeline over all lines |
| 4 | `GET` | `/claims/:claimId` | Get a claim with lines, current adjudications, and explanations |
| 5 | `GET` | `/claims/:claimId/ledger` | Member's usage-ledger balances and entries for the plan year |
| 6 | `POST` | `/claims/:claimId/pay` | Pay approved lines |
| 7 | `POST` | `/claims/:claimId/lines/:lineId/resolve-review` | Resolve a manual-review pend on a line |
| 8 | `POST` | `/claims/:claimId/disputes` | Open a dispute against one or more lines |
| 9 | `POST` | `/disputes/:disputeId/start-review` | Move a dispute `OPEN → UNDER_REVIEW` |
| 10 | `POST` | `/disputes/:disputeId/resolve` | Resolve a dispute (optionally re-adjudicating with corrections) |
| 11 | `GET` | `/disputes/:disputeId` | Get a dispute with per-line adjudication history |
| 12 | `GET` | `/policies/:policyId` | Get a policy with coverage rules and exclusions |

---

## Endpoint reference (request & response payloads)

All monetary fields are integer **minor units** (cents): `25000` = $250.00. Request bodies are validated with strict Zod schemas — **unknown fields are rejected with `400`**. Endpoints that take no body are `POST`s driven entirely by path params.

Error responses share one shape: `{ "error": "<message>" }`. Status mapping (centralized in [`src/api/server.ts`](src/api/server.ts)): validation → `400`, not found → `404`, not-payable / conflict / illegal-transition → `409`.

### 1. `GET /health`

Liveness probe. No body.

**Response `200`**

```json
{ "status": "ok", "service": "claim-processing-system" }
```

---

### 2. `POST /claims`

Submit a new claim with one or more lines. `diagnosisCode` is optional (defaults to `""`) and is **never returned** in responses (PHI minimization).

**Request body**

```json
{
  "memberId": "M-001",
  "policyId": "POL-001",
  "provider": "Downtown Physio",
  "dateOfService": "2026-03-10",
  "lines": [
    {
      "serviceCode": "97110",
      "serviceCategory": "PHYSICAL_THERAPY",
      "diagnosisCode": "M54.5",
      "billedMinor": 25000,
      "units": 1
    }
  ]
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `memberId` | string | yes | Non-empty. Must match the policy's member. |
| `policyId` | string | yes | Non-empty. |
| `provider` | string | yes | Non-empty. |
| `dateOfService` | string | yes | Non-empty (`YYYY-MM-DD`). |
| `lines` | array | yes | At least one line. |
| `lines[].serviceCode` | string | yes | Non-empty. |
| `lines[].serviceCategory` | string | yes | Non-empty (e.g. `PHYSICAL_THERAPY`, `PREVENTIVE_CARE`). |
| `lines[].diagnosisCode` | string | no | Defaults to `""`. PHI — never serialized back. |
| `lines[].billedMinor` | integer | yes | ≥ 0, minor units. |
| `lines[].units` | integer | yes | > 0. |

**Response `201`**

```json
{ "claimId": "CLM-7f3a...", "state": "SUBMITTED" }
```

---

### 3. `POST /claims/:claimId/adjudicate`

Runs the fixed pipeline over every line and appends a new current adjudication per line. **No request body.** Returns the adjudication summary.

**Response `200`** (real output for this line as the member's **first** claim against a freshly seeded DB — the $500 annual deductible is untouched, so the full $250 allowed goes toward the deductible and the plan pays $0):

```json
{
  "claimId": "CLM-7f3a...",
  "claimState": "PARTIALLY_APPROVED",
  "lines": [
    {
      "lineId": "LN-1a2b...",
      "serviceCategory": "PHYSICAL_THERAPY",
      "decisionCode": "PARTIALLY_APPROVED",
      "reasonCodes": ["DEDUCTIBLE_APPLIED", "COPAY_APPLIED"],
      "lineState": "PARTIALLY_APPROVED",
      "allowedMinor": 25000,
      "deductibleAppliedMinor": 25000,
      "coinsuranceMinor": 0,
      "copayMinor": 2500,
      "payableMinor": 0,
      "memberRespMinor": 25000
    }
  ]
}
```

> Exact figures depend on the member's **accumulated deductible** at adjudication time. Once the $500 deductible is met, later claims show `deductibleAppliedMinor: 0` with coinsurance/copay applied and a non-zero `payableMinor`. `COVERED` appears only as a fallback when no cost-share/limit reason code applies (a fully-covered line).

- `claimState` ∈ `SUBMITTED | UNDER_REVIEW | APPROVED | PARTIALLY_APPROVED | DENIED | PAID` (derived from line states).
- `decisionCode` ∈ `APPROVED | PARTIALLY_APPROVED | DENIED | NEEDS_REVIEW`.
- `reasonCodes` ⊆ `COVERED, NOT_COVERED, EXCLUDED_SERVICE, POLICY_INACTIVE, DEDUCTIBLE_APPLIED, ANNUAL_LIMIT_APPLIED, ANNUAL_LIMIT_REACHED, COINSURANCE_APPLIED, COPAY_APPLIED, PENDED_FOR_REVIEW, PER_INCIDENT_MAX_APPLIED`.

---

### 4. `GET /claims/:claimId`

Returns the claim with its lines, each line's current adjudication, and a derived explanation. PHI-minimized: member `name` and line `diagnosisCode` are omitted.

**Response `200`**

```json
{
  "claimId": "CLM-7f3a...",
  "memberId": "M-001",
  "policyId": "POL-001",
  "provider": "Downtown Physio",
  "dateOfService": "2026-03-10",
  "state": "PARTIALLY_APPROVED",
  "isDisputed": false,
  "lines": [
    {
      "lineId": "LN-1a2b...",
      "serviceCode": "97110",
      "serviceCategory": "PHYSICAL_THERAPY",
      "billedMinor": 25000,
      "units": 1,
      "state": "PARTIALLY_APPROVED",
      "adjudication": {
        "sequence": 1,
        "isCurrent": true,
        "decisionCode": "PARTIALLY_APPROVED",
        "reasonCodes": ["DEDUCTIBLE_APPLIED", "COPAY_APPLIED"],
        "allowedMinor": 25000,
        "deductibleAppliedMinor": 25000,
        "coinsuranceMinor": 0,
        "copayMinor": 2500,
        "payableMinor": 0,
        "memberRespMinor": 25000,
        "adjudicatedAt": "2026-03-11T09:00:00.000Z"
      },
      "explanation": {
        "shortMessage": "Deductible applied.",
        "detail": "$250.00 was applied toward your annual deductible. A $25.00 copay applies to this service.",
        "breakdown": [
          { "label": "Billed", "amountMinor": 25000 },
          { "label": "Allowed", "amountMinor": 25000 },
          { "label": "Deductible applied", "amountMinor": 25000 },
          { "label": "After deductible", "amountMinor": 0 },
          { "label": "Coinsurance", "amountMinor": 0 },
          { "label": "Copay", "amountMinor": 2500 },
          { "label": "Payable", "amountMinor": 0 }
        ]
      }
    }
  ]
}
```

`adjudication` and `explanation` are `null` until the claim is adjudicated. `isDisputed` is derived from the existence of an open dispute, never stored.

---

### 5. `GET /claims/:claimId/ledger`

Member's usage-ledger balances and append-only entries for the claim's plan year. Balances are **summed** from entries (no cached column).

**Response `200`**

```json
{
  "memberId": "M-001",
  "period": 2026,
  "balances": {
    "DEDUCTIBLE": 25000,
    "ANNUAL_LIMIT:PHYSICAL_THERAPY": 25000
  },
  "entries": [
    {
      "entryId": "LE-9c8d...",
      "bucket": "DEDUCTIBLE",
      "amountOrCount": 25000,
      "sourceLineId": "LN-1a2b...",
      "createdAt": "2026-03-11T09:00:05.000Z"
    },
    {
      "entryId": "LE-a1b2...",
      "bucket": "ANNUAL_LIMIT:PHYSICAL_THERAPY",
      "amountOrCount": 25000,
      "sourceLineId": "LN-1a2b...",
      "createdAt": "2026-03-11T09:00:05.001Z"
    }
  ]
}
```

Buckets are `DEDUCTIBLE` and `ANNUAL_LIMIT:<serviceCategory>` (the plan year is the separate `period` field). Ledger entries are written only on `APPROVED`/`PARTIALLY_APPROVED`; reversals appear as additional **negative** `amountOrCount` entries (never edits).

---

### 6. `POST /claims/:claimId/pay`

Pays the approved / partially-approved lines. **No request body.** Returns the same `AdjudicationSummary` shape as adjudicate, with `claimState` advancing to `PAID`.

Paying a claim with **no payable lines fails with `409`** (NotPayable) — so a line fully consumed by the deductible (`payableMinor: 0`, as in examples 3–5) cannot be paid. The response below shows a line whose deductible was **already met** on a prior claim, leaving a non-zero `payableMinor`:

**Response `200`**

```json
{
  "claimId": "CLM-7f3a...",
  "claimState": "PAID",
  "lines": [
    {
      "lineId": "LN-1a2b...",
      "serviceCategory": "PHYSICAL_THERAPY",
      "decisionCode": "PARTIALLY_APPROVED",
      "reasonCodes": ["COINSURANCE_APPLIED", "COPAY_APPLIED"],
      "lineState": "PAID",
      "allowedMinor": 25000,
      "deductibleAppliedMinor": 0,
      "coinsuranceMinor": 5000,
      "copayMinor": 2500,
      "payableMinor": 17500,
      "memberRespMinor": 7500
    }
  ]
}
```

`PAID` is terminal — a paid line cannot be re-adjudicated or disputed.

---

### 7. `POST /claims/:claimId/lines/:lineId/resolve-review`

Resolves a manual-review pend (`NEEDS_REVIEW`) on a single line by re-running adjudication for it. **No request body.** Returns the `AdjudicationSummary`.

**Response `200`** — same shape as `POST /claims/:claimId/adjudicate`.

---

### 8. `POST /claims/:claimId/disputes`

Opens a dispute against one or more lines of the claim.

**Request body**

```json
{
  "lineIds": ["LN-1a2b..."],
  "reason": "Service was billed under the wrong category."
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `lineIds` | string[] | yes | At least one non-empty line id belonging to the claim. |
| `reason` | string | yes | Non-empty. |

**Response `201`**

```json
{ "disputeId": "DSP-4e5f...", "claimId": "CLM-7f3a...", "state": "OPEN" }
```

---

### 9. `POST /disputes/:disputeId/start-review`

Moves a dispute `OPEN → UNDER_REVIEW`. **No request body.**

**Response `200`**

```json
{ "disputeId": "DSP-4e5f...", "state": "UNDER_REVIEW" }
```

---

### 10. `POST /disputes/:disputeId/resolve`

Resolves a dispute. If `corrections` are supplied, the affected lines are corrected and **re-adjudicated** through the same pipeline (a new adjudication row is appended per corrected line).

**Request body**

```json
{
  "outcome": "OVERTURNED",
  "note": "Re-categorized to PHYSICAL_THERAPY and approved on dispute.",
  "corrections": {
    "LN-1a2b...": { "serviceCategory": "PHYSICAL_THERAPY" }
  }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `outcome` | enum | yes | `UPHELD \| OVERTURNED \| PARTIALLY_OVERTURNED`. Descriptive metadata; resolution re-adjudicates whatever corrections are supplied, identically for all outcomes. |
| `note` | string | yes | Non-empty. |
| `corrections` | object | no | Map of `lineId → correction`. Each correction may set any of `serviceCode`, `serviceCategory`, `diagnosisCode`, `billedMinor`, `units` (all optional, strict). Omit to resolve without re-adjudicating. |

**Response `200`**

```json
{
  "dispute": {
    "disputeId": "DSP-4e5f...",
    "state": "CLOSED",
    "resolutionOutcome": "OVERTURNED",
    "resolutionNote": "Re-categorized to PHYSICAL_THERAPY and approved on dispute."
  },
  "adjudication": {
    "claimId": "CLM-7f3a...",
    "claimState": "PARTIALLY_APPROVED",
    "lines": [
      {
        "lineId": "LN-1a2b...",
        "serviceCategory": "PHYSICAL_THERAPY",
        "decisionCode": "PARTIALLY_APPROVED",
        "reasonCodes": ["DEDUCTIBLE_APPLIED", "COINSURANCE_APPLIED", "COPAY_APPLIED"],
        "lineState": "PARTIALLY_APPROVED",
        "allowedMinor": 80000,
        "deductibleAppliedMinor": 50000,
        "coinsuranceMinor": 6000,
        "copayMinor": 2500,
        "payableMinor": 21500,
        "memberRespMinor": 58500
      }
    ]
  }
}
```

---

### 11. `GET /disputes/:disputeId`

Returns the dispute and the **full append-only adjudication history** per disputed line (sequence 1 preserved, latest current).

**Response `200`**

```json
{
  "disputeId": "DSP-4e5f...",
  "claimId": "CLM-7f3a...",
  "lineIds": ["LN-1a2b..."],
  "reason": "Service was billed under the wrong category.",
  "state": "CLOSED",
  "resolutionOutcome": "OVERTURNED",
  "resolutionNote": "Re-categorized to PHYSICAL_THERAPY and approved on dispute.",
  "openedAt": "2026-06-01T10:00:00.000Z",
  "resolvedAt": "2026-06-01T10:05:00.000Z",
  "adjudicationHistory": {
    "LN-1a2b...": [
      {
        "sequence": 1,
        "isCurrent": false,
        "decisionCode": "DENIED",
        "reasonCodes": ["NOT_COVERED"],
        "allowedMinor": 0,
        "deductibleAppliedMinor": 0,
        "coinsuranceMinor": 0,
        "copayMinor": 0,
        "payableMinor": 0,
        "memberRespMinor": 0,
        "adjudicatedAt": "2026-06-01T09:30:00.000Z"
      },
      {
        "sequence": 2,
        "isCurrent": true,
        "decisionCode": "PARTIALLY_APPROVED",
        "reasonCodes": ["DEDUCTIBLE_APPLIED", "COINSURANCE_APPLIED", "COPAY_APPLIED"],
        "allowedMinor": 80000,
        "deductibleAppliedMinor": 50000,
        "coinsuranceMinor": 6000,
        "copayMinor": 2500,
        "payableMinor": 21500,
        "memberRespMinor": 58500,
        "adjudicatedAt": "2026-06-01T10:05:00.000Z"
      }
    ]
  }
}
```

`resolutionOutcome`, `resolutionNote`, and `resolvedAt` are present only once the dispute is resolved.

---

### 12. `GET /policies/:policyId`

Returns a policy with its coverage rules and exclusions.

**Response `200`**

```json
{
  "policyId": "POL-001",
  "memberId": "M-001",
  "effectiveDate": "2026-01-01",
  "terminationDate": "2026-12-31",
  "planYear": 2026,
  "annualDeductibleMinor": 50000,
  "exclusions": ["EXPERIMENTAL"],
  "coverage": [
    { "serviceCategory": "PREVENTIVE_CARE", "covered": true, "coinsuranceRate": 0 },
    {
      "serviceCategory": "PHYSICAL_THERAPY",
      "covered": true,
      "coinsuranceRate": 0.2,
      "annualLimitMinor": 400000,
      "copayMinor": 2500
    },
    {
      "serviceCategory": "DIAGNOSTIC_IMAGING",
      "covered": true,
      "coinsuranceRate": 0.1,
      "reviewThresholdMinor": 1000000
    },
    { "serviceCategory": "EXPERIMENTAL", "covered": true, "coinsuranceRate": 0.2 },
    { "serviceCategory": "COSMETIC", "covered": false }
  ]
}
```

`coverage` mirrors the seeded [`policies/standard-plan-2026.json`](policies/standard-plan-2026.json). A covered rule always carries `coinsuranceRate` and may carry optional `annualLimitMinor`, `copayMinor`, `perIncidentMaxMinor`, `reviewThresholdMinor`, and `visitLimit`; a non-covered rule carries only `serviceCategory` and `covered: false`. Returns `404` if the policy is unknown (e.g. database not seeded).

---

## Example API flow

Two self-contained scenarios, both validated against the seeded data. All amounts are minor units (cents).

> **Lines and disputes are independent.** A line is `PAID` once you pay it, and `PAID` is terminal — you cannot dispute or re-adjudicate a paid line. So the dispute scenario below uses its **own** claim, not the one paid in Scenario A.
>
> Tip: capture the generated `claimId` / `lineId` / `disputeId` from each response (the examples assume `$CLAIM_ID`, `$LINE_ID`, `$DISPUTE_ID`).

### Scenario A — submit → adjudicate → pay (`M-001` / `POL-001`)

**1. Submit a claim** (one physical-therapy line, $250.00 billed):

```bash
curl -s -X POST http://localhost:3000/claims \
  -H 'Content-Type: application/json' \
  -d '{
    "memberId": "M-001",
    "policyId": "POL-001",
    "provider": "Downtown Physio",
    "dateOfService": "2026-03-10",
    "lines": [
      { "serviceCode": "97110", "serviceCategory": "PHYSICAL_THERAPY", "billedMinor": 25000, "units": 1 }
    ]
  }'
# → 201 {"claimId":"<generated>","state":"SUBMITTED"}
```

**2. Adjudicate** the claim (runs the fixed pipeline over every line):

```bash
curl -s -X POST http://localhost:3000/claims/$CLAIM_ID/adjudicate
# → 200 adjudication summary (per-line decision codes, reason codes, cost-share)
```

**3. Inspect** the claim — line states, the current adjudication, and a derived explanation:

```bash
curl -s http://localhost:3000/claims/$CLAIM_ID
```

**4. Pay** the approved lines:

```bash
curl -s -X POST http://localhost:3000/claims/$CLAIM_ID/pay
```

**5. View the usage ledger** (deductible/limit accumulators for the plan year):

```bash
curl -s http://localhost:3000/claims/$CLAIM_ID/ledger
```

> Exact cost-share (deductible applied, coinsurance, copay, payable) depends on the member's accumulated deductible and annual limits at the time of adjudication — inspect the adjudication response and `/ledger` to see the breakdown.

### Scenario B — dispute an overturned denial (`M-002` / `POL-002`)

A line is submitted under the wrong category (`COSMETIC`, which is **not covered**), gets **denied**, is then disputed and re-adjudicated under the correct category (`PHYSICAL_THERAPY`). A denied line is the realistic dispute target — an overturn re-adjudicates `DENIED → APPROVED/PARTIALLY_APPROVED`.

**1. Submit a mis-categorized line, then adjudicate → `DENIED`:**

```bash
curl -s -X POST http://localhost:3000/claims \
  -H 'Content-Type: application/json' \
  -d '{
    "memberId": "M-002",
    "policyId": "POL-002",
    "provider": "PT Clinic",
    "dateOfService": "2026-06-01",
    "lines": [
      { "serviceCode": "PT-1", "serviceCategory": "COSMETIC", "billedMinor": 80000, "units": 1 }
    ]
  }'
# capture claimId → $CLAIM_ID

curl -s -X POST http://localhost:3000/claims/$CLAIM_ID/adjudicate
# → claimState "DENIED", reasonCodes ["NOT_COVERED"]
```

**2. Get the claim to capture the line id:**

```bash
curl -s http://localhost:3000/claims/$CLAIM_ID    # → lines[0].lineId = $LINE_ID
```

**3. Open a dispute, then move it under review:**

```bash
curl -s -X POST http://localhost:3000/claims/$CLAIM_ID/disputes \
  -H 'Content-Type: application/json' \
  -d '{ "lineIds": ["'"$LINE_ID"'"], "reason": "Wrong category." }'
# capture disputeId → $DISPUTE_ID

curl -s -X POST http://localhost:3000/disputes/$DISPUTE_ID/start-review
# → state "UNDER_REVIEW"
```

**4. Resolve `OVERTURNED` with a category correction — re-adjudicates the line:**

```bash
curl -s -X POST http://localhost:3000/disputes/$DISPUTE_ID/resolve \
  -H 'Content-Type: application/json' \
  -d '{
    "outcome": "OVERTURNED",
    "note": "Re-categorized to PHYSICAL_THERAPY and approved on dispute.",
    "corrections": { "'"$LINE_ID"'": { "serviceCategory": "PHYSICAL_THERAPY" } }
  }'
# → dispute.state "CLOSED", adjudication.claimState "PARTIALLY_APPROVED", payableMinor 21500
```

**5. The now-approved line can be paid:**

```bash
curl -s -X POST http://localhost:3000/claims/$CLAIM_ID/pay    # → claimState "PAID"
```

`GET /disputes/$DISPUTE_ID` shows the append-only history: sequence 1 `DENIED` preserved, sequence 2 `PARTIALLY_APPROVED` current.

A complete, asserted walkthrough of both scenarios lives in the end-to-end test: [`test/e2e/lifecycle.test.ts`](test/e2e/lifecycle.test.ts).

---

## Testing

The full suite runs entirely on **in-memory repositories — no database, migration, or seed required.**

```bash
npm test               # all suites (unit + integration + e2e) — 110 tests
npm run test:unit      # unit tests only
npm run test:integration
npm run test:e2e
```

Type-check without emitting:

```bash
npm run lint           # tsc --noEmit
```

---

## Project structure

```
src/
  api/            Express server, routes, controllers, request schemas, serializers, OpenAPI spec
  config/         Strict rule loader + explanation catalog
  domain/         Entities, value objects, codes, state machines, money helpers
  pipeline/       Adjudication pipeline, claim-state derivation, explanations
  repositories/   Repository interfaces + Prisma and in-memory adapters
  services/       Claim, adjudication, ledger, and dispute services
  container.ts    Composition root (Prisma or in-memory wiring)
  index.ts        Boot entrypoint
prisma/           schema.prisma, migrations, seed.ts
policies/         standard-plan-2026.json (coverage-rule config)
test/             unit / integration / e2e suites
docs/             domain model, implementation plan, acceptance scenarios
```

---

## Troubleshooting

- **`Cannot find module '.prisma/client'` / client errors** — run `npm run generate` (or `npm run migrate`, which generates as part of `migrate dev`).
- **`GET /policies/POL-001` returns 404** — the database hasn't been seeded; run `npm run seed`.
- **Seed refuses to run** — `DATABASE_URL` must be a local `file:` SQLite URL and `NODE_ENV` must not be `production` (the seed truncates all tables).
- **Port already in use** — set `PORT` in `.env` to a free port.
