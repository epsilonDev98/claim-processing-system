/**
 * Ledger service (implementation-plan §9, ledger contract acceptance §0.6, dispute reversal §7).
 *
 * The single owner of usage-ledger reads and writes. Two invariants live here:
 *   - Balances are DERIVED by summing entries per bucket — there is no cached balance column.
 *   - The ledger is APPEND-ONLY and signed. New consumption appends positive entries; a dispute
 *     that changes a line's consumption appends signed COMPENSATING entries for the difference.
 *     Existing entries are never edited or deleted.
 *
 * Running-balance behavior (later lines in the same claim seeing earlier lines' consumption) is the
 * caller's concern: `adjudicateClaim` loads `balances()` once and threads a mutable copy across
 * lines. This service stays stateless — every read re-sums the ledger.
 */

import { randomUUID } from 'node:crypto';
import type { UsageLedgerEntry } from '../domain/entities';
import type { LedgerDelta } from '../pipeline/adjudicate-line';
import type { UsageLedgerRepository } from '../repositories/interfaces';

interface LedgerKeys {
  memberId: string;
  policyId: string;
  period: number;
  sourceLineId: string;
}

export class LedgerService {
  constructor(private readonly ledger: UsageLedgerRepository) {}

  /** Summed consumption per bucket for a member in a period (signed entries net out). */
  async balances(memberId: string, period: number): Promise<Map<string, number>> {
    return sumByBucket(await this.ledger.entriesForMemberPeriod(memberId, period));
  }

  /** Summed consumption per bucket attributable to a single source line. */
  async consumedByLine(memberId: string, period: number, sourceLineId: string): Promise<Map<string, number>> {
    const entries = await this.ledger.entriesForMemberPeriod(memberId, period);
    return sumByBucket(entries.filter((entry) => entry.sourceLineId === sourceLineId));
  }

  /**
   * Append positive consumption for a line. Zero-amount deltas write nothing (§0.6). Negative
   * amounts are REJECTED — compensating (negative) entries are posted only via `reconcileLine`,
   * which keeps normal consumption and dispute reconciliation cleanly separated. The whole batch
   * is validated before anything is written, so a rejected delta leaves no partial consumption.
   */
  async consume(params: LedgerKeys & { deltas: readonly LedgerDelta[] }): Promise<void> {
    for (const delta of params.deltas) {
      if (delta.amountMinor < 0) {
        throw new Error(
          `consume() rejects negative amounts (bucket '${delta.bucket}': ${delta.amountMinor}); ` +
            'post compensating/negative entries via reconcileLine() instead.',
        );
      }
    }
    for (const delta of params.deltas) {
      if (delta.amountMinor === 0) continue;
      await this.appendEntry(params, delta.bucket, delta.amountMinor);
    }
  }

  /**
   * Reconcile a line's consumption to `target` by appending SIGNED compensating entries for the
   * per-bucket difference vs. what the line has already consumed: positive for newly-due
   * consumption (S9), negative to reverse a prior consumption. History is never edited (§0.6, §7).
   * Returns the compensating deltas posted (empty if the line is already reconciled).
   */
  async reconcileLine(params: LedgerKeys & { target: readonly LedgerDelta[] }): Promise<LedgerDelta[]> {
    // `target` is the desired FINAL consumption for the line, so it must be non-negative; only the
    // computed per-bucket diff may be negative (a compensating reversal).
    for (const delta of params.target) {
      if (delta.amountMinor < 0) {
        throw new Error(
          `reconcileLine target is the desired final consumption and must be non-negative ` +
            `(bucket '${delta.bucket}': ${delta.amountMinor}); only the computed diff may be negative.`,
        );
      }
    }

    const current = await this.consumedByLine(params.memberId, params.period, params.sourceLineId);
    const target = sumDeltas(params.target);

    const posted: LedgerDelta[] = [];
    for (const bucket of new Set<string>([...current.keys(), ...target.keys()])) {
      const diff = (target.get(bucket) ?? 0) - (current.get(bucket) ?? 0);
      if (diff === 0) continue;
      await this.appendEntry(params, bucket, diff);
      posted.push({ bucket, amountMinor: diff });
    }
    return posted;
  }

  private async appendEntry(keys: LedgerKeys, bucket: string, amountMinor: number): Promise<void> {
    const entry: UsageLedgerEntry = {
      entryId: randomUUID(),
      memberId: keys.memberId,
      policyId: keys.policyId,
      period: keys.period,
      bucket,
      amountOrCount: amountMinor,
      sourceLineId: keys.sourceLineId,
      createdAt: new Date().toISOString(),
    };
    await this.ledger.append(entry);
  }
}

function sumByBucket(entries: readonly UsageLedgerEntry[]): Map<string, number> {
  const sums = new Map<string, number>();
  for (const entry of entries) {
    sums.set(entry.bucket, (sums.get(entry.bucket) ?? 0) + entry.amountOrCount);
  }
  return sums;
}

function sumDeltas(deltas: readonly LedgerDelta[]): Map<string, number> {
  const sums = new Map<string, number>();
  for (const delta of deltas) {
    sums.set(delta.bucket, (sums.get(delta.bucket) ?? 0) + delta.amountMinor);
  }
  return sums;
}
