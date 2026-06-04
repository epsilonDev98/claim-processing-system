/**
 * Endpoint table (implementation-plan §10). Each route is a thin controller wrapped so async
 * errors propagate to the central error handler in server.ts.
 *
 * Beyond the plan's table, two endpoints complete lifecycles the demo scenarios drive:
 *   - POST /claims/:claimId/lines/:lineId/resolve-review — resolve a manual-review pend (E2E-1).
 *   - POST /disputes/:disputeId/start-review            — OPEN → UNDER_REVIEW before resolve (E2E-2).
 */

import type { Express, NextFunction, Request, Response } from 'express';
import type { Container } from '../container';
import { makeControllers } from './controllers';

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

function asyncHandler(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

export function registerRoutes(app: Express, container: Container): void {
  const ctrl = makeControllers(container);

  app.post('/claims', asyncHandler(ctrl.submitClaim));
  app.post('/claims/:claimId/adjudicate', asyncHandler(ctrl.adjudicateClaim));
  app.get('/claims/:claimId', asyncHandler(ctrl.getClaim));
  app.get('/claims/:claimId/ledger', asyncHandler(ctrl.getLedger));
  app.post('/claims/:claimId/pay', asyncHandler(ctrl.payClaim));
  app.post('/claims/:claimId/lines/:lineId/resolve-review', asyncHandler(ctrl.resolveReview));
  app.post('/claims/:claimId/disputes', asyncHandler(ctrl.openDispute));

  app.post('/disputes/:disputeId/start-review', asyncHandler(ctrl.startReview));
  app.post('/disputes/:disputeId/resolve', asyncHandler(ctrl.resolveDispute));
  app.get('/disputes/:disputeId', asyncHandler(ctrl.getDispute));

  app.get('/policies/:policyId', asyncHandler(ctrl.getPolicy));
}
