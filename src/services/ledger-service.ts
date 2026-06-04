/**
 * Ledger service (implementation-plan §9, ledger contract acceptance §0.6).
 *
 * Balances are DERIVED by summing ledger entries per bucket — there is no cached balance column
 * (matches the §3 "denormalization deferred" decision). Consumption is append-only: only positive
 * (non-zero) entries are written, keyed to the source line.
 */

import { randomUUID } from 'node:crypto';
import type { UsageLedgerEntry } from '../domain/entities';
import type { LedgerDelta } from '../pipeline/adjudicate-line';
import type { UsageLedgerRepository } from '../repositories/interfaces';

export class LedgerService {
  constructor(private readonly ledger: UsageLedgerRepository) {}

  /** Summed consumption per bucket for a member in a period. Buckets with no entries are absent. */
  async balances(memberId: string, period: number): Promise<Map<string, number>> {
    const entries = await this.ledger.entriesForMemberPeriod(memberId, period);
    const sums = new Map<string, number>();
    for (const entry of entries) {
      sums.set(entry.bucket, (sums.get(entry.bucket) ?? 0) + entry.amountOrCount);
    }
    return sums;
  }

  /** Append consumption entries for one line. Zero-amount deltas write nothing (§0.6). */
  async consume(params: {
    memberId: string;
    policyId: string;
    period: number;
    sourceLineId: string;
    deltas: readonly LedgerDelta[];
  }): Promise<void> {
    for (const delta of params.deltas) {
      if (delta.amountMinor === 0) continue;
      const entry: UsageLedgerEntry = {
        entryId: randomUUID(),
        memberId: params.memberId,
        policyId: params.policyId,
        period: params.period,
        bucket: delta.bucket,
        amountOrCount: delta.amountMinor,
        sourceLineId: params.sourceLineId,
        createdAt: new Date().toISOString(),
      };
      await this.ledger.append(entry);
    }
  }
}
