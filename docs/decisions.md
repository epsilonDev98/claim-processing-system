# Decisions

What this system actually does, what it deliberately does *not* do, and the domain assumptions
baked into the code. Everything here is grounded in the implementation, the test suite, and the
seeded policy as they stand today — not in the earlier design docs where those differ.

> Scope note: where `docs/` and the code disagree, the code wins and is described here. A few
> things the design docs describe are only *partially* wired; those are called out explicitly
> under [What I did not build](#what-i-did-not-build).

---

## 1. The three load-bearing decisions

Everything else follows from these.

### 1.1 Claim state is derived, never stored as truth

A claim has no state machine. `ClaimState` is a **pure projection of its line states**, computed by
`deriveClaimState` (`src/pipeline/derive-claim-state.ts`) and by nothing else. `Claim.state` in the
database is a *cache* that only that function writes (`prisma/schema.prisma` comments it as such;
`ClaimRepository.saveClaimState` is documented "cache write only").

The projection is ordered guard clauses, first match wins:

```
0. every line AWAITING_ADJUDICATION   → SUBMITTED
1. any line NEEDS_REVIEW              → UNDER_REVIEW
2. ≥1 payable line and all paid      → PAID        (denied lines aren't payable, so PAID+DENIED ⇒ PAID)
3. every line DENIED                 → DENIED
4. every line APPROVED               → APPROVED
5. otherwise (partials, or a mix)    → PARTIALLY_APPROVED
```

Consequence: there is **no `DISPUTED` state anywhere**. "Is this claim disputed?" is derived at read
time from the existence of an open dispute (`DisputeRepository.findOpenByClaim`), not stored on the
claim or line. The API surfaces it as a computed `isDisputed` boolean on the claim view.

### 1.2 Adjudication is a fixed pipeline of pure functions, and it is append-only

The decision logic is a **fixed, hard-coded step order** — not a rules engine, not a DSL. The order
lives in one place, `adjudicateLine` (`src/pipeline/adjudicate-line.ts`):

```
a. eligibility → b. coverage → c. exclusion → d. review → e. limit → f. deductible → g. cost share
```

Steps a–c are hard-deny gates; d pends (stops the pipeline); e–g compute the payable math. Each step
is a pure function in `src/pipeline/steps.ts` with no I/O. The service layer **never re-decides** — it
runs the pure pipeline, then persists the outcome.

Adjudication results are **append-only**. Each (re-)adjudication of a line inserts a new
`Adjudication` row with the next `sequence`; exactly one row per line is `isCurrent`. Re-running
adjudication, resolving a review, or overturning a dispute all *append* — they never mutate or delete
history. Enforced in the DB by `@@unique([lineId, sequence])`.

### 1.3 Money is integer minor units, with banker's rounding

All money is integer **minor units** (cents). There are no floats anywhere in storage or arithmetic.
The single `Money` value object (`src/domain/money.ts`) rejects non-integer construction and is the
only place arithmetic happens. The one place a fraction can appear — coinsurance (`rate × amount`) —
is rounded with **banker's rounding (round half to even)** so repeated halves don't bias sums upward,
and so the figure is identical everywhere the math runs.

---

## 2. What I built

### Domain core
- **Three small state machines** as explicit transition tables (`src/domain/states.ts`): line and
  dispute states are guarded machines (`assertLineTransition` / `assertDisputeTransition`); claim
  state is *not* a machine (see §1.1). Illegal edges throw `IllegalTransitionError` → HTTP 409.
- **Closed code sets**: `DecisionCode` (exactly one per adjudication) and `ReasonCode` (one-or-many),
  string-valued so they serialize as their own names.
- **`Money` value object** with `add/sub/min/percentOf/clampToZero` and currency-mismatch guarding.

### Adjudication pipeline (the seven steps, as actually implemented)
- **Eligibility**: policy must be active on the date of service, compared as ISO `yyyy-mm-dd`
  strings with inclusive bounds. Inactive ⇒ hard deny `POLICY_INACTIVE`.
- **Coverage**: a category is covered iff a rule exists *and* `covered: true`. Missing rule or
  `covered: false` ⇒ hard deny `NOT_COVERED`.
- **Exclusion**: a policy-level exclusion list hard-denies even an otherwise-covered category ⇒
  `EXCLUDED_SERVICE`. (Coverage and exclusion are deliberately *separate* gates.)
- **Review**: a covered rule with a `review_threshold` pends (`NEEDS_REVIEW`) when billed exceeds the
  threshold; the pipeline stops and computes no money. Skipped once a human has reviewed.
- **Limit**: per-incident max caps first, then the remaining annual limit caps. A fully-exhausted
  annual limit is a hard deny (`ANNUAL_LIMIT_REACHED`); a partial cap continues to cost-share.
- **Deductible**: member pays up to the remaining annual deductible off the allowed amount first.
- **Cost share**: coinsurance (banker's-rounded) + copay reduce the post-deductible amount; payable
  is clamped to ≥ 0.

The decision derivation: `payable == billed` ⇒ `APPROVED`; anything less (including $0 fully consumed
by deductible/share) ⇒ `PARTIALLY_APPROVED`; the gates ⇒ `DENIED`; the threshold ⇒ `NEEDS_REVIEW`.
Reason codes are emitted in pipeline-evaluation order.

### Usage ledger (accumulators)
- **Append-only, signed, derived balances** (`src/services/ledger-service.ts`). There is no cached
  balance column — every balance is computed by summing entries per bucket. Buckets are
  `DEDUCTIBLE` and `ANNUAL_LIMIT:<category>`.
- **Running balances within a claim**: `adjudicateClaim` loads balances once and threads a mutable
  copy across lines, so a later line in the same claim sees an earlier line's consumption. **Line
  order within a claim is therefore significant.**
- **Two distinct write paths**: `consume()` appends positive entries on approve/partial and *rejects*
  negatives; `reconcileLine()` posts **signed compensating entries** for the per-bucket diff when a
  dispute changes a line's consumption. History is never edited.

### Lifecycle operations (the services)
- **Submit** (`ClaimService`): validates shape + domain rules, rejects duplicate lines (same
  `serviceCode|billed|units`), verifies the policy belongs to the member, starts the claim
  `SUBMITTED` with all lines `AWAITING_ADJUDICATION`.
- **Adjudicate** (`AdjudicationService.adjudicateClaim`): processes **only** `AWAITING_ADJUDICATION`
  lines, which makes re-running **idempotent and resumable** (no duplicate adjudications, no
  double-consumed ledger). Already-decided lines are preserved as-is.
- **Resolve manual review** (`resolveReview`): re-adjudicates a single `NEEDS_REVIEW` line with the
  Review step lifted, so it falls through to the normal money math.
- **Pay** (`payClaim`): transitions payable lines to `PAID`; **blocked (409)** if any line is still
  `AWAITING_ADJUDICATION` or `NEEDS_REVIEW`. Payment is all-or-nothing across the claim's payable
  lines.
- **Dispute** (`DisputeService`): `openDispute → startReview → resolve`. Resolution optionally applies
  sanctioned line **corrections**, then re-enters the *existing* pipeline via `reAdjudicateLines`
  (no new decision logic), reconciles the ledger with compensating entries, and records the outcome.
  Re-adjudication for a dispute excludes the line's own prior consumption so it isn't double-counted
  against its own recomputed limit/deductible.

### Configuration as data, not code
- **Strict policy-config schema** (`src/config/rule-schema.ts`): every object is Zod `.strict()`, so
  any unknown field fails fast. This is the deliberate guard against a config file smuggling in a
  rules DSL — `condition`, `expression`, `formula`, `operator`, surrogate `rule_id`, `priority` all
  rejected without enumerating them. JSON carries values only; ordering and logic live in code.
- **Natural key**: `service_category` is the key for a coverage rule — no surrogate id; duplicates
  are a load-time error. Covered/non-covered is a discriminated union (a non-covered rule may carry
  *only* the key + flag).
- **Explanation catalog** (`src/config/explanation-catalog.ts`): reason code → member-facing
  templates, typed `Record<ReasonCode, …>` so the closed set is complete *by construction* (missing a
  row is a compile error), plus a boot-time `assertCatalogComplete` runtime guard. Explanations are
  **derived on read, never persisted** — the engine only fills templates.

### Persistence & composition
- **Prisma + SQLite**, schema mirrors the domain 1:1; JSON-encoded strings stand in for arrays
  (reason codes, line-id lists, exclusions) since SQLite has no array/JSON column.
- **Composition root** (`src/container.ts`): the Express app depends only on a `Container`, so the
  same app runs over Prisma (boot) or in-memory adapters (every test). Repository ports expose only
  the minimum the services need; no ORM types leak through.

### HTTP API
- 12 endpoints (`src/api/routes.ts`), thin controllers (validate → service → serialize), centralized
  error→status mapping in `server.ts` (Zod/Validation → 400, NotFound → 404,
  NotPayable/Conflict/IllegalTransition → 409, else 500).
- **PHI minimization at the serializer**: member `name` and line `diagnosisCode` are *never*
  serialized into any response (asserted in the e2e test).
- **Swagger UI at `/docs`** and the raw spec at `/openapi.json` (`src/api/openapi.ts`, hand-authored
  OpenAPI 3.0.3).

### Tests
- **110 passing tests, zero database required** — every test (unit, integration, e2e) runs on
  in-memory repositories. Unit tests cover money/rounding, the state tables, claim-state derivation,
  single-line adjudication, the explain engine + catalog, and the rule loader. Integration tests
  cover full adjudication and the dispute round-trips (S8 upheld, S9 overturned). The e2e tests drive
  the two scenarios over real HTTP via supertest.

---

## What I did not build

These are deliberate omissions or things modeled-but-not-wired. Several are surfaced in the schema,
state tables, or interfaces but have **no execution path** — worth knowing before relying on them.

- **No web frontend.** An optional Next.js BFF / demo UI was considered but deliberately dropped; the
  REST API plus **Swagger UI at `/docs`** is the demo and inspection surface. No browser-based client
  exists.
- **No authentication, authorization, or rate limiting.** Every endpoint is open. There is no notion
  of a caller identity, role, or tenant.
- **`visit_limit` is accepted, persisted, and then ignored.** The schema validates it, the loader maps
  it, and both repository adapters round-trip it — but the pipeline's `applyLimit` only enforces
  `per_incident_max` and `annual_limit`. **Visit-count limits are not enforced.**
- **Dispute `WITHDRAWN` is modeled but unreachable.** The transition table allows
  `OPEN/UNDER_REVIEW → WITHDRAWN → CLOSED`, but no service method or endpoint performs a withdrawal.
  In practice a dispute only ever travels `OPEN → UNDER_REVIEW → RESOLVED → CLOSED`.
- **Dispute outcome does not drive logic.** `UPHELD`, `OVERTURNED`, and `PARTIALLY_OVERTURNED` are all
  accepted, but `resolve()` treats them identically: it records the outcome string and re-adjudicates
  whatever corrections were supplied. The *outcome is descriptive metadata*; the actual result is
  whatever the re-run pipeline computes. (`PARTIALLY_OVERTURNED` has no special handling at all.)
- **`getActivePolicyForMemberOnDate` is dead code.** It's on the `PolicyRepository` port and
  implemented in both adapters but called by nothing — submission takes an explicit `policyId`.
- **No partial / per-line payment.** `payClaim` pays all payable lines at once; you cannot pay one
  line of a multi-line claim.
- **No cancel / withdraw / delete / amend endpoints**, and no claim resubmission. The only sanctioned
  post-decision edit of a line is a correction made through an open dispute.
- **The adjudication service is not wrapped in a single transaction.** Within a claim it issues
  multiple sequential repository writes (append adjudication, save line state, append ledger). The
  Prisma `appendForLine` flips `is_current` + inserts atomically via `$transaction`, but a process
  crash *mid-claim* could leave a partially adjudicated claim. Idempotent re-adjudication (only
  `AWAITING` lines are processed) is the mitigation, not true atomicity.
- **No concurrency control.** Running balances are read-modify-thread in memory; there is no
  optimistic lock or row versioning. Concurrent adjudications/disputes for the same member could
  race on accumulators. Single-writer is assumed.
- **No pagination, filtering, or list endpoints.** You fetch by id (`GET /claims/:id`,
  `/disputes/:id`, `/policies/:id`); there is no "list all claims" endpoint.
- **The Prisma adapter has no automated test coverage.** All 110 tests use in-memory repositories.
  The SQLite path was validated by hand against a running server, but no test asserts Prisma
  read/write behavior, the migration, or the JSON-encoding round-trips.
- **`CURRENCY` and `TEST_DATABASE_URL` env vars are declared but unused.** `CURRENCY` documents the
  single-currency assumption; `TEST_DATABASE_URL` was reserved for test-DB isolation that the
  in-memory test strategy made unnecessary. Neither is read by any code.
- **No multi-currency.** `Money`'s currency type is the literal `'USD'`; cross-currency arithmetic
  throws, but there is no FX or second currency.
- **No background processing / async adjudication.** Adjudication is a single synchronous pass over a
  claim's lines; there is no queue, no pend-and-callback, no scheduled re-adjudication.
- **No observability stack** beyond a single boot log line and the `/health` probe — no structured
  logging, metrics, or tracing.

---

## Domain assumptions

Assumptions about the insurance domain that are encoded in the implementation. A reviewer should read
these as "this is how the system *defines* the domain," since the real-world domain is richer.

1. **A claim always has at least one line.** Submission rejects an empty `lines` array, and
   `deriveClaimState` throws on zero lines — claim state is undefined without lines.

2. **Adjudication is atomic across a claim's lines.** All of a claim's `AWAITING` lines are decided
   in one synchronous pass. There is no "partially adjudicated" claim state; a claim is either fully
   pre-adjudication or fully post-adjudication. `deriveClaimState`'s guard 0 depends on this.

3. **Line order within a claim is meaningful.** Because accumulators are threaded line-to-line, two
   lines in the same category consume the shared deductible/limit in submission order. The earlier
   line gets first claim on remaining deductible/limit.

4. **Accumulators are scoped per member, per plan year.** The ledger is keyed by
   `(memberId, period)` where `period` is the policy's `planYear`. Each seeded member gets their own
   policy (`POL-001/002/003`) so their accumulators are independent. Family/group accumulators are
   not modeled.

5. **Coverage and exclusion are independent gates.** A category can be `covered: true` yet still be
   denied because it appears in the policy's `exclusions` list. The seeded plan exercises exactly
   this: `EXPERIMENTAL` is `covered: true` but listed in `exclusions`, so it is always denied
   `EXCLUDED_SERVICE` — distinct from `COSMETIC` which is `covered: false` and denied `NOT_COVERED`.

6. **Manual review is a gate-lift, not a human verdict.** Pending for review only means "billed
   exceeded the review threshold." Resolving it re-runs the *same* pipeline with the Review step
   skipped — so the line can still come back `APPROVED`, `PARTIALLY_APPROVED`, **or** `DENIED` based
   on the money math. There is no API to record an explicit human approve/deny decision; the human
   action is solely "let it past the threshold."

7. **`PAID` is terminal.** A paid line has no outgoing transitions. You cannot dispute, re-adjudicate,
   or re-pay a paid line — disputes must target lines that are not yet paid. (This was the real defect
   the README's example flow originally tripped over.)

8. **A claim has at most one open dispute at a time.** `openDispute` rejects a second dispute while one
   is open (`{OPEN, UNDER_REVIEW}`). A dispute may target one or more lines of the claim.

9. **A denial consumes no accumulator.** Hard-denied and pended lines post nothing to the ledger.
   Consequently an overturned denial (S9) posts only positive entries — there is nothing to reverse —
   whereas overturning a previously *paid/partial* line would post signed compensating entries.

10. **Dates are plain ISO calendar strings, no timezones.** Policy-active checks compare
    `yyyy-mm-dd` lexicographically with inclusive bounds. No time-of-day, no timezone, no business-day
    logic.

11. **Money is single-currency (USD) and always whole cents.** Sub-cent amounts cannot exist;
    fractional coinsurance is resolved by banker's rounding at the point of multiplication.

12. **`diagnosisCode` is descriptive PHI, never a rule input.** It is captured on a line but plays no
    part in adjudication and is never returned in a response.

13. **Duplicate lines are defined by `serviceCode + billedMinor + units`.** Two lines with the same
    triple in one submission are rejected as duplicates; differing on any of the three is allowed.

14. **The standard plan's specific terms are fixtures, not the engine.** The seeded plan
    (`policies/standard-plan-2026.json`) sets the $500 deductible, PT's 20% coinsurance / $25 copay /
    $4,000 annual limit, imaging's $10,000 review threshold, etc. These are *data*; the engine enforces
    whatever a validated config supplies. Note `per_incident_max` is implemented and explainable but
    **not exercised by any seeded rule**, so no fixture or test currently drives it.
