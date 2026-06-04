import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import type { UsageLedgerEntry } from '../../src/domain/entities';
import { InMemoryUsageLedgerRepository } from '../../src/repositories/memory/in-memory-repositories';
import { LedgerService } from '../../src/services/ledger-service';

const PERIOD = 2026;
const PT_BUCKET = 'ANNUAL_LIMIT:PHYSICAL_THERAPY';
const DEDUCTIBLE = 'DEDUCTIBLE';

function entry(overrides: Partial<UsageLedgerEntry>): UsageLedgerEntry {
  return {
    entryId: randomUUID(),
    memberId: 'M-001',
    policyId: 'POL-001',
    period: PERIOD,
    bucket: DEDUCTIBLE,
    amountOrCount: 0,
    sourceLineId: 'L1',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function keys(overrides: Partial<{ memberId: string; policyId: string; period: number; sourceLineId: string }> = {}) {
  return { memberId: 'M-001', policyId: 'POL-001', period: PERIOD, sourceLineId: 'L1', ...overrides };
}

describe('LedgerService.balances', () => {
  it('sums entries per bucket across lines', async () => {
    const svc = new LedgerService(
      new InMemoryUsageLedgerRepository([
        entry({ bucket: DEDUCTIBLE, amountOrCount: 30000, sourceLineId: 'L1' }),
        entry({ bucket: DEDUCTIBLE, amountOrCount: 20000, sourceLineId: 'L2' }),
        entry({ bucket: PT_BUCKET, amountOrCount: 80000 }),
      ]),
    );
    const balances = await svc.balances('M-001', PERIOD);
    expect(balances.get(DEDUCTIBLE)).to.equal(50000);
    expect(balances.get(PT_BUCKET)).to.equal(80000);
  });

  it('nets signed (compensating) entries', async () => {
    const svc = new LedgerService(
      new InMemoryUsageLedgerRepository([
        entry({ bucket: PT_BUCKET, amountOrCount: 80000 }),
        entry({ bucket: PT_BUCKET, amountOrCount: -30000 }),
      ]),
    );
    expect((await svc.balances('M-001', PERIOD)).get(PT_BUCKET)).to.equal(50000);
  });

  it('filters by member and period', async () => {
    const svc = new LedgerService(
      new InMemoryUsageLedgerRepository([
        entry({ memberId: 'M-001', amountOrCount: 10000 }),
        entry({ memberId: 'M-002', amountOrCount: 99999 }),
        entry({ period: 2025, amountOrCount: 88888 }),
      ]),
    );
    const balances = await svc.balances('M-001', PERIOD);
    expect(balances.get(DEDUCTIBLE)).to.equal(10000);
  });

  it('is empty when there are no entries', async () => {
    const svc = new LedgerService(new InMemoryUsageLedgerRepository());
    expect((await svc.balances('M-001', PERIOD)).size).to.equal(0);
  });
});

describe('LedgerService.consume', () => {
  it('appends positive entries and skips zero-amount deltas (§0.6)', async () => {
    const repo = new InMemoryUsageLedgerRepository();
    const svc = new LedgerService(repo);
    await svc.consume({
      ...keys(),
      deltas: [
        { bucket: DEDUCTIBLE, amountMinor: 50000 },
        { bucket: PT_BUCKET, amountMinor: 80000 },
        { bucket: 'VISIT_COUNT:PHYSICAL_THERAPY', amountMinor: 0 },
      ],
    });
    expect(await repo.entriesForMemberPeriod('M-001', PERIOD)).to.have.length(2);
    const balances = await svc.balances('M-001', PERIOD);
    expect(balances.get(DEDUCTIBLE)).to.equal(50000);
    expect(balances.get(PT_BUCKET)).to.equal(80000);
  });

  it('rejects negative deltas — compensating entries go through reconcileLine only', async () => {
    const repo = new InMemoryUsageLedgerRepository();
    const svc = new LedgerService(repo);

    let error: unknown;
    try {
      await svc.consume({
        ...keys(),
        // A positive delta alongside the negative one to prove nothing is written partially.
        deltas: [
          { bucket: DEDUCTIBLE, amountMinor: 50000 },
          { bucket: PT_BUCKET, amountMinor: -100 },
        ],
      });
    } catch (err) {
      error = err;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.match(/negative|reconcileLine/i);
    // The whole batch is rejected up front — no partial consumption is written.
    expect(await repo.entriesForMemberPeriod('M-001', PERIOD)).to.have.length(0);
  });
});

describe('LedgerService.reconcileLine (compensating entries)', () => {
  it('posts positive entries when nothing was consumed before (S9 overturn from a denial)', async () => {
    const repo = new InMemoryUsageLedgerRepository();
    const svc = new LedgerService(repo);

    const posted = await svc.reconcileLine({
      ...keys({ memberId: 'M-003', policyId: 'POL-003', sourceLineId: 'C-S9/L1' }),
      target: [
        { bucket: DEDUCTIBLE, amountMinor: 50000 },
        { bucket: PT_BUCKET, amountMinor: 80000 },
      ],
    });

    expect(posted).to.deep.equal([
      { bucket: DEDUCTIBLE, amountMinor: 50000 },
      { bucket: PT_BUCKET, amountMinor: 80000 },
    ]);
    const balances = await svc.balances('M-003', PERIOD);
    expect(balances.get(DEDUCTIBLE)).to.equal(50000);
    expect(balances.get(PT_BUCKET)).to.equal(80000);
  });

  it('posts a negative compensating entry to reduce a prior consumption, never editing history', async () => {
    const repo = new InMemoryUsageLedgerRepository();
    const svc = new LedgerService(repo);
    await svc.consume({ ...keys(), deltas: [{ bucket: PT_BUCKET, amountMinor: 80000 }] });

    const posted = await svc.reconcileLine({ ...keys(), target: [{ bucket: PT_BUCKET, amountMinor: 50000 }] });

    expect(posted).to.deep.equal([{ bucket: PT_BUCKET, amountMinor: -30000 }]);
    // Both the original +80000 and the compensating -30000 remain (history preserved); net = 50000.
    expect(await repo.entriesForMemberPeriod('M-001', PERIOD)).to.have.length(2);
    expect((await svc.balances('M-001', PERIOD)).get(PT_BUCKET)).to.equal(50000);
  });

  it('fully reverses consumption when the line should now consume nothing', async () => {
    const repo = new InMemoryUsageLedgerRepository();
    const svc = new LedgerService(repo);
    await svc.consume({ ...keys(), deltas: [{ bucket: DEDUCTIBLE, amountMinor: 50000 }] });

    const posted = await svc.reconcileLine({ ...keys(), target: [] });

    expect(posted).to.deep.equal([{ bucket: DEDUCTIBLE, amountMinor: -50000 }]);
    expect((await svc.balances('M-001', PERIOD)).get(DEDUCTIBLE)).to.equal(0);
  });

  it('posts nothing when the line is already reconciled', async () => {
    const repo = new InMemoryUsageLedgerRepository();
    const svc = new LedgerService(repo);
    await svc.consume({ ...keys(), deltas: [{ bucket: DEDUCTIBLE, amountMinor: 50000 }] });

    const posted = await svc.reconcileLine({ ...keys(), target: [{ bucket: DEDUCTIBLE, amountMinor: 50000 }] });

    expect(posted).to.deep.equal([]);
    expect(await repo.entriesForMemberPeriod('M-001', PERIOD)).to.have.length(1);
  });

  it('rejects a negative target — final consumption must be non-negative (only the diff may be negative)', async () => {
    const repo = new InMemoryUsageLedgerRepository();
    const svc = new LedgerService(repo);

    let error: unknown;
    try {
      await svc.reconcileLine({ ...keys(), target: [{ bucket: PT_BUCKET, amountMinor: -100 }] });
    } catch (err) {
      error = err;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.match(/non-negative|final consumption/i);
    expect(await repo.entriesForMemberPeriod('M-001', PERIOD)).to.have.length(0);
  });

  it('scopes reconciliation to the source line (other lines’ consumption is untouched)', async () => {
    const repo = new InMemoryUsageLedgerRepository();
    const svc = new LedgerService(repo);
    await svc.consume({ ...keys({ sourceLineId: 'OTHER' }), deltas: [{ bucket: PT_BUCKET, amountMinor: 80000 }] });

    const posted = await svc.reconcileLine({ ...keys({ sourceLineId: 'L1' }), target: [{ bucket: PT_BUCKET, amountMinor: 50000 }] });

    expect(posted).to.deep.equal([{ bucket: PT_BUCKET, amountMinor: 50000 }]);
    // OTHER's 80000 + L1's new 50000 → 130000 total for the bucket.
    expect((await svc.balances('M-001', PERIOD)).get(PT_BUCKET)).to.equal(130000);
  });
});
