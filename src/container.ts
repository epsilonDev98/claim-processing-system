/**
 * Composition root (implementation-plan §"container"). Wires repositories + services. The Express
 * layer depends only on a Container, so the same app runs over Prisma (production/boot) or
 * in-memory adapters (E2E tests) — services and routes are storage-agnostic.
 */

import type { PrismaClient } from '@prisma/client';
import type {
  AdjudicationRepository,
  ClaimRepository,
  DisputeRepository,
  MemberRepository,
  PolicyRepository,
  UsageLedgerRepository,
} from './repositories/interfaces';
import {
  PrismaAdjudicationRepository,
  PrismaClaimRepository,
  PrismaDisputeRepository,
  PrismaMemberRepository,
  PrismaPolicyRepository,
  PrismaUsageLedgerRepository,
} from './repositories/prisma/prisma-repositories';
import { AdjudicationService } from './services/adjudication-service';
import { ClaimService } from './services/claim-service';
import { DisputeService } from './services/dispute-service';
import { LedgerService } from './services/ledger-service';

export interface Repositories {
  members: MemberRepository;
  policies: PolicyRepository;
  claims: ClaimRepository;
  adjudications: AdjudicationRepository;
  ledger: UsageLedgerRepository;
  disputes: DisputeRepository;
}

export interface Container {
  repositories: Repositories;
  ledgerService: LedgerService;
  claimService: ClaimService;
  adjudicationService: AdjudicationService;
  disputeService: DisputeService;
}

/** Assemble services over a set of repository adapters. */
export function buildContainer(repositories: Repositories): Container {
  const ledgerService = new LedgerService(repositories.ledger);
  const claimService = new ClaimService(repositories.claims, repositories.members, repositories.policies);
  const adjudicationService = new AdjudicationService(
    repositories.claims,
    repositories.policies,
    repositories.adjudications,
    ledgerService,
  );
  const disputeService = new DisputeService(repositories.disputes, repositories.claims, adjudicationService);
  return { repositories, ledgerService, claimService, adjudicationService, disputeService };
}

/** Production container backed by Prisma/SQLite. */
export function createPrismaContainer(prisma: PrismaClient): Container {
  return buildContainer({
    members: new PrismaMemberRepository(prisma),
    policies: new PrismaPolicyRepository(prisma),
    claims: new PrismaClaimRepository(prisma),
    adjudications: new PrismaAdjudicationRepository(prisma),
    ledger: new PrismaUsageLedgerRepository(prisma),
    disputes: new PrismaDisputeRepository(prisma),
  });
}
