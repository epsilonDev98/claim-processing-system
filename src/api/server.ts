/**
 * Express app assembly + centralized error mapping (implementation-plan §10).
 *
 * Error → status mapping (kept out of controllers/scenarios on purpose):
 *   - ZodError / ValidationError            → 400
 *   - NotFoundError                         → 404
 *   - NotPayableError / ConflictError /
 *     IllegalTransitionError                → 409
 *   - anything else                         → 500
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import type { Container } from '../container';
import { IllegalTransitionError } from '../domain/states';
import { ConflictError, NotFoundError, NotPayableError, ValidationError } from '../services/errors';
import { registerRoutes } from './routes';

export function createServer(container: Container): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'claim-processing-system' });
  });

  registerRoutes(app, container);

  app.use(errorHandler);
  return app;
}

function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'ValidationError', issues: err.issues });
    return;
  }
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.name, message: err.message });
    return;
  }
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.name, message: err.message });
    return;
  }
  if (
    err instanceof NotPayableError ||
    err instanceof ConflictError ||
    err instanceof IllegalTransitionError
  ) {
    res.status(409).json({ error: err.name, message: err.message });
    return;
  }

  const message = err instanceof Error ? err.message : 'Internal Server Error';
  res.status(500).json({ error: 'InternalServerError', message });
}
