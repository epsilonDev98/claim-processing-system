import express, { type Express } from 'express';

export function createServer(): Express {
  const app = express();

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'claim-processing-system',
    });
  });

  return app;
}
