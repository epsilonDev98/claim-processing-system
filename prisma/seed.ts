/**
 * Seed: load the standard plan from JSON via the strict loader and persist the §0.1 fixtures.
 *
 * Members M-001/M-002/M-003 each get their own copy of the standard plan (POL-001/002/003) so
 * their accumulators are independent — the ledger is keyed per member (acceptance §0.1). The
 * explanation catalog is seeded and the completeness invariant is asserted before exit (S14).
 */

import 'dotenv/config';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { loadPolicyConfig } from '../src/config/rule-loader';
import { EXPLANATION_CATALOG, assertCatalogComplete } from '../src/config/explanation-catalog';

const prisma = new PrismaClient();

const MEMBERS: ReadonlyArray<{ memberId: string; policyId: string }> = [
  { memberId: 'M-001', policyId: 'POL-001' },
  { memberId: 'M-002', policyId: 'POL-002' },
  { memberId: 'M-003', policyId: 'POL-003' },
];

/**
 * The seed truncates every table before reloading fixtures. Guard so a destructive reseed only
 * ever targets a LOCAL SQLite/dev database — never production or a non-SQLite datasource.
 */
function assertLocalDevDatabase(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV=production (the seed truncates all tables).');
  }
  const url = process.env.DATABASE_URL;
  if (url === undefined || !url.startsWith('file:')) {
    throw new Error(
      `Refusing to seed: DATABASE_URL must be a local SQLite "file:" URL (got '${url ?? 'undefined'}'). ` +
        'The seed truncates all tables and is intended for local/dev only.',
    );
  }
}

async function main(): Promise<void> {
  assertLocalDevDatabase();
  assertCatalogComplete();

  const configPath =
    process.env.POLICY_CONFIG_PATH ?? path.resolve(process.cwd(), 'policies/standard-plan-2026.json');
  const config = loadPolicyConfig(configPath);

  // Idempotent reseed: clear in FK-safe order.
  await prisma.$transaction([
    prisma.usageLedgerEntry.deleteMany(),
    prisma.adjudication.deleteMany(),
    prisma.dispute.deleteMany(),
    prisma.claimLine.deleteMany(),
    prisma.claim.deleteMany(),
    prisma.coverageRule.deleteMany(),
    prisma.policy.deleteMany(),
    prisma.member.deleteMany(),
    prisma.explanationCode.deleteMany(),
  ]);

  for (const { memberId, policyId } of MEMBERS) {
    await prisma.member.create({
      data: { memberId, name: '<PHI>', dob: '1985-04-12' },
    });
    await prisma.policy.create({
      data: {
        policyId,
        memberId,
        effectiveDate: '2026-01-01',
        terminationDate: '2026-12-31',
        planYear: config.planYear,
        annualDeductibleMinor: config.annualDeductibleMinor,
        exclusions: JSON.stringify(config.exclusions),
        coverageRules: {
          // Flatten the discriminated union onto the (nullable) persistence columns. Non-covered
          // rules persist all cost-share/limit columns as null — they carry no such terms.
          create: config.rules.map((rule) =>
            rule.covered
              ? {
                  serviceCategory: rule.serviceCategory,
                  covered: true,
                  coinsuranceRate: rule.coinsuranceRate,
                  annualLimitMinor: rule.annualLimitMinor ?? null,
                  visitLimit: rule.visitLimit ?? null,
                  perIncidentMaxMinor: rule.perIncidentMaxMinor ?? null,
                  copayMinor: rule.copayMinor ?? null,
                  reviewThresholdMinor: rule.reviewThresholdMinor ?? null,
                }
              : {
                  serviceCategory: rule.serviceCategory,
                  covered: false,
                  coinsuranceRate: null,
                  annualLimitMinor: null,
                  visitLimit: null,
                  perIncidentMaxMinor: null,
                  copayMinor: null,
                  reviewThresholdMinor: null,
                },
          ),
        },
      },
    });
  }

  for (const entry of Object.values(EXPLANATION_CATALOG)) {
    await prisma.explanationCode.create({
      data: {
        code: entry.code,
        shortMessage: entry.shortMessage,
        detailTemplate: entry.detailTemplate,
        category: entry.category,
      },
    });
  }

  const [ruleCount, codeCount] = await Promise.all([
    prisma.coverageRule.count(),
    prisma.explanationCode.count(),
  ]);
  console.log(
    `Seeded ${MEMBERS.length} members/policies, ${ruleCount} coverage rules, ${codeCount} explanation codes.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
