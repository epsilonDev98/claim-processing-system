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

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness probe |
| `POST` | `/claims` | Submit a new claim |
| `GET` | `/claims/:claimId` | Get a claim with lines, current adjudications, and explanations |
| `POST` | `/claims/:claimId/adjudicate` | Run the adjudication pipeline over all lines |
| `GET` | `/claims/:claimId/ledger` | Member's usage-ledger balances and entries for the plan year |
| `POST` | `/claims/:claimId/pay` | Pay approved lines |
| `POST` | `/claims/:claimId/lines/:lineId/resolve-review` | Resolve a manual-review pend on a line |
| `POST` | `/claims/:claimId/disputes` | Open a dispute against one or more lines |
| `POST` | `/disputes/:disputeId/start-review` | Move a dispute `OPEN → UNDER_REVIEW` |
| `POST` | `/disputes/:disputeId/resolve` | Resolve a dispute (optionally re-adjudicating with corrections) |
| `GET` | `/disputes/:disputeId` | Get a dispute with per-line adjudication history |
| `GET` | `/policies/:policyId` | Get a policy with coverage rules and exclusions |

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
