import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createServer } from './api/server';
import { assertCatalogComplete } from './config/explanation-catalog';
import { loadPolicyConfig } from './config/rule-loader';
import { createPrismaContainer } from './container';

const DEFAULT_PORT = 3000;

function resolvePort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new RangeError(`PORT must be an integer between 1 and 65535; received ${value}`);
  }
  return port;
}

function main(): void {
  // Fail fast at boot: every reason code is explainable, and the rule config is valid.
  assertCatalogComplete();
  const policyConfigPath = process.env.POLICY_CONFIG_PATH;
  if (policyConfigPath !== undefined && policyConfigPath.trim() !== '') {
    loadPolicyConfig(policyConfigPath);
  }

  const prisma = new PrismaClient();
  const app = createServer(createPrismaContainer(prisma));
  const port = resolvePort(process.env.PORT);

  app.listen(port, () => {
    console.log(`claim-processing-system listening on port ${port}`);
  });
}

main();
