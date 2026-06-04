# Implementation Plan — Claims Processing System

> Smallest working implementation that satisfies every required flow in
> [`domain-model.md`](./domain-model.md) and [`acceptance-scenarios.md`](./acceptance-scenarios.md).
> Those two documents are the **source of truth**. This plan adds **no new domain concepts** and does
> **not** redesign the model — it only chooses the minimal code shape that makes the model executable
> and the acceptance scenarios pass.

## Stack (confirmed)

| Concern | Choice |
|---|---|
| Runtime / language | Node.js 20+, TypeScript (strict) |
| HTTP | Express |
| Persistence | Prisma + SQLite (in-memory SQLite for tests) |
| Validation | Zod (rule-config loader **and** request bodies) |
| Tests | Mocha + Chai + Sinon |
| Frontend | Next.js — **very thin BFF** + minimal demo screens (optional walkthrough surface) |

## Guiding constraints (from the model — repeated so they bind the code)

1. **Adjudication is a fixed pipeline of pure functions**, not a rule engine. JSON carries *values only*.
2. **ClaimLine is authoritative; Claim state is derived** by one pure function and never assigned.
3. **Adjudication is append-only** (one `is_current`); **UsageLedger is append-only** (compensating
   entries, never edits).
4. **Reason codes are emitted by pipeline steps**; the member `Explanation` is *derived* from
   `reason_codes` + catalog, never stored.
5. **No stored `DISPUTED` state** — it is derived from an open `Dispute`.
6. **Money is integer minor units** everywhere; never floats.

---

## 1. Project Structure

```
claim-processing-system/
├── prisma/
│   ├── schema.prisma                 # persistence schema (mirrors domain entities 1:1)
│   └── seed.ts                       # seed member + policy + rules from policies/*.json
├── policies/
│   └── standard-plan-2026.json       # coverage-rule config (acceptance §0.2 fixtures)
├── src/
│   ├── domain/                       # pure, no I/O, no framework imports
│   │   ├── money.ts                  # Money value object + safe integer arithmetic
│   │   ├── value-objects.ts          # ServiceCode, CostShare, Period, CalculationBreakdown, Explanation
│   │   ├── codes.ts                  # DecisionCode (closed enum), ReasonCode (closed enum)
│   │   ├── states.ts                 # Claim/Line/Dispute state enums + transition tables + guards
│   │   └── entities.ts               # Member, Policy, CoverageRule, Claim, ClaimLine, Adjudication,
│   │                                 #   UsageLedgerEntry, Dispute (types/interfaces)
│   ├── config/
│   │   ├── rule-schema.ts            # Zod .strict() schema for CoverageRule (the DSL guard)
│   │   ├── rule-loader.ts            # read JSON → validate → typed CoverageRule[] (fail fast)
│   │   └── explanation-catalog.ts    # ExplanationCode catalog + startup completeness check
│   ├── pipeline/                     # pure adjudication core
│   │   ├── steps.ts                  # eligibility, coverage, exclusion, review, limit, deductible, costShare
│   │   ├── adjudicate-line.ts        # runs steps in fixed order → AdjudicationResult + LedgerDeltas
│   │   ├── derive-claim-state.ts     # ordered guard clauses → ClaimState (pure)
│   │   └── explain.ts                # reason_codes + catalog + breakdown → Explanation (derived)
│   ├── repositories/
│   │   ├── interfaces.ts             # repo ports (see §9)
│   │   ├── prisma/                   # Prisma-backed implementations
│   │   └── memory/                   # in-memory implementations for unit/integration tests
│   ├── services/
│   │   ├── ledger-service.ts         # balance reads (sum ledger) + append entries + compensating entries
│   │   ├── claim-service.ts          # submit + validation + duplicate-line rejection
│   │   ├── adjudication-service.ts   # orchestrate per-claim adjudication + persistence + claim-state cache
│   │   └── dispute-service.ts        # dispute lifecycle + re-adjudication + compensating ledger
│   ├── api/
│   │   ├── server.ts                 # Express app assembly + error handler
│   │   ├── routes.ts                 # endpoint table (see §10)
│   │   ├── controllers.ts            # thin handlers: validate → call service → serialize
│   │   ├── request-schemas.ts        # Zod schemas for request bodies
│   │   └── serializers.ts            # domain → DTO; PHI-minimizing
│   ├── container.ts                  # composition root: wire repos + services
│   └── index.ts                      # boot: load rules, run catalog check, start server
├── test/
│   ├── unit/                         # S1,S2,S3,S6,S10,S11,S12,S13,S14
│   ├── integration/                  # S4,S5,S7,S8,S9 (real ledger / in-memory SQLite)
│   └── e2e/                          # E2E-1 lifecycle, E2E-2 dispute overturned (supertest over Express)
├── web/                              # Next.js thin BFF + minimal demo UI
├── package.json  ·  tsconfig.json  ·  .mocharc.json  ·  .env
```

**Layering rule (the one architectural invariant):** `domain/` and `pipeline/` import nothing from
`services/`, `repositories/`, `api/`, Prisma, or Express. Dependencies point inward only. This is what
keeps the pipeline trivially unit-testable and the model explainable.

---

## 2. Core Modules

Each module below lists **Responsibility · Dependencies · Why it exists**.

### `domain/` (pure model)
- **Responsibility:** Entity/value-object types, the two code enums, and the state enums + transition
  tables. No behavior beyond money arithmetic and transition guards.
- **Dependencies:** none (leaf).
- **Why:** A framework-free core makes the rules readable like the policy document and lets every pure
  test run with no setup.

### `config/` (coverage-rule loader + catalog)
- **Responsibility:** Turn authored JSON into **validated typed `CoverageRule` structs**, and host the
  `ExplanationCode` catalog with a boot-time completeness check.
- **Dependencies:** `domain/`, Zod.
- **Why:** Enforces the "config carries values, never expressions" red line in code (S13) and the catalog
  invariant (S14) — the model's two guard-rails against drifting into a DSL or an un-explainable code.

### `pipeline/` (adjudication core)
- **Responsibility:** The fixed-order rule steps, single-line adjudication, claim-state derivation, and
  explanation rendering — all **pure functions**.
- **Dependencies:** `domain/`, `config/` (for catalog text). No repos, no DB.
- **Why:** This *is* the business logic. Keeping it pure makes S1–S12 unit/derivation tests fast and
  deterministic, and makes "why was this denied?" answerable by reading code, not simulating an engine.

### `repositories/` (persistence ports + adapters)
- **Responsibility:** Define repo interfaces (ports) and provide Prisma and in-memory adapters.
- **Dependencies:** `domain/`; Prisma adapter also depends on Prisma client.
- **Why:** Lets services be tested against in-memory adapters and lets SQLite stay swappable, without
  leaking ORM types into the domain.

### `services/` (orchestration)
- **Responsibility:** Use-case orchestration — submit, adjudicate a whole claim, ledger balance math,
  dispute lifecycle. Owns persistence + transactions; delegates *all* decisions to `pipeline/`.
- **Dependencies:** `domain/`, `pipeline/`, `config/`, `repositories/`.
- **Why:** Separates "decide" (pure pipeline) from "remember" (repos) so the append-only and
  derived-state invariants live in one place and disputes reuse the same pipeline (no special-casing).

### `api/` (REST surface)
- **Responsibility:** HTTP transport only — validate requests (Zod), call a service, serialize a
  PHI-safe DTO, map domain errors to status codes.
- **Dependencies:** `services/`, Express, Zod.
- **Why:** The single demo interface required by the brief. Thin by design — no business logic here, so
  scenarios assert domain behavior, not status codes.

### `container.ts` / `index.ts` (composition + boot)
- **Responsibility:** Wire concrete repos + services; on boot load rules and run the catalog completeness
  check (fail fast), then start Express.
- **Dependencies:** everything above.
- **Why:** One obvious place that assembles the app; nothing else news-up dependencies.

### `web/` (Next.js thin BFF)
- **Responsibility:** Minimal screens (submit a claim, view claim + line explanations, open/resolve a
  dispute) proxying to the REST API.
- **Dependencies:** the REST API only.
- **Why:** A friendlier walkthrough surface for the demo; deliberately holds **no** business logic.

---

## 3. Entity Definitions

TypeScript interfaces mirroring domain-model §2.1 exactly (Prisma `schema.prisma` mirrors these 1:1).
All `*_minor` fields are integers.

```ts
// codes.ts
export enum DecisionCode { APPROVED, PARTIALLY_APPROVED, DENIED, NEEDS_REVIEW }
export enum ReasonCode {
  COVERED, NOT_COVERED, EXCLUDED_SERVICE, POLICY_INACTIVE,
  DEDUCTIBLE_APPLIED, ANNUAL_LIMIT_APPLIED, ANNUAL_LIMIT_REACHED,
  COINSURANCE_APPLIED, COPAY_APPLIED, PENDED_FOR_REVIEW, PER_INCIDENT_MAX_APPLIED,
}

// entities.ts
interface Member   { memberId: string; name: string /*PHI*/; dob: string }
interface Policy   { policyId: string; memberId: string; effectiveDate: string; terminationDate: string;
                     planYear: number; annualDeductibleMinor: number }
interface CoverageRule { serviceCategory: string; /* natural key — one promise per category */
                     covered: boolean;
                     annualLimitMinor?: number; visitLimit?: number; perIncidentMaxMinor?: number;
                     coinsuranceRate: number; copayMinor?: number;
                     reviewThresholdMinor?: number /* present + billed above ⇒ pend; absent ⇒ never */ }
interface Claim    { claimId: string; memberId: string; policyId: string; provider: string;
                     dateOfService: string; submittedAt: string; state: ClaimState /* derived cache */ }
interface ClaimLine{ lineId: string; claimId: string; serviceCode: string; serviceCategory: string;
                     diagnosisCode: string /*PHI*/; billedMinor: number; units: number;
                     state: LineState /* written by pipeline */ }
interface Adjudication { adjudicationId: string; lineId: string; sequence: number; isCurrent: boolean;
                     decisionCode: DecisionCode; reasonCodes: ReasonCode[];
                     allowedMinor: number; deductibleAppliedMinor: number; coinsuranceMinor: number;
                     copayMinor: number; payableMinor: number; memberRespMinor: number; adjudicatedAt: string }
interface UsageLedgerEntry { entryId: string; memberId: string; policyId: string; period: number;
                     bucket: string; amountOrCount: number /* signed */; sourceLineId: string; createdAt: string }
interface Dispute  { disputeId: string; claimId: string; lineIds: string[]; reason: string;
                     state: DisputeState; resolutionOutcome?: DisputeOutcome; resolutionNote?: string;
                     openedAt: string; resolvedAt?: string }
interface ExplanationCode { code: string; shortMessage: string; detailTemplate: string; category: string }
```

No fields added beyond the model. `CoverageRule` carries **no** explanation metadata (per §4).

---

## 4. Value Objects

| VO | Shape | Behavior (the only behavior allowed in `domain/`) |
|---|---|---|
| `Money` | `{ amountMinor: number; currency: 'USD' }` | `add/sub/min(a,b)`, `percentOf(rate)` with **banker's rounding** to minor units, `clampToZero()`. Never floats. |
| `ServiceCode` | branded `string` | CPT-like identifier; equality only. |
| `CostShare` | `{ coinsuranceRate: number; copayMinor: number }` | derived from a `CoverageRule`; no logic. |
| `Period` | `{ planYear: number }` | scopes ledger accumulators. |
| `CalculationBreakdown` | ordered steps `{ label; amountMinor }[]` | the payable math trace; built by `adjudicate-line.ts`. |
| `Explanation` | `{ shortMessage; detail; breakdown }` | **derived** by `explain.ts` from reason codes + catalog + breakdown; never persisted. |

`Money` is the single source of money arithmetic so rounding is identical everywhere (matters for the
coinsurance figures in S3/S5/S7).

---

## 5. State Machine Implementation Strategy

Three machines, deliberately minimal — **declarative transition tables + a guard function**, no library.

- **Claim state — NOT a transition machine.** It is the pure function `deriveClaimState(lineStates[])`
  in `pipeline/derive-claim-state.ts`, implemented as the five ordered guard clauses from §6 (first
  match wins). It is the **only** writer of `Claim.state` (a cache). S10 is a table-driven test over
  this function. Transitions like `UNDER_REVIEW → PARTIALLY_APPROVED` are *consequences* of re-derivation,
  not asserted edges.
- **Line state machine** — `states.ts` holds `LINE_TRANSITIONS: Record<LineState, LineState[]>` matching
  the §6 diagram; `assertLineTransition(from, to)` throws on an illegal edge (e.g. `AWAITING_ADJUDICATION
  → PAID`, `DENIED → PAID`). The pipeline sets the post-adjudication state; the service applies the guard.
  Re-adjudication appends an `Adjudication` rather than introducing a `DISPUTED` line state.
- **Dispute state machine** — `DISPUTE_TRANSITIONS` for `OPEN → UNDER_REVIEW → RESOLVED → CLOSED`
  (+ `WITHDRAWN`); same `assertTransition` helper.

There is **no `DISPUTED` enum value** anywhere. "Is this claim disputed?" is a derived query:
`disputeRepo.findOpenByClaim(claimId)` returning a dispute in `{OPEN, UNDER_REVIEW}`.

Strategy choice: hand-rolled tables over a state-machine library — the graphs are tiny, and explicit
tables keep the "invalid transition" tests (model §6) readable. Avoids a dependency = avoids
over-engineering.

---

## 6. Coverage Rule Loader Strategy

`config/rule-schema.ts` defines a **Zod object with `.strict()`** so any unknown field throws — this is
the DSL guard in code. The schema mirrors the simplified `CoverageRule` (keyed by `serviceCategory`,
no surrogate id, no `requiresReview` flag):

- **Type/range checks:** `coinsuranceRate` is `z.number().min(0).max(1)`; `*_minor`/`*_threshold` are
  `z.number().int().nonnegative()`; `covered` boolean; `serviceCategory` non-empty.
- **`.strict()`** rejects unknown fields → catches `priority` / `rule_id`, and the DSL smells
  (`condition`, `expression`, `formula`, `operator`) without enumerating them (S13). An explicit denylist
  assertion in the test documents intent.
- **Cross-field refinement:** `covered:false` rules carry **only** `serviceCategory` + `covered` (all
  cost-share/limit/threshold fields must be absent — a non-covered benefit has no math).
- **Uniqueness:** duplicate `serviceCategory` within one policy is a **load-time error** (exactly one
  promise per category) — replaces the old surrogate `rule_id` as the natural key.
- **Exclusions** are a policy-level `exclusions: string[]` (categories), not a rule field; checked by the
  Exclusion pipeline step.

`rule-loader.ts`: `loadPolicyConfig(path) → { policy, exclusions, rules: CoverageRule[] }` — read file →
`JSON.parse` → `schema.parse` (throws on first violation, **fail fast**) → typed structs. Called at boot
and by `prisma/seed.ts`. No interpreter, no priority field, no rule ids — pipeline **ordering lives only
in `pipeline/`**, and a present `review_threshold` is the only thing that drives the Review step.

`explanation-catalog.ts`: static catalog (acceptance §0.3) + `assertCatalogComplete(allReasonCodes)` run
at boot — fails startup, not mid-claim (S14).

---

## 7. Adjudication Service Design

**Responsibility:** orchestrate a whole claim through the pure pipeline and persist results +
derived state. **Dependencies:** `pipeline/`, all repos, `ledger-service`, `config` catalog.

`adjudicateClaim(claimId)`:
1. Load claim + lines, the policy active on DOS, its rules, and **current ledger balances** for the
   member/period (via `ledger-service.balances()`).
2. Set claim → `UNDER_REVIEW`.
3. **For each line in order**, call the pure `adjudicateLine(line, rule, policy, runningBalances)` which
   runs steps in the fixed order (eligibility → coverage → exclusion → review → limit → deductible →
   cost share) and returns `{ decisionCode, reasonCodes[], breakdown, amounts, lineState, ledgerDeltas }`.
   - Append a new `Adjudication` (sequence = prev+1, `isCurrent=true`, flip prior to false).
   - Apply `assertLineTransition` then persist line state.
   - On `APPROVED`/`PARTIALLY_APPROVED`: write ledger entries (`ledger-service.consume`) **and update the
     in-memory `runningBalances`** so later lines in the same claim see the consumption (this is what makes
     S7-L4 cap correctly against the running PT limit).
4. `Claim.state = deriveClaimState(lineStates)` — the only assignment of claim state (a cache write).
5. Return a summary; **no payment** happens here.

`payClaim(claimId)`: allowed only when no line is `NEEDS_REVIEW`; transitions payable
(`APPROVED`/`PARTIALLY_APPROVED`) lines → `PAID`, re-derives claim state → `PAID`. Guard blocks
`DENIED → PAID` and paying an `UNDER_REVIEW` claim.

The **decision-derivation contract** (acceptance §0.5) lives inside `adjudicate-line.ts` as the mapping
from pipeline outcome → `DecisionCode` + `LineState`; the service never re-decides.

---

## 8. Dispute Service Design

**Responsibility:** dispute lifecycle + re-adjudication via the *same* pipeline + compensating ledger.
**Dependencies:** `adjudication-service` (reuse), repos, `ledger-service`.

- `openDispute(claimId, lineIds, reason)` → create `Dispute` in `OPEN` (no claim/line state change;
  "disputed" is derived).
- `startReview(disputeId)` → `OPEN → UNDER_REVIEW`.
- `resolve(disputeId, outcome, note, corrections?)`:
  - `corrections?` may fix a line input (e.g. S9's wrong `serviceCategory`) — the only sanctioned way to
    edit a line post-decision, gated by an open dispute.
  - Re-adjudicate each targeted line through `adjudicateLine` → **append** a new `Adjudication`
    (`isCurrent=true`, prior preserved). Claim re-enters `UNDER_REVIEW` and is re-derived.
  - **Ledger:** diff new vs. previously-consumed usage for the line; post **signed compensating entries**
    keyed to `sourceLineId` — positive for newly-due consumption (S9), negative to reverse a prior
    consumption. **Never edit an existing entry.**
  - Set `resolutionOutcome ∈ {UPHELD, OVERTURNED, PARTIALLY_OVERTURNED}`, `resolutionNote`;
    `UNDER_REVIEW → RESOLVED → CLOSED`.
- **UPHELD (S8):** re-adjudication yields the same outcome; a new `Adjudication` record is still appended
  (full audit trail, exactly one `isCurrent`); ledger unchanged.
- **OVERTURNED (S9):** favorable re-adjudication; new ledger consumption entries written.

Disputes add **no** new pipeline logic — they re-enter the existing one, exactly as the model requires.

---

## 9. Repository Interfaces

Ports in `repositories/interfaces.ts`; Prisma + in-memory adapters implement each. Methods are the
minimum the services call — nothing speculative.

```ts
interface PolicyRepository {
  getActivePolicyForMemberOnDate(memberId: string, dos: string): Promise<Policy | null>;
  getRulesForPolicy(policyId: string): Promise<CoverageRule[]>;
  getExclusionsForPolicy(policyId: string): Promise<string[]>;   // excluded service categories
}
interface ClaimRepository {
  create(claim: Claim, lines: ClaimLine[]): Promise<Claim>;
  getWithLines(claimId: string): Promise<{ claim: Claim; lines: ClaimLine[] } | null>;
  saveClaimState(claimId: string, state: ClaimState): Promise<void>;   // cache write only
  saveLineState(lineId: string, state: LineState): Promise<void>;
}
interface AdjudicationRepository {
  appendForLine(adj: Adjudication): Promise<void>;   // sets prior isCurrent=false in one tx
  currentForLine(lineId: string): Promise<Adjudication | null>;
  historyForLine(lineId: string): Promise<Adjudication[]>;
}
interface UsageLedgerRepository {
  append(entry: UsageLedgerEntry): Promise<void>;     // append-only (signed amounts)
  entriesForMemberPeriod(memberId: string, period: number): Promise<UsageLedgerEntry[]>;
}
interface DisputeRepository {
  create(d: Dispute): Promise<Dispute>;
  get(disputeId: string): Promise<Dispute | null>;
  findOpenByClaim(claimId: string): Promise<Dispute | null>;   // derives "is disputed"
  save(d: Dispute): Promise<void>;
}
interface MemberRepository { get(memberId: string): Promise<Member | null>; }
```

`ledger-service` computes balances by **summing** `entriesForMemberPeriod` per bucket (no cached balance
column — matches the §3 "denormalization deferred" decision).

---

## 10. API Surface (REST)

Thin Express endpoints; bodies validated by Zod; responses are PHI-minimizing DTOs. Endpoints assert
**domain outcomes**, not the reverse.

| Method · Path | Purpose | Body / params | Returns |
|---|---|---|---|
| `POST /claims` | Submit a claim (validate ≥1 line, amounts ≥0, DOS present, reject duplicate lines) → `SUBMITTED` | member/policy/provider/DOS + lines[] | claim id + `SUBMITTED` |
| `POST /claims/:id/adjudicate` | Run the fixed pipeline over all lines | — | claim state, per-line decision/reason codes + breakdown |
| `GET /claims/:id` | Full claim view: lines, **current** adjudication, derived claim state, derived explanations, `isDisputed` flag | — | claim DTO |
| `GET /claims/:id/ledger` | Usage entries + summed balances for the member/period (audit) | — | ledger view |
| `POST /claims/:id/pay` | Pay payable lines → `PAID` (blocked if any line `NEEDS_REVIEW`) | — | claim `PAID` |
| `POST /claims/:id/disputes` | Open a dispute against line ids | lineIds[], reason | dispute `OPEN` |
| `POST /disputes/:id/resolve` | Review + resolve: re-adjudicate, append adjudication, compensating ledger | outcome, note, corrections? | new line/claim states, resolution |
| `GET /disputes/:id` | Dispute detail + adjudication history for its lines | — | dispute DTO |
| `GET /policies/:id` | Policy + loaded rules (demo/inspection) | — | policy DTO |

Error mapping is centralized in `server.ts` (validation → 400, illegal transition / not-payable → 409,
missing → 404) — kept out of the scenarios on purpose.

---

## Recommended Commit Sequence

Each commit is independently green (its own tests pass) and adds nothing the next commit doesn't need.

### Commit 1 — Project setup
`package.json`, `tsconfig.json` (strict), `.mocharc.json`, ESLint/Prettier, Express+Prisma+Zod deps,
`prisma/schema.prisma` mirroring §3 entities, SQLite datasource, npm scripts (`dev`, `test`, `migrate`,
`seed`), empty `src/` skeleton + health route. **Tests:** one boot/health smoke test.

### Commit 2 — Domain entities & value objects
`domain/` (`money.ts`, `value-objects.ts`, `codes.ts`, `entities.ts`). **Tests (unit):** `Money`
arithmetic + banker's rounding; enum/type sanity. Pins §3–§4 and the money correctness behind S3/S5/S7.

### Commit 3 — State machines
`domain/states.ts` (line + dispute transition tables, `assertTransition`) and
`pipeline/derive-claim-state.ts`. **Tests (unit):** **S10** table-driven derivation over all line-state
combinations; illegal-transition guards (`AWAITING→PAID`, `DENIED→PAID`).

### Commit 4 — Coverage rule configuration
`config/rule-schema.ts`, `rule-loader.ts`, `explanation-catalog.ts`, `policies/standard-plan-2026.json`,
`prisma/seed.ts`. **Tests (unit):** **S13** (unknown field, bad type/range, DSL-smell rejection, valid
load) and **S14** (catalog completeness at boot).

### Commit 5 — Adjudication service
`pipeline/steps.ts`, `adjudicate-line.ts`, `explain.ts`; `repositories/` (interfaces + in-memory +
Prisma); `services/ledger-service.ts`, `claim-service.ts`, `adjudication-service.ts`. **Tests:** unit
**S1, S2, S3, S6, S11, S12**; integration **S4, S5, S7** (real ledger, running-balance cap).

### Commit 6 — Dispute handling
`services/dispute-service.ts` + `DisputeRepository`. **Tests (integration):** **S8** (upheld: appended
record, one `isCurrent`, ledger unchanged) and **S9** (overturned: re-adjudication, new ledger entries,
compensating-entry path).

### Commit 7 — API
`api/` (server, routes, controllers, request-schemas, serializers), `container.ts`, `index.ts`; the
`web/` Next.js thin BFF. **Tests (e2e, supertest):** **E2E-1** full lifecycle (submit→adjudicate→resolve
review→pay) and **E2E-2** dispute-overturned round-trip.

### Commit 8 — Documentation
`docs/decisions.md` (this stack + tradeoffs), `docs/self-review.md`, README setup/run/test instructions,
and a short demo script mapping each endpoint to its acceptance scenario. No code changes.

---

## Traceability (modules → acceptance scenarios)

| Module | Validated by |
|---|---|
| `domain/money` + value objects | S1, S3, S5, S7 (money math) |
| `pipeline/derive-claim-state` | **S10**, S7 |
| `pipeline/steps` + `adjudicate-line` | S1, S2, S3, S4, S5, S6, S11, S12 |
| `pipeline/explain` + catalog | every scenario's explanation; **S14** |
| `config/rule-loader` + schema | **S13** |
| `ledger-service` | S3, S5, S7 (consume), S9 (compensating) |
| `adjudication-service` | S4, S5, S7; E2E-1 |
| `dispute-service` | **S8**, **S9**; E2E-2 |
| `api/` | E2E-1, E2E-2 |
```
